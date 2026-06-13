import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import {
  cleanThreeTierTables,
  resetThreeTierSchema,
  seedCategory,
  seedPricedProduct,
} from './helpers/three-tier-schema'

/**
 * Property-based tests cho Order History query.
 * **Validates: Requirements 4.7**
 *
 * Property 8: Order history sắp xếp đúng và giới hạn — max 10 items, sorted DESC by created_at
 */

async function cleanTables(db: D1Database) {
  await cleanThreeTierTables(db)
}

async function seedUser(db: D1Database): Promise<number> {
  const telegramId = Math.floor(Math.random() * 2_000_000_000)
  await db
    .prepare(
      "INSERT INTO users (telegram_id, username, first_name, balance, created_at, updated_at) VALUES (?, 'testuser', 'Test', 0, datetime('now'), datetime('now'))"
    )
    .bind(telegramId)
    .run()
  const user = await db
    .prepare('SELECT id FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<{ id: number }>()
  return user!.id
}

async function seedProduct(db: D1Database): Promise<number> {
  const categoryId = await seedCategory(db, 'Test Category')
  return seedPricedProduct(db, {
    categoryId,
    name: 'Test Product',
    price: 50_000,
  })
}

/**
 * Insert N orders with distinct created_at timestamps.
 * Timestamps are spaced 1 minute apart starting from a base time, shuffled to avoid insertion-order bias.
 */
async function seedOrders(
  db: D1Database,
  userId: number,
  productId: number,
  count: number
): Promise<string[]> {
  // Generate timestamps in order, then shuffle for insertion
  const baseTime = new Date('2024-06-01T00:00:00Z')
  const timestamps: string[] = []

  for (let i = 0; i < count; i++) {
    const ts = new Date(baseTime.getTime() + i * 60_000) // 1 min apart
    timestamps.push(ts.toISOString().replace('T', ' ').slice(0, 19))
  }

  // Shuffle timestamps to insert in random order (avoid insertion-order bias)
  const shuffled = [...timestamps].sort(() => Math.random() - 0.5)

  for (const ts of shuffled) {
    await db
      .prepare(
        'INSERT INTO orders (user_id, product_id, quantity, total_amount, status, created_at) VALUES (?, ?, 1, 50000, ?, ?)'
      )
      .bind(userId, productId, 'completed', ts)
      .run()
  }

  return timestamps
}

interface OrderHistoryRow {
  quantity: number
  total_amount: number
  created_at: string
  name: string
  emoji: string | null
}

describe('Property 8: Order history sắp xếp đúng và giới hạn', () => {
  beforeEach(async () => {
    await resetThreeTierSchema(env.DB)
    await cleanTables(env.DB)
  })

  /**
   * **Validates: Requirements 4.7**
   * Order history returns at most 10 items regardless of how many orders exist.
   */
  it('returns at most 10 orders', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20 }), // number of orders to insert
        async (orderCount) => {
          await cleanTables(env.DB)

          const userId = await seedUser(env.DB)
          const productId = await seedProduct(env.DB)

          await seedOrders(env.DB, userId, productId, orderCount)

          // Execute the same query as handleHistory
          const { results } = await env.DB
            .prepare(
              `SELECT o.quantity, o.total_amount, o.created_at, p.name, p.emoji
	               FROM orders o
	               JOIN products p ON p.id = o.product_id
	               WHERE o.user_id = ?
               ORDER BY o.created_at DESC
               LIMIT 10`
            )
            .bind(userId)
            .all<OrderHistoryRow>()

          // Property: results length is at most 10
          expect(results.length).toBeLessThanOrEqual(10)

          // Property: results length is min(orderCount, 10)
          expect(results.length).toBe(Math.min(orderCount, 10))
        }
      ),
      { numRuns: 25 }
    )
  })

  /**
   * **Validates: Requirements 4.7**
   * Order history is sorted by created_at DESC (most recent first).
   * Each item's created_at >= next item's created_at.
   */
  it('orders are sorted by created_at DESC', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 20 }), // need at least 2 orders to verify sorting
        async (orderCount) => {
          await cleanTables(env.DB)

          const userId = await seedUser(env.DB)
          const productId = await seedProduct(env.DB)

          await seedOrders(env.DB, userId, productId, orderCount)

          // Execute the same query as handleHistory
          const { results } = await env.DB
            .prepare(
              `SELECT o.quantity, o.total_amount, o.created_at, p.name, p.emoji
	               FROM orders o
	               JOIN products p ON p.id = o.product_id
	               WHERE o.user_id = ?
               ORDER BY o.created_at DESC
               LIMIT 10`
            )
            .bind(userId)
            .all<OrderHistoryRow>()

          // Property: each item's created_at >= next item's created_at (DESC order)
          for (let i = 0; i < results.length - 1; i++) {
            const current = results[i].created_at
            const next = results[i + 1].created_at
            expect(current >= next).toBe(true)
          }
        }
      ),
      { numRuns: 25 }
    )
  })
})
