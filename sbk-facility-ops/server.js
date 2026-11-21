'use strict';
/**
 * SBK Facility Ops — server
 * Attendance, bin disposal, DEWA meter readings and security patrol.
 *
 * Node >= 22.13 (uses the built-in node:sqlite, so there are no native modules to compile).
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

// ---------- config ----------
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const APP_TZ = process.env.APP_TZ || 'Asia/Dubai';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 14);
const TRUST_PROXY = process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- database ----------
const db = new DatabaseSync(path.join(DATA_DIR, 'sbk-ops.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','supervisor','staff')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  site_id INTEGER REFERENCES sites(id),
  type TEXT NOT NULL CHECK (type IN ('in','out')),
  ts TEXT NOT NULL, day TEXT NOT NULL,
  lat REAL, lng REAL, accuracy REAL,
  note TEXT, photo TEXT
);
CREATE TABLE IF NOT EXISTS bins (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  site_id INTEGER REFERENCES sites(id),
  location TEXT,
  bin_type TEXT NOT NULL,
  bin_count INTEGER NOT NULL DEFAULT 1,
  ts TEXT NOT NULL, day TEXT NOT NULL,
  note TEXT, photo TEXT
);
CREATE TABLE IF NOT EXISTS meter_readings (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  site_id INTEGER REFERENCES sites(id),
  unit TEXT,
  meter_no TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('electricity','water')),
  reading REAL NOT NULL,
  prev_reading REAL,
  consumption REAL,
  ts TEXT NOT NULL, day TEXT NOT NULL,
  note TEXT, photo TEXT
);
CREATE TABLE IF NOT EXISTS patrols (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  site_id INTEGER REFERENCES sites(id),
  checkpoint_id INTEGER REFERENCES checkpoints(id),
  status TEXT NOT NULL CHECK (status IN ('clear','issue')),
  ts TEXT NOT NULL, day TEXT NOT NULL,
  lat REAL, lng REAL,
  note TEXT, photo TEXT
);
CREATE INDEX IF NOT EXISTS ix_att_day ON attendance(day);
CREATE INDEX IF NOT EXISTS ix_bins_day ON bins(day);
CREATE INDEX IF NOT EXISTS ix_meter_day ON meter_readings(day);
CREATE INDEX IF NOT EXISTS ix_meter_no ON meter_readings(meter_no, kind, ts);
CREATE INDEX IF NOT EXISTS ix_patrol_day ON patrols(day);
`);

// ---------- helpers ----------
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const localDay = (d = new Date()) => dayFmt.format(d); // YYYY-MM-DD in APP_TZ
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: APP_TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const localDateTime = (iso) => `${localDay(new Date(iso))} ${timeFmt.format(new Date(iso))}`;
const nowIso = () => new Date().toISOString();

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function str(v, max = 500) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function intId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => { throw new HttpError(400, msg); };

/** Save a data:image/...;base64 photo, returns the stored file name or null. */
function savePhoto(dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) bad('Photo must be a JPEG, PNG or WebP image');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 4 * 1024 * 1024) bad('Photo is too large (max 4 MB)');
  const name = `${crypto.randomUUID()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return name;
}

function siteExists(id) {
  if (id === null) return null;
  const row = db.prepare('SELECT id FROM sites WHERE id = ?').get(id);
  if (!row) bad('Unknown site');
  return id;
}

// ---------- bootstrap ----------
(function bootstrap() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
    db.prepare('INSERT INTO users (username, name, password_hash, role) VALUES (?,?,?,?)')
      .run(username, 'Administrator', hashPassword(password), 'admin');
    console.log('='.repeat(60));
    console.log(' First run: created admin account');
    console.log(`   username: ${username}`);
    if (!process.env.ADMIN_PASSWORD) console.log(`   password: ${password}`);
    else console.log('   password: (from ADMIN_PASSWORD)');
    console.log(' Sign in and change it from the Profile screen.');
    console.log('='.repeat(60));
  }
  const sites = db.prepare('SELECT COUNT(*) AS n FROM sites').get().n;
  if (sites === 0) {
    const ins = db.prepare('INSERT INTO sites (name) VALUES (?)');
    const id = ins.run('Main Building').lastInsertRowid;
    const cp = db.prepare('INSERT INTO checkpoints (site_id, name) VALUES (?,?)');
    ['Main Gate', 'Lobby', 'Parking Basement', 'Roof Access', 'Fire Exit'].forEach((n) => cp.run(id, n));
  }
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
})();

// ---------- app ----------
const app = express();
app.set('trust proxy', TRUST_PROXY);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(self), camera=(self)',
    'Content-Security-Policy':
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  next();
});

app.use(express.json({ limit: '8mb' }));

// Cookie-based sessions stored in SQLite.
const COOKIE = 'sbk_sid';
function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function setSessionCookie(req, res, token, maxAgeSec) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (req.secure) parts.push('Secure');
  res.set('Set-Cookie', parts.join('; '));
}

app.use((req, res, next) => {
  req.user = null;
  const token = readCookie(req, COOKIE);
  if (token) {
    const row = db.prepare(`
      SELECT u.id, u.username, u.name, u.role, u.active, s.expires_at
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).get(sha256(token));
    if (row && row.active && row.expires_at > Date.now()) {
      req.user = { id: row.id, username: row.username, name: row.name, role: row.role };
      req.sessionHash = sha256(token);
    }
  }
  next();
});

