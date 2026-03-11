const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, '.')));

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

function randomColor() {
  const colors = ['#FF6B6B','#FFD93D','#6BCB77','#4D96FF','#FF922B','#CC5DE8','#20C997','#F783AC','#74C0FC','#A9E34B'];
  return colors[Math.floor(Math.random() * colors.length)];
}

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
}

function getState() {
  return {
    type: 'state',
    players: Object.values(players),
    gameState,
    hitDeal,
    hitDeals,
    currentDealIndex,
    totalDeals: DEALS.length
  };
}

wss.on('connection', (ws) => {
  const id = String(nextId++);
  ws.playerId = id;
  players[id] = {
    id,
    name: `Player ${id}`,
    color: randomColor(),
    isAdmin: false,
    ball: { x: 620, y: 620, vx: 0, vy: 0, active: false },
    score: 0
  };

  ws.send(JSON.stringify({ type: 'init', playerId: id, isAdmin: false }));
  broadcast(getState());

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const player = players[id];
    if (!player) return;

    if (msg.type === 'setName') {
      player.name = msg.name.slice(0, 20);
      player.isAdmin = msg.name.trim() === ADMIN_NAME;
      ws.send(JSON.stringify({ type: 'init', playerId: id, isAdmin: player.isAdmin }));
      broadcast(getState());
    }

    if (msg.type === 'throw' && gameState === 'playing') {
      player.ball = { x: msg.x, y: msg.y, vx: msg.vx, vy: msg.vy, active: true };
      broadcast(getState());
    }

    if (msg.type === 'ballUpdate' && gameState === 'playing') {
      player.ball = msg.ball;
      broadcast({ type: 'ballUpdate', playerId: id, ball: player.ball });
    }

    // Client-side collision detection reports a hit
    if (msg.type === 'hitTarget' && gameState === 'playing') {
      const deal = DEALS[currentDealIndex];
      if (!deal) return;

      player.score += 1;
      player.ball.active = false;
      gameState = 'paused';
      hitDeal = { deal, player: player.name, color: player.color, dealIndex: currentDealIndex };
      hitDeals.push({ deal, player: player.name, color: player.color });

      Object.values(players).forEach(p => { p.ball.active = false; });

      broadcast({ type: 'hit', deal, playerName: player.name, playerColor: player.color });
      broadcast(getState());
    }

    if (msg.type === 'startGame' && player.isAdmin) {
      gameState = 'playing';
      hitDeal = null;
      hitDeals = [];
      currentDealIndex = 0;
      Object.values(players).forEach(p => {
        p.ball = { x: 620, y: 620, vx: 0, vy: 0, active: false };
        p.score = 0;
      });
      broadcast({ type: 'gameStarted' });
      broadcast(getState());
    }

    if (msg.type === 'resume' && player.isAdmin && gameState === 'paused') {
      currentDealIndex++;
      if (currentDealIndex >= DEALS.length) {
        gameState = 'gameover';
        broadcast({ type: 'gameover' });
      } else {
        gameState = 'playing';
        hitDeal = null;
        Object.values(players).forEach(p => {
          p.ball = { x: 620, y: 620, vx: 0, vy: 0, active: false };
        });
        broadcast({ type: 'resumed', currentDealIndex });
      }
      broadcast(getState());
    }

    if (msg.type === 'resetGame' && player.isAdmin) {
      gameState = 'waiting';
      hitDeal = null;
      hitDeals = [];
      currentDealIndex = 0;
      Object.values(players).forEach(p => {
        p.score = 0;
        p.ball = { x: 620, y: 620, vx: 0, vy: 0, active: false };
      });
      broadcast(getState());
    }
  });

  ws.on('close', () => {
    delete players[id];
    broadcast(getState());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Presales Game running at http://localhost:${PORT}`);
  console.log(`Share your local IP + port with teammates!`);
});
