-- =============================================
-- 0015 - Product Catalog three-tier + i18n upgrade
--
-- Chuyen mo hinh san pham tu HAI TANG sang BA TANG:
--   1. product_types (MOI)  = Danh muc, KHONG co gia.
--   2. products (MOI)        = San pham co gia, FK -> product_types. GIU NGUYEN id
--                              cua product_types CU (anh xa 1:1, id-preserving - D4).
--   3. product_items         = Kho tai khoan, doi ten tu products CU; type_id -> product_id.
--
-- Them Translation_Store theo thuc the: product_type_translations, product_translations
--   (pattern giong product_type_templates o 0008, khoa UNIQUE(entity_id, lang)).
--
-- Chien luoc: tao bang moi + copy + doi ten (giong 0008_multi_region_payments.sql),
--   bao toan orders / order_items / product_type_templates, doi soat so dem cuoi
--   (ep loi chia-0 de abort ca file neu sai lech).
--
-- LUU Y D1: PRAGMA foreign_keys la no-op khi dang trong transaction (giu de tai lieu).
--   id duoc bao toan nen orders.product_type_id (= id product_types cu) va
--   product_items.product_id (= type_id cu) tu khop voi products.id moi.
--
-- KHONG sua bat ky migration da ton tai (0001..0014). Chi them file moi nay.
-- =============================================

PRAGMA foreign_keys=OFF;

DROP TABLE IF EXISTS _migration_0015_pre;
DROP TABLE IF EXISTS _migration_0015_category_map;
DROP TABLE IF EXISTS _migration_0015_assert;

-- ---------------------------------------------
-- BUOC 0: Chup so dem TRUOC migration de doi soat cuoi (R2.8, R2.10)
--   products CU       = kho tai khoan  -> n_items
--   product_types CU  = san pham moi   -> n_products
-- ---------------------------------------------
CREATE TABLE _migration_0015_pre AS
  SELECT
    (SELECT COUNT(*) FROM products)                AS n_items,
    (SELECT COUNT(*) FROM product_types)           AS n_products,
    (SELECT COUNT(*) FROM orders)                  AS n_orders,
    (SELECT COUNT(*) FROM product_type_templates)  AS n_tpl;

-- ---------------------------------------------
-- BUOC 1: Kho tai khoan: products (CU) -> product_items_old, type_id -> product_id
--   ALTER ... RENAME giu nguyen toan bo du lieu, CHECK(status IN
--   ('available','sold','reserved')) va cac index cu; se rebuild thanh product_items
--   sau khi tao bang products moi de FK product_id tro dung products(id).
-- ---------------------------------------------
ALTER TABLE products RENAME TO product_items_old;
ALTER TABLE product_items_old RENAME COLUMN type_id TO product_id;

-- ---------------------------------------------
-- BUOC 2: Tach bang gia cu lam nguon sinh san pham + danh muc
-- ---------------------------------------------
ALTER TABLE product_types RENAME TO product_types_old;

-- ---------------------------------------------
-- BUOC 3: product_types MOI = danh muc (KHONG co cot price - R1.1)
-- ---------------------------------------------
CREATE TABLE product_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,                                  -- Base_Value (R1.11)
  description TEXT,                                     -- Base_Value, nullable
  content TEXT,                                         -- Base_Value, nullable
  emoji TEXT,                                           -- du lieu admin nhap; NULL/rong = khong co emoji
  image_data TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_visible INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 3a. Danh muc mac dinh co dinh, duy nhat (id=1) CHI tao khi co category null/rong (R2.6, R2.12)
INSERT INTO product_types (id, name, sort_order, is_visible)
SELECT 1, 'Chưa phân loại', 0, 1
WHERE EXISTS (
  SELECT 1 FROM product_types_old
  WHERE category IS NULL OR TRIM(category) = ''
);

-- 3b. Lap bang anh xa tam cho category thuc su co gia tri (R2.5, R2.13).
--     Khong lookup bang name khi gan Product de tranh gop nham category co text trung
--     voi nhan danh muc mac dinh.
CREATE TABLE _migration_0015_category_map (
  category_key TEXT PRIMARY KEY,
  product_type_id INTEGER NOT NULL UNIQUE
);

INSERT INTO _migration_0015_category_map (category_key, product_type_id)
SELECT
  category_key,
  (SELECT COUNT(*) FROM product_types) + ROW_NUMBER() OVER (ORDER BY category_key)
FROM (
  SELECT DISTINCT TRIM(category) AS category_key
  FROM product_types_old
  WHERE category IS NOT NULL AND TRIM(category) <> ''
);

