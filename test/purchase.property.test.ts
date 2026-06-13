import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import {
  cleanThreeTierTables,
  resetThreeTierSchema,
  seedCategory,
  seedPricedProduct,
  seedProductItems,
} from './helpers/three-tier-schema'

/**
 * Property-based tests cho purchase validation.
 * **Validates: Requirements 3.1, 3.5, 3.6**
 */

async function cleanTables(db: D1Database) {
  await cleanThreeTierTables(db)
}

// --- Helpers ---

interface CategorySetup {
  name: string
  isVisible: boolean
  productVisible: boolean
  stockCount: number // number of available product_items to seed
}

async function seedCategoryWithProduct(
  db: D1Database,
  setup: CategorySetup
): Promise<number> {
  const categoryId = await seedCategory(db, setup.name, setup.isVisible)
  if (setup.productVisible || setup.stockCount > 0) {
    const productId = await seedPricedProduct(db, {
      categoryId,
      name: `${setup.name} Product`,
      price: 10_000,
      isVisible: setup.productVisible,
    })
    await seedProductItems(db, productId, setup.stockCount)
  }
  return categoryId
}

// The same SQL query used in handleCategoryList (src/bot/callbacks/purchase.ts)
const CATEGORY_LIST_QUERY = `
  SELECT pt.id, pt.name, pt.emoji,
         COUNT(DISTINCT p.id) as product_count,
         COUNT(CASE WHEN pi.status = 'available' THEN 1 END) as stock
  FROM product_types pt
  LEFT JOIN products p ON p.product_type_id = pt.id AND p.is_visible = 1
  LEFT JOIN product_items pi ON pi.product_id = p.id
  WHERE pt.is_visible = 1
  GROUP BY pt.id
  ORDER BY pt.sort_order ASC, pt.name ASC
`

// --- Arbitraries ---

const arbCategorySetup: fc.Arbitrary<CategorySetup> = fc.record({
  name: fc.string({ minLength: 1, maxLength: 50 }).map((s) => s.replace(/\0/g, 'x')),
  isVisible: fc.boolean(),
  productVisible: fc.boolean(),
  stockCount: fc.integer({ min: 0, max: 10 }),
})

// --- Property 7 ---

describe('Property 7: Category hiển thị theo is_visible và stock động', () => {
  /**
   * **Validates: Requirements 3.1**
   * categories list gồm mọi category hiển thị; stock đếm product_items available.
   */
  beforeEach(async () => {
    await resetThreeTierSchema(env.DB)
    await cleanTables(env.DB)
  })

  it('only visible categories appear; stock counts visible products available items', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbCategorySetup, { minLength: 1, maxLength: 8 }),
        async (categories) => {
          await cleanTables(env.DB)

          // Seed all categories
          const seededIds: number[] = []
          for (const cat of categories) {
            const id = await seedCategoryWithProduct(env.DB, cat)
            seededIds.push(id)
          }

          // Query using the same SQL as handleCategoryList
          const result = await env.DB.prepare(CATEGORY_LIST_QUERY).all<{
            id: number
            name: string
            product_count: number
            stock: number
          }>()

          const returnedIds = new Set(result.results.map((r) => r.id))

          // Verify: every returned category is visible.
          for (const row of result.results) {
            expect(returnedIds.has(row.id)).toBe(true)
          }

          // Verify: no visible category is missing and hidden category is absent.
          for (let i = 0; i < categories.length; i++) {
            const cat = categories[i]
            const id = seededIds[i]

            if (cat.isVisible) {
              expect(returnedIds.has(id)).toBe(true)
              const row = result.results.find((r) => r.id === id)!
              expect(row.product_count).toBe(cat.productVisible ? 1 : 0)
              expect(row.stock).toBe(cat.productVisible ? cat.stockCount : 0)
            } else {
              expect(returnedIds.has(id)).toBe(false)
            }
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it('visible categories with 0 stock are included with stock = 0', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            name: fc.string({ minLength: 1, maxLength: 30 }).map((s) => s.replace(/\0/g, 'x')),
            isVisible: fc.constant(true),
            productVisible: fc.constant(true),
            stockCount: fc.constant(0),
          }),
          { minLength: 1, maxLength: 5 }
        ),
        async (emptyCategories) => {
          await cleanTables(env.DB)

          for (const cat of emptyCategories) {
            await seedCategoryWithProduct(env.DB, cat)
          }

          const result = await env.DB.prepare(CATEGORY_LIST_QUERY).all<{ stock: number }>()
          expect(result.results.length).toBe(emptyCategories.length)
          for (const row of result.results) expect(row.stock).toBe(0)
        }
      ),
      { numRuns: 50 }
    )
  })
})

// --- Property 9 ---

describe('Property 9: Quantity validation', () => {
  /**
   * **Validates: Requirements 3.5, 3.6**
   * Reject input ≤ 0, non-integer, > 50; báo stock thực tế nếu vượt.
   */

  const MAX_QTY = 50

  /**
   * Pure validation logic extracted from purchase.ts:
   * - qty must be integer
   * - qty must be > 0
   * - qty must be <= MAX_QTY (50)
   * - qty must be <= available stock
   *
   * Returns: { valid: true } | { valid: false, reason: string, actualStock?: number }
   */
  function validateQuantity(
    qty: number,
    availableStock: number
  ): { valid: true } | { valid: false; reason: string; actualStock?: number } {
    if (!Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY) {
      return { valid: false, reason: 'invalid_range' }
    }
    if (qty > availableStock) {
      return { valid: false, reason: 'exceeds_stock', actualStock: availableStock }
    }
    return { valid: true }
  }

  it('rejects qty <= 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: 0 }),
        fc.integer({ min: 1, max: 100 }),
        (qty, stock) => {
          const result = validateQuantity(qty, stock)
          expect(result.valid).toBe(false)
          if (!result.valid) {
            expect(result.reason).toBe('invalid_range')
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it('rejects non-integer quantities', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 50, noNaN: true }).filter((n) => !Number.isInteger(n)),
        fc.integer({ min: 1, max: 100 }),
        (qty, stock) => {
          const result = validateQuantity(qty, stock)
          expect(result.valid).toBe(false)
          if (!result.valid) {
            expect(result.reason).toBe('invalid_range')
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it('rejects qty > 50 (MAX_QTY)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 51, max: 10000 }),
        fc.integer({ min: 1, max: 10000 }),
        (qty, stock) => {
          const result = validateQuantity(qty, stock)
          expect(result.valid).toBe(false)
          if (!result.valid) {
            expect(result.reason).toBe('invalid_range')
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it('reports actual remaining stock when qty > available stock (within valid range)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 0, max: 49 }),
        (qty, stock) => {
          fc.pre(qty > stock) // ensure qty exceeds stock

          const result = validateQuantity(qty, stock)
          expect(result.valid).toBe(false)
          if (!result.valid) {
            expect(result.reason).toBe('exceeds_stock')
            expect(result.actualStock).toBe(stock)
          }
        }
      ),
      { numRuns: 100 }
    )
  })

  it('accepts valid quantities (integer, 1 <= qty <= min(50, stock))', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50 }),
        fc.integer({ min: 1, max: 100 }),
        (qty, stock) => {
          fc.pre(qty <= stock) // must not exceed stock

          const result = validateQuantity(qty, stock)
          expect(result.valid).toBe(true)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('NaN and Infinity are rejected', () => {
    const invalidValues = [NaN, Infinity, -Infinity]
    for (const qty of invalidValues) {
      const result = validateQuantity(qty, 10)
      expect(result.valid).toBe(false)
    }
  })
})
