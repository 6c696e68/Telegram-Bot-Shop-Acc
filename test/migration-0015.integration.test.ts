import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { DEFAULT_CATEGORY_NAME } from '../src/services/catalog-migration-map'

declare const __MIGRATION_0015_SQL_B64__: string

function migration0015Sql(): string {
  const b64 = __MIGRATION_0015_SQL_B64__
  if (!b64) return ''
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function splitSqlStatements(sql: string): string[] {
  return sql.split(';').map((part) => part.trim()).filter(Boolean)
}

function executableMigration0015Sql(): string {
  const sql = migration0015Sql()
  return sql
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart()
      return !trimmed.startsWith('--') && !trimmed.startsWith('PRAGMA foreign_keys=')
    })
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .replace(/CREATE TEMP TABLE/g, 'CREATE TABLE')
    .replace(/order_id INTEGER REFERENCES orders\(id\),/g, 'order_id INTEGER,')
    .trim()
}

async function runSqlScript(sql: string): Promise<void> {
  const statements = splitSqlStatements(sql)
  for (let i = 0; i < statements.length; i += 1) {
    const statement = statements[i]
    try {
      await env.DB.prepare(statement).run()
    } catch (error) {
      throw new Error(`migration statement ${i + 1} failed: ${statement.slice(0, 160)} :: ${String(error)}`)
    }
  }
}

async function runSqlScriptBatch(sql: string): Promise<void> {
  const statements = sql.split(';').map((part) => part.trim()).filter(Boolean)
  try {
    await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)))
  } catch (error) {
    throw new Error(`migration batch failed: ${String(error)}`)
  }
}

async function dropKnownTables(): Promise<void> {
  await env.DB.prepare('PRAGMA foreign_keys=OFF').run()
  for (const table of [
    'order_items',
    'orders',
    'product_items',
    'products',
    'product_type_templates',
    'product_translations',
    'product_type_translations',
    'product_types',
    'users',
    'transactions',
    'deposits',
    'admin_users',
    'system_config',
    'audit_logs',
    'banners',
    'product_items_old',
    'product_types_old',
    '_pre',
    '_category_map',
    '_assert',
  ]) {
    await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run().catch(() => {})
  }
  await env.DB.prepare('PRAGMA foreign_keys=ON').run()
}

async function createLegacySchema(): Promise<void> {
  const statements = [
    `CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id INTEGER UNIQUE NOT NULL,
      balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0)
    )`,
    `CREATE TABLE product_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      price INTEGER NOT NULL,
      emoji TEXT,
      sort_order INTEGER DEFAULT 0,
      is_visible INTEGER DEFAULT 1,
      success_template TEXT,
      image_data TEXT,
      category TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','sold','reserved')),
      buyer_id INTEGER,
      order_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sold_at TEXT
    )`,
    `CREATE TABLE product_type_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_type_id INTEGER NOT NULL,
      lang TEXT NOT NULL,
      success_template TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(product_type_id, lang)
    )`,
    `CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      product_type_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      total_amount INTEGER NOT NULL,
      transaction_id INTEGER,
      status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed','refunded')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
    `CREATE TABLE order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
  ]
  for (const statement of statements) {
    await env.DB.prepare(statement).run()
  }
}

async function seedLegacyData(): Promise<void> {
  await env.DB.prepare('INSERT INTO users (id, telegram_id, balance) VALUES (1, 123456, 0)').run()
  await env.DB
    .prepare(
      `INSERT INTO product_types
        (id, name, description, price, emoji, sort_order, is_visible, success_template, image_data, category, created_at, updated_at)
       VALUES
        (10, 'Legacy A', 'Desc A', 10000, NULL, 1, 1, 'Tpl A', 'img-a', NULL, '2026-01-01', '2026-01-02'),
        (11, 'Legacy B', 'Desc B', 20000, NULL, 2, 1, 'Tpl B', 'img-b', ?, '2026-01-03', '2026-01-04')`
    )
    .bind(DEFAULT_CATEGORY_NAME)
    .run()
  await env.DB
    .prepare(
      `INSERT INTO products (id, type_id, content, status, buyer_id, order_id, created_at, sold_at)
       VALUES
        (100, 10, 'account-a', 'sold', 1, 500, '2026-01-05', '2026-01-06'),
        (101, 11, 'account-b', 'available', NULL, NULL, '2026-01-07', NULL)`
    )
    .run()
  await env.DB
    .prepare(
      "INSERT INTO product_type_templates (id, product_type_id, lang, success_template, updated_at) VALUES (600, 10, 'en', 'Delivered [content]', '2026-01-08')"
    )
    .run()
  await env.DB
    .prepare(
      "INSERT INTO orders (id, user_id, product_type_id, quantity, total_amount, transaction_id, status, created_at) VALUES (500, 1, 10, 1, 10000, 900, 'completed', '2026-01-09')"
    )
    .run()
  await env.DB
    .prepare("INSERT INTO order_items (id, order_id, product_id, created_at) VALUES (700, 500, 100, '2026-01-10')")
    .run()
}

