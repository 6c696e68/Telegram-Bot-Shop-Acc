-- Post-0014 relevant schema state (subset) for verifying 0015 migration.
-- FK off during seeding: real rows were added incrementally over time; this fixture
-- inserts products (with order_id) before orders, which would violate FK otherwise.
PRAGMA foreign_keys=OFF;

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER UNIQUE NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0)
);

-- product_types after 0001 + 0002(success_template) + 0012(image_data) + 0013(category)
CREATE TABLE product_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL CHECK(price > 0),
  emoji TEXT DEFAULT '#',
  sort_order INTEGER DEFAULT 0,
  is_visible INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  success_template TEXT,
  image_data TEXT,
  category TEXT
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  product_type_id INTEGER NOT NULL REFERENCES product_types(id),
  quantity INTEGER NOT NULL CHECK(quantity > 0),
  total_amount INTEGER NOT NULL,
  transaction_id INTEGER,
  status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed','refunded')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type_id INTEGER NOT NULL REFERENCES product_types(id),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','sold','reserved')),
  buyer_id INTEGER REFERENCES users(id),
  order_id INTEGER REFERENCES orders(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sold_at TEXT
);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE product_type_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_type_id INTEGER NOT NULL REFERENCES product_types(id) ON DELETE CASCADE,
  lang TEXT NOT NULL,
  success_template TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(product_type_id, lang)
);

-- Indexes from 0001 carried onto product_items_old after rename; 0015 drops them
-- together with product_items_old after rebuilding the final product_items table.
CREATE INDEX idx_products_type_status ON products(type_id, status);
CREATE INDEX idx_products_buyer ON products(buyer_id) WHERE buyer_id IS NOT NULL;
CREATE UNIQUE INDEX idx_products_content_type ON products(type_id, content);
-- Orders indexes from 0001 + 0007
CREATE INDEX idx_orders_user_created ON orders(user_id, created_at DESC);
CREATE INDEX idx_orders_status_created ON orders(status, created_at);
CREATE INDEX idx_orders_product_type ON orders(product_type_id);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_ptt_type_lang ON product_type_templates(product_type_id, lang);
CREATE INDEX idx_product_types_category ON product_types(category);

-- ===== SEED DATA (edge cases) =====
INSERT INTO users (id, telegram_id, balance) VALUES (1, 111, 50000), (2, 222, 0);

-- product_types: id1 null category, id2 whitespace category, id3 & id4 same 'AI', id5 'VPN'
INSERT INTO product_types (id, name, description, price, emoji, category) VALUES
  (1, 'Netflix',  'desc1', 10000, 'N', NULL),
  (2, 'Spotify',  NULL,    20000, 'S', '   '),
  (3, 'ChatGPT',  'desc3', 30000, 'C', 'AI'),
  (4, 'Claude',   NULL,    40000, 'L', 'AI'),
  (5, 'NordVPN',  'desc5', 50000, 'V', 'VPN');

INSERT INTO products (id, type_id, content, status, buyer_id, order_id) VALUES
  (1, 1, 'net-acc-1', 'available', NULL, NULL),
  (2, 1, 'net-acc-2', 'sold', 1, 1),
  (3, 2, 'spo-acc-1', 'available', NULL, NULL),
  (4, 3, 'gpt-acc-1', 'reserved', NULL, NULL),
  (5, 4, 'cla-acc-1', 'available', NULL, NULL);

INSERT INTO orders (id, user_id, product_type_id, quantity, total_amount, status) VALUES
  (1, 1, 1, 1, 10000, 'completed');

INSERT INTO order_items (id, order_id, product_id) VALUES
  (1, 1, 2);

INSERT INTO product_type_templates (id, product_type_id, lang, success_template) VALUES
  (1, 1, 'vi', 'Cam on ban da mua [name]'),
  (2, 3, 'en', 'Thanks for buying [name]');