// CSRF guard: every state-changing API call must be a JSON request from our own front end.
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    if (req.get('X-Requested-With') !== 'sbk-ops' || !req.is('application/json')) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }
  next();
});

const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please sign in' }));
const requireRole = (...roles) => (req, res, next) =>
  !req.user ? res.status(401).json({ error: 'Please sign in' })
    : roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'Not allowed for your role' });
const isManager = (u) => u.role === 'admin' || u.role === 'supervisor';
const wrap = (fn) => (req, res, next) => { try { const r = fn(req, res); if (r !== undefined) res.json(r); } catch (e) { next(e); } };

// ---------- auth ----------
const loginAttempts = new Map(); // ip -> { count, until }
app.post('/api/login', wrap((req, res) => {
  const ip = req.ip;
  const rec = loginAttempts.get(ip);
  if (rec && rec.until > Date.now() && rec.count >= 8) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
  const username = str(req.body.username, 64);
  const password = String(req.body.password || '');
  const user = username && db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    const r = rec && rec.until > Date.now() ? rec : { count: 0, until: Date.now() + 10 * 60 * 1000 };
    r.count++; loginAttempts.set(ip, r);
    throw new HttpError(401, 'Wrong username or password');
  }
  loginAttempts.delete(ip);
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)')
    .run(sha256(token), user.id, Date.now() + SESSION_DAYS * 86400e3);
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
  return { user: { id: user.id, username: user.username, name: user.name, role: user.role } };
}));

app.post('/api/logout', wrap((req, res) => {
  if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionHash);
  setSessionCookie(req, res, '', 0);
  return { ok: true };
}));

app.get('/api/me', requireAuth, wrap((req) => ({ user: req.user, tz: APP_TZ, today: localDay() })));

app.post('/api/me/password', requireAuth, wrap((req) => {
  const { current, next: nextPw } = req.body || {};
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(current || ''), user.password_hash)) bad('Current password is wrong');
  if (String(nextPw || '').length < 8) bad('New password must be at least 8 characters');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(nextPw)), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(req.user.id, req.sessionHash);
  return { ok: true };
}));

// ---------- reference data ----------
app.get('/api/meta', requireAuth, wrap(() => ({
  sites: db.prepare('SELECT id, name, active FROM sites ORDER BY name').all(),
  checkpoints: db.prepare('SELECT id, site_id, name, active FROM checkpoints ORDER BY site_id, id').all(),
})));

