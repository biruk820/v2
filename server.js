require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');

const ROLES = ['admin', 'agent', 'accountant', 'hr'];
const ROLE_LABELS = { admin: 'Admin', agent: 'Sales Agent', accountant: 'Accountant', hr: 'Human Resources' };

// ---- Mailer (used to send the "verify your email" link) ----
let mailer = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
} else {
  console.warn('SMTP not configured — verification emails will only be logged to the console, not actually sent.');
}

async function sendVerificationEmail(user, token) {
  const link = `${APP_URL}/api/auth/verify?token=${token}`;
  const subject = 'Verify your Kefko Travel Agent account';
  const text = `Hi ${user.name},\n\nConfirm your email to activate your Kefko staff account:\n${link}\n\nIf you didn't request this, you can ignore this email.`;
  const html = `<p>Hi ${user.name},</p><p>Confirm your email to activate your Kefko staff account:</p><p><a href="${link}">${link}</a></p><p>If you didn't request this, you can ignore this email.</p>`;
  if (!mailer) {
    console.log(`[verification email — SMTP not configured, printing instead]\nTo: ${user.email}\n${text}`);
    return;
  }
  await mailer.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to: user.email, subject, text, html });
}

// Which roles can read / write each module. Admin always has full access.
const PERMISSIONS = {
  sales:     { read: ['admin', 'agent', 'accountant'], write: ['admin', 'agent'] },
  customers: { read: ['admin', 'agent'],                write: ['admin', 'agent'] },
  inventory: { read: ['admin', 'agent'],                write: ['admin', 'agent'] },
  expenses:  { read: ['admin', 'accountant'],           write: ['admin', 'accountant'] },
  payroll:   { read: ['admin', 'hr'],                   write: ['admin', 'hr'] },
  bank:      { read: ['admin', 'accountant'],           write: ['admin', 'accountant'] },
};

const db = new Database(path.join(__dirname, 'kefko.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'agent',
  email_verified INTEGER DEFAULT 0,
  verify_token TEXT,
  verify_token_expires TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  date TEXT, passenger TEXT, airline TEXT, route TEXT, ticket TEXT,
  value REAL, partcomm REAL, subtotal REAL, commpct REAL, total REAL, status TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  name TEXT, phone TEXT, email TEXT, company TEXT, notes TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  airline TEXT, route TEXT, alloc REAL, used REAL, remaining REAL, validity TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  date TEXT, category TEXT, desc TEXT, amount REAL, paidby TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS payroll (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  month TEXT, employee TEXT, base REAL, allow REAL, deduct REAL, net REAL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS bank (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  date TEXT, desc TEXT, bank TEXT, amount REAL, ref TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS booking_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL, phone TEXT, email TEXT,
  origin TEXT, destination TEXT, travel_date TEXT, passengers INTEGER DEFAULT 1,
  notes TEXT, status TEXT DEFAULT 'Pending',
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// Migrate old databases where users.role defaulted to 'staff', or the verification columns didn't exist yet
try {
  db.prepare(`UPDATE users SET role='agent' WHERE role NOT IN ('admin','agent','accountant','hr')`).run();
} catch (e) { /* ignore on fresh db */ }
const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes('email_verified')) db.exec(`ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0`);
if (!userCols.includes('verify_token')) db.exec(`ALTER TABLE users ADD COLUMN verify_token TEXT`);
if (!userCols.includes('verify_token_expires')) db.exec(`ALTER TABLE users ADD COLUMN verify_token_expires TEXT`);

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- Auth middleware ----
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.id;
    req.role = payload.role;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
}

function signToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
}
function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role, roleLabel: ROLE_LABELS[user.role] || user.role };
}

// ---- Auth routes ----
app.post('/api/auth/register', async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const finalRole = ROLES.includes(role) ? role : 'agent';
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });
  const hash = bcrypt.hashSync(password, 10);
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const info = db.prepare('INSERT INTO users (name,email,password_hash,role,verify_token,verify_token_expires) VALUES (?,?,?,?,?,?)')
    .run(name, email.toLowerCase(), hash, finalRole, token, expires);
  const user = { id: info.lastInsertRowid, name, email };
  try {
    await sendVerificationEmail(user, token);
  } catch (e) {
    console.error('Failed to send verification email:', e.message);
  }
  res.json({ pending: true, message: `We've sent a verification link to ${email}. Click it to activate your account before logging in.` });
});

app.get('/api/auth/verify', (req, res) => {
  const { token } = req.query;
  const user = db.prepare('SELECT * FROM users WHERE verify_token = ?').get(token || '');
  if (!user) return res.status(400).send('<h2>This verification link is invalid or has already been used.</h2>');
  if (user.verify_token_expires && new Date(user.verify_token_expires) < new Date()) {
    return res.status(400).send('<h2>This verification link has expired. Please register again or request a new link.</h2>');
  }
  db.prepare('UPDATE users SET email_verified=1, verify_token=NULL, verify_token_expires=NULL WHERE id=?').run(user.id);
  res.send(`<div style="font-family:sans-serif;max-width:420px;margin:60px auto;text-align:center;">
    <h2 style="color:#0E3A5F;">Email verified ✓</h2>
    <p>Your Kefko account is now active. You can close this tab and log in.</p>
    <a href="${APP_URL || '/'}" style="display:inline-block;margin-top:14px;background:#1CA6E0;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;">Go to Login</a>
  </div>`);
});

