import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { miniAppApi } from '../src/routes/miniapp-api'
import { completeDeposit } from '../src/services/deposit-service'
import { _resetRateLimiter } from '../src/bot/rate-limit'
import type { ApiResponse } from '../src/types/api'
import type { DepositStatusDto } from '../src/types/miniapp'
import type { ProviderId } from '../src/services/payments/types'

// Feature: payos-deposit, Property 24
/**
 * Property-based test cho endpoint `POST /api/app/deposits/:id/cancel` — quy tắc
 * PayOS không cho huỷ thủ công (R23).
 *
 * **Property 24: PayOS deposits are never cancelled**
 * **Validates: Requirements 23.1, 23.2, 23.3**
 *
 * Với một Deposit `pending` thuộc người mua, gửi yêu cầu huỷ qua Mini App API:
 *   - provider = `payos`: HTTP 409, `error = 'payos_not_cancellable'`, trạng thái
 *     Deposit GIỮ NGUYÊN `pending` (KHÔNG chuyển `cancelled`) — R23.2. Sau khi bị từ
 *     chối, Deposit vẫn còn cộng được: `completeDeposit` cộng đúng VND đúng một lần và
 *     chuyển sang `completed` — R23.3 (guard hoàn tất từ `pending`/`expired` không đổi).
 *   - provider = `sepay`/`cryptobot` (đối chứng): HTTP 200, `success = true`, trạng thái
 *     Deposit chuyển `cancelled`.
 *
 * Mount router `miniAppApi` trực tiếp (không phụ thuộc đăng ký ở `src/index.ts`).
 * Router đã áp `miniAppAuth` nên mỗi request cần header `X-Telegram-Init-Data` ký hợp lệ.
 * Chạy dưới @cloudflare/vitest-pool-workers nên Web Crypto + D1 thật có sẵn.
 */

const BOT_TOKEN = 'test-bot-token'

// --- Schema: deposits đa provider (cột chung) + users + transactions + system_config ---

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
  `CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL DEFAULT 'sepay',
    amount INTEGER NOT NULL CHECK(amount > 0),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','completed','expired','cancelled','awaiting_credit')),
    correlation_ref TEXT,
    provider_txn_id TEXT,
    metadata TEXT,
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
  await env.DB.prepare('DELETE FROM transactions').run()
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

function getExecutionCtx() {
  return {
    waitUntil: (_promise: Promise<unknown>) => {},
    passThroughOnException: () => {},
  }
}

/** Tạo người mua với telegram_id cho trước; trả về `users.id`. */
async function seedBuyer(telegramId: number): Promise<number> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO users (telegram_id, username, first_name, balance, is_active, region, language, last_interaction_at, created_at, updated_at)
     VALUES (?, 'buyer', 'Buyer', 0, 1, 'vietnam', 'vi', ?, ?, ?)`
  )
    .bind(telegramId, now, now, now)
    .run()
  const row = await env.DB.prepare('SELECT id FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<{ id: number }>()
  return row!.id
}

