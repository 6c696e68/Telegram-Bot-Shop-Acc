import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { validateName, validateDescription, validatePrice } from '../src/bot/commands/admin'
import {
  cleanThreeTierTables,
  resetThreeTierSchema,
  seedCategory as seedCatalogCategory,
  seedPricedProduct,
} from './helpers/three-tier-schema'

/**
 * Property-based tests cho Admin validation.
 * **Validates: Requirements 5.2, 5.3, 6.3, 6.5, 6.4**
 */

async function cleanTables(db: D1Database) {
  await cleanThreeTierTables(db)
}

async function seedProduct(db: D1Database, price = 50_000): Promise<number> {
  const categoryId = await seedCatalogCategory(db, 'Test Category')
  return seedPricedProduct(db, {
    categoryId,
    name: 'Test Product',
    price,
  })
}

// --- Property 10: Category validation với error message cụ thể ---

describe('Property 10: Category validation với error message cụ thể', () => {
  /**
   * **Validates: Requirements 5.2, 5.3**
   * validateName: valid khi 1-100 chars non-empty, invalid khi empty hoặc > 100.
   * validateDescription: valid khi 0-500 chars, invalid khi > 500.
   * validatePrice: valid khi 1-999999999 integer string, invalid cho non-numbers, < 1, > 999999999.
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
    it('accepts integer strings in range 1-999999999', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 999_999_999 }),
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

    it('rejects prices below 1 with specific error', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -10_000, max: 0 }),
          (price) => {
            const result = validatePrice(String(price))
            expect(result.valid).toBe(false)
            expect(result.error).toBeDefined()
            expect(result.error).toContain('1')
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
   * N unique contents tạo N product_items via D1 batch.
   */
  beforeEach(async () => {
    await resetThreeTierSchema(env.DB)
    await cleanTables(env.DB)
  })

  it('N unique contents inserted via batch create exactly N product_items', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.string({ minLength: 1, maxLength: 100 }).filter(s => s.trim().length > 0),
          { minLength: 1, maxLength: 20 }
        ).filter(arr => new Set(arr).size === arr.length), // ensure unique
        async (contents) => {
          await cleanTables(env.DB)

          const productId = await seedProduct(env.DB)
          const now = new Date().toISOString()

          // Batch insert (same logic as handleAddProduct)
          const stmts = contents.map((content: string) =>
            env.DB.prepare(
              'INSERT INTO product_items (product_id, content, status, created_at) VALUES (?, ?, ?, ?)'
            ).bind(productId, content, 'available', now)
          )

          await env.DB.batch(stmts)

          // Verify all N product_items created
          const result = await env.DB
            .prepare('SELECT COUNT(*) as cnt FROM product_items WHERE product_id = ?')
            .bind(productId)
            .first<{ cnt: number }>()

          expect(result!.cnt).toBe(contents.length)

          // Verify each content exists
          for (const content of contents) {
            const product = await env.DB
              .prepare('SELECT id FROM product_items WHERE product_id = ? AND content = ?')
              .bind(productId, content)
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

          const productId = await seedProduct(env.DB)
          const now = new Date().toISOString()

          // Insert the existing product first
          await env.DB.prepare(
            'INSERT INTO product_items (product_id, content, status, created_at) VALUES (?, ?, ?, ?)'
          ).bind(productId, existingContent, 'available', now).run()

          // Build batch that includes the existing content (will cause UNIQUE violation)
          const contentsWithDup = [...newContents, existingContent]
          const stmts = contentsWithDup.map((content: string) =>
            env.DB.prepare(
              'INSERT INTO product_items (product_id, content, status, created_at) VALUES (?, ?, ?, ?)'
            ).bind(productId, content, 'available', now)
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
            .prepare('SELECT COUNT(*) as cnt FROM product_items WHERE product_id = ?')
            .bind(productId)
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
 * UNIQUE INDEX (product_id, content) prevents duplicate content within same product.
   */
  beforeEach(async () => {
    await resetThreeTierSchema(env.DB)
    await cleanTables(env.DB)
  })

  it('rejects duplicate content in same category', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0),
        async (content) => {
          await cleanTables(env.DB)

          const productId = await seedProduct(env.DB)
          const now = new Date().toISOString()

          // First insert succeeds
          await env.DB.prepare(
            'INSERT INTO product_items (product_id, content, status, created_at) VALUES (?, ?, ?, ?)'
          ).bind(productId, content, 'available', now).run()

          // Second insert with same content + category should fail
          let insertFailed = false
          try {
            await env.DB.prepare(
              'INSERT INTO product_items (product_id, content, status, created_at) VALUES (?, ?, ?, ?)'
            ).bind(productId, content, 'available', now).run()
          } catch (e) {
            insertFailed = true
          }

          expect(insertFailed).toBe(true)

          // Only 1 product exists
          const result = await env.DB
            .prepare('SELECT COUNT(*) as cnt FROM product_items WHERE product_id = ? AND content = ?')
            .bind(productId, content)
            .first<{ cnt: number }>()
          expect(result!.cnt).toBe(1)
        }
      ),
      { numRuns: 30 }
    )
  })

  it('allows same content in different products', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 200 }).filter(s => s.trim().length > 0),
        async (content) => {
          await cleanTables(env.DB)

          const productId1 = await seedProduct(env.DB, 26_000)
          const productId2 = await seedProduct(env.DB, 60_000)
          const now = new Date().toISOString()

          // Insert same content in two different products
          await env.DB.prepare(
            'INSERT INTO product_items (product_id, content, status, created_at) VALUES (?, ?, ?, ?)'
          ).bind(productId1, content, 'available', now).run()

          await env.DB.prepare(
            'INSERT INTO product_items (product_id, content, status, created_at) VALUES (?, ?, ?, ?)'
          ).bind(productId2, content, 'available', now).run()

          // Both exist
          const count1 = await env.DB
            .prepare('SELECT COUNT(*) as cnt FROM product_items WHERE product_id = ? AND content = ?')
            .bind(productId1, content)
            .first<{ cnt: number }>()
          const count2 = await env.DB
            .prepare('SELECT COUNT(*) as cnt FROM product_items WHERE product_id = ? AND content = ?')
            .bind(productId2, content)
            .first<{ cnt: number }>()

          expect(count1!.cnt).toBe(1)
          expect(count2!.cnt).toBe(1)
        }
      ),
      { numRuns: 30 }
    )
  })
})
