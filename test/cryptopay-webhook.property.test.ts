import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { Hono } from 'hono'
import { cryptoPayWebhook } from '../src/routes/cryptopay'

/**
 * Property-based tests cho Crypto Pay Webhook route (`routes/cryptopay.ts`).
 *
 * Target: cryptoPayWebhook + middleware cryptoPayAuth + deposit-service. Dùng D1 thật
 * qua @cloudflare/vitest-pool-workers (miniflare), khớp convention setup schema + env.DB
 * như test/sepay-webhook.property.test.ts và test/deposit-service.property.test.ts.
 *
 * Route CHƯA được mount vào app (task 13.1), nên test mount tạm một Hono app gắn
 * cryptoPayWebhook tại '/webhook' → endpoint POST /webhook/cryptopay, rồi gọi qua
 * app.request với env bindings + executionCtx (giống sepay-webhook test).
 *
 * Chữ ký Crypto Pay (xem src/middleware/cryptopay-auth.ts):
 *  - secret = SHA256(CRYPTO_PAY_API_TOKEN) bytes
 *  - hmac   = HMAC_SHA256(secret, rawBody) hex
 *  - header 'crypto-pay-api-signature'
 * Test ký bằng crypto.subtle giống middleware (sẵn có trên workerd).
 *
 * Validates: Requirements 11.4, 12.2, 12.6, 12.7
 *  - Property 3 (Bảo toàn tiền đã trả): thanh toán USDT hợp lệ luôn dẫn tới đúng MỘT
 *    lần cộng tiền — ngay (rate hợp lệ) hoặc sau (awaiting_credit) — không mất kể cả khi
 *    deposit đã expired; chữ ký giả không cộng tiền; callback trùng không cộng lại.
 *  - Property 4 (Quy đổi xác định): creditVnd = floor(paid_usdt × exchange_rate).
 */

const CRYPTO_PAY_API_TOKEN = 'test-crypto-pay-token-987654'
const EXCHANGE_RATE_KEY = 'exchange_rate_usdt_vnd'

// --- Schema: phản chiếu migration 0008 (deposits đa provider) + users + transactions + system_config ---

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
    region TEXT CHECK(region IN ('vietnam','international')),
    language TEXT,
    language_locked INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER DEFAULT 1,
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

async function setExchangeRate(value: string | null): Promise<void> {
  await env.DB.prepare('DELETE FROM system_config WHERE key = ?').bind(EXCHANGE_RATE_KEY).run()
  if (value !== null) {
    await env.DB
      .prepare("INSERT INTO system_config (key, value) VALUES (?, ?)")
      .bind(EXCHANGE_RATE_KEY, value)
      .run()
  }
}

