import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { app } from '../src/index'

/**
 * Property-based tests cho PayOS Webhook route (`routes/payos.ts`, mount tại
 * `/webhook/payos` trong `src/index.ts`).
 *
 * Target: payOsWebhook + resolvePayOsConfig + completeDeposit. Dùng D1 thật qua
 * @cloudflare/vitest-pool-workers (miniflare), khớp convention setup schema + env.DB
 * như test/sepay-webhook.property.test.ts và test/cryptopay-webhook.property.test.ts.
 *
 * Chữ ký PayOS (xem src/routes/payos.ts):
 *  - signature = HMAC_SHA256(checksumKey, sortObjDataByKey(body.data)) hex
 *  - checksumKey resolve qua resolvePayOsConfig (system_config payos_checksum_key | env)
 * Test ký bằng crypto.subtle giống route (sẵn có trên workerd) và tái dựng
 * sortObjDataByKey y hệt route để tạo chữ ký hợp lệ.
 *
 * Validates:
 *  - Property 18: Webhook verification gates crediting — Requirements 12.2, 12.3
 *  - Property 19: Verified success on a pending deposit credits exact VND immediately —
 *    Requirements 12.4, 12.5, 13.2, 13.3
 */

const CHECKSUM_KEY = 'test-payos-checksum-key-abc123'
const PAYOS_CHECKSUM_KEY_CONFIG = 'payos_checksum_key'

// --- Schema: deposits đa provider (cột chung) + users + transactions + system_config ---

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

