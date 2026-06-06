/**
 * SePay Webhook Route — xử lý callback từ SePay khi có giao dịch banking.
 * Requirements: 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 8.2, 8.5
 */
import { Hono } from 'hono'
import type { AppEnv } from '../types'
import type { SepayWebhookPayload } from '../types/sepay'
import type { DbDeposit, DbUser } from '../types/db'
import { sepayAuth } from '../middleware/sepay-auth'
import { completeDeposit } from '../services/deposit-service'
import { DEPOSIT_TTL_MS } from '../services/deposit-policy'
import { readDepositLimits } from '../services/deposit-limits'
import { resolveBotToken } from '../services/telegram-config'
import { sendMessage } from '../bot/telegram-api'
import { resolveLang } from '../services/user-locale'
import { renderDepositSuccess } from '../bot/notify-deposit'

/**
 * Mã chuyển khoản nội bộ: "NAP" + 4-17 ký tự alphanumeric (xem `utils/transfer-code.ts`).
 * SePay có thể đã tự nhận diện mã vào trường `code` (khi cấu hình tiền tố "NAP" trên
 * my.sepay.vn); nếu không, mã vẫn nằm trong `content` (nội dung CK gốc) — bắt cả hai.
 */
const TRANSFER_CODE_REGEX = /NAP[A-Z0-9]{4,17}/i

/**
 * Trích mã chuyển khoản nội bộ từ payload SePay.
 *
 * Ưu tiên trường `code` (mã SePay tự nhận diện — đáng tin hơn vì không bị nội dung
 * ngân hàng chèn ký tự lạ); nếu `code` rỗng/không khớp định dạng "NAP..." thì fallback
 * dò trong `content`. Trả mã đã upper-case hoặc `null` nếu không tìm thấy.
 */
function extractTransferCode(payload: SepayWebhookPayload): string | null {
  const fromCode = payload.code?.match(TRANSFER_CODE_REGEX)
  if (fromCode) return fromCode[0].toUpperCase()

  const fromContent = payload.content.match(TRANSFER_CODE_REGEX)
  if (fromContent) return fromContent[0].toUpperCase()

  return null
}

const sepayWebhook = new Hono<AppEnv>()

// Apply sepay-auth middleware — returns 401 if auth fails
sepayWebhook.use('/sepay', sepayAuth)

sepayWebhook.post('/sepay', async (c) => {
  const db = c.env.DB

  // Parse payload
  let payload: SepayWebhookPayload
  try {
    payload = await c.req.json<SepayWebhookPayload>()
  } catch {
    return c.json({ success: true })
  }

  // Chỉ xử lý giao dịch tiền vào (Req 2.5)
  if (payload.transferType !== 'in') {
    return c.json({ success: true })
  }

  // Idempotency check: kiểm tra sepay_transaction_id đã xử lý chưa (Req 2.12)
  const existingDeposit = await db
    .prepare('SELECT id FROM deposits WHERE sepay_transaction_id = ?')
    .bind(String(payload.id))
    .first<{ id: number }>()

  if (existingDeposit) {
    return c.json({ success: true })
  }

  // Extract transfer_code: ưu tiên field `code` của SePay, fallback `content` (Req 2.6)
  const transferCode = extractTransferCode(payload)
  if (!transferCode) {
    console.warn('[SePay] No transfer code found. code/content:', payload.code, payload.content)
    return c.json({ success: true })
  }

  // Find pending deposit by transfer_code (Req 2.7). Kèm tuổi (giây) để áp luật TTL.
  const deposit = await db
    .prepare(
      `SELECT *, strftime('%s','now') - strftime('%s', created_at) AS age_sec
       FROM deposits WHERE transfer_code = ? AND status = 'pending'`
    )
    .bind(transferCode)
    .first<DbDeposit & { age_sec: number }>()

  if (!deposit) {
    console.warn('[SePay] No pending deposit found for transfer_code:', transferCode)
    return c.json({ success: true })
  }

  // TTL: chuyển khoản tới sau khi deposit đã quá hạn (15 phút) thì KHÔNG được tính.
  // Cron sẽ dọn trạng thái sang 'expired'; ở đây chỉ cần bỏ qua việc cộng tiền.
  if (deposit.age_sec * 1000 > DEPOSIT_TTL_MS) {
    console.warn('[SePay] Deposit expired (>15m), skip crediting. transfer_code:', transferCode)
    return c.json({ success: true })
  }

  // Validate amount range theo hạn mức cấu hình trong `system_config` (Req 2.8, 8.2)
  const { min: minAmount, max: maxAmount } = await readDepositLimits(db)
  if (payload.transferAmount < minAmount || payload.transferAmount > maxAmount) {
    console.warn(
      '[SePay] Amount out of range:',
      payload.transferAmount,
      `(allowed ${minAmount}-${maxAmount})`
    )
    return c.json({ success: true })
  }

  // Get user info
  const user = await db
    .prepare('SELECT * FROM users WHERE id = ?')
    .bind(deposit.user_id)
    .first<DbUser>()

  if (!user) {
    console.warn('[SePay] User not found for deposit:', deposit.id)
    return c.json({ success: true })
  }

  // Execute deposit transaction (Req 2.9, 2.10).
  // Lưu ý R15.3: SePay phải bỏ qua khi deposit đã `expired`. `completeDeposit` cho
  // phép hoàn tất từ `expired` (phục vụ CryptoBot trả trễ), nên ta CHỈ gọi cho deposit
  // còn `pending`: query phía trên đã lọc `status = 'pending'` + TTL guard ở trên đã
  // bỏ qua chuyển khoản tới sau khi quá hạn → deposit `expired` không bao giờ tới đây.
  const result = await completeDeposit({
    db,
    depositId: deposit.id,
    userId: user.id,
    creditVnd: payload.transferAmount,
    provider: 'sepay',
    sepayTransactionId: String(payload.id),
  })

  if (!result.success && result.error === 'db_error') {
    // Lỗi atomic tạm thời sau khi đã xác nhận thanh toán — log để theo dõi; dựa vào
    // retry của SePay (giữ nguyên hành vi cũ: luôn trả success ở cuối — Req 8.5).
    console.error('[SePay] completeDeposit db_error for deposit:', deposit.id)
  }

  // Gửi notification cho user nếu thành công (Req 2.11, 9.2-9.5) — async via waitUntil.
  // Thông báo render theo ngôn ngữ user: resolve qua resolveLang(db, user) rồi chọn biến thể.
  if (result.success) {
    const botToken = await resolveBotToken(db, c.env)
    const lang = await resolveLang(db, user)
    const notificationText = renderDepositSuccess(lang, payload.transferAmount, result.newBalance)

    // Fire-and-forget notification (waitUntil pattern for CF Workers)
    const notificationPromise = sendMessage(botToken, user.telegram_id, notificationText, {
      parse_mode: 'HTML',
    }).catch((err) => {
      console.error('[SePay] Failed to send notification:', err)
    })

    // Use waitUntil if available (Cloudflare Workers ExecutionContext)
    if (c.executionCtx?.waitUntil) {
      c.executionCtx.waitUntil(notificationPromise)
    }
  }

  // Luôn return success (Req 8.5)
  return c.json({ success: true })
})

export { sepayWebhook }
