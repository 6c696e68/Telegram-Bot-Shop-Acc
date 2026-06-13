/**
 * Product template service — tải bản template bán hàng đa ngôn ngữ.
 *
 * Nguồn dữ liệu là bảng `product_type_templates`. Sau migration 0015, cột
 * `product_type_id` được giữ tên cũ để tương thích schema, nhưng giá trị trỏ tới
 * `products.id` (Product có giá).
 *
 * Tách khỏi `src/utils/telegram-template.ts` (thuần render, không chạm DB) để tránh
 * vòng import và giữ ranh giới trách nhiệm rõ ràng (renderer = pure, loader = I/O).
 */

import { isSupportedLang, type Lang } from '../i18n/locales'

/**
 * Tải toàn bộ template theo từng ngôn ngữ của một Product bằng MỘT query.
 * Chỉ giữ các bản có `lang` thuộc registry `SUPPORTED_LANGUAGES` (phòng dữ liệu
 * cũ/lạ trong cột mở `lang`); giá trị `success_template` có thể là null.
 *
 * @returns `Map<Lang, string|null>` — rỗng nếu Product chưa cấu hình template.
 */
export async function loadProductTemplates(
  db: D1Database,
  productId: number
): Promise<Map<Lang, string | null>> {
  const { results } = await db
    .prepare(
      'SELECT lang, success_template FROM product_type_templates WHERE product_type_id = ?'
    )
    .bind(productId)
    .all<{ lang: string; success_template: string | null }>()

  const templatesByLang = new Map<Lang, string | null>()
  for (const row of results ?? []) {
    if (isSupportedLang(row.lang)) {
      templatesByLang.set(row.lang, row.success_template)
    }
  }
  return templatesByLang
}

/** @deprecated Dùng `loadProductTemplates`; alias giữ tương thích call site cũ. */
export const loadProductTypeTemplates = loadProductTemplates
