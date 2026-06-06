import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { miniAppApi } from '../src/routes/miniapp-api'
import { _resetRateLimiter } from '../src/bot/rate-limit'
import { formatCurrency } from '../src/utils/format'
import type { ApiResponse } from '../src/types/api'
import type { DepositCreatedDto } from '../src/types/miniapp'

// Feature: telegram-mini-app, Property 13
/**
 * Property-based test cho endpoint `POST /api/app/deposits` — validate khoảng số
 * tiền nạp theo `system_config` (`min_deposit`/`max_deposit`).
 *
 * **Property 13: Validate khoảng số tiền nạp**
 * **Validates: Requirements 8.2, 8.3**
 *
 * Với min/max (min ≤ max) tự seed vào `system_config` và amount sinh trải dài
 * dưới-min / trong-khoảng / trên-max:
 *   - IFF `min ≤ amount ≤ max` (amount là số nguyên dương): HTTP 200, `success = true`,
 *     và TẠO ĐÚNG 1 bản ghi `deposits` trạng thái `pending` cho người mua đó với đúng
 *     `amount`, `transfer_code` hợp lệ (Req 8.3).
 *   - Ngược lại (amount < min HOẶC amount > max): HTTP 400, `success = false`, `error`
 *     là chuỗi thông báo nêu rõ giới hạn (chứa `formatCurrency(min)` và `formatCurrency(max)`),
 *     và KHÔNG có bản ghi `deposits` nào được tạo (Req 8.2).
 *
 * Mount router `miniAppApi` trực tiếp (không phụ thuộc đăng ký ở `src/index.ts`).
 * Router đã áp `miniAppAuth` nên mỗi request cần header `X-Telegram-Init-Data` ký hợp lệ.
 *
 * Endpoint gọi `sendPhoto` (qua global fetch) trong `c.executionCtx.waitUntil(...)` sau
 * khi commit. Ta stub `fetch` để không gọi mạng thật và cung cấp executionCtx có `waitUntil`.
 *
 * Cô lập mỗi iteration: dọn bảng + reset rate-limit (DEPOSIT_RULE capacity = 3) + dùng
 * telegram_id riêng để tránh throttling.
 *
 * Chạy dưới @cloudflare/vitest-pool-workers nên Web Crypto + D1 thật có sẵn.
 */

const BOT_TOKEN = 'test-bot-token'

// --- Schema tối thiểu cho tạo yêu cầu nạp (đồng bộ test/integration.test.ts) ---

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
    is_active INTEGER DEFAULT 1,
    region TEXT CHECK(region IN ('vietnam','international')),
    language TEXT,
    language_locked INTEGER NOT NULL DEFAULT 0,
    last_interaction_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL DEFAULT 'sepay' CHECK(provider IN ('sepay','cryptobot')),
    transfer_code TEXT UNIQUE NOT NULL,
    amount INTEGER NOT NULL CHECK(amount > 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','expired','cancelled','awaiting_credit')),
    sepay_transaction_id TEXT,
    bank_ref TEXT,
    completed_at TEXT,
    expired_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER
  )`,
]

async function applySchema(): Promise<void> {
  for (const stmt of SCHEMA_STATEMENTS) {
    await env.DB.prepare(stmt).run()
  }
}

async function cleanTables(): Promise<void> {
  await env.DB.prepare('DELETE FROM deposits').run()
  await env.DB.prepare('DELETE FROM users').run()
  await env.DB.prepare('DELETE FROM system_config').run()
}

function getEnvBindings() {
  return {
    DB: env.DB,
    BOT_TOKEN,
    BANK_NAME: 'MB',
    BANK_ACCOUNT: '0123',
    BANK_OWNER: 'NGUYEN VAN A',
  }
}

/** executionCtx tối thiểu để endpoint gọi `waitUntil` cho ảnh VietQR fire-and-forget. */
function getExecutionCtx() {
  return {
    waitUntil: (_promise: Promise<unknown>) => {},
    passThroughOnException: () => {},
  }
}

/** Seed cặp giới hạn nạp vào system_config (value TEXT). */
async function seedDepositLimits(min: number, max: number): Promise<void> {
  await env.DB.prepare("INSERT INTO system_config (key, value) VALUES ('min_deposit', ?)")
    .bind(String(min))
    .run()
  await env.DB.prepare("INSERT INTO system_config (key, value) VALUES ('max_deposit', ?)")
    .bind(String(max))
    .run()
}

/** Tạo người mua với telegram_id cho trước (balance bất kỳ — không ảnh hưởng nạp). */
async function seedBuyer(telegramId: number): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO users (telegram_id, username, first_name, balance, is_active, region, language, last_interaction_at, created_at, updated_at)
     VALUES (?, 'buyer', 'Buyer', 0, 1, 'vietnam', 'vi', ?, ?, ?)`
  )
    .bind(telegramId, now, now, now)
    .run()
}

