import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  PRODUCT_PRICE_MAX,
  PRODUCT_PRICE_MIN,
  TRANSLATION_CONTENT_MAX,
  TRANSLATION_DESCRIPTION_MAX,
  TRANSLATION_NAME_MAX,
  validatePrice,
  validateSupportedLang,
  validateTranslationFields,
} from '../src/services/catalog-validation'

// Feature: product-catalog-i18n-upgrade, Property 1: Validate gia la all-or-nothing
// Feature: product-catalog-i18n-upgrade, Property 10: Validate do dai truong dich

describe('Property 1: Validate giá là all-or-nothing', () => {
  it('accepts only integer VND prices in the allowed range', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.integer({ min: -10, max: PRODUCT_PRICE_MAX + 10 }),
          fc.float({ noNaN: true }),
          fc.string(),
          fc.constant(null),
          fc.constant(undefined)
        ),
        (value) => {
          const valid =
            typeof value === 'number' &&
            Number.isInteger(value) &&
            value >= PRODUCT_PRICE_MIN &&
            value <= PRODUCT_PRICE_MAX
          expect(validatePrice(value)).toBe(valid ? null : 'price_out_of_range')
        }
      ),
      { numRuns: 100 }
    )
  })
})

describe('Property 10: Validate độ dài trường dịch', () => {
  it('enforces supported language and translation field length limits', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: TRANSLATION_NAME_MAX + 2 }),
        fc.string({ minLength: 0, maxLength: TRANSLATION_DESCRIPTION_MAX + 2 }),
        fc.string({ minLength: 0, maxLength: TRANSLATION_CONTENT_MAX + 2 }),
        fc.constantFrom('vi', 'en', 'zz', ''),
        (name, description, content, lang) => {
          const expected =
            name.trim().length === 0
              ? 'translation_name_required'
              : name.trim().length > TRANSLATION_NAME_MAX
                ? 'translation_name_too_long'
                : description.trim().length > TRANSLATION_DESCRIPTION_MAX
                  ? 'translation_description_too_long'
                  : content.trim().length > TRANSLATION_CONTENT_MAX
                    ? 'translation_content_too_long'
                    : null

          expect(validateTranslationFields({ name, description, content })).toBe(expected)
          expect(validateSupportedLang(lang)).toBe(lang === 'vi' || lang === 'en' ? null : 'unsupported_language')
        }
      ),
      { numRuns: 100 }
    )
  })
})
