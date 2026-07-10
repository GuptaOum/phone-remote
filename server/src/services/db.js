/**
 * Database layer — one async API, two backends:
 *
 *   DATABASE_URL set     → PostgreSQL (RDS in production)
 *   DATABASE_URL missing → SQLite file server/data/phoneremote.db (local dev)
 *
 * Schema:
 *   users   → id (uuid), email, password_hash, created_at
 *   devices → id (uuid from phone), user_id, name, model, last_seen
 */
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const PG_URL = process.env.DATABASE_URL || '';

let impl; // { query(sql, params) → rows }  — normalized across backends

async function init() {
  if (PG_URL) {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: PG_URL,
      ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
    });
    impl = {
      kind: 'postgres',
      query: async (sql, params = []) => (await pool.query(sql, params)).rows,
    };
    await impl.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        email         TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at    BIGINT NOT NULL
      )`);
    await impl.query(`
      CREATE TABLE IF NOT EXISTS devices (
        id        TEXT PRIMARY KEY,
        user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name      TEXT,
        model     TEXT,
        last_seen BIGINT
      )`);
    await impl.query('ALTER TABLE devices ADD COLUMN IF NOT EXISTS revoked_at BIGINT');
    console.log('🗄️  Database: PostgreSQL');
  } else {
    const Database = require('better-sqlite3');
    const dataDir = path.join(__dirname, '../../data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const db = new Database(path.join(dataDir, 'phoneremote.db'));
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        email         TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id        TEXT PRIMARY KEY,
        user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name      TEXT,
        model     TEXT,
        last_seen INTEGER
      );`);
    // Migration: revoked_at marks devices removed from the dashboard
    try { db.exec('ALTER TABLE devices ADD COLUMN revoked_at INTEGER'); } catch (_) { /* already exists */ }
    impl = {
      kind: 'sqlite',
      // Translate $1,$2… placeholders to ? so both backends share SQL strings
      query: async (sql, params = []) => {
        const q = sql.replace(/\$\d+/g, '?');
        const stmt = db.prepare(q);
        return stmt.reader ? stmt.all(...params) : (stmt.run(...params), []);
      },
    };
    console.log('🗄️  Database: SQLite (local dev — set DATABASE_URL for PostgreSQL)');
  }
}

// ── Users ────────────────────────────────────────────────────────────────────

async function createUser(email, passwordHash) {
  const id = uuidv4();
  await impl.query(
    'INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)',
    [id, email.toLowerCase(), passwordHash, Date.now()]
  );
  return { id, email: email.toLowerCase() };
}

async function getUserByEmail(email) {
  const rows = await impl.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  return rows[0] || null;
}

async function getUserById(id) {
  const rows = await impl.query('SELECT id, email, created_at FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

// ── Devices ──────────────────────────────────────────────────────────────────

async function upsertDevice({ id, userId, name, model }) {
  const existing = await impl.query('SELECT id FROM devices WHERE id = $1', [id]);
  if (existing.length) {
    // Re-registration also clears any revocation — the register path only
    // allows this when the phone holds a token issued after the revocation.
    await impl.query(
      'UPDATE devices SET user_id = $1, name = $2, model = $3, last_seen = $4, revoked_at = NULL WHERE id = $5',
      [userId, name, model, Date.now(), id]
    );
  } else {
    await impl.query(
      'INSERT INTO devices (id, user_id, name, model, last_seen) VALUES ($1, $2, $3, $4, $5)',
      [id, userId, name, model, Date.now()]
    );
  }
}

async function getDevice(id) {
  const rows = await impl.query('SELECT * FROM devices WHERE id = $1', [id]);
  return rows[0] || null;
}

/** Mark a device as revoked — kept in the DB so reconnects with old tokens can be rejected. */
async function revokeDeviceRow(id, userId) {
  await impl.query('UPDATE devices SET revoked_at = $1 WHERE id = $2 AND user_id = $3', [Date.now(), id, userId]);
}

async function touchDevice(id) {
  await impl.query('UPDATE devices SET last_seen = $1 WHERE id = $2', [Date.now(), id]);
}

async function listDevices(userId) {
  return impl.query(
    'SELECT id, name, model, last_seen FROM devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY last_seen DESC',
    [userId]
  );
}

async function deleteDevice(id, userId) {
  await impl.query('DELETE FROM devices WHERE id = $1 AND user_id = $2', [id, userId]);
}

module.exports = { init, createUser, getUserByEmail, getUserById, upsertDevice, getDevice, revokeDeviceRow, touchDevice, listDevices, deleteDevice };
