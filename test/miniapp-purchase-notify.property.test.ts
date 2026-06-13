import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { miniAppApi } from '../src/routes/miniapp-api'
import { _resetRateLimiter } from '../src/bot/rate-limit'
import {
  cleanThreeTierTables,
  resetThreeTierSchema,
  seedCategory,
  seedPricedProduct,
} from './helpers/three-tier-schema'

// Feature: telegram-mini-app, Property 12
/**
 * Property-based test cho `POST /api/app/purchase` — lỗi gửi tin nhắn bot KHÔNG rollback.
 *
 * **Property 12: Lỗi gửi tin nhắn bot không rollback giao dịch đã commit**
 * **Validates: Requirements 7.5**
 *
 * Tin nhắn bot được gửi fire-and-forget SAU commit qua
 * `c.executionCtx.waitUntil(sendMessage(...).catch(log))`. Vì vậy một lỗi khi gửi tin
 * (Telegram API down) KHÔNG được phép:
 *   - làm hỏng HTTP response (vẫn phải 200 + success), và
   *   - thay đổi trạng thái đã commit trong D1 (balance, orders, product_items, order_items, transactions).
 *
 * Chiến lược so sánh xác định: chạy CÙNG một kịch bản mua hàng hai lần trên cùng một
 * seed DB giống hệt nhau:
 *   (A) `fetch` (Telegram API) RESOLVE 200 → notify thành công, chụp lại trạng thái DB.
 *   (B) reset DB về seed y hệt, `fetch` THROW → notify thất bại, chụp lại trạng thái DB.
 * Khẳng định: ở (B) response vẫn 200 + success, và trạng thái DB (chuẩn hoá, bỏ id/timestamp
 * vốn tự tăng/đổi giữa hai lần chạy) GIỐNG HỆT (A) — lỗi gửi tin không đổi gì cả.
 *
 * Chạy dưới @cloudflare/vitest-pool-workers nên Web Crypto + D1 thật có sẵn. Gọi thẳng
 * `miniAppApi.request('/purchase', ...)` với env bindings (arg 3) và executionCtx (arg 4)
 * có `waitUntil` thực sự await promise để `.catch` của notify được chạy trước khi kiểm tra.
 */

const BOT_TOKEN = 'test-bot-token'
const USERNAME = 'buyer'
const FIRST_NAME = 'Buyer'

/** Dọn sạch mọi bảng liên quan luồng mua hàng (thứ tự tôn trọng FK). */
async function cleanTables(db: D1Database) {
  await cleanThreeTierTables(db)
}

function getEnvBindings() {
  return { DB: env.DB, BOT_TOKEN }
}

// --- executionCtx thật: waitUntil thu các promise để await (notify .catch chạy xong) ---

let pendingWaits: Promise<unknown>[] = []

function makeExecutionCtx() {
  return {
    waitUntil: (p: Promise<unknown>) => {
      // swallow: notify đã có .catch ở controller; bọc thêm để không gây unhandled rejection.
      pendingWaits.push(Promise.resolve(p).catch(() => {}))
    },
    passThroughOnException: () => {},
  }
}

// --- Helper: ký initData hợp lệ (thuật toán Telegram WebApp) ---

const encoder = new TextEncoder()

async function hmacSha256(
  keyBytes: ArrayBuffer | Uint8Array,
  message: string
): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return crypto.subtle.sign('HMAC', key, encoder.encode(message))
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

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

/** initData tươi (auth_date = now) cho `telegramId`, username/first_name khớp seed (tránh drift). */
async function freshInitData(telegramId: number): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  const user = JSON.stringify({ id: telegramId, username: USERNAME, first_name: FIRST_NAME })
  return signInitData({ user, auth_date: String(nowSec) }, BOT_TOKEN)
}

// --- Kịch bản mua hàng ---

interface Scenario {
  price: number
  quantity: number
  extraStock: number // số product available dư ra ngoài quantity
  slack: number // số dư dư ra ngoài tổng tiền (đảm bảo đủ tiền)
}

