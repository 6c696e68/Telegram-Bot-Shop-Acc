-- Representative schema state AFTER 0001..0014 for tables touched by 0015
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER UNIQUE NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0)
);

CREATE TABLE product_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  price INTEGER NOT NULL CHECK(price > 0),
  emoji TEXT DEFAULT '📦',
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

-- Indexes that 0015 expects to exist (from 0001/0007/0008/0013)
CREATE INDEX idx_products_type_status ON products(type_id, status);
CREATE INDEX idx_products_buyer ON products(buyer_id) WHERE buyer_id IS NOT NULL;
CREATE UNIQUE INDEX idx_products_content_type ON products(type_id, content);
CREATE INDEX idx_orders_user_created ON orders(user_id, created_at DESC);
CREATE INDEX idx_orders_status_created ON orders(status, created_at);
CREATE INDEX idx_orders_product_type ON orders(product_type_id);
CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_ptt_type_lang ON product_type_templates(product_type_id, lang);
CREATE INDEX idx_product_types_category ON product_types(category);

-- Seed data: categories null/empty + distinct values (incl. whitespace-trim collision)
INSERT INTO users (id, telegram_id, balance) VALUES (1, 111, 50000), (2, 222, 0);
INSERT INTO product_types (id, name, description, price, emoji, category, success_template) VALUES
  (1, 'Netflix', 'Tai khoan Netflix', 50000, 'N', 'Giai tri', 'Cam on [name]'),
  (2, 'Spotify', NULL, 30000, 'S', '  Giai tri  ', NULL),
  (3, 'ChatGPT', 'AI', 99000, 'G', 'AI', NULL),
  (4, 'NoCat', NULL, 10000, 'X', NULL, NULL),
  (5, 'EmptyCat', NULL, 12000, 'Y', '   ', NULL);

INSERT INTO products (id, type_id, content, status, buyer_id, order_id) VALUES
  (1, 1, 'acc-netflix-1', 'sold', 1, 1),
  (2, 1, 'acc-netflix-2', 'available', NULL, NULL),
  (3, 3, 'acc-gpt-1', 'available', NULL, NULL),
  (4, 4, 'acc-nocat-1', 'reserved', NULL, NULL);

INSERT INTO orders (id, user_id, product_type_id, quantity, total_amount, status) VALUES
  (1, 1, 1, 1, 50000, 'completed');

INSERT INTO order_items (id, order_id, product_id) VALUES (1, 1, 1);

INSERT INTO product_type_templates (id, product_type_id, lang, success_template) VALUES
  (1, 1, 'vi', 'Cam on [name]'),
  (2, 1, 'en', 'Thanks [name]');
