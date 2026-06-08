/**
 * PayOsProvider — implement `PaymentProvider` cho luồng nạp tiền qua cổng PayOS.
 *
 * Đơn vị nhập là VND (`amountUnit='vnd'`), khả dụng cả Bot lẫn Mini App. Trách nhiệm
 * `createDeposit`:
 *  1. Validate `rawAmount` là số nguyên dương (R8.6, R9.1); sai → lỗi `limit`
 *     (`deposit.limit.vnd_invalid`), KHÔNG tạo deposit (R8.5).
 *  2. `readDepositLimits(db)` → ngoài `[min,max]` → lỗi `limit`
 *     (`deposit.limit.vnd_range`) (R9.1, R9.2).
 *  3. `checkDepositPolicy(db, userId)` → bị chặn → lỗi `policy` (R9.3, R9.4).
 *  4. Sinh `orderCode` duy nhất (timestamp + random), khác `deposits.id`; INSERT deposit
 *     pending với `correlation_ref = orderCode`. Retry khi đụng partial unique index
 *     `(provider, correlation_ref)` (R8.1).
 *  5. `returnUrl = cancelUrl = readMiniAppUrl(db)` (quyết định A — dùng chung cho mọi
 *     kênh). Nếu `miniapp_url` rỗng/null → lỗi cấu hình (`provider_error` localized),
 *     KHÔNG tạo deposit (R8.4, R8.5).
 *  6. `resolvePayOsConfig(db, env)` → `createPaymentLink(...)`.
 *  7. Thành công → UPDATE `provider_txn_id = paymentLinkId`, `metadata = {checkoutUrl, qrCode}`;
 *     trả `output.payos` (R8.2, R8.3, R13.1).
 *  8. Lỗi `createPaymentLink` → dọn deposit mồ côi
 *     (`DELETE ... WHERE id=? AND status='pending' AND provider_txn_id IS NULL`),
 *     log chi tiết nội bộ, trả `provider_error` chung chung (R14.1–R14.4).
 *
 * Việc cộng tiền khi PayOS xác nhận do `deposit-service.completeDeposit` (dùng chung)
 * đảm nhiệm — provider KHÔNG tự cập nhật balance.
 *
 * Đăng ký vào registry làm ở module đăng ký (task 3.5); ở đây chỉ export instance
 * `payOsProvider`.
 *
 * Requirements: 5.1, 5.3, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 9.1, 9.2, 9.3, 9.4, 13.1,
 *               14.1, 14.2, 14.3, 14.4, 15.1
 */

import { formatMoney } from '../../utils/format'
import { readMiniAppUrl } from '../../utils/system-config'
import { t } from '../../bot/i18n'
import { readDepositLimits } from '../deposit-limits'
import { checkDepositPolicy } from '../deposit-policy'
import { resolvePayOsConfig } from '../payos-config'
import { createPaymentLink, PayOsApiError } from './payos-client'
import type {
  AmountUnit,
  CreateDepositInput,
  CreateDepositResult,
  PaymentProvider,
  ProviderId,
} from './types'

/**
 * Mô tả hiển thị trên cổng PayOS. PayOS giới hạn `description` rất ngắn (<= 9 ký tự ở
 * `createPaymentLink`) nên dùng chuỗi tĩnh ASCII ngắn, KHÔNG emoji, KHÔNG nhồi orderCode
 * (orderCode đi qua trường riêng).
 */
const PAYOS_DESCRIPTION = 'Nap tien' // 8 ký tự ASCII

/** Số lần thử lại khi `orderCode` đụng partial unique index `(provider, correlation_ref)`. */
const ORDER_CODE_MAX_ATTEMPTS = 5

/**
 * Sinh `orderCode` duy nhất cho PayOS: timestamp (ms) ghép random 3 chữ số.
 * `Date.now() * 1000` ~ 1.7e15 < `Number.MAX_SAFE_INTEGER` (9.007e15) nên an toàn số nguyên.
 * Vì dựa trên timestamp + random, giá trị luôn lớn hơn nhiều so với `deposits.id`
 * (autoincrement nhỏ) → khác `deposits.id` (R8.1).
 */
function generateOrderCode(): number {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000)
}

/** Nhận diện lỗi vi phạm ràng buộc UNIQUE của D1/SQLite (để retry sinh orderCode). */
function isUniqueConstraintError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause)
  return /UNIQUE constraint failed/i.test(message)
}

/** Implement nội bộ — export qua instance `payOsProvider` (không cần nhiều bản). */
class PayOsProvider implements PaymentProvider {
  readonly id: ProviderId = 'payos'
  readonly amountUnit: AmountUnit = 'vnd'

