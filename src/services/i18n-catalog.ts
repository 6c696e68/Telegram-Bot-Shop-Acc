/**
 * i18n Catalog resolver — logic fallback hiển thị đa ngôn ngữ cho Product_Type/Product.
 *
 * Một nguồn logic fallback DUY NHẤT dùng chung cho Bot / Mini App / CMS (D6 trong design),
 * tách phần thuần (resolveDisplayText / isValidText / placeholder) khỏi phần I/O
 * (loadProductTranslations / loadProductTypeTranslations / loadDisplayLang) để dễ test PBT.
 *
 * Nguyên tắc:
 *  - Áp dụng chuỗi fallback ĐỘC LẬP cho từng trường văn bản (name, description, content):
 *      Display_Language → Default_Language → BASE_FALLBACK_LANG → Base_Value → placeholder  (R4.5)
 *  - Một trường HỢP LỆ ⇔ khác null và khác chuỗi rỗng sau khi trim (R4.1).
 *  - Kết quả LUÔN khác chuỗi rỗng khi placeholder khác rỗng (R4.6, R11.7).
 *  - Bản dịch có `lang` ngoài `SUPPORTED_LANGUAGES` bị loại ngay ở bước nạp (R3.5),
 *    nên không bao giờ lọt vào `byLang`.
 *  - `default_language` đọc runtime từ `system_config`; sai/thiếu → `BASE_FALLBACK_LANG`
 *    (fail-safe, đồng nhất với `resolveLang`).
 */

import { BASE_FALLBACK_LANG, isSupportedLang, type Lang } from '../i18n/locales'
import { readSystemConfigValue } from '../utils/system-config'

/** Key trong `system_config` chứa mã locale mặc định toàn hệ thống. */
const DEFAULT_LANGUAGE_KEY = 'default_language'

/** Ba trường văn bản hiển thị đa ngôn ngữ của Product_Type/Product. */
export type Field = 'name' | 'description' | 'content'

/** Giá trị ba trường dịch của một ngôn ngữ (mỗi trường có thể null). */
export interface TranslationFields {
  name: string | null
  description: string | null
  content: string | null
}

/**
 * Bản dịch của một thực thể đã LỌC theo `SUPPORTED_LANGUAGES` (R3.5).
 * `byLang`: map mã ngôn ngữ → giá trị từng trường.
 */
export interface EntityTranslations {
  byLang: Map<Lang, TranslationFields>
}

/**
 * Tiền tố placeholder hiển thị — KHÁC chuỗi rỗng (R4.6, R11.7).
 * Không chèn emoji (tuân thủ AGENTS.md): dùng chữ thuần.
 */
export const DISPLAY_PLACEHOLDER_PREFIX = 'Sản phẩm #'

/**
 * Sinh placeholder hiển thị theo định danh thực thể — LUÔN khác chuỗi rỗng (R4.6, R11.7).
 * Dùng id để admin dễ truy vết khi Base_Value rỗng/null.
 */
export function buildDisplayPlaceholder(id: number | string): string {
  return `${DISPLAY_PLACEHOLDER_PREFIX}${id}`
}

/**
 * Một trường văn bản được coi là HỢP LỆ ⇔ khác null/undefined VÀ khác chuỗi rỗng
 * sau khi loại bỏ khoảng trắng đầu/cuối (trim) — R4.1.
 */
export function isValidText(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/**
 * Trả về chuỗi hiển thị KHÁC RỖNG cho một trường, áp chuỗi fallback độc lập từng trường:
 *   Display_Language → Default_Language → BASE_FALLBACK_LANG → Base_Value → placeholder (R4.2–R4.6).
 *
 * @param translations  bản dịch đã lọc theo SUPPORTED_LANGUAGES (R3.5)
 * @param field         trường cần resolve (name/description/content)
 * @param baseValue     Base_Value của trường (cột gốc trên bản ghi thực thể)
 * @param displayLang   Display_Language (đã qua resolveLang — luôn là Lang hợp lệ)
 * @param defaultLang   Default_Language (đọc từ system_config qua loadDisplayLang)
 * @param placeholder   giá trị placeholder KHÁC rỗng (R4.6, R11.7)
 * @returns chuỗi hiển thị, luôn khác chuỗi rỗng khi `placeholder` khác rỗng.
 */
export function resolveDisplayText(
  translations: EntityTranslations,
  field: Field,
  baseValue: string | null,
  displayLang: Lang,
  defaultLang: Lang,
  placeholder: string
): string {
  // Chuỗi mắt xích ngôn ngữ; trùng lặp (vd displayLang === defaultLang) vô hại vì chỉ duyệt tuần tự.
  const chain: Lang[] = [displayLang, defaultLang, BASE_FALLBACK_LANG]
  for (const lang of chain) {
    const v = translations.byLang.get(lang)?.[field]
    if (isValidText(v)) return v.trim()
  }
  if (isValidText(baseValue)) return baseValue.trim() // R4.6
  return placeholder // R4.6, R11.7 — luôn khác chuỗi rỗng
}

/** Hàng thô bản dịch đọc từ D1 (lang là cột mở, có thể chứa mã ngoài registry). */
interface TranslationRow {
  lang: string
  name: string | null
  description: string | null
  content: string | null
}

/** Gom các hàng thô thành `EntityTranslations`, CHỈ giữ lang thuộc registry (R3.5). */
function buildEntityTranslations(rows: readonly TranslationRow[] | null | undefined): EntityTranslations {
  const byLang = new Map<Lang, TranslationFields>()
  for (const r of rows ?? []) {
    if (isSupportedLang(r.lang)) {
      byLang.set(r.lang, { name: r.name, description: r.description, content: r.content })
    }
  }
  return { byLang }
}

/**
 * Nạp bản dịch của một Product từ D1, LỌC chỉ giữ lang thuộc SUPPORTED_LANGUAGES (R3.5).
 */
export async function loadProductTranslations(
  db: D1Database,
  productId: number
): Promise<EntityTranslations> {
  const { results } = await db
    .prepare('SELECT lang, name, description, content FROM product_translations WHERE product_id = ?')
    .bind(productId)
    .all<TranslationRow>()
  return buildEntityTranslations(results)
}

/**
 * Nạp bản dịch của một Product_Type từ D1, LỌC chỉ giữ lang thuộc SUPPORTED_LANGUAGES (R3.5).
 */
export async function loadProductTypeTranslations(
  db: D1Database,
  productTypeId: number
): Promise<EntityTranslations> {
  const { results } = await db
    .prepare('SELECT lang, name, description, content FROM product_type_translations WHERE product_type_id = ?')
    .bind(productTypeId)
    .all<TranslationRow>()
  return buildEntityTranslations(results)
}

/**
 * Đọc Default_Language (`system_config.default_language`) làm mắt xích default cho fallback.
 * Validate theo registry; thiếu/sai → `BASE_FALLBACK_LANG` (fail-safe, đồng nhất `resolveLang`).
 *
 * @returns luôn là một `Lang` hợp lệ.
 */
export async function loadDisplayLang(db: D1Database): Promise<Lang> {
  const defaultLanguage = await readSystemConfigValue(db, DEFAULT_LANGUAGE_KEY)
  return isSupportedLang(defaultLanguage) ? defaultLanguage : BASE_FALLBACK_LANG
}