async function seedUser(balance: number): Promise<number> {
  const telegramId = Math.floor(Math.random() * 2_000_000_000)
  await env.DB.prepare(
    "INSERT INTO users (telegram_id, username, first_name, balance, language, created_at, updated_at) VALUES (?, 'testuser', 'Test', ?, 'en', datetime('now'), datetime('now'))"
  )
    .bind(telegramId, balance)
    .run()
  const row = await env.DB.prepare('SELECT id FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<{ id: number }>()
  return row!.id
}

/** Seed một deposit cryptobot ở trạng thái `status` cho trước; trả về deposits.id + invoiceId. */
async function seedCryptoDeposit(
  userId: number,
  amount: number,
  status: 'pending' | 'expired' | 'completed' | 'awaiting_credit'
): Promise<{ depositId: number; invoiceId: string }> {
  const invoiceId = String(Math.floor(Math.random() * 2_000_000_000))
  await env.DB.prepare(
    `INSERT INTO deposits (user_id, provider, amount, status, correlation_ref, provider_txn_id, metadata, created_at)
     VALUES (?, 'cryptobot', ?, ?, ?, ?, ?, datetime('now'))`
  )
    .bind(userId, amount, status, invoiceId, invoiceId, JSON.stringify({ asset: 'USDT' }))
    .run()
  const row = await env.DB.prepare('SELECT MAX(id) as id FROM deposits').first<{ id: number }>()
  return { depositId: row!.id, invoiceId }
}

async function getUserBalance(userId: number): Promise<number> {
  const row = await env.DB.prepare('SELECT balance FROM users WHERE id = ?')
    .bind(userId)
    .first<{ balance: number }>()
  return row!.balance
}

async function getDeposit(depositId: number): Promise<{
  status: string
  amount: number
  exchange_rate: number | null
  usdt_amount: string | null
}> {
  const row = await env.DB.prepare(
    `SELECT status, amount,
            json_extract(metadata, '$.exchange_rate') AS exchange_rate,
            json_extract(metadata, '$.usdt_amount') AS usdt_amount
     FROM deposits WHERE id = ?`
  )
    .bind(depositId)
    .first<{ status: string; amount: number; exchange_rate: number | null; usdt_amount: string | null }>()
  return row!
}

async function countDepositTx(userId: number): Promise<number> {
  const row = await env.DB
    .prepare("SELECT COUNT(*) as cnt FROM transactions WHERE user_id = ? AND type = 'deposit'")
    .bind(userId)
    .first<{ cnt: number }>()
  return row!.cnt
}

// --- Ký chữ ký Crypto Pay giống middleware (secret=SHA256(token), hmac=HMAC-SHA256 hex) ---

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

async function signCryptoPay(token: string, rawBody: string): Promise<string> {
  const encoder = new TextEncoder()
  const secret = await crypto.subtle.digest('SHA-256', encoder.encode(token))
  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const hmacBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody))
  return toHex(hmacBuffer)
}

// --- Mount tạm route vào một Hono app để test (route chưa mount vào app chính — task 13.1) ---

const testApp = new Hono()
testApp.route('/webhook', cryptoPayWebhook)

function getEnvBindings(overrides: Record<string, unknown> = {}) {
  return {
    DB: env.DB,
    CRYPTO_PAY_API_TOKEN,
    BOT_TOKEN: 'test-bot-token',
    TELEGRAM_SECRET_TOKEN: 'test-telegram-secret',
    SEPAY_API_KEY: 'test-sepay-key',
    ADMIN_IDS: '123456789',
    JWT_SECRET: 'test-jwt-secret',
    BANK_NAME: 'Vietcombank',
    BANK_ACCOUNT: '1017588888',
    BANK_OWNER: 'NGUYEN VAN TEST',
    ...overrides,
  }
}

function getExecutionCtx() {
  return {
    waitUntil: (_promise: Promise<unknown>) => {},
    passThroughOnException: () => {},
  }
}

/** Build payload webhook invoice_paid của Crypto Pay. */
function buildInvoicePaidPayload(options: {
  invoiceId: string
  depositId: number
  paidUsdt: string
}) {
  return {
    update_id: Math.floor(Math.random() * 1_000_000),
    update_type: 'invoice_paid',
    payload: {
      invoice_id: Number(options.invoiceId),
      status: 'paid',
      asset: 'USDT',
      amount: options.paidUsdt,
      paid_asset: 'USDT',
      paid_amount: options.paidUsdt,
      payload: String(options.depositId),
    },
  }
}

/**
 * Gửi webhook qua app.request. Tự ký chữ ký hợp lệ trừ khi truyền `signatureOverride`.
 * `dbOverride` cho phép thay binding DB (dùng để mô phỏng db_error).
 */
async function sendWebhook(
  payload: object,
  opts: { signatureOverride?: string; dbOverride?: unknown } = {}
): Promise<Response> {
  const rawBody = JSON.stringify(payload)
  const signature =
    opts.signatureOverride ?? (await signCryptoPay(CRYPTO_PAY_API_TOKEN, rawBody))
  const bindings = opts.dbOverride
    ? getEnvBindings({ DB: opts.dbOverride })
    : getEnvBindings()
  return testApp.request(
    '/webhook/cryptopay',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'crypto-pay-api-signature': signature,
      },
      body: rawBody,
    },
    bindings as never,
    getExecutionCtx() as never
  )
}

