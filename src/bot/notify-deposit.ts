/**
 * Notify-deposit — helper render thông báo "nạp thành công" dùng chung cho mọi
 * luồng cộng tiền (webhook SePay, webhook CryptoBot, cron credit-awaiting).
 *
 * Gom 1 nơi để tránh lặp 3 lần (DRY) và giữ thông báo nhất quán giữa các provider.
 * Chuỗi lấy từ catalog i18n bot theo `ctx.lang` (key `deposit.success.*`) — thêm ngôn ngữ
 * chỉ cần thêm catalog, KHÔNG sửa helper (R4.1, OCP). Số tiền hiển thị render qua
 * `formatMoneyFor(amount, ctx)`: international + Valid_Rate → USD, còn lại → VND.
 * Đây CHỈ là hiển thị — số tiền cộng cho user vẫn là VND-native, không đổi (R5.4).
 */

import { formatMoneyFor, type CurrencyContext } from '../utils/format'
import { t } from './i18n'

/**
 * Dựng nội dung thông báo nạp thành công theo Region/Language của user.
 *
 * @param ctx - CurrencyContext (Language + Region + rate) để chọn tiền tệ hiển thị.
 * @param amountVnd - Số VND vừa cộng cho lần nạp này (giá trị crediting gốc, không đổi).
 * @param newBalanceVnd - Số dư mới (VND) sau khi cộng.
 */
export function renderDepositSuccess(
  ctx: CurrencyContext,
  amountVnd: number,
  newBalanceVnd: number
): string {
  return [
    t(ctx.lang, 'deposit.success.header'),
    '',
    t(ctx.lang, 'deposit.success.amount', { amount: formatMoneyFor(amountVnd, ctx) }),
    t(ctx.lang, 'deposit.success.balance', { balance: formatMoneyFor(newBalanceVnd, ctx) }),
    '',
    t(ctx.lang, 'deposit.success.footer'),
  ].join('\n')
}
