const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const DEALS = [
  "TELUS Canada Demo", "Ericsson POC", "Rakuten Congested Cells",
  "Telefonica Spain + Nvidia", "Rogers Canada PoC", "TEF Spain Tupl",
  "VNPT", "DISH NOC AI+ServiceNow", "TELUS Cust. Experience",
  "Verizon Voice POC", "TELUS RFP On-site", "O2 Czech RFQ",
  "Cetin RFP", "Agentic-AI Catalyst", "AT&T Agentic-AI"
];

let players = {};        // id -> { id, name, color, ball: {x,y,vx,vy,active}, score }
let gameState = 'waiting'; // waiting | playing | paused
let hitDeal = null;
let holes = [];
let nextId = 1;

function randomColor() {
  const colors = ['#FF6B6B','#FFD93D','#6BCB77','#4D96FF','#FF922B','#CC5DE8','#20C997','#F783AC','#74C0FC','#A9E34B'];
  return colors[Math.floor(Math.random() * colors.length)];
}

function generateHoles() {
  // Place deals as "holes" in a grid layout
  holes = DEALS.map((deal, i) => {
    const cols = 5;
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      id: i,
      deal,
      x: 120 + col * 220,
      y: 100 + row * 160,
      r: 30,
      hit: false
    };
  });
}

generateHoles();

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
    holes
  };
}

wss.on('connection', (ws) => {
  const id = String(nextId++);
  const isHost = Object.keys(players).length === 0;

  ws.playerId = id;
  players[id] = {
    id, name: `Player ${id}`,
    color: randomColor(),
    isHost,
    ball: { x: 100 + Math.random()*600, y: 400 + Math.random()*100, vx: 0, vy: 0, active: false },
    score: 0
  };

  ws.send(JSON.stringify({ type: 'init', playerId: id, isHost, holes, deals: DEALS }));
  broadcast(getState());

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const player = players[id];
    if (!player) return;

    if (msg.type === 'setName') {
      player.name = msg.name.slice(0, 20);
      broadcast(getState());
    }

    if (msg.type === 'throw' && gameState === 'playing') {
      player.ball = { x: msg.x, y: msg.y, vx: msg.vx, vy: msg.vy, active: true };
      broadcast(getState());
    }

    if (msg.type === 'ballUpdate' && gameState === 'playing') {
      player.ball = msg.ball;

      // Check hole collision
      for (const hole of holes) {
        if (hole.hit) continue;
        const dx = player.ball.x - hole.x;
        const dy = player.ball.y - hole.y;
        const dist = Math.sqrt(dx*dx + dy*dy);
        if (dist < hole.r + 12) {
          hole.hit = true;
          player.score += 1;
          player.ball.active = false;
          gameState = 'paused';
          hitDeal = { deal: hole.deal, player: player.name, color: player.color };
          broadcast({ type: 'hit', deal: hole.deal, playerName: player.name, playerColor: player.color, playerId: id });
          broadcast(getState());
          return;
        }
      }
      broadcast({ type: 'ballUpdate', playerId: id, ball: player.ball });
    }

    if (msg.type === 'startGame' && player.isHost) {
      gameState = 'playing';
      hitDeal = null;
      holes.forEach(h => h.hit = false);
      Object.values(players).forEach(p => {
        p.ball = { x: 500, y: 500, vx: 0, vy: 0, active: false };
        p.score = 0;
      });
      broadcast({ type: 'gameStarted' });
      broadcast(getState());
    }

    if (msg.type === 'resume' && player.isHost && gameState === 'paused') {
      gameState = 'playing';
      hitDeal = null;
      broadcast({ type: 'resumed' });
      broadcast(getState());
    }

    if (msg.type === 'resetGame' && player.isHost) {
      generateHoles();
      gameState = 'waiting';
      hitDeal = null;
      Object.values(players).forEach(p => {
        p.score = 0;
        p.ball = { x: 500, y: 500, vx: 0, vy: 0, active: false };
      });
      broadcast(getState());
    }
  });

  ws.on('close', () => {
    delete players[id];
    // If host left, assign to next
    const remaining = Object.values(players);
    if (remaining.length > 0 && !remaining.find(p => p.isHost)) {
      remaining[0].isHost = true;
    }
    broadcast(getState());
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Presales Game running at http://localhost:${PORT}`);
  console.log(`Share your local IP + port with teammates!`);
});
