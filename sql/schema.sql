-- Grand Elephants marketplace schema (D1 / SQLite)
-- All money stored as INTEGER cents (ZMW). Prices/totals are cents.

DROP TABLE IF EXISTS reviews;
DROP TABLE IF EXISTS rider_payouts;
DROP TABLE IF EXISTS lipila_logs;
DROP TABLE IF EXISTS admin_actions;
DROP TABLE IF EXISTS otps;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS chat_messages;
DROP TABLE IF EXISTS addresses;
DROP TABLE IF EXISTS invoice_items;
DROP TABLE IF EXISTS invoices;
DROP TABLE IF EXISTS payouts;
DROP TABLE IF EXISTS wallets;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS collection_numbers;
DROP TABLE IF EXISTS business_members;
DROP TABLE IF EXISTS businesses;
DROP TABLE IF EXISTS riders;
DROP TABLE IF EXISTS categories;
DROP TABLE IF EXISTS banners;
DROP TABLE IF EXISTS app_settings;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT UNIQUE NOT NULL,                 -- stable public id, e.g. "u_<hex>"
  name TEXT NOT NULL DEFAULT '',
  email TEXT UNIQUE,
  phone TEXT UNIQUE NOT NULL,               -- E.164, e.g. +260977123456
  password_hash TEXT,                       -- optional (admin/staff web login)
  role TEXT NOT NULL DEFAULT 'user',        -- user | rider | business | employee | admin | superadmin
  rider_status TEXT NOT NULL DEFAULT 'none',-- none | pending | approved
  rider_lat REAL,
  rider_lng REAL,
  rider_address TEXT,
  profile_photo TEXT,
  bike_photo TEXT,
  business_id INTEGER,                      -- own business (for business owners)
  tpin TEXT,                                -- ZRA TPIN (business tax ID)
  fcm_token TEXT,
  fcm_topic TEXT,
  notifications_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_users_phone ON users(phone);
CREATE INDEX idx_users_role ON users(role);

CREATE TABLE businesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  slogan TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  logo TEXT,
  address TEXT NOT NULL DEFAULT '',
  tpin TEXT,                                -- ZRA TPIN
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | suspended
  commission_pct REAL NOT NULL DEFAULT 15,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_businesses_owner ON businesses(owner_user_id);
CREATE INDEX idx_businesses_status ON businesses(status);

CREATE TABLE business_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  role_in_business TEXT NOT NULL DEFAULT 'staff', -- owner | manager | staff
  UNIQUE(business_id, user_id)
);
CREATE INDEX idx_members_business ON business_members(business_id);
CREATE INDEX idx_members_user ON business_members(user_id);

CREATE TABLE collection_numbers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  business_name TEXT NOT NULL,
  network TEXT NOT NULL,                    -- mtn | airtel | zamtel
  phone_number TEXT NOT NULL,
  till_number TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  added_by TEXT NOT NULL DEFAULT 'superadmin', -- superadmin | business
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_collections_business ON collection_numbers(business_id);

CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  image TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  is_ghost INTEGER NOT NULL DEFAULT 0,      -- luxury "not yet listed" item
  stock INTEGER NOT NULL DEFAULT 0,         -- 0 = unlimited
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_products_business ON products(business_id);
CREATE INDEX idx_products_category ON products(category);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  icon TEXT NOT NULL DEFAULT '🛍️',
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,                      -- e.g. ORD-483920-123456 (matches app format)
  user_id INTEGER NOT NULL REFERENCES users(id),
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  subtotal_cents INTEGER NOT NULL,
  delivery_fee_cents INTEGER NOT NULL DEFAULT 0,
  vat_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending',   -- Pending|Confirmed|Processing|Shipped|Out for Delivery|Delivered|Cancelled|Refunded
  payment_method TEXT NOT NULL DEFAULT 'mobile_money', -- mobile_money | card
  payment_status TEXT NOT NULL DEFAULT 'pending',      -- pending | successful | failed
  transaction_id TEXT,
  reference_id TEXT,                        -- Lipila referenceId (idempotency key)
  delivery_address TEXT NOT NULL DEFAULT '',
  delivery_method TEXT NOT NULL DEFAULT 'standard',
  customer_phone TEXT,
  notes TEXT,
  rider_id INTEGER REFERENCES riders(id),
  assigned_at TEXT,
  delivered_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_business ON orders(business_id);
