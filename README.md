# Kefko Travel Agent — Business System (Website + Backend)

A Node.js website for Kefko Travel Agent: sales & bookings, customers, ticket
inventory, expenses, payroll, bank statement, and reports — with staff login
accounts. Each staff account's records are private to that account.

## What's inside
- `server.js` — Express backend + SQLite database + login (JWT)
- `public/index.html` — the website itself (single page, same design as before)
- `package.json` — dependencies
- `.env.example` — settings template

## 1. Install on your server
Requires Node.js 18+ (check with `node -v`).

```bash
cd kefko-backend
npm install
cp .env.example .env
```

Open `.env` and fill in:

- **`JWT_SECRET`** — a long random string that keeps login sessions secure.
  Generate one with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```
- **`APP_URL`** — the public web address of your deployed site (e.g.
  `https://biruk-4nkh.onrender.com`). This is what verification email links
  point to.
- **`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`** —
  credentials for actually sending the verification email. The easiest free
  option is a Gmail account:
  1. Turn on 2-Step Verification on that Google account.
  2. Go to Google Account → Security → App Passwords, create one for "Mail".
  3. Use that 16-character password as `SMTP_PASS` (not your normal Gmail password).
  4. `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER` = the Gmail address.

  If SMTP isn't configured, the app still works but just prints the
  verification link to the server logs instead of emailing it — fine for
  testing, not for real staff who need the email in their inbox.

On Render specifically, add these same values under **Environment** on your
service instead of a `.env` file (Render doesn't read `.env` directly).

## 2. Run it

```bash
npm start
```

The site is now live at `http://your-server:3000` (or whatever `PORT` you set
in `.env`). The first time anyone visits, they'll see a Log In / Register
screen — have each staff member register their own account with their name,
work email, and a password.

## 3. Keep it running
For production, run it under a process manager so it restarts automatically
and survives reboots, e.g. with [PM2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2
pm2 start server.js --name kefko
pm2 save
pm2 startup
```

If you want it reachable at a normal domain (e.g. `system.kefkotravel.com`)
over HTTPS, put it behind a reverse proxy such as Nginx or Caddy pointing at
port 3000, with a free SSL certificate from Let's Encrypt.

## Data & backups
All data lives in `kefko.db` (a SQLite file) next to `server.js`. Back this
file up regularly — e.g. a nightly copy to another folder or cloud storage.
Nothing is stored in the browser, so staff can log in from any device and see
their own records.

## Notes
- **Public customer booking page**: your website now has a customer-facing
  page at `/book` (e.g. `https://biruk-4nkh.onrender.com/book`) — share this
  link with customers. They fill in their trip details and it lands in
  **Booking Requests** inside the staff portal for Sales Agents/Admin to
  review, mark as Contacted, and either Confirm (which pre-fills a new Sale
  for you to finish) or Reject. No payment or live fares yet — an agent
  always confirms manually first, matching the fact that live flight
  search/fares and online payment need a GDS provider (Amadeus/Sabre/
  Travelport or a direct airline API) and a payment gateway account, which
  you'd need to apply for separately before those can be wired in.
- **Real email verification**: after registering, staff get an email with a
  confirmation link. They can't log in until they click it. Links expire
  after 24 hours; there's a "Resend link" option on the login screen if
  someone's link expires or gets lost.
- **Departments/roles**: at registration, each person picks Sales Agent,
  Accountant, Human Resources, or Admin. What they can see and edit depends
  on that choice:
  - **Sales Agent** — Sales & Bookings, Customers, Ticket Inventory (full access)
  - **Accountant** — Expenses, Bank Statement, Reports (full access), and can
    view Sales for reconciliation (read-only)
  - **Human Resources** — Payroll (full access)
  - **Admin** — full access to every module, plus a Team page listing everyone
    who has registered and their department
  - Dashboard is visible to everyone; it just shows whatever a given role has
    access to.
  - This is a starting split — if you want different departments to see
    different things (e.g. give Accountant access to Payroll too), tell me
    and I'll adjust the permission rules in `server.js`.
- All departments now share one company-wide dataset (not siloed per login) —
  a sale entered by one agent is visible to any other agent, and to Admin/
  Accountant where relevant.
- Passwords are stored as bcrypt hashes, never in plain text.
- Sessions last 30 days before requiring login again.
