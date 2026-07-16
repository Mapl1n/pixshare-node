/**
 * PixShare Node.js Server v2.0
 *
 * Self-contained: HTTP REST API + WebSocket signaling + static file serving
 * New in v2: SQLite persistence, JWT auth, room management, transfer history
 *
 * Usage:
 *   node server.js              → start on port 8080
 *   node server.js --port 3000  → custom port
 *   JWT_SECRET=mysecret node    → custom JWT signing key
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');

// ---- Modules ----
const auth = require('./auth');
const db = require('./database');

// DB will be initialized asynchronously in startServer()

// ---- Config ----
const PORT = parseInt(process.env.PORT || process.argv[3] || '8080', 10);
const ROOM_TTL = 10 * 60 * 1000; // 10 min fallback for in-memory rooms

// ---- In-memory WebSocket state (coexists with DB-persisted rooms) ----
const wsRooms = new Map(); // roomCode -> { sender: ws|null, receiver: ws|null, created: timestamp }

// Clean expired in-memory WS rooms every 60s
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of wsRooms) {
    if (now - room.created > ROOM_TTL) {
      if (room.sender) try { room.sender.close(); } catch (e) {}
      if (room.receiver) try { room.receiver.close(); } catch (e) {}
      wsRooms.delete(code);
      console.log(`🧹 Room ${code} expired`);
    }
  }
}, 60000);

// ---- Helpers ----
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const [, nets] of Object.entries(interfaces)) {
    for (const net of nets) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

function generateRoomCode() {
  return crypto.randomInt(100000, 999999).toString();
}

const STATIC_DIR = path.join(__dirname, 'public');

// ======================== HTTP Server ========================
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;
  const p = url.pathname;

  // ---- Parse auth token (optional) ----
  const authHeader = req.headers.authorization;
  let currentUser = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    currentUser = auth.verifyToken(authHeader.slice(7));
  }

  try {
    // ==================== Health ====================
    if (p === '/api/health' && method === 'GET') {
      const stats = db.getStats();
      return sendJSON(res, 200, {
        status: 'ok',
        rooms: wsRooms.size,
        ...stats,
      });
    }

    // ==================== Auth ====================
    if (p === '/api/auth/register' && method === 'POST') {
      const body = await parseBody(req);
      if (!body.username || !body.password) {
        return sendJSON(res, 400, { error: 'username and password required' });
      }
      const hash = auth.hashPassword(body.password);
      const result = db.createUser(body.username, hash);
      if (!result) {
        return sendJSON(res, 409, { error: '用户名已存在' });
      }
      const user = db.findUserByUsername(body.username);
      const token = auth.generateToken(user);
      return sendJSON(res, 201, { token, user: { id: user.id, username: user.username } });
    }

    if (p === '/api/auth/login' && method === 'POST') {
      const body = await parseBody(req);
      const user = db.findUserByUsername(body.username);
      if (!user || !auth.verifyPassword(body.password, user.password_hash)) {
        return sendJSON(res, 401, { error: '用户名或密码错误' });
      }
      const token = auth.generateToken(user);
      return sendJSON(res, 200, { token, user: { id: user.id, username: user.username } });
    }

    if (p === '/api/auth/me' && method === 'GET') {
      if (!currentUser) return sendJSON(res, 401, { error: '未登录' });
      const user = db.findUserById(currentUser.id);
      if (!user) return sendJSON(res, 404, { error: '用户不存在' });
      return sendJSON(res, 200, { user });
    }

    // ==================== Rooms ====================
    if (p === '/api/rooms' && method === 'POST') {
      const body = await parseBody(req);
      const roomCode = body.room || generateRoomCode();
      const expiresAt = new Date(Date.now() + ROOM_TTL).toISOString();
      db.createRoom(roomCode, currentUser?.id || null, body.name || '', expiresAt);
      return sendJSON(res, 201, { room: roomCode, expiresAt });
    }

    if (p === '/api/rooms' && method === 'GET') {
      const rooms = db.getActiveRooms().map((r) => ({
        id: r.id,
        name: r.name,
        created_at: r.created_at,
        expires_at: r.expires_at,
        active: wsRooms.has(r.id),
      }));
      return sendJSON(res, 200, { rooms });
    }

    if (p.match(/^\/api\/rooms\/(.+)$/) && method === 'GET') {
      const roomId = p.match(/^\/api\/rooms\/(.+)$/)[1];
      const room = db.getRoom(roomId);
      if (!room) return sendJSON(res, 404, { error: '房间不存在' });
      return sendJSON(res, 200, { room, active: wsRooms.has(roomId) });
    }

    if (p.match(/^\/api\/rooms\/(.+)$/) && method === 'DELETE') {
      const roomId = p.match(/^\/api\/rooms\/(.+)$/)[1];
      if (!currentUser) return sendJSON(res, 401, { error: '未登录' });
      const room = db.getRoom(roomId);
      if (!room) return sendJSON(res, 404, { error: '房间不存在' });
      if (room.creator_id && room.creator_id !== currentUser.id) {
        return sendJSON(res, 403, { error: '无权删除此房间' });
      }
      db.deleteRoom(roomId);
      // Also close active WebSocket connections
      const wsRoom = wsRooms.get(roomId);
      if (wsRoom) {
        if (wsRoom.sender) try { wsRoom.sender.close(); } catch (e) {}
        if (wsRoom.receiver) try { wsRoom.receiver.close(); } catch (e) {}
        wsRooms.delete(roomId);
      }
      return sendJSON(res, 200, { success: true });
    }

    // ==================== History ====================
    if (p === '/api/history' && method === 'GET') {
      if (!currentUser) return sendJSON(res, 401, { error: '未登录' });
      const history = db.getTransferHistory(currentUser.id);
      return sendJSON(res, 200, { history });
    }

    // ==================== Static Files ====================
    let filePath = p === '/' ? '/index.html' : p;
    filePath = path.join(STATIC_DIR, filePath);

    if (!filePath.startsWith(STATIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not Found');
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

  } catch (err) {
    console.error('HTTP error:', err);
    sendJSON(res, 500, { error: 'Internal server error' });
  }
});

// ==================== WebSocket Signaling ====================
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let role = null;
  let roomCode = null;
  let transferFiles = 0;
  let transferSize = 0;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }

    // Track transfer stats from relay messages
    if (msg.type === 'relay') {
      if (msg.subtype === 'file-start' || msg.subtype === 'metadata') {
        transferFiles = transferFiles + 1;
        transferSize += msg.data?.size || msg.data?.fileSize || 0;
      }
    }

    switch (msg.type) {
      case 'create': {
        roomCode = msg.room;
        role = 'sender';
        if (!wsRooms.has(roomCode)) {
          wsRooms.set(roomCode, { sender: ws, receiver: null, created: Date.now() });
        } else {
          wsRooms.get(roomCode).sender = ws;
        }
        // Also ensure DB room exists
        if (!db.getRoom(roomCode)) {
          const expiresAt = new Date(Date.now() + ROOM_TTL).toISOString();
          db.createRoom(roomCode, null, '', expiresAt);
        }
        console.log(`🏠 Room ${roomCode}: sender connected`);
        ws.send(JSON.stringify({ type: 'created', room: roomCode }));
        break;
      }

      case 'join': {
        roomCode = msg.room;
        role = 'receiver';
        const room = wsRooms.get(roomCode);
        if (room) {
          room.receiver = ws;
          console.log(`🚪 Room ${roomCode}: receiver joined`);
          ws.send(JSON.stringify({ type: 'joined', room: roomCode }));
          if (room.sender) {
            room.sender.send(JSON.stringify({ type: 'join-request' }));
          }
        } else {
          ws.send(JSON.stringify({ type: 'error', message: '房间不存在，请核对数字' }));
        }
        break;
      }

      case 'relay': {
        const room = wsRooms.get(roomCode || msg.room);
        if (!room) return;
        const target = role === 'sender' ? room.receiver : room.sender;
        if (target) {
          target.send(JSON.stringify({ type: msg.subtype || 'relay', data: msg.data || msg }));
        }
        break;
      }

      case 'confirm': {
        const room = wsRooms.get(roomCode || msg.room);
        if (room && room.receiver) {
          room.receiver.send(JSON.stringify({ type: 'confirmed' }));
        }
        break;
      }

      case 'offer': {
        const room = wsRooms.get(msg.room);
        if (room && room.receiver) room.receiver.send(JSON.stringify(msg));
        break;
      }

      case 'answer': {
        const room = wsRooms.get(msg.room);
        if (room && room.sender) room.sender.send(JSON.stringify(msg));
        break;
      }

      case 'complete': {
        // Transfer completed — log it
        if (roomCode && role === 'sender' && transferFiles > 0) {
          db.logTransfer(roomCode, null, transferFiles, transferSize);
          console.log(`📊 Room ${roomCode}: ${transferFiles} files, ${transferSize} bytes logged`);
          transferFiles = 0;
          transferSize = 0;
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    // Log any in-progress transfer
    if (roomCode && role === 'sender' && transferFiles > 0) {
      db.logTransfer(roomCode, null, transferFiles, transferSize);
    }

    if (roomCode && wsRooms.has(roomCode)) {
      const room = wsRooms.get(roomCode);
      if (role === 'sender') room.sender = null;
      if (role === 'receiver') room.receiver = null;

      const other = role === 'sender' ? room.receiver : room.sender;
      if (other) {
        try { other.send(JSON.stringify({ type: 'peer-disconnected' })); } catch (e) {}
      }

      if (!room.sender && !room.receiver) {
        wsRooms.delete(roomCode);
        console.log(`🗑️  Room ${roomCode}: deleted`);
      }
    }
  });

  ws.on('error', () => {});
});

// ==================== Start ====================
async function startServer() {
  // Initialize SQLite WASM database first
  await db.initDB();

  server.listen(PORT, () => {
    const ips = getLocalIPs();
    console.log('');
    console.log('╔══════════════════════════════════╗');
    console.log('║     📸 PixShare Server v2.0     ║');
    console.log('╠══════════════════════════════════╣');
    const portPad = PORT < 1000 ? ' ' : '';
    console.log(`║  Local:  http://localhost:${PORT}     ${portPad}║`);
    for (const ip of ips) {
      const pad = ' '.repeat(Math.max(0, 26 - ip.length - 6));
      console.log(`║  LAN:    http://${ip}:${PORT}${pad}║`);
    }
    console.log('╠══════════════════════════════════╣');
    console.log('║  API:    /api/auth/register      ║');
    console.log('║  API:    /api/rooms              ║');
    console.log('║  API:    /api/history            ║');
    console.log('║  API:    /api/health             ║');
    console.log('╚══════════════════════════════════╝');
    console.log('');
    console.log('📱 Same WiFi？好友打开上面的 LAN 地址');
    console.log('');
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