-- 3c. Moi category DISTINCT (khac null/rong) -> 1 danh muc (R2.5)
INSERT INTO product_types (id, name, sort_order, is_visible)
SELECT product_type_id, category_key, 0, 1
FROM _migration_0015_category_map
ORDER BY product_type_id;

-- ---------------------------------------------
-- BUOC 4: products MOI = san pham co gia, GIU NGUYEN id cu (R2.2, D4)
--   CHECK gia: 1 <= price <= 999999999 (R1.5)
-- ---------------------------------------------
CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_type_id INTEGER NOT NULL REFERENCES product_types(id),  -- danh muc cha (R1.2)
  name TEXT NOT NULL,                                  -- Base_Value (R1.11)
  description TEXT,                                     -- Base_Value, nullable
  content TEXT,                                         -- Base_Value hien thi, nullable
  price INTEGER NOT NULL CHECK(price >= 1 AND price <= 999999999), -- VND (R1.5)
  emoji TEXT,
  image_data TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_visible INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO products
  (id, product_type_id, name, description, content, price, emoji, image_data, sort_order, is_visible, created_at, updated_at)
SELECT
  o.id,
  CASE
    WHEN o.category IS NULL OR TRIM(o.category) = '' THEN 1
    ELSE (SELECT m.product_type_id FROM _migration_0015_category_map m WHERE m.category_key = TRIM(o.category))
  END,
  o.name, o.description, NULL, o.price, o.emoji, o.image_data, o.sort_order, o.is_visible,
  o.created_at, o.updated_at
FROM product_types_old o;                              -- gia/mo ta/anh/emoji giu nguyen (R2.2)

-- ---------------------------------------------
-- BUOC 5: orders_new - doi product_type_id -> product_id (FK products), giu gia tri id
--   (R2.7, R9.1, R9.6). Tai tao cac index cua orders bi mat khi DROP (gom ca
--   perf index tu 0007: status_created, product).
-- ---------------------------------------------
CREATE TABLE orders_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  total_amount INTEGER NOT NULL,
  transaction_id INTEGER,
  status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed','refunded')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO orders_new (id, user_id, product_id, quantity, total_amount, transaction_id, status, created_at)
SELECT id, user_id, product_type_id, quantity, total_amount, transaction_id, status, created_at FROM orders;

-- ---------------------------------------------
-- BUOC 6: product_items FINAL = kho cu, FK product_id -> products(id) (R1.4, R2.3, R2.4)
--   order_id tam tro orders_new; khi orders_new doi ten ve orders, SQLite cap nhat FK.
-- ---------------------------------------------
CREATE TABLE product_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','sold','reserved')),
  buyer_id INTEGER REFERENCES users(id),
  order_id INTEGER REFERENCES orders_new(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sold_at TEXT
);

INSERT INTO product_items (id, product_id, content, status, buyer_id, order_id, created_at, sold_at)
SELECT id, product_id, content, status, buyer_id, order_id, created_at, sold_at
FROM product_items_old;

-- ---------------------------------------------
-- BUOC 7: product_type_templates_new - GIU NGUYEN ban ghi, chi retarget FK -> products (R11.1)
--   product_type_id cua template = id product_types cu = id products moi -> tu khop.
--   Rebuild copy 1:1 (cung so dong, cung noi dung) de doi dich FK an toan,
--   GIU TEN cot product_type_id (tuong thich code hien co).
-- ---------------------------------------------
CREATE TABLE product_type_templates_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_type_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  lang TEXT NOT NULL,
  success_template TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(product_type_id, lang)
);
INSERT INTO product_type_templates_new (id, product_type_id, lang, success_template, updated_at)
SELECT id, product_type_id, lang, success_template, updated_at FROM product_type_templates;

-- ---------------------------------------------
-- BUOC 8: order_items_new - doi product_id -> product_item_id (FK product_items), giu id
--   (R2.7, R9.2)
-- ---------------------------------------------
CREATE TABLE order_items_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders_new(id),
  product_item_id INTEGER NOT NULL REFERENCES product_items(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO order_items_new (id, order_id, product_item_id, created_at)
SELECT id, order_id, product_id, created_at FROM order_items;

-- Drop bang cu theo thu tu child -> parent de D1 remote khong vi pham FK.
DROP TABLE product_type_templates;
DROP TABLE order_items;
DROP TABLE product_items_old;
DROP TABLE orders;
DROP TABLE product_types_old;

ALTER TABLE product_type_templates_new RENAME TO product_type_templates;
ALTER TABLE orders_new RENAME TO orders;
ALTER TABLE order_items_new RENAME TO order_items;

CREATE INDEX idx_ptt_type_lang ON product_type_templates(product_type_id, lang);
CREATE INDEX idx_orders_user_created ON orders(user_id, created_at DESC);
CREATE INDEX idx_orders_status_created ON orders(status, created_at);
CREATE INDEX idx_orders_product ON orders(product_id);
CREATE INDEX idx_order_items_order ON order_items(order_id);

-- ---------------------------------------------
-- BUOC 9: Translation_Store (D2) - theo thuc the, UNIQUE(entity_id, lang) (R3.4)
--   lang de MO, loc theo SUPPORTED_LANGUAGES o tang ung dung (R3.5).
-- ---------------------------------------------
CREATE TABLE product_type_translations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_type_id INTEGER NOT NULL REFERENCES product_types(id) ON DELETE CASCADE,
  lang TEXT NOT NULL,
  name TEXT,
  description TEXT,
  content TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(product_type_id, lang)
);

