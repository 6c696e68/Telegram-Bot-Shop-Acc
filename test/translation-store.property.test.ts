import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { validateSupportedLang } from '../src/services/catalog-validation'
import { resetThreeTierSchema, seedCategory, seedPricedProduct } from './helpers/three-tier-schema'

// Feature: product-catalog-i18n-upgrade, Property 7: Tinh duy nhat cua thuc the ngon ngu
// Feature: product-catalog-i18n-upgrade, Property 9: Ghi ban dich tu choi ngon ngu ngoai registry

beforeEach(async () => {
  await resetThreeTierSchema(env.DB)
})

describe('Property 7: Tính duy nhất của (thực thể, ngôn ngữ)', () => {
  it('rejects duplicate translations for the same category/product and language', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom('vi', 'en'), async (lang) => {
        await resetThreeTierSchema(env.DB)
        const categoryId = await seedCategory(env.DB, 'Category')
        const productId = await seedPricedProduct(env.DB, { categoryId, name: 'Product', price: 10_000 })

        await env.DB
          .prepare('INSERT INTO product_type_translations (product_type_id, lang, name) VALUES (?, ?, ?)')
          .bind(categoryId, lang, 'Category translated')
          .run()
        await expect(
          env.DB
            .prepare('INSERT INTO product_type_translations (product_type_id, lang, name) VALUES (?, ?, ?)')
            .bind(categoryId, lang, 'Duplicate')
            .run()
        ).rejects.toThrow()

        await env.DB
          .prepare('INSERT INTO product_translations (product_id, lang, name) VALUES (?, ?, ?)')
          .bind(productId, lang, 'Product translated')
          .run()
        await expect(
          env.DB
            .prepare('INSERT INTO product_translations (product_id, lang, name) VALUES (?, ?, ?)')
            .bind(productId, lang, 'Duplicate')
            .run()
        ).rejects.toThrow()
      }),
      { numRuns: 100 }
    )
  })
})

describe('Property 9: Ghi bản dịch từ chối ngôn ngữ ngoài registry', () => {
  it('validates supported language codes before writes', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 8 }), (lang) => {
        const isSupported = lang === 'vi' || lang === 'en'
        expect(validateSupportedLang(lang)).toBe(isSupported ? null : 'unsupported_language')
      }),
      { numRuns: 100 }
    )
  })
})
