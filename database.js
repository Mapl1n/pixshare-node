/**
 * PixShare Database — SQLite via sql.js (pure WASM, no native deps)
 *
 * sql.js is a pure JavaScript/WASM implementation of SQLite —
 * works on Windows, macOS, and Linux without any native compilation.
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'pixshare.db');
let db = null;

/**
 * Initialize the database (must be called once before using other functions).
 * sql.js initSqlJS is async (loads WASM), so this must be awaited.
 */
async function initDB() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  // Load existing DB or create new
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Schema
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      creator_id INTEGER REFERENCES users(id),
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      is_active INTEGER DEFAULT 1
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS transfer_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT REFERENCES rooms(id),
      sender_id INTEGER REFERENCES users(id),
      file_count INTEGER DEFAULT 0,
      total_size INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  saveDB();
  console.log('📦 Database: sql.js (WASM SQLite) initialized');
  return db;
}

function saveDB() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function queryAll(sql, params = []) {
  if (!db) return [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function queryOne(sql, params = []) {
  const results = queryAll(sql, params);
  return results.length > 0 ? results[0] : null;
}

function run(sql, params = []) {
  if (!db) return;
  db.run(sql, params);
  saveDB();
}

// ---- User helpers ----
function createUser(username, passwordHash) {
  const existing = findUserByUsername(username);
  if (existing) return null;
  run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [username, passwordHash]);
  return findUserByUsername(username);
}

function findUserByUsername(username) {
  return queryOne('SELECT * FROM users WHERE username = ?', [username]);
}

function findUserById(id) {
  return queryOne('SELECT id, username, created_at FROM users WHERE id = ?', [id]);
}

// ---- Room helpers ----
function createRoom(id, creatorId, name, expiresAt) {
  run('INSERT OR IGNORE INTO rooms (id, creator_id, name, expires_at) VALUES (?, ?, ?, ?)',
    [id, creatorId || null, name || '', expiresAt]);
}

function getRoom(id) {
  return queryOne('SELECT * FROM rooms WHERE id = ?', [id]);
}

function getActiveRooms() {
  const now = new Date().toISOString();
  return queryAll(
    "SELECT * FROM rooms WHERE is_active = 1 AND expires_at > ? ORDER BY created_at DESC",
    [now]
  );
}

function deactivateRoom(id) {
  run('UPDATE rooms SET is_active = 0 WHERE id = ?', [id]);
}

// ---- Transfer log helpers ----
function logTransfer(roomId, senderId, fileCount, totalSize) {
  run('INSERT INTO transfer_logs (room_id, sender_id, file_count, total_size) VALUES (?, ?, ?, ?)',
    [roomId, senderId || null, fileCount, totalSize]);
}

function getTransferHistory(userId, limit = 50) {
  return queryAll(
    `SELECT tl.*, r.name as room_name
     FROM transfer_logs tl
     LEFT JOIN rooms r ON tl.room_id = r.id
     WHERE tl.sender_id = ?
     ORDER BY tl.created_at DESC LIMIT ?`,
    [userId, limit]
  );
}

// ---- Stats ----
function getStats() {
  const now = new Date().toISOString();
  return {
    activeRooms: queryOne(
      "SELECT COUNT(*) as c FROM rooms WHERE is_active = 1 AND expires_at > ?", [now]
    )?.c || 0,
    totalUsers: queryOne('SELECT COUNT(*) as c FROM users')?.c || 0,
    totalTransfers: queryOne('SELECT COUNT(*) as c FROM transfer_logs')?.c || 0,
  };
}

// Cleanup expired rooms every 60s
setInterval(() => {
  const now = new Date().toISOString();
  run("UPDATE rooms SET is_active = 0 WHERE expires_at <= ? AND is_active = 1", [now]);
}, 60000);

module.exports = {
  initDB,
  createUser,
  findUserByUsername,
  findUserById,
  createRoom,
  getRoom,
  getActiveRooms,
  deactivateRoom,
  logTransfer,
  getTransferHistory,
  getStats,
};
