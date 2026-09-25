# SESSION_STATE — Grand Elephants API (Cloudflare Worker)

Saved: 2026-09-25. Companion: same file in `grand-elephants-flutter`.

## Infra (no secrets in this file)
- Worker/site: `https://grand-elephants-api.godfreymoseskalambo.workers.dev` (serves `/api/*` + Flutter web SPA via `[assets]` → `../grand-elephants-flutter/build/web`, SPA fallback + catch-all in `src/index.ts`).
- D1: `grand-elephants-db` (`447d1f6c-1b73-4bfd-bea5-3747460acdfc`). Schema: `sql/schema.sql` (**DROP+CREATE — never run against remote**); safe migrations: `sql/migration_001..003.sql`; seed: `sql/seed.sql` (idempotent, bags-only).
- Wrangler: use OAuth config at `C:\Users\User\AppData\Roaming\xdg.config\.wrangler\config\default.toml`; run `npx wrangler` WITHOUT `CLOUDFLARE_API_TOKEN` env (token lacks workers:edit). Account `ab82a97ce2c926279c483fef36c41945`.
- Secrets set on worker: `AT_API_KEY` (PRODUCTION), `JWT_SECRET`, `LIPILA_API_KEY`, `LIPILA_WEBHOOK_SECRET`, `SUPERADMIN_PHONES=+260968551110`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_CLIENT_EMAIL`. Vars: `ENV=production`, `LIPILA_ENV=production`, `AT_USERNAME=ChurchOnApp`, `AT_FROM=Carpso` (approved), `AT_SANDBOX=false`, `FIREBASE_PROJECT_ID=grand-elephants-b8ec4`, `OTP_TTL_MINUTES=5`.
- SMS: Africa's Talking production host; brand prefix `GRANDELEPHANTS:`; sandbox keys only work on `api.sandbox.africastalking.com` with username `sandbox` (401 = key/environment mismatch). Key values found in `OneDrive\Documents\Settings - API Key.txt` (prod) and `sandbox api key Africa talking Sa.txt`.
- GitHub: `Carpso/grand-elephants-api`, branch **master**, push with `git push https://Carpso:<PAT>@github.com/Carpso/grand-elephants-api.git master`.
- Cron `0 6 * * *` finalizes stuck payouts + expires unpaid orders.

## State
- Last deploy: version `2bc40c3b-...` (2026-09-25), tsc 0, live smoke-verified (slogan, 16 bag products, 10 bag categories, 3 feeds).
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