async function setChecksumKey(value: string | null): Promise<void> {
  await env.DB.prepare('DELETE FROM system_config WHERE key = ?').bind(PAYOS_CHECKSUM_KEY_CONFIG).run()
  if (value !== null) {
    await env.DB
      .prepare('INSERT INTO system_config (key, value) VALUES (?, ?)')
      .bind(PAYOS_CHECKSUM_KEY_CONFIG, value)
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

/** Seed một deposit payos ở trạng thái `status`; correlation_ref = orderCode. */
async function seedPayOsDeposit(
  userId: number,
  amount: number,
  orderCode: string,
  status: 'pending' | 'expired' | 'completed' | 'awaiting_credit'
): Promise<number> {
  await env.DB.prepare(
    `INSERT INTO deposits (user_id, provider, amount, status, correlation_ref, created_at)
     VALUES (?, 'payos', ?, ?, ?, datetime('now'))`
  )
    .bind(userId, amount, status, orderCode)
    .run()
  const row = await env.DB.prepare('SELECT MAX(id) as id FROM deposits').first<{ id: number }>()
  return row!.id
}

async function getUserBalance(userId: number): Promise<number> {
  const row = await env.DB.prepare('SELECT balance FROM users WHERE id = ?')
    .bind(userId)
    .first<{ balance: number }>()
  return row!.balance
}

async function getDeposit(depositId: number): Promise<{ status: string; amount: number }> {
  const row = await env.DB.prepare('SELECT status, amount FROM deposits WHERE id = ?')
    .bind(depositId)
    .first<{ status: string; amount: number }>()
  return row!
}

async function countDepositTx(userId: number): Promise<number> {
  const row = await env.DB
    .prepare("SELECT COUNT(*) as cnt FROM transactions WHERE user_id = ? AND type = 'deposit'")
    .bind(userId)
    .first<{ cnt: number }>()
  return row!.cnt
}

// --- Ký chữ ký PayOS giống route (sortObjDataByKey + HMAC-SHA256 hex) ---

/** Replica của sortObjDataByKey trong routes/payos.ts (giữ đồng bộ). */
function sortObjDataByKey(data: Record<string, unknown>): string {
  return Object.keys(data)
    .sort()
    .map((key) => {
      const value = data[key]
      let stringValue: string
      if (value === null || value === undefined) {
        stringValue = ''
      } else if (typeof value === 'object') {
        stringValue = JSON.stringify(value)
      } else {
        stringValue = String(value)
      }
      return `${key}=${stringValue}`
    })
    .join('&')
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

async function signPayOsData(data: Record<string, unknown>, checksumKey: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(checksumKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const buffer = await crypto.subtle.sign('HMAC', key, encoder.encode(sortObjDataByKey(data)))
  return toHex(buffer)
}

// --- Helpers gọi route qua app.request (route đã mount /webhook/payos) ---

function getEnvBindings() {
  return {
    DB: env.DB,
    BOT_TOKEN: 'test-bot-token',
    TELEGRAM_SECRET_TOKEN: 'test-telegram-secret',
    SEPAY_API_KEY: 'test-sepay-key',
    ADMIN_IDS: '123456789',
    JWT_SECRET: 'test-jwt-secret',
    BANK_NAME: 'Vietcombank',
    BANK_ACCOUNT: '1017588888',
    BANK_OWNER: 'NGUYEN VAN TEST',
    // PAYOS_CHECKSUM_KEY cố tình KHÔNG set ở env → checksumKey chỉ đến từ system_config.
  }
}

function getExecutionCtx() {
  return {
    waitUntil: (_promise: Promise<unknown>) => {},
    passThroughOnException: () => {},
  }
}

async function sendWebhook(body: object): Promise<Response> {
  return app.request(
    '/webhook/payos',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    getEnvBindings() as never,
    getExecutionCtx() as never
  )
}

/** Build webhook body PayOS thành công cho deposit `orderCode`. */
function buildPayOsData(options: {
  orderCode: string
  paymentLinkId: string
  amount: number
  code?: string
}): Record<string, unknown> {
  return {
    orderCode: options.orderCode,
    paymentLinkId: options.paymentLinkId,
    amount: options.amount,
    code: options.code ?? '00',
    desc: 'success',
    accountNumber: '0123456789',
    reference: `ref-${Math.random().toString(36).slice(2, 10)}`,
  }
}

// Generators
const arbInitialBalance = fc.integer({ min: 0, max: 10_000_000 })
const arbDepositAmount = fc.integer({ min: 20_000, max: 100_000_000 })
const arbOrderCode = fc.integer({ min: 1, max: 2_000_000_000 }).map((n) => String(n))
const arbPaymentLinkId = fc
  .stringOf(fc.constantFrom(...'abcdef0123456789'.split('')), { minLength: 8, maxLength: 16 })
const arbDuplicateCount = fc.integer({ min: 2, max: 5 })

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

// Feature: payos-deposit, Property 18
describe('Property 18: Webhook verification gates crediting', () => {
  /**
   * **Validates: Requirements 12.2, 12.3**
   * Chữ ký sai → 401, KHÔNG cộng tiền, deposit giữ pending, không có transaction.
   */
  it('chữ ký không hợp lệ → 401 và không cộng tiền', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInitialBalance,
        arbDepositAmount,
        arbOrderCode,
        arbPaymentLinkId,
        async (initialBalance, amount, orderCode, paymentLinkId) => {
          await cleanTables()
          await setChecksumKey(CHECKSUM_KEY)
          const userId = await seedUser(initialBalance)
          const depositId = await seedPayOsDeposit(userId, amount, orderCode, 'pending')

          const data = buildPayOsData({ orderCode, paymentLinkId, amount })
          const res = await sendWebhook({ code: '00', data, signature: 'deadbeefdeadbeef' })

          expect(res.status).toBe(401)
          expect(await getUserBalance(userId)).toBe(initialBalance)
          expect((await getDeposit(depositId)).status).toBe('pending')
          expect(await countDepositTx(userId)).toBe(0)
        }
      ),
      { numRuns: 25 }
    )
  })

  /**
   * **Validates: Requirements 12.2, 12.3**
   * Thiếu checksumKey (chưa cấu hình ở DB lẫn env) → 401, KHÔNG cộng tiền, dù chữ ký
   * "đúng" theo một key bất kỳ.
   */
  it('thiếu checksumKey → 401 và không cộng tiền', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInitialBalance,
        arbDepositAmount,
        arbOrderCode,
        arbPaymentLinkId,
        async (initialBalance, amount, orderCode, paymentLinkId) => {
          await cleanTables()
          await setChecksumKey(null) // không cấu hình checksum key
          const userId = await seedUser(initialBalance)
          const depositId = await seedPayOsDeposit(userId, amount, orderCode, 'pending')

          const data = buildPayOsData({ orderCode, paymentLinkId, amount })
          // Ký bằng một key tùy ý — vẫn phải bị từ chối vì server không có checksumKey.
          const signature = await signPayOsData(data, CHECKSUM_KEY)
          const res = await sendWebhook({ code: '00', data, signature })

          expect(res.status).toBe(401)
          expect(await getUserBalance(userId)).toBe(initialBalance)
          expect((await getDeposit(depositId)).status).toBe('pending')
          expect(await countDepositTx(userId)).toBe(0)
        }
      ),
      { numRuns: 25 }
    )
  })

  /**
   * **Validates: Requirements 12.2, 12.3**
   * Chữ ký hợp lệ nhưng sự kiện KHÔNG thành công (code != '00') → 200, KHÔNG cộng tiền,
   * deposit giữ pending.
   */
  it('chữ ký hợp lệ nhưng không phải success → 200 và không cộng tiền', async () => {
    const arbNonSuccessCode = fc.constantFrom('01', '02', '99', 'FF', 'xx')
    await fc.assert(
      fc.asyncProperty(
        arbInitialBalance,
        arbDepositAmount,
        arbOrderCode,
        arbPaymentLinkId,
        arbNonSuccessCode,
        async (initialBalance, amount, orderCode, paymentLinkId, code) => {
          await cleanTables()
          await setChecksumKey(CHECKSUM_KEY)
          const userId = await seedUser(initialBalance)
          const depositId = await seedPayOsDeposit(userId, amount, orderCode, 'pending')

          const data = buildPayOsData({ orderCode, paymentLinkId, amount, code })
          const signature = await signPayOsData(data, CHECKSUM_KEY)
          const res = await sendWebhook({ code, data, signature })

          expect(res.status).toBe(200)
          expect(await res.json()).toEqual({ success: true })
          expect(await getUserBalance(userId)).toBe(initialBalance)
          expect((await getDeposit(depositId)).status).toBe('pending')
          expect(await countDepositTx(userId)).toBe(0)
        }
      ),
      { numRuns: 25 }
    )
  })

  /**
   * **Validates: Requirements 12.2, 12.3**
   * Chữ ký hợp lệ, success, nhưng orderCode không khớp deposit nào → 200, không cộng tiền.
   */
  it('chữ ký hợp lệ, success, orderCode không khớp → 200 và không cộng tiền', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInitialBalance,
        arbDepositAmount,
        arbOrderCode,
        arbPaymentLinkId,
        async (initialBalance, amount, orderCode, paymentLinkId) => {
          await cleanTables()
          await setChecksumKey(CHECKSUM_KEY)
          const userId = await seedUser(initialBalance)
          // Deposit có orderCode khác hẳn với orderCode trong webhook.
          const depositId = await seedPayOsDeposit(userId, amount, `other-${orderCode}`, 'pending')

          const data = buildPayOsData({ orderCode, paymentLinkId, amount })
          const signature = await signPayOsData(data, CHECKSUM_KEY)
          const res = await sendWebhook({ code: '00', data, signature })

          expect(res.status).toBe(200)
          expect(await getUserBalance(userId)).toBe(initialBalance)
          expect((await getDeposit(depositId)).status).toBe('pending')
          expect(await countDepositTx(userId)).toBe(0)
        }
      ),
      { numRuns: 25 }
    )
  })
})

