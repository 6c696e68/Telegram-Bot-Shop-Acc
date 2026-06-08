import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { payOsProvider } from '../src/services/payments/payos-provider'

/**
 * Property-based tests cho `payos-provider.ts` (`payOsProvider.createDeposit`).
 *
 * Dùng D1 thật qua @cloudflare/vitest-pool-workers (bảng `users`/`deposits`/`system_config`
 * tự khai theo schema provider-agnostic `0014`, gồm partial unique index
 * `(provider, correlation_ref)` + `(provider, provider_txn_id)`). Mock global `fetch`
 * cho PayOS `createPaymentLink`: trả link thành công (success-path) hoặc fail (Property 20).
 *
 * Validates:
 *  - Property 11: Order codes are unique and distinct from deposit ids — Requirements 8.1
 *  - Property 12: Successful PayOS creation round-trips correlation and link id — Requirements 8.2, 8.3, 13.1
 *  - Property 13: Return/cancel URLs use configured miniapp_url — Requirements 8.4, 8.5
 *  - Property 14: Invalid amounts are rejected without creating a deposit — Requirements 8.6, 9.1, 9.2
 *  - Property 15: Deposit policy is enforced before creation — Requirements 9.3
 *  - Property 20: Orphan pending deposit is cleaned up on link-creation failure — Requirements 14.1, 14.2
 */

const MINIAPP_URL = 'https://miniapp.example.com/app'

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
  await env.DB.prepare('DELETE FROM deposits').run()
  await env.DB.prepare('DELETE FROM users').run()
  await env.DB.prepare('DELETE FROM system_config').run()
}

