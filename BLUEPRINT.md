# Grand Elephants — Backend Blueprint

Cloudflare Worker + D1 + Lipila + Africa's Talking SMS + FCM push powering the
Grand Elephants luxury marketplace (Flutter app + website on the same worker URL).

## Architecture

```
Flutter app (Android/iOS/web) ──┐
Website (Flutter web build) ────┤──> Cloudflare Worker (grand-elephants-api)
                                │      ├─ Hono router (JSON API under /api/*)
                                │      ├─ D1 (SQLite) database
                                │      ├─ Lipila (MoMo/card collections + payouts)
                                │      ├─ Africa's Talking (OTP + SMS)
                                │      └─ Firebase Admin (FCM push)
```

One worker serves everything: `/api/*` is the JSON API, everything else serves
the Flutter web build (the marketing site + web app) as static assets with SPA
fallback. Live at:
`https://grand-elephants-api.godfreymoseskalambo.workers.dev`

## Roles

| role | access |
|---|---|
| user | browse catalog, order, track, wishlist, chat, addresses |
| rider | `/api/riders/*` — own deliveries, live location, payout history |
| business | `/api/businesses/me/*` — products, orders, staff, riders, payouts |
| employee | joined via business staff — sees own orders |
| admin | `/api/admin/*` — stats, users, orders, businesses, fleet, payouts, Lipila wallet |
| superadmin | everything admin can + collection-number management for all businesses |

Guards are server-side: `authFromRequest()` validates the JWT, `hasRole()`
checks `role`/`superadmin` set, `canManageBusiness()` scopes business data.

## Money flow (Lipila)

1. Checkout `POST /api/orders` — Lipila **collection** prompt sent to the
   customer's phone; money lands in the **Grand Elephants merchant wallet**.
2. Webhook `POST /api/webhooks/lipila` confirms payment → `confirmOrder()`:
   order marked paid, business wallet credited (subtotal − commission), ZRA
   invoice issued.
3. Business payout `POST /api/businesses/me/payout` — Lipila **disbursement**
   to the business collection number (net of the 1.5% disbursement fee).
4. Rider payout `POST /api/admin/riders/:id/payout` — admin pays a rider's
   accrued delivery earnings straight to their mobile money.
5. Daily cron finalizes any payouts stuck in `processing` and expires unpaid
   orders after 48h.

All money is stored as integer **cents** (ZMW). Fees in `src/fees.ts`.

## API surface (key endpoints)

- Auth: `POST /api/auth/request-otp`, `POST /api/auth/verify-otp`, `GET/PATCH /api/me`
- Catalog: `GET /api/config`, `/api/categories`, `/api/products`, `/api/products/:id`, `/api/products/:id/reviews`
- Orders: `POST /api/orders`, `GET /api/orders`, `GET /api/orders/:id`, `POST /api/orders/:id/cancel`
- Business: `/api/businesses/apply`, `/api/businesses/me`, `/api/businesses/me/products`, `/api/businesses/me/orders`, `/api/businesses/me/payout`, collection-numbers
- Riders: `/api/riders/me`, `/api/riders/apply`, `/api/riders/me/deliveries`, `/api/riders/me/payouts`, `/api/riders/me/location`, `/api/orders/:id/rider-status`
- Notifications/addresses/chat: `/api/notifications/mine`, `/api/addresses`, `/api/chat/messages`
- Admin: `/api/admin/stats`, `/api/admin/users`, `/api/admin/orders`, `/api/admin/riders`, `/api/admin/rider-applications`, `/api/admin/rider-payouts`, `/api/admin/payouts`, `/api/admin/lipila/balance`, `/api/admin/categories`, `/api/admin/settings`, `/api/admin/actions`, `/api/admin/lipila-logs`
- Webhooks: `POST /api/webhooks/lipila`, cron `GET /__cron`

## Database (D1)

Schema in `sql/schema.sql` (idempotent DROP+CREATE), seed in `sql/seed.sql`.
Tables: users, businesses, business_members, collection_numbers, products,
categories, orders, order_items, riders, rider_payouts, addresses,
notifications, chat_messages, invoices, invoice_items, wallets, payouts,
reviews, lipila_logs, admin_actions, otps, banners, app_settings.

Apply schema:
```
npx wrangler d1 execute grand-elephants-db --remote --file=./sql/schema.sql
npx wrangler d1 execute grand-elephants-db --remote --file=./sql/seed.sql
```

## SMS (Africa's Talking)

Production live: `api.africastalking.com`, username `ChurchOnApp`, approved
sender ID **`Carpso`**, brand prefix `GRANDELEPHANTS:`. Templates in
`src/messages.ts` (OTP, order, rider, payout, invoice) — the OTP string is inlined
in `src/auth.ts`.

- Secret: `AT_API_KEY` (production key — AT dashboard → Settings → API Key).
- Vars: `AT_USERNAME`, `AT_FROM`, `AT_SANDBOX`.
- `AT_SANDBOX="true"` flips `src/sms.ts` to the sandbox host + username
  `sandbox` (keys are environment-specific; a 401 "authentication is invalid"
  = key/host mismatch).
- `ENV` must be `production` for real sends; otherwise SMS is logged only and
  OTP responses include a `debugCode`.

## Secrets (NEVER commit)

See `.dev.vars.example`. Production secrets via `npx wrangler secret put`:
`AT_API_KEY`, `JWT_SECRET`, `LIPILA_API_KEY`, `LIPILA_WEBHOOK_SECRET`,
`SUPERADMIN_PHONES`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `ZRA_API_KEY`.

The Lipila API key is the **Grand Elephants merchant wallet** key — all
collections land in that wallet, and all business/rider payouts disburse from it.

## Deploy

```
.\deploy.ps1      # builds Flutter web + deploys worker
npx wrangler deploy   # deploy only (website already built)
```

## Local dev

```
npx wrangler dev --test-scheduled
# ENV=sandbox (default) logs SMS + returns debug OTP codes; no real money.
# Production worker runs ENV=production (real AT SMS + real Lipila money).
```