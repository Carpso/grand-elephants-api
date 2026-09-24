-- Migration 003: buyer TPIN, tax payments, riders.updated_at.
-- Targeted ALTERs for an existing database (idempotent by construction for
-- tax_payments only; run the ALTERs once). Never run sql/schema.sql remotely.

ALTER TABLE orders ADD COLUMN buyer_tpin TEXT;
ALTER TABLE invoices ADD COLUMN buyer_tpin TEXT;
ALTER TABLE riders ADD COLUMN updated_at TEXT;

CREATE TABLE IF NOT EXISTS tax_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  reference TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tax_payments_business ON tax_payments(business_id);
