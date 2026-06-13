import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  simulatePurchase,
  type PurchaseSimulationState,
  type PurchaseSimulationRequest,
  type SimulatedPurchaseItem,
} from '../src/services/transaction'

// Feature: product-catalog-i18n-upgrade, Property 13: Dieu kien mua va bat bien khi that bai
// Feature: product-catalog-i18n-upgrade, Property 14: Giao dich mua la all-or-nothing
// Feature: product-catalog-i18n-upgrade, Property 15: Bat bien cau truc don hang sau khi mua
// Feature: product-catalog-i18n-upgrade, Property 16: Khong ban trung Product_Item duoi dong thoi
// Feature: product-catalog-i18n-upgrade, Property 17: So du khong bao gio am

const NUM_RUNS = 100
const PRODUCT_ID = 10
const OTHER_PRODUCT_ID = 20
const USER_ID = 99

function createItems(productId: number, available: number, sold = 0, reserved = 0): SimulatedPurchaseItem[] {
  let nextId = 1
  const items: SimulatedPurchaseItem[] = []

  for (let i = 0; i < available; i += 1) {
    items.push({ id: nextId, product_id: productId, status: 'available', buyer_id: null, order_id: null })
    nextId += 1
  }
  for (let i = 0; i < sold; i += 1) {
    items.push({ id: nextId, product_id: productId, status: 'sold', buyer_id: 500, order_id: 700 + i })
    nextId += 1
  }
  for (let i = 0; i < reserved; i += 1) {
    items.push({ id: nextId, product_id: productId, status: 'reserved', buyer_id: null, order_id: null })
    nextId += 1
  }
  items.push({ id: nextId, product_id: OTHER_PRODUCT_ID, status: 'available', buyer_id: null, order_id: null })

  return items
}

function createState(balance: number, available: number, sold = 0, reserved = 0): PurchaseSimulationState {
  return {
    balance,
    nextOrderId: 1,
    items: createItems(PRODUCT_ID, available, sold, reserved),
    orders: [],
    orderItems: [],
    transactions: [],
  }
}

function cloneState<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function soldItems(state: PurchaseSimulationState): SimulatedPurchaseItem[] {
  return state.items.filter((item) => item.product_id === PRODUCT_ID && item.status === 'sold' && item.order_id !== null)
}

describe('Property 13: Điều kiện mua và bất biến trạng thái khi thất bại', () => {
  it('succeeds iff total is positive, balance covers total, and enough stock exists', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 200_000 }),
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 10 }),
        (balance, unitPrice, quantity, available) => {
          const state = createState(balance, available)
          const before = cloneState(state)
          const result = simulatePurchase({ userId: USER_ID, productId: PRODUCT_ID, quantity, unitPrice }, state)
          const total = unitPrice * quantity
          const shouldSucceed = total > 0 && balance >= total && available >= quantity

          expect(result.success).toBe(shouldSucceed)
          expect(state).toEqual(before)
          if (!shouldSucceed) {
            expect(result.state).toEqual(before)
          }
        }
      ),
      { numRuns: NUM_RUNS }
    )
  })
})

describe('Property 14: Giao dịch mua là all-or-nothing', () => {
  it('commits all purchase records or leaves the state unchanged', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 200_000 }),
        fc.integer({ min: 0, max: 10 }),
        fc.integer({ min: 0, max: 10 }),
        fc.boolean(),
        (balance, unitPrice, quantity, available, failRecordPhase) => {
          const state = createState(balance, available)
          const before = cloneState(state)
          const result = simulatePurchase(
            { userId: USER_ID, productId: PRODUCT_ID, quantity, unitPrice, failRecordPhase },
            state
          )
          const total = unitPrice * quantity

          if (!result.success) {
            expect(result.state).toEqual(before)
            return
          }

          expect(result.state.balance).toBe(before.balance - total)
          expect(soldItems(result.state)).toHaveLength(quantity)
          expect(result.state.orders).toHaveLength(1)
          expect(result.state.orderItems).toHaveLength(quantity)
          expect(result.state.transactions).toHaveLength(1)
          expect(result.state.transactions[0]).toMatchObject({
            amount: -total,
            balance_before: before.balance,
            balance_after: before.balance - total,
            reference_id: result.order!.id,
          })
        }
      ),
      { numRuns: NUM_RUNS }
    )
  })
})

