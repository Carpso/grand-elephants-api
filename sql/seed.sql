-- Seed data: categories, banners, settings, a superadmin user (phone from SUPERADMIN_PHONES var via API).

INSERT OR IGNORE INTO categories (name, icon, enabled) VALUES
  ('Bags', '👜', 1),
  ('Shoes', '👠', 1),
  ('Jewelry', '💍', 1),
  ('Dresses', '👗', 1),
  ('Electronics', '📱', 1),
  ('Groceries', '🛒', 1),
  ('Fashion', '🧥', 1),
  ('Home & Living', '🏠', 1),
  ('Accessories', '🧢', 1),
  ('Beauty', '💄', 1);

INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('app_name', 'Grand Elephants'),
  ('app_slogan', 'Premium Marketplace & Luxury Heritage'),
  ('app_logo', ''),
  ('vat_pct', '16'),
  ('platform_commission_pct', '15'),
  ('delivery_base_fee_cents', '2500'),
  ('delivery_per_km_cents', '1000'),
  ('zra_enabled', '0'),
  ('zra_api_url', '');
