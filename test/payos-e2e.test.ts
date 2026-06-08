import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../src/index'
import { payOsProvider } from '../src/services/payments/payos-provider'

/**
 * Integration / example test — luồng PayOS end-to-end.
 *
 * Nối `payOsProvider.createDeposit` (tạo Deposit pending + Payment_Link) với route
 * webhook `/webhook/payos` (cộng tiền qua `completeDeposit`). Dùng D1 thật qua
 * @cloudflare/vitest-pool-workers (miniflare) + `app.request`, theo convention của
 * test/integration.test.ts, test/payos-provider.property.test.ts và
 * test/payos-webhook.property.test.ts.
 *
 * Phủ:
 *  - Tạo Deposit qua provider (pending, correlation_ref=orderCode, provider_txn_id=paymentLinkId).
 *  - Webhook success hợp lệ → cộng đúng amount VND, deposit -> completed (1 transaction).
 *  - Lặp lại CÙNG callback (và duplicate) → idempotent theo paymentLinkId: 200, balance
 *    không đổi, vẫn chỉ một transaction (no double-credit).
 *
 * Validates: Requirements 17.4
 */

const CHECKSUM_KEY = 'e2e-payos-checksum-key-xyz789'
const CLIENT_ID = 'e2e-client-id'
const API_KEY = 'e2e-api-key'
const MINIAPP_URL = 'https://miniapp.example.com/app'

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
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_provider_correlation
     ON deposits(provider, correlation_ref) WHERE correlation_ref IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_provider_txn
     ON deposits(provider, provider_txn_id) WHERE provider_txn_id IS NOT NULL`,
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

/** Seed hạn mức + PayOS credentials + checksum key + miniapp_url. */
async function seedConfig(): Promise<void> {
  const entries: Array<[string, string]> = [
    ['min_deposit', '20000'],
    ['max_deposit', '100000000'],
    ['payos_client_id', CLIENT_ID],
    ['payos_api_key', API_KEY],
    ['payos_checksum_key', CHECKSUM_KEY],
    ['miniapp_url', MINIAPP_URL],
  ]
  for (const [key, value] of entries) {
    await env.DB.prepare('INSERT INTO system_config (key, value) VALUES (?, ?)')
      .bind(key, value)
      .run()
  }
}

async function seedUser(balance: number): Promise<{ id: number; telegramId: number }> {
  const telegramId = Math.floor(Math.random() * 2_000_000_000)
  await env.DB.prepare(
    "INSERT INTO users (telegram_id, username, first_name, balance, region, language, created_at, updated_at) VALUES (?, 'e2euser', 'E2E', ?, 'vietnam', 'vi', datetime('now'), datetime('now'))"
  )
    .bind(telegramId, balance)
    .run()
  const row = await env.DB.prepare('SELECT id FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<{ id: number }>()
  return { id: row!.id, telegramId }
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
  correlation_ref: string | null
  provider_txn_id: string | null
}> {
  const row = await env.DB.prepare(
    'SELECT status, amount, correlation_ref, provider_txn_id FROM deposits WHERE id = ?'
  )
    .bind(depositId)
    .first<{
      status: string
      amount: number
      correlation_ref: string | null
      provider_txn_id: string | null
    }>()
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

// --- Env bindings + ctx cho app.request ---

function getEnvBindings() {
  return {
    DB: env.DB,
    BOT_TOKEN: 'test-bot-token',
    TELEGRAM_SECRET_TOKEN: 'test-telegram-secret',
    ADMIN_IDS: '123456789',
    JWT_SECRET: 'test-jwt-secret',
    // PAYOS_* cố tình KHÔNG set ở env → credentials chỉ đến từ system_config (DB-first).
  }
}

function getExecutionCtx() {
  return {
    waitUntil: (_promise: Promise<unknown>) => {},
    passThroughOnException: () => {},
  }
}

function testEnv() {
  return getEnvBindings() as never
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

/**
 * Mock fetch điều phối theo URL: PayOS `createPaymentLink` (api-merchant.payos.vn) trả
 * link thành công; mọi URL khác (Telegram sendMessage cho notify) trả ok. `paymentLinkId`
 * duy nhất để khớp idempotency theo provider_txn_id.
 */
function stubFetchDispatch(): void {
  let counter = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      const href = typeof url === 'string' ? url : (url as Request).url
      if (href.includes('payos.vn')) {
        counter += 1
        return new Response(
          JSON.stringify({
            code: '00',
            desc: 'success',
            data: {
              checkoutUrl: `https://pay.payos.vn/web/link-${counter}`,
              qrCode: `qr-data-${counter}`,
              paymentLinkId: `plink-${counter}-${Math.floor(Math.random() * 1_000_000)}`,
            },
          }),
          { status: 200 }
        )
      }
      // Telegram notify hoặc khác → ok.
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    })
  )
}

