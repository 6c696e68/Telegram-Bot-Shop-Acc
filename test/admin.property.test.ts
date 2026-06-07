import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { validateName, validateDescription, validatePrice } from '../src/bot/commands/admin'

/**
 * Property-based tests cho Admin validation.
 * **Validates: Requirements 5.2, 5.3, 6.3, 6.5, 6.4**
 */

// --- Schema for D1 tests ---

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS product_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    price INTEGER NOT NULL CHECK(price > 0),
    emoji TEXT DEFAULT '📦',
    sort_order INTEGER DEFAULT 0,
    is_visible INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type_id INTEGER NOT NULL REFERENCES product_types(id),
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','sold','reserved')),
    buyer_id INTEGER,
    order_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sold_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_products_content_type ON products(type_id, content)`,
]

async function applySchema(db: D1Database) {
  for (const stmt of SCHEMA_STATEMENTS) {
    await db.prepare(stmt).run()
  }
}

async function cleanTables(db: D1Database) {
  await db.prepare('DELETE FROM products').run()
  await db.prepare('DELETE FROM product_types').run()
}

async function seedCategory(db: D1Database, price: number = 50000): Promise<number> {
  await db
    .prepare(
      "INSERT INTO product_types (name, price, created_at, updated_at) VALUES ('Test Category', ?, datetime('now'), datetime('now'))"
    )
    .bind(price)
    .run()
  const cat = await db.prepare('SELECT MAX(id) as id FROM product_types').first<{ id: number }>()
  return cat!.id
}

// --- Property 10: Category validation với error message cụ thể ---

describe('Property 10: Category validation với error message cụ thể', () => {
  /**
   * **Validates: Requirements 5.2, 5.3**
   * validateName: valid khi 1-100 chars non-empty, invalid khi empty hoặc > 100.
   * validateDescription: valid khi 0-500 chars, invalid khi > 500.
   * validatePrice: valid khi 1000-999999999 integer string, invalid cho non-numbers, < 1000, > 999999999.
   */

  describe('validateName', () => {
    it('accepts non-empty strings of 1-100 characters', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
          (name) => {
            const result = validateName(name)
            expect(result.valid).toBe(true)
            expect(result.error).toBeUndefined()
          }
        ),
        { numRuns: 100 }
      )
    })

    it('rejects empty or whitespace-only strings with specific error', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('', '   ', '\t', '\n', '  \t\n  '),
          (name) => {
            const result = validateName(name)
            expect(result.valid).toBe(false)
            expect(result.error).toBeDefined()
            expect(result.error).toContain('trống')
          }
        ),
        { numRuns: 10 }
      )
    })

    it('rejects strings exceeding 100 characters with specific error', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 101, maxLength: 300 }).filter((s) => s.trim().length > 100),
          (name) => {
            const result = validateName(name)
            expect(result.valid).toBe(false)
            expect(result.error).toBeDefined()
            expect(result.error).toContain('100')
          }
        ),
        { numRuns: 100 }
      )
    })
  })

  describe('validateDescription', () => {
    it('accepts strings of 0-500 characters', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 0, maxLength: 500 }),
          (description) => {
            const result = validateDescription(description)
            expect(result.valid).toBe(true)
            expect(result.error).toBeUndefined()
          }
        ),
        { numRuns: 100 }
      )
    })

    it('rejects strings exceeding 500 characters with specific error', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 501, maxLength: 1000 }),
          (description) => {
            const result = validateDescription(description)
            expect(result.valid).toBe(false)
            expect(result.error).toBeDefined()
            expect(result.error).toContain('500')
          }
        ),
        { numRuns: 100 }
      )
    })
  })

  describe('validatePrice', () => {
    it('accepts integer strings in range 1000-999999999', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1000, max: 999_999_999 }),
          (price) => {
            const result = validatePrice(String(price))
            expect(result.valid).toBe(true)
            expect(result.error).toBeUndefined()
          }
        ),
        { numRuns: 100 }
      )
    })

    it('rejects non-numeric inputs with specific error', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 20 }).filter(s => isNaN(parseInt(s.replace(/[.,\s]/g, ''), 10))),
          (input) => {
            const result = validatePrice(input)
            expect(result.valid).toBe(false)
            expect(result.error).toBeDefined()
            expect(result.error).toContain('số nguyên')
          }
        ),
        { numRuns: 50 }
      )
    })

    it('rejects prices below 1000 with specific error', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 999 }),
          (price) => {
            const result = validatePrice(String(price))
            expect(result.valid).toBe(false)
            expect(result.error).toBeDefined()
            expect(result.error).toContain('1,000')
          }
        ),
        { numRuns: 50 }
      )
    })

    it('rejects prices above 999999999 with specific error', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1_000_000_000, max: 2_000_000_000 }),
          (price) => {
            const result = validatePrice(String(price))
            expect(result.valid).toBe(false)
            expect(result.error).toBeDefined()
            expect(result.error).toContain('999,999,999')
          }
        ),
        { numRuns: 50 }
      )
    })
  })
})

// --- Property 11: Bulk product insert atomicity ---

describe('Property 11: Bulk product insert atomicity', () => {
  /**
   * **Validates: Requirements 6.3, 6.5**
   * N unique contents tạo N products via D1 batch.
   */
  beforeEach(async () => {
    await applySchema(env.DB)
    await cleanTables(env.DB)
  })

  it('N unique contents inserted via batch create exactly N products', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
          { minLength: 1, maxLength: 20 }
        ).filter(arr => new Set(arr).size === arr.length), // ensure unique
        async (contents) => {
          await cleanTables(env.DB)

          const categoryId = await seedCategory(env.DB)
          const now = new Date().toISOString()

          // Batch insert (same logic as handleAddProduct)
          const stmts = contents.map((content: string) =>
            env.DB.prepare(
              'INSERT INTO products (type_id, content, status, created_at) VALUES (?, ?, ?, ?)'
            ).bind(categoryId, content, 'available', now)
          )

          await env.DB.batch(stmts)

          // Verify all N products created
          const result = await env.DB
            .prepare('SELECT COUNT(*) as cnt FROM products WHERE type_id = ?')
            .bind(categoryId)
            .first<{ cnt: number }>()

          expect(result!.cnt).toBe(contents.length)

          // Verify each content exists
          for (const content of contents) {
            const product = await env.DB
              .prepare('SELECT id FROM products WHERE type_id = ? AND content = ?')
              .bind(categoryId, content)
              .first()
            expect(product).not.toBeNull()
          }
        }
      ),
      { numRuns: 25 }
    )
  })

  it('batch with duplicate content in same category fails atomically (no partial insert)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
        fc.array(
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
          { minLength: 1, maxLength: 5 }
        ),
        async (existingContent, newContents) => {
          await cleanTables(env.DB)

          const categoryId = await seedCategory(env.DB)
          const now = new Date().toISOString()

          // Insert the existing product first
          await env.DB.prepare(
            'INSERT INTO products (type_id, content, status, created_at) VALUES (?, ?, ?, ?)'
          ).bind(categoryId, existingContent, 'available', now).run()

          // Build batch that includes the existing content (will cause UNIQUE violation)
          const contentsWithDup = [...newContents, existingContent]
          const stmts = contentsWithDup.map((content: string) =>
            env.DB.prepare(
              'INSERT INTO products (type_id, content, status, created_at) VALUES (?, ?, ?, ?)'
            ).bind(categoryId, content, 'available', now)
          )

          // D1 batch should fail due to UNIQUE constraint
          let batchFailed = false
          try {
            await env.DB.batch(stmts)
          } catch (e) {
            batchFailed = true
          }

          expect(batchFailed).toBe(true)

          // Verify atomicity: only the original product remains
          const result = await env.DB
            .prepare('SELECT COUNT(*) as cnt FROM products WHERE type_id = ?')
            .bind(categoryId)
            .first<{ cnt: number }>()

          expect(result!.cnt).toBe(1) // Only the pre-existing product
        }
      ),
      { numRuns: 20 }
    )
  })
})

// --- Property 12: Product content uniqueness per category ---

describe('Property 12: Product content uniqueness per category', () => {
  /**
   * **Validates: Requirements 6.4**
   * UNIQUE INDEX (type_id, content) prevents duplicate content within same category.
   */
  beforeEach(async () => {
    await applySchema(env.DB)
    await cleanTables(env.DB)
  })

  it('rejects duplicate content in same category', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0),
        async (content) => {
          await cleanTables(env.DB)

          const categoryId = await seedCategory(env.DB)
          const now = new Date().toISOString()

          // First insert succeeds
          await env.DB.prepare(
            'INSERT INTO products (type_id, content, status, created_at) VALUES (?, ?, ?, ?)'
          ).bind(categoryId, content, 'available', now).run()

          // Second insert with same content + category should fail
          let insertFailed = false
          try {
            await env.DB.prepare(
              'INSERT INTO products (type_id, content, status, created_at) VALUES (?, ?, ?, ?)'
            ).bind(categoryId, content, 'available', now).run()
          } catch (e) {
            insertFailed = true
          }

          expect(insertFailed).toBe(true)

          // Only 1 product exists
          const result = await env.DB
            .prepare('SELECT COUNT(*) as cnt FROM products WHERE type_id = ? AND content = ?')
            .bind(categoryId, content)
            .first<{ cnt: number }>()
          expect(result!.cnt).toBe(1)
        }
      ),
      { numRuns: 30 }
    )
  })

  it('allows same content in different categories', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0),
        async (content) => {
          await cleanTables(env.DB)

          const categoryId1 = await seedCategory(env.DB, 26000)
          const categoryId2 = await seedCategory(env.DB, 60000)
          const now = new Date().toISOString()

          // Insert same content in two different categories
          await env.DB.prepare(
            'INSERT INTO products (type_id, content, status, created_at) VALUES (?, ?, ?, ?)'
          ).bind(categoryId1, content, 'available', now).run()

          await env.DB.prepare(
            'INSERT INTO products (type_id, content, status, created_at) VALUES (?, ?, ?, ?)'
          ).bind(categoryId2, content, 'available', now).run()

          // Both exist
          const count1 = await env.DB
            .prepare('SELECT COUNT(*) as cnt FROM products WHERE type_id = ? AND content = ?')
            .bind(categoryId1, content)
            .first<{ cnt: number }>()
          const count2 = await env.DB
            .prepare('SELECT COUNT(*) as cnt FROM products WHERE type_id = ? AND content = ?')
            .bind(categoryId2, content)
            .first<{ cnt: number }>()

          expect(count1!.cnt).toBe(1)
          expect(count2!.cnt).toBe(1)
        }
      ),
      { numRuns: 30 }
    )
  })
})
