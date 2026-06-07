import i18n from '@/i18n'

/** BCP-47 tag theo locale CMS hiện tại (R4.6). */
function bcp47(): string {
  return i18n.global.locale.value === 'vi' ? 'vi-VN' : 'en-US'
}

/** Valid_Rate guard (R4.2): chuỗi cấu hình → số hữu hạn > 0, ngược lại null. */
function parseRate(v: string | null | undefined): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Hiển thị kép (R4.1, R4.2, R4.4). Rate hợp lệ → "150.000đ (~$5.00)";
 * thiếu/không hợp lệ → "150.000đ" (VND-only, fail-safe).
 * Backward-compatible: gọi chỉ với amountVnd vẫn ra chuỗi VND như trước.
 */
export function formatMoney(amountVnd: number, rate?: number | null): string {
  const vnd = amountVnd.toLocaleString(bcp47()) + 'đ'
  const r = typeof rate === 'number' ? rate : null
  if (r !== null && Number.isFinite(r) && r > 0) {
    return `${vnd} (~$${(amountVnd / r).toFixed(2)})`
  }
  return vnd
}

export { parseRate }

/** Số nguyên/đếm theo locale CMS hiện tại. */
export function formatNumber(n: number): string {
  return n.toLocaleString(bcp47())
}