describe('Property 15: Bất biến cấu trúc đơn hàng sau khi mua', () => {
  it('creates one order with distinct sold product_items linked to that order', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200_000 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 0, max: 8 }),
        (unitPrice, quantity, extraStock) => {
          const total = unitPrice * quantity
          const state = createState(total + 1_000, quantity + extraStock)
          const result = simulatePurchase({ userId: USER_ID, productId: PRODUCT_ID, quantity, unitPrice }, state)

          expect(result.success).toBe(true)
          const order = result.order!
          const orderItems = result.state.orderItems.filter((item) => item.order_id === order.id)
          const productItemIds = orderItems.map((item) => item.product_item_id)
          const uniqueProductItemIds = new Set(productItemIds)

          expect(order).toMatchObject({
            user_id: USER_ID,
            product_id: PRODUCT_ID,
            quantity,
            total_amount: total,
          })
          expect(orderItems).toHaveLength(quantity)
          expect(uniqueProductItemIds.size).toBe(quantity)

          for (const productItemId of productItemIds) {
            const item = result.state.items.find((candidate) => candidate.id === productItemId)
            expect(item).toMatchObject({
              product_id: PRODUCT_ID,
              status: 'sold',
              buyer_id: USER_ID,
              order_id: order.id,
            })
          }
        }
      ),
      { numRuns: NUM_RUNS }
    )
  })
})

describe('Property 16: Không bán trùng Product_Item dưới đồng thời', () => {
  it('serializable concurrent attempts never sell more items than available or sell one item twice', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 10 }),
        (available, unitPrice, quantities) => {
          let sharedState = createState(0, available)
          const balances = new Map<number, number>()

          quantities.forEach((_quantity, index) => {
            balances.set(index + 1, unitPrice * 50)
          })

          quantities.forEach((quantity, index) => {
            const userId = index + 1
            const balanceBefore = balances.get(userId)!
            const sharedBefore = cloneState(sharedState)
            const attemptState: PurchaseSimulationState = { ...cloneState(sharedState), balance: balanceBefore }
            const result = simulatePurchase({ userId, productId: PRODUCT_ID, quantity, unitPrice }, attemptState)

            if (result.success) {
              balances.set(userId, result.state.balance)
              sharedState = { ...result.state, balance: 0 }
            } else {
              expect(result.state.items).toEqual(sharedBefore.items)
              expect(balances.get(userId)).toBe(balanceBefore)
            }
          })

          const sold = soldItems(sharedState)
          const soldIds = sold.map((item) => item.id)
          expect(sold).toHaveLength(new Set(soldIds).size)
          expect(sold.length).toBeLessThanOrEqual(available)
          for (const order of sharedState.orders) {
            expect(sharedState.orderItems.filter((item) => item.order_id === order.id)).toHaveLength(order.quantity)
          }
        }
      ),
      { numRuns: NUM_RUNS }
    )
  })
})

describe('Property 17: Số dư không bao giờ âm', () => {
  it('keeps balance non-negative across any purchase sequence for one user', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 30 }),
        fc.array(
          fc.record({
            unitPrice: fc.integer({ min: 0, max: 200_000 }),
            quantity: fc.integer({ min: 0, max: 8 }),
          }),
          { minLength: 1, maxLength: 20 }
        ),
        (initialBalance, available, requests) => {
          let state = createState(initialBalance, available)

          for (const request of requests) {
            const before = cloneState(state)
            const purchaseRequest: PurchaseSimulationRequest = {
              userId: USER_ID,
              productId: PRODUCT_ID,
              quantity: request.quantity,
              unitPrice: request.unitPrice,
            }
            const result = simulatePurchase(purchaseRequest, state)

            expect(result.state.balance).toBeGreaterThanOrEqual(0)
            if (!result.success) {
              expect(result.state).toEqual(before)
            }
            state = result.state
          }
        }
      ),
      { numRuns: NUM_RUNS }
    )
  })
})
