/**
 * PixShare Node.js Server
 *
 * Self-contained: HTTP server + WebSocket signaling + static file serving
 * No external dependencies except ws and qrcode (npm install)
 *
 * Usage:
 *   node server.js              → start on port 8080
 *   node server.js --port 3000  → custom port
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');

// ---- Config ----
const PORT = parseInt(process.env.PORT || process.argv[3] || '8080', 10);
const ROOM_TTL = 10 * 60 * 1000; // rooms expire after 10 min

// ---- State ----
const rooms = new Map(); // roomCode -> { sender: ws|null, receiver: ws|null, created: timestamp }

// Clean expired rooms every 60s
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.created > ROOM_TTL) {
      // Close connections for expired rooms
      if (room.sender) try { room.sender.close(); } catch (e) {}
      if (room.receiver) try { room.receiver.close(); } catch (e) {}
      rooms.delete(code);
      console.log(`🧹 Room ${code} expired`);
    }
  }
}, 60000);

// ---- HTTP Server ----
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const [name, nets] of Object.entries(interfaces)) {
    for (const net of nets) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

const STATIC_DIR = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
    return;
  }

  // Serve static files
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(STATIC_DIR, filePath);

  // Security: prevent directory traversal
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath);
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.json': 'application/json',
      '.ico': 'image/x-icon',
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// ---- WebSocket Signaling ----
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let role = null;
  let roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    switch (msg.type) {
      case 'create': {
        roomCode = msg.room;
        role = 'sender';
        if (!rooms.has(roomCode)) {
          rooms.set(roomCode, { sender: ws, receiver: null, created: Date.now() });
        } else {
          rooms.get(roomCode).sender = ws;
        }
        console.log(`🏠 Room ${roomCode}: sender connected`);
        ws.send(JSON.stringify({ type: 'created', room: roomCode }));
        break;
      }

      case 'join': {
        roomCode = msg.room;
        role = 'receiver';
        const room = rooms.get(roomCode);
        if (room) {
          room.receiver = ws;
          console.log(`🚪 Room ${roomCode}: receiver joined`);
          ws.send(JSON.stringify({ type: 'joined', room: roomCode }));
          // Notify sender
          if (room.sender) {
            room.sender.send(JSON.stringify({ type: 'join-request' }));
          }
        } else {
          ws.send(JSON.stringify({ type: 'error', message: '房间不存在，请核对数字' }));
        }
        break;
      }

      case 'relay': {
        // Generic relay: forward any message to the other peer in the room
        const room = rooms.get(roomCode || msg.room);
        if (!room) return;
        const target = role === 'sender' ? room.receiver : room.sender;
        if (target) {
          target.send(JSON.stringify({ type: msg.subtype || 'relay', data: msg.data || msg }));
        }
        break;
      }

      // Sender confirms join → pass to receiver
      case 'confirm': {
        const room = rooms.get(roomCode || msg.room);
        if (room && room.receiver) {
          room.receiver.send(JSON.stringify({ type: 'confirmed' }));
        }
        break;
      }

      // Forward offer/answer between peers
      case 'offer': {
        const room = rooms.get(msg.room);
        if (room && room.receiver) {
          room.receiver.send(JSON.stringify(msg));
        }
        break;
      }

      case 'answer': {
        const room = rooms.get(msg.room);
        if (room && room.sender) {
          room.sender.send(JSON.stringify(msg));
        }
        break;
      }

      case 'join-request': {
        const room = rooms.get(msg.room);
        if (room && room.sender) {
          room.sender.send(JSON.stringify({ type: 'join-request' }));
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (roomCode && rooms.has(roomCode)) {
      const room = rooms.get(roomCode);
      if (role === 'sender') room.sender = null;
      if (role === 'receiver') room.receiver = null;
      // Notify other peer
      const other = role === 'sender' ? room.receiver : room.sender;
      if (other) {
        try { other.send(JSON.stringify({ type: 'peer-disconnected' })); } catch (e) {}
      }
      // Clean empty room
      if (!room.sender && !room.receiver) {
        rooms.delete(roomCode);
        console.log(`🗑️  Room ${roomCode}: deleted`);
      }
    }
  });

  ws.on('error', () => {});
});

// ---- Start ----
server.listen(PORT, () => {
  const ips = getLocalIPs();
  console.log('');
  console.log('╔══════════════════════════════════╗');
  console.log('║     📸 PixShare Server v1.0     ║');
  console.log('╠══════════════════════════════════╣');
  console.log(`║  Local:  http://localhost:${PORT}     ${PORT < 1000 ? ' ' : ''}║`);
  for (const ip of ips) {
    const pad = ' '.repeat(Math.max(0, 26 - ip.length - 6));
    console.log(`║  LAN:    http://${ip}:${PORT}${pad}║`);
  }
  console.log('╠══════════════════════════════════╣');
  console.log('║  Rooms:  ' + rooms.size + ' active'.padEnd(25) + '  ║');
  console.log('╚══════════════════════════════════╝');
  console.log('');
  console.log('📱 Same WiFi？好友打开上面的 LAN 地址');
  console.log('🌐 不同网络？用以下任一方式暴露公网：');
  console.log('');
  console.log('   方法1（推荐）: npx localtunnel --port ' + PORT);
  console.log('   方法2:        ssh -R 80:localhost:' + PORT + ' serveo.net');
  console.log('   方法3:        ngrok http ' + PORT);
  console.log('');
});
