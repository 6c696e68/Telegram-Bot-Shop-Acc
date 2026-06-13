import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { miniAppApi } from '../src/routes/miniapp-api'
import type { ApiResponse } from '../src/types/api'
import type { OrderListItemDto } from '../src/types/miniapp'
import {
  resetThreeTierSchema,
  seedCategory,
  seedPricedProduct,
} from './helpers/three-tier-schema'

// Feature: telegram-mini-app, Task 8.3
/**
 * Example test cho endpoint `GET /api/app/orders` — trạng thái trống lịch sử đơn hàng.
 *
 * **Validates: Requirements 11.4**
 *
 * Trọng tâm: khi người mua CHƯA có đơn hàng nào, endpoint phải trả mảng rỗng `[]`
 * (không null, không lỗi) kèm `meta.total = 0` để frontend hiển thị trạng thái trống
 * (Req 11.4). Bổ sung một positive control: seed đúng 1 đơn cho cùng người mua →
 * endpoint trả mảng đúng 1 phần tử, chứng minh `[]` ở case trống là do KHÔNG có dữ liệu
 * chứ không phải endpoint luôn trả rỗng.
 *
 * Mount router `miniAppApi` trực tiếp (không phụ thuộc đăng ký ở `src/index.ts`). Router đã
 * áp `miniAppAuth` nên mỗi request cần header `X-Telegram-Init-Data` ký hợp lệ. Chạy dưới
 * `@cloudflare/vitest-pool-workers` nên Web Crypto + D1 thật có sẵn.
 */

const BOT_TOKEN = 'test-bot-token'

// Người mua cố định để ký initData hợp lệ (middleware tự upsert vào `users`).
const BUYER_TELEGRAM_ID = 770_000_222

// --- Helper: ký initData hợp lệ (tái hiện thuật toán Telegram WebApp) ---

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

/**
 * Ký một tập field initData và trả chuỗi initData thô (URLSearchParams) kèm `hash` hợp lệ.
 * data_check_string = các cặp "key=value" (trừ `hash`), sort tăng dần, nối bằng "\n".
 */
async function signInitData(
  fields: Record<string, string>,
  botToken: string
): Promise<string> {
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

/** initData hợp lệ cho người mua cố định, auth_date hiện tại để vượt TTL. */
async function buyerInitData(): Promise<string> {
  const fields: Record<string, string> = {
    user: JSON.stringify({ id: BUYER_TELEGRAM_ID, username: 'buyer', first_name: 'An' }),
    auth_date: String(Math.floor(Date.now() / 1000)),
  }
  return signInitData(fields, BOT_TOKEN)
}

function getEnvBindings() {
  return { DB: env.DB, BOT_TOKEN }
}

/** Gọi GET /orders với initData hợp lệ. */
async function getOrders(): Promise<Response> {
  const raw = await buyerInitData()
  return miniAppApi.request(
    '/orders',
    { headers: { 'X-Telegram-Init-Data': raw } },
    getEnvBindings() as any
  )
}

/**
 * Bảo đảm người mua cố định tồn tại trong `users` và trả về `users.id` nội bộ.
 * Khớp quy tắc định danh qua `telegram_id` (KHÔNG dùng telegram_id làm users.id).
 * Middleware `miniAppAuth` upsert ON CONFLICT(telegram_id) nên id giữ nguyên giữa các request.
 */
async function ensureBuyer(): Promise<number> {
  await env.DB.prepare(
    `INSERT INTO users (telegram_id, username, first_name, balance)
     VALUES (?, 'buyer', 'An', 0)
     ON CONFLICT(telegram_id) DO NOTHING`
  )
    .bind(BUYER_TELEGRAM_ID)
    .run()

  const row = await env.DB.prepare('SELECT id FROM users WHERE telegram_id = ?')
    .bind(BUYER_TELEGRAM_ID)
    .first<{ id: number }>()
  return row!.id
}

// --- Setup: tạo bảng + dọn sạch trước mỗi test ---

beforeEach(async () => {
  await resetThreeTierSchema(env.DB)
})

describe('GET /api/app/orders — trạng thái trống lịch sử (Req 11.4)', () => {
  it('người mua chưa có đơn → trả mảng rỗng [] với meta.total = 0', async () => {
    const res = await getOrders()

    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiResponse<OrderListItemDto[]>

    expect(body.success).toBe(true)
    expect(body.error).toBeNull()
    // Mảng rỗng thật sự (không null) — frontend dựa vào đây để hiển thị trạng thái trống (Req 11.4).
    expect(Array.isArray(body.data)).toBe(true)
    expect(body.data).toEqual([])
    // meta phản ánh tổng số đơn = 0.
    expect(body.meta?.total).toBe(0)
  })

  it('positive control: seed 1 đơn cho người mua → trả mảng đúng 1 phần tử', async () => {
    const userId = await ensureBuyer()

    const categoryId = await seedCategory(env.DB, 'Streaming')
    const productId = await seedPricedProduct(env.DB, {
      categoryId,
      name: 'Netflix',
      description: 'Tài khoản xem phim',
      price: 50_000,
    })

    await env.DB.prepare(
      `INSERT INTO orders (user_id, product_id, quantity, total_amount, status)
       VALUES (?, ?, 2, 100000, 'completed')`
    )
      .bind(userId, productId)
      .run()

    const res = await getOrders()

    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiResponse<OrderListItemDto[]>

    expect(body.success).toBe(true)
    expect(body.error).toBeNull()
    expect(body.data).toHaveLength(1)
    expect(body.data![0].product_name).toBe('Netflix')
    expect(body.data![0].quantity).toBe(2)
    expect(body.data![0].total_amount).toBe(100000)
    expect(body.meta?.total).toBe(1)
  })
})
