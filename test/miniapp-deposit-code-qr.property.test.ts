import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { miniAppApi } from '../src/routes/miniapp-api'
import { _resetRateLimiter } from '../src/bot/rate-limit'
import type { ApiResponse } from '../src/types/api'
import type { DepositCreatedDto } from '../src/types/miniapp'

// Feature: telegram-mini-app, Property 14
/**
 * Property-based test cho endpoint `POST /api/app/deposits` — `transfer_code` hợp lệ
 * và đôi một phân biệt; `qr_url` (VietQR) mang đúng tham số `amount` và `addInfo`.
 *
 * **Property 14: Transfer code hợp lệ và phân biệt; VietQR mang đúng tham số**
 * **Validates: Requirements 8.3, 8.4**
 *
 * Với mọi `amount` hợp lệ trong khoảng `[min_deposit, max_deposit]` (và `telegram_id`
 * biến thiên), khi tạo yêu cầu nạp:
 *   - `transfer_code` khớp regex `/^NAP[A-Z0-9]{4,17}$/` (Req 8.3).
 *   - `transfer_code` đôi một phân biệt giữa tất cả deposit sinh ra (gom qua một `Set`
 *     tích luỹ xuyên suốt ≥100 iteration; suffix 6 ký tự ngẫu nhiên nên trùng là
 *     gần như không thể) (Req 8.3).
 *   - `qr_url` parse được bằng `new URL(...)` và `searchParams`:
 *       `amount === String(amount)` và `addInfo === transfer_code` (Req 8.4).
 *
 * Mount router `miniAppApi` trực tiếp (không phụ thuộc đăng ký ở `src/index.ts`).
 * Router đã áp `miniAppAuth` nên mỗi request cần header `X-Telegram-Init-Data` ký hợp lệ.
 *
 * Endpoint gọi `sendPhoto` (qua global fetch) trong `c.executionCtx.waitUntil(...)` sau
 * khi commit. Ta stub `fetch` để không gọi mạng thật và cung cấp executionCtx có
 * `waitUntil`. Lỗi gửi tin KHÔNG ảnh hưởng response (Req 10.4) nên no-op là đủ.
 *
 * `DEPOSIT_RULE` có capacity 3 → reset rate-limiter mỗi iteration (test này tạo nhiều
 * deposit liên tiếp). Chạy dưới `@cloudflare/vitest-pool-workers` nên Web Crypto + D1 thật có sẵn.
 */

const BOT_TOKEN = 'test-bot-token'

// Giới hạn nạp seed vào system_config: min nhỏ, max lớn để amount sinh ra luôn trong khoảng.
const MIN_DEPOSIT = 1_000
const MAX_DEPOSIT = 100_000_000

/** Định dạng transfer_code hợp lệ theo `src/utils/transfer-code.ts` (Req 8.3). */
const TRANSFER_CODE_REGEX = /^NAP[A-Z0-9]{4,17}$/

// --- Schema tối thiểu cho tạo deposit (đồng bộ test/integration.test.ts) ---

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
    is_active INTEGER DEFAULT 1,
    region TEXT DEFAULT 'vietnam' CHECK(region IN ('vietnam','international')),
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

/** Dọn users + deposits giữa các iteration (giữ nguyên system_config đã seed). */
async function cleanBuyerTables(): Promise<void> {
  await env.DB.prepare('DELETE FROM deposits').run()
  await env.DB.prepare('DELETE FROM users').run()
}

/** Seed giới hạn nạp vào system_config (Req 8.2 — để amount sinh ra luôn hợp lệ). */
async function seedDepositLimits(): Promise<void> {
  await env.DB.prepare('DELETE FROM system_config').run()
  await env.DB.prepare(
    "INSERT INTO system_config (key, value, updated_at) VALUES ('min_deposit', ?, datetime('now'))"
  )
    .bind(String(MIN_DEPOSIT))
    .run()
  await env.DB.prepare(
    "INSERT INTO system_config (key, value, updated_at) VALUES ('max_deposit', ?, datetime('now'))"
  )
    .bind(String(MAX_DEPOSIT))
    .run()
}

