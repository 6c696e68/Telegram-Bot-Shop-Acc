import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { TransactionService } from '../src/services/transaction'
import { completeDeposit } from '../src/services/deposit-service'
import type { DbTransaction } from '../src/types/db'
import {
  cleanThreeTierTables,
  resetThreeTierSchema,
  seedCategory,
  seedPricedProduct,
  seedProductItems,
} from './helpers/three-tier-schema'

/**
 * Property-based tests cho Transaction Service.
 * Validates: Requirements 4.9, 3.7, 4.5, 2.6, 4.4, 4.1, 4.3, 4.2
 */

const transactionService = new TransactionService()

async function seedUser(db: D1Database, balance: number): Promise<number> {
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
  return user!.id
}

async function seedCatalogProduct(db: D1Database, price: number, stock: number): Promise<number> {
  const categoryId = await seedCategory(db, 'Test Category')
  const productId = await seedPricedProduct(db, {
    categoryId,
    name: 'Test Product',
    price,
  })
  await seedProductItems(db, productId, stock)
  return productId
}

async function seedDeposit(
  db: D1Database,
  userId: number,
  amount: number
): Promise<number> {
  const transferCode = `NAP${Date.now().toString(36).toUpperCase()}`
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

describe('Property 1: Balance không bao giờ âm', () => {
  /**
   * **Validates: Requirements 4.9**
   * Mọi sequence operations, balance >= 0.
   * D1 CHECK constraint ensures balance can never go negative.
   */
  beforeEach(async () => {
    await resetThreeTierSchema(env.DB)
  })

  it('after any purchase where balance >= totalAmount, resulting balance >= 0', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1000, max: 10_000_000 }),   // initialBalance
        fc.integer({ min: 1000, max: 500_000 }),       // unitPrice
        fc.integer({ min: 1, max: 10 }),               // quantity
        async (initialBalance, unitPrice, quantity) => {
          await cleanThreeTierTables(env.DB)

          const totalAmount = unitPrice * quantity
          // Only test cases where user can afford
          fc.pre(initialBalance >= totalAmount)

          const userId = await seedUser(env.DB, initialBalance)
          const productId = await seedCatalogProduct(env.DB, unitPrice, quantity)

          const result = await transactionService.executePurchase(
            env.DB,
            userId,
            productId,
            quantity,
            unitPrice
          )

          expect(result.success).toBe(true)

          const balanceAfter = await getUserBalance(env.DB, userId)
          expect(balanceAfter).toBeGreaterThanOrEqual(0)
        }
      ),
      { numRuns: 30 }
    )
  })

  it('purchase rejected when balance < totalAmount, balance unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1000, max: 500_000 }),   // initialBalance
        fc.integer({ min: 1000, max: 500_000 }),   // unitPrice
        fc.integer({ min: 1, max: 10 }),           // quantity
        async (initialBalance, unitPrice, quantity) => {
          await cleanThreeTierTables(env.DB)

          const totalAmount = unitPrice * quantity
          // Only test cases where user cannot afford
          fc.pre(initialBalance < totalAmount)

          const userId = await seedUser(env.DB, initialBalance)
          const productId = await seedCatalogProduct(env.DB, unitPrice, quantity)

          const result = await transactionService.executePurchase(
            env.DB,
            userId,
            productId,
            quantity,
            unitPrice
          )

          expect(result.success).toBe(false)
          expect(result.error).toBe('insufficient_balance')

          const balanceAfter = await getUserBalance(env.DB, userId)
          expect(balanceAfter).toBe(initialBalance)
          expect(balanceAfter).toBeGreaterThanOrEqual(0)
        }
      ),
      { numRuns: 30 }
    )
  })
})

describe('Property 2: Deposit cộng chính xác số tiền', () => {
  /**
   * **Validates: Requirements 2.6**
   * balance_after = balance_before + amount.
   */
  beforeEach(async () => {
    await resetThreeTierSchema(env.DB)
  })

  it('after deposit of amount X, user balance increases by exactly X', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10_000_000 }),       // initialBalance
        fc.integer({ min: 20_000, max: 100_000_000 }), // depositAmount
        async (initialBalance, depositAmount) => {
          await cleanThreeTierTables(env.DB)

          const userId = await seedUser(env.DB, initialBalance)
          const depositId = await seedDeposit(env.DB, userId, depositAmount)
          const sepayTxId = `SEP${Date.now()}`

          const result = await completeDeposit({
            db: env.DB,
            depositId,
            userId,
            creditVnd: depositAmount,
            provider: 'sepay',
            providerTxnId: sepayTxId,
          })

          expect(result.success).toBe(true)
          if (!result.success) return
          expect(result.newBalance).toBe(initialBalance + depositAmount)

          const actualBalance = await getUserBalance(env.DB, userId)
          expect(actualBalance).toBe(initialBalance + depositAmount)
        }
      ),
      { numRuns: 30 }
    )
  })
})

