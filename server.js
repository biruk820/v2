require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { Pool, types } = require('pg');
const path = require('path');

// Return timestamp columns as plain strings instead of JS Date objects,
// so the frontend can safely do things like created_at.slice(0,10).
types.setTypeParser(1114, val => val); // timestamp
types.setTypeParser(1184, val => val); // timestamptz

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '');

const ROLES = ['admin', 'agent', 'accountant', 'hr'];
const ROLE_LABELS = { admin: 'Admin', agent: 'Sales Agent', accountant: 'Accountant', hr: 'Human Resources' };

const PERMISSIONS = {
  sales:     { read: ['admin', 'agent', 'accountant'], write: ['admin', 'agent'] },
  customers: { read: ['admin', 'agent'],                write: ['admin', 'agent'] },
  inventory: { read: ['admin', 'agent'],                write: ['admin', 'agent'] },
  expenses:  { read: ['admin', 'accountant'],           write: ['admin', 'accountant'] },
  payroll:   { read: ['admin', 'hr'],                   write: ['admin', 'hr'] },
  bank:      { read: ['admin', 'accountant'],           write: ['admin', 'accountant'] },
};
const BOOKING_STAFF_ROLES = ['admin', 'agent'];

// ---- Database (Postgres — survives redeploys, unlike a local SQLite file) ----
if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL is not set. The app will fail to connect to a database. See README for setup.');
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'agent',
      email_verified BOOLEAN DEFAULT FALSE,
      verify_token TEXT,
      verify_token_expires TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id),
      date TEXT, passenger TEXT, airline TEXT, route TEXT, ticket TEXT,
      value REAL, partcomm REAL, subtotal REAL, commpct REAL, total REAL, status TEXT
    );
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id),
      name TEXT, phone TEXT, email TEXT, company TEXT, notes TEXT
    );
    CREATE TABLE IF NOT EXISTS inventory (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id),
      airline TEXT, route TEXT, alloc REAL, used REAL, remaining REAL, validity TEXT
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id),
      date TEXT, category TEXT, "desc" TEXT, amount REAL, paidby TEXT
    );
    CREATE TABLE IF NOT EXISTS payroll (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id),
      month TEXT, employee TEXT, base REAL, allow REAL, deduct REAL, net REAL
    );
    CREATE TABLE IF NOT EXISTS bank (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id),
      date TEXT, "desc" TEXT, bank TEXT, amount REAL, ref TEXT
    );
    CREATE TABLE IF NOT EXISTS booking_requests (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL, phone TEXT, email TEXT,
      origin TEXT, destination TEXT, travel_date TEXT, passengers INTEGER DEFAULT 1,
      notes TEXT, status TEXT DEFAULT 'Pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Safe no-op if these already exist — lets old databases catch up.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token_expires TIMESTAMPTZ`);
  await pool.query(`UPDATE users SET role='agent' WHERE role NOT IN ('admin','agent','accountant','hr')`);
}

// ---- Mailer ----
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

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const finalRole = ROLES.includes(role) ? role : 'agent';
    const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(409).json({ error: 'An account with this email already exists' });
    const hash = bcrypt.hashSync(password, 10);
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const { rows } = await pool.query(
      `INSERT INTO users (name,email,password_hash,role,verify_token,verify_token_expires) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [name, email.toLowerCase(), hash, finalRole, token, expires]
    );
    const user = { id: rows[0].id, name, email };
    try { await sendVerificationEmail(user, token); } catch (e) { console.error('Failed to send verification email:', e.message); }
    res.json({ pending: true, message: `We've sent a verification link to ${email}. Click it to activate your account before logging in.` });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.get('/api/auth/verify', async (req, res) => {
  try {
    const { token } = req.query;
    const { rows } = await pool.query('SELECT * FROM users WHERE verify_token=$1', [token || '']);
    const user = rows[0];
    if (!user) return res.status(400).send('<h2>This verification link is invalid or has already been used.</h2>');
    if (user.verify_token_expires && new Date(user.verify_token_expires) < new Date()) {
      return res.status(400).send('<h2>This verification link has expired. Please register again or request a new link.</h2>');
    }
    await pool.query('UPDATE users SET email_verified=TRUE, verify_token=NULL, verify_token_expires=NULL WHERE id=$1', [user.id]);
    res.send(`<div style="font-family:sans-serif;max-width:420px;margin:60px auto;text-align:center;">
      <h2 style="color:#0E3A5F;">Email verified ✓</h2>
      <p>Your Kefko account is now active. You can close this tab and log in.</p>
      <a href="${APP_URL || '/'}" style="display:inline-block;margin-top:14px;background:#1CA6E0;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;">Go to Login</a>
    </div>`);
  } catch (e) { console.error(e); res.status(500).send('<h2>Something went wrong verifying your email.</h2>'); }
});

