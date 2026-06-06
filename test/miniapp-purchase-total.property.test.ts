import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { miniAppApi } from '../src/routes/miniapp-api'
import { _resetRateLimiter } from '../src/bot/rate-limit'
import type { ApiResponse } from '../src/types/api'
import type { PurchaseResultDto } from '../src/types/miniapp'

// Feature: telegram-mini-app, Property 7
/**
 * Property-based test cho endpoint `POST /api/app/purchase` — tổng tiền do Worker
 * tính luôn bằng giá loại sản phẩm nhân số lượng.
 *
 * **Property 7: Tổng tiền bằng giá nhân số lượng**
 * **Validates: Requirements 6.1**
 *
 * Với mọi `price` (1..10_000_000) và `quantity` (1..50) hợp lệ:
 *   - `data.total_amount` trong response = `price × quantity` (tính SERVER-SIDE,
 *     không tin client — Req 6.1).
 *   - Cross-check sổ cái: số dư của người mua sau giao dịch giảm ĐÚNG `price × quantity`.
 *
 * Mount router `miniAppApi` trực tiếp (không phụ thuộc đăng ký ở `src/index.ts`).
 * Router đã áp `miniAppAuth` nên mỗi request cần header `X-Telegram-Init-Data` ký hợp lệ.
 *
 * Endpoint gọi `sendMessage` (qua global fetch) trong `c.executionCtx.waitUntil(...)`
 * sau khi commit. Ta stub `fetch` để không gọi mạng thật và cung cấp executionCtx có
 * `waitUntil`. Lỗi gửi tin KHÔNG ảnh hưởng response (Req 7.5) nên không cần thật.
 *
 * Chạy dưới @cloudflare/vitest-pool-workers nên Web Crypto + D1 thật có sẵn.
 */

const BOT_TOKEN = 'test-bot-token'