describe('Property 4: Atomic purchase consistency', () => {
  /**
   * **Validates: Requirements 4.1, 4.3, 4.4, 3.7**
   * Balance giảm đúng N*P, đúng quantity product_items 'sold', order ghi đúng.
   */
  beforeEach(async () => {
    await resetThreeTierSchema(env.DB)
  })

  it('balance decreases by N*P, N products become sold, order has correct quantity/total', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1000, max: 500_000 }),  // unitPrice
        fc.integer({ min: 1, max: 5 }),            // quantity
        async (unitPrice, quantity) => {
          await cleanThreeTierTables(env.DB)

          const totalAmount = unitPrice * quantity
          const initialBalance = totalAmount + Math.floor(Math.random() * 1_000_000)

          const userId = await seedUser(env.DB, initialBalance)
          const productId = await seedCatalogProduct(env.DB, unitPrice, quantity + 3) // extra stock

          const result = await transactionService.executePurchase(
            env.DB,
            userId,
            productId,
            quantity,
            unitPrice
          )

          expect(result.success).toBe(true)

          // 1. Balance decreased by exactly totalAmount
          const balanceAfter = await getUserBalance(env.DB, userId)
          expect(balanceAfter).toBe(initialBalance - totalAmount)

          // 2. Exactly N products are now 'sold' for this buyer
          const soldProducts = await env.DB
            .prepare("SELECT COUNT(*) as cnt FROM product_items WHERE buyer_id = ? AND status = 'sold'")
            .bind(userId)
            .first<{ cnt: number }>()
          expect(soldProducts!.cnt).toBe(quantity)

          // 3. Order has correct quantity and total_amount
          expect(result.order).toBeDefined()
          expect(result.order!.quantity).toBe(quantity)
          expect(result.order!.total_amount).toBe(totalAmount)
          expect(result.order!.user_id).toBe(userId)
          expect(result.order!.product_id).toBe(productId)
        }
      ),
      { numRuns: 25 }
    )
  })
})

describe('Property 5: Mỗi thay đổi balance có transaction record', () => {
  /**
   * **Validates: Requirements 4.2, 4.5**
   * balance_after - balance_before = amount trong transaction record.
   */
  beforeEach(async () => {
    await resetThreeTierSchema(env.DB)
  })

  it('purchase creates transaction where balance_after - balance_before = amount', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1000, max: 500_000 }),  // unitPrice
        fc.integer({ min: 1, max: 5 }),            // quantity
        async (unitPrice, quantity) => {
          await cleanThreeTierTables(env.DB)

          const totalAmount = unitPrice * quantity
          const initialBalance = totalAmount + 100_000

          const userId = await seedUser(env.DB, initialBalance)
          const productId = await seedCatalogProduct(env.DB, unitPrice, quantity)

          const result = await transactionService.executePurchase(
            env.DB,
            userId,
            productId,
            quantity,
            unitPrice
          )

          expect(result.success).toBe(true)

          // Find the transaction record
          const tx = await env.DB
            .prepare(
              "SELECT * FROM transactions WHERE user_id = ? AND type = 'purchase' ORDER BY id DESC LIMIT 1"
            )
            .bind(userId)
            .first<DbTransaction>()

          expect(tx).not.toBeNull()
          expect(tx!.balance_after - tx!.balance_before).toBe(tx!.amount)
          expect(tx!.amount).toBe(-totalAmount)
          expect(tx!.balance_before).toBe(initialBalance)
          expect(tx!.balance_after).toBe(initialBalance - totalAmount)
          expect(tx!.status).toBe('success')
        }
      ),
      { numRuns: 25 }
    )
  })

  it('deposit creates transaction where balance_after - balance_before = amount', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5_000_000 }),        // initialBalance
        fc.integer({ min: 20_000, max: 10_000_000 }),  // depositAmount
        async (initialBalance, depositAmount) => {
          await cleanThreeTierTables(env.DB)

          const userId = await seedUser(env.DB, initialBalance)
          const depositId = await seedDeposit(env.DB, userId, depositAmount)
          const sepayTxId = `SEP${Date.now()}_${Math.random()}`

          const result = await completeDeposit({
            db: env.DB,
            depositId,
            userId,
            creditVnd: depositAmount,
            provider: 'sepay',
            providerTxnId: sepayTxId,
          })

          expect(result.success).toBe(true)

          // Find the transaction record
          const tx = await env.DB
            .prepare(
              "SELECT * FROM transactions WHERE user_id = ? AND type = 'deposit' ORDER BY id DESC LIMIT 1"
            )
            .bind(userId)
            .first<DbTransaction>()

          expect(tx).not.toBeNull()
          expect(tx!.balance_after - tx!.balance_before).toBe(tx!.amount)
          expect(tx!.amount).toBe(depositAmount)
          expect(tx!.balance_before).toBe(initialBalance)
          expect(tx!.balance_after).toBe(initialBalance + depositAmount)
          expect(tx!.status).toBe('success')
        }
      ),
      { numRuns: 25 }
    )
  })
})
