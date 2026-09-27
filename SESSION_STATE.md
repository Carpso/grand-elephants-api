# SESSION_STATE — Grand Elephants API (Cloudflare Worker)

Saved: 2026-09-27. Companion: same file in `grand-elephants-flutter`.

## Infra (no secrets in this file)
- Worker/site: `https://grand-elephants-api.godfreymoseskalambo.workers.dev` (serves `/api/*` + Flutter web SPA via `[assets]` → `../grand-elephants-flutter/build/web`, SPA fallback + catch-all in `src/index.ts`).
- D1: `grand-elephants-db` (`447d1f6c-1b73-4bfd-bea5-3747460acdfc`). Schema: `sql/schema.sql` (**DROP+CREATE — never run against remote**); safe migrations: `sql/migration_001..003.sql`; seed: `sql/seed.sql` (idempotent, bags-only).
- Wrangler: use OAuth config at `C:\Users\User\AppData\Roaming\xdg.config\.wrangler\config\default.toml`; run `npx wrangler` WITHOUT `CLOUDFLARE_API_TOKEN` env (token lacks workers:edit). Account `ab82a97ce2c926279c483fef36c41945`.
- Secrets set on worker: `AT_API_KEY` (PRODUCTION), `JWT_SECRET`, `LIPILA_API_KEY`, `LIPILA_WEBHOOK_SECRET`, `SUPERADMIN_PHONES=+260968551110`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL`. Vars: `ENV=production`, `LIPILA_ENV=production`, `AT_USERNAME=ChurchOnApp`, `AT_FROM=Carpso` (approved), `AT_SANDBOX=false`, `FIREBASE_PROJECT_ID=grand-elephants-b8ec4`, `OTP_TTL_MINUTES=5`.
- SMS: Africa's Talking production host; brand prefix `GRANDELEPHANTS:`; sandbox keys only work on `api.sandbox.africastalking.com` with username `sandbox` (401 = key/environment mismatch). Key values found in `OneDrive\Documents\Settings - API Key.txt` (prod) and `sandbox api key Africa talking Sa.txt`.
- GitHub: `Carpso/grand-elephants-api`, branch **master**, push with `git push https://Carpso:<PAT>@github.com/Carpso/grand-elephants-api.git master`.
- Cron `0 6 * * *` finalizes stuck payouts + expires unpaid orders.

## State
- Last deploy: version `245a7263-2617-4eab-89d2-f76ca63cd539` (2026-09-27), script + 81 assets; verified live: `request-otp` 200 `{"ok":true}` (real SMS), `verify-otp` 401 for wrong code, `/api/products` 200 (16 bags), `main.dart.js` 200, SPA fallback 200.
- **Incident 2026-09-27 (resolved):** deployment `0e15538e` (2026-09-25 03:52Z) was uploaded **assets-only — no worker script** → every non-asset path returned an *empty* 404 (this is why the app's "Send Code" button got no response: `POST /api/auth/request-otp` died at the edge) and `wrangler tail` failed with CF code `100311` "Cannot tail a Worker which only has assets". Cause of that upload unknown (no Flutter/app code was at fault). Fix = `npx wrangler deploy` from this repo. **Diagnostic rule:** empty-body 404s + `100311` on tail → redeploy immediately, then re-verify `request-otp`.
- **Incident 2026-09-27 part 2 (secrets wipe, resolved):** a **foreign deployment** `6841ad08` (08:08:49Z, source `version_upload`, config with `compatibility_date = 2026-09-25` — ours is `2026-01-01` — and **no handlers/bindings**) overwrote the worker again AND **wiped all secrets** (`npx wrangler secret list` → `[]`). Symptoms: `verify-otp` → 500 "Imported HMAC key length (0)…" (empty `JWT_SECRET`), and no SMS dispatched (`AT_API_KEY` gone; `sendSms` errors are swallowed so `request-otp` still returned `{"ok":true}`). Restored: worker redeploy + secrets re-put from value sources — `AT_API_KEY`←`Temp\opencode\at_prod.txt` (prod `atsk_e…`), `JWT_SECRET`←`jwt_secret.txt`, `LIPILA_WEBHOOK_SECRET`←`webhook_secret.txt`, `SUPERADMIN_PHONES=+260968551110`, `FIREBASE_CLIENT_EMAIL`←OneDrive `grand-elephants-b8ec4-firebase-adminsdk-…json`, `FIREBASE_PRIVATE_KEY`←`Temp\opencode\firebase_key.pem`. Current deployment `8195b235`.
  - **`LIPILA_API_KEY` value is LOST** (it only ever existed as a CF secret) — re-fetch from the Lipila dashboard and run `npx wrangler secret put LIPILA_API_KEY`. Payment collection/disbursement will fail until then.
  - **`.dev.vars` contains LOCAL placeholders (`local-*`, sandbox envs) — never use it to restore production.**
  - E2E verified in headless Chrome against the live site: type number → Send Code → `request-otp 200` → code → Verify → `verify-otp 200` → Home screen logged in (superadmin); `/api/me` with the issued JWT → 200.
  - **WARNING: a second deployer exists** (other machine/session — no local wrangler log for its deploys, foreign config, OAuth author `godfreymoseskalambo`). It broke production twice (`0e15538e`, `6841ad08`). Coordinate/stop it, or it will wipe the worker again. After any deploy you did not make: check `GET /api/products` **and** `npx wrangler secret list`.
  - **It struck AGAIN at 12:40:51Z** (source `Unknown (deployment)`, 6 min after the 12:35 secret restore) — all secrets wiped a second time; re-restored (6/6) and fully re-verified the same day. The deployer is still active — treat every unexpected `wrangler deployments list` entry as a potential wipe and re-check secrets after it.
- **2026-09-27 gap batch (all six closed, E2E green):** R2 upload pipeline (`POST /api/upload` + admin `migrate-images` — ran, 0 migrated), banner CRUD + category delete (409 guard), OTP lockout (migration_004 applied; 5 fails → 15-min 429 on request+verify), ZRA SmartInvoice client (VSDC `SalesInformation/SaveSales`, config-driven base/auth, stores AFC/ACF/QR; needs official onboarding docs + `ZRA_API_KEY` + `zra_enabled=1` to go live), 401→403 reclassification (56 sites, `forbidden()` helper), plus Flutter-side: upload service at all image pickers, banners/categories admin write UI, FCM tap-through deep links (route allowlist). Full browser E2E: login → verify-otp 200 → Home. `POST /api/admin/migrate-images` executed (0 migrated / 18 skipped / 0 failed).
- D1 remote: migrations 001-003 applied (25 tables incl. `reviews`, `rider_payouts`, `proof_photo`, `buyer_tpin`, `tax_payments`, `riders.updated_at`), seed applied → 10 bag categories, 16 bag products with `assets/products/*.png`.

## This session's API changes (commit `6a5cb84`)
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
- ZRA Smart Invoice embed (fill in `src/smart_invoice.ts`).
- Image uploads still base64 in D1 → move to R2 (add binding + upload route).
- No banner write endpoint / category delete endpoint; `attempts` cap exists but no lockout duration.
- Business scope/role failures return 401 instead of 403 (client doesn't auto-logout on 401, so safe today).
- `ZRA_API_KEY` secret unset (blank until onboarding).

## Key commands
- `npx tsc --noEmit` (must be 0), `npx wrangler deploy`, `npx wrangler secret list`
- `npx wrangler d1 execute grand-elephants-db --remote --command "SELECT ..."`
- Deploy website: `flutter build web --release` in Flutter repo first, then `npx wrangler deploy` here (`.\deploy.ps1` does both).
