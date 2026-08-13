# Kefko Travel Agent — Business System (Website + Backend)

A Node.js website for Kefko Travel Agent: booking requests, sales & bookings,
customers, ticket inventory, expenses, payroll, bank statement, and reports —
with staff login accounts by department. Data lives in a real Postgres
database, so it survives redeploys and restarts.

## What's inside
- `server.js` — Express backend + Postgres database + login (JWT) + email verification
- `public/index.html` — the staff portal
- `public/book.html` — the public customer booking page (`/book`)
- `package.json` — dependencies
- `.env.example` — settings template

## 1. Create a free Postgres database

This is the piece that makes your data permanent — do this first.

**On Render** (easiest since you're already there):
1. Dashboard → **New +** → **PostgreSQL**.
2. Give it any name, choose the **Free** plan, click **Create Database**.
3. Once it's ready, open it and copy the **Internal Database URL** (starts
   with `postgresql://`).
4. Go to your `biruk`/`v3` web service → **Environment**, add a variable
   `DATABASE_URL` and paste that value in.

(Any other free Postgres works too — Neon.tech, Supabase, etc. — just paste
whichever connection string they give you into `DATABASE_URL`.)

## 2. Install locally (only needed if you're also running this on your own computer/server)
Requires Node.js 18+ (check with `node -v`).

```bash
cd kefko-backend
npm install
cp .env.example .env
```

Open `.env` and fill in:

- **`DATABASE_URL`** — from step 1 above.
- **`JWT_SECRET`** — a long random string that keeps login sessions secure.
  Generate one with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- **`APP_URL`** — the public web address of your deployed site (e.g.
  `https://biruk-4nkh.onrender.com`). This is what verification email links
  point to.
- **`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`** —
  credentials for sending the verification email. Easiest free option is a
  Gmail account with an **App Password** (not your normal password):
  1. Turn on 2-Step Verification on that Google account.
  2. Google Account → Security → App Passwords → create one for "Mail".
  3. Use that 16-character password as `SMTP_PASS`.
  4. `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER` = the Gmail address.

On Render, add these same values under **Environment** on your web service
instead of a `.env` file (Render doesn't read `.env` directly).

## 3. Run it

```bash
npm start
```

The site is live at `http://your-server:3000` (or whatever `PORT` is set
to). First visit shows Log In / Register — each staff member registers
under their department (Sales Agent, Accountant, HR, Admin) and verifies
their email before they can log in.

## 4. Keep it running (self-hosted only)
Use a process manager like [PM2](https://pm2.keymetrics.io/) so it restarts
automatically:

```bash
npm install -g pm2
pm2 start server.js --name kefko
pm2 save
pm2 startup
```

## Notes
- **Data now survives redeploys**: switching from a local SQLite file to
  Postgres was the actual fix for accounts/data disappearing after every
  GitHub push — Postgres lives outside the web service entirely.
- **Real email verification**: after registering, staff get an email with a
  confirmation link. They can't log in until they click it. Links expire
  after 24 hours; there's a "Resend link" option on the login screen.
- **Departments/roles**: Sales Agent, Accountant, Human Resources, or Admin.
  - **Sales Agent** — Booking Requests, Sales & Bookings, Customers, Ticket
    Inventory (full access)
  - **Accountant** — Expenses, Bank Statement, Reports (full access), and
    can view Sales for reconciliation (read-only)
  - **Human Resources** — Payroll (full access)
  - **Admin** — everything, plus a Team page listing all registered staff
- **Public booking page**: share `/book` (e.g.
  `https://your-site.onrender.com/book`) with customers. Requests land in
  **Booking Requests** for Sales Agents/Admin to confirm and convert into a
  Sale — no live fares or payment yet, since that needs a GDS provider
  (Amadeus/Sabre/Travelport or a direct airline API) and a payment gateway
  account, both of which you'd apply for separately.
- Passwords are stored as bcrypt hashes, never in plain text.
- Sessions last 30 days before requiring login again.
