/**
 * Render tin nhắn "Mua hàng thành công" cho từng product_type — đa ngôn ngữ.
 *
 * Cấu trúc tin nhắn = HEADER cố định (theo `lang`) + BODY.
 *  - HEADER (luôn có): tiêu đề + emoji name × qty + nhãn nội dung sản phẩm.
 *    Bản 'vi' GIỮ NGUYÊN nội dung+emoji cũ; bản ngôn ngữ mới dùng chữ thuần.
 *  - BODY = success_template của product_type theo `lang`. Chọn theo thứ tự:
 *    `lang` → `BASE_FALLBACK_LANG` → body mặc định dựng sẵn theo `lang` (R16.5).
 *
 * Placeholder dùng trong BODY (admin nhập ở CMS):
 *   [content]   → danh sách account đã mua (đánh số, mỗi dòng bọc <code>)
 *   [name]      → tên loại sản phẩm
 *   [emoji]     → emoji loại sản phẩm
 *   [quantity]  → số lượng mua
 *   [total]     → tổng tiền (đã format theo lang, vd 75.000đ)
 *   [balance]   → số dư còn lại (đã format theo lang)
 *
 * BODY là HTML do admin kiểm soát → KHÔNG escape phần template.
 * Giá trị động (account content, name) ĐƯỢC escape để không phá vỡ HTML (R16.6).
 *
 * HEADER + nhãn body mặc định lấy từ catalog i18n bot theo `lang` (key `purchase.success.*`)
 * — thêm ngôn ngữ chỉ cần thêm catalog, KHÔNG sửa renderer (R16.4, OCP).
 */

import { formatMoneyFor, type CurrencyContext } from './format'
import { t } from '../bot/i18n'
import { BASE_FALLBACK_LANG, type Lang } from '../i18n/locales'

export interface SuccessTemplateVars {
  emoji: string
  name: string
  quantity: number
  totalAmount: number
  balanceAfter: number
  contents: string[]
}

/** Các placeholder được hỗ trợ — dùng để hint ở CMS. */
export const TEMPLATE_PLACEHOLDERS = [
  '[content]',
  '[name]',
  '[emoji]',
  '[quantity]',
  '[total]',
  '[balance]',
] as const

/** Escape các ký tự đặc biệt của Telegram HTML (&, <, >). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Build danh sách account đánh số, mỗi account bọc <code> (đã escape). */
function buildContentList(contents: string[]): string {
  return contents
    .map((c, i) => `${i + 1}. <code>${escapeHtml(c)}</code>`)
    .join('\n')
}

/** Header cố định theo ngôn ngữ — luôn xuất hiện ở đầu mọi tin nhắn thành công. */
function buildHeader(vars: SuccessTemplateVars, lang: Lang): string {
  return [
    t(lang, 'purchase.success.header'),
    '',
    `${vars.emoji} ${escapeHtml(vars.name)} × ${vars.quantity}`,
    '',
    t(lang, 'purchase.success.content_label'),
  ].join('\n')
}

/** Body mặc định theo ngôn ngữ khi product_type không cấu hình template riêng. */
function defaultBody(vars: SuccessTemplateVars, ctx: CurrencyContext): string {
  const lang = ctx.lang
  return [
    buildContentList(vars.contents),
    '',
    t(lang, 'purchase.success.divider'),
    `${t(lang, 'purchase.success.total_label')}: ${formatMoneyFor(vars.totalAmount, ctx)}`,
    `${t(lang, 'purchase.success.balance_label')}: ${formatMoneyFor(vars.balanceAfter, ctx)}`,
  ].join('\n')
}

/** Thay placeholder trong body custom bằng giá trị thật ([total]/[balance] theo Region/lang). */
function renderBody(template: string, vars: SuccessTemplateVars, ctx: CurrencyContext): string {
  const replacements: Record<string, string> = {
    '[content]': buildContentList(vars.contents),
    '[name]': escapeHtml(vars.name),
    '[emoji]': vars.emoji,
    '[quantity]': String(vars.quantity),
    '[total]': formatMoneyFor(vars.totalAmount, ctx),
    '[balance]': formatMoneyFor(vars.balanceAfter, ctx),
  }
  return template.replace(
    /\[(content|name|emoji|quantity|total|balance)\]/g,
    (match) => replacements[match] ?? match
  )
}

/**
 * Render tin nhắn thành công đầy đủ: HEADER (theo lang) + BODY.
 *
 * Chọn BODY theo thứ tự fallback xác định (R16.5):
 *   templates[lang] (non-empty) → templates[BASE_FALLBACK_LANG] (non-empty) → body mặc định theo lang.
 * HEADER luôn lấy theo `lang` (không phụ thuộc template nào được chọn).
 *
 * @param templatesByLang - map lang → success_template (null/empty → bỏ qua mắt xích đó)
 * @param vars - dữ liệu thay thế
 * @param ctx - CurrencyContext của người mua (Region/lang/rate); [total]/[balance] hiển thị theo Region
 */
export function renderSuccessMessage(
  templatesByLang: Map<Lang, string | null>,
  vars: SuccessTemplateVars,
  ctx: CurrencyContext
): string {
  const header = buildHeader(vars, ctx.lang)
  const tpl =
    templatesByLang.get(ctx.lang)?.trim() ||
    templatesByLang.get(BASE_FALLBACK_LANG)?.trim()
  const body = tpl ? renderBody(tpl, vars, ctx) : defaultBody(vars, ctx)
  return `${header}\n${body}`
}
