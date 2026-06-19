import { isSupportedLang } from '../i18n/locales'

export const PRODUCT_PRICE_MIN = 1
export const PRODUCT_PRICE_MAX = 999_999_999
/** Trần số lượng mỗi đơn: mặc định 10, cho phép cấu hình trong [1, 50] (trần cứng hệ thống). */
export const PRODUCT_MAX_PER_ORDER_MIN = 1
export const PRODUCT_MAX_PER_ORDER_MAX = 50
export const PRODUCT_MAX_PER_ORDER_DEFAULT = 10
export const TRANSLATION_NAME_MAX = 200
export const TRANSLATION_DESCRIPTION_MAX = 2_000
export const TRANSLATION_CONTENT_MAX = 5_000

export interface TranslationInput {
  name?: unknown
  description?: unknown
  content?: unknown
}

export interface NormalizedTranslationFields {
  name: string
  description: string | null
  content: string | null
}

export function isValidPrice(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= PRODUCT_PRICE_MIN &&
    value <= PRODUCT_PRICE_MAX
  )
}

export function validatePrice(value: unknown): string | null {
  return isValidPrice(value) ? null : 'price_out_of_range'
}

export function isValidMaxPerOrder(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= PRODUCT_MAX_PER_ORDER_MIN &&
    value <= PRODUCT_MAX_PER_ORDER_MAX
  )
}

/** Validate trần số lượng mỗi đơn — phải là số nguyên trong [1, 50]. */
export function validateMaxPerOrder(value: unknown): string | null {
  return isValidMaxPerOrder(value) ? null : 'max_per_order_out_of_range'
}

export function validateSupportedLang(lang: unknown): string | null {
  return typeof lang === 'string' && isSupportedLang(lang.trim()) ? null : 'unsupported_language'
}

export function normalizeTranslationFields(input: TranslationInput): NormalizedTranslationFields | string {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  const description =
    typeof input.description === 'string' && input.description.trim().length > 0
      ? input.description.trim()
      : null
  const content =
    typeof input.content === 'string' && input.content.trim().length > 0 ? input.content.trim() : null

  if (name.length === 0) return 'translation_name_required'
  if (name.length > TRANSLATION_NAME_MAX) return 'translation_name_too_long'
  if ((description?.length ?? 0) > TRANSLATION_DESCRIPTION_MAX) {
    return 'translation_description_too_long'
  }
  if ((content?.length ?? 0) > TRANSLATION_CONTENT_MAX) {
    return 'translation_content_too_long'
  }

  return { name, description, content }
}

export function validateTranslationFields(input: TranslationInput): string | null {
  const normalized = normalizeTranslationFields(input)
  return typeof normalized === 'string' ? normalized : null
}
