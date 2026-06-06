/**
 * Notify-deposit — helper render thông báo "nạp thành công" dùng chung cho mọi
 * luồng cộng tiền (webhook SePay, webhook CryptoBot, cron credit-awaiting).
 *
 * Gom 1 nơi để tránh lặp 3 lần (DRY) và giữ thông báo nhất quán giữa các provider.
 * Chuỗi lấy từ catalog i18n bot theo `lang` (key `deposit.success.*`) — thêm ngôn ngữ
 * chỉ cần thêm catalog, KHÔNG sửa helper (R4.1, OCP). Số tiền render qua
 * `formatMoney(amount, lang)` để nhóm chữ số đúng locale.
 */

import { formatMoney } from '../utils/format'
import { t } from './i18n'
import type { Lang } from '../i18n/locales'

/**
 * Dựng nội dung thông báo nạp thành công theo ngôn ngữ user.
 *
 * @param lang - Ngôn ngữ hiển thị đã resolve (`resolveLang`).
 * @param amountVnd - Số VND vừa cộng cho lần nạp này.
 * @param newBalanceVnd - Số dư mới sau khi cộng.
 */
export function renderDepositSuccess(
  lang: Lang,
  amountVnd: number,
  newBalanceVnd: number
): string {
  return [
    t(lang, 'deposit.success.header'),
    '',
    t(lang, 'deposit.success.amount', { amount: formatMoney(amountVnd, lang) }),
    t(lang, 'deposit.success.balance', { balance: formatMoney(newBalanceVnd, lang) }),
    '',
    t(lang, 'deposit.success.footer'),
  ].join('\n')
}
