'use strict';

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '3000', 10);

const rooms = new Map();

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = new Set();
    rooms.set(roomId, room);
  }
  return room;
}

function send(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    console.warn('send failed:', err.message);
  }
}

function broadcastToOthers(room, sender, payload) {
  for (const peer of room) {
    if (peer !== sender) send(peer, payload);
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.roomId = null;
  ws.peerId = Math.random().toString(36).slice(2, 10);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === 'join') {
      const roomId = String(msg.roomId || '').trim();
      if (!roomId) {
        send(ws, { type: 'error', message: 'roomId required' });
        return;
      }
      const room = getRoom(roomId);
      if (room.size >= 2) {
        send(ws, { type: 'error', message: 'room full' });
        return;
      }
      const existingPeers = Array.from(room).map((p) => p.peerId);
      ws.roomId = roomId;
      room.add(ws);
      const peerCount = room.size;
      send(ws, { type: 'joined', roomId, peerId: ws.peerId, peerCount, peers: existingPeers });
      broadcastToOthers(room, ws, { type: 'peer-joined', peerId: ws.peerId, peerCount });
      console.log(`peer ${ws.peerId} joined room ${roomId} (${peerCount} peers)`);
      return;
    }

    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;

    if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice') {
      broadcastToOthers(room, ws, { ...msg, from: ws.peerId });
    }
  });

  ws.on('close', () => {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;
    room.delete(ws);
    broadcastToOthers(room, ws, { type: 'peer-left', peerId: ws.peerId, peerCount: room.size });
    if (room.size === 0) rooms.delete(ws.roomId);
    console.log(`peer ${ws.peerId} left room ${ws.roomId}`);
  });

  ws.on('error', (err) => {
    console.warn('ws error:', err.message);
  });
});

server.listen(PORT, () => {
  console.log(`signal-server listening on :${PORT}`);
});