// Generators
const arbInitialBalance = fc.integer({ min: 0, max: 10_000_000 })
// USDT (hundredths) >= 1.00 và rate >= 1 → floor(usdt*rate) >= 1 (tránh CHECK amount>0 vi phạm).
const arbUsdtHundredths = fc.integer({ min: 100, max: 5_000_000 }) // 1.00 .. 50000.00
const arbRate = fc.integer({ min: 1, max: 200_000 })

function usdtStrFromHundredths(h: number): string {
  return (h / 100).toFixed(2)
}

beforeEach(async () => {
  await applySchema()
  await cleanTables()
  // Mock fetch để chặn gọi Telegram API thật ở luồng notify thành công.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
  )
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Feature: multi-region-payments, Property 3
describe('Property 3: Bảo toàn tiền đã trả (Crypto Pay webhook)', () => {
  /**
   * **Validates: Requirements 11.4, 19.2**
   * Chữ ký giả (sai signature header) → 401, KHÔNG cộng tiền, deposit giữ nguyên pending.
   */
  it('chữ ký giả → 401 và không cộng tiền', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInitialBalance,
        arbUsdtHundredths,
        arbRate,
        async (initialBalance, usdtH, rate) => {
          await cleanTables()
          await setExchangeRate(String(rate))
          const userId = await seedUser(initialBalance)
          const { depositId, invoiceId } = await seedCryptoDeposit(userId, 1000, 'pending')

          const payload = buildInvoicePaidPayload({
            invoiceId,
            depositId,
            paidUsdt: usdtStrFromHundredths(usdtH),
          })

          const res = await sendWebhook(payload, { signatureOverride: 'deadbeefdeadbeef' })
          expect(res.status).toBe(401)

          // Không cộng tiền, deposit không đổi.
          expect(await getUserBalance(userId)).toBe(initialBalance)
          expect((await getDeposit(depositId)).status).toBe('pending')
          expect(await countDepositTx(userId)).toBe(0)
        }
      ),
      { numRuns: 25 }
    )
  })

  /**
   * **Validates: Requirements 11.4, 12.7**
   * paid-after-expired: deposit ở trạng thái 'expired' khi callback hợp lệ tới → vẫn cộng
   * đúng MỘT lần (R11.4); balance += floor(usdt*rate); deposit -> completed.
   */
  it("paid-after-expired: deposit 'expired' vẫn cộng đúng một lần", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInitialBalance,
        arbUsdtHundredths,
        arbRate,
        async (initialBalance, usdtH, rate) => {
          await cleanTables()
          await setExchangeRate(String(rate))
          const userId = await seedUser(initialBalance)
          const { depositId, invoiceId } = await seedCryptoDeposit(userId, 1000, 'expired')

          const usdtStr = usdtStrFromHundredths(usdtH)
          const expectedCredit = Math.floor(Number(usdtStr) * rate)
          const payload = buildInvoicePaidPayload({ invoiceId, depositId, paidUsdt: usdtStr })

          const res = await sendWebhook(payload)
          expect(res.status).toBe(200)
          expect(await res.json()).toEqual({ success: true })

          expect(await getUserBalance(userId)).toBe(initialBalance + expectedCredit)
          const dep = await getDeposit(depositId)
          expect(dep.status).toBe('completed')
          expect(await countDepositTx(userId)).toBe(1)
        }
      ),
      { numRuns: 25 }
    )
  })

  /**
   * **Validates: Requirements 11.2, 11.4**
   * Invoice trùng (deposit đã 'completed') → bỏ qua, KHÔNG cộng lần nữa, trả 200.
   */
  it("invoice trùng (deposit đã completed) → bỏ qua, không cộng lại (200)", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInitialBalance,
        arbUsdtHundredths,
        arbRate,
        async (initialBalance, usdtH, rate) => {
          await cleanTables()
          await setExchangeRate(String(rate))
          const userId = await seedUser(initialBalance)
          // Deposit đã completed từ trước (đã cộng tiền lần đầu, balance phản ánh sẵn).
          const { depositId, invoiceId } = await seedCryptoDeposit(userId, 1000, 'completed')

          const payload = buildInvoicePaidPayload({
            invoiceId,
            depositId,
            paidUsdt: usdtStrFromHundredths(usdtH),
          })

          const res = await sendWebhook(payload)
          expect(res.status).toBe(200)
          expect(await res.json()).toEqual({ success: true })

          // Không cộng thêm; deposit vẫn completed.
          expect(await getUserBalance(userId)).toBe(initialBalance)
          expect((await getDeposit(depositId)).status).toBe('completed')
          expect(await countDepositTx(userId)).toBe(0)
        }
      ),
      { numRuns: 25 }
    )
  })

  /**
   * **Validates: Requirements 12.4, 12.7**
   * rate lỗi (thiếu/không hợp lệ) → deposit chuyển 'awaiting_credit' (chưa cộng), trả 200,
   * lưu usdt_amount để cron credit-awaiting cộng sau. Tiền KHÔNG mất.
   */
  it("rate lỗi → deposit chuyển awaiting_credit, chưa cộng", async () => {
    const arbBadRate = fc.constantFrom<string | null>(null, '', '0', '-5', 'abc', 'NaN')
    await fc.assert(
      fc.asyncProperty(
        arbInitialBalance,
        arbUsdtHundredths,
        arbBadRate,
        async (initialBalance, usdtH, badRate) => {
          await cleanTables()
          await setExchangeRate(badRate)
          const userId = await seedUser(initialBalance)
          const { depositId, invoiceId } = await seedCryptoDeposit(userId, 1000, 'pending')

          const usdtStr = usdtStrFromHundredths(usdtH)
          const payload = buildInvoicePaidPayload({ invoiceId, depositId, paidUsdt: usdtStr })

          const res = await sendWebhook(payload)
          expect(res.status).toBe(200)
          expect(await res.json()).toEqual({ success: true })

          // Chưa cộng tiền; deposit -> awaiting_credit; lưu usdt_amount.
          expect(await getUserBalance(userId)).toBe(initialBalance)
          const dep = await getDeposit(depositId)
          expect(dep.status).toBe('awaiting_credit')
          expect(dep.usdt_amount).toBe(usdtStr)
          expect(await countDepositTx(userId)).toBe(0)
        }
      ),
      { numRuns: 25 }
    )
  })

  /**
   * **Validates: Requirements 11.2, 12.4**
   * Callback trùng tới khi deposit đã 'completed' nhưng rate đang lỗi → idempotency chặn
   * TRƯỚC bước rate; markAwaitingCredit KHÔNG được gọi → deposit GIỮ 'completed'
   * (không bị đảo trạng thái về awaiting_credit).
   */
  it("callback trùng khi đã 'completed' + rate lỗi → giữ completed (markAwaitingCredit không ghi đè)", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInitialBalance,
        arbUsdtHundredths,
        async (initialBalance, usdtH) => {
          await cleanTables()
          await setExchangeRate(null) // rate thiếu
          const userId = await seedUser(initialBalance)
          const { depositId, invoiceId } = await seedCryptoDeposit(userId, 5000, 'completed')

          const payload = buildInvoicePaidPayload({
            invoiceId,
            depositId,
            paidUsdt: usdtStrFromHundredths(usdtH),
          })

          const res = await sendWebhook(payload)
          expect(res.status).toBe(200)

          // Giữ completed; không đổi sang awaiting_credit; balance không đổi.
          expect((await getDeposit(depositId)).status).toBe('completed')
          expect(await getUserBalance(userId)).toBe(initialBalance)
        }
      ),
      { numRuns: 25 }
    )
  })

  /**
   * **Validates: Requirements 14.5**
   * completeDeposit db_error (lỗi atomic tạm thời SAU khi thanh toán xác nhận) → webhook
   * trả 500 để Crypto Pay retry callback; KHÔNG đánh dấu hoàn tất, KHÔNG cộng tiền.
   *
   * Mô phỏng: bọc DB binding sao cho `prepare` vẫn chạy thật (đọc deposit/user/rate) nhưng
   * `batch` ném lỗi → completeDeposit trả { error: 'db_error' } → route trả 500.
   */
  it('completeDeposit db_error → webhook trả 500 (retry, chưa hoàn tất)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInitialBalance,
        arbUsdtHundredths,
        arbRate,
        async (initialBalance, usdtH, rate) => {
          await cleanTables()
          await setExchangeRate(String(rate))
          const userId = await seedUser(initialBalance)
          const { depositId, invoiceId } = await seedCryptoDeposit(userId, 1000, 'pending')

          // DB wrapper: prepare delegate thật, batch luôn ném (mô phỏng atomic lỗi tạm thời).
          const failingDb = {
            prepare: (sql: string) => env.DB.prepare(sql),
            batch: async () => {
              throw new Error('simulated transient db_error')
            },
          }

          const payload = buildInvoicePaidPayload({
            invoiceId,
            depositId,
            paidUsdt: usdtStrFromHundredths(usdtH),
          })

          const res = await sendWebhook(payload, { dbOverride: failingDb })
          expect(res.status).toBe(500)
          expect(await res.json()).toEqual({ success: false })

          // Chưa cộng tiền; deposit chưa hoàn tất (vẫn pending) → retry còn cộng được.
          expect(await getUserBalance(userId)).toBe(initialBalance)
          expect((await getDeposit(depositId)).status).toBe('pending')
          expect(await countDepositTx(userId)).toBe(0)
        }
      ),
      { numRuns: 20 }
    )
  })
})

