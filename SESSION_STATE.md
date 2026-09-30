# SESSION_STATE — Grand Elephants API (Cloudflare Worker)

Saved: 2026-09-30. Companion: same file in `grand-elephants-flutter`.

## Infra (no secrets in this file)
- Worker/site: `https://grand-elephants-api.godfreymoseskalambo.workers.dev` (serves `/api/*` + Flutter web SPA via `[assets]` → `../grand-elephants-flutter/build/web`, SPA fallback + catch-all in `src/index.ts`).
- D1: `grand-elephants-db` (`447d1f6c-1b73-4bfd-bea5-3747460acdfc`). Schema: `sql/schema.sql` (**DROP+CREATE — never run against remote**); safe migrations: `sql/migration_001..003.sql`; seed: `sql/seed.sql` (idempotent, bags-only).
- Wrangler: use OAuth config at `C:\Users\User\AppData\Roaming\xdg.config\.wrangler\config\default.toml`; run `npx wrangler` WITHOUT `CLOUDFLARE_API_TOKEN` env (token lacks workers:edit). Account `ab82a97ce2c926279c483fef36c41945`.
- Secrets set on worker: `AT_API_KEY` (PRODUCTION), `JWT_SECRET`, `LIPILA_API_KEY` (restored 2026-09-30), `LIPILA_WEBHOOK_SECRET`, `SUPERADMIN_PHONES=+260968551110`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL`. Vars: `ENV=production`, `LIPILA_ENV=production`, `AT_USERNAME=ChurchOnApp`, `AT_FROM=Carpso` (approved), `AT_SANDBOX=false`, `FIREBASE_PROJECT_ID=grand-elephants-b8ec4`, `OTP_TTL_MINUTES=5`.
- SMS: Africa's Talking production host; brand prefix `GRANDELEPHANTS:`; sandbox keys only work on `api.sandbox.africastalking.com` with username `sandbox` (401 = key/environment mismatch). Key values found in `OneDrive\Documents\Settings - API Key.txt` (prod) and `sandbox api key Africa talking Sa.txt`.
- GitHub: `Carpso/grand-elephants-api`, branch **master**, push with `git push https://Carpso:<PAT>@github.com/Carpso/grand-elephants-api.git master`.
- Cron `0 6 * * *` finalizes stuck payouts + expires unpaid orders.

