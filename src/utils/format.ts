/**
 * Format utilities — currency, number, date theo locale.
 * Requirements: 4.6
 */

import type { Lang, Region } from '../i18n/locales'
import { readSystemConfigValue } from './system-config'

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

// ─────────────────────────────────────────────────────────────────────────────
// Currency display (USD) — choke point cho hiển thị tiền theo Region.
// Lưu trữ/thanh toán/limit vẫn VND/USDT-native; phần dưới chỉ đụng tới chuỗi hiển thị.
// Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Context tiền tệ theo từng request. Build một lần tại nơi đã load User (Region).
 * `rate` là Valid_Rate (số chia VND-per-USD) đã parse, hoặc null khi thiếu/không hợp lệ.
 */
export interface CurrencyContext {
  lang: Lang
  region: Region | null
  rate: number | null
}

/**
 * Guard Valid_Rate (R2/R3). Parse chuỗi system_config thành số hữu hạn > 0, ngược lại null.
 * Khớp với cách payment path hiểu "hợp lệ" để hiển thị và crediting đồng thuận.
 */
export function parseRate(value: string | undefined | null): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Helper làm tròn/định dạng (R2.1–R2.3). Caller PHẢI truyền Valid_Rate (> 0, hữu hạn).
 * usd = amountVnd / rate, cố định đúng 2 chữ số thập phân, prefix '$', giữ số 0 cuối.
 * Không thay đổi Stored_Amount VND (R2.4).
 */
export function vndToUsdString(amountVnd: number, rate: number): string {
  return '$' + (amountVnd / rate).toFixed(2)
}

/**
 * Formatter theo tiền tệ (R1, R3). Là choke point hiển thị duy nhất.
 *   international + Valid_Rate  → USD_String
 *   còn lại (vietnam/null/unknown/rate không hợp lệ) → VND_String (fail-safe)
 * Fail-safe hữu hạn (R3.3): chỉ phát USD_String khi giá trị USD render được thành
 * chuỗi `$d.dd` hợp lệ. Rate hợp lệ nhưng cực nhỏ có thể khiến amountVnd/rate:
 *   - tràn thành Infinity (vd rate=5e-324) → "$Infinity", hoặc
 *   - vượt 1e21 (vd rate=5.56e-309) → Number.toFixed phát ký pháp mũ "$1.79e+308".
 * Cả hai đều là chuỗi vỡ. Guard dưới đây chỉ phát USD khi usd hữu hạn VÀ < 1e21
 * (ngưỡng toFix=fixed-notation); ngược lại fallback về VND để không bao giờ phát chuỗi vỡ.
 * Với input hợp lệ thực tế (rate ≥ 0.01, amount ≤ 1e9) usd ≤ 1e11 nên không bao giờ bị fallback.
 */
const USD_TOFIXED_SAFE_MAX = 1e21

export function formatMoneyFor(amountVnd: number, ctx: CurrencyContext): string {
  if (ctx.region === 'international' && ctx.rate !== null) {
    const usd = amountVnd / ctx.rate
    if (Number.isFinite(usd) && Math.abs(usd) < USD_TOFIXED_SAFE_MAX) {
      return vndToUsdString(amountVnd, ctx.rate)
    }
  }
  return formatMoney(amountVnd, ctx.lang)
}

/**
 * Build CurrencyContext (đọc rate một lần mỗi request, DB-first, không cache).
 * Đọc `exchange_rate_usdt_vnd` qua readSystemConfigValue rồi parse qua parseRate.
 */
export async function buildCurrencyContext(
  db: D1Database,
  opts: { lang: Lang; region: Region | null }
): Promise<CurrencyContext> {
  const rate = parseRate(await readSystemConfigValue(db, 'exchange_rate_usdt_vnd'))
  return { lang: opts.lang, region: opts.region, rate }
}
