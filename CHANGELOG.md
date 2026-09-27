# Changelog — Grand Elephants API

All notable changes to the `grand-elephants-api` Cloudflare Worker.
Format: [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased] — 2026-09-27

### Fixed
- **All `/api/*` routes returned empty-body 404s** (the app's Send Code button
  got no response → no OTP request, no verify). The 2026-09-25 03:52Z
  deployment (`0e15538e`) had been uploaded **assets-only, with no Worker
  script**, so Cloudflare answered every non-asset path at the edge before the
  Worker could run (`npx wrangler tail` failed with CF code `100311` "Cannot
  tail a Worker which only has assets"). Fixed by re-running
  `npx wrangler deploy` → version `245a7263-2617-4eab-89d2-f76ca63cd539`;
  verified live: `POST /api/auth/request-otp` → 200 `{"ok":true}` (real SMS),
  `POST /api/auth/verify-otp` → 401 for a wrong code, `GET /api/products` →
  200 (16 bags), website assets + SPA fallback → 200. **No code changes.**
  Prevention: always verify `GET /api/products` returns JSON after deploying
  (see AGENTS.md → Deployment).

## [Unreleased] — 2026-09-27 (gap batch)

### Added
- **R2 image pipeline**: `POST /api/upload` (auth; ≤3MB; jpeg/png/webp) →
  `grand-elephants/{folder}/…` in bucket `choa-sermons-vault`, served at
  `https://media.churchonapp.com/…` (`IMAGES` binding in wrangler.toml).
  One-shot `POST /api/admin/migrate-images` moves stored base64 to R2
  (executed: 0 migrated, 18 skipped, 0 failed — no data-URIs in DB).
- **Banner CRUD**: `GET/POST /api/admin/banners`, `PUT/DELETE
  /api/admin/banners/:id` (admin+). **Category delete**:
  `DELETE /api/admin/categories/:id` → 409 while products reference it.
- **OTP lockout**: 5 failed verifies burn the code and lock the phone for
  15 min (`OTP_LOCKOUT_MINUTES`); new `otp_lockouts` table (migration_004,
  applied remotely). Locked → HTTP 429 on BOTH request-otp and verify-otp.
- **ZRA Smart Invoice**: real submission client in `smart_invoice.ts`
  (researched ZRA VSDC `POST {base}/SalesInformation/SaveSales`; base URL
  config `ZRA_BASE_URL` → `app_settings.zra_base_url` → default sandbox
  `https://api-sandbox.zra.org.zm/vsdc-api/v1`; auth `ZRA_AUTH_SCHEME` +
  `ZRA_API_KEY`). Stores `afc_code`/`acf_code`/`zra_qr`/`synced_at` on
  success, stays `issued` on failure; still gated by `zra_enabled=1` + key.
  Production endpoint/payload must be finalized against official ZRA
  onboarding docs (device credentials/TPIN registration not yet done).
- **401→403**: new `forbidden()` helper; 56 role/scope/ownership failures
  now return 403 (missing-token/OTP/webhook-auth failures stay 401).

### Fixed
- **Second secrets wipe**: foreign deployment at 12:40:51Z (source
  `Unknown (deployment)`, 6 min after the 12:35 restore) wiped all six
  secrets again. All re-restored from stored value sources; functional E2E
  re-verified: request-otp 200 (SMS dispatched), verify-otp 200, /api/me
  200, upload→R2→public URL 200, 403/409/429 semantics correct, full
  browser login lands on Home. `LIPILA_API_KEY` remains lost.
- **All Worker secrets were wiped** by a second, foreign deployment
  (`6841ad08`, 08:08:49Z — different config, no script/bindings) → `verify-otp`
  500 (empty `JWT_SECRET`) and silent SMS failure (missing `AT_API_KEY`).
  Secrets re-put from stored value sources; `verify-otp` → 200 + JWT,
  `/api/me` → 200, full browser E2E (Send Code → Verify → Home) passes.
  **Outstanding: `LIPILA_API_KEY` value is lost — re-fetch from the Lipila
  dashboard and `npx wrangler secret put LIPILA_API_KEY`.** Note: `.dev.vars`
  holds `local-*` placeholders only — never restore prod from it.

## [2026-09-25]

### Added
- **Admin product management**: `GET/POST /api/admin/products`,
  `PUT/DELETE /api/admin/products/:id` (delete = soft, `active = 0`), same
  validation as the business routes (name, ZMW price → integer cents,
  `isValidCategory`), `?businessId=` filter on the list.
- **Rider onboarding**: `POST /api/admin/rider-applications/:id/approve` now
  writes the `riders` fleet row when none exists (business from body, else the
  default platform business) and accepts `vehicle`.
- **Role rules**: `PATCH /api/admin/users/:id` validates `role`
  (`user|rider|business|employee|admin|superadmin`) and `riderStatus`
  (`none|pending|approved|rejected`); superadmin can only be granted by a
  superadmin and nobody changes their own role.
- **Product feeds** (identical `productJson[]` shape to `GET /api/products`):
  `GET /api/products/new`, `/api/products/trending` (paid units sold, newest
  first as fallback), `/api/products/suggested` (categories the buyer has
  already bought rank first; token optional, anonymous = trending), plus
  `GET /api/products?sort=new|trending|suggested` and `?limit=`
  (1–50, default 12).
- **Buyer TPIN**: `POST /api/orders` accepts an optional `tpin`
  (spaces/dashes stripped, must be exactly 10 digits → 400 otherwise), stored
  in `orders.buyer_tpin`, copied to `invoices.buyer_tpin` on confirmation and
  returned as `buyerTpin` on every order payload (buyer, business and admin
  order lists).
- **Business VAT / tax tracking**:
  `GET /api/businesses/me/tax?from=YYYY-MM-DD&to=YYYY-MM-DD` →
  `{ businessId, from, to, vatPct, salesCount, taxableSalesCents,
  vatCollectedCents, vatBySale: [{ orderId, invoiceNo, date, taxableCents,
  vatCents, totalCents, tpin }] }` — computed from what each order stored
  (`orders.vat_cents`, VAT_PCT from fee settings for legacy 0-VAT rows),
  paid orders only;
  `GET/POST /api/businesses/me/tax/payments` (amountCents > 0,
  periodStart/periodEnd `YYYY-MM-DD`, optional reference/method) → new table
  `tax_payments`.
- **Receipt**: `GET /api/orders/:id/receipt` (same access rule as
  `GET /api/orders/:id`) → `{ receipt: { orderNumber, invoiceNo, status,
  paymentMethod, paymentStatus, transactionId, referenceId, createdAt,
  deliveredAt, currency, vatPct, business: { id, name, address, tpin },
  buyer: { name, phone, tpin }, delivery: { address, method, feeCents,
  riderName }, items: [{ name, image, unitPriceCents, quantity,
  lineTotalCents }], subtotalCents, vatCents, deliveryFeeCents,
  totalCents } }`. `GET /api/orders/:id` additionally returns
  `orderNumber`, `lineTotalCents`, `businessAddress`, `businessTpin`,
  `buyerTpin`.
- **ZRA SmartInvoice seam**: `src/smart_invoice.ts` exports
  `submitInvoice(env, invoice)` — a logged no-op (`TODO(ZRA)` for credentials)
  called from the invoice-issuance path in `confirmOrder`, so the real ZRA push
  can be dropped in without touching order code.
- **Employee dashboard**: `GET /api/employee/stats` (any authenticated user) →
  `{ salesTodayCents, salesTotalCents, ordersToday, ordersTotal, pendingOrders,
  ownOrders }`; zeroed for users with no business, plus their own order count.
- `sql/migration_002.sql` (`orders.proof_photo`) and `sql/migration_003.sql`
  (`orders.buyer_tpin`, `invoices.buyer_tpin`, `riders.updated_at`,
  `tax_payments` + index).

### Changed
- **Bags-only catalog**: `src/categories.ts` now validates the 10 bag
  categories (Tote Bags, Backpacks, Handbags, Crossbody Bags, Clutches, Laptop
  Bags, Duffel & Travel Bags, Waist Bags, Shopping Bags, Baby Bags).
  `sql/seed.sql` rewritten as an idempotent bags-only seed — legacy
  non-bag categories are renamed onto the bag set (ids preserved), product
  categories follow, any remaining non-bag product is deactivated (never
  deleted), the dead `assets/products/handbag.png` image is repointed, then
  10 bag categories and 15 bag products (ZMW cents, bundled
  `assets/products/*.png` assets) are upserted.
- **Fees from the database**: `loadFeeSettings` (60s cache, `app_settings`
  wins over env) drives order totals, `/api/config.feeInfo`, payouts and rider
  payouts; `PATCH /api/admin/settings` invalidates the cache.
- `productBusinessScope` renamed to `businessScope` and reused by the
  collection-number routes so admins can manage the platform business without
  `users.business_id`.
- Rider status updates accept `proofPhoto` (`POST/PATCH
  /api/orders/:id/rider-status`) for proof of delivery.

### Fixed
- `riders` had no `updated_at` column although six UPDATEs set it (rider
  status, vehicle, balance, payout rollback) — column added to
  `sql/schema.sql` and applied via `migration_003.sql`.
- OTP brute-force cap: `verifyOtp` burns the code after 5 failed attempts
  (`MAX_OTP_ATTEMPTS`), surfaced as 401 from `POST /api/auth/verify-otp`.
- App slogan default and live `app_settings.app_slogan` = **Move With
  Conviction**.

### D1 (remote `grand-elephants-db`, 2026-09-25)
- `npx wrangler d1 execute grand-elephants-db --remote --file=./sql/migration_003.sql`
  (5 queries → 24 tables)
- `npx wrangler d1 execute grand-elephants-db --remote --file=./sql/seed.sql`
  (21 queries → 10 bag categories, 16 bag products, bags-only transform)
- `UPDATE app_settings SET value='Move With Conviction' WHERE key='app_slogan'`
- `sql/schema.sql` was **not** executed against the remote database.

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
