/**
 * Credit-awaiting job — lưới an toàn cộng tiền cho deposit CryptoBot đang `awaiting_credit`.
 *
 * Được gọi trong `scheduled` (cron 15') sau `expirePendingDeposits`. Khi webhook CryptoBot
 * nhận thanh toán USDT lúc tỷ giá tạm lỗi, deposit được giữ ở `awaiting_credit` (lưu
 * `usdt_amount`) thay vì cộng tiền sai — KHÔNG mất tiền (R12.4). Job này quét lại các
 * deposit đó và cộng khi tỷ giá đã hợp lệ (R12.7).
 *
 * Nguyên tắc:
 *  - Tỷ giá thiếu/không hợp lệ (không dương) → bỏ qua TRỌN lượt này, KHÔNG cộng (đợi lượt sau).
 *  - Tỷ giá hợp lệ → với mỗi deposit: `creditVnd = floor(usdt_amount × rate)`, gọi
 *    `completeDeposit` (idempotent — cộng đúng một lần dù gọi lặp/đồng thời).
 *  - Lỗi từng deposit độc lập: một deposit lỗi KHÔNG chặn các deposit khác.
 *  - `db_error` → KHÔNG notify, để lượt cron sau retry (R14.5). `already_processed`
 *    (đã cộng trước đó) → cũng không notify lại. Chỉ `success` mới notify user.
 *
 * Requirements: 12.7
 */

import type { Bindings } from '../types/bindings'
import type { DbUser } from '../types/db'
import { completeDeposit } from './deposit-service'
import { resolveBotToken } from './telegram-config'
import { resolveLang } from './user-locale'
import { readSystemConfigValue } from '../utils/system-config'
import { sendMessage } from '../bot/telegram-api'
import { renderDepositSuccess } from '../bot/notify-deposit'

/** Key trong `system_config` chứa tỷ giá VND cho 1 USDT. */
const EXCHANGE_RATE_CONFIG = 'exchange_rate_usdt_vnd'

/** Các cột deposit cần để cộng tiền + notify. */
interface AwaitingDepositRow {
  id: number
  user_id: number
  usdt_amount: string | null
  crypto_invoice_id: string | null
}

/** Parse chuỗi config sang số dương hữu hạn; không hợp lệ → `undefined`. */
function parsePositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * Quét các deposit `awaiting_credit` và cộng tiền khi tỷ giá hợp lệ.
 *
 * @param env - Bindings (cần `DB` + resolve `bot_token` để notify).
 * @param ctx - ExecutionContext (dùng `waitUntil` để fire-and-forget notification).
 * @returns Số deposit đã cộng thành công trong lượt này.
 */
export async function creditAwaitingDeposits(
  env: Bindings,
  ctx: ExecutionContext
): Promise<number> {
  const db = env.DB

  // Tỷ giá thiếu/không hợp lệ → bỏ qua lượt này, KHÔNG cộng (đợi admin cấu hình lại).
  const rate = parsePositiveNumber(await readSystemConfigValue(db, EXCHANGE_RATE_CONFIG))
  if (rate === undefined) {
    console.warn('[CreditAwaiting] Tỷ giá USDT chưa hợp lệ, bỏ qua lượt này.')
    return 0
  }

  const { results } = await db
    .prepare(
      `SELECT id, user_id, usdt_amount, crypto_invoice_id
       FROM deposits WHERE status = 'awaiting_credit'`
    )
    .all<AwaitingDepositRow>()

  if (results.length === 0) {
    return 0
  }

  // Resolve bot token một lần cho cả lượt (notify dùng chung).
  const botToken = await resolveBotToken(db, env)

  let creditedCount = 0

  for (const deposit of results) {
    // Lỗi từng deposit độc lập: một deposit hỏng KHÔNG chặn các deposit còn lại.
    try {
      const usdt = parsePositiveNumber(deposit.usdt_amount ?? undefined)
      if (usdt === undefined) {
        // usdt_amount thiếu/không hợp lệ → không thể quy đổi, bỏ qua deposit này.
        console.error(
          '[CreditAwaiting] usdt_amount không hợp lệ cho deposit:',
          deposit.id,
          deposit.usdt_amount
        )
        continue
      }

      const creditVnd = Math.floor(usdt * rate)

      const result = await completeDeposit({
        db,
        depositId: deposit.id,
        userId: deposit.user_id,
        creditVnd,
        provider: 'cryptobot',
        cryptoInvoiceId: deposit.crypto_invoice_id ?? undefined,
        usdtAmount: deposit.usdt_amount ?? undefined,
        exchangeRate: rate,
      })

      if (!result.success) {
        // db_error → để lượt cron sau retry (R14.5). already_processed/not_found → đã
        // cộng trước đó hoặc không hợp lệ → không notify.
        if (result.error === 'db_error') {
          console.error('[CreditAwaiting] completeDeposit db_error cho deposit:', deposit.id)
        }
        continue
      }

      creditedCount++

      // Notify user theo ngôn ngữ — fire-and-forget qua waitUntil.
      const user = await db
        .prepare('SELECT * FROM users WHERE id = ?')
        .bind(deposit.user_id)
        .first<DbUser>()

      if (!user) {
        console.error('[CreditAwaiting] Không tìm thấy user cho deposit:', deposit.id)
        continue
      }

      const lang = await resolveLang(db, user)
      const text = renderDepositSuccess(lang, creditVnd, result.newBalance)

      ctx.waitUntil(
        sendMessage(botToken, user.telegram_id, text, { parse_mode: 'HTML' }).catch((err) => {
          console.error('[CreditAwaiting] Gửi thông báo thất bại cho deposit:', deposit.id, err)
        })
      )
    } catch (err) {
      // An toàn cuối: bất kỳ lỗi bất ngờ nào của một deposit không được chặn lượt quét.
      console.error('[CreditAwaiting] Lỗi xử lý deposit:', deposit.id, err)
    }
  }

  return creditedCount
}