function getEnvBindings() {
  return {
    DB: env.DB,
    BOT_TOKEN,
    BANK_NAME: 'MB',
    BANK_ACCOUNT: '0123456789',
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

/** Ký initData cho buyer với `auth_date` hiện tại (vượt TTL) — username/first_name khớp seed. */
async function signBuyerInitData(telegramId: number): Promise<string> {
  const user = { id: telegramId, username: 'buyer', first_name: 'Buyer' }
  const fields: Record<string, string> = {
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
  }
  return signInitData(fields, BOT_TOKEN)
}

/** Insert buyer vào users (middleware sẽ upsert idempotent với cùng telegram_id). */
async function insertBuyer(telegramId: number): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO users (telegram_id, username, first_name, balance, is_active, last_interaction_at, created_at, updated_at)
     VALUES (?, 'buyer', 'Buyer', 0, 1, ?, ?, ?)`
  )
    .bind(telegramId, now, now, now)
    .run()
}

/** Gọi POST /deposits với amount cho trước. */
async function createDeposit(telegramId: number, amount: number): Promise<Response> {
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
  await cleanBuyerTables()
  await seedDepositLimits()
  _resetRateLimiter()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// --- Property 14 ---

describe('Property 14: Transfer code hợp lệ và phân biệt; VietQR mang đúng tham số', () => {
  /**
   * **Validates: Requirements 8.3, 8.4**
   * Mỗi deposit: `transfer_code` khớp `/^NAP[A-Z0-9]{4,17}$/`, đôi một phân biệt;
   * `qr_url` chứa đúng `amount` và `addInfo === transfer_code`.
   */
  it('transfer_code matches regex + is distinct; qr_url carries correct amount & addInfo', async () => {
    // Stub fetch để ảnh VietQR (sendPhoto) không gọi mạng thật.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    )

    // Tích luỹ transfer_code xuyên suốt các iteration để kiểm tính phân biệt (Req 8.3).
    const seenCodes = new Set<string>()
    let count = 0

    await fc.assert(
      fc.asyncProperty(
        fc.record({
          amount: fc.integer({ min: MIN_DEPOSIT, max: MAX_DEPOSIT }),
          telegramId: fc.integer({ min: 1, max: 9_999_999_999 }),
        }),
        async ({ amount, telegramId }) => {
          // Cô lập từng iteration: dọn users + deposits, reset rate-limit (key theo telegram_id).
          await cleanBuyerTables()
          _resetRateLimiter()
          await insertBuyer(telegramId)

          const res = await createDeposit(telegramId, amount)

          expect(res.status).toBe(200)
          const body = (await res.json()) as ApiResponse<DepositCreatedDto>
          expect(body.success).toBe(true)
          expect(body.error).toBeNull()

          const data = body.data!
          const transferCode = data.transfer_code

          // Req 8.3: transfer_code khớp định dạng NAP[A-Z0-9]{4,17}.
          expect(transferCode).toMatch(TRANSFER_CODE_REGEX)

          // Req 8.3: phân biệt — chưa từng thấy trước đó, rồi ghi nhận.
          expect(seenCodes.has(transferCode)).toBe(false)
          seenCodes.add(transferCode)
          count++

          // Req 8.4: qr_url parse được và mang đúng amount + addInfo = transfer_code.
          const url = new URL(data.qr_url)
          expect(url.searchParams.get('amount')).toBe(String(amount))
          expect(url.searchParams.get('addInfo')).toBe(transferCode)

          // Amount trong DTO phản ánh đúng amount yêu cầu (không bị client điều khiển sai lệch).
          expect(data.amount).toBe(amount)
        }
      ),
      { numRuns: 100 }
    )

    // Tổng kết: số transfer_code phân biệt = số deposit đã tạo (không có trùng nào).
    expect(seenCodes.size).toBe(count)
    expect(count).toBeGreaterThanOrEqual(100)
  })
})