## State
- Last deploy: version `bd203e65-8521-4f68-bf26-61563bcc7ae9` (2026-09-30), worker script + web assets; verified live: `/api/fx` 200 `{"usdToZmw":19.56,"source":"open.er-api.com"}`, `/api/health` `db:"online"` latencyMs 167, `/api/config` has `appDescription`+`maintenanceMode`+feeInfo, `/api/products` 200, admin routes 401, site 200 with new `main.dart.js` (contains try-on/checkout fix strings). Previous: `245a7263` (2026-09-27) + gap-batch deploys.
- **Incident 2026-09-27 (resolved):** deployment `0e15538e` (2026-09-25 03:52Z) was uploaded **assets-only — no worker script** → every non-asset path returned an *empty* 404 (this is why the app's "Send Code" button got no response: `POST /api/auth/request-otp` died at the edge) and `wrangler tail` failed with CF code `100311` "Cannot tail a Worker which only has assets". Cause of that upload unknown (no Flutter/app code was at fault). Fix = `npx wrangler deploy` from this repo. **Diagnostic rule:** empty-body 404s + `100311` on tail → redeploy immediately, then re-verify `request-otp`.
- **Incident 2026-09-27 part 2 (secrets wipe, resolved):** a **foreign deployment** `6841ad08` (08:08:49Z, source `version_upload`, config with `compatibility_date = 2026-09-25` — ours is `2026-01-01` — and **no handlers/bindings**) overwrote the worker again AND **wiped all secrets** (`npx wrangler secret list` → `[]`). Symptoms: `verify-otp` → 500 "Imported HMAC key length (0)…" (empty `JWT_SECRET`), and no SMS dispatched (`AT_API_KEY` gone; `sendSms` errors are swallowed so `request-otp` still returned `{"ok":true}`). Restored: worker redeploy + secrets re-put from value sources — `AT_API_KEY`←`Temp\opencode\at_prod.txt` (prod `atsk_e…`), `JWT_SECRET`←`jwt_secret.txt`, `LIPILA_WEBHOOK_SECRET`←`webhook_secret.txt`, `SUPERADMIN_PHONES=+260968551110`, `FIREBASE_CLIENT_EMAIL`←OneDrive `grand-elephants-b8ec4-firebase-adminsdk-…json`, `FIREBASE_PRIVATE_KEY`←`Temp\opencode\firebase_key.pem`. Current deployment `8195b235`.
  - **`LIPILA_API_KEY` restored 2026-09-30** — value = first whitespace token of line 0 of `OneDrive\Documents\lsk_019fc62a-10c9-726a-82ff-03bfdee.txt` (40-char `lsk_…` prod key; file also holds a "kingdom sponsor" note + support note on later lines — never use those). Verified `GET https://blz.lipila.io/api/v1/merchants/balance` with `x-api-key` → HTTP 200, balance 6.4108 ZMW.
  - **`.dev.vars` contains LOCAL placeholders (`local-*`, sandbox envs) — never use it to restore production.**
  - E2E verified in headless Chrome against the live site: type number → Send Code → `request-otp 200` → code → Verify → `verify-otp 200` → Home screen logged in (superadmin); `/api/me` with the issued JWT → 200.
  - **WARNING: a second deployer exists** (other machine/session — no local wrangler log for its deploys, foreign config, OAuth author `godfreymoseskalambo`). It broke production twice (`0e15538e`, `6841ad08`). Coordinate/stop it, or it will wipe the worker again. After any deploy you did not make: check `GET /api/products` **and** `npx wrangler secret list`.
  - **It struck AGAIN at 12:40:51Z** (source `Unknown (deployment)`, 6 min after the 12:35 secret restore) — all secrets wiped a second time; re-restored (6/6) and fully re-verified the same day. The deployer is still active — treat every unexpected `wrangler deployments list` entry as a potential wipe and re-check secrets after it.
- **2026-09-27 gap batch (all six closed, E2E green):** R2 upload pipeline (`POST /api/upload` + admin `migrate-images` — ran, 0 migrated), banner CRUD + category delete (409 guard), OTP lockout (migration_004 applied; 5 fails → 15-min 429 on request+verify), ZRA SmartInvoice client (VSDC `SalesInformation/SaveSales`, config-driven base/auth, stores AFC/ACF/QR; needs official onboarding docs + `ZRA_API_KEY` + `zra_enabled=1` to go live), 401→403 reclassification (56 sites, `forbidden()` helper), plus Flutter-side: upload service at all image pickers, banners/categories admin write UI, FCM tap-through deep links (route allowlist). Full browser E2E: login → verify-otp 200 → Home. `POST /api/admin/migrate-images` executed (0 migrated / 18 skipped / 0 failed).
- D1 remote: migrations 001-003 applied (25 tables incl. `reviews`, `rider_payouts`, `proof_photo`, `buyer_tpin`, `tax_payments`, `riders.updated_at`), seed applied → 10 bag categories, 16 bag products with `assets/products/*.png`.

## 2026-09-30 session (deploy `bd203e65`) — admin/Lipila/FX batch
- `GET /api/fx` (before `/api/config`): live USD→ZMW from `FX_SOURCES` (open.er-api.com, frankfurter.dev, jsdelivr fawazahmed0 currency-api — each with a `pick` closure), module `fxCache` 6h TTL, last-good persisted to `app_settings` key `fx_usd_zmw` (upsert), static fallback 26.5 → response `{ok, usdToZmw, source, updatedAt, stale?}`.
- `/api/config` adds `appDescription` (byKey `app_description`), `maintenanceMode` (`maintenance_mode === "1"`), feeInfo `deliveryBaseFee`/`deliveryPerKm` (cents→whole).
- Maintenance middleware `app.use("/api/*")` after CORS: `maintenanceCache` 60s TTL (invalidated when `maintenance_mode` written in settings PATCH); exempts `/api/config|/api/health|/api/fx|/api/auth/*|/api/webhooks/*`; admins bypass; others 503.
- `PATCH /api/admin/settings`: booleans stored as `"1"/"0"`, nulls skipped, 400 `wrote:false` if nothing to write; `maintenanceCache = null` on maintenance_mode write.
- `GET /api/admin/actions`: LEFT JOIN users → adds `adminName`/`adminRole` (snake_case fields kept for the client).
- `PATCH /api/admin/users/:id`: `Number.isFinite` guard + 404 "User not found" (was silent 200 on bad id).
- `POST /api/admin/payouts/:id/process`: guards `already <status>` + status transitions, wallet restore + `pushAdmins` when flipping to `failed`, `logAction`, returns `{ok, status, error}`.
- `/api/health` (and `/health`): async `SELECT 1` db check → `{ok, service, time, db, latencyMs}`.
- **Lipila**: `src/lipila.ts` `checkWalletBalance` path fixed `/wallet/balance` → **`/merchants/balance`** (old path 404'd — the Finance/superadmin wallet tile was broken). All other paths verified against docs.lipila.dev 1:1: `POST /collections/mobile-money`, `POST /collections/card` (nested customerInfo/collectionRequest), `GET /collections/check-status`, `POST /disbursements/mobile-money`, `GET /disbursements/check-status`; bases sandbox `https://api.lipila.dev/api/v1` / prod `https://blz.lipila.io/api/v1` (`LIPILA_ENV=production`). `LIPILA_API_KEY` secret re-put (value source above).
- Gates: `npx tsc --noEmit` 0. Single deploy ships worker + `../grand-elephants-flutter/build/web` (OAuth wrangler, no `CLOUDFLARE_API_TOKEN`).

## This session's earlier API changes (commit `6a5cb84`)
- Admin products CRUD `/api/admin/products*` (admins manage any business's products; default platform business resolution); business product routes also accept admin.
- Rider approval inserts `riders` fleet row; `PATCH /api/admin/users/:id`: `riderStatus` accepts `rejected`, role rules (admin grants up to `admin`, only superadmin grants `superadmin`, no self-change), OTP cap 5 attempts.
- `src/fees.ts` `loadFeeSettings(db)` — fees (VAT/delivery/commission) read from `app_settings` with 60s cache, env fallback → Finance screen now real.
- `GET /api/employee/stats`; rider `proofPhoto` on `PATCH /api/orders/:id/rider-status`.
- Bags-only: `src/categories.ts` `MARKETPLACE_CATEGORIES`, idempotent bag seed, legacy categories transformed live.
- Feeds: `GET /api/products/new|trending|suggested` (+`?sort=`, `?limit=` default 12), same product JSON shape.
- Buyer TPIN: `POST /api/orders {tpin}` (10 digits) → `orders.buyer_tpin` → `invoices.buyer_tpin` → `buyerTpin` in all order JSON.
- Tax: `GET /api/businesses/me/tax?from&to` (vatBySale incl. tpin), `tax/payments` CRUD, `tax_payments` table; `src/smart_invoice.ts` `submitInvoice()` logged no-op TODO(ZRA) called from `confirmOrder`.
- Receipt: `GET /api/orders/:id/receipt` (full receipt payload incl. business/buyer TPIN, VAT, payment refs); enriched `orderJson`.
- Slogan fallback/seed/live → "Move With Conviction".

## Contracts the app relies on (do not break)
- Product JSON shape (`productJson`), order JSON (`orderJson` incl. `buyerTpin`, `orderNumber`), receipt payload, tax payload — see BLUEPRINT.md API surface + CHANGELOG 2026-09-25.
- Auth: JWT 90 days, OTP 5 min single-use newest-only; `hasRole(user, ...roles)`; `SUPERADMIN_ROLES={"superadmin","admin"}`.

## Known gaps / next steps
- ZRA Smart Invoice embed (fill in `src/smart_invoice.ts`); `ZRA_API_KEY` secret unset (blank until onboarding).
- Maintenance mode untested at runtime (no admin JWT available locally) — code-reviewed only; test the toggle carefully (admins bypass, customers get 503 for 60s after toggle-off at worst).
- Android artifacts (2026-09-30 APK/AAB) built but **not uploaded to R2** (`media.churchonapp.com/grand-elephants/` still serves the 2026-09-27 build).

## Key commands
- `npx tsc --noEmit` (must be 0), `npx wrangler deploy`, `npx wrangler secret list`
- `npx wrangler d1 execute grand-elephants-db --remote --command "SELECT ..."`
- Deploy website: `flutter build web --release` in Flutter repo first, then `npx wrangler deploy` here (`.\deploy.ps1` does both).
