import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { miniAppApi } from '../src/routes/miniapp-api'
import {
  cleanThreeTierTables,
  resetThreeTierSchema,
  seedCategory,
  seedPricedProduct,
} from './helpers/three-tier-schema'

// Feature: telegram-mini-app, Property 16
/**
 * Property-based test cho cô lập dữ liệu theo người mua trên `/orders` và `/orders/:id`.
 *
 * **Property 16: Cô lập dữ liệu theo người mua**
 * **Validates: Requirements 11.1, 11.2, 11.3, 15.3**
 *
 * - Req 11.1: `GET /orders` chỉ trả đơn của người mua hiện tại (lọc theo `telegram_id`),
 *   sắp xếp `created_at` giảm dần.
 * - Req 11.2/11.3: đơn mang đúng thông tin sản phẩm; chi tiết đơn trả `contents`.
 * - Req 15.3: `GET /orders/:id` của đơn người khác → 404 và TUYỆT ĐỐI không lộ
 *   `products.content` của người mua khác.
 *
 * Chiến lược: seed HAI người mua phân biệt (buyerA, buyerB), mỗi người có tập đơn riêng
 * (orders + order_items + product_items với content đã biết) trên cùng một Product.
 * `created_at` set tường minh tăng dần theo chỉ số đơn để khẳng định DESC ổn định (không flaky).
 *
 * Mount `miniAppApi` trực tiếp (đã gắn `miniAppApi.use('/*', miniAppAuth)`), ký initData
 * per-buyer với `auth_date` tươi và `username`/`first_name` khớp bản ghi đã seed để tránh
 * upsert drift. Chạy dưới `@cloudflare/vitest-pool-workers` nên Web Crypto + D1 thật có sẵn.
 */

const BOT_TOKEN = 'test-bot-token'

// telegram_id cố định, phân biệt cho hai người mua.
const BUYER_A = { telegramId: 100_001, username: 'buyerA', firstName: 'BuyerA' }
const BUYER_B = { telegramId: 100_002, username: 'buyerB', firstName: 'BuyerB' }

async function cleanTables(db: D1Database) {
  await cleanThreeTierTables(db)
}

function getEnvBindings() {
  return { DB: env.DB, BOT_TOKEN }
}

function getExecutionCtx() {
  return {
    waitUntil: (_p: Promise<unknown>) => {},
    passThroughOnException: () => {},
  }
}

// --- Helper: ký initData hợp lệ (tái hiện thuật toán Telegram WebApp) ---

const encoder = new TextEncoder()

