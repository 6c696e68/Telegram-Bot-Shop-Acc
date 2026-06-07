import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { miniAppApi } from '../src/routes/miniapp-api'
import { formatMoneyFor, buildCurrencyContext } from '../src/utils/format'
import { resolveLang } from '../src/services/user-locale'
import type { ApiResponse } from '../src/types/api'
import type { ProductTypeDetailDto } from '../src/types/miniapp'

// Feature: telegram-mini-app, Task 4.3
/**
 * Example test cho endpoint `GET /api/app/product-types/:id` — chi tiết loại sản phẩm.
 *
 * **Validates: Requirements 5.3, 5.4**
 *
 * Trọng tâm hai hành vi của endpoint chi tiết:
 *   - 404 `not_found` khi `id` không tồn tại, khi loại sản phẩm bị ẩn (`is_visible = 0`),
 *     hoặc khi `id` không phải số nguyên dương (Req 5.4 — loại ẩn hành xử như không tồn tại).
 *   - Khi loại sản phẩm hiển thị: trả 200 với đầy đủ field chi tiết (Req 5.3) và TUYỆT ĐỐI
 *     KHÔNG chứa `success_template` (chỉ dùng server-side để dựng tin nhắn bot, không lộ ra API).
 *
 * Mount router `miniAppApi` trực tiếp (không phụ thuộc đăng ký ở `src/index.ts`). Router đã áp
 * `miniAppAuth` nên mỗi request cần header `X-Telegram-Init-Data` ký hợp lệ. Chạy dưới
 * `@cloudflare/vitest-pool-workers` nên Web Crypto + D1 thật có sẵn.
 */

const BOT_TOKEN = 'test-bot-token'

// Người mua cố định để ký initData hợp lệ (middleware tự upsert vào `users`).
const BUYER_TELEGRAM_ID = 555_000_111

