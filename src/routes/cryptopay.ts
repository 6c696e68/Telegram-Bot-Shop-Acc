/**
 * Crypto Pay Webhook Route — xử lý callback từ @CryptoBot khi hoá đơn USDT được trả.
 *
 * Đối xứng `routes/sepay.ts` nhưng cho provider `cryptobot`:
 *  - Xác thực chữ ký qua middleware `cryptoPayAuth` (HMAC SHA256, R19.2). Middleware đã
 *    đọc raw body và lưu vào `c.get('rawBody')` — handler KHÔNG đọc lại body (tránh
 *    "body already consumed") mà `JSON.parse` từ raw đã verify.
 *  - Chỉ xử lý update `invoice_paid`; loại khác bỏ qua (trả 200).
 *  - Idempotency theo `crypto_invoice_id` (R11.2).
 *  - Tỷ giá thiếu/không hợp lệ → `markAwaitingCredit`, KHÔNG mất tiền (R12.4).
 *  - Lỗi atomic tạm thời (`db_error`) → trả 500 để Crypto Pay retry callback (R14.5).
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 12.2, 12.4, 12.5, 12.6, 14.5, 15.4
 */
import { Hono } from 'hono'
import type { Bindings } from '../types'
import type { DbDeposit, DbUser } from '../types/db'
import { cryptoPayAuth, type CryptoPayVariables } from '../middleware/cryptopay-auth'
import { completeDeposit, markAwaitingCredit } from '../services/deposit-service'
import { resolveBotToken } from '../services/telegram-config'
import { resolveLang } from '../services/user-locale'
import { sendMessage } from '../bot/telegram-api'
import { renderDepositSuccess } from '../bot/notify-deposit'
import { readSystemConfigValue } from '../utils/system-config'
import { buildCurrencyContext } from '../utils/format'

/** Env cho route crypto: Bindings chung + biến `rawBody` do middleware set. */
type CryptoPayRouteEnv = {
  Bindings: Bindings
  Variables: CryptoPayVariables
}

/** Key trong `system_config` chứa tỷ giá VND cho 1 USDT. */
const EXCHANGE_RATE_CONFIG = 'exchange_rate_usdt_vnd'

/**
 * Đối tượng `Invoice` trong payload webhook của Crypto Pay (chỉ khai báo trường dùng).
 * Tham chiếu: https://help.crypt.bot/crypto-pay-api#webhook-updates
 */
interface CryptoPayInvoicePayload {
  /** Định danh hoá đơn (số nguyên) — khớp `deposits.crypto_invoice_id` (dạng chuỗi). */
  invoice_id: number
  /** Trạng thái hoá đơn; webhook `invoice_paid` mang `status='paid'`. */
  status?: string
  /** Asset hoá đơn (vd 'USDT'). */
  asset?: string
  /** Số tiền hoá đơn (chuỗi thập phân). */
  amount?: string
  /** Asset thực người dùng đã trả (có thể khác `asset` nếu thanh toán chéo). */
  paid_asset?: string
  /** Số tiền thực nhận (chuỗi thập phân) — ưu tiên dùng làm USDT thực nhận. */
  paid_amount?: string
  /** Payload nội bộ đính khi tạo invoice — chính là `deposits.id` dạng chuỗi. */
  payload?: string
}

/** Một update webhook của Crypto Pay. */
interface CryptoPayWebhookUpdate {
  update_id: number
  update_type: string
  payload: CryptoPayInvoicePayload
}

/** Các cột deposit cần để cộng tiền + cross-check + notify. */
interface CryptoDepositRow {
  id: number
  user_id: number
  status: DbDeposit['status']
  usdt_amount: string | null
}

/** Parse chuỗi config sang số dương hữu hạn; không hợp lệ → `undefined`. */
function parsePositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

const cryptoPayWebhook = new Hono<CryptoPayRouteEnv>()

// Xác thực chữ ký webhook — 401 nếu thất bại (R19.2/19.3/19.4).
cryptoPayWebhook.use('/cryptopay', cryptoPayAuth)

