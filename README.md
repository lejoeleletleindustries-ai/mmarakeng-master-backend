# Mmarakeng Master Backend

Central production API for **Mmarakeng** (Lesotho marketplace, advertising, digital products, Lockbox).

Owners: **Lejwele Le Te Industries** and **Origin Dot**.

This repository is **source code only** — deploy to Render (or similar) with PostgreSQL. It does **not** depend on your phone or Windows PC staying online.

---

## Stack

- Node.js 18+
- Express
- PostgreSQL
- JWT auth
- REST API

---

## Local development

```bash
cp .env.example .env
# Edit .env — set DATABASE_URL to a Postgres instance, JWT_SECRET, SESSION_SECRET
# Optionally set OWNER1_PASSWORD and OWNER2_PASSWORD for first seed

npm install
npm run migrate
npm run seed
npm start
```

Health check: `GET http://localhost:10000/api/health` (or your `PORT`)

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | **Yes** | PostgreSQL connection string |
| `JWT_SECRET` | **Yes** | Long random string for tokens |
| `SESSION_SECRET` | Recommended | HMAC / session material |
| `PORT` | No | Default `10000` (Render sets this) |
| `HOST` | No | Default `0.0.0.0` |
| `OWNER1_PASSWORD` / `OWNER2_PASSWORD` | For seed | Bootstrap owner logins (not hard-coded in source) |
| `OWNER1_PHONE` / `OWNER2_PHONE` | No | Defaults provided in `.env.example` |
| `ADMIN_PASSWORD` | No | Optional platform admin seed |
| `PAYMENT_API_KEY` / `PAYMENT_PROVIDER` | No | M-Pesa / EcoCash integration later |
| `HCAPTCHA_SECRET` | No | Live CAPTCHA |
| `CORS_ORIGIN` | No | Default `*` |

**Never commit `.env`.** Only `.env.example` (names only) is in git.

---

## Deploy to Render

