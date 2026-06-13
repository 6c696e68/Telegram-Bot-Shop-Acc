import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  DEFAULT_CATEGORY_ID,
  DEFAULT_CATEGORY_NAME,
  mapLegacyToThreeTier,
  type LegacyDatabase,
  type LegacyProductType,
} from '../src/services/catalog-migration-map'

// Feature: product-catalog-i18n-upgrade, Property 5: Migration bao toan so luong va anh xa
// Feature: product-catalog-i18n-upgrade, Property 6: Migration bao toan product_type_templates

const statusArb = fc.constantFrom<'available' | 'sold' | 'reserved'>('available', 'sold', 'reserved')
const categoryArb = fc.oneof(
  fc.constant(null),
  fc.constant(''),
  fc.constant('   '),
  fc.constant(DEFAULT_CATEGORY_NAME),
  fc.constant('Streaming'),
  fc.constant('AI Tools'),
  fc.constant('Games')
)

function legacyDb(categories: Array<string | null>): LegacyDatabase {
  const productTypes: LegacyProductType[] = categories.map((category, index) => ({
    id: index + 10,
    name: `Product ${index}`,
    description: index % 2 === 0 ? `Description ${index}` : null,
    price: 1_000 + index,
    emoji: null,
    image_data: index % 2 === 0 ? `image-${index}` : null,
    category,
    sort_order: index,
    is_visible: index % 2,
    success_template: `Template ${index}`,
    created_at: `2026-01-01 00:00:${String(index).padStart(2, '0')}`,
    updated_at: `2026-01-02 00:00:${String(index).padStart(2, '0')}`,
  }))

  return {
    productTypes,
    products: productTypes.map((pt, index) => ({
      id: index + 100,
      type_id: pt.id,
      content: `stock-${index}`,
      status: index % 3 === 0 ? 'sold' : index % 3 === 1 ? 'reserved' : 'available',
      buyer_id: index % 3 === 0 ? 1 : null,
      order_id: index % 3 === 0 ? index + 300 : null,
      created_at: pt.created_at,
      sold_at: index % 3 === 0 ? pt.updated_at : null,
    })),
    orders: productTypes.map((pt, index) => ({
      id: index + 300,
      user_id: 1,
      product_type_id: pt.id,
      quantity: 1,
      total_amount: pt.price,
      transaction_id: index + 400,
      status: 'completed',
      created_at: pt.updated_at,
    })),
    orderItems: productTypes.map((_pt, index) => ({
      id: index + 500,
      order_id: index + 300,
      product_id: index + 100,
      created_at: `2026-01-03 00:00:${String(index).padStart(2, '0')}`,
    })),
    productTypeTemplates: productTypes.map((pt, index) => ({
      id: index + 600,
      product_type_id: pt.id,
      lang: index % 2 === 0 ? 'vi' : 'en',
      success_template: `Success ${index}`,
      updated_at: pt.updated_at,
    })),
  }
}

describe('Property 5: Migration bảo toàn số lượng và ánh xạ', () => {
  it('preserves ids/counts and maps stock/orders to the new three-tier model', () => {
    fc.assert(
      fc.property(fc.array(categoryArb, { minLength: 1, maxLength: 8 }), (categories) => {
        const legacy = legacyDb(categories)
        const mapped = mapLegacyToThreeTier(legacy, { now: '2026-06-08 00:00:00' })

        expect(mapped.products).toHaveLength(legacy.productTypes.length)
        expect(mapped.productItems).toHaveLength(legacy.products.length)
        expect(mapped.orders).toHaveLength(legacy.orders.length)
        expect(mapped.orderItems).toHaveLength(legacy.orderItems.length)

        for (const legacyType of legacy.productTypes) {
          const product = mapped.products.find((p) => p.id === legacyType.id)
          expect(product).toBeDefined()
          expect(product!.name).toBe(legacyType.name)
          expect(product!.description).toBe(legacyType.description)
          expect(product!.price).toBe(legacyType.price)
          expect(product!.image_data).toBe(legacyType.image_data)
        }

        for (const item of legacy.products) {
          const mappedItem = mapped.productItems.find((p) => p.id === item.id)
          expect(mappedItem).toEqual({
            id: item.id,
            product_id: item.type_id,
            content: item.content,
            status: item.status,
            buyer_id: item.buyer_id,
            order_id: item.order_id,
            created_at: item.created_at,
            sold_at: item.sold_at,
          })
        }

        for (const order of legacy.orders) {
          expect(mapped.orders.find((o) => o.id === order.id)?.product_id).toBe(order.product_type_id)
        }
        for (const item of legacy.orderItems) {
          expect(mapped.orderItems.find((o) => o.id === item.id)?.product_item_id).toBe(item.product_id)
        }
      }),
      { numRuns: 100 }
    )
  })

  it('creates the default category only for missing category values and does not merge matching names', () => {
    const mapped = mapLegacyToThreeTier(
      legacyDb([null, '   ', DEFAULT_CATEGORY_NAME, 'Streaming'])
    )

    const defaultRows = mapped.productTypes.filter((pt) => pt.name === DEFAULT_CATEGORY_NAME)
    expect(defaultRows.length).toBe(2)
    expect(mapped.productTypes.some((pt) => pt.id === DEFAULT_CATEGORY_ID)).toBe(true)

    const noMissing = mapLegacyToThreeTier(legacyDb(['Streaming', 'Games']))
    expect(noMissing.productTypes.some((pt) => pt.id === DEFAULT_CATEGORY_ID && pt.name === DEFAULT_CATEGORY_NAME)).toBe(false)
  })
})

describe('Property 6: Migration bảo toàn nguyên vẹn product_type_templates', () => {
  it('copies templates one-to-one without changing content', () => {
    fc.assert(
      fc.property(fc.array(categoryArb, { minLength: 1, maxLength: 8 }), (categories) => {
        const legacy = legacyDb(categories)
        const mapped = mapLegacyToThreeTier(legacy)
        expect(mapped.productTypeTemplates).toEqual(legacy.productTypeTemplates)
      }),
      { numRuns: 100 }
    )
  })
})

describe('status arbitrary smoke', () => {
  it('keeps every stock status unchanged', () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        const legacy = legacyDb(['Streaming'])
        legacy.products[0].status = status
        expect(mapLegacyToThreeTier(legacy).productItems[0].status).toBe(status)
      }),
      { numRuns: 100 }
    )
  })
})
