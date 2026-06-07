import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { miniAppApi } from '../src/routes/miniapp-api'
import { formatMoneyFor, buildCurrencyContext } from '../src/utils/format'
import { resolveLang } from '../src/services/user-locale'
import type { ApiResponse } from '../src/types/api'
import type { ProductTypeListItemDto } from '../src/types/miniapp'

// Feature: telegram-mini-app, Property 6
/**
 * Property-based test cho endpoint `GET /api/app/product-types` — danh mục loại sản phẩm.
 *
 * **Property 6: Danh mục lọc theo hiển thị, sắp xếp và đếm tồn kho đúng**
 * **Validates: Requirements 5.1, 5.2, 5.4**
 *
 * Với mọi tập `product_types` được seed (mỗi loại có cờ hiển thị, sort_order, tên,
 * giá, số `products` `available`/`sold`), một người mua đã xác thực gọi
 * `GET /product-types` và kết quả PHẢI thỏa:
 *   - CHỈ gồm loại `is_visible = 1`; KHÔNG có loại `is_visible = 0` (Req 5.1).
 *   - Loại hiển thị nhưng hết hàng (`availableCount = 0`) VẪN xuất hiện với
 *     `stock = 0`, `in_stock = false` (Req 5.4 — khác query bot vốn `HAVING stock > 0`).
 *   - Sắp xếp theo `sort_order ASC` rồi `name ASC` (cặp `(sort_order, name)` không giảm dần).
 *   - Mỗi loại trả về: `stock === availableCount` đã seed (chỉ đếm `available`, KHÔNG đếm
 *     `sold`), `in_stock === (stock > 0)` và `price_display === formatCurrency(price)` (Req 5.2).
 *
 * Mount router `miniAppApi` trực tiếp (không phụ thuộc đăng ký ở `src/index.ts`). Router đã áp
 * `miniAppAuth` nên mỗi request cần header `X-Telegram-Init-Data` ký hợp lệ. Chạy dưới
 * `@cloudflare/vitest-pool-workers` nên Web Crypto + D1 thật có sẵn.
 *
 * GHI CHÚ collation/so sánh tên: tất cả ký tự sinh ra cho `name` đều thuộc ASCII (< 128).
 * Với ASCII, collation mặc định BINARY của SQLite (so sánh theo byte UTF-8) trùng khớp
 * thứ tự so sánh code-unit UTF-16 của JavaScript (`<`/`>`), nên assertion thứ tự ổn định.
 */

const BOT_TOKEN = 'test-bot-token'

// Người mua cố định để ký initData hợp lệ (middleware tự upsert vào `users`).
const BUYER_TELEGRAM_ID = 777_000_222

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

/** Gọi GET /product-types với initData hợp lệ. */
async function getProductTypes(): Promise<Response> {
  const raw = await buyerInitData()
  return miniAppApi.request(
    '/product-types',
    { headers: { 'X-Telegram-Init-Data': raw } },
    getEnvBindings() as any
  )
}

// --- Arbitraries ---

// Ký tự ASCII an toàn cho `name`: không vượt 127 nên BINARY collation của SQLite
// trùng thứ tự với so sánh chuỗi của JS. Trộn space/digit/upper/lower để kích hoạt
// nhánh sắp xếp phụ theo `name` khi `sort_order` bằng nhau.
const NAME_CHARS =
  ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split('')

const arbName = fc
  .array(fc.constantFrom(...NAME_CHARS), { minLength: 1, maxLength: 12 })
  .map((a) => a.join(''))

interface PtSpec {
  isVisible: boolean
  sortOrder: number
  name: string
  price: number
  availableCount: number
  soldCount: number
}

const arbPt: fc.Arbitrary<PtSpec> = fc.record({
  isVisible: fc.boolean(),
  // Khoảng nhỏ để dễ tạo `sort_order` trùng nhau → kiểm tra sắp xếp phụ theo `name`.
  sortOrder: fc.integer({ min: 0, max: 5 }),
  name: arbName,
  price: fc.integer({ min: 1, max: 10_000_000 }),
  availableCount: fc.integer({ min: 0, max: 5 }),
  soldCount: fc.integer({ min: 0, max: 3 }),
})

const arbPtList = fc.array(arbPt, { minLength: 1, maxLength: 8 })

/**
 * Seed một product_type (+ N products `available` + M products `sold`) và trả id vừa tạo.
 * `sold` được seed CỐ TÌNH để chứng minh `stock` chỉ đếm `available` (Req 5.2).
 */
