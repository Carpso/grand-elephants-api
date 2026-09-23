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