/** Tạo một Deposit `pending` cho người mua, trả về `deposits.id`. */
async function seedPendingDeposit(
  userId: number,
  provider: ProviderId,
  amount: number,
  correlationRef: string
): Promise<number> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO deposits (user_id, provider, amount, status, correlation_ref, created_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`
  )
    .bind(userId, provider, amount, correlationRef, now)
    .run()
  const row = await env.DB.prepare(
    "SELECT id FROM deposits WHERE user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1"
  )
    .bind(userId)
    .first<{ id: number }>()
  return row!.id
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

async function signBuyerInitData(telegramId: number): Promise<string> {
  const user = { id: telegramId, username: 'buyer', first_name: 'Buyer' }
  const fields: Record<string, string> = {
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
  }
  return signInitData(fields, BOT_TOKEN)
}

async function postCancel(telegramId: number, depositId: number) {
  const raw = await signBuyerInitData(telegramId)
  return miniAppApi.request(
    `/deposits/${depositId}/cancel`,
    {
      method: 'POST',
      headers: {
        'X-Telegram-Init-Data': raw,
        'Content-Type': 'application/json',
      },
    },
    getEnvBindings() as any,
    getExecutionCtx() as any
  )
}

/** Đọc trạng thái Deposit hiện tại. */
async function readDepositStatus(depositId: number): Promise<string> {
  const row = await env.DB.prepare('SELECT status FROM deposits WHERE id = ?')
    .bind(depositId)
    .first<{ status: string }>()
  return row!.status
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

// --- Property 24 ---

describe('Property 24: PayOS deposits are never cancelled', () => {
  /**
   * **Validates: Requirements 23.2, 23.3**
   * Huỷ một Deposit `payos` `pending` luôn bị từ chối (409 `payos_not_cancellable`),
   * trạng thái giữ `pending`, và Deposit vẫn cộng được sau đó (`completeDeposit`).
   */
  it('refuses to cancel a pending payos deposit (409) and keeps it creditable', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          telegramId: fc.integer({ min: 1, max: 9_999_999_999 }),
          amount: fc.integer({ min: 10_000, max: 5_000_000 }),
          orderCode: fc.integer({ min: 1, max: 9_999_999 }),
        }),
        async ({ telegramId, amount, orderCode }) => {
          await cleanTables()
          _resetRateLimiter()

          const userId = await seedBuyer(telegramId)
          const depositId = await seedPendingDeposit(
            userId,
            'payos',
            amount,
            `payos-${orderCode}`
          )

          // --- Yêu cầu huỷ bị từ chối: 409 payos_not_cancellable (R23.2) ---
          const res = await postCancel(telegramId, depositId)
          expect(res.status).toBe(409)
          const body = (await res.json()) as ApiResponse<null>
          expect(body.success).toBe(false)
          expect(body.data).toBeNull()
          expect(body.error).toBe('payos_not_cancellable')

          // Trạng thái Deposit KHÔNG đổi: vẫn pending (không cancelled).
          expect(await readDepositStatus(depositId)).toBe('pending')

          // --- Vẫn cộng được sau khi bị từ chối huỷ (R23.3) ---
          const credit = await completeDeposit({
            db: env.DB,
            depositId,
            userId,
            creditVnd: amount,
            provider: 'payos',
            providerTxnId: `link-${orderCode}`,
          })
          expect(credit.success).toBe(true)
          if (credit.success) {
            expect(credit.newBalance).toBe(amount)
          }
          expect(await readDepositStatus(depositId)).toBe('completed')

          // Cộng đúng MỘT lần: số dư người mua bằng đúng amount.
          const userRow = await env.DB.prepare('SELECT balance FROM users WHERE id = ?')
            .bind(userId)
            .first<{ balance: number }>()
          expect(userRow!.balance).toBe(amount)
        }
      ),
      { numRuns: 50 }
    )
  })

  /**
   * **Validates: Requirements 23.2** (đối chứng)
   * Các provider không phải PayOS (`sepay`/`cryptobot`) vẫn huỷ được bình thường:
   * 200 + trạng thái chuyển `cancelled`. Khẳng định quy tắc R23 chỉ áp cho `payos`.
   */
  it('still cancels pending sepay/cryptobot deposits (contrast)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          telegramId: fc.integer({ min: 1, max: 9_999_999_999 }),
          amount: fc.integer({ min: 10_000, max: 5_000_000 }),
          provider: fc.constantFrom<ProviderId>('sepay', 'cryptobot'),
          ref: fc.integer({ min: 1, max: 9_999_999 }),
        }),
        async ({ telegramId, amount, provider, ref }) => {
          await cleanTables()
          _resetRateLimiter()

          const userId = await seedBuyer(telegramId)
          const depositId = await seedPendingDeposit(
            userId,
            provider,
            amount,
            `${provider}-${ref}`
          )

          const res = await postCancel(telegramId, depositId)
          expect(res.status).toBe(200)
          const body = (await res.json()) as ApiResponse<DepositStatusDto>
          expect(body.success).toBe(true)
          expect(body.error).toBeNull()
          expect(body.data).not.toBeNull()
          expect(body.data!.status).toBe('cancelled')

          expect(await readDepositStatus(depositId)).toBe('cancelled')
        }
      ),
      { numRuns: 50 }
    )
  })
})
