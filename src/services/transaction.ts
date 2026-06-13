import type { DbOrder, DbProductItem, DbUser } from '../types/db'

export interface PurchaseResult {
  success: boolean
  order?: DbOrder
  productItems?: DbProductItem[]
  /** @deprecated Giữ tương thích call site cũ; dùng `productItems`. */
  products?: DbProductItem[]
  balanceAfter?: number
  error?: 'insufficient_balance' | 'insufficient_stock' | 'db_error'
}

export type SimulatedPurchaseStatus = 'available' | 'sold' | 'reserved'

export interface SimulatedPurchaseItem {
  id: number
  product_id: number
  status: SimulatedPurchaseStatus
  buyer_id: number | null
  order_id: number | null
}

export interface SimulatedPurchaseOrder {
  id: number
  user_id: number
  product_id: number
  quantity: number
  total_amount: number
}

export interface SimulatedPurchaseOrderItem {
  order_id: number
  product_item_id: number
}

export interface SimulatedPurchaseTransaction {
  user_id: number
  amount: number
  balance_before: number
  balance_after: number
  reference_id: number
}

export interface PurchaseSimulationState {
  balance: number
  nextOrderId: number
  items: SimulatedPurchaseItem[]
  orders: SimulatedPurchaseOrder[]
  orderItems: SimulatedPurchaseOrderItem[]
  transactions: SimulatedPurchaseTransaction[]
}

export interface PurchaseSimulationRequest {
  userId: number
  productId: number
  quantity: number
  unitPrice: number
  failRecordPhase?: boolean
}

export interface PurchaseSimulationResult {
  success: boolean
  state: PurchaseSimulationState
  order?: SimulatedPurchaseOrder
  productItems?: SimulatedPurchaseItem[]
  error?: 'insufficient_balance' | 'insufficient_stock' | 'db_error'
}

function clonePurchaseSimulationState(state: PurchaseSimulationState): PurchaseSimulationState {
  return {
    balance: state.balance,
    nextOrderId: state.nextOrderId,
    items: state.items.map((item) => ({ ...item })),
    orders: state.orders.map((order) => ({ ...order })),
    orderItems: state.orderItems.map((item) => ({ ...item })),
    transactions: state.transactions.map((tx) => ({ ...tx })),
  }
}

export function simulatePurchase(request: PurchaseSimulationRequest, input: PurchaseSimulationState): PurchaseSimulationResult {
  const original = clonePurchaseSimulationState(input)
  const totalAmount = request.quantity * request.unitPrice

  if (request.quantity <= 0 || totalAmount <= 0 || original.balance < totalAmount) {
    return { success: false, error: 'insufficient_balance', state: original }
  }

  const availableItems = original.items
    .filter((item) => item.product_id === request.productId && item.status === 'available')
    .sort((a, b) => a.id - b.id)
    .slice(0, request.quantity)

  if (availableItems.length < request.quantity) {
    return { success: false, error: 'insufficient_stock', state: original }
  }

  if (request.failRecordPhase) {
    return { success: false, error: 'db_error', state: original }
  }

  const state = clonePurchaseSimulationState(original)
  const orderId = state.nextOrderId
  const balanceBefore = state.balance
  const balanceAfter = balanceBefore - totalAmount
  const claimedIds = new Set(availableItems.map((item) => item.id))
  const order: SimulatedPurchaseOrder = {
    id: orderId,
    user_id: request.userId,
    product_id: request.productId,
    quantity: request.quantity,
    total_amount: totalAmount,
  }

  state.nextOrderId += 1
  state.balance = balanceAfter
  state.orders.push(order)
  for (const item of state.items) {
    if (!claimedIds.has(item.id)) continue
    item.status = 'sold'
    item.buyer_id = request.userId
    item.order_id = orderId
    state.orderItems.push({ order_id: orderId, product_item_id: item.id })
  }
  state.transactions.push({
    user_id: request.userId,
    amount: -totalAmount,
    balance_before: balanceBefore,
    balance_after: balanceAfter,
    reference_id: orderId,
  })

  return {
    success: true,
    state,
    order,
    productItems: state.items.filter((item) => claimedIds.has(item.id)),
  }
}