  async createDeposit(input: CreateDepositInput): Promise<CreateDepositResult> {
    const { db, env, userId, rawAmount, lang } = input

    // 1) Validate số nguyên dương (R8.6, R9.1). Sai → limit, KHÔNG tạo deposit (R8.5).
    if (!Number.isInteger(rawAmount) || rawAmount <= 0) {
      return {
        success: false,
        error: { type: 'limit', message: t(lang, 'deposit.limit.vnd_invalid') },
      }
    }

    // 2) Hạn mức VND theo system_config (đồng bộ Bot/Mini App/webhook) — R9.1, R9.2.
    const limits = await readDepositLimits(db)
    if (rawAmount < limits.min || rawAmount > limits.max) {
      return {
        success: false,
        error: {
          type: 'limit',
          message: t(lang, 'deposit.limit.vnd_range', {
            min: formatMoney(limits.min, lang),
            max: formatMoney(limits.max, lang),
          }),
        },
      }
    }

    // 3) Luật chống lạm dụng dùng chung (cooldown + trần pending) — R9.3, R9.4.
    const verdict = await checkDepositPolicy(db, userId)
    if (!verdict.allowed) {
      return {
        success: false,
        error: {
          type: 'policy',
          reason: verdict.reason ?? 'cooldown',
          retryAfterMs: verdict.retryAfterMs,
        },
      }
    }

    // 4) Return/Cancel URL dùng chung miniapp_url (quyết định A) — R8.4. Rỗng/null →
    //    lỗi cấu hình, KHÔNG tạo deposit (R8.5). Đọc TRƯỚC khi INSERT để không tạo mồ côi.
    const miniAppUrl = await readMiniAppUrl(db)
    if (!miniAppUrl) {
      console.error('[PayOsProvider] miniapp_url chưa cấu hình — không thể tạo liên kết PayOS')
      return {
        success: false,
        error: { type: 'provider_error', message: t(lang, 'deposit.error.payos_failed') },
      }
    }

    // 5) Sinh orderCode duy nhất + INSERT deposit pending (correlation_ref = orderCode).
    //    Retry khi đụng partial unique index (provider, correlation_ref) — R8.1.
    const now = new Date().toISOString()
    let orderCode = 0
    let depositId = 0
    let inserted = false
    for (let attempt = 0; attempt < ORDER_CODE_MAX_ATTEMPTS; attempt++) {
      orderCode = generateOrderCode()
      try {
        const row = await db
          .prepare(
            "INSERT INTO deposits (user_id, provider, correlation_ref, amount, status, created_at) VALUES (?, 'payos', ?, ?, 'pending', ?) RETURNING id"
          )
          .bind(userId, String(orderCode), rawAmount, now)
          .first<{ id: number }>()
        if (row) {
          depositId = row.id
          inserted = true
          break
        }
      } catch (cause) {
        if (isUniqueConstraintError(cause)) {
          // orderCode trùng (cực hiếm) → thử lại với giá trị mới.
          continue
        }
        throw cause
      }
    }

    if (!inserted) {
      return {
        success: false,
        error: { type: 'provider_error', message: t(lang, 'deposit.generic_error') },
      }
    }

    // 6) Resolve cấu hình + gọi PayOS tạo liên kết thanh toán. CHỈ bọc try quanh
    //    createPaymentLink: nếu lỗi → dọn deposit mồ côi (R14.1, R14.2). KHÔNG bọc bước
    //    UPDATE sau-thành-công trong try này (tránh xoá nhầm deposit khi link đã tạo).
    let link
    try {
      const config = await resolvePayOsConfig(db, env)
      link = await createPaymentLink({
        clientId: config.clientId,
        apiKey: config.apiKey,
        checksumKey: config.checksumKey,
        orderCode,
        amount: rawAmount,
        description: PAYOS_DESCRIPTION,
        returnUrl: miniAppUrl,
        cancelUrl: miniAppUrl,
      })
    } catch (cause) {
      // Dọn deposit mồ côi: chỉ xoá khi vẫn pending và chưa gắn provider_txn_id (R14.1, R14.2).
      // Bọc try để lỗi cleanup không làm createDeposit ném ra (caller bot/miniapp không có
      // try/catch) — vẫn trả provider_error localized cho user (R14.3, R15.1).
      try {
        await db
          .prepare(
            "DELETE FROM deposits WHERE id = ? AND status = 'pending' AND provider_txn_id IS NULL"
          )
          .bind(depositId)
          .run()
      } catch (cleanupErr) {
        console.error('[PayOsProvider] dọn deposit mồ côi thất bại cho deposit:', depositId, cleanupErr)
      }

      // Chi tiết lỗi nội bộ chỉ ghi log (có thể chứa thông tin kỹ thuật), KHÔNG hiển thị user.
      const detail = cause instanceof PayOsApiError ? cause.message : String(cause)
      console.error('[PayOsProvider] createPaymentLink thất bại cho deposit:', depositId, detail)
      // Thông báo chung chung, không lộ chi tiết kỹ thuật (R14.3, R14.4).
      return {
        success: false,
        error: { type: 'provider_error', message: t(lang, 'deposit.error.payos_failed') },
      }
    }

    // 7) Link đã tạo THÀNH CÔNG → gắn paymentLinkId (idempotency webhook) + metadata.
    //    Nếu UPDATE lỗi: KHÔNG xoá deposit (link thật đã tồn tại) — webhook vẫn cộng được
    //    theo correlation_ref==orderCode và tự set provider_txn_id qua COALESCE (R8.2/R13.1).
    const metadataJson = JSON.stringify({ checkoutUrl: link.checkoutUrl, qrCode: link.qrCode })
    try {
      await db
        .prepare(
          "UPDATE deposits SET provider_txn_id = ?, metadata = ? WHERE id = ? AND status = 'pending'"
        )
        .bind(link.paymentLinkId, metadataJson, depositId)
        .run()
    } catch (updErr) {
      console.error(
        '[PayOsProvider] gắn provider_txn_id/metadata thất bại (link vẫn hợp lệ, webhook sẽ tự set):',
        depositId,
        updErr
      )
    }

    return {
      success: true,
      output: {
        depositId,
        payos: {
          checkoutUrl: link.checkoutUrl,
          qrCode: link.qrCode,
          paymentLinkId: link.paymentLinkId,
          amountVnd: rawAmount,
          orderCode,
        },
      },
    }
  }
}

/** Instance dùng chung của PayOS provider. */
export const payOsProvider: PaymentProvider = new PayOsProvider()
