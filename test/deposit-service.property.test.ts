import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { completeDeposit, markAwaitingCredit } from '../src/services/deposit-service'

/**
 * Property-based tests cho DepositService.completeDeposit.
 *
 * Target: src/services/deposit-service.ts (completeDeposit). Dùng D1 thật qua
 * @cloudflare/vitest-pool-workers (miniflare) — khớp convention setup schema + env.DB
 * như test/transaction.property.test.ts và test/user-locale-lang.property.test.ts.
 *
 * Validates: Requirements 11.2, 14.3, 14.4
 *  - Property 1: Cộng tiền đúng một lần (gọi completeDeposit lặp/đồng thời cho cùng
 *    deposit → tổng VND cộng vào users.balance đúng đúng 1 lần creditVnd; số lần
 *    success===true đúng 1).
 *  - Property 2: Số dư không âm (users.balance luôn >= 0 sau mọi thao tác).
 */

// --- Schema: phản chiếu migration 0008 (deposits rebuild đa provider) + users + transactions ---

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
}

async function seedUser(balance: number): Promise<number> {
  const telegramId = Math.floor(Math.random() * 2_000_000_000)
  await env.DB.prepare(
    "INSERT INTO users (telegram_id, username, first_name, balance, created_at, updated_at) VALUES (?, 'testuser', 'Test', ?, datetime('now'), datetime('now'))"
  )
    .bind(telegramId, balance)
    .run()
  const row = await env.DB.prepare('SELECT id FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<{ id: number }>()
  return row!.id
}

/** Seed deposit pending cho provider tương ứng; trả về deposits.id. */
async function seedDeposit(
  userId: number,
  amount: number,
  provider: 'sepay' | 'cryptobot'
): Promise<number> {
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`.toUpperCase()
  if (provider === 'sepay') {
    await env.DB.prepare(
      "INSERT INTO deposits (user_id, provider, amount, status, correlation_ref, created_at) VALUES (?, 'sepay', ?, 'pending', ?, datetime('now'))"
    )
      .bind(userId, amount, `NAP${unique}`)
      .run()
  } else {
    await env.DB.prepare(
      "INSERT INTO deposits (user_id, provider, amount, status, correlation_ref, metadata, created_at) VALUES (?, 'cryptobot', ?, 'pending', ?, ?, datetime('now'))"
    )
      .bind(userId, amount, `INV${unique}`, JSON.stringify({ asset: 'USDT' }))
      .run()
  }
  const row = await env.DB.prepare('SELECT MAX(id) as id FROM deposits').first<{ id: number }>()
  return row!.id
}

async function getUserBalance(userId: number): Promise<number> {
  const row = await env.DB.prepare('SELECT balance FROM users WHERE id = ?')
    .bind(userId)
    .first<{ balance: number }>()
  return row!.balance
}

/** Build input completeDeposit theo provider (kèm trường đặc thù). */
function buildInput(
  depositId: number,
  userId: number,
  creditVnd: number,
  provider: 'sepay' | 'cryptobot'
) {
  if (provider === 'sepay') {
    return {
      db: env.DB,
      depositId,
      userId,
      creditVnd,
      provider,
      providerTxnId: `SEP${depositId}`,
    } as const
  }
  return {
    db: env.DB,
    depositId,
    userId,
    creditVnd,
    provider,
    providerTxnId: `INV${depositId}`,
    correlationRef: `INV${depositId}`,
    metadata: { asset: 'USDT', usdt_amount: '10.5', exchange_rate: 26000 },
  } as const
}

beforeEach(async () => {
  await applySchema()
  await cleanTables()
})

// Generators
const arbInitialBalance = fc.integer({ min: 0, max: 10_000_000 })
const arbCreditVnd = fc.integer({ min: 1, max: 100_000_000 })
const arbRepeat = fc.integer({ min: 2, max: 6 })

// Feature: multi-region-payments, Property 1
describe('Property 1: Cộng tiền đúng một lần', () => {
  /**
   * **Validates: Requirements 11.2, 14.4**
   * Gọi completeDeposit LẶP (tuần tự) cho cùng deposit → users.balance chỉ tăng đúng
   * một lần creditVnd; số lần success===true đúng 1; các lần sau trả 'already_processed'.
   */
  for (const provider of ['sepay', 'cryptobot'] as const) {
    it(`[${provider}] repeated sequential calls credit exactly once`, async () => {
      await fc.assert(
        fc.asyncProperty(
          arbInitialBalance,
          arbCreditVnd,
          arbRepeat,
          async (initialBalance, creditVnd, repeat) => {
            await cleanTables()
            const userId = await seedUser(initialBalance)
            const depositId = await seedDeposit(userId, creditVnd, provider)

            const results = []
            for (let i = 0; i < repeat; i++) {
              results.push(await completeDeposit(buildInput(depositId, userId, creditVnd, provider)))
            }

            const successCount = results.filter((r) => r.success).length
            expect(successCount).toBe(1)

            // Các lần dư phải là 'already_processed' (chống cộng trùng — R14.2).
            const reprocessed = results.filter(
              (r) => !r.success && r.error === 'already_processed'
            ).length
            expect(reprocessed).toBe(repeat - 1)

            const finalBalance = await getUserBalance(userId)
            expect(finalBalance).toBe(initialBalance + creditVnd)
            expect(finalBalance).toBeGreaterThanOrEqual(0)
          }
        ),
        { numRuns: 40 }
      )
    })
  }

  /**
   * **Validates: Requirements 11.2, 14.4**
   * Gọi completeDeposit ĐỒNG THỜI (Promise.all) cho cùng deposit → đúng một lần cộng;
   * exactly một success; balance == initial + creditVnd.
   */
  for (const provider of ['sepay', 'cryptobot'] as const) {
    it(`[${provider}] concurrent calls credit exactly once`, async () => {
      await fc.assert(
        fc.asyncProperty(
          arbInitialBalance,
          arbCreditVnd,
          arbRepeat,
          async (initialBalance, creditVnd, concurrency) => {
            await cleanTables()
            const userId = await seedUser(initialBalance)
            const depositId = await seedDeposit(userId, creditVnd, provider)

            const results = await Promise.all(
              Array.from({ length: concurrency }, () =>
                completeDeposit(buildInput(depositId, userId, creditVnd, provider))
              )
            )

            const successCount = results.filter((r) => r.success).length
            expect(successCount).toBe(1)

            const finalBalance = await getUserBalance(userId)
            expect(finalBalance).toBe(initialBalance + creditVnd)
            expect(finalBalance).toBeGreaterThanOrEqual(0)
          }
        ),
        { numRuns: 40 }
      )
    })
  }
})

// Feature: multi-region-payments, Property 2
describe('Property 2: Số dư không âm', () => {
  /**
   * **Validates: Requirements 14.3**
   * Sau mọi thao tác nạp (gồm lặp/đồng thời, mọi creditVnd hợp lệ, balance khởi tạo bất kỳ),
   * users.balance luôn >= 0.
   */
  for (const provider of ['sepay', 'cryptobot'] as const) {
    it(`[${provider}] balance stays >= 0 after any sequence of deposit operations`, async () => {
      await fc.assert(
        fc.asyncProperty(
          arbInitialBalance,
          arbCreditVnd,
          arbRepeat,
          fc.boolean(), // concurrent?
          async (initialBalance, creditVnd, repeat, concurrent) => {
            await cleanTables()
            const userId = await seedUser(initialBalance)
            const depositId = await seedDeposit(userId, creditVnd, provider)

            if (concurrent) {
              await Promise.all(
                Array.from({ length: repeat }, () =>
                  completeDeposit(buildInput(depositId, userId, creditVnd, provider))
                )
              )
            } else {
              for (let i = 0; i < repeat; i++) {
                await completeDeposit(buildInput(depositId, userId, creditVnd, provider))
              }
            }

            const finalBalance = await getUserBalance(userId)
            expect(finalBalance).toBeGreaterThanOrEqual(0)
          }
        ),
        { numRuns: 40 }
      )
    })
  }
})

// --- Helpers cho Property 5/6/7 (deposit-service tổng quát hoá) ---

/** Đếm số transaction 'deposit' tham chiếu một deposit cụ thể. */
async function countDepositTransactions(depositId: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM transactions WHERE type = 'deposit' AND reference_type = 'deposit' AND reference_id = ?"
  )
    .bind(depositId)
    .first<{ c: number }>()
  return row!.c
}

/** Đọc nguyên dòng deposit (cột chung). */
async function getDepositRow(depositId: number): Promise<{
  status: string
  provider: string
  provider_txn_id: string | null
  correlation_ref: string | null
  metadata: string | null
  amount: number
}> {
  const row = await env.DB.prepare(
    'SELECT status, provider, provider_txn_id, correlation_ref, metadata, amount FROM deposits WHERE id = ?'
  )
    .bind(depositId)
    .first<{
      status: string
      provider: string
      provider_txn_id: string | null
      correlation_ref: string | null
      metadata: string | null
      amount: number
    }>()
  return row!
}

/** Seed deposit với status tuỳ ý (phục vụ Property 7). Trả về deposits.id. */
async function seedDepositWithStatus(
  userId: number,
  amount: number,
  status: 'pending' | 'completed' | 'expired' | 'cancelled' | 'awaiting_credit'
): Promise<number> {
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`.toUpperCase()
  const completedAt = status === 'completed' ? new Date().toISOString() : null
  await env.DB.prepare(
    "INSERT INTO deposits (user_id, provider, amount, status, correlation_ref, completed_at, created_at) VALUES (?, 'payos', ?, ?, ?, ?, datetime('now'))"
  )
    .bind(userId, amount, status, `ORD${unique}`, completedAt)
    .run()
  const row = await env.DB.prepare('SELECT MAX(id) as id FROM deposits').first<{ id: number }>()
  return row!.id
}

// Feature: payos-deposit, Property 5
describe('Property 5: completeDeposit credits exactly once', () => {
  /**
   * **Validates: Requirements 4.2, 12.9, 13.4**
   * Với một deposit và bất kỳ số lần gọi completeDeposit lặp hoặc đồng thời tham chiếu nó,
   * users.balance chỉ tăng đúng một lần creditVnd VÀ chỉ đúng MỘT transaction 'deposit'
   * được ghi (không sinh giao dịch ma ở các lần gọi trùng).
   */
  for (const provider of ['sepay', 'cryptobot'] as const) {
    it(`[${provider}] repeated/concurrent calls credit exactly once and record exactly one transaction`, async () => {
      await fc.assert(
        fc.asyncProperty(
          arbInitialBalance,
          arbCreditVnd,
          arbRepeat,
          fc.boolean(), // concurrent?
          async (initialBalance, creditVnd, repeat, concurrent) => {
            await cleanTables()
            const userId = await seedUser(initialBalance)
            const depositId = await seedDeposit(userId, creditVnd, provider)

            let results
            if (concurrent) {
              results = await Promise.all(
                Array.from({ length: repeat }, () =>
                  completeDeposit(buildInput(depositId, userId, creditVnd, provider))
                )
              )
            } else {
              results = []
              for (let i = 0; i < repeat; i++) {
                results.push(
                  await completeDeposit(buildInput(depositId, userId, creditVnd, provider))
                )
              }
            }

            // Đúng MỘT lần success.
            const successCount = results.filter((r) => r.success).length
            expect(successCount).toBe(1)

            // Balance tăng đúng một lần creditVnd.
            const finalBalance = await getUserBalance(userId)
            expect(finalBalance).toBe(initialBalance + creditVnd)

            // Đúng MỘT transaction 'deposit' được ghi cho deposit này.
            const txCount = await countDepositTransactions(depositId)
            expect(txCount).toBe(1)
          }
        ),
        { numRuns: 40 }
      )
    })
  }
})

// Feature: payos-deposit, Property 6
describe('Property 6: completeDeposit persists provider fields via common columns', () => {
  /**
   * **Validates: Requirements 4.1**
   * Với mọi completeDeposit kèm providerTxnId/correlationRef/metadata, dòng deposit hoàn tất
   * lưu các giá trị đó vào cột chung provider_txn_id/correlation_ref/metadata, status thành
   * 'completed', amount == creditVnd, và metadata JSON round-trip nguyên vẹn.
   */
  it('persists provider_txn_id/correlation_ref/metadata into common columns and metadata round-trips', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInitialBalance,
        arbCreditVnd,
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.record({
          asset: fc.constantFrom('USDT', 'USDC', 'TON'),
          usdt_amount: fc.float({ min: Math.fround(0.01), max: 100000, noNaN: true }).map((n) => String(n)),
          exchange_rate: fc.integer({ min: 1, max: 100000 }),
          note: fc.string({ maxLength: 50 }),
        }),
        async (initialBalance, creditVnd, providerTxnId, correlationRef, metadata) => {
          await cleanTables()
          const userId = await seedUser(initialBalance)
          // provider 'payos' không CHECK → dùng để kiểm cột chung không phụ thuộc provider.
          const depositId = await seedDepositWithStatus(userId, creditVnd, 'pending')

          const result = await completeDeposit({
            db: env.DB,
            depositId,
            userId,
            creditVnd,
            provider: 'payos',
            providerTxnId,
            correlationRef,
            metadata,
          })

          expect(result.success).toBe(true)

          const row = await getDepositRow(depositId)
          expect(row.status).toBe('completed')
          expect(row.amount).toBe(creditVnd)
          expect(row.provider_txn_id).toBe(providerTxnId)
          expect(row.correlation_ref).toBe(correlationRef)

          // metadata JSON round-trips.
          expect(row.metadata).not.toBeNull()
          const parsed = JSON.parse(row.metadata as string)
          expect(parsed).toEqual(metadata)
        }
      ),
      { numRuns: 40 }
    )
  })
})

