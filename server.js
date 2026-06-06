const express = require('express');
const path = require('path');
const app = express();

const PORT = process.env.PORT || 3000;

// ═══ REDIS SOZLAMALARI ═══
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || "https://moving-airedale-70150.upstash.io";
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "gQAAAAAAARIGAAIgcDExMzBkZDc1Y2RmOGM0MDVjYTQ4Y2IyNGU2Yzc5Y2JhNw";

// Serverni to'satdan o'chib ketishdan himoya qilish
process.on('uncaughtException', (err) => console.error('Server xatosi:', err.message));
process.on('unhandledRejection', (err) => console.error('Server xatosi:', err.message));

// ═══ CORS (Tashqi paketsiz, qo'lda yozilgan) ═══
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Cache-Control');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ═══ MIDDLEWARE ═══
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "5mb" }));
app.use(express.static(__dirname));

// ═══ REDIS FUNKSIYALARI ═══
async function redis(command, ...args) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify([command, ...args])
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function getKey(key) {
  const val = await redis('get', key);
  if (!val) return null;
  try { return JSON.parse(val); } catch { return val; }
}

async function setKey(key, value, ex = null) {
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (ex) return redis('set', key, str, 'EX', ex);
  return redis('set', key, str);
}

// ═══ SSE CLIENTLAR ═══
const sseClients = {};
function notifyClients(channelId, data) {
  const clients = sseClients[channelId] || [];
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => { try { res.write(msg); } catch {} });
}

// ═══ API ENDPOINTLAR ═══

app.post('/api/login', async (req, res) => {
  try {
    const { username } = req.body;
    if (!username || username.trim().length < 2) return res.status(400).json({ error: 'Username kamida 2 harf' });
    const clean = username.trim().slice(0, 20);
    const existing = await getKey(`user:${clean}`);
    if (!existing) await setKey(`user:${clean}`, { online: true, currentGame: null });
    else { existing.online = true; await setKey(`user:${clean}`, existing); }
    res.json({ ok: true, username: clean });
  } catch (e) { res.status(500).json({ error: 'Server xatosi' }); }
});

app.get('/api/users/search/:username', async (req, res) => {
  try {
    const user = await getKey(`user:${req.params.username}`);
    if (user) res.json({ username: req.params.username, online: user.online });
    else res.status(404).json({ error: 'Topilmadi' });
  } catch (e) { res.status(500).json({ error: 'Server xatosi' }); }
});

app.post('/api/challenge', async (req, res) => {
  try {
    const { from, to } = req.body;
    if (!from || !to) return res.status(400).json({ error: 'from va to kerak' });
    if (from === to) return res.status(400).json({ error: "O'zingiz bilan o'ynay olmaysiz" });
    const toUser = await getKey(`user:${to}`);
    if (!toUser) return res.status(404).json({ error: 'Raqib topilmadi' });
    const chId = Math.random().toString(36).slice(2, 8);
    await setKey(`challenge:${chId}`, { from, to, status: 'pending', createdAt: Date.now() }, 300);
    notifyClients('user_' + to, { type: 'new_challenge', from, challengeId: chId });
    res.json({ ok: true, challengeId: chId });
  } catch (e) { res.status(500).json({ error: 'Server xatosi' }); }
});

app.get('/api/challenges/:username', async (req, res) => {
  try {
    const scanResult = await redis('scan', '0', 'MATCH', 'challenge:*', 'COUNT', '100');
    const keys = Array.isArray(scanResult) && Array.isArray(scanResult[1]) ? scanResult[1] : [];
    if (keys.length === 0) return res.json([]);
    const values = await redis('mget', ...keys);
    const challenges = [];
    keys.forEach((key, index) => {
      if (values[index]) {
        try {
          const ch = JSON.parse(values[index]);
          if (ch.to === req.params.username && ch.status === 'pending') challenges.push({ id: key.replace('challenge:', ''), from: ch.from });
        } catch (e) {}
      }
    });
    res.json(challenges);
  } catch (e) { res.status(500).json({ error: 'Server xatosi' }); }
});

