import type { DbOrder, DbProduct, DbUser } from '../types/db'

export interface PurchaseResult {
  success: boolean
  order?: DbOrder
  products?: DbProduct[]
  error?: 'insufficient_balance' | 'insufficient_stock' | 'db_error'
}

export class TransactionService {
  /**
   * Atomic purchase: check balance → deduct → mark products sold → create order + order_items + transaction.
   * Two-phase: insert order first (to get id), then batch the rest atomically.
   * Concurrency guard: balance UPDATE has WHERE balance >= totalAmount.
   */
  async executePurchase(
    db: D1Database,
    userId: number,
    categoryId: number,
    quantity: number,
    unitPrice: number
  ): Promise<PurchaseResult> {
    const totalAmount = quantity * unitPrice
    const now = new Date().toISOString()

    // 1. Query user balance and available products
    const [userResult, productsResult] = await Promise.all([
      db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<DbUser>(),
      db
        .prepare(
          "SELECT * FROM products WHERE type_id = ? AND status = 'available' ORDER BY created_at ASC LIMIT ?"
        )
        .bind(categoryId, quantity)
        .all<DbProduct>(),
    ])

    if (!userResult) {
      return { success: false, error: 'db_error' }
    }

    // 2. Pre-checks
    if (userResult.balance < totalAmount) {
      return { success: false, error: 'insufficient_balance' }
    }

    const availableProducts = productsResult.results
    if (availableProducts.length < quantity) {
      return { success: false, error: 'insufficient_stock' }
    }

    const balanceBefore = userResult.balance
    const balanceAfter = balanceBefore - totalAmount
    const productIds = availableProducts.map((p) => p.id)

    // Phase 1: tạo order để lấy orderId (dùng liên kết products/order_items/transaction).
    let orderId: number
    try {
      const orderInsert = await db
        .prepare(
          'INSERT INTO orders (user_id, product_type_id, quantity, total_amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id'
        )
        .bind(userId, categoryId, quantity, totalAmount, 'completed', now)
        .first<{ id: number }>()
      if (!orderInsert) {
        return { success: false, error: 'db_error' }
      }
      orderId = orderInsert.id
    } catch {
      return { success: false, error: 'db_error' }
    }

    /**
     * Bù trừ (compensating): hoàn nguyên products đã gắn order này về `available`,
     * xoá order_items + order. KHÔNG đụng balance (chỉ gọi trước khi/khi balance chưa trừ).
     * Dùng khi snipe stock hoặc balance guard fail — đảm bảo KHÔNG để lại trạng thái dở dang.
     */
    const abort = async (
      error: 'insufficient_stock' | 'insufficient_balance' | 'db_error'
    ): Promise<PurchaseResult> => {
      await db
        .prepare(
          "UPDATE products SET status = 'available', buyer_id = NULL, order_id = NULL, sold_at = NULL WHERE order_id = ?"
        )
        .bind(orderId)
        .run()
        .catch(() => {})
      await db.prepare('DELETE FROM order_items WHERE order_id = ?').bind(orderId).run().catch(() => {})
      await db.prepare('DELETE FROM orders WHERE id = ?').bind(orderId).run().catch(() => {})
      return { success: false, error }
    }

    // Phase 2: GIÀNH stock nguyên tử trong MỘT câu lệnh — đánh dấu các product đã chọn
    // thành 'sold' kèm orderId, guard `status='available'`. Nếu bị mua tranh (snipe) thì
    // số dòng đổi < quantity → hoàn nguyên những cái vừa giành rồi báo hết hàng.
    const placeholders = productIds.map(() => '?').join(', ')
    let claimChanges: number
    try {
      const claim = await db
        .prepare(
          `UPDATE products SET status = 'sold', buyer_id = ?, order_id = ?, sold_at = ?
           WHERE status = 'available' AND id IN (${placeholders})`
        )
        .bind(userId, orderId, now, ...productIds)
        .run()
      claimChanges = claim.meta.changes ?? 0
    } catch {
      return abort('db_error')
    }
    if (claimChanges !== quantity) {
      return abort('insufficient_stock')
    }

    // Phase 3: TRỪ số dư nguyên tử bằng increment có guard (`balance = balance - ?`
    // tránh lost update khi cùng user mua đồng thời; `WHERE balance >= ?` chống âm).
    // Guard fail (đua hết tiền) → hoàn nguyên stock vừa giành, không trừ tiền.
    let balanceChanges: number
    try {
      const deduct = await db
        .prepare('UPDATE users SET balance = balance - ?, updated_at = ? WHERE id = ? AND balance >= ?')
        .bind(totalAmount, now, userId, totalAmount)
        .run()
      balanceChanges = deduct.meta.changes ?? 0
    } catch {
      return abort('db_error')
    }
    if (balanceChanges === 0) {
      return abort('insufficient_balance')
    }

    // Phase 4: ghi order_items + transaction (audit). Tiền + stock đã nhất quán; nếu
    // bước này lỗi, order vẫn hợp lệ — chỉ thiếu line items/transaction (order-cleanup
    // cron là lưới an toàn cho order dở). Không rollback tiền vì hàng đã giao.
    const recordStmts: D1PreparedStatement[] = availableProducts.map((product) =>
      db
        .prepare('INSERT INTO order_items (order_id, product_id, created_at) VALUES (?, ?, ?)')
        .bind(orderId, product.id, now)
    )
    recordStmts.push(
      db
        .prepare(
          'INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(
          userId,
          'purchase',
          -totalAmount,
          balanceBefore,
          balanceAfter,
          'order',
          orderId,
          `Mua ${quantity} sản phẩm`,
          'success',
          now
        )
    )
    try {
      await db.batch(recordStmts)
    } catch {
      // Tiền đã trừ + hàng đã giao (products sold) → KHÔNG hoàn tác; chỉ log để theo dõi.
      console.error('[Transaction] ghi order_items/transaction lỗi cho order:', orderId)
    }

    // Build response — fetch created order
    const order = await db
      .prepare('SELECT * FROM orders WHERE id = ?')
      .bind(orderId)
      .first<DbOrder>()

    return {
      success: true,
      order: order ?? undefined,
      products: availableProducts,
    }
  }
}

export const transactionService = new TransactionService()