// --- Helper: ký initData hợp lệ (tái hiện thuật toán Telegram WebApp) ---

const encoder = new TextEncoder()

async function hmacSha256(keyBytes: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
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

/** Ký initData cho người mua với `auth_date` hiện tại để vượt TTL. */
async function signBuyerInitData(telegramId: number): Promise<string> {
  const user = { id: telegramId, username: 'buyer', first_name: 'Buyer' }
  const fields: Record<string, string> = {
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
  }
  return signInitData(fields, BOT_TOKEN)
}

async function postDeposit(telegramId: number, amount: number) {
  const raw = await signBuyerInitData(telegramId)
  return miniAppApi.request(
    '/deposits',
    {
      method: 'POST',
      headers: {
        'X-Telegram-Init-Data': raw,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount }),
    },
    getEnvBindings() as any,
    getExecutionCtx() as any
  )
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

// --- Property 13 ---

describe('Property 13: Validate khoảng số tiền nạp', () => {
  /**
   * **Validates: Requirements 8.2, 8.3**
   * Tạo deposit khi và chỉ khi `min ≤ amount ≤ max`; ngoài khoảng → 400 + message
   * giới hạn, không tạo bản ghi `deposits`.
   */
  it('creates a pending deposit iff min <= amount <= max, otherwise 400 with no deposit row', async () => {
    // Stub fetch để ảnh VietQR (sendPhoto) không gọi mạng thật.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    )

    await fc.assert(
      fc.asyncProperty(
        // min ∈ [10_000, 1_000_000]; max = min + span (đảm bảo min ≤ max).
        fc.integer({ min: 10_000, max: 1_000_000 }).chain((min) =>
          fc.integer({ min: 0, max: 2_000_000 }).chain((span) => {
            const max = min + span
            return fc.record({
              min: fc.constant(min),
              max: fc.constant(max),
              // amount trải dài: biên trong/ngoài khoảng + dải rộng quanh [min, max].
              amount: fc.oneof(
                fc.constant(min), // biên dưới (trong khoảng)
                fc.constant(max), // biên trên (trong khoảng)
                fc.constant(min - 1), // ngay dưới min (ngoài khoảng)
                fc.constant(max + 1), // ngay trên max (ngoài khoảng)
                fc.integer({ min: Math.max(1, min - 100_000), max: max + 100_000 })
              ),
              telegramId: fc.integer({ min: 1, max: 9_999_999_999 }),
            })
          })
        ),
        async ({ min, max, amount, telegramId }) => {
          // Cô lập từng iteration: dọn bảng + reset rate-limit (key theo telegram_id).
          await cleanTables()
          _resetRateLimiter()

          await seedDepositLimits(min, max)
          await seedBuyer(telegramId)

          const userRow = await env.DB.prepare('SELECT id FROM users WHERE telegram_id = ?')
            .bind(telegramId)
            .first<{ id: number }>()
          const userId = userRow!.id

          const inRange = amount >= min && amount <= max

          const res = await postDeposit(telegramId, amount)

          if (inRange) {
            // --- Trong khoảng: 200 + tạo đúng 1 deposit pending (Req 8.3) ---
            expect(res.status).toBe(200)
            const body = (await res.json()) as ApiResponse<DepositCreatedDto>
            expect(body.success).toBe(true)
            expect(body.error).toBeNull()
            expect(body.data).not.toBeNull()
            expect(body.data!.amount).toBe(amount)
            expect(body.data!.status).toBe('pending')
            expect(typeof body.data!.transfer_code).toBe('string')
            expect(body.data!.transfer_code.length).toBeGreaterThan(0)

            // Sổ cái: đúng 1 bản ghi pending cho user, đúng amount, transfer_code khớp.
            const pending = await env.DB.prepare(
              "SELECT id, amount, transfer_code, status FROM deposits WHERE user_id = ? AND status = 'pending'"
            )
              .bind(userId)
              .all<{ id: number; amount: number; transfer_code: string; status: string }>()
            expect(pending.results).toHaveLength(1)
            expect(pending.results[0].amount).toBe(amount)
            expect(pending.results[0].transfer_code).toBe(body.data!.transfer_code)
          } else {
            // --- Ngoài khoảng: 400 + message giới hạn + KHÔNG tạo deposit (Req 8.2) ---
            expect(res.status).toBe(400)
            const body = (await res.json()) as ApiResponse<null>
            expect(body.success).toBe(false)
            expect(body.data).toBeNull()
            // error là chuỗi thông báo nêu rõ giới hạn min/max đã format.
            expect(typeof body.error).toBe('string')
            expect(body.error as string).toContain(formatCurrency(min))
            expect(body.error as string).toContain(formatCurrency(max))

            // KHÔNG có bản ghi deposits nào được tạo.
            const all = await env.DB.prepare('SELECT COUNT(*) AS n FROM deposits')
              .first<{ n: number }>()
            expect(all!.n).toBe(0)
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})