async function seedProductType(spec: PtSpec): Promise<number> {
  const inserted = await env.DB.prepare(
    `INSERT INTO product_types (name, description, price, emoji, sort_order, is_visible, success_template)
     VALUES (?, ?, ?, '🎬', ?, ?, ?)
     RETURNING id`
  )
    .bind(spec.name, null, spec.price, spec.sortOrder, spec.isVisible ? 1 : 0, null)
    .first<{ id: number }>()

  const typeId = inserted!.id

  for (let i = 0; i < spec.availableCount; i++) {
    await env.DB.prepare(
      `INSERT INTO products (type_id, content, status) VALUES (?, ?, 'available')`
    )
      .bind(typeId, `avail-${typeId}-${i}`)
      .run()
  }
  for (let i = 0; i < spec.soldCount; i++) {
    await env.DB.prepare(
      `INSERT INTO products (type_id, content, status) VALUES (?, ?, 'sold')`
    )
      .bind(typeId, `sold-${typeId}-${i}`)
      .run()
  }

  return typeId
}

/**
 * So sánh chuỗi theo thứ tự BINARY (code unit) — khớp collation mặc định của SQLite
 * cho dữ liệu ASCII. Trả < 0, 0, > 0 như convention compareFn.
 */
function binaryCompare(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
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

// --- Property 6 ---

describe('Property 6: Danh mục lọc theo hiển thị, sắp xếp và đếm tồn kho đúng', () => {
  /**
   * **Validates: Requirements 5.1, 5.2, 5.4**
   */
  it('GET /product-types only returns visible types, ordered, with accurate available stock', async () => {
    await fc.assert(
      fc.asyncProperty(arbPtList, async (specs) => {
        // Cô lập từng iteration: dọn products + product_types (giữ buyer ở `users`).
        await env.DB.prepare('DELETE FROM products').run()
        await env.DB.prepare('DELETE FROM product_types').run()

        // Seed và map id → spec để đối chiếu (tên có thể trùng nên match theo id).
        const idToSpec = new Map<number, PtSpec>()
        for (const spec of specs) {
          const id = await seedProductType(spec)
          idToSpec.set(id, spec)
        }

        const res = await getProductTypes()
        expect(res.status).toBe(200)

        const body = (await res.json()) as ApiResponse<ProductTypeListItemDto[]>
        expect(body.success).toBe(true)
        expect(body.error).toBeNull()

        const data = body.data!
        expect(Array.isArray(data)).toBe(true)

        // (1) Số lượng trả về = đúng số loại hiển thị (mọi loại hiển thị đều xuất hiện,
        // kể cả hết hàng — Req 5.1, 5.4; không loại ẩn nào lọt vào — Req 5.1).
        const visibleCount = specs.filter((s) => s.isVisible).length
        expect(data.length).toBe(visibleCount)

        for (const item of data) {
          const spec = idToSpec.get(item.id)
          // (2) Mỗi id trả về phải tồn tại và là loại hiển thị (không có loại ẩn).
          expect(spec).toBeDefined()
          expect(spec!.isVisible).toBe(true)

          // (3) stock chỉ đếm `available` (KHÔNG đếm `sold`) — Req 5.2.
          expect(item.stock).toBe(spec!.availableCount)
          // (4) in_stock = (stock > 0); loại hết hàng vẫn xuất hiện với in_stock=false — Req 5.4.
          expect(item.in_stock).toBe(spec!.availableCount > 0)

          // (5) Giá + định dạng tiền tệ đúng — Req 5.2.
          expect(item.price).toBe(spec!.price)
          expect(item.price_display).toBe(await expectedMoneyDisplay(spec!.price))
          // Tên phản ánh đúng bản ghi đã seed.
          expect(item.name).toBe(spec!.name)
        }

        // (6) Thứ tự: cặp (sort_order, name) không giảm dần — Req 5.1 (ORDER BY sort_order ASC, name ASC).
        for (let i = 1; i < data.length; i++) {
          const prev = idToSpec.get(data[i - 1].id)!
          const cur = idToSpec.get(data[i].id)!
          const ordered =
            prev.sortOrder < cur.sortOrder ||
            (prev.sortOrder === cur.sortOrder && binaryCompare(prev.name, cur.name) <= 0)
          expect(ordered).toBe(true)
        }
      }),
      { numRuns: 100 }
    )
  })
})