app.post('/api/challenge/:id/accept', async (req, res) => {
  try {
    const ch = await getKey(`challenge:${req.params.id}`);
    if (!ch || ch.to !== req.body.username) return res.status(400).json({ error: 'Xato challenge' });
    ch.status = 'accepted';
    await setKey(`challenge:${req.params.id}`, ch, 60);
    const gameId = Math.random().toString(36).slice(2, 8).toUpperCase();
    const gameState = {
      board: [['r','n','b','q','k','b','n','r'],['p','p','p','p','p','p','p','p'],[null,null,null,null,null,null,null,null],[null,null,null,null,null,null,null,null],[null,null,null,null,null,null,null,null],[null,null,null,null,null,null,null,null],['P','P','P','P','P','P','P','P'],['R','N','B','Q','K','B','N','R']],
      turn: 'white', enPassant: null, castling: { WK: true, WQ: true, BK: true, BQ: true },
      captured: { white: [], black: [] }, lastMove: null, status: 'playing', winner: null,
      createdAt: new Date().toISOString(), whiteTime: 600, blackTime: 600,
      whitePlayer: ch.from, blackPlayer: ch.to, chat: []
    };
    await setKey(`game:${gameId}`, gameState, 7200);
    const fromUser = await getKey(`user:${ch.from}`);
    const toUser = await getKey(`user:${ch.to}`);
    if (fromUser) { fromUser.currentGame = gameId; await setKey(`user:${ch.from}`, fromUser); }
    if (toUser) { toUser.currentGame = gameId; await setKey(`user:${ch.to}`, toUser); }
    notifyClients('user_' + ch.from, { type: 'game_start', gameId, color: 'white' });
    notifyClients('user_' + ch.to, { type: 'game_start', gameId, color: 'black' });
    res.json({ ok: true, gameId, color: 'black' });
  } catch (e) { res.status(500).json({ error: 'Server xatosi' }); }
});

app.post('/api/games', async (req, res) => {
  try {
    const { id, state } = req.body;
    if (await getKey(`game:${id}`)) return res.status(409).json({ error: 'ID mavjud' });
    await setKey(`game:${id}`, state, 7200);
    res.status(201).json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: 'Server xatosi' }); }
});

app.get('/api/games/:id', async (req, res) => {
  try {
    const id = req.params.id.startsWith('user_') ? req.params.id : req.params.id.toUpperCase();
    const game = await getKey(`game:${id}`);
    if (!game) return res.status(404).json({ error: "O'yin topilmadi" });
    res.json(game);
  } catch (e) { res.status(500).json({ error: 'Server xatosi' }); }
});

app.put('/api/games/:id', async (req, res) => {
  try {
    const id = req.params.id.toUpperCase();
    const game = await getKey(`game:${id}`);
    if (!game) return res.status(404).json({ error: "O'yin topilmadi" });
    if (req.body.chatMsg) {
      if (!game.chat) game.chat = [];
      game.chat.push(req.body.chatMsg);
      const { chatMsg, ...rest } = req.body;
      Object.assign(game, rest);
    } else { Object.assign(game, req.body); }
    await setKey(`game:${id}`, game, 7200);
    notifyClients(id, game);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Server xatosi' }); }
});

app.get('/api/games/:id/events', (req, res) => {
  const id = req.params.id.startsWith('user_') ? req.params.id : req.params.id.toUpperCase();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*' });
  res.write('data: {"type":"connected"}\n\n');
  if (!sseClients[id]) sseClients[id] = [];
  sseClients[id].push(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients[id] = (sseClients[id] || []).filter(r => r !== res); });
});

// ═══ SPA FALLBACK ═══
app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ═══ SERVER ISHGA TUSHIRISH ═══
app.listen(PORT, '0.0.0.0', () => console.log(`♟ Server ishga tushdi: ${PORT}`));