// Feature: payos-deposit, Property 7
describe('Property 7: markAwaitingCredit only affects creditable deposits', () => {
  /**
   * **Validates: Requirements 4.3**
   * markAwaitingCredit lưu metadata và đặt status 'awaiting_credit' CHỈ khi deposit đang
   * 'pending' hoặc 'expired'; KHÔNG bao giờ ghi đè deposit 'completed'/'cancelled'/
   * 'awaiting_credit' (giữ nguyên status + metadata cũ).
   */
  const arbStatus = fc.constantFrom(
    'pending',
    'completed',
    'expired',
    'cancelled',
    'awaiting_credit'
  ) as fc.Arbitrary<'pending' | 'completed' | 'expired' | 'cancelled' | 'awaiting_credit'>

  it('transitions to awaiting_credit only from pending/expired, never overwrites others', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInitialBalance,
        arbCreditVnd,
        arbStatus,
        fc.record({
          usdt_amount: fc
            .float({ min: Math.fround(0.01), max: 100000, noNaN: true })
            .map((n) => String(n)),
        }),
        async (initialBalance, creditVnd, initialStatus, metadata) => {
          await cleanTables()
          const userId = await seedUser(initialBalance)
          const depositId = await seedDepositWithStatus(userId, creditVnd, initialStatus)

          await markAwaitingCredit(env.DB, depositId, metadata)

          const row = await getDepositRow(depositId)
          if (initialStatus === 'pending' || initialStatus === 'expired') {
            // Chỉ các trạng thái creditable mới chuyển sang awaiting_credit + ghi metadata.
            expect(row.status).toBe('awaiting_credit')
            expect(row.metadata).not.toBeNull()
            expect(JSON.parse(row.metadata as string)).toEqual(metadata)
          } else {
            // completed/cancelled/awaiting_credit: giữ nguyên status, KHÔNG ghi metadata mới.
            expect(row.status).toBe(initialStatus)
            expect(row.metadata).toBeNull()
          }
        }
      ),
      { numRuns: 40 }
    )
  })
})
