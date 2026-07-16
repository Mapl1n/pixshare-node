/**
 * PixShare Auth — JWT tokens + bcrypt password hashing
 */

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'pixshare-secret-change-in-production';
const JWT_EXPIRES = '7d';

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/**
 * Express-style auth middleware.
 * Attaches `req.user` if valid token found, otherwise proceeds without user.
 */
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }
  const decoded = verifyToken(header.slice(7));
  req.user = decoded ? { id: decoded.id, username: decoded.username } : null;
  next();
}

/**
 * Require authentication — responds 401 if no valid token.
 */
function requireAuth(req, res, next) {
  if (!req.user) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Authentication required' }));
    return;
  }
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateToken,
  verifyToken,
  authMiddleware,
  requireAuth,
};
