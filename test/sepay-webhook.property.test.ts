import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { app } from '../src/index'
import { cleanThreeTierTables, resetThreeTierSchema } from './helpers/three-tier-schema'

/**
 * Property-based tests cho SePay Webhook route.
 * **Validates: Requirements 2.10**
 *
 * Property 3: Deposit webhook idempotence — cùng webhook gửi lại
 * không thay đổi balance, return HTTP 200.
 */

const SEPAY_API_KEY = 'test-sepay-api-key-12345'

async function cleanTables(db: D1Database) {
  await cleanThreeTierTables(db)
}

async function seedUser(db: D1Database, balance: number): Promise<{ id: number; telegramId: number }> {
  const telegramId = Math.floor(Math.random() * 2_000_000_000)
  await db
    .prepare(
      "INSERT INTO users (telegram_id, username, first_name, balance, created_at, updated_at) VALUES (?, 'testuser', 'Test', ?, datetime('now'), datetime('now'))"
    )
    .bind(telegramId, balance)
    .run()
  const user = await db
    .prepare('SELECT id FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<{ id: number }>()
  return { id: user!.id, telegramId }
}

async function seedDeposit(db: D1Database, userId: number, transferCode: string, amount: number): Promise<number> {
  await db
    .prepare(
      "INSERT INTO deposits (user_id, correlation_ref, amount, status, created_at) VALUES (?, ?, ?, 'pending', datetime('now'))"
    )
    .bind(userId, transferCode, amount)
    .run()
  const dep = await db.prepare('SELECT MAX(id) as id FROM deposits').first<{ id: number }>()
  return dep!.id
}

async function getUserBalance(db: D1Database, userId: number): Promise<number> {
  const user = await db.prepare('SELECT balance FROM users WHERE id = ?').bind(userId).first<{ balance: number }>()
  return user!.balance
}

function buildSepayPayload(options: {
  id: number
  transferAmount: number
  content: string
}) {
  return {
    id: options.id,
    gateway: 'Vietcombank',
    transactionDate: '2024-07-02 11:08:33',
    accountNumber: '1017588888',
    subAccount: null,
    code: `SEVN${options.id}`,
    content: options.content,
    transferType: 'in' as const,
    description: 'Transfer',
    transferAmount: options.transferAmount,
    accumulated: 10_000_000,
    referenceCode: `FT${Date.now()}`,
  }
}

// Build env bindings for app.request()
function getEnvBindings() {
  return {
    DB: env.DB,
    SEPAY_API_KEY,
    BOT_TOKEN: 'test-bot-token',
    TELEGRAM_SECRET_TOKEN: 'test-telegram-secret',
    ADMIN_IDS: '123456789',
    JWT_SECRET: 'test-jwt-secret',
    BANK_NAME: 'Vietcombank',
    BANK_ACCOUNT: '1017588888',
    BANK_OWNER: 'NGUYEN VAN TEST',
  }
}

// Mock ExecutionContext for Hono app.request()
function getExecutionCtx() {
  return {
    waitUntil: (_promise: Promise<unknown>) => {},
    passThroughOnException: () => {},
  }
}

// Helper to send a webhook request through the app
async function sendWebhook(payload: object) {
  return app.request('/webhook/sepay', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Apikey ${SEPAY_API_KEY}`,
    },
    body: JSON.stringify(payload),
  }, getEnvBindings() as any, getExecutionCtx() as any)
}

// Arbitrary: generate a valid SePay webhook id (positive integer)
const arbSepayId = fc.integer({ min: 1, max: 2_000_000_000 })

// Arbitrary: generate a transfer amount within valid range
const arbTransferAmount = fc.integer({ min: 20_000, max: 100_000_000 })

// Arbitrary: generate a valid transfer code (NAP + 4-17 alphanumeric)
const arbTransferCode = fc
  .stringOf(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')), {
    minLength: 4,
    maxLength: 10,
  })
  .map((s) => `NAP${s}`)

// Arbitrary: number of duplicate sends (2-5)
const arbDuplicateCount = fc.integer({ min: 2, max: 5 })

describe('Property 3: Deposit webhook idempotence', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    await resetThreeTierSchema(env.DB)
    await cleanTables(env.DB)

    // Mock global fetch to prevent real Telegram API calls
    mockFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * **Validates: Requirements 2.10**
   * Sending the same webhook payload multiple times should only increase
   * the user's balance once. Subsequent calls return HTTP 200 without
   * modifying balance (idempotent).
   */
  it('duplicate webhook sends do not change balance after first successful processing', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSepayId,
        arbTransferAmount,
        arbTransferCode,
        fc.integer({ min: 0, max: 5_000_000 }), // initialBalance
        arbDuplicateCount,
        async (sepayId, transferAmount, transferCode, initialBalance, duplicateCount) => {
          await cleanTables(env.DB)

          // Setup: create user and pending deposit
          const { id: userId } = await seedUser(env.DB, initialBalance)
          await seedDeposit(env.DB, userId, transferCode, transferAmount)

          // Build a single webhook payload
          const payload = buildSepayPayload({
            id: sepayId,
            transferAmount,
            content: `${transferCode} chuyen tien nap`,
          })

          // First call: should process the deposit
          const res1 = await sendWebhook(payload)

          expect(res1.status).toBe(200)
          const body1 = await res1.json()
          expect(body1).toEqual({ success: true })

          // Verify balance increased by exactly transferAmount
          const balanceAfterFirst = await getUserBalance(env.DB, userId)
          expect(balanceAfterFirst).toBe(initialBalance + transferAmount)

          // Send the same webhook N more times (duplicates)
          for (let i = 0; i < duplicateCount; i++) {
            const resN = await sendWebhook(payload)

            // Always returns HTTP 200 with { success: true }
            expect(resN.status).toBe(200)
            const bodyN = await resN.json()
            expect(bodyN).toEqual({ success: true })
          }

          // Final balance should equal initial + amount (NOT initial + N * amount)
          const finalBalance = await getUserBalance(env.DB, userId)
          expect(finalBalance).toBe(initialBalance + transferAmount)
        }
      ),
      { numRuns: 20 }
    )
  })

  /**
   * **Validates: Requirements 2.10**
   * Second call with same payload.id returns 200 without modifying balance.
   */
  it('second call with same payload.id returns 200 without modifying balance', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSepayId,
        arbTransferAmount,
        arbTransferCode,
        fc.integer({ min: 0, max: 10_000_000 }), // initialBalance
        async (sepayId, transferAmount, transferCode, initialBalance) => {
          await cleanTables(env.DB)

          const { id: userId } = await seedUser(env.DB, initialBalance)
          await seedDeposit(env.DB, userId, transferCode, transferAmount)

          const payload = buildSepayPayload({
            id: sepayId,
            transferAmount,
            content: `Chuyen tien ${transferCode}`,
          })

          // First call: processes successfully
          const res1 = await sendWebhook(payload)
          expect(res1.status).toBe(200)

          const balanceAfterFirst = await getUserBalance(env.DB, userId)
          expect(balanceAfterFirst).toBe(initialBalance + transferAmount)

          // Second call: same payload.id, should be idempotent
          const res2 = await sendWebhook(payload)

          expect(res2.status).toBe(200)
          const body2 = await res2.json()
          expect(body2).toEqual({ success: true })

          // Balance unchanged after duplicate
          const balanceAfterSecond = await getUserBalance(env.DB, userId)
          expect(balanceAfterSecond).toBe(balanceAfterFirst)
          expect(balanceAfterSecond).toBe(initialBalance + transferAmount)

          // Only 1 transaction record exists for this deposit
          const txCount = await env.DB
            .prepare("SELECT COUNT(*) as cnt FROM transactions WHERE user_id = ? AND type = 'deposit'")
            .bind(userId)
            .first<{ cnt: number }>()
          expect(txCount!.cnt).toBe(1)
        }
      ),
      { numRuns: 25 }
    )
  })

  /**
   * **Validates: Requirements 2.10**
   * Response is always { success: true } with HTTP 200 for valid auth
   * (regardless of whether the deposit was already processed).
   */
  it('response is always { success: true } with HTTP 200 for authenticated requests', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbSepayId,
        arbTransferAmount,
        arbTransferCode,
        async (sepayId, transferAmount, transferCode) => {
          await cleanTables(env.DB)

          const { id: userId } = await seedUser(env.DB, 0)
          await seedDeposit(env.DB, userId, transferCode, transferAmount)

          const payload = buildSepayPayload({
            id: sepayId,
            transferAmount,
            content: `${transferCode} nap tien`,
          })

          // Send webhook twice
          const res1 = await sendWebhook(payload)
          const res2 = await sendWebhook(payload)

          // Both return 200 with { success: true }
          expect(res1.status).toBe(200)
          expect(await res1.json()).toEqual({ success: true })
          expect(res2.status).toBe(200)
          expect(await res2.json()).toEqual({ success: true })
        }
      ),
      { numRuns: 20 }
    )
  })
})