// Feature: payos-deposit, Property 19
describe('Property 19: Verified success on a pending deposit credits exact VND immediately', () => {
  /**
   * **Validates: Requirements 12.4, 12.5, 13.2, 13.3**
   * Webhook hợp lệ + success trên deposit pending → cộng đúng deposit.amount VND NGAY:
   * status -> completed, balance += amount (không tỷ giá), không awaiting_credit, trả 200.
   */
  it('verified success cộng đúng VND ngay (completed, balance += amount)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInitialBalance,
        arbDepositAmount,
        arbOrderCode,
        arbPaymentLinkId,
        async (initialBalance, amount, orderCode, paymentLinkId) => {
          await cleanTables()
          await setChecksumKey(CHECKSUM_KEY)
          const userId = await seedUser(initialBalance)
          const depositId = await seedPayOsDeposit(userId, amount, orderCode, 'pending')

          const data = buildPayOsData({ orderCode, paymentLinkId, amount })
          const signature = await signPayOsData(data, CHECKSUM_KEY)
          const res = await sendWebhook({ code: '00', data, signature })

          expect(res.status).toBe(200)
          expect(await res.json()).toEqual({ success: true })

          // Cộng đúng VND của deposit, không quy đổi tỷ giá.
          expect(await getUserBalance(userId)).toBe(initialBalance + amount)
          const dep = await getDeposit(depositId)
          expect(dep.status).toBe('completed')
          expect(dep.amount).toBe(amount)
          expect(await countDepositTx(userId)).toBe(1)
        }
      ),
      { numRuns: 30 }
    )
  })

  /**
   * **Validates: Requirements 12.4, 12.5, 13.2, 13.3**
   * Callback xác thực lặp lại nhiều lần → chỉ cộng MỘT lần (idempotent); các lần sau trả
   * 200, balance không đổi, chỉ một transaction.
   */
  it('callback xác thực lặp lại chỉ cộng một lần (idempotent)', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInitialBalance,
        arbDepositAmount,
        arbOrderCode,
        arbPaymentLinkId,
        arbDuplicateCount,
        async (initialBalance, amount, orderCode, paymentLinkId, duplicateCount) => {
          await cleanTables()
          await setChecksumKey(CHECKSUM_KEY)
          const userId = await seedUser(initialBalance)
          const depositId = await seedPayOsDeposit(userId, amount, orderCode, 'pending')

          const data = buildPayOsData({ orderCode, paymentLinkId, amount })
          const signature = await signPayOsData(data, CHECKSUM_KEY)
          const webhookBody = { code: '00', data, signature }

          // Lần đầu: cộng tiền.
          const res1 = await sendWebhook(webhookBody)
          expect(res1.status).toBe(200)
          expect(await getUserBalance(userId)).toBe(initialBalance + amount)

          // Các lần sau: idempotent, không cộng thêm.
          for (let i = 0; i < duplicateCount; i++) {
            const resN = await sendWebhook(webhookBody)
            expect(resN.status).toBe(200)
            expect(await resN.json()).toEqual({ success: true })
          }

          expect(await getUserBalance(userId)).toBe(initialBalance + amount)
          expect((await getDeposit(depositId)).status).toBe('completed')
          expect(await countDepositTx(userId)).toBe(1)
        }
      ),
      { numRuns: 20 }
    )
  })
})
