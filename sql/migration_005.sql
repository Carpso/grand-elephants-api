-- Migration 005: uniform buyer-borne platform fee model.
-- Run ONCE against the remote DB (the ALTER fails if re-run):
--   npx wrangler d1 execute grand-elephants-db --remote --file=./sql/migration_005.sql
-- The UPDATE/INSERT statements are idempotent.

ALTER TABLE orders ADD COLUMN platform_fee_cents INTEGER NOT NULL DEFAULT 0;

-- Historic platform earnings used the old seller-commission model - backfill so
-- the admin dashboard keeps its history after the stats query switches.
UPDATE orders SET platform_fee_cents = CAST(ROUND(subtotal_cents * COALESCE((SELECT commission_pct FROM businesses b WHERE b.id = orders.business_id), 15) / 100.0) AS INTEGER)
 WHERE payment_status = 'successful' AND platform_fee_cents = 0;

-- Fee settings now describe the buyer-borne cut (DB values shadow env vars).
INSERT INTO app_settings (key, value) VALUES
  ('platform_commission_pct', '1'),
  ('platform_min_fee_cents', '300'),
  ('platform_card_fee_pct', '2'),
  ('platform_card_min_fee_cents', '500'),
  ('platform_payout_fee_pct', '1')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
