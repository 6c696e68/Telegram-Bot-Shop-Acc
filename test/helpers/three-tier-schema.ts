export const THREE_TIER_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
    is_active INTEGER DEFAULT 1,
    banned_at TEXT,
    last_interaction_at TEXT,
    region TEXT CHECK(region IN ('vietnam','international')),
    language TEXT,
    language_locked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS product_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    content TEXT,
    emoji TEXT,
    image_data TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_visible INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_type_id INTEGER NOT NULL REFERENCES product_types(id),
    name TEXT NOT NULL,
    description TEXT,
    content TEXT,
    price INTEGER NOT NULL CHECK(price >= 1 AND price <= 999999999),
    emoji TEXT,
    image_data TEXT,
    max_per_order INTEGER NOT NULL DEFAULT 10 CHECK(max_per_order >= 1 AND max_per_order <= 50),
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_visible INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    total_amount INTEGER NOT NULL,
    transaction_id INTEGER,
    status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed','refunded')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL CHECK(type IN ('deposit','purchase','refund','adjustment')),
    amount INTEGER NOT NULL,
    balance_before INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reference_type TEXT,
    reference_id INTEGER,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success','failed','pending')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS product_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id),
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','sold','reserved')),
    buyer_id INTEGER REFERENCES users(id),
    order_id INTEGER REFERENCES orders(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sold_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_product_items_content ON product_items(product_id, content)`,
  `CREATE INDEX IF NOT EXISTS idx_product_items_product_status ON product_items(product_id, status)`,
  `CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    product_item_id INTEGER NOT NULL REFERENCES product_items(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL DEFAULT 'sepay',
    amount INTEGER NOT NULL CHECK(amount > 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','expired','cancelled','awaiting_credit')),
    correlation_ref TEXT,
    provider_txn_id TEXT,
    metadata TEXT,
    completed_at TEXT,
    expired_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_provider_correlation
    ON deposits(provider, correlation_ref) WHERE correlation_ref IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_provider_txn
    ON deposits(provider, provider_txn_id) WHERE provider_txn_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    last_login_at TEXT,
    failed_login_count INTEGER DEFAULT 0,
    locked_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER REFERENCES admin_users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL REFERENCES admin_users(id),
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id INTEGER,
    old_value TEXT,
    new_value TEXT,
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS product_type_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_type_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    lang TEXT NOT NULL,
    success_template TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(product_type_id, lang)
  )`,
  `CREATE TABLE IF NOT EXISTS product_type_translations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_type_id INTEGER NOT NULL REFERENCES product_types(id) ON DELETE CASCADE,
    lang TEXT NOT NULL,
    name TEXT,
    description TEXT,
    content TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(product_type_id, lang)
  )`,
  `CREATE TABLE IF NOT EXISTS product_translations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    lang TEXT NOT NULL,
    name TEXT,
    description TEXT,
    content TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(product_id, lang)
  )`,
  `CREATE TABLE IF NOT EXISTS banners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_data TEXT NOT NULL,
    link_url TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
]

const DROP_TABLES = [
  'audit_logs',
  'banners',
  'order_items',
  'product_items',
  'orders',
  'transactions',
  'deposits',
  'product_type_templates',
  'product_translations',
  'product_type_translations',
  'products',
  'product_types',
  'users',
  'admin_users',
  'system_config',
]

export async function applyThreeTierSchema(db: D1Database): Promise<void> {
  for (const stmt of THREE_TIER_SCHEMA_STATEMENTS) {
    await db.prepare(stmt).run()
  }
}

export async function resetThreeTierSchema(db: D1Database): Promise<void> {
  await db.prepare('PRAGMA foreign_keys=OFF').run()
  for (const table of DROP_TABLES) {
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run()
  }
  await db.prepare('PRAGMA foreign_keys=ON').run()
  await applyThreeTierSchema(db)
}

export async function cleanThreeTierTables(db: D1Database): Promise<void> {
  await db.prepare('DELETE FROM audit_logs').run().catch(() => {})
  await db.prepare('DELETE FROM banners').run().catch(() => {})
  await db.prepare('DELETE FROM order_items').run()
  await db.prepare('DELETE FROM product_items').run()
  await db.prepare('DELETE FROM orders').run()
  await db.prepare('DELETE FROM transactions').run()
  await db.prepare('DELETE FROM deposits').run()
  await db.prepare('DELETE FROM product_type_templates').run()
  await db.prepare('DELETE FROM product_translations').run()
  await db.prepare('DELETE FROM product_type_translations').run()
  await db.prepare('DELETE FROM products').run()
  await db.prepare('DELETE FROM product_types').run()
  await db.prepare('DELETE FROM users').run()
  await db.prepare('DELETE FROM system_config').run()
  await db.prepare('DELETE FROM admin_users').run()
}

export async function seedCategory(
  db: D1Database,
  name = 'Category',
  isVisible = true,
  sortOrder = 0
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO product_types (name, description, content, emoji, sort_order, is_visible)
       VALUES (?, NULL, NULL, NULL, ?, ?)
       RETURNING id`
    )
    .bind(name, sortOrder, isVisible ? 1 : 0)
    .first<{ id: number }>()
  return row!.id
}

export async function seedPricedProduct(
  db: D1Database,
  params: {
    categoryId: number
    name?: string
    description?: string | null
    content?: string | null
    price: number
    isVisible?: boolean
    sortOrder?: number
    emoji?: string | null
    imageData?: string | null
    maxPerOrder?: number
  }
): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO products
         (product_type_id, name, description, content, price, emoji, image_data, max_per_order, sort_order, is_visible)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`
    )
    .bind(
      params.categoryId,
      params.name ?? 'Product',
      params.description ?? null,
      params.content ?? null,
      params.price,
      params.emoji ?? null,
      params.imageData ?? null,
      params.maxPerOrder ?? 10,
      params.sortOrder ?? 0,
      params.isVisible === false ? 0 : 1
    )
    .first<{ id: number }>()
  return row!.id
}

export async function seedProductItems(
  db: D1Database,
  productId: number,
  count: number,
  status: 'available' | 'sold' | 'reserved' = 'available'
): Promise<number[]> {
  const ids: number[] = []
  for (let i = 0; i < count; i++) {
    const row = await db
      .prepare(
        `INSERT INTO product_items (product_id, content, status, created_at)
         VALUES (?, ?, ?, datetime('now'))
         RETURNING id`
      )
      .bind(productId, `item_${productId}_${status}_${i}_${Math.random().toString(36).slice(2)}`, status)
      .first<{ id: number }>()
    ids.push(row!.id)
  }
  return ids
}
