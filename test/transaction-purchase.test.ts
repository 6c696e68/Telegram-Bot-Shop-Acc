import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { transactionService } from '../src/services/transaction'
import {
  resetThreeTierSchema,
  seedCategory,
  seedPricedProduct,
  seedProductItems,
} from './helpers/three-tier-schema'

/**
 * Regression test cho `TransactionService.executePurchase` — chốt 2 bug CRITICAL đã sửa:
 *
 *  - BUG #1 (commit một phần khi snipe): khi 2 người mua tranh cùng stock, người THUA
 *    KHÔNG được bị trừ tiền và KHÔNG để lại product 'sold' mồ côi / transaction ma.
 *  - BUG #2 (lost update số dư): 2 lần mua đồng thời của CÙNG user (khác category) phải
 *    trừ ĐÚNG tổng hai khoản (dùng `balance = balance - ?` thay vì ghi tuyệt đối).
 *
 * Bất biến kiểm chứng (đúng với MỌI thứ tự interleave): bảo toàn tiền
 *   `tổng tiền đã trừ == đơn giá × số product thực 'sold'`, số dư không âm, không có
 *   product 'sold' mà thiếu order hợp lệ.
 *
 * Chạy dưới @cloudflare/vitest-pool-workers (D1 thật) nên `Promise.all` tạo được
 * tương tranh thực sự giữa các lời gọi.
 */

async function seedUser(telegramId: number, balance: number): Promise<number> {
  const row = await env.DB.prepare(
    'INSERT INTO users (telegram_id, balance) VALUES (?, ?) RETURNING id'
  ).bind(telegramId, balance).first<{ id: number }>()
  return row!.id
}

async function seedCatalogProduct(price: number, stock: number): Promise<number> {
  const categoryId = await seedCategory(env.DB, `cat_${Math.random().toString(36).slice(2)}`)
  const productId = await seedPricedProduct(env.DB, {
    categoryId,
    name: `product_${Math.random().toString(36).slice(2)}`,
    price,
  })
  await seedProductItems(env.DB, productId, stock)
  return productId
}

async function balanceOf(userId: number): Promise<number> {
  const row = await env.DB.prepare('SELECT balance FROM users WHERE id = ?').bind(userId).first<{ balance: number }>()
  return row!.balance
}

async function countSold(productId: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM product_items WHERE product_id = ? AND status = 'sold'"
  ).bind(productId).first<{ n: number }>()
  return row!.n
}

async function countAvailable(productId: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM product_items WHERE product_id = ? AND status = 'available'"
  ).bind(productId).first<{ n: number }>()
  return row!.n
}

