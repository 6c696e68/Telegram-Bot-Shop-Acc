/**
 * Format utilities — currency, number, date theo locale.
 * Requirements: 4.6
 */

import type { Lang } from '../i18n/locales'

/**
 * Bảng tra Lang -> BCP 47 locale dùng cho Intl.NumberFormat.
 * `vi` -> `vi-VN` (nhóm bằng dấu chấm: 150.000), `en` -> `en-US` (dấu phẩy: 150,000).
 * Mở rộng ngôn ngữ = thêm 1 dòng ở đây (không sửa logic).
 */
const NUMBER_LOCALE_BY_LANG: Record<Lang, string> = {
  vi: 'vi-VN',
  en: 'en-US',
}

/**
 * Định dạng số nguyên/thập phân theo Language của User.
 * Ví dụ: formatNumber(150000, 'vi') -> "150.000"; formatNumber(150000, 'en') -> "150,000"
 */
export function formatNumber(n: number, lang: Lang): string {
  return new Intl.NumberFormat(NUMBER_LOCALE_BY_LANG[lang]).format(n)
}

/**
 * Định dạng số tiền VND theo Language của User. Giữ đơn vị VND (suffix `đ`),
 * chỉ đổi cách nhóm chữ số theo locale.
 * Ví dụ: formatMoney(150000, 'vi') -> "150.000đ"; formatMoney(150000, 'en') -> "150,000đ"
 */
export function formatMoney(amountVnd: number, lang: Lang): string {
  return formatNumber(amountVnd, lang) + 'đ'
}

/**
 * Alias tương thích ngược cho các nơi gọi cũ (Bot/CMS/Mini App backend) chưa
 * truyền Language. Thống nhất hiển thị VND theo `vi` (nhóm bằng dấu chấm).
 * Lưu ý: định dạng đổi từ `150,000đ` -> `150.000đ` theo R4.6 (có chủ đích).
 */
export function formatCurrency(amount: number): string {
  return formatMoney(amount, 'vi')
}

/**
 * Bảng tra Lang -> BCP 47 locale cho định dạng ngày giờ.
 */
const DATETIME_LOCALE_BY_LANG: Record<Lang, string> = {
  vi: 'vi-VN',
  en: 'en-US',
}

/**
 * Định dạng ngày giờ (ISO 8601 UTC) theo Language của User (R4.6).
 * Giữ múi giờ UTC để khớp hành vi `formatDate` cũ; chỉ đổi cách trình bày theo locale.
 */
export function formatDateTime(isoString: string, lang: Lang): string {
  return new Intl.DateTimeFormat(DATETIME_LOCALE_BY_LANG[lang], {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(isoString))
}

/**
 * Convert ISO 8601 UTC string sang "DD/MM/YYYY HH:mm".
 * Ví dụ: "2024-07-02T11:08:33.000Z" → "02/07/2024 11:08"
 */
export function formatDate(isoString: string): string {
  const date = new Date(isoString)

  const day = String(date.getUTCDate()).padStart(2, '0')
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const year = date.getUTCFullYear()
  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')

  return `${day}/${month}/${year} ${hours}:${minutes}`
}