/**
   * Seed DB về trạng thái giống hệt cho `telegramId`: 1 user (balance đủ), 1 category,
   * 1 product hiển thị và (quantity + extraStock) product_item available. Trả về `productId`.
   */
async function seed(db: D1Database, telegramId: number, s: Scenario): Promise<number> {
  await cleanTables(db)

  const balance = s.price * s.quantity + s.slack
  await db
    .prepare(
      `INSERT INTO users (telegram_id, username, first_name, balance, is_active, last_interaction_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'), datetime('now'))`
    )
    .bind(telegramId, USERNAME, FIRST_NAME, balance)
    .run()

  const categoryId = await seedCategory(db, 'Streaming')
  const productId = await seedPricedProduct(db, {
    categoryId,
    name: 'Netflix',
    description: 'Tai khoan phim',
    price: s.price,
  })
  await db.prepare(
    `INSERT INTO product_type_templates (product_type_id, lang, success_template)
     VALUES (?, 'vi', ?)`
  )
    .bind(productId, 'Cam on [name] x [quantity] - con [balance]')
    .run()

  const totalStock = s.quantity + s.extraStock
  for (let i = 1; i <= totalStock; i++) {
    await db.prepare(
      `INSERT INTO product_items (product_id, content, status, created_at)
       VALUES (?, ?, 'available', datetime('now'))`
    )
      .bind(productId, `acc_${i}@mail.test:pw${i}`)
      .run()
  }

  return productId
}

/**
 * Trạng thái DB chuẩn hoá — CHỈ giữ các trường nghiệp vụ bất biến, LOẠI BỎ id & timestamp
 * (chúng tự tăng/đổi giữa hai lần chạy do AUTOINCREMENT + datetime('now')) để so sánh xác định.
 */
async function captureState(db: D1Database, telegramId: number) {
  const u = await db
    .prepare('SELECT id, balance FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<{ id: number; balance: number }>()
  const userId = u!.id

  const orders = (
    await db
      .prepare(
        'SELECT quantity, total_amount, status FROM orders WHERE user_id = ? ORDER BY quantity ASC, total_amount ASC'
      )
      .bind(userId)
      .all<{ quantity: number; total_amount: number; status: string }>()
  ).results

  const sold = (
    await db
      .prepare("SELECT content, status FROM product_items WHERE buyer_id = ? ORDER BY content ASC")
      .bind(userId)
      .all<{ content: string; status: string }>()
  ).results

  const available = (
    await db
      .prepare("SELECT content FROM product_items WHERE status = 'available' ORDER BY content ASC")
      .all<{ content: string }>()
  ).results.map((r) => r.content)

  const orderItems = await db
    .prepare(
      'SELECT COUNT(*) AS c FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.user_id = ?'
    )
    .bind(userId)
    .first<{ c: number }>()

  const txs = (
    await db
      .prepare(
        'SELECT type, amount, balance_before, balance_after, status FROM transactions WHERE user_id = ? ORDER BY amount ASC, balance_after ASC'
      )
      .bind(userId)
      .all<{
        type: string
        amount: number
        balance_before: number
        balance_after: number
        status: string
      }>()
  ).results

  return {
    balance: u!.balance,
    orders,
    sold,
    available,
    orderItemsCount: orderItems!.c,
    txs,
  }
}

/** Gọi POST /purchase và await mọi waitUntil để notify (.catch) chạy xong. */
async function doPurchase(telegramId: number, productId: number, quantity: number) {
  const raw = await freshInitData(telegramId)
  pendingWaits = []
  const res = await miniAppApi.request(
    '/purchase',
    {
      method: 'POST',
      headers: { 'X-Telegram-Init-Data': raw, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, quantity }),
    },
    getEnvBindings() as unknown as Record<string, unknown>,
    makeExecutionCtx() as unknown as ExecutionContext
  )
  await Promise.all(pendingWaits)
  return res
}

/** Stub Telegram fetch thành công (resolve 200). */
function stubFetchOk() {
  const fn = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  vi.stubGlobal('fetch', fn)
  return fn
}

