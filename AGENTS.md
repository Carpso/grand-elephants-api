# AGENTS.md — Grand Elephants API

Guidance for AI coding agents working in this repository.

## Commands

- `npx tsc --noEmit` — typecheck
- `npx wrangler dev --test-scheduled` — local dev (ENV=sandbox: no real SMS/money)
- `npm run db:remote` — apply `sql/schema.sql` to remote D1
- `npm run db:seed` — apply `sql/seed.sql` to remote D1
- `.\deploy.ps1` — build Flutter web + `wrangler deploy`
- `npx wrangler secret put NAME` — set a secret (see `.dev.vars.example`)

## Conventions

- **All money is integer cents.** Never float money. Fees in `src/fees.ts`.
- Server-side role guards are REQUIRED on every admin/business/rider route —
  `authFromRequest()` + `hasRole()` / `canManageBusiness()`.
- Never hardcode secrets. They come from `env` bindings (`LIPILA_API_KEY`,
  `JWT_SECRET`, etc.). A var with the same name as a secret will block the
  secret — keep secrets out of `[vars]` in `wrangler.toml`.
- SQL is SQLite (D1). Use `db.batch()` for multi-statement transactions.
- Order/collection/disbursement reference IDs are idempotency keys — never
  re-run a collection with the same referenceId.
- New tables MUST be added to `sql/schema.sql` (idempotent DROP+CREATE) and
  applied to remote D1 before deploy.
- Keep `src/index.ts` Hono routes grouped by concern (auth, catalog, orders,
  business, riders, admin, webhooks, cron).

## SMS (Africa's Talking)

- Live on the **production** API: `api.africastalking.com`, username
  `ChurchOnApp`, sender ID **`Carpso`** (approved). All SMS are branded
  `GRANDELEPHANTS: …` (`src/messages.ts` + the OTP string in `src/auth.ts`).
- `AT_API_KEY` is a secret (production key from the AT dashboard —
  `Settings → API Key`). `AT_USERNAME`/`AT_FROM`/`AT_SANDBOX` are `[vars]`.
- `AT_SANDBOX = "true"` switches `src/sms.ts` to
  `api.sandbox.africastalking.com` with username `sandbox` (sandbox keys are
  rejected by the production host and vice versa — a 401
  "The supplied authentication is invalid" almost always means
  key/environment mismatch).
- `ENV=production` is required for SMS to actually send; otherwise messages
  are only logged. OTP debug codes are returned only when `ENV != production`.
- If AT rejects the sender ID (400), `sendSms` retries once without `from`
  so OTPs keep flowing.

## Repository layout

- `src/index.ts` — all routes + cron
- `src/auth.ts` — OTP + JWT + role guards
- `src/lipila.ts` — Lipila gateway client (collections, card, disbursements, balance)
- `src/fees.ts` — fee math (delivery/VAT/commission/Lipila fees)
- `src/firebase.ts` — FCM push
- `src/sms.ts` — Africa's Talking SMS
- `src/invoice.ts` — ZRA SmartInvoice-ready invoices
- `sql/` — D1 schema + seed

## Dependencies

Node 18+, `@cloudflare/workers-types`. This repo has no tests — verify with
`npx tsc --noEmit` and manual `curl` against `wrangler dev`.