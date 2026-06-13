import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import {
  computeStock,
  getProductStock,
  isInStock,
  listProductsWithStock,
  pickThumbnail,
} from '../src/services/catalog-service'
import {
  resetThreeTierSchema,
  seedCategory,
  seedPricedProduct,
  seedProductItems,
} from './helpers/three-tier-schema'

// Feature: product-catalog-i18n-upgrade, Property 2: Ton kho dong bang Product_Item available
// Feature: product-catalog-i18n-upgrade, Property 12: Uu tien anh thay the cua Product

beforeEach(async () => {
  await resetThreeTierSchema(env.DB)
})

describe('Property 2: Tồn kho động bằng số Product_Item available', () => {
  it('computeStock counts only available items', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('available', 'sold', 'reserved', 'other'), { minLength: 0, maxLength: 50 }),
        (statuses) => {
          const stock = computeStock(statuses.map((status) => ({ status })))
          expect(stock).toBe(statuses.filter((status) => status === 'available').length)
          expect(isInStock(stock)).toBe(stock > 0)
        },
      ),
      { numRuns: 100 }
    )
  })

  it('getProductStock and listProductsWithStock count product_items dynamically', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 6 }),
        fc.integer({ min: 0, max: 4 }),
        async (availableCount, soldCount) => {
          await resetThreeTierSchema(env.DB)
          const categoryId = await seedCategory(env.DB, 'Category')
          const productId = await seedPricedProduct(env.DB, { categoryId, name: 'Product', price: 10_000 })
          await seedProductItems(env.DB, productId, availableCount, 'available')
          await seedProductItems(env.DB, productId, soldCount, 'sold')

          expect(await getProductStock(env.DB, productId)).toBe(availableCount)
          const products = await listProductsWithStock(env.DB, categoryId)
          expect(products.find((p) => p.id === productId)?.stock).toBe(availableCount)
        },
      ),
      { numRuns: 100 }
    )
  })
})

describe('Property 12: Ưu tiên ảnh thay thế của Product', () => {
  it('prefers product image, then product emoji, then category emoji, then none', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string({ minLength: 0, maxLength: 20 }), { nil: null }),
        fc.option(fc.string({ minLength: 0, maxLength: 10 }), { nil: null }),
        fc.option(fc.string({ minLength: 0, maxLength: 10 }), { nil: null }),
        (imageData, productEmoji, typeEmoji) => {
          const thumb = pickThumbnail(
            { image_data: imageData, emoji: productEmoji },
            { emoji: typeEmoji }
          )
          const image = typeof imageData === 'string' && imageData.trim() ? imageData.trim() : null
          const productGlyph =
            typeof productEmoji === 'string' && productEmoji.trim() ? productEmoji.trim() : null
          const typeGlyph = typeof typeEmoji === 'string' && typeEmoji.trim() ? typeEmoji.trim() : null

          if (image) expect(thumb).toEqual({ kind: 'image', value: image })
          else if (productGlyph) expect(thumb).toEqual({ kind: 'emoji', value: productGlyph })
          else if (typeGlyph) expect(thumb).toEqual({ kind: 'emoji', value: typeGlyph })
          else expect(thumb).toEqual({ kind: 'none', value: null })
        },
      ),
      { numRuns: 100 }
    )
  })
})