// --- Schema (khớp migration 0001 + 0002 success_template) ---

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
    is_active INTEGER DEFAULT 1,
    last_interaction_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS product_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    price INTEGER NOT NULL CHECK(price > 0),
    emoji TEXT DEFAULT '📦',
    sort_order INTEGER DEFAULT 0,
    is_visible INTEGER DEFAULT 1,
    success_template TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type_id INTEGER NOT NULL REFERENCES product_types(id),
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','sold','reserved')),
    buyer_id INTEGER REFERENCES users(id),
    order_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sold_at TEXT
  )`,
]

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

/**
 * Tính chuỗi hiển thị tiền y hệt endpoint (currency-display-usd, task 4.1):
 * lang = resolveLang(DB, user); ctx = buildCurrencyContext(DB, { lang, region });
 * display = formatMoneyFor(amount, ctx). Người mua trong test không set region
 * (region = null) và không set language; system_config rỗng (không default_language,
 * không exchange_rate_usdt_vnd) → resolveLang lùi BASE_FALLBACK_LANG, ctx.rate = null,
 * nhánh VND áp dụng. Derive qua helper để test vẫn đúng nếu config đổi về sau.
 */
async function expectedMoneyDisplay(amountVnd: number): Promise<string> {
  const lang = await resolveLang(env.DB, { language: null })
  const ctx = await buildCurrencyContext(env.DB, { lang, region: null })
  return formatMoneyFor(amountVnd, ctx)
}

/** Gọi GET /product-types/:id với initData hợp lệ. */
async function getDetail(id: string | number): Promise<Response> {
  const raw = await buyerInitData()
  return miniAppApi.request(
    `/product-types/${id}`,
    { headers: { 'X-Telegram-Init-Data': raw } },
    getEnvBindings() as any
  )
}

interface SeedProductType {
  name: string
  description: string | null
  price: number
  isVisible: boolean
  successTemplate: string | null
  availableStock: number
}

/** Seed một product_type (+ N products available) và trả về id vừa tạo. */
async function seedProductType(setup: SeedProductType): Promise<number> {
  const inserted = await env.DB.prepare(
    `INSERT INTO product_types (name, description, price, emoji, sort_order, is_visible, success_template)
     VALUES (?, ?, ?, '🎬', 0, ?, ?)
     RETURNING id`
  )
    .bind(
      setup.name,
      setup.description,
      setup.price,
      setup.isVisible ? 1 : 0,
      setup.successTemplate
    )
    .first<{ id: number }>()

  const typeId = inserted!.id
  for (let i = 0; i < setup.availableStock; i++) {
    await env.DB.prepare(
      `INSERT INTO products (type_id, content, status) VALUES (?, ?, 'available')`
    )
      .bind(typeId, `${setup.name}-acc-${i}`)
      .run()
  }
  return typeId
}

// --- Setup: tạo bảng + dọn sạch trước mỗi test ---

beforeEach(async () => {
  for (const stmt of SCHEMA_STATEMENTS) {
    await env.DB.prepare(stmt).run()
  }
  await env.DB.prepare('DELETE FROM products').run()
  await env.DB.prepare('DELETE FROM product_types').run()
  await env.DB.prepare('DELETE FROM users').run()
})

describe('GET /api/app/product-types/:id — chi tiết loại sản phẩm (Req 5.3, 5.4)', () => {
  it('trả 404 not_found khi id không tồn tại', async () => {
    const res = await getDetail(999_999)

    expect(res.status).toBe(404)
    const body = (await res.json()) as ApiResponse<null>
    expect(body).toEqual({ success: false, data: null, error: 'not_found' })
  })

  it('trả 404 not_found khi product_type bị ẩn (is_visible = 0)', async () => {
    const hiddenId = await seedProductType({
      name: 'Hidden',
      description: 'Loại ẩn',
      price: 50_000,
      isVisible: false,
      successTemplate: 'tpl ẩn',
      availableStock: 5,
    })

    const res = await getDetail(hiddenId)

    // Loại ẩn hành xử như không tồn tại (Req 5.4) — không lộ sự tồn tại.
    expect(res.status).toBe(404)
    const body = (await res.json()) as ApiResponse<null>
    expect(body).toEqual({ success: false, data: null, error: 'not_found' })
  })

  it('trả 404 not_found khi id không phải số nguyên dương', async () => {
    const res = await getDetail('abc')

    expect(res.status).toBe(404)
    const body = (await res.json()) as ApiResponse<null>
    expect(body).toEqual({ success: false, data: null, error: 'not_found' })
  })

  it('trả 200 với chi tiết đầy đủ và KHÔNG chứa success_template khi product_type hiển thị', async () => {
    const visibleId = await seedProductType({
      name: 'Netflix',
      description: 'Tài khoản xem phim 1 tháng',
      price: 50_000,
      isVisible: true,
      // CỐ TÌNH seed success_template khác null để chứng minh endpoint loại bỏ nó.
      successTemplate: 'Tài khoản: [content] | [name] [emoji]',
      availableStock: 12,
    })

    const res = await getDetail(visibleId)

    expect(res.status).toBe(200)
    const body = (await res.json()) as ApiResponse<ProductTypeDetailDto>
    expect(body.success).toBe(true)
    expect(body.error).toBeNull()

    const data = body.data!
    // Đầy đủ field chi tiết (Req 5.3).
    expect(data.id).toBe(visibleId)
    expect(data.name).toBe('Netflix')
    expect(data.description).toBe('Tài khoản xem phim 1 tháng')
    expect(data.price).toBe(50_000)
    expect(data.price_display).toBe(await expectedMoneyDisplay(50_000))
    expect(data.stock).toBe(12)
    expect(data.in_stock).toBe(true)
    expect(typeof data.max_quantity).toBe('number')
    expect(data.max_quantity).toBeGreaterThan(0)

    // CRITICAL: success_template là server-side only, không bao giờ lộ ra API.
    expect(data).not.toHaveProperty('success_template')
  })
})
