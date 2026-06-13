import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { BASE_FALLBACK_LANG, type Lang } from '../src/i18n/locales'
import {
  buildDisplayPlaceholder,
  isValidText,
  loadDisplayLang,
  loadProductTranslations,
  resolveDisplayText,
  type EntityTranslations,
} from '../src/services/i18n-catalog'
import { resetThreeTierSchema, seedCategory, seedPricedProduct } from './helpers/three-tier-schema'

// Feature: product-catalog-i18n-upgrade, Property 8: Doc chi tra ngon ngu thuoc registry
// Feature: product-catalog-i18n-upgrade, Property 11: Fallback hien thi theo tung truong

const textArb = fc.option(fc.string({ minLength: 0, maxLength: 20 }), { nil: null })
const unsupportedLangArb = fc
  .string({ minLength: 1, maxLength: 8 })
  .filter((lang) => lang !== 'vi' && lang !== 'en')

function translations(params: {
  display?: string | null
  defaultValue?: string | null
  baseFallback?: string | null
}): EntityTranslations {
  const byLang = new Map<Lang, { name: string | null; description: string | null; content: string | null }>()
  byLang.set('vi', { name: params.display ?? null, description: null, content: null })
  byLang.set('en', { name: params.defaultValue ?? params.baseFallback ?? null, description: null, content: null })
  return { byLang }
}

function valid(value: string | null): string | null {
  return isValidText(value) ? value.trim() : null
}

beforeEach(async () => {
  await resetThreeTierSchema(env.DB)
})

describe('Property 11: Fallback hiển thị theo từng trường luôn cho chuỗi khác rỗng', () => {
  it('uses display, default, base fallback, base value, then placeholder in order', () => {
    fc.assert(
      fc.property(textArb, textArb, textArb, (displayValue, defaultValue, baseValue) => {
        const placeholder = buildDisplayPlaceholder('x')
        const data = translations({ display: displayValue, defaultValue })
        const resolved = resolveDisplayText(data, 'name', baseValue, 'vi', 'en', placeholder)
        const expected =
          valid(displayValue) ??
          valid(defaultValue) ??
          valid(defaultValue) ??
          valid(baseValue) ??
          placeholder

        expect(resolved).toBe(expected)
        expect(resolved.trim().length).toBeGreaterThan(0)
      }),
      { numRuns: 100 }
    )
  })

  it('resolves each field independently', () => {
    const entity: EntityTranslations = {
      byLang: new Map([
        ['vi', { name: 'Tên VI', description: '', content: 'Nội dung VI' }],
        [BASE_FALLBACK_LANG, { name: 'Name EN', description: 'Description EN', content: '' }],
      ]),
    }

    expect(resolveDisplayText(entity, 'name', 'Base name', 'vi', 'en', 'Placeholder')).toBe('Tên VI')
    expect(resolveDisplayText(entity, 'description', 'Base description', 'vi', 'en', 'Placeholder')).toBe('Description EN')
    expect(resolveDisplayText(entity, 'content', 'Base content', 'vi', 'en', 'Placeholder')).toBe('Nội dung VI')
  })
})

describe('Property 8: Đọc chỉ trả ngôn ngữ thuộc registry', () => {
  it('loadProductTranslations drops unsupported language rows and loadDisplayLang fails safe', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom<Lang>('vi', 'en'), unsupportedLangArb, async (supportedLang, unsupportedLang) => {
        await resetThreeTierSchema(env.DB)
        const categoryId = await seedCategory(env.DB, 'Category')
        const productId = await seedPricedProduct(env.DB, { categoryId, name: 'Product', price: 10_000 })
        const supportedName = `Name ${supportedLang}`

        await env.DB
          .prepare('INSERT INTO product_translations (product_id, lang, name) VALUES (?, ?, ?), (?, ?, ?)')
          .bind(productId, supportedLang, supportedName, productId, unsupportedLang, 'Unsupported')
          .run()
        await env.DB
          .prepare('INSERT INTO system_config (key, value) VALUES (?, ?)')
          .bind('default_language', unsupportedLang)
          .run()

        const loaded = await loadProductTranslations(env.DB, productId)
        expect([...loaded.byLang.keys()]).toEqual([supportedLang])
        expect(loaded.byLang.get(supportedLang)?.name).toBe(supportedName)
        expect(await loadDisplayLang(env.DB)).toBe(BASE_FALLBACK_LANG)
      }),
      { numRuns: 100 }
    )
  })
})
