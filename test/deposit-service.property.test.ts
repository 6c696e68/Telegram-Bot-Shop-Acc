import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { completeDeposit } from '../src/services/deposit-service'

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
    provider TEXT NOT NULL DEFAULT 'sepay' CHECK(provider IN ('sepay','cryptobot')),
    amount INTEGER NOT NULL CHECK(amount > 0),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','completed','expired','cancelled','awaiting_credit')),
    transfer_code TEXT,
    sepay_transaction_id TEXT,
    bank_ref TEXT,
    crypto_invoice_id TEXT,
    asset TEXT,
    usdt_amount TEXT,
    exchange_rate INTEGER,
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
      "INSERT INTO deposits (user_id, provider, amount, status, transfer_code, created_at) VALUES (?, 'sepay', ?, 'pending', ?, datetime('now'))"
    )
      .bind(userId, amount, `NAP${unique}`)
      .run()
  } else {
    await env.DB.prepare(
      "INSERT INTO deposits (user_id, provider, amount, status, crypto_invoice_id, asset, created_at) VALUES (?, 'cryptobot', ?, 'pending', ?, 'USDT', datetime('now'))"
    )
      .bind(userId, amount, `INV${unique}`)
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
      sepayTransactionId: `SEP${depositId}`,
    } as const
  }
  return {
    db: env.DB,
    depositId,
    userId,
    creditVnd,
    provider,
    cryptoInvoiceId: `INV${depositId}`,
    usdtAmount: '10.5',
    exchangeRate: 26000,
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