beforeEach(async () => {
  await dropKnownTables()
  await createLegacySchema()
  await seedLegacyData()
})

describe('Migration 0015 integration smoke', () => {
  it('migrates legacy product data into the three-tier schema without losing references', async () => {
    const sql = migration0015Sql()
    expect(sql).toContain('0015 - Product Catalog three-tier')
    const executableSql = executableMigration0015Sql()
    await runSqlScript(executableSql)

    const counts = await env.DB
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM product_types) AS categories,
          (SELECT COUNT(*) FROM products) AS products,
          (SELECT COUNT(*) FROM product_items) AS product_items,
          (SELECT COUNT(*) FROM orders) AS orders,
          (SELECT COUNT(*) FROM product_type_templates) AS templates`
      )
      .first<{ categories: number; products: number; product_items: number; orders: number; templates: number }>()
    expect(counts).toEqual({ categories: 2, products: 2, product_items: 2, orders: 1, templates: 1 })

    const matchingDefaultNames = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM product_types WHERE name = ?')
      .bind(DEFAULT_CATEGORY_NAME)
      .first<{ n: number }>()
    expect(matchingDefaultNames!.n).toBe(2)

    const product = await env.DB
      .prepare('SELECT id, product_type_id, name, description, price, image_data FROM products WHERE id = 10')
      .first<{ id: number; product_type_id: number; name: string; description: string; price: number; image_data: string }>()
    expect(product).toMatchObject({
      id: 10,
      product_type_id: 1,
      name: 'Legacy A',
      description: 'Desc A',
      price: 10000,
      image_data: 'img-a',
    })

    const item = await env.DB
      .prepare('SELECT id, product_id, content, status, buyer_id, order_id, sold_at FROM product_items WHERE id = 100')
      .first<{ id: number; product_id: number; content: string; status: string; buyer_id: number; order_id: number; sold_at: string }>()
    expect(item).toMatchObject({
      id: 100,
      product_id: 10,
      content: 'account-a',
      status: 'sold',
      buyer_id: 1,
      order_id: 500,
      sold_at: '2026-01-06',
    })

    const order = await env.DB.prepare('SELECT product_id FROM orders WHERE id = 500').first<{ product_id: number }>()
    expect(order!.product_id).toBe(10)
    const orderItem = await env.DB
      .prepare('SELECT product_item_id FROM order_items WHERE id = 700')
      .first<{ product_item_id: number }>()
    expect(orderItem!.product_item_id).toBe(100)
    const template = await env.DB
      .prepare('SELECT product_type_id, lang, success_template FROM product_type_templates WHERE id = 600')
      .first<{ product_type_id: number; lang: string; success_template: string }>()
    expect(template).toEqual({
      product_type_id: 10,
      lang: 'en',
      success_template: 'Delivered [content]',
    })
  })

  it('fails the final assertion on broken legacy references and leaves the old schema intact in a transactional batch', async () => {
    // Feature: product-catalog-i18n-upgrade, Integration: migration rollback on count/reference mismatch
    await env.DB.prepare('UPDATE products SET type_id = 999 WHERE id = 101').run()

    await expect(runSqlScriptBatch(executableMigration0015Sql())).rejects.toThrow(/migration batch failed/)

    const oldProduct = await env.DB
      .prepare('SELECT id, type_id, content, status FROM products WHERE id = 101')
      .first<{ id: number; type_id: number; content: string; status: string }>()
    expect(oldProduct).toEqual({ id: 101, type_id: 999, content: 'account-b', status: 'available' })

    const oldProductType = await env.DB
      .prepare('SELECT id, price, success_template FROM product_types WHERE id = 11')
      .first<{ id: number; price: number; success_template: string }>()
    expect(oldProductType).toEqual({ id: 11, price: 20000, success_template: 'Tpl B' })

    await expect(env.DB.prepare('SELECT COUNT(*) AS n FROM product_items').first()).rejects.toThrow()
  })
})