export class TransactionService {
  /**
   * Atomic purchase: check balance → claim product_items → deduct → create order_items + transaction.
   * Two-phase: insert order first (to get id), then batch the rest atomically.
   * Concurrency guard: balance UPDATE has WHERE balance >= totalAmount.
   */
  async executePurchase(
    db: D1Database,
    userId: number,
    productId: number,
    quantity: number,
    unitPrice: number
  ): Promise<PurchaseResult> {
    const totalAmount = quantity * unitPrice
    const now = new Date().toISOString()

    if (quantity <= 0 || totalAmount <= 0) {
      return { success: false, error: 'insufficient_balance' }
    }

    // 1. Query user balance and available product_items
    const [userResult, itemsResult] = await Promise.all([
      db.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<DbUser>(),
      db
        .prepare(
          "SELECT * FROM product_items WHERE product_id = ? AND status = 'available' ORDER BY created_at ASC, id ASC LIMIT ?"
        )
        .bind(productId, quantity)
        .all<DbProductItem>(),
    ])

    if (!userResult) {
      return { success: false, error: 'db_error' }
    }

    // 2. Pre-checks
    if (userResult.balance < totalAmount) {
      return { success: false, error: 'insufficient_balance' }
    }

    const availableItems = itemsResult.results
    if (availableItems.length < quantity) {
      return { success: false, error: 'insufficient_stock' }
    }

    const productItemIds = availableItems.map((p) => p.id)

    // Phase 1: tạo order để lấy orderId (dùng liên kết products/order_items/transaction).
    let orderId: number
    try {
      const orderInsert = await db
        .prepare(
          'INSERT INTO orders (user_id, product_id, quantity, total_amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id'
        )
        .bind(userId, productId, quantity, totalAmount, 'completed', now)
        .first<{ id: number }>()
      if (!orderInsert) {
        return { success: false, error: 'db_error' }
      }
      orderId = orderInsert.id
    } catch {
      return { success: false, error: 'db_error' }
    }

    /**
     * Bù trừ (compensating): hoàn nguyên product_items đã gắn order này về `available`,
     * xoá order_items + order. KHÔNG đụng balance (chỉ gọi trước khi/khi balance chưa trừ).
     * Dùng khi snipe stock hoặc balance guard fail — đảm bảo KHÔNG để lại trạng thái dở dang.
     */
    const abort = async (
      error: 'insufficient_stock' | 'insufficient_balance' | 'db_error'
    ): Promise<PurchaseResult> => {
      await db
        .prepare(
          "UPDATE product_items SET status = 'available', buyer_id = NULL, order_id = NULL, sold_at = NULL WHERE order_id = ?"
        )
        .bind(orderId)
        .run()
        .catch(() => {})
      await db.prepare('DELETE FROM order_items WHERE order_id = ?').bind(orderId).run().catch(() => {})
      await db.prepare('DELETE FROM orders WHERE id = ?').bind(orderId).run().catch(() => {})
      return { success: false, error }
    }

    const abortAfterDeduct = async (
      error: 'insufficient_stock' | 'insufficient_balance' | 'db_error'
    ): Promise<PurchaseResult> => {
      await db.prepare('DELETE FROM transactions WHERE reference_type = ? AND reference_id = ?')
        .bind('order', orderId)
        .run()
        .catch(() => {})
      await db.prepare('UPDATE users SET balance = balance + ?, updated_at = ? WHERE id = ?')
        .bind(totalAmount, now, userId)
        .run()
        .catch(() => {})
      return abort(error)
    }

    // Phase 2: GIÀNH stock nguyên tử trong MỘT câu lệnh — đánh dấu các item đã chọn
    // thành 'sold' kèm orderId, guard `status='available'`. Nếu bị mua tranh (snipe) thì
    // số dòng đổi < quantity → hoàn nguyên những cái vừa giành rồi báo hết hàng.
    const placeholders = productItemIds.map(() => '?').join(', ')
    let claimChanges: number
    try {
      const claim = await db
        .prepare(
          `UPDATE product_items SET status = 'sold', buyer_id = ?, order_id = ?, sold_at = ?
           WHERE status = 'available' AND id IN (${placeholders})`
        )
        .bind(userId, orderId, now, ...productItemIds)
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
    let balanceBefore: number
    let balanceAfter: number
    try {
      const deduct = await db
        .prepare(
          'UPDATE users SET balance = balance - ?, updated_at = ? WHERE id = ? AND balance >= ? RETURNING balance'
        )
        .bind(totalAmount, now, userId, totalAmount)
        .first<{ balance: number }>()
      if (!deduct) {
        return abort('insufficient_balance')
      }
      balanceAfter = deduct.balance
      balanceBefore = balanceAfter + totalAmount
    } catch {
      return abort('db_error')
    }

    // Phase 4: ghi order_items + transaction (audit). Nếu bước này lỗi thì bù trừ
    // balance + stock + order để giao dịch vẫn all-or-nothing.
    const recordStmts: D1PreparedStatement[] = availableItems.map((item) =>
      db
        .prepare('INSERT INTO order_items (order_id, product_item_id, created_at) VALUES (?, ?, ?)')
        .bind(orderId, item.id, now)
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
      return abortAfterDeduct('db_error')
    }

    // Build response — fetch created order
    const order = await db
      .prepare('SELECT * FROM orders WHERE id = ?')
      .bind(orderId)
      .first<DbOrder>()

    return {
      success: true,
      order: order ?? undefined,
      productItems: availableItems,
      products: availableItems,
      balanceAfter,
    }
  }
}

export const transactionService = new TransactionService()