// --- Schema tối thiểu cho mua hàng (đồng bộ test/integration.test.ts) ---

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
    success_template TEXT,
    sort_order INTEGER DEFAULT 0,
    is_visible INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    product_type_id INTEGER NOT NULL REFERENCES product_types(id),
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    total_amount INTEGER NOT NULL,
    transaction_id INTEGER,
    status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed','refunded')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL CHECK(type IN ('deposit','purchase','refund','adjustment')),
    amount INTEGER NOT NULL,
    balance_before INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reference_type TEXT,
    reference_id INTEGER,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success','failed','pending')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type_id INTEGER NOT NULL REFERENCES product_types(id),
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','sold','reserved')),
    buyer_id INTEGER REFERENCES users(id),
    order_id INTEGER REFERENCES orders(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sold_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_products_content_type ON products(type_id, content)`,
  `CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS product_type_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_type_id INTEGER NOT NULL REFERENCES product_types(id) ON DELETE CASCADE,
    lang TEXT NOT NULL,
    success_template TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(product_type_id, lang)
  )`,
]

async function applySchema(): Promise<void> {
  for (const stmt of SCHEMA_STATEMENTS) {
    await env.DB.prepare(stmt).run()
  }
}

async function cleanTables(): Promise<void> {
  await env.DB.prepare('DELETE FROM order_items').run()
  await env.DB.prepare('DELETE FROM products').run()
  await env.DB.prepare('DELETE FROM orders').run()
  await env.DB.prepare('DELETE FROM transactions').run()
  await env.DB.prepare('DELETE FROM users').run()
  await env.DB.prepare('DELETE FROM product_types').run()
}

function getEnvBindings() {
  return {
    DB: env.DB,
    BOT_TOKEN,
    BANK_NAME: 'MB',
    BANK_ACCOUNT: '123',
    BANK_OWNER: 'OWNER',
  }
}

/** executionCtx tối thiểu để endpoint gọi `waitUntil` cho tin nhắn bot fire-and-forget. */
function getExecutionCtx() {
  return {
    waitUntil: (_promise: Promise<unknown>) => {},
    passThroughOnException: () => {},
  }
}

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

/**
 * Ký initData với username/first_name KHỚP giá trị đã INSERT vào DB (để upsert của
 * middleware không làm lệch dữ liệu). `auth_date` dùng thời điểm hiện tại để vượt TTL.
 */
async function signBuyerInitData(telegramId: number): Promise<string> {
  const user = { id: telegramId, username: 'buyer', first_name: 'Buyer' }
  const fields: Record<string, string> = {
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
  }
  return signInitData(fields, BOT_TOKEN)
}

// --- Setup ---

beforeEach(async () => {
  await applySchema()
  await cleanTables()
  _resetRateLimiter()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// --- Property 7 ---

describe('Property 7: Tổng tiền bằng giá nhân số lượng', () => {
  /**
   * **Validates: Requirements 6.1**
   * Với mọi price/quantity hợp lệ: `data.total_amount === price × quantity` và số dư
   * người mua giảm đúng `price × quantity` sau giao dịch.
   */
  it('total_amount === price × quantity, and balance decreases by exactly that', async () => {
    // Stub fetch để tin nhắn bot (sendMessage) không gọi mạng thật.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    )

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          price: fc.integer({ min: 1, max: 10_000_000 }),
          quantity: fc.integer({ min: 1, max: 50 }),
          extraBalance: fc.integer({ min: 0, max: 1_000_000 }),
          telegramId: fc.integer({ min: 1, max: 9_999_999_999 }),
        }),
        async ({ price, quantity, extraBalance, telegramId }) => {
          // Cô lập từng iteration: dọn bảng + reset rate-limit (key theo telegram_id).
          await cleanTables()
          _resetRateLimiter()

          const expectedTotal = price * quantity
          const initialBalance = expectedTotal + extraBalance

          // Seed người mua với số dư đủ trả (balance >= price*quantity).
          const now = new Date().toISOString()
          await env.DB.prepare(
            `INSERT INTO users (telegram_id, username, first_name, balance, is_active, last_interaction_at, created_at, updated_at)
             VALUES (?, 'buyer', 'Buyer', ?, 1, ?, ?, ?)`
          )
            .bind(telegramId, initialBalance, now, now, now)
            .run()

          // Seed loại sản phẩm với giá `price`.
          const pt = await env.DB.prepare(
            `INSERT INTO product_types (name, description, price, emoji, is_visible, sort_order, created_at, updated_at)
             VALUES ('Netflix', 'mô tả', ?, '🎬', 1, 0, ?, ?) RETURNING id`
          )
            .bind(price, now, now)
            .first<{ id: number }>()
          const productTypeId = pt!.id

          // Seed đủ tồn kho (>= quantity) các products 'available'.
          for (let i = 0; i < quantity; i++) {
            await env.DB.prepare(
              `INSERT INTO products (type_id, content, status, created_at)
               VALUES (?, ?, 'available', ?)`
            )
              .bind(productTypeId, `acc_${i}`, now)
              .run()
          }

          const raw = await signBuyerInitData(telegramId)
          const res = await miniAppApi.request(
            '/purchase',
            {
              method: 'POST',
              headers: {
                'X-Telegram-Init-Data': raw,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ productTypeId, quantity }),
            },
            getEnvBindings() as any,
            getExecutionCtx() as any
          )

          expect(res.status).toBe(200)
          const body = (await res.json()) as ApiResponse<PurchaseResultDto>
          expect(body.success).toBe(true)
          expect(body.error).toBeNull()

          const data = body.data!
          // Req 6.1: tổng tiền Worker tính = price × quantity.
          expect(data.total_amount).toBe(expectedTotal)
          // Số dư mới trả về phản ánh đúng phép trừ.
          expect(data.new_balance).toBe(initialBalance - expectedTotal)

          // Cross-check sổ cái: số dư DB giảm đúng price × quantity.
          const dbUser = await env.DB.prepare('SELECT balance FROM users WHERE telegram_id = ?')
            .bind(telegramId)
            .first<{ balance: number }>()
          expect(dbUser!.balance).toBe(initialBalance - expectedTotal)
        }
      ),
      { numRuns: 100 }
    )
  })
})