// ---------- generic list query ----------
const MODULES = {
  attendance: {
    table: 'attendance',
    cols: 'r.id, r.type, r.ts, r.day, r.lat, r.lng, r.accuracy, r.note, r.photo',
    csv: ['ts', 'day', 'staff', 'site', 'type', 'lat', 'lng', 'accuracy', 'note'],
  },
  bins: {
    table: 'bins',
    cols: 'r.id, r.location, r.bin_type, r.bin_count, r.ts, r.day, r.note, r.photo',
    csv: ['ts', 'day', 'staff', 'site', 'location', 'bin_type', 'bin_count', 'note'],
  },
  meters: {
    table: 'meter_readings',
    cols: 'r.id, r.unit, r.meter_no, r.kind, r.reading, r.prev_reading, r.consumption, r.ts, r.day, r.note, r.photo',
    csv: ['ts', 'day', 'staff', 'site', 'unit', 'meter_no', 'kind', 'reading', 'prev_reading', 'consumption', 'note'],
  },
  patrols: {
    table: 'patrols',
    cols: 'r.id, r.status, r.ts, r.day, r.lat, r.lng, r.note, r.photo, c.name AS checkpoint, r.checkpoint_id',
    join: 'LEFT JOIN checkpoints c ON c.id = r.checkpoint_id',
    csv: ['ts', 'day', 'staff', 'site', 'checkpoint', 'status', 'lat', 'lng', 'note'],
  },
};

function listRecords(mod, req, { limit = 200 } = {}) {
  const m = MODULES[mod];
  const where = [];
  const params = [];
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const from = DAY.test(req.query.from || '') ? req.query.from : null;
  const to = DAY.test(req.query.to || '') ? req.query.to : null;
  if (from) { where.push('r.day >= ?'); params.push(from); }
  if (to) { where.push('r.day <= ?'); params.push(to); }
  const site = intId(req.query.site);
  if (site) { where.push('r.site_id = ?'); params.push(site); }
  if (!isManager(req.user)) { where.push('r.user_id = ?'); params.push(req.user.id); }
  else if (intId(req.query.user)) { where.push('r.user_id = ?'); params.push(intId(req.query.user)); }
  const sql = `
    SELECT ${m.cols}, r.user_id, u.name AS staff, r.site_id, s.name AS site
    FROM ${m.table} r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN sites s ON s.id = r.site_id
    ${m.join || ''}
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY r.ts DESC
    ${limit ? `LIMIT ${Number(limit)}` : ''}`;
  return db.prepare(sql).all(...params);
}

for (const mod of Object.keys(MODULES)) {
  app.get(`/api/${mod}`, requireAuth, wrap((req) => ({ rows: listRecords(mod, req, { limit: Math.min(Number(req.query.limit) || 200, 1000) }) })));
  app.delete(`/api/${mod}/:id`, requireRole('admin'), wrap((req) => {
    const id = intId(req.params.id);
    const row = id && db.prepare(`SELECT photo FROM ${MODULES[mod].table} WHERE id = ?`).get(id);
    if (!row) throw new HttpError(404, 'Not found');
    db.prepare(`DELETE FROM ${MODULES[mod].table} WHERE id = ?`).run(id);
    if (row.photo) fs.rm(path.join(UPLOAD_DIR, path.basename(row.photo)), () => {});
    return { ok: true };
  }));
}

// ---------- attendance ----------
app.get('/api/attendance/status', requireAuth, wrap((req) => {
  const last = db.prepare(`SELECT type, ts, site_id FROM attendance WHERE user_id = ? AND day = ? ORDER BY ts DESC LIMIT 1`)
    .get(req.user.id, localDay());
  return { last: last || null };
}));