/** Stub Telegram fetch lỗi (reject) — mô phỏng Telegram API down. */
function stubFetchThrow() {
  const fn = vi.fn(async () => {
    throw new Error('telegram down')
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

/**
 * Chạy kịch bản hai lần (notify OK rồi notify lỗi) trên seed giống hệt và so sánh trạng thái DB.
 * Mỗi lần gọi dùng một `telegramId` riêng để không tích luỹ rate-limit giữa các iteration.
 */
async function runAndCompare(telegramId: number, s: Scenario) {
  const db = env.DB

  // (A) notify THÀNH CÔNG → chụp trạng thái chuẩn.
  await seed(db, telegramId, s)
  const fetchOk = stubFetchOk()
  const resA = await doPurchase(telegramId, await currentProductId(db), s.quantity)
  expect(resA.status).toBe(200)
  const bodyA = (await resA.json()) as { success: boolean }
  expect(bodyA.success).toBe(true)
  expect(fetchOk).toHaveBeenCalled() // notify đã gửi (thành công)
  const stateA = await captureState(db, telegramId)

  // (B) reset seed y hệt, notify LỖI → trạng thái DB phải giống hệt (A).
  await seed(db, telegramId, s)
  const fetchThrow = stubFetchThrow()
  const resB = await doPurchase(telegramId, await currentProductId(db), s.quantity)
  expect(resB.status).toBe(200) // Req 7.5: lỗi gửi tin KHÔNG ảnh hưởng response
  const bodyB = (await resB.json()) as { success: boolean }
  expect(bodyB.success).toBe(true)
  expect(fetchThrow).toHaveBeenCalled() // notify đã được gọi và ném lỗi
  const stateB = await captureState(db, telegramId)

  // Req 7.5: giao dịch đã commit không bị rollback — state hệt như khi gửi tin thành công.
  expect(stateB).toEqual(stateA)
}

/** Lấy id product vừa seed (chỉ có đúng 1 product trong DB). */
async function currentProductId(db: D1Database): Promise<number> {
  const product = await db.prepare("SELECT id FROM products WHERE name = 'Netflix'").first<{ id: number }>()
  return product!.id
}

// --- telegram_id duy nhất mỗi iteration (tránh rate-limit key tích luỹ qua nhiều lần chạy) ---

let telegramSeq = 0
const BASE_TELEGRAM_ID = 700_000_000

function nextTelegramId(): number {
  return BASE_TELEGRAM_ID + telegramSeq++
}

const arbScenario: fc.Arbitrary<Scenario> = fc.record({
  price: fc.integer({ min: 1_000, max: 100_000 }),
  quantity: fc.integer({ min: 1, max: 8 }),
  extraStock: fc.integer({ min: 0, max: 3 }),
  slack: fc.integer({ min: 0, max: 500_000 }),
})

describe('Property 12: Lỗi gửi tin nhắn bot không rollback giao dịch mua hàng đã commit', () => {
  beforeEach(async () => {
    await resetThreeTierSchema(env.DB)
    await cleanTables(env.DB)
    _resetRateLimiter()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /**
   * **Validates: Requirements 7.5**
   * Với mọi (price, quantity, stock, balance đủ): notify lỗi → response 200 + success và
   * trạng thái DB (balance, orders, product_items, order_items, transactions) giống hệt notify OK.
   */
  it('notify failure leaves committed state identical to notify success (200 + success)', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (s) => {
        await runAndCompare(nextTelegramId(), s)
      }),
      { numRuns: 30 }
    )
  })

  /**
   * **Validates: Requirements 7.5** (ví dụ xác định, dễ debug)
   * Kịch bản cố định: mua 2/5, số dư dư — notify lỗi không đổi trạng thái so với notify OK.
   */
  it('example: purchase 2 of 5 with sufficient balance is unaffected by notify failure', async () => {
    await runAndCompare(nextTelegramId(), {
      price: 50_000,
      quantity: 2,
      extraStock: 3,
      slack: 400_000,
    })
  })
})
