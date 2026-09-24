-- Grand Elephants seed data: bags-only marketplace.
-- Idempotent: every statement is an upsert / INSERT ... WHERE NOT EXISTS, so
-- re-running against an existing database (local or remote) never duplicates
-- rows and never overwrites admin-tuned settings.
--
-- Run: npx wrangler d1 execute grand-elephants-db --remote --file=./sql/seed.sql

-- ---------- 0) bags-only enforcement for pre-existing data ----------
-- No-ops on a fresh database (no legacy rows); on a live one it retires the
-- old non-bag catalog in place: legacy category names are renamed onto the
-- bag set (preserving category ids), product categories follow, and anything
-- that is still not a bag is deactivated (never deleted: orders reference it).

UPDATE categories SET name = CASE name
    WHEN 'Bags' THEN 'Handbags'
    WHEN 'Shoes' THEN 'Backpacks'
    WHEN 'Jewelry' THEN 'Clutches'
    WHEN 'Dresses' THEN 'Tote Bags'
    WHEN 'Electronics' THEN 'Laptop Bags'
    WHEN 'Groceries' THEN 'Shopping Bags'
    WHEN 'Fashion' THEN 'Crossbody Bags'
    WHEN 'Home & Living' THEN 'Duffel & Travel Bags'
    WHEN 'Accessories' THEN 'Waist Bags'
    WHEN 'Beauty' THEN 'Baby Bags'
  END
 WHERE name IN ('Bags', 'Shoes', 'Jewelry', 'Dresses', 'Electronics', 'Groceries',
                'Fashion', 'Home & Living', 'Accessories', 'Beauty');

UPDATE products SET category = CASE category
    WHEN 'Bags' THEN 'Handbags'
    WHEN 'Shoes' THEN 'Backpacks'
    WHEN 'Jewelry' THEN 'Clutches'
    WHEN 'Dresses' THEN 'Tote Bags'
    WHEN 'Electronics' THEN 'Laptop Bags'
    WHEN 'Groceries' THEN 'Shopping Bags'
    WHEN 'Fashion' THEN 'Crossbody Bags'
    WHEN 'Home & Living' THEN 'Duffel & Travel Bags'
    WHEN 'Accessories' THEN 'Waist Bags'
    WHEN 'Beauty' THEN 'Baby Bags'
  END,
  updated_at = datetime('now')
 WHERE category IN ('Bags', 'Shoes', 'Jewelry', 'Dresses', 'Electronics', 'Groceries',
                    'Fashion', 'Home & Living', 'Accessories', 'Beauty');

UPDATE products
   SET active = 0, updated_at = datetime('now')
 WHERE category NOT IN ('Tote Bags', 'Backpacks', 'Handbags', 'Crossbody Bags', 'Clutches',
                        'Laptop Bags', 'Duffel & Travel Bags', 'Waist Bags', 'Shopping Bags', 'Baby Bags');

-- ---------- 10 bag categories ----------

INSERT INTO categories (name, icon, enabled) VALUES
  ('Tote Bags', '👜', 1),
  ('Backpacks', '🎒', 1),
  ('Handbags', '👛', 1),
  ('Crossbody Bags', '👝', 1),
  ('Clutches', '💼', 1),
  ('Laptop Bags', '💻', 1),
  ('Duffel & Travel Bags', '🧳', 1),
  ('Waist Bags', '🛍️', 1),
  ('Shopping Bags', '🛒', 1),
  ('Baby Bags', '🍼', 1)
ON CONFLICT(name) DO UPDATE SET icon = excluded.icon, enabled = 1;

-- ---------- settings (only when missing, never clobber live values) ----------

INSERT INTO app_settings (key, value) VALUES
  ('app_name', 'Grand Elephants'),
  ('app_slogan', 'Move With Conviction'),
  ('app_logo', ''),
  ('vat_pct', '16'),
  ('platform_commission_pct', '15'),
  ('delivery_base_fee_cents', '2500'),
  ('delivery_per_km_cents', '1000'),
  ('zra_enabled', '0'),
  ('zra_api_url', '')
ON CONFLICT(key) DO NOTHING;

