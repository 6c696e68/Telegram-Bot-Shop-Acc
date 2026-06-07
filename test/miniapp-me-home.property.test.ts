import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { miniAppApi } from '../src/routes/miniapp-api'
import { formatMoneyFor, buildCurrencyContext } from '../src/utils/format'
import { resolveLang } from '../src/services/user-locale'
import type { ApiResponse } from '../src/types/api'
import type { MeDto } from '../src/types/miniapp'

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

// Feature: telegram-mini-app, Property 5
/**
 * Property-based test cho endpoint `GET /me` và `GET /home` — dữ liệu người mua
 * phản ánh đúng bản ghi `users` và đúng định dạng tiền tệ.
 *
 * **Property 5: Dữ liệu người mua phản ánh đúng DB và đúng định dạng**
 * **Validates: Requirements 4.1, 4.2, 12.1, 12.2**
 *
 * Với mọi người mua (telegram_id, username, first_name, balance ≥ 0) được INSERT
 * vào `users`:
 *   - `GET /me` trả `telegram_id` / `username` / `first_name` / `balance` khớp
 *     đúng bản ghi `users` (Req 12.1, 12.2) và `balance_display === formatCurrency(balance)` (Req 4.2).
 *   - `GET /home` trả `balance` + `balance_display` khớp DB và đúng định dạng (Req 4.1, 4.2).
 *
 * Mount router `miniAppApi` trực tiếp (không phụ thuộc đăng ký ở `src/index.ts`).
 * Router đã áp `miniAppAuth` nên mỗi request cần header `X-Telegram-Init-Data` ký hợp lệ.
 *
 * LƯU Ý đồng bộ với upsert của middleware: `getOrCreateUser` chạy
 * `INSERT ... ON CONFLICT(telegram_id) DO UPDATE` cập nhật `username`/`first_name`
 * theo initData trên MỖI request. Vì vậy ta ký initData với CHÍNH `username`/`first_name`
 * đã INSERT vào DB để giá trị sau upsert không đổi. `balance` KHÔNG bị upsert sửa
 * nên assertion về số dư luôn ổn định.
 *
 * Chạy dưới @cloudflare/vitest-pool-workers nên Web Crypto + D1 thật có sẵn.
 */

const BOT_TOKEN = 'test-bot-token'

// Schema `users` tối thiểu (giống test/integration.test.ts).
const USERS_TABLE = `CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
  is_active INTEGER DEFAULT 1,
  last_interaction_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`

// Bảng system_config cần tồn tại vì miniAppAuth resolve bot_token DB-first.
// Để rỗng → fallback về env.BOT_TOKEN.
const SYSTEM_CONFIG_TABLE = `CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER
)`

function getEnvBindings() {
  return { DB: env.DB, BOT_TOKEN }
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

// --- Arbitraries ---

// Ký tự an toàn round-trip qua JSON + URLSearchParams (gồm ký tự đặc biệt HTML),
// tránh surrogate/null.
const SAFE_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.&<>"\'=@'.split('')

const arbText = fc
  .array(fc.constantFrom(...SAFE_CHARS), { maxLength: 24 })
  .map((a) => a.join(''))

interface BuyerInput {
  telegramId: number
  username: string | null
  firstName: string | null
  balance: number
}

const arbBuyer: fc.Arbitrary<BuyerInput> = fc.record({
  telegramId: fc.integer({ min: 1, max: 9_999_999_999 }),
  username: fc.option(arbText, { nil: null }),
  firstName: fc.option(arbText, { nil: null }),
  balance: fc.integer({ min: 0, max: 1_000_000_000_000 }),
})

/**
 * Dựng + ký initData với username/first_name KHỚP giá trị đã INSERT vào DB
 * (để upsert của middleware không làm lệch dữ liệu). auth_date dùng thời điểm
 * hiện tại để vượt qua TTL.
 */
async function signBuyerInitData(b: BuyerInput): Promise<string> {
  const user: { id: number; username?: string; first_name?: string } = { id: b.telegramId }
  if (b.username !== null) user.username = b.username
  if (b.firstName !== null) user.first_name = b.firstName

  const fields: Record<string, string> = {
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
  }
  return signInitData(fields, BOT_TOKEN)
}

/** INSERT bản ghi `users` với balance chỉ định (sau khi đã dọn sạch bảng). */
async function insertBuyer(b: BuyerInput): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO users (telegram_id, username, first_name, balance, is_active, last_interaction_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?)`
  )
    .bind(b.telegramId, b.username, b.firstName, b.balance, now, now, now)
    .run()
}

// --- Setup: bảng users + dọn sạch trước mỗi test ---

beforeEach(async () => {
  await env.DB.prepare(USERS_TABLE).run()
  await env.DB.prepare(SYSTEM_CONFIG_TABLE).run()
  await env.DB.prepare('DELETE FROM users').run()
})

// --- Property 5 ---

describe('Property 5: Dữ liệu người mua phản ánh đúng DB và đúng định dạng', () => {
  /**
   * **Validates: Requirements 12.1, 12.2, 4.2**
   * `GET /me` trả telegram_id/username/first_name/balance khớp bản ghi `users`,
   * và balance_display === formatCurrency(balance).
   */
  it('GET /me reflects the users row and formats balance correctly', async () => {
    await fc.assert(
      fc.asyncProperty(arbBuyer, async (b) => {
        // Cô lập từng iteration: telegram_id UNIQUE nên cần dọn trước mỗi run.
        await env.DB.prepare('DELETE FROM users').run()
        await insertBuyer(b)

        const raw = await signBuyerInitData(b)
        const res = await miniAppApi.request(
          '/me',
          { headers: { 'X-Telegram-Init-Data': raw } },
          getEnvBindings() as any
        )

        expect(res.status).toBe(200)
        const body = (await res.json()) as ApiResponse<MeDto>
        expect(body.success).toBe(true)
        expect(body.error).toBeNull()

        const data = body.data!
        expect(data.telegram_id).toBe(b.telegramId)
        expect(data.username).toBe(b.username)
        expect(data.first_name).toBe(b.firstName)
        expect(data.balance).toBe(b.balance)
        expect(data.balance_display).toBe(await expectedMoneyDisplay(b.balance))
      }),
      { numRuns: 100 }
    )
  })

  /**
   * **Validates: Requirements 4.1, 4.2**
   * `GET /home` trả balance khớp bản ghi `users` và balance_display đúng định dạng.
   */
  it('GET /home reflects the users balance and formats it correctly', async () => {
    await fc.assert(
      fc.asyncProperty(arbBuyer, async (b) => {
        await env.DB.prepare('DELETE FROM users').run()
        await insertBuyer(b)

        const raw = await signBuyerInitData(b)
        const res = await miniAppApi.request(
          '/home',
          { headers: { 'X-Telegram-Init-Data': raw } },
          getEnvBindings() as any
        )

        expect(res.status).toBe(200)
        const body = (await res.json()) as ApiResponse<{ balance: number; balance_display: string }>
        expect(body.success).toBe(true)
        expect(body.error).toBeNull()

        const data = body.data!
        expect(data.balance).toBe(b.balance)
        expect(data.balance_display).toBe(await expectedMoneyDisplay(b.balance))
      }),
      { numRuns: 100 }
    )
  })
})