app.post('/api/auth/resend', async (req, res) => {
  try {
    const { email } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [(email || '').toLowerCase()]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'No account found with that email' });
    if (user.email_verified) return res.status(400).json({ error: 'This account is already verified — try logging in.' });
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await pool.query('UPDATE users SET verify_token=$1, verify_token_expires=$2 WHERE id=$3', [token, expires, user.id]);
    try { await sendVerificationEmail(user, token); } catch (e) {
      console.error('Failed to send verification email:', e.message);
      return res.status(500).json({ error: 'Could not send the email right now. Try again shortly.' });
    }
    res.json({ message: `Verification link re-sent to ${user.email}.` });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [(email || '').toLowerCase()]);
    const user = rows[0];
    if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (!user.email_verified) {
      return res.status(403).json({ error: 'Please verify your email before logging in — check your inbox for the link.', unverified: true });
    }
    res.json({ token: signToken(user), user: publicUser(user) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
});

app.get('/api/auth/me', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT id,name,email,role FROM users WHERE id=$1', [req.userId]);
  if (!rows[0]) return res.status(404).json({ error: 'Account not found' });
  res.json({ user: publicUser(rows[0]) });
});

// ---- Generic CRUD, gated by department/role permissions ----
function crud(table, columns) {
  const perms = PERMISSIONS[table];
  const qcols = columns.map(c => `"${c}"`).join(',');

  app.get(`/api/${table}`, auth, async (req, res) => {
    if (!perms.read.includes(req.role)) return res.status(403).json({ error: 'Your role does not have access to this module' });
    const { rows } = await pool.query(`SELECT * FROM ${table} ORDER BY id DESC`);
    res.json(rows);
  });

  app.post(`/api/${table}`, auth, async (req, res) => {
    if (!perms.write.includes(req.role)) return res.status(403).json({ error: 'Your role cannot add records here' });
    const vals = columns.map(c => req.body[c] ?? null);
    const placeholders = columns.map((_, i) => `$${i + 2}`).join(',');
    const { rows } = await pool.query(
      `INSERT INTO ${table} (user_id,${qcols}) VALUES ($1,${placeholders}) RETURNING *`,
      [req.userId, ...vals]
    );
    res.json(rows[0]);
  });

  app.delete(`/api/${table}/:id`, auth, async (req, res) => {
    if (!perms.write.includes(req.role)) return res.status(403).json({ error: 'Your role cannot delete records here' });
    await pool.query(`DELETE FROM ${table} WHERE id=$1`, [req.params.id]);
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
app.get('/api/team', auth, async (req, res) => {
  if (req.role !== 'admin') return res.status(403).json({ error: 'Only Admin can view the team list' });
  const { rows } = await pool.query('SELECT id,name,email,role,created_at FROM users ORDER BY id ASC');
  res.json(rows.map(r => ({ ...r, roleLabel: ROLE_LABELS[r.role] || r.role })));
});

// ---- Booking requests ----
app.post('/api/public/booking-request', async (req, res) => {
  const { name, phone, email, origin, destination, travel_date, passengers, notes } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone number are required' });
  const { rows } = await pool.query(
    `INSERT INTO booking_requests (name,phone,email,origin,destination,travel_date,passengers,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [name, phone, email || null, origin || null, destination || null, travel_date || null, passengers || 1, notes || null]
  );
  res.json({ ok: true, id: rows[0].id });
});

app.get('/api/booking-requests', auth, async (req, res) => {
  if (!BOOKING_STAFF_ROLES.includes(req.role)) return res.status(403).json({ error: 'Your role does not have access to booking requests' });
  const { rows } = await pool.query('SELECT * FROM booking_requests ORDER BY id DESC');
  res.json(rows);
});

app.patch('/api/booking-requests/:id', auth, async (req, res) => {
  if (!BOOKING_STAFF_ROLES.includes(req.role)) return res.status(403).json({ error: 'Your role cannot update booking requests' });
  const { status } = req.body;
  if (!['Pending', 'Contacted', 'Confirmed', 'Rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const { rows } = await pool.query('UPDATE booking_requests SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id]);
  res.json(rows[0]);
});

app.delete('/api/booking-requests/:id', auth, async (req, res) => {
  if (!BOOKING_STAFF_ROLES.includes(req.role)) return res.status(403).json({ error: 'Your role cannot delete booking requests' });
  await pool.query('DELETE FROM booking_requests WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/book', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'book.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Kefko backend running on http://localhost:${PORT}`));
  })
  .catch(err => {
    console.error('Failed to set up the database — check DATABASE_URL:', err.message);
    process.exit(1);
  });