-- ---------- 15 bag products (only when a business exists) ----------
-- Prices are ZMW cents (K850 = 85000). Images are Flutter asset keys from
-- assets/products/*.png so ProductImage resolves them on every platform.
-- Products are tied to the first business row (the seeded marketplace shop).

INSERT INTO products (business_id, name, price_cents, image, description, category, is_ghost, stock, active)
SELECT (SELECT id FROM businesses ORDER BY id LIMIT 1),
  'Classic Beige Tote', 85000,
  'assets/products/chic_tote_bag_beige_1765539674873.png',
  'Structured beige tote with reinforced handles, zip top and a roomy interior for everyday work and errands.',
  'Tote Bags', 0, 25, 1
WHERE EXISTS (SELECT 1 FROM businesses)
  AND NOT EXISTS (SELECT 1 FROM products WHERE name = 'Classic Beige Tote');

INSERT INTO products (business_id, name, price_cents, image, description, category, is_ghost, stock, active)
SELECT (SELECT id FROM businesses ORDER BY id LIMIT 1),
  'Everyday Canvas Tote', 45000,
  'assets/products/chic_tote_bag_beige_1765539674873.png',
  'Lightweight canvas tote for groceries, market runs and beach days. Folds flat when not in use.',
  'Shopping Bags', 0, 30, 1
WHERE EXISTS (SELECT 1 FROM businesses)
  AND NOT EXISTS (SELECT 1 FROM products WHERE name = 'Everyday Canvas Tote');

INSERT INTO products (business_id, name, price_cents, image, description, category, is_ghost, stock, active)
SELECT (SELECT id FROM businesses ORDER BY id LIMIT 1),
  'Tan Leather Backpack', 125000,
  'assets/products/elegant_backpack_tan_1765539717712.png',
  'Full-grain tan leather backpack with padded straps, laptop sleeve and quick-access front pocket.',
  'Backpacks', 0, 20, 1
WHERE EXISTS (SELECT 1 FROM businesses)
  AND NOT EXISTS (SELECT 1 FROM products WHERE name = 'Tan Leather Backpack');

INSERT INTO products (business_id, name, price_cents, image, description, category, is_ghost, stock, active)
SELECT (SELECT id FROM businesses ORDER BY id LIMIT 1),
  'Gilded Top-Handle Bag', 250000,
  'assets/products/luxury_handbag_gold_1765539658142.png',
  'Statement gold-toned top-handle bag with gold hardware, silk-lined interior and detachable strap.',
  'Handbags', 0, 8, 1
WHERE EXISTS (SELECT 1 FROM businesses)
  AND NOT EXISTS (SELECT 1 FROM products WHERE name = 'Gilded Top-Handle Bag');

INSERT INTO products (business_id, name, price_cents, image, description, category, is_ghost, stock, active)
SELECT (SELECT id FROM businesses ORDER BY id LIMIT 1),
  'White Structured Handbag', 185000,
  'assets/products/white_structured_handbag_1765540624619.png',
  'Crisp white structured handbag with a detachable crossbody strap and protective metal feet.',
  'Handbags', 0, 12, 1
WHERE EXISTS (SELECT 1 FROM businesses)
  AND NOT EXISTS (SELECT 1 FROM products WHERE name = 'White Structured Handbag');

INSERT INTO products (business_id, name, price_cents, image, description, category, is_ghost, stock, active)
SELECT (SELECT id FROM businesses ORDER BY id LIMIT 1),
  'Boho Suede Bucket Bag', 98000,
  'assets/products/boho_bucket_bag_suede_1765541183472.png',
  'Soft suede bucket bag with drawstring closure and braided tassel detail for an effortless boho look.',
  'Handbags', 0, 15, 1
WHERE EXISTS (SELECT 1 FROM businesses)
  AND NOT EXISTS (SELECT 1 FROM products WHERE name = 'Boho Suede Bucket Bag');

INSERT INTO products (business_id, name, price_cents, image, description, category, is_ghost, stock, active)
SELECT (SELECT id FROM businesses ORDER BY id LIMIT 1),
  'Blue Crossbody Bag', 69000,
  'assets/products/blue_crossbody_bag_1765540608590.png',
  'Hands-free blue crossbody with adjustable strap, RFID pocket and enough room for phone, wallet and keys.',
  'Crossbody Bags', 0, 35, 1
WHERE EXISTS (SELECT 1 FROM businesses)
  AND NOT EXISTS (SELECT 1 FROM products WHERE name = 'Blue Crossbody Bag');

INSERT INTO products (business_id, name, price_cents, image, description, category, is_ghost, stock, active)
SELECT (SELECT id FROM businesses ORDER BY id LIMIT 1),
  'Modern Black Clutch', 52000,
  'assets/products/modern_clutch_black_1765539690984.png',
  'Minimal matte black clutch for evenings out, with a hidden chain strap and magnetic snap closure.',
  'Clutches', 0, 25, 1
WHERE EXISTS (SELECT 1 FROM businesses)
  AND NOT EXISTS (SELECT 1 FROM products WHERE name = 'Modern Black Clutch');

INSERT INTO products (business_id, name, price_cents, image, description, category, is_ghost, stock, active)
SELECT (SELECT id FROM businesses ORDER BY id LIMIT 1),
  'Red Leather Satchel', 115000,
  'assets/products/red_leather_satchel_1765540591490.png',
  'Bold red leather satchel with twin handles, adjustable shoulder strap and organised inner compartments.',
  'Tote Bags', 0, 18, 1
WHERE EXISTS (SELECT 1 FROM businesses)
  AND NOT EXISTS (SELECT 1 FROM products WHERE name = 'Red Leather Satchel');

INSERT INTO products (business_id, name, price_cents, image, description, category, is_ghost, stock, active)
SELECT (SELECT id FROM businesses ORDER BY id LIMIT 1),
  'Patterned Travel Duffle', 165000,
  'assets/products/patterned_travel_duffle_1765540640522.png',
  'Cabin-friendly patterned duffle with shoe compartment, reinforced base and a luggage strap on the back.',
  'Duffel & Travel Bags', 0, 10, 1
WHERE EXISTS (SELECT 1 FROM businesses)
  AND NOT EXISTS (SELECT 1 FROM products WHERE name = 'Patterned Travel Duffle');

INSERT INTO products (business_id, name, price_cents, image, description, category, is_ghost, stock, active)
SELECT (SELECT id FROM businesses ORDER BY id LIMIT 1),
  'Canvas Weekender Duffle', 145000,
  'assets/products/canvas_weekender_striped_1765541218222.png',
  'Striped canvas weekender with leather trim, 40L capacity and a removable padded shoulder strap.',
  'Duffel & Travel Bags', 0, 14, 1
WHERE EXISTS (SELECT 1 FROM businesses)
  AND NOT EXISTS (SELECT 1 FROM products WHERE name = 'Canvas Weekender Duffle');

INSERT INTO products (business_id, name, price_cents, image, description, category, is_ghost, stock, active)
SELECT (SELECT id FROM businesses ORDER BY id LIMIT 1),
  'Vintage Leather Messenger', 118000,
  'assets/products/vintage_leather_messenger_1765541166445.png',
  'Distressed leather messenger that fits a 15-inch laptop, with an adjustable buckle strap.',
  'Laptop Bags', 0, 16, 1
WHERE EXISTS (SELECT 1 FROM businesses)
  AND NOT EXISTS (SELECT 1 FROM products WHERE name = 'Vintage Leather Messenger');

INSERT INTO products (business_id, name, price_cents, image, description, category, is_ghost, stock, active)
SELECT (SELECT id FROM businesses ORDER BY id LIMIT 1),
  'Padded Laptop Briefcase', 99000,
  'assets/products/vintage_leather_messenger_1765541166445.png',
  'Slim padded briefcase with a suspended laptop bay, cable organiser and water-resistant finish.',
  'Laptop Bags', 0, 20, 1
WHERE EXISTS (SELECT 1 FROM businesses)
  AND NOT EXISTS (SELECT 1 FROM products WHERE name = 'Padded Laptop Briefcase');

INSERT INTO products (business_id, name, price_cents, image, description, category, is_ghost, stock, active)
SELECT (SELECT id FROM businesses ORDER BY id LIMIT 1),
  'Urban Belt Bag', 38000,
  'assets/products/urban_belt_bag_black_1765541201845.png',
  'Sleek black belt bag worn around the waist or across the chest, perfect for travel and busy days.',
  'Waist Bags', 0, 40, 1
WHERE EXISTS (SELECT 1 FROM businesses)
  AND NOT EXISTS (SELECT 1 FROM products WHERE name = 'Urban Belt Bag');

INSERT INTO products (business_id, name, price_cents, image, description, category, is_ghost, stock, active)
SELECT (SELECT id FROM businesses ORDER BY id LIMIT 1),
  'Baby Diaper Backpack', 85000,
  'assets/products/elegant_backpack_tan_1765539717712.png',
  'Hands-free diaper backpack with insulated bottle pockets, changing mat and stroller straps.',
  'Baby Bags', 0, 22, 1
WHERE EXISTS (SELECT 1 FROM businesses)
  AND NOT EXISTS (SELECT 1 FROM products WHERE name = 'Baby Diaper Backpack');

-- Repoint the legacy placeholder image (assets/products/handbag.png does not
-- exist in the app bundle) to a real bundled bag asset.
UPDATE products
   SET image = 'assets/products/luxury_handbag_gold_1765539658142.png',
       updated_at = datetime('now')
 WHERE image = 'assets/products/handbag.png';
