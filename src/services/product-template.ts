/**
 * Product template service — tải bản template bán hàng đa ngôn ngữ.
 *
 * Nguồn dữ liệu là bảng `product_type_templates` (khoá theo `product_type_id, lang`)
 * thay cho cột cứng `product_types.success_template` (đã deprecated sau migration 0008).
 *
 * Tách khỏi `src/utils/telegram-template.ts` (thuần render, không chạm DB) để tránh
 * vòng import và giữ ranh giới trách nhiệm rõ ràng (renderer = pure, loader = I/O).
 */

import { isSupportedLang, type Lang } from '../i18n/locales'

/**
 * Tải toàn bộ template theo từng ngôn ngữ của một product_type bằng MỘT query.
 * Chỉ giữ các bản có `lang` thuộc registry `SUPPORTED_LANGUAGES` (phòng dữ liệu
 * cũ/lạ trong cột mở `lang`); giá trị `success_template` có thể là null.
 *
 * @returns `Map<Lang, string|null>` — rỗng nếu product_type chưa cấu hình template.
 */
export async function loadProductTypeTemplates(
  db: D1Database,
  productTypeId: number
): Promise<Map<Lang, string | null>> {
  const { results } = await db
    .prepare(
      'SELECT lang, success_template FROM product_type_templates WHERE product_type_id = ?'
    )
    .bind(productTypeId)
    .all<{ lang: string; success_template: string | null }>()

  const templatesByLang = new Map<Lang, string | null>()
  for (const row of results ?? []) {
    if (isSupportedLang(row.lang)) {
      templatesByLang.set(row.lang, row.success_template)
    }
  }
  return templatesByLang
}
