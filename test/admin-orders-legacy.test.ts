import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { SignJWT } from 'jose'
import { app } from '../src/index'
import {
  resetThreeTierSchema,
  seedCategory,
  seedPricedProduct,
  seedProductItems,
} from './helpers/three-tier-schema'

const JWT_SECRET = 'test-jwt-secret'

function bindings() {
  return {
    DB: env.DB,
    JWT_SECRET,
    BOT_TOKEN: 'test-bot-token',
    ADMIN_IDS: '1',
  }
}

function executionCtx() {
  return {
    waitUntil: (_promise: Promise<unknown>) => {},
    passThroughOnException: () => {},
  }
}

async function jwt(): Promise<string> {
  return new SignJWT({ username: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('1')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET))
}

async function apiGet(path: string): Promise<Response> {
  return app.request(
    path,
    { headers: { Authorization: `Bearer ${await jwt()}` } },
    bindings() as any,
    executionCtx() as any
  )
}

beforeEach(async () => {
  await resetThreeTierSchema(env.DB)
})

describe('Admin orders legacy lookup', () => {
  it('returns migrated order product and product_item details through the new schema', async () => {
    const user = await env.DB
      .prepare('INSERT INTO users (telegram_id, username, first_name, balance) VALUES (?, ?, ?, ?) RETURNING id')
      .bind(123456, 'buyer', 'Buyer', 50_000)
      .first<{ id: number }>()
    const categoryId = await seedCategory(env.DB, 'Legacy category')
    const productId = await seedPricedProduct(env.DB, {
      categoryId,
      name: 'Legacy product',
      price: 25_000,
    })
    const [itemId] = await seedProductItems(env.DB, productId, 1, 'available')
    const order = await env.DB
      .prepare(
        `INSERT INTO orders (user_id, product_id, quantity, total_amount, status)
         VALUES (?, ?, 1, 25000, 'completed')
         RETURNING id`
      )
      .bind(user!.id, productId)
      .first<{ id: number }>()
    await env.DB
      .prepare("UPDATE product_items SET status = 'sold', buyer_id = ?, order_id = ?, sold_at = datetime('now') WHERE id = ?")
      .bind(user!.id, order!.id, itemId)
      .run()
    await env.DB
      .prepare('INSERT INTO order_items (order_id, product_item_id) VALUES (?, ?)')
      .bind(order!.id, itemId)
      .run()

    const listRes = await apiGet('/api/admin/orders')
    expect(listRes.status).toBe(200)
    const listJson = (await listRes.json()) as any
    expect(listJson.success).toBe(true)
    expect(listJson.data[0]).toMatchObject({
      id: order!.id,
      product_id: productId,
      product_name: 'Legacy product',
      product_type_id: categoryId,
      product_type_name: 'Legacy category',
      unit_price: 25_000,
      telegram_id: 123456,
    })

    const detailRes = await apiGet(`/api/admin/orders/${order!.id}`)
    expect(detailRes.status).toBe(200)
    const detailJson = (await detailRes.json()) as any
    expect(detailJson.success).toBe(true)
    expect(detailJson.data.product_id).toBe(productId)
    expect(detailJson.data.items).toHaveLength(1)
    expect(detailJson.data.items[0]).toMatchObject({
      product_item_id: itemId,
      product_status: 'sold',
    })
  })
})