app.post('/api/auth/resend', async (req, res) => {
  const { email } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase());
  if (!user) return res.status(404).json({ error: 'No account found with that email' });
  if (user.email_verified) return res.status(400).json({ error: 'This account is already verified — try logging in.' });
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE users SET verify_token=?, verify_token_expires=? WHERE id=?').run(token, expires, user.id);
  try {
    await sendVerificationEmail(user, token);
  } catch (e) {
    console.error('Failed to send verification email:', e.message);
    return res.status(500).json({ error: 'Could not send the email right now. Try again shortly.' });
  }
  res.json({ message: `Verification link re-sent to ${user.email}.` });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (!user.email_verified) {
    return res.status(403).json({ error: 'Please verify your email before logging in — check your inbox for the link.', unverified: true });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/api/auth/me', auth, (req, res) => {
  const user = db.prepare('SELECT id,name,email,role FROM users WHERE id=?').get(req.userId);
  if (!user) return res.status(404).json({ error: 'Account not found' });
  res.json({ user: publicUser(user) });
});

// ---- Generic CRUD, gated by department/role permissions ----
function crud(table, columns) {
  const cols = columns.join(',');
  const placeholders = columns.map(() => '?').join(',');
  const perms = PERMISSIONS[table];

  app.get(`/api/${table}`, auth, (req, res) => {
    if (!perms.read.includes(req.role)) return res.status(403).json({ error: 'Your role does not have access to this module' });
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id DESC`).all();
    res.json(rows);
  });

  app.post(`/api/${table}`, auth, (req, res) => {
    if (!perms.write.includes(req.role)) return res.status(403).json({ error: 'Your role cannot add records here' });
    const vals = columns.map(c => req.body[c] ?? null);
    const info = db.prepare(`INSERT INTO ${table} (user_id,${cols}) VALUES (?,${placeholders})`).run(req.userId, ...vals);
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(info.lastInsertRowid);
    res.json(row);
  });

  app.delete(`/api/${table}/:id`, auth, (req, res) => {
    if (!perms.write.includes(req.role)) return res.status(403).json({ error: 'Your role cannot delete records here' });
    db.prepare(`DELETE FROM ${table} WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
  });
}

crud('sales', ['date', 'passenger', 'airline', 'route', 'ticket', 'value', 'partcomm', 'subtotal', 'commpct', 'total', 'status']);
crud('customers', ['name', 'phone', 'email', 'company', 'notes']);
crud('inventory', ['airline', 'route', 'alloc', 'used', 'remaining', 'validity']);
crud('expenses', ['date', 'category', 'desc', 'amount', 'paidby']);
crud('payroll', ['month', 'employee', 'base', 'allow', 'deduct', 'net']);
crud('bank', ['date', 'desc', 'bank', 'amount', 'ref']);

// ---- Admin: view all registered staff ----
app.get('/api/team', auth, (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Only Admin can view the team list' });
  const rows = db.prepare('SELECT id,name,email,role,created_at FROM users ORDER BY id ASC').all();
  res.json(rows.map(r => ({ ...r, roleLabel: ROLE_LABELS[r.role] || r.role })));
});

// ---- Booking requests: public customers submit, Agent/Admin review ----
const BOOKING_STAFF_ROLES = ['admin', 'agent'];

// No auth — this is the public customer-facing form on /book
app.post('/api/public/booking-request', (req, res) => {
  const { name, phone, email, origin, destination, travel_date, passengers, notes } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone number are required' });
  const info = db.prepare(`INSERT INTO booking_requests (name,phone,email,origin,destination,travel_date,passengers,notes) VALUES (?,?,?,?,?,?,?,?)`)
    .run(name, phone, email || null, origin || null, destination || null, travel_date || null, passengers || 1, notes || null);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.get('/api/booking-requests', auth, (req, res) => {
  if (!BOOKING_STAFF_ROLES.includes(req.role)) return res.status(403).json({ error: 'Your role does not have access to booking requests' });
  const rows = db.prepare('SELECT * FROM booking_requests ORDER BY id DESC').all();
  res.json(rows);
});

app.patch('/api/booking-requests/:id', auth, (req, res) => {
  if (!BOOKING_STAFF_ROLES.includes(req.role)) return res.status(403).json({ error: 'Your role cannot update booking requests' });
  const { status } = req.body;
  if (!['Pending', 'Contacted', 'Confirmed', 'Rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare('UPDATE booking_requests SET status=? WHERE id=?').run(status, req.params.id);
  const row = db.prepare('SELECT * FROM booking_requests WHERE id=?').get(req.params.id);
  res.json(row);
});

app.delete('/api/booking-requests/:id', auth, (req, res) => {
  if (!BOOKING_STAFF_ROLES.includes(req.role)) return res.status(403).json({ error: 'Your role cannot delete booking requests' });
  db.prepare('DELETE FROM booking_requests WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Public customer booking page (no login needed)
app.get('/book', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'book.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`Kefko backend running on http://localhost:${PORT}`));
