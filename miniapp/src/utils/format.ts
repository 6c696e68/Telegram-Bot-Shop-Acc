/**
 * format.ts — tiện ích hiển thị phía frontend.
 *
 * Tiền tệ format CLIENT-SIDE theo LOCALE hiện tại của Mini App (đã sync = ngôn ngữ
 * user — R4.6). KHÔNG dùng chuỗi `*_display` của server nữa để tránh lẫn lộn định
 * dạng (server ghim `vi`, client theo ngôn ngữ user). Thời gian giữ nguyên UTC.
 */

import i18n from '@/i18n'

/** BCP-47 tag theo locale hiện tại của Mini App (R4.6). */
function bcp47(): string {
  return i18n.global.locale.value === 'vi' ? 'vi-VN' : 'en-US'
}

/**
 * Format số tiền VNĐ với dấu phân cách hàng nghìn theo locale hiện tại (R4.6).
 * Ví dụ: 150000 → "150.000đ" (vi) hoặc "150,000đ" (en). Đọc `i18n.global.locale.value`
 * nên reactive theo đổi ngôn ngữ khi dùng trong template/computed.
 */
export function formatCurrency(amount: number): string {
  return amount.toLocaleString(bcp47()) + 'đ'
}

/** Ngữ cảnh vùng + tỉ giá để format tiền region-aware (mirror backend `formatMoneyFor`). */
export interface MoneyContext {
  region: 'vietnam' | 'international' | null
  rate: number | null
}

/**
 * Format số tiền (INTEGER VNĐ) theo vùng — mirror backend `formatMoneyFor`.
 * Chỉ trả USD khi region='international' và `rate` hữu hạn > 0 và USD tính ra hữu hạn,
 * `< 1e21`; mọi trường hợp khác fallback VNĐ qua `formatCurrency` (fail-safe). Guard này
 * khớp backend để giá trị động (vd tổng tiền price × qty) hiển thị y hệt chuỗi server.
 */
export function formatMoneyFor(amountVnd: number, ctx: MoneyContext): string {
  if (ctx.region === 'international' && ctx.rate != null && Number.isFinite(ctx.rate) && ctx.rate > 0) {
    const usd = amountVnd / ctx.rate
    if (Number.isFinite(usd) && Math.abs(usd) < 1e21) {
      return '$' + usd.toFixed(2)
    }
  }
  return formatCurrency(amountVnd)
}

/**
 * Convert chuỗi ISO 8601 UTC sang "DD/MM/YYYY HH:mm" theo giờ UTC.
 * Khớp `formatDate` backend để hiển thị thời gian đơn hàng nhất quán.
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