/** Số product_item 'sold' nhưng order_id không trỏ tới order tồn tại (orphan phải = 0). */
async function countOrphanSold(): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM product_items p
     WHERE p.status = 'sold' AND (p.order_id IS NULL OR NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = p.order_id))`
  ).first<{ n: number }>()
  return row!.n
}

beforeEach(async () => {
  await resetThreeTierSchema(env.DB)
})

describe('executePurchase — happy path + reject side-effects', () => {
  it('mua thành công: trừ tiền đúng 1 lần, sold đúng số lượng, tạo order/items/transaction', async () => {
    const userId = await seedUser(1, 100_000)
    const productId = await seedCatalogProduct(30_000, 5)

    const res = await transactionService.executePurchase(env.DB, userId, productId, 2, 30_000)

    expect(res.success).toBe(true)
    expect(await balanceOf(userId)).toBe(40_000) // 100k - 60k
    expect(await countSold(productId)).toBe(2)
    expect(await countAvailable(productId)).toBe(3)

    const orders = await env.DB.prepare('SELECT COUNT(*) as n FROM orders').first<{ n: number }>()
    expect(orders!.n).toBe(1)
    const items = await env.DB.prepare('SELECT COUNT(*) as n FROM order_items').first<{ n: number }>()
    expect(items!.n).toBe(2)
    const tx = await env.DB.prepare("SELECT amount FROM transactions WHERE type='purchase'").first<{ amount: number }>()
    expect(tx!.amount).toBe(-60_000)
    expect(await countOrphanSold()).toBe(0)
  })

  it('thiếu số dư: từ chối, KHÔNG đổi số dư/kho, không tạo order/transaction', async () => {
    const userId = await seedUser(2, 10_000)
    const productId = await seedCatalogProduct(30_000, 5)

    const res = await transactionService.executePurchase(env.DB, userId, productId, 1, 30_000)

    expect(res.success).toBe(false)
    if (!res.success) expect(res.error).toBe('insufficient_balance')
    expect(await balanceOf(userId)).toBe(10_000)
    expect(await countSold(productId)).toBe(0)
    expect(await countAvailable(productId)).toBe(5)
    const orders = await env.DB.prepare('SELECT COUNT(*) as n FROM orders').first<{ n: number }>()
    expect(orders!.n).toBe(0)
    const tx = await env.DB.prepare('SELECT COUNT(*) as n FROM transactions').first<{ n: number }>()
    expect(tx!.n).toBe(0)
  })

  it('thiếu kho: từ chối, KHÔNG đổi số dư/kho, không orphan', async () => {
    const userId = await seedUser(3, 1_000_000)
    const productId = await seedCatalogProduct(30_000, 1)

    const res = await transactionService.executePurchase(env.DB, userId, productId, 2, 30_000)

    expect(res.success).toBe(false)
    if (!res.success) expect(res.error).toBe('insufficient_stock')
    expect(await balanceOf(userId)).toBe(1_000_000)
    expect(await countSold(productId)).toBe(0)
    expect(await countAvailable(productId)).toBe(1)
    expect(await countOrphanSold()).toBe(0)
  })
})

describe('executePurchase — bất biến dưới tương tranh (concurrency)', () => {
  it('BUG #1: 2 người tranh cùng stock — đúng 1 người thắng, người thua KHÔNG bị trừ tiền, không orphan', async () => {
    const price = 30_000
    const userA = await seedUser(10, 1_000_000)
    const userB = await seedUser(11, 1_000_000)
    const productId = await seedCatalogProduct(price, 2) // chỉ đủ cho 1 đơn qty=2

    const [ra, rb] = await Promise.all([
      transactionService.executePurchase(env.DB, userA, productId, 2, price),
      transactionService.executePurchase(env.DB, userB, productId, 2, price),
    ])

    const successes = [ra, rb].filter((r) => r.success).length
    expect(successes).toBe(1) // đúng 1 người thắng (chỉ 2 product cho qty=2)

    const sold = await countSold(productId)
    expect(sold).toBe(2)

    // Bảo toàn tiền: tổng đã trừ của cả 2 user == đơn giá × số product sold.
    const spentA = 1_000_000 - (await balanceOf(userA))
    const spentB = 1_000_000 - (await balanceOf(userB))
    expect(spentA + spentB).toBe(price * sold) // == 60_000, người thua trừ 0

    // Không có product sold mồ côi (order bị xoá nhưng product vẫn sold).
    expect(await countOrphanSold()).toBe(0)
    // Đúng 1 order tồn tại.
    const orders = await env.DB.prepare('SELECT COUNT(*) as n FROM orders').first<{ n: number }>()
    expect(orders!.n).toBe(1)
  })

  it('BUG #2: cùng user mua 2 category đồng thời — trừ ĐÚNG tổng, không lost update', async () => {
    const userId = await seedUser(20, 100_000)
    const productA = await seedCatalogProduct(30_000, 5)
    const productB = await seedCatalogProduct(40_000, 5)

    const [ra, rb] = await Promise.all([
      transactionService.executePurchase(env.DB, userId, productA, 1, 30_000),
      transactionService.executePurchase(env.DB, userId, productB, 1, 40_000),
    ])

    expect(ra.success).toBe(true)
    expect(rb.success).toBe(true)
    // Không lost update: 100k - 30k - 40k = 30k (bug cũ ghi tuyệt đối sẽ ra sai).
    expect(await balanceOf(userId)).toBe(30_000)
    expect(await countSold(productA)).toBe(1)
    expect(await countSold(productB)).toBe(1)
    expect(await countOrphanSold()).toBe(0)

    const txs = (
      await env.DB
        .prepare(
          "SELECT amount, balance_before, balance_after FROM transactions WHERE user_id = ? AND type = 'purchase'"
        )
        .bind(userId)
        .all<{ amount: number; balance_before: number; balance_after: number }>()
    ).results
    expect(txs).toHaveLength(2)
    for (const tx of txs) {
      expect(tx.balance_after - tx.balance_before).toBe(tx.amount)
    }
    expect(Math.min(...txs.map((tx) => tx.balance_after))).toBe(30_000)
  })
})