/** Seed hạn mức + PayOS config + (mặc định) miniapp_url. */
async function seedConfig(opts: { miniAppUrl?: string | null } = {}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO system_config (key, value) VALUES
       ('min_deposit', '20000'),
       ('max_deposit', '100000000'),
       ('payos_client_id', 'test-client-id'),
       ('payos_api_key', 'test-api-key'),
       ('payos_checksum_key', 'test-checksum-key')`
  ).run()
  const url = opts.miniAppUrl === undefined ? MINIAPP_URL : opts.miniAppUrl
  if (url) {
    await env.DB.prepare("INSERT INTO system_config (key, value) VALUES ('miniapp_url', ?)")
      .bind(url)
      .run()
  }
}

async function seedUser(): Promise<{ id: number; telegramId: number }> {
  const telegramId = Math.floor(Math.random() * 2_000_000_000)
  await env.DB.prepare(
    "INSERT INTO users (telegram_id, username, first_name, balance, region, language, created_at, updated_at) VALUES (?, 'u', 'U', 0, 'vietnam', 'vi', datetime('now'), datetime('now'))"
  )
    .bind(telegramId)
    .run()
  const row = await env.DB.prepare('SELECT id FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<{ id: number }>()
  return { id: row!.id, telegramId }
}

async function depositCount(userId: number): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM deposits WHERE user_id = ?')
    .bind(userId)
    .first<{ c: number }>()
  return row!.c
}

function testEnv() {
  return {
    DB: env.DB,
    BOT_TOKEN: 'test-bot-token',
    TELEGRAM_SECRET_TOKEN: 'x',
    ADMIN_IDS: '1',
    JWT_SECRET: 'x',
    PAYOS_CLIENT_ID: 'test-client-id',
    PAYOS_API_KEY: 'test-api-key',
    PAYOS_CHECKSUM_KEY: 'test-checksum-key',
  } as never
}

/**
 * Mock fetch trả về một payment link thành công với `paymentLinkId` duy nhất mỗi lần
 * (tránh đụng partial unique index `(provider, provider_txn_id)` khi tạo nhiều deposit).
 * Trả thêm hàm đọc lại request body gần nhất.
 */
function stubFetchSuccess(): { lastBody: () => Record<string, unknown> | undefined } {
  let counter = 0
  let captured: Record<string, unknown> | undefined
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      counter += 1
      captured = JSON.parse(init.body as string) as Record<string, unknown>
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
    })
  )
  return { lastBody: () => captured }
}

beforeEach(async () => {
  await applySchema()
  await cleanTables()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const validAmountArb = fc.integer({ min: 20_000, max: 5_000_000 })

describe('payos-provider — Property 11: order codes are unique and distinct from deposit ids', () => {
  /** **Validates: Requirements 8.1** */
  it('orderCode (correlation_ref) is unique across many createDeposit calls and never equals deposits.id', async () => {
    await seedConfig()
    stubFetchSuccess()

    const orderCodes: number[] = []

    await fc.assert(
      fc.asyncProperty(validAmountArb, async (amount) => {
        // Fresh user mỗi lần để không bị chặn bởi cooldown / trần pending (giữ deposits tích luỹ).
        const user = await seedUser()
        const result = await payOsProvider.createDeposit({
          db: env.DB,
          env: testEnv(),
          userId: user.id,
          telegramId: user.telegramId,
          rawAmount: amount,
          lang: 'vi',
          channel: 'bot',
        })

        expect(result.success).toBe(true)
        if (!result.success) return
        const { depositId, payos } = result.output
        expect(payos).toBeDefined()
        // orderCode KHÁC deposits.id (R8.1).
        expect(payos!.orderCode).not.toBe(depositId)
        orderCodes.push(payos!.orderCode)
      }),
      { numRuns: 40 }
    )

    // Mọi orderCode phân biệt nhau (duy nhất).
    expect(new Set(orderCodes).size).toBe(orderCodes.length)
  })
})

describe('payos-provider — Property 12: successful creation round-trips correlation and link id', () => {
  /** **Validates: Requirements 8.2, 8.3, 13.1** */
  it('on success correlation_ref==orderCode, provider_txn_id==paymentLinkId, output mirrors the link', async () => {
    await fc.assert(
      fc.asyncProperty(validAmountArb, async (amount) => {
        await cleanTables()
        await seedConfig()
        const fetchSpy = stubFetchSuccess()
        const user = await seedUser()

        const result = await payOsProvider.createDeposit({
          db: env.DB,
          env: testEnv(),
          userId: user.id,
          telegramId: user.telegramId,
          rawAmount: amount,
          lang: 'vi',
          channel: 'bot',
        })

        expect(result.success).toBe(true)
        if (!result.success) return
        const { depositId, payos } = result.output
        expect(payos).toBeDefined()

        // Output round-trips dữ liệu link đã mock.
        const sentBody = fetchSpy.lastBody()
        expect(payos!.orderCode).toBe(sentBody!.orderCode)
        expect(payos!.amountVnd).toBe(amount)
        expect(payos!.checkoutUrl).toBeTruthy()
        expect(payos!.paymentLinkId).toBeTruthy()

        // Cột chung lưu đúng: correlation_ref == orderCode, provider_txn_id == paymentLinkId.
        const row = await env.DB.prepare(
          `SELECT correlation_ref, provider_txn_id, status,
                  json_extract(metadata, '$.checkoutUrl') AS checkout_url,
                  json_extract(metadata, '$.qrCode') AS qr_code
           FROM deposits WHERE id = ?`
        )
          .bind(depositId)
          .first<{
            correlation_ref: string | null
            provider_txn_id: string | null
            status: string
            checkout_url: string | null
            qr_code: string | null
          }>()

        expect(row!.status).toBe('pending')
        expect(row!.correlation_ref).toBe(String(payos!.orderCode))
        expect(row!.provider_txn_id).toBe(payos!.paymentLinkId)
        expect(row!.checkout_url).toBe(payos!.checkoutUrl)
        expect(row!.qr_code).toBe(payos!.qrCode)
      }),
      { numRuns: 30 }
    )
  })
})

describe('payos-provider — Property 13: return/cancel URLs use configured miniapp_url', () => {
  /** **Validates: Requirements 8.4, 8.5** */
  it('returnUrl and cancelUrl sent to PayOS both equal the configured miniapp_url', async () => {
    await fc.assert(
      fc.asyncProperty(validAmountArb, fc.webUrl(), async (amount, miniAppUrl) => {
        await cleanTables()
        await seedConfig({ miniAppUrl })
        const fetchSpy = stubFetchSuccess()
        const user = await seedUser()

        const result = await payOsProvider.createDeposit({
          db: env.DB,
          env: testEnv(),
          userId: user.id,
          telegramId: user.telegramId,
          rawAmount: amount,
          lang: 'vi',
          channel: 'miniapp',
        })

        expect(result.success).toBe(true)
        if (!result.success) return

        const sentBody = fetchSpy.lastBody()
        expect(sentBody).toBeDefined()
        expect(sentBody!.returnUrl).toBe(miniAppUrl)
        expect(sentBody!.cancelUrl).toBe(miniAppUrl)
      }),
      { numRuns: 30 }
    )
  })

  /** **Validates: Requirements 8.5** — miniapp_url chưa cấu hình → không tạo deposit, lỗi provider. */
  it('when miniapp_url is empty/unset, no deposit is created and a provider_error is returned', async () => {
    await fc.assert(
      fc.asyncProperty(validAmountArb, async (amount) => {
        await cleanTables()
        await seedConfig({ miniAppUrl: null })
        const fetchSpy = stubFetchSuccess()
        const user = await seedUser()

        const result = await payOsProvider.createDeposit({
          db: env.DB,
          env: testEnv(),
          userId: user.id,
          telegramId: user.telegramId,
          rawAmount: amount,
          lang: 'vi',
          channel: 'bot',
        })

        expect(result.success).toBe(false)
        if (result.success) return
        expect(result.error.type).toBe('provider_error')

        // Không tạo deposit và không gọi PayOS (đọc miniapp_url trước khi INSERT).
        expect(await depositCount(user.id)).toBe(0)
        expect(fetchSpy.lastBody()).toBeUndefined()
      }),
      { numRuns: 25 }
    )
  })
})

describe('payos-provider — Property 14: invalid amounts are rejected without creating a deposit', () => {
  const invalidAmountArb = fc.oneof(
    fc.integer({ min: -1_000_000, max: 0 }), // không dương
    fc.integer({ min: 1, max: 1_000_000 }).map((n) => n + 0.5) // không nguyên
  )

  /** **Validates: Requirements 8.6, 9.1, 9.2** */
  it('non-integer / non-positive amounts are rejected and no deposit row is created', async () => {
    await fc.assert(
      fc.asyncProperty(invalidAmountArb, async (amount) => {
        await cleanTables()
        await seedConfig()
        const fetchSpy = stubFetchSuccess()
        const user = await seedUser()

        const result = await payOsProvider.createDeposit({
          db: env.DB,
          env: testEnv(),
          userId: user.id,
          telegramId: user.telegramId,
          rawAmount: amount,
          lang: 'vi',
          channel: 'bot',
        })

        expect(result.success).toBe(false)
        if (result.success) return
        expect(result.error.type).toBe('limit')

        // Không tạo deposit, không gọi PayOS.
        expect(await depositCount(user.id)).toBe(0)
        expect(fetchSpy.lastBody()).toBeUndefined()
      }),
      { numRuns: 40 }
    )
  })
})

describe('payos-provider — Property 15: deposit policy is enforced before creation', () => {
  /** **Validates: Requirements 9.3** */
  it('when the pending cap is reached, no new deposit is created', async () => {
    await fc.assert(
      fc.asyncProperty(validAmountArb, async (amount) => {
        await cleanTables()
        await seedConfig()
        const fetchSpy = stubFetchSuccess()
        const user = await seedUser()

        // Seed 3 pending deposits còn hiệu lực → chạm trần MAX_PENDING_DEPOSITS.
        for (let i = 0; i < 3; i++) {
          await env.DB.prepare(
            "INSERT INTO deposits (user_id, provider, correlation_ref, amount, status, created_at) VALUES (?, 'payos', ?, ?, 'pending', datetime('now'))"
          )
            .bind(user.id, `seed-${user.id}-${i}`, 50_000)
            .run()
        }
        const before = await depositCount(user.id)
        expect(before).toBe(3)

        const result = await payOsProvider.createDeposit({
          db: env.DB,
          env: testEnv(),
          userId: user.id,
          telegramId: user.telegramId,
          rawAmount: amount,
          lang: 'vi',
          channel: 'bot',
        })

        expect(result.success).toBe(false)
        if (result.success) return
        expect(result.error.type).toBe('policy')

        // Không tạo deposit mới, không gọi PayOS.
        expect(await depositCount(user.id)).toBe(before)
        expect(fetchSpy.lastBody()).toBeUndefined()
      }),
      { numRuns: 25 }
    )
  })
})

describe('payos-provider — Property 20: orphan pending deposit is cleaned up on link-creation failure', () => {
  /** **Validates: Requirements 14.1, 14.2** */
  it('when createPaymentLink fails, the pending orphan deposit (provider_txn_id IS NULL) is deleted', async () => {
    /** Các chế độ thất bại của createPaymentLink. */
    type FailMode = 'http' | 'code' | 'network' | 'abort'
    const failModeArb = fc.constantFrom<FailMode>('http', 'code', 'network', 'abort')

    await fc.assert(
      fc.asyncProperty(validAmountArb, failModeArb, async (amount, mode) => {
        await cleanTables()
        await seedConfig()
        const user = await seedUser()

        vi.stubGlobal(
          'fetch',
          vi.fn(async () => {
            switch (mode) {
              case 'http':
                return new Response(JSON.stringify({ code: '00', data: {} }), { status: 500 })
              case 'code':
                return new Response(JSON.stringify({ code: '99', desc: 'biz error' }), { status: 200 })
              case 'network':
                throw new Error('network down')
              case 'abort': {
                const e = new Error('aborted')
                e.name = 'AbortError'
                throw e
              }
            }
          })
        )

        const result = await payOsProvider.createDeposit({
          db: env.DB,
          env: testEnv(),
          userId: user.id,
          telegramId: user.telegramId,
          rawAmount: amount,
          lang: 'vi',
          channel: 'bot',
        })

        expect(result.success).toBe(false)
        if (result.success) return
        expect(result.error.type).toBe('provider_error')

        // Deposit mồ côi (pending, provider_txn_id NULL) đã bị dọn → không còn hàng nào.
        expect(await depositCount(user.id)).toBe(0)
        const orphans = await env.DB.prepare(
          "SELECT COUNT(*) AS c FROM deposits WHERE user_id = ? AND status = 'pending' AND provider_txn_id IS NULL"
        )
          .bind(user.id)
          .first<{ c: number }>()
        expect(orphans!.c).toBe(0)
      }),
      { numRuns: 30 }
    )
  })
})