async function hmacSha256(keyBytes: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  return crypto.subtle.sign('HMAC', key, encoder.encode(message))
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Ký initData và trả chuỗi thô (URLSearchParams) kèm `hash` hợp lệ.
 * data_check_string = các cặp "key=value" (trừ `hash`), sort tăng dần, nối bằng "\n".
 */
async function signInitData(fields: Record<string, string>, botToken: string): Promise<string> {
  const pairs = Object.keys(fields)
    .filter((k) => k !== 'hash')
    .map((k) => `${k}=${fields[k]}`)
  pairs.sort()
  const dataCheckString = pairs.join('\n')

  const secretKey = await hmacSha256(encoder.encode('WebAppData'), botToken)
  const hash = toHex(await hmacSha256(secretKey, dataCheckString))

  const params = new URLSearchParams()
  for (const k of Object.keys(fields)) params.append(k, fields[k])
  params.append('hash', hash)
  return params.toString()
}

/** Ký initData cho một người mua với `auth_date` tươi (trong TTL) và username/first_name khớp seed. */
async function signBuyerInitData(buyer: {
  telegramId: number
  username: string
  firstName: string
}): Promise<string> {
  const user = { id: buyer.telegramId, username: buyer.username, first_name: buyer.firstName }
  const fields = {
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
  }
  return signInitData(fields, BOT_TOKEN)
}

// --- Helper seed ---

async function seedUser(
  db: D1Database,
  buyer: { telegramId: number; username: string; firstName: string }
): Promise<number> {
  await db
    .prepare(
      "INSERT INTO users (telegram_id, username, first_name, balance, created_at, updated_at) VALUES (?, ?, ?, 0, datetime('now'), datetime('now'))"
    )
    .bind(buyer.telegramId, buyer.username, buyer.firstName)
    .run()
  const row = await db
    .prepare('SELECT id FROM users WHERE telegram_id = ?')
    .bind(buyer.telegramId)
    .first<{ id: number }>()
  return row!.id
}

async function seedProduct(db: D1Database): Promise<number> {
  const categoryId = await seedCategory(db, 'Streaming')
  return seedPricedProduct(db, {
    categoryId,
    name: 'Netflix',
    price: 50_000,
  })
}

/** Seed một đơn (product_item + order + order_item) cho user, trả orderId. */
async function seedOrder(
  db: D1Database,
  userId: number,
  productId: number,
  content: string,
  createdAt: string
): Promise<number> {
  const prod = await db
    .prepare(
      "INSERT INTO product_items (product_id, content, status, buyer_id, created_at, sold_at) VALUES (?, ?, 'sold', ?, datetime('now'), datetime('now')) RETURNING id"
    )
    .bind(productId, content, userId)
    .first<{ id: number }>()

  const order = await db
    .prepare(
      "INSERT INTO orders (user_id, product_id, quantity, total_amount, status, created_at) VALUES (?, ?, 1, 50000, 'completed', ?) RETURNING id"
    )
    .bind(userId, productId, createdAt)
    .first<{ id: number }>()

  await db
    .prepare("INSERT INTO order_items (order_id, product_item_id, created_at) VALUES (?, ?, datetime('now'))")
    .bind(order!.id, prod!.id)
    .run()

  await db.prepare('UPDATE product_items SET order_id = ? WHERE id = ?').bind(order!.id, prod!.id).run()

  return order!.id
}

// `created_at` ISO tăng dần theo chỉ số → sort chuỗi = sort thời gian (ổn định cho DESC).
const BASE_EPOCH_MS = Date.UTC(2024, 0, 1, 0, 0, 0)
function createdAtForIndex(i: number): string {
  return new Date(BASE_EPOCH_MS + i * 1000).toISOString()
}

interface OrderListResponse {
  success: boolean
  data: Array<{ id: number; created_at: string }>
  error: string | null
}

interface OrderDetailResponse {
  success: boolean
  data: { id: number; contents: string[] } | null
  error: string | null
}

beforeEach(async () => {
  await resetThreeTierSchema(env.DB)
  await cleanTables(env.DB)
})

describe('Property 16: Cô lập dữ liệu theo người mua', () => {
  /**
   * **Validates: Requirements 11.1, 11.2, 11.3, 15.3**
   *
   * Với mọi tập đơn phân bố giữa buyerA và buyerB:
   *  - GET /orders (buyerA) → chỉ chứa đơn của buyerA (không có đơn buyerB), DESC theo created_at.
   *  - GET /orders/:id (đơn buyerB, gọi bởi buyerA) → 404 và KHÔNG lộ content của buyerB.
   *  - GET /orders/:id (đơn buyerB, gọi bởi buyerB) → 200, content có mặt (positive control).
   */
  it('orders are isolated per buyer; cross-buyer detail returns 404 without leaking content', async () => {
    await fc.assert(
      fc.asyncProperty(
        // 'A'/'B' assignment cho mỗi đơn; bảo đảm tồn tại ít nhất 1 đơn mỗi người mua.
        fc
          .array(fc.constantFrom<'A' | 'B'>('A', 'B'), { minLength: 2, maxLength: 8 })
          .map((arr) => {
            if (!arr.includes('A')) arr[0] = 'A'
            if (!arr.includes('B')) arr[arr.length - 1] = 'B'
            return arr
          }),
        async (owners) => {
          await cleanTables(env.DB)

          const userIdA = await seedUser(env.DB, BUYER_A)
          const userIdB = await seedUser(env.DB, BUYER_B)
          const productId = await seedProduct(env.DB)

          const aOrderIds = new Set<number>()
          const bOrderIds = new Set<number>()
          const contentByOrderId = new Map<number, string>()

          for (let i = 0; i < owners.length; i++) {
            const isA = owners[i] === 'A'
            const userId = isA ? userIdA : userIdB
            const content = `acc-${owners[i]}-${i}:secret-${i}`
	            const orderId = await seedOrder(
	              env.DB,
	              userId,
	              productId,
	              content,
	              createdAtForIndex(i)
	            )
            contentByOrderId.set(orderId, content)
            ;(isA ? aOrderIds : bOrderIds).add(orderId)
          }

          const initDataA = await signBuyerInitData(BUYER_A)
          const initDataB = await signBuyerInitData(BUYER_B)

          // --- GET /orders as buyerA: chỉ đơn của buyerA, DESC theo created_at (Req 11.1) ---
          const listRes = await miniAppApi.request(
            '/orders',
            { headers: { 'X-Telegram-Init-Data': initDataA } },
            getEnvBindings() as any,
            getExecutionCtx() as any
          )
          expect(listRes.status).toBe(200)
          const listBody = (await listRes.json()) as OrderListResponse
          expect(listBody.success).toBe(true)

          // Mọi đơn trả về đều thuộc buyerA; không có đơn nào của buyerB.
          for (const item of listBody.data) {
            expect(aOrderIds.has(item.id)).toBe(true)
            expect(bOrderIds.has(item.id)).toBe(false)
          }
          // Trả đủ và đúng tập đơn của buyerA (≤ 8 đơn nên nằm trọn trong 1 trang).
          const returnedIds = new Set(listBody.data.map((o) => o.id))
          expect(returnedIds).toEqual(aOrderIds)

          // created_at không tăng dần (DESC ổn định).
          for (let i = 1; i < listBody.data.length; i++) {
            expect(listBody.data[i - 1].created_at >= listBody.data[i].created_at).toBe(true)
          }

          // --- GET /orders/:id của buyerB, gọi bởi buyerA → 404 + không lộ content (Req 15.3) ---
          const victimOrderId = [...bOrderIds][0]
          const victimContent = contentByOrderId.get(victimOrderId)!

          const crossRes = await miniAppApi.request(
            `/orders/${victimOrderId}`,
            { headers: { 'X-Telegram-Init-Data': initDataA } },
            getEnvBindings() as any,
            getExecutionCtx() as any
          )
          expect(crossRes.status).toBe(404)
          const crossText = await crossRes.text()
          expect(crossText).not.toContain(victimContent)
          const crossBody = JSON.parse(crossText) as OrderDetailResponse
          expect(crossBody.success).toBe(false)
          expect(crossBody.error).toBe('not_found')
          expect(crossBody.data).toBeNull()

          // --- Positive control: chủ sở hữu (buyerB) xem được content của chính đơn đó (Req 11.3) ---
          const ownRes = await miniAppApi.request(
            `/orders/${victimOrderId}`,
            { headers: { 'X-Telegram-Init-Data': initDataB } },
            getEnvBindings() as any,
            getExecutionCtx() as any
          )
          expect(ownRes.status).toBe(200)
          const ownBody = (await ownRes.json()) as OrderDetailResponse
          expect(ownBody.success).toBe(true)
          expect(ownBody.data!.id).toBe(victimOrderId)
          expect(ownBody.data!.contents).toContain(victimContent)
        }
      ),
      { numRuns: 100 }
    )
  })
})