CREATE INDEX idx_orders_rider ON orders(rider_id);
CREATE INDEX idx_orders_status ON orders(status);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL REFERENCES orders(id),
  product_id INTEGER,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  image TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_items_order ON order_items(order_id);

CREATE TABLE riders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  vehicle TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | suspended
  balance_cents INTEGER NOT NULL DEFAULT 0, -- delivery earnings (ZMW cents)
  joined TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, business_id)
);
CREATE INDEX idx_riders_business ON riders(business_id);

CREATE TABLE addresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  details TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_addresses_user ON addresses(user_id);

CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'info',
  data TEXT,                                -- JSON payload for deep links
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_notifications_user ON notifications(user_id, read);

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  is_user INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ZRA SmartInvoice-ready invoice records (one per paid order).
CREATE TABLE invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_no TEXT NOT NULL UNIQUE,          -- e.g. SOA-2026-000123
  order_id TEXT NOT NULL REFERENCES orders(id),
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  customer_id INTEGER NOT NULL REFERENCES users(id),
  tp_in TEXT,                               -- business TPIN
  afc_code TEXT,                            -- ZRA AFC (Tax Invoice) code (filled on ZRA sync)
  acf_code TEXT,                            -- ZRA ACF (self-billing) code
  zra_qr TEXT,                              -- ZRA QR payload
  status TEXT NOT NULL DEFAULT 'issued',    -- issued | synced | cancelled
  subtotal_cents INTEGER NOT NULL,
  vat_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  synced_at TEXT
);
CREATE INDEX idx_invoices_order ON invoices(order_id);
CREATE INDEX idx_invoices_business ON invoices(business_id);

CREATE TABLE invoice_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  vat_pct REAL NOT NULL DEFAULT 16
);
CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id);

CREATE TABLE wallets (
  business_id INTEGER PRIMARY KEY REFERENCES businesses(id),
  balance_cents INTEGER NOT NULL DEFAULT 0, -- available for payout
  held_cents INTEGER NOT NULL DEFAULT 0,    -- in-flight orders not yet delivered
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  amount_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL DEFAULT 0,     -- Lipila disbursement fee, paid by business
  net_cents INTEGER NOT NULL,
  phone TEXT NOT NULL,
  network TEXT NOT NULL DEFAULT 'mtn',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | processing | successful | failed
  lipila_reference TEXT,
  error TEXT,
  requested_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_payouts_business ON payouts(business_id);

CREATE TABLE lipila_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                       -- collection | disbursement
  reference_id TEXT NOT NULL,
  phone TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unknown',   -- success | pending | failed | error
  lipila_status TEXT,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_lipila_logs_ref ON lipila_logs(reference_id);

CREATE TABLE admin_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_user_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT '',
  entity_id TEXT,
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_admin_actions_created ON admin_actions(created_at);

CREATE TABLE otps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_otps_phone ON otps(phone, used, expires_at);

CREATE TABLE banners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  subtitle TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Product reviews (customer ratings).
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL DEFAULT 5,
  comment TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(product_id, user_id)
);
CREATE INDEX idx_reviews_product ON reviews(product_id);

-- Rider payouts: admin pays a rider their delivery earnings via Lipila.
CREATE TABLE rider_payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rider_id INTEGER NOT NULL REFERENCES riders(id),
  business_id INTEGER NOT NULL REFERENCES businesses(id),
  amount_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  net_cents INTEGER NOT NULL,
  phone TEXT NOT NULL,
  network TEXT NOT NULL DEFAULT 'mtn',
  status TEXT NOT NULL DEFAULT 'processing', -- processing | successful | failed
  lipila_reference TEXT,
  error TEXT,
  requested_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_rider_payouts_rider ON rider_payouts(rider_id);
CREATE INDEX idx_rider_payouts_business ON rider_payouts(business_id);