app.post('/api/attendance', requireAuth, wrap((req) => {
  const b = req.body || {};
  const type = b.type === 'in' || b.type === 'out' ? b.type : bad('Type must be in or out');
  const day = localDay();
  const last = db.prepare(`SELECT type FROM attendance WHERE user_id = ? AND day = ? ORDER BY ts DESC LIMIT 1`).get(req.user.id, day);
  if (type === 'in' && last && last.type === 'in') bad('You are already checked in');
  if (type === 'out' && (!last || last.type === 'out')) bad('You are not checked in');
  const r = db.prepare(`INSERT INTO attendance (user_id, site_id, type, ts, day, lat, lng, accuracy, note, photo)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(req.user.id, siteExists(intId(b.site_id)), type, nowIso(), day,
    num(b.lat), num(b.lng), num(b.accuracy), str(b.note), savePhoto(b.photo));
  return { id: Number(r.lastInsertRowid) };
}));

// ---------- bins ----------
app.post('/api/bins', requireAuth, wrap((req) => {
  const b = req.body || {};
  const binType = str(b.bin_type, 40) || bad('Choose the waste type');
  const count = Number.isInteger(Number(b.bin_count)) && Number(b.bin_count) > 0 && Number(b.bin_count) <= 500
    ? Number(b.bin_count) : bad('Bin count must be between 1 and 500');
  const r = db.prepare(`INSERT INTO bins (user_id, site_id, location, bin_type, bin_count, ts, day, note, photo)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(req.user.id, siteExists(intId(b.site_id)), str(b.location, 120), binType, count,
    nowIso(), localDay(), str(b.note), savePhoto(b.photo));
  return { id: Number(r.lastInsertRowid) };
}));

// ---------- DEWA meters ----------
app.get('/api/meters/last', requireAuth, wrap((req) => {
  const meterNo = str(req.query.meter_no, 60);
  const kind = req.query.kind;
  if (!meterNo || !['electricity', 'water'].includes(kind)) return { last: null };
  return {
    last: db.prepare(`SELECT reading, ts, unit, site_id FROM meter_readings WHERE meter_no = ? AND kind = ? ORDER BY ts DESC LIMIT 1`)
      .get(meterNo, kind) || null,
  };
}));

app.get('/api/meters/list', requireAuth, wrap(() => ({
  meters: db.prepare(`
    SELECT meter_no, kind, unit, site_id, MAX(ts) AS last_ts
    FROM meter_readings GROUP BY meter_no, kind ORDER BY meter_no`).all(),
})));

app.post('/api/meters', requireAuth, wrap((req) => {
  const b = req.body || {};
  const meterNo = str(b.meter_no, 60) || bad('Meter number is required');
  const kind = ['electricity', 'water'].includes(b.kind) ? b.kind : bad('Choose electricity or water');
  const reading = num(b.reading);
  if (reading === null || reading < 0) bad('Enter a valid reading');
  const prev = db.prepare(`SELECT reading FROM meter_readings WHERE meter_no = ? AND kind = ? ORDER BY ts DESC LIMIT 1`).get(meterNo, kind);
  const prevReading = prev ? prev.reading : null;
  if (prevReading !== null && reading < prevReading && !b.confirm_lower) {
    throw new HttpError(409, `Reading is lower than the previous one (${prevReading}). Confirm to save anyway.`);
  }
  const consumption = prevReading === null ? null : Math.round((reading - prevReading) * 1000) / 1000;
  const r = db.prepare(`INSERT INTO meter_readings (user_id, site_id, unit, meter_no, kind, reading, prev_reading, consumption, ts, day, note, photo)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.user.id, siteExists(intId(b.site_id)), str(b.unit, 60), meterNo, kind, reading,
    prevReading, consumption, nowIso(), localDay(), str(b.note), savePhoto(b.photo));
  return { id: Number(r.lastInsertRowid), consumption };
}));

// ---------- security patrol ----------
app.post('/api/patrols', requireAuth, wrap((req) => {
  const b = req.body || {};
  const cpId = intId(b.checkpoint_id) || bad('Choose a checkpoint');
  const cp = db.prepare('SELECT id, site_id FROM checkpoints WHERE id = ?').get(cpId) || bad('Unknown checkpoint');
  const status = b.status === 'issue' ? 'issue' : 'clear';
  if (status === 'issue' && !str(b.note)) bad('Describe the issue');
  const r = db.prepare(`INSERT INTO patrols (user_id, site_id, checkpoint_id, status, ts, day, lat, lng, note, photo)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(req.user.id, cp.site_id, cp.id, status, nowIso(), localDay(),
    num(b.lat), num(b.lng), str(b.note), savePhoto(b.photo));
  return { id: Number(r.lastInsertRowid) };
}));

// ---------- dashboard ----------
app.get('/api/dashboard', requireAuth, wrap((req) => {
  const day = localDay();
  const mine = !isManager(req.user);
  const f = mine ? ' AND user_id = ' + Number(req.user.id) : '';
  const one = (sql) => db.prepare(sql).get(day);
  const onDuty = db.prepare(`
    SELECT u.name, a.ts, s.name AS site FROM attendance a
    JOIN users u ON u.id = a.user_id LEFT JOIN sites s ON s.id = a.site_id
    WHERE a.day = ? AND a.id IN (SELECT MAX(id) FROM attendance WHERE day = ? GROUP BY user_id) AND a.type = 'in'
    ORDER BY a.ts`).all(day, day);
  const cpTotal = db.prepare('SELECT COUNT(*) AS n FROM checkpoints WHERE active = 1').get().n;
  const cpDone = db.prepare(`SELECT COUNT(DISTINCT checkpoint_id) AS n FROM patrols WHERE day = ?${f}`).get(day).n;
  return {
    day,
    onDuty: mine ? onDuty.filter((r) => r.name === req.user.name) : onDuty,
    bins: one(`SELECT COUNT(*) AS entries, COALESCE(SUM(bin_count),0) AS bins FROM bins WHERE day = ?${f}`),
    meters: one(`SELECT COUNT(*) AS n FROM meter_readings WHERE day = ?${f}`),
    patrols: { ...one(`SELECT COUNT(*) AS n, SUM(status = 'issue') AS issues FROM patrols WHERE day = ?${f}`), cpDone, cpTotal },
    issues: db.prepare(`
      SELECT p.ts, p.note, c.name AS checkpoint, u.name AS staff FROM patrols p
      JOIN users u ON u.id = p.user_id LEFT JOIN checkpoints c ON c.id = p.checkpoint_id
      WHERE p.day = ? AND p.status = 'issue'${f.replace('user_id', 'p.user_id')} ORDER BY p.ts DESC LIMIT 10`).all(day),
  };
}));

// ---------- CSV export ----------
function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // prevent spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
app.get('/api/export/:mod', requireRole('admin', 'supervisor'), (req, res, next) => {
  try {
    const mod = req.params.mod.replace(/\.csv$/, '');
    if (!MODULES[mod]) throw new HttpError(404, 'Unknown module');
    const rows = listRecords(mod, req, { limit: 0 }).map((r) => ({ ...r, time: localDateTime(r.ts) }));
    const cols = ['time', ...MODULES[mod].csv.filter((c) => c !== 'ts')];
    const body = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="sbk-${mod}-${localDay()}.csv"`);
    res.send('﻿' + body);
  } catch (e) { next(e); }
});

// ---------- admin: users / sites / checkpoints ----------
app.get('/api/users', requireRole('admin', 'supervisor'), wrap(() => ({
  users: db.prepare('SELECT id, username, name, role, active, created_at FROM users ORDER BY active DESC, name').all(),
})));
app.post('/api/users', requireRole('admin'), wrap((req) => {
  const b = req.body || {};
  const username = str(b.username, 40);
  if (!username || !/^[a-zA-Z0-9._-]{3,40}$/.test(username)) bad('Username: 3–40 letters, numbers, . _ -');
  const name = str(b.name, 80) || bad('Name is required');
  const role = ['admin', 'supervisor', 'staff'].includes(b.role) ? b.role : 'staff';
  if (String(b.password || '').length < 8) bad('Password must be at least 8 characters');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) bad('That username is taken');
  const r = db.prepare('INSERT INTO users (username, name, password_hash, role) VALUES (?,?,?,?)')
    .run(username, name, hashPassword(String(b.password)), role);
  return { id: Number(r.lastInsertRowid) };
}));
app.patch('/api/users/:id', requireRole('admin'), wrap((req) => {
  const id = intId(req.params.id);
  const user = id && db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) throw new HttpError(404, 'Not found');
  const b = req.body || {};
  if (b.name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(str(b.name, 80) || bad('Name is required'), id);
  if (b.role !== undefined) {
    if (!['admin', 'supervisor', 'staff'].includes(b.role)) bad('Bad role');
    if (id === req.user.id && b.role !== 'admin') bad('You cannot remove your own admin role');
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(b.role, id);
  }
  if (b.active !== undefined) {
    if (id === req.user.id && !b.active) bad('You cannot deactivate yourself');
    db.prepare('UPDATE users SET active = ? WHERE id = ?').run(b.active ? 1 : 0, id);
    if (!b.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  if (b.password) {
    if (String(b.password).length < 8) bad('Password must be at least 8 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(b.password)), id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  return { ok: true };
}));

app.post('/api/sites', requireRole('admin'), wrap((req) => {
  const name = str(req.body.name, 80) || bad('Site name is required');
  if (db.prepare('SELECT 1 FROM sites WHERE name = ?').get(name)) bad('That site already exists');
  return { id: Number(db.prepare('INSERT INTO sites (name) VALUES (?)').run(name).lastInsertRowid) };
}));
app.patch('/api/sites/:id', requireRole('admin'), wrap((req) => {
  const id = intId(req.params.id) || bad('Bad id');
  if (req.body.name !== undefined) db.prepare('UPDATE sites SET name = ? WHERE id = ?').run(str(req.body.name, 80) || bad('Name required'), id);
  if (req.body.active !== undefined) db.prepare('UPDATE sites SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, id);
  return { ok: true };
}));
app.post('/api/checkpoints', requireRole('admin'), wrap((req) => {
  const site = siteExists(intId(req.body.site_id)) || bad('Choose a site');
  const name = str(req.body.name, 80) || bad('Checkpoint name is required');
  return { id: Number(db.prepare('INSERT INTO checkpoints (site_id, name) VALUES (?,?)').run(site, name).lastInsertRowid) };
}));
app.patch('/api/checkpoints/:id', requireRole('admin'), wrap((req) => {
  const id = intId(req.params.id) || bad('Bad id');
  if (req.body.name !== undefined) db.prepare('UPDATE checkpoints SET name = ? WHERE id = ?').run(str(req.body.name, 80) || bad('Name required'), id);
  if (req.body.active !== undefined) db.prepare('UPDATE checkpoints SET active = ? WHERE id = ?').run(req.body.active ? 1 : 0, id);
  return { ok: true };
}));

// ---------- photos (signed-in users only) ----------
app.get('/uploads/:file', requireAuth, (req, res) => {
  const file = path.basename(req.params.file);
  if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(file)) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.join(UPLOAD_DIR, file), (err) => err && !res.headersSent && res.status(404).end());
});

// ---------- health + static front end ----------
app.get('/healthz', (req, res) => { db.prepare('SELECT 1').get(); res.json({ ok: true }); });
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, p) { if (p.endsWith('sw.js') || p.endsWith('.html')) res.set('Cache-Control', 'no-cache'); },
}));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- errors ----------
app.use((err, req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload is too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Server error' : err.message });
});

const server = app.listen(PORT, HOST, () => console.log(`SBK Facility Ops running on http://${HOST}:${PORT} (tz ${APP_TZ}, data ${DATA_DIR})`));
const shutdown = () => { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