cryptoPayWebhook.post('/cryptopay', async (c) => {
  const db = c.env.DB

  // Body đã được middleware đọc + verify; parse từ raw (không đọc lại request body).
  let update: CryptoPayWebhookUpdate
  try {
    update = JSON.parse(c.get('rawBody')) as CryptoPayWebhookUpdate
  } catch {
    // Body verify được nhưng không phải JSON hợp lệ — không có gì để xử lý.
    console.warn('[CryptoPay] Body không phải JSON hợp lệ, bỏ qua.')
    return c.json({ success: true })
  }

  // Chỉ xử lý hoá đơn đã trả; các update khác bỏ qua (R11.1).
  if (update.update_type !== 'invoice_paid') {
    return c.json({ success: true })
  }

  const invoice = update.payload
  if (!invoice || invoice.invoice_id === undefined || invoice.invoice_id === null) {
    console.warn('[CryptoPay] update invoice_paid thiếu payload.invoice_id, bỏ qua.')
    return c.json({ success: true })
  }

  const cryptoInvoiceId = String(invoice.invoice_id)

  // USDT thực nhận: ưu tiên `paid_amount`, fallback `amount` (R12.2).
  const usdtAmountStr = invoice.paid_amount ?? invoice.amount
  const usdtAmount = parsePositiveNumber(usdtAmountStr ?? undefined)
  if (usdtAmount === undefined || usdtAmountStr === undefined) {
    console.error(
      '[CryptoPay] Số USDT thực nhận không hợp lệ cho invoice:',
      cryptoInvoiceId,
      invoice.paid_amount,
      invoice.amount
    )
    return c.json({ success: true })
  }

  // Tra deposit theo crypto_invoice_id để lấy id/user/status thực tế trong DB.
  const deposit = await db
    .prepare(
      `SELECT id, user_id, status, usdt_amount
       FROM deposits WHERE crypto_invoice_id = ?`
    )
    .bind(cryptoInvoiceId)
    .first<CryptoDepositRow>()

  if (!deposit) {
    console.warn('[CryptoPay] Không tìm thấy deposit cho invoice:', cryptoInvoiceId)
    return c.json({ success: true })
  }

  // Cross-check payload(depositId) với deposit tra theo invoice — cảnh báo nếu lệch,
  // nhưng nguồn sự thật là bản ghi tra theo crypto_invoice_id (idempotency anchor).
  if (invoice.payload !== undefined && invoice.payload !== String(deposit.id)) {
    console.warn(
      '[CryptoPay] payload depositId lệch với deposit theo invoice:',
      invoice.payload,
      'vs',
      deposit.id
    )
  }

  // Idempotency: deposit đã completed → bỏ qua, trả 200 (R11.2).
  if (deposit.status === 'completed') {
    return c.json({ success: true })
  }

  // Đọc tỷ giá. Thiếu/không hợp lệ → giữ awaiting_credit (KHÔNG mất tiền), trả 200 (R12.4).
  const rate = parsePositiveNumber(await readSystemConfigValue(db, EXCHANGE_RATE_CONFIG))
  if (rate === undefined) {
    console.error(
      '[CryptoPay] Tỷ giá exchange_rate_usdt_vnd thiếu/không hợp lệ; giữ awaiting_credit cho deposit:',
      deposit.id
    )
    await markAwaitingCredit(db, deposit.id, usdtAmountStr)
    return c.json({ success: true })
  }

  // Quy đổi VND = floor(USDT × rate) (R12.5/12.6).
  const creditVnd = Math.floor(usdtAmount * rate)

  // Cộng tiền atomic; cho phép hoàn tất kể cả khi deposit đang `expired` (R11.4/15.4).
  const result = await completeDeposit({
    db,
    depositId: deposit.id,
    userId: deposit.user_id,
    creditVnd,
    provider: 'cryptobot',
    cryptoInvoiceId,
    usdtAmount: usdtAmountStr,
    exchangeRate: rate,
  })

  if (!result.success) {
    if (result.error === 'db_error') {
      // Lỗi atomic tạm thời SAU khi thanh toán đã xác nhận → trả 500 để Crypto Pay
      // retry callback. KHÔNG trả 200, KHÔNG đánh dấu hoàn tất → retry còn cộng được (R14.5).
      console.error('[CryptoPay] completeDeposit db_error cho deposit:', deposit.id)
      return c.json({ success: false }, 500)
    }

    // already_processed (đã cộng đúng một lần trước đó) / not_found → coi như xong,
    // trả 200 idempotent, KHÔNG notify lại.
    return c.json({ success: true })
  }

  // Thành công → thông báo user theo ngôn ngữ (R11.3) — fire-and-forget qua waitUntil.
  const user = await db
    .prepare('SELECT * FROM users WHERE id = ?')
    .bind(deposit.user_id)
    .first<DbUser>()

  if (user) {
    const botToken = await resolveBotToken(db, c.env)
    const lang = await resolveLang(db, user)
    const currencyCtx = await buildCurrencyContext(db, { lang, region: user.region })
    const text = renderDepositSuccess(currencyCtx, creditVnd, result.newBalance)

    const notificationPromise = sendMessage(botToken, user.telegram_id, text, {
      parse_mode: 'HTML',
    }).catch((err) => {
      console.error('[CryptoPay] Gửi thông báo thất bại cho deposit:', deposit.id, err)
    })

    if (c.executionCtx?.waitUntil) {
      c.executionCtx.waitUntil(notificationPromise)
    }
  } else {
    console.error('[CryptoPay] Không tìm thấy user để notify cho deposit:', deposit.id)
  }

  // Hoàn tất (R11.5).
  return c.json({ success: true })
})

export { cryptoPayWebhook }
