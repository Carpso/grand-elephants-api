# Changelog — Grand Elephants API

All notable changes to the `grand-elephants-api` Cloudflare Worker.
Format: [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased] — 2026-09-24

### Added
- Full marketplace API on Cloudflare Workers + D1: auth (OTP/JWT), catalog,
  orders, businesses, riders, admin fleet/payouts, webhooks, cron.
- Endpoints: rider payouts, admin riders/applications/status, notifications,
  addresses CRUD, support chat, product reviews, `/api/admin/lipila/balance`.
- Tables `reviews` and `rider_payouts` (`sql/schema.sql` +
  non-destructive `sql/migration_001.sql`, applied to remote D1 — 23 tables).
- Lipila webhook handles `RPY-` references; daily cron finalizes stuck rider
  payouts and expires unpaid orders.
- Website hosting: `[assets]` serves `../grand-elephants-flutter/build/web`
  with SPA fallback + API catch-all — one worker serves API and website.
- Firebase Admin FCM push (`src/firebase.ts`), secrets
  `FIREBASE_PRIVATE_KEY` / `FIREBASE_CLIENT_EMAIL`, var `FIREBASE_PROJECT_ID`
  (`grand-elephants-b8ec4`).
- `deploy.ps1`, `.dev.vars.example`, `BLUEPRINT.md`, `AGENTS.md`.

### SMS (Africa's Talking)
- Production live: `api.africastalking.com`, username `ChurchOnApp`,
  approved sender ID **`Carpso`**, brand prefix **`GRANDELEPHANTS:`**
  (replaces `SELLONAPP:` / "Sell On App" everywhere — messages, narration,
  docs).
- `AT_SANDBOX` var + sandbox branch in `src/sms.ts`
  (`api.sandbox.africastalking.com`, username `sandbox`) for sandbox keys.
- `AT_API_KEY` secret set (production key). Verified end-to-end:
  `POST /api/auth/request-otp` → real SMS delivered, 201 from AT.
- All SMS templates rebranded in `src/messages.ts`; OTP string in
  `src/auth.ts`.

### Changed
- `wrangler.toml`: `ENV=production`, `LIPILA_ENV=production`,
  `AT_FROM="Carpso"`, `AT_SANDBOX="false"`, `FIREBASE_PROJECT_ID`.
- Secrets: `JWT_SECRET`, `LIPILA_API_KEY`, `LIPILA_WEBHOOK_SECRET`,
  `SUPERADMIN_PHONES`, `AT_API_KEY`, `FIREBASE_*` (never committed).
- Full rename `Sell On App` / `sellonapp` / `sell_on_app` → Grand Elephants
  across source, SQL and docs.

### Security
- Lipila secret removed from git history (force-pushed); all keys stored as
  wrangler secrets only. Role checks are server-side on every admin/business/
  rider route.