// Feature: multi-region-payments, Property 4
describe('Property 4: Quy đổi xác định (creditVnd = floor(usdt × rate))', () => {
  /**
   * **Validates: Requirements 12.2, 12.6**
   * Với usdt/rate ngẫu nhiên: số VND cộng vào balance == floor(paid_usdt × rate); deposit
   * lưu đúng amount=creditVnd, exchange_rate=rate, usdt_amount=paid_usdt.
   */
  it('credit đúng floor(usdt × rate) cho usdt/rate ngẫu nhiên', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInitialBalance,
        arbUsdtHundredths,
        arbRate,
        async (initialBalance, usdtH, rate) => {
          await cleanTables()
          await setExchangeRate(String(rate))
          const userId = await seedUser(initialBalance)
          const { depositId, invoiceId } = await seedCryptoDeposit(userId, 1000, 'pending')

          const usdtStr = usdtStrFromHundredths(usdtH)
          const expectedCredit = Math.floor(Number(usdtStr) * rate)

          const payload = buildInvoicePaidPayload({ invoiceId, depositId, paidUsdt: usdtStr })
          const res = await sendWebhook(payload)
          expect(res.status).toBe(200)

          const finalBalance = await getUserBalance(userId)
          expect(finalBalance).toBe(initialBalance + expectedCredit)

          const dep = await getDeposit(depositId)
          expect(dep.status).toBe('completed')
          expect(dep.amount).toBe(expectedCredit)
          expect(dep.exchange_rate).toBe(rate)
          expect(dep.usdt_amount).toBe(usdtStr)

          // Sai khác do làm tròn không vượt 1 đơn vị VND (Property 4).
          const expectedFromMath = Number(usdtStr) * rate
          expect(Math.abs(dep.amount - expectedFromMath)).toBeLessThan(1)
        }
      ),
      { numRuns: 40 }
    )
  })
})
