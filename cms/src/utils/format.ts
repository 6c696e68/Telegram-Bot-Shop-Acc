import i18n from '@/i18n'

/** BCP-47 tag theo locale CMS hiện tại (R4.6). */
function bcp47(): string {
  return i18n.global.locale.value === 'vi' ? 'vi-VN' : 'en-US'
}

/** Số tiền VND theo locale CMS hiện tại, hậu tố 'đ'. vi→150.000đ, en→150,000đ */
export function formatMoney(amountVnd: number): string {
  return amountVnd.toLocaleString(bcp47()) + 'đ'
}

/** Số nguyên/đếm theo locale CMS hiện tại. */
export function formatNumber(n: number): string {
  return n.toLocaleString(bcp47())
}
