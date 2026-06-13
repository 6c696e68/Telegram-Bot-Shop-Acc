import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import {
  resetThreeTierSchema,
  seedCategory,
  seedPricedProduct,
  seedProductItems,
} from './helpers/three-tier-schema'

// Feature: product-catalog-i18n-upgrade, Property 3: Tao ban ghi con can cha ton tai
// Feature: product-catalog-i18n-upgrade, Property 4: Chan xoa cha con con

beforeEach(async () => {
  await resetThreeTierSchema(env.DB)
  await env.DB.prepare('PRAGMA foreign_keys=ON').run()
})

describe('Property 3: Tạo bản ghi con cần cha tồn tại', () => {
  it('rejects products without an existing category and product_items without an existing product', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1_000, max: 10_000 }), async (missingId) => {
        await resetThreeTierSchema(env.DB)
        await expect(
          env.DB
            .prepare('INSERT INTO products (product_type_id, name, price) VALUES (?, ?, ?)')
            .bind(missingId, 'Orphan product', 10_000)
            .run()
        ).rejects.toThrow()

        await expect(
          env.DB
            .prepare('INSERT INTO product_items (product_id, content) VALUES (?, ?)')
            .bind(missingId, `stock-${missingId}`)
            .run()
        ).rejects.toThrow()
      }),
      { numRuns: 100 }
    )
  })
})

describe('Property 4: Chặn xoá cha còn con', () => {
  it('blocks deleting a category with products and a product with stock items', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (stockCount) => {
        await resetThreeTierSchema(env.DB)
        const categoryId = await seedCategory(env.DB, 'Category')
        const productId = await seedPricedProduct(env.DB, { categoryId, name: 'Product', price: 10_000 })
        await seedProductItems(env.DB, productId, stockCount, 'available')

        await expect(env.DB.prepare('DELETE FROM product_types WHERE id = ?').bind(categoryId).run()).rejects.toThrow()
        await expect(env.DB.prepare('DELETE FROM products WHERE id = ?').bind(productId).run()).rejects.toThrow()

        expect(await env.DB.prepare('SELECT id FROM product_types WHERE id = ?').bind(categoryId).first()).not.toBeNull()
        expect(await env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(productId).first()).not.toBeNull()
      }),
      { numRuns: 100 }
    )
  })
})
