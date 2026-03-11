const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, '.')));

// ─────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────
const MAX_PLAYERS   = 100;   // connection cap
const MAX_MSG_BYTES = 512;   // ignore oversized messages
const BALL_TICK_MS  = 50;    // how often to broadcast ball positions (20 fps)
const RATE_LIMIT_MS = 50;    // min interval between ballUpdates per player
const HEARTBEAT_MS  = 20000; // ping interval to detect dead sockets

const DEALS = [
  "TELUS Canada Demo", "Ericsson POC", "Rakuten Congested Cells",
  "Telefonica Spain + Nvidia", "Rogers Canada PoC", "TEF Spain Tupl",
  "VNPT", "DISH NOC AI+ServiceNow", "TELUS Cust. Experience",
  "Verizon Voice POC", "TELUS RFP On-site", "O2 Czech RFQ",
  "Cetin RFP", "Agentic-AI Catalyst", "AT&T Agentic-AI"
];

const ADMIN_NAME = 'EranAdmin';

let players = {};
let gameState = 'waiting'; // waiting | playing | paused | gameover
let hitDeal = null;
let hitDeals = [];
let currentDealIndex = 0;
let nextId = 1;

// ─────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────
function randomColor() {
  const colors = ['#FF6B6B','#FFD93D','#6BCB77','#4D96FF','#FF922B','#CC5DE8','#20C997','#F783AC','#74C0FC','#A9E34B'];
  return colors[Math.floor(Math.random() * colors.length)];
}

// Pre-serialise once per broadcast call (not once per client)
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

function getState() {
  return {
    type: 'state',
    players: Object.values(players).map(p => ({
      id: p.id, name: p.name, color: p.color, isAdmin: p.isAdmin,
      score: p.score, ball: p.ball
    })),
    gameState,
    hitDeal,
    hitDeals,
    currentDealIndex,
    totalDeals: DEALS.length
  };
}

function isValidBall(b) {
  return b && typeof b.x === 'number' && typeof b.y === 'number'
           && isFinite(b.x) && isFinite(b.y)
           && Math.abs(b.x) < 5000 && Math.abs(b.y) < 5000;
}

// ─────────────────────────────────────────────────────
// BATCHED BALL BROADCAST — runs every BALL_TICK_MS
// Replaces per-message individual broadcasts (eliminates O(N²) fan-out)
// ─────────────────────────────────────────────────────
setInterval(() => {
  if (gameState !== 'playing') return;
  const balls = {};
  Object.values(players).forEach(p => {
    if (p.ball && p.ball.active) balls[p.id] = p.ball;
  });
  if (Object.keys(balls).length === 0) return;
  broadcast({ type: 'balls', balls });
}, BALL_TICK_MS);

// ─────────────────────────────────────────────────────
// HEARTBEAT — detect and clean up dead connections
// ─────────────────────────────────────────────────────
const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

// ─────────────────────────────────────────────────────
// CONNECTIONS
// ─────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  // Connection cap
  if (Object.keys(players).length >= MAX_PLAYERS) {
    ws.send(JSON.stringify({ type: 'error', message: 'Server full' }));
    ws.close();
    return;
  }

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const id = String(nextId++);
  ws.playerId = id;
  players[id] = {
    id,
    name: `Player ${id}`,
    color: randomColor(),
    isAdmin: false,
    ball: { x: 620, y: 620, vx: 0, vy: 0, active: false },
    score: 0,
    _lastBallUpdate: 0   // for per-player rate limiting
  };

  ws.send(JSON.stringify({ type: 'init', playerId: id, isAdmin: false }));
  broadcast(getState());

  ws.on('message', (raw) => {
    // Size guard
    if (raw.length > MAX_MSG_BYTES) return;

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const player = players[id];
    if (!player) return;

    // ── setName ──────────────────────────────────────
    if (msg.type === 'setName') {
      player.name    = String(msg.name || '').slice(0, 20);
      player.isAdmin = player.name.trim() === ADMIN_NAME;
      ws.send(JSON.stringify({ type: 'init', playerId: id, isAdmin: player.isAdmin }));
      broadcast(getState());
    }

    // ── throw ─────────────────────────────────────────
    if (msg.type === 'throw' && gameState === 'playing') {
      if (!isValidBall(msg)) return;
      player.ball = { x: msg.x, y: msg.y, vx: msg.vx || 0, vy: msg.vy || 0, active: true };
      // State broadcast is intentional here (low frequency, once per throw)
      broadcast(getState());
    }

    // ── ballUpdate (rate-limited; no immediate broadcast — batched ticker handles it) ──
    if (msg.type === 'ballUpdate' && gameState === 'playing') {
      const now = Date.now();
      if (now - player._lastBallUpdate < RATE_LIMIT_MS) return;
      player._lastBallUpdate = now;
      if (!isValidBall(msg.ball)) return;
      const b = msg.ball;
      player.ball = { x: b.x, y: b.y, vx: b.vx || 0, vy: b.vy || 0, active: !!b.active };
    }

    // ── hitTarget ─────────────────────────────────────
    if (msg.type === 'hitTarget' && gameState === 'playing') {
      const deal = DEALS[currentDealIndex];
      if (!deal) return;

      player.score += 1;
      player.ball.active = false;
      gameState = 'paused';
      hitDeal  = { deal, player: player.name, color: player.color, dealIndex: currentDealIndex };
      hitDeals.push({ deal, player: player.name, color: player.color });

      Object.values(players).forEach(p => { p.ball.active = false; });

      broadcast({ type: 'hit', deal, playerName: player.name, playerColor: player.color });
      broadcast(getState());
    }

    // ── startGame ─────────────────────────────────────
    if (msg.type === 'startGame' && player.isAdmin) {
      gameState = 'playing';
      hitDeal   = null;
      hitDeals  = [];
      currentDealIndex = 0;
      Object.values(players).forEach(p => {
        p.ball  = { x: 620, y: 620, vx: 0, vy: 0, active: false };
        p.score = 0;
      });
      broadcast({ type: 'gameStarted' });
      broadcast(getState());
    }

    // ── resume ────────────────────────────────────────
    if (msg.type === 'resume' && player.isAdmin && gameState === 'paused') {
      currentDealIndex++;
      if (currentDealIndex >= DEALS.length) {
        gameState = 'gameover';
        broadcast({ type: 'gameover' });
      } else {
        gameState = 'playing';
        hitDeal   = null;
        Object.values(players).forEach(p => {
          p.ball = { x: 620, y: 620, vx: 0, vy: 0, active: false };
        });
        broadcast({ type: 'resumed', currentDealIndex });
      }
      broadcast(getState());
    }

    // ── resetGame ─────────────────────────────────────
    if (msg.type === 'resetGame' && player.isAdmin) {
      gameState        = 'waiting';
      hitDeal          = null;
      hitDeals         = [];
      currentDealIndex = 0;
      Object.values(players).forEach(p => {
        p.score = 0;
        p.ball  = { x: 620, y: 620, vx: 0, vy: 0, active: false };
      });
      broadcast(getState());
    }
  });

  ws.on('close', () => {
    delete players[id];
    broadcast(getState());
  });

  ws.on('error', () => {
    delete players[id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Presales Game running at http://localhost:${PORT}`);
  console.log(`Share your local IP + port with teammates!`);
});
