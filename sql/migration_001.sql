-- Migration: add reviews + rider_payouts tables (idempotent, non-destructive).
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  rating INTEGER NOT NULL DEFAULT 5,
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(product_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id);

CREATE TABLE IF NOT EXISTS rider_payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rider_id INTEGER NOT NULL,
  business_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  net_cents INTEGER NOT NULL,
  phone TEXT NOT NULL,
  network TEXT NOT NULL DEFAULT 'mtn',
  status TEXT NOT NULL DEFAULT 'processing',
  lipila_reference TEXT,
  error TEXT,
  requested_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rider_payouts_rider ON rider_payouts(rider_id);
CREATE INDEX IF NOT EXISTS idx_rider_payouts_business ON rider_payouts(business_id);