beforeEach(async () => {
  await applySchema()
  await cleanTables()
  stubFetchDispatch()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PayOS end-to-end: createDeposit -> webhook credit (idempotent by paymentLinkId)', () => {
  /**
   * **Validates: Requirements 17.4**
   * Tạo deposit qua provider rồi webhook hợp lệ cộng đúng VND một lần; gửi lại CÙNG
   * callback nhiều lần không cộng trùng (no-op -> 200, balance không đổi, 1 transaction).
   */
  it('credits exactly once and repeated callbacks do not double-credit', async () => {
    const initialBalance = 50_000
    const amount = 250_000
    await seedConfig()
    const user = await seedUser(initialBalance)

    // 1) Tạo deposit qua provider (stub fetch trả payment link).
    const created = await payOsProvider.createDeposit({
      db: env.DB,
      env: testEnv(),
      userId: user.id,
      telegramId: user.telegramId,
      rawAmount: amount,
      lang: 'vi',
      channel: 'miniapp',
    })

    expect(created.success).toBe(true)
    if (!created.success) return
    const { depositId, payos } = created.output
    expect(payos).toBeDefined()
    const orderCode = String(payos!.orderCode)
    const paymentLinkId = payos!.paymentLinkId

    // Deposit pending với correlation_ref=orderCode, provider_txn_id=paymentLinkId.
    const beforeDep = await getDeposit(depositId)
    expect(beforeDep.status).toBe('pending')
    expect(beforeDep.correlation_ref).toBe(orderCode)
    expect(beforeDep.provider_txn_id).toBe(paymentLinkId)
    expect(await getUserBalance(user.id)).toBe(initialBalance)

    // 2) Webhook success hợp lệ → cộng đúng amount VND, deposit -> completed.
    const data: Record<string, unknown> = {
      orderCode,
      paymentLinkId,
      amount,
      code: '00',
      desc: 'success',
      accountNumber: '0123456789',
      reference: 'ref-e2e-001',
    }
    const signature = await signPayOsData(data, CHECKSUM_KEY)
    const webhookBody = { code: '00', data, signature }

    const res1 = await sendWebhook(webhookBody)
    expect(res1.status).toBe(200)
    expect(await res1.json()).toEqual({ success: true })

    expect(await getUserBalance(user.id)).toBe(initialBalance + amount)
    const afterDep = await getDeposit(depositId)
    expect(afterDep.status).toBe('completed')
    expect(afterDep.amount).toBe(amount)
    expect(await countDepositTx(user.id)).toBe(1)

    // 3) Gửi lại CÙNG callback nhiều lần → idempotent, không cộng trùng.
    for (let i = 0; i < 3; i++) {
      const resN = await sendWebhook(webhookBody)
      expect(resN.status).toBe(200)
      expect(await resN.json()).toEqual({ success: true })
    }

    // Balance không đổi, deposit vẫn completed, vẫn chỉ một transaction.
    expect(await getUserBalance(user.id)).toBe(initialBalance + amount)
    expect((await getDeposit(depositId)).status).toBe('completed')
    expect(await countDepositTx(user.id)).toBe(1)
  })
})