CREATE TABLE product_translations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  lang TEXT NOT NULL,
  name TEXT,
  description TEXT,
  content TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(product_id, lang)
);

CREATE INDEX idx_pt_trans ON product_type_translations(product_type_id, lang);
CREATE INDEX idx_prod_trans ON product_translations(product_id, lang);

-- ---------------------------------------------
-- BUOC 10: Index kho/san pham
--   Index cu cua products CU nam tren product_items_old va bien mat khi drop bang
--   old. product_items FINAL duoc rebuild nen tao index moi tu dau.
-- ---------------------------------------------
CREATE INDEX idx_product_items_product_status ON product_items(product_id, status);   -- ton kho dong (R1.7)
CREATE UNIQUE INDEX idx_product_items_content ON product_items(product_id, content);  -- chong trung content trong cung san pham
CREATE INDEX idx_product_items_buyer ON product_items(buyer_id) WHERE buyer_id IS NOT NULL;
CREATE INDEX idx_products_type_visible ON products(product_type_id, is_visible);      -- liet ke san pham theo danh muc (R6.2, R7.2)

-- ---------------------------------------------
-- BUOC 11: Doi soat so luong - EP LOI de abort ca file neu sai lech (R2.8, R2.10).
--   product_items == products CU, products == product_types CU, orders va
--   product_type_templates giu nguyen so dong; tat ca FK moi join duoc.
--
--   LUU Y QUAN TRONG: trong SQLite/D1 phep chia cho 0 (1/0) tra ve NULL, KHONG
--   nem loi -> KHONG abort duoc migration. Vi vay dung CHECK constraint: tao bang
--   helper _migration_0015_assert co rang buoc CHECK(ok = 1) roi chen gia tri ket qua doi soat;
--   khi so dem sai lech, gia tri chen vao = 0 vi pham CHECK -> loi -> wrangler coi
--   ca file 0015 la CHUA ap dung (rollback, khong danh dau trong d1_migrations).
-- ---------------------------------------------
CREATE TABLE _migration_0015_assert (ok INTEGER NOT NULL CHECK(ok = 1));
INSERT INTO _migration_0015_assert (ok) VALUES (
	  CASE WHEN (SELECT COUNT(*) FROM product_items)           = (SELECT n_items FROM _migration_0015_pre)
	        AND (SELECT COUNT(*) FROM products)                = (SELECT n_products FROM _migration_0015_pre)
	        AND (SELECT COUNT(*) FROM orders)                  = (SELECT n_orders FROM _migration_0015_pre)
	        AND (SELECT COUNT(*) FROM product_type_templates)  = (SELECT n_tpl FROM _migration_0015_pre)
	        AND NOT EXISTS (
	          SELECT 1 FROM products p
	          LEFT JOIN product_types pt ON pt.id = p.product_type_id
	          WHERE pt.id IS NULL
	        )
	        AND NOT EXISTS (
	          SELECT 1 FROM product_items pi
	          LEFT JOIN products p ON p.id = pi.product_id
	          WHERE p.id IS NULL
	        )
	        AND NOT EXISTS (
	          SELECT 1 FROM orders o
	          LEFT JOIN products p ON p.id = o.product_id
	          WHERE p.id IS NULL
	        )
	        AND NOT EXISTS (
	          SELECT 1 FROM order_items oi
	          LEFT JOIN orders o ON o.id = oi.order_id
	          LEFT JOIN product_items pi ON pi.id = oi.product_item_id
	          WHERE o.id IS NULL OR pi.id IS NULL
	        )
	        AND NOT EXISTS (
	          SELECT 1 FROM product_type_templates t
	          LEFT JOIN products p ON p.id = t.product_type_id
	          WHERE p.id IS NULL
	        )
	       THEN 1 ELSE 0 END
);

-- ---------------------------------------------
-- BUOC 12: Don dep
-- ---------------------------------------------
DROP TABLE _migration_0015_assert;
DROP TABLE _migration_0015_category_map;
DROP TABLE _migration_0015_pre;

PRAGMA foreign_keys=ON;