1. Create a GitHub repo: `mmarakeng-master-backend`
2. Push this project (without `node_modules` / `.env`)
3. On [Render](https://render.com): **New → Web Service** → connect the repo
4. **New → PostgreSQL** → copy the **Internal Database URL** (or External)
5. Web service settings:

| Setting | Value |
|---------|--------|
| **Runtime** | Node |
| **Build Command** | `npm install --omit=dev && npm run migrate && npm run seed` |
| **Start Command** | `npm start` |
| **Health Check Path** | `/api/health` |

6. Environment variables on the Web Service:

```
DATABASE_URL=<from Render Postgres>
JWT_SECRET=<long random string>
SESSION_SECRET=<long random string>
NODE_ENV=production
OWNER1_PASSWORD=<choose a strong password>
OWNER2_PASSWORD=<choose a strong password>
```

7. Deploy. Render assigns a public HTTPS URL, for example:

`https://mmarakeng-master-backend.onrender.com`

**That URL is your Master Backend URL** — only after deploy. It is not invented in this README.

8. Test:

```bash
curl https://YOUR-RENDER-URL/api/health
```

Expected: JSON with `"status":"ok"` and `"database":"connected"`.

9. Point every Mmarakeng client **Central server / API base URL** to:

`https://YOUR-RENDER-URL`

---

## Main API paths

| Method | Path | Notes |
|--------|------|--------|
| GET | `/api/health` | Health + DB status |
| GET | `/api/central/info` | Central backend marker |
| POST | `/api/auth/register` | Register |
| POST | `/api/auth/login` | Login → JWT |
| GET | `/api/auth/me` | Current user |
| GET | `/api/listings` | Public listings |
| POST | `/api/listings` | Create (auth) |
| GET | `/api/admin/queue` | Admin review queue |
| POST | `/api/admin/listings/:id/status` | Approve / reject / publish |
| POST | `/api/admin/listings/:id/delete` | Permanent delete |
| * | `/api/lockbox/*` | Invite, accept, messages |
| * | `/api/digital/*` | Digital products + pay + download |
| * | `/api/subscription/*` | Plans + checkout |
| GET | `/api/admin/platform-stats` | Platform stats |
| GET | `/api/seller/dashboard` | Seller analytics |

Auth header: `Authorization: Bearer <token>`

---

## GitHub upload

```bash
cd mmarakeng-master-backend
git init
git add .
git commit -m "Initial Mmarakeng Master Backend"
git branch -M main
git remote add origin https://github.com/YOUR_USER/mmarakeng-master-backend.git
git push -u origin main
```

Then connect that repo in Render as above.

---

## Security notes

- Owner passwords are **not** in source code; set via env at seed time.
- Ordinary admins cannot reset owner passwords or grant themselves owner role via API.
- Lockbox content is participant-only; owner exceptional access is audited.
- Payment provider secrets only via env when you connect M-Pesa/EcoCash.

---

## Object storage

| Variable | Purpose |
|----------|---------|
| `STORAGE_PROVIDER` | `local` (dev) or `s3` (production) |
| `S3_ENDPOINT` | S3-compatible endpoint |
| `S3_BUCKET` | Bucket name |
| `S3_REGION` | Region |
| `S3_ACCESS_KEY_ID` | Access key (secret) |
| `S3_SECRET_ACCESS_KEY` | Secret key (secret) |

Local disk is **not** durable on ephemeral free hosts. For production digital files, configure S3-compatible storage. Paid downloads always go through authorized API routes — not public static URLs for private files.

---

## Payments — M-Pesa Lesotho & EcoCash Lesotho

Adapters are **implemented and production-configurable**. They are **not live** until you obtain official merchant approval, API documentation, and credentials from each provider.

### Modes

| `PAYMENTS_MODE` | Behaviour |
|-----------------|-----------|
| `test` | Allows `POST /api/payments/test/simulate` for local testing only |
| `production` | Manual admin confirm only for `provider=manual`; M-Pesa/EcoCash via webhook + verification |

### Enable a provider (after official credentials)

```
MPESA_ENABLED=true
MPESA_ENVIRONMENT=sandbox   # or production
MPESA_API_BASE_URL=         # from official docs
MPESA_CLIENT_ID=
MPESA_CLIENT_SECRET=
MPESA_MERCHANT_ID=
MPESA_BUSINESS_ID=
MPESA_SHORTCODE=
MPESA_CALLBACK_URL=https://YOUR-RENDER-URL/api/payments/mpesa/webhook
MPESA_WEBHOOK_SECRET=
```

Same pattern for `ECOCASH_*`.

### Webhooks

- `POST /api/payments/mpesa/webhook`
- `POST /api/payments/ecocash/webhook`

Callbacks verify signature when secret is set, enforce idempotency, validate amount, and only then mark payment successful and unlock digital products / publish listings / activate subscriptions.

### Config status (admin)

`GET /api/payments/config-status` — reports enabled / environment / credentials configured **yes/no** — **never** returns secrets.

### Before production payments, obtain from each provider

- Official merchant approval  
- Official API documentation  
- Sandbox credentials  
- Production credentials  
- Production API endpoint  
- Authentication requirements  
- Webhook/callback requirements  
- Signing/certificate requirements if applicable  
- Merchant/account identifiers  
- Settlement information  
- Supported transaction types  
- Fees/limits  
- Production activation approval  

Do **not** invent these values.

**M-Pesa and EcoCash adapters are implemented and production-configurable. Production activation requires official merchant/API approval, credentials, provider configuration, and successful sandbox/production verification.**

---

## MMARAKENG OFFLINE LOCKBOX

### What it is

A **private house with multiple private rooms**. Each room has its own access control. The **room owner** controls who receives `room_code` + `access_secret` (can share by phone, SMS, in person, etc. — not required to go through the app).

### Online vs offline

| Requires internet | Works offline (after prior online auth + room join) |
|-------------------|------------------------------------------------------|
| Register, OTP, first login, password reset | Open authorized rooms already cached on device |
| Join room with credentials (first time) | Read locally stored messages |
| Marketplace publish, payments, purchases | Compose/reply; stored as **PENDING_OFFLINE** locally |
| Sync queue to server | UI shows Offline — not “Delivered” until sync confirms |

**Temporary loss of internet must not auto-logout** a previously authenticated session. Show **OFFLINE MODE**, not LOGGED OUT.

### Honest limitation

If two devices are **both fully offline** with **no data path** between them, a new message on Device A cannot appear on Device B until:

1. at least one device syncs via the central backend, or  
2. a future explicit local transfer mechanism is implemented.

The server never marks a message **delivered** without a real sync path.

### API (room model)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/lockbox/rooms` | Create room (returns `room_code` + `access_secret` once) |
| GET | `/api/lockbox/rooms` | List my authorized rooms |
| POST | `/api/lockbox/rooms/join` | Join with room_code + access_secret |
| GET | `/api/lockbox/rooms/offline-bootstrap` | Payload for client encrypted offline cache |
| POST | `/api/lockbox/rooms/:roomId/sync` | Push pending + pull incoming (`client_message_id` idempotent) |
| GET | `/api/lockbox/sync/status` | Sync cursors |
| POST | `/api/lockbox/rooms/:roomId/credentials/regenerate` | Owner rotates secret |
| POST | `/api/lockbox/rooms/:roomId/participants/:userId/revoke` | Owner revokes member |

### Sync states

`draft` → `pending_offline` (client) → `syncing` → `synced` → optional `delivered` / `read` / `failed`

### Revocation offline

If the owner revokes a member while that member is offline, the device may keep **cached** data until the next online auth check; then access is blocked and no new server data is downloaded.

### Client responsibilities

- Encrypt offline room cache at rest (do not store plaintext room secrets).
- Persist a local message queue across restarts.
- On reconnect: call `/rooms/:id/sync` with pending `client_message_id`s.
- Do not claim Delivered until server accepts the message.

---

## Security, GPS, Distress & Timed Auth (update)

### NPM registry
`package-lock.json` must resolve only from `https://registry.npmjs.org/`.  
Project includes `.npmrc` with that registry. Do not use private proxy IPs.

### Digital files
`/uploads/digital` is **not** publicly static. Downloads go through authenticated `/api/digital/...` with purchase checks.

### Timed Sequence Authentication
Optional second factor: `PUT /api/timed-auth/profile`, `POST /api/timed-auth/verify`.  
Stores hash of steps + intervals; verification uses configurable tolerance (default 800ms). Does not replace password login.

### Location / Maps
`/api/location/*` — user location, near-listings foundation, Google Maps **navigation URL** helper (client opens Maps). Keys via env only.

### Distress
`/api/distress/*` — contacts, activate, evidence upload/download (authz), nearest-help returns `not_configured` until a real emergency provider is connected.

### Delivery
`/api/delivery/*` — IDOR-protected delivery coordinates and navigation URLs for authorized seller/customer only.
