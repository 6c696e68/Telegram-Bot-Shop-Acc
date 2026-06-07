/**
 * CryptoPayProvider — implement `PaymentProvider` cho luồng nạp tiền USDT qua @CryptoBot.
 *
 * Đơn vị nhập là USDT (`amountUnit='usdt'`). Trách nhiệm `createDeposit`:
 *  1. Đọc cấu hình: `crypto_min_usdt` (mặc định 5 USDT nếu thiếu — R13.5),
 *     `exchange_rate_usdt_vnd` (tỷ giá hiện tại) và hạn mức VND (`readDepositLimits`).
 *  2. Validate `usdt >= crypto_min_usdt` và `floor(usdt × rate) <= max_deposit`
 *     (R13.2/R13.4) — ngoài hạn mức → lỗi `limit`.
 *  3. Kiểm tra luật chống lạm dụng dùng chung (`checkDepositPolicy`) → lỗi `policy`.
 *  4. INSERT deposit `pending` (lấy `id` làm `payload` cho invoice) → gọi Crypto Pay
 *     `createInvoice` → UPDATE `crypto_invoice_id`. Nếu `createInvoice` thất bại →
 *     XOÁ deposit vừa tạo (KHÔNG để lại `pending` mồ côi) rồi trả `provider_error`
 *     (R10.4).
 *  5. Chọn `payUrl` theo kênh khởi tạo (`bot` → botInvoiceUrl, `miniapp` →
 *     miniAppInvoiceUrl, fallback `payUrl`).
 *
 * Lưu `amount = floor(usdt × rate_hiện_tại)` (VND kỳ vọng để hiển thị/hạn mức) và
 * `usdt_amount` (chuỗi thập phân, giữ nguyên độ chính xác). Việc cộng tiền khi
 * Crypto Pay xác nhận do `deposit-service.completeDeposit` (dùng chung) đảm nhiệm.
 *
 * Đăng ký vào registry được làm ở module đăng ký (task 5.3); ở đây chỉ export
 * instance `cryptoPayProvider`.
 *
 * Requirements: 10.1, 10.2, 10.4, 10.5, 13.2, 13.4, 13.5, 13.6
 */

import { formatMoney } from '../../utils/format'
import { readSystemConfigMap } from '../../utils/system-config'
import { t } from '../../bot/i18n'
import { readDepositLimits } from '../deposit-limits'
import { checkDepositPolicy } from '../deposit-policy'
import { resolveCryptoPayToken } from '../cryptopay-config'
import { createInvoice, CryptoPayApiError } from './crypto-pay-client'
import type {
  AmountUnit,
  CreateDepositInput,
  CreateDepositResult,
  DepositChannel,
  PaymentProvider,
  ProviderId,
} from './types'

/** Số USDT tối thiểu mặc định khi `crypto_min_usdt` chưa cấu hình (R13.5). */
const DEFAULT_CRYPTO_MIN_USDT = 5

/**
 * TTL hoá đơn Crypto Pay (giây). Đặt dài hơn TTL pending local (15') để hoá đơn vẫn
 * hợp lệ khi user thanh toán trễ; webhook trả-trễ vẫn cộng được qua `completeDeposit`.
 */
const CRYPTO_INVOICE_EXPIRES_IN_SEC = 10_800

/** Parse chuỗi config sang số dương hữu hạn; không hợp lệ → `undefined`. */
function parsePositiveNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/** Implement nội bộ — export qua instance `cryptoPayProvider` (không cần nhiều bản). */
class CryptoPayProvider implements PaymentProvider {
  readonly id: ProviderId = 'cryptobot'
  readonly amountUnit: AmountUnit = 'usdt'

  async createDeposit(input: CreateDepositInput): Promise<CreateDepositResult> {
    const { db, env, userId, rawAmount } = input
    const channel: DepositChannel = input.channel ?? 'bot'
    const lang = input.lang

    // rawAmount là USDT (có thể thập phân). Fail-fast nếu không phải số dương hữu hạn.
    if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
      return {
        success: false,
        error: { type: 'limit', message: t(lang, 'deposit.limit.usdt_invalid') },
      }
    }
    const usdt = rawAmount

    // 1) Cấu hình: crypto_min_usdt + exchange_rate (một query), hạn mức VND dùng chung.
    const config = await readSystemConfigMap(db, ['crypto_min_usdt', 'exchange_rate_usdt_vnd'])
    const cryptoMinUsdt = parsePositiveNumber(config.get('crypto_min_usdt')) ?? DEFAULT_CRYPTO_MIN_USDT
    const rate = parsePositiveNumber(config.get('exchange_rate_usdt_vnd'))
    if (rate === undefined) {
      // Không có tỷ giá hợp lệ thì không thể quy đổi/kiểm hạn mức — fail-fast, không tạo deposit.
      return {
        success: false,
        error: {
          type: 'provider_error',
          message: t(lang, 'deposit.error.rate_unset'),
        },
      }
    }

    const limits = await readDepositLimits(db)
    // VND kỳ vọng khi cộng tiền (làm tròn xuống — R12/R13.4).
    const creditVnd = Math.floor(usdt * rate)

    // 2) Hạn mức: USDT tối thiểu (R13.2) + giá trị VND quy đổi không vượt trần (R13.4).
    if (usdt < cryptoMinUsdt) {
      return {
        success: false,
        error: { type: 'limit', message: t(lang, 'deposit.limit.usdt_min', { min: cryptoMinUsdt }) },
      }
    }
    if (creditVnd > limits.max) {
      return {
        success: false,
        error: {
          type: 'limit',
          message: t(lang, 'deposit.limit.vnd_max', { max: formatMoney(limits.max, lang) }),
        },
      }
    }

    // 3) Luật chống lạm dụng dùng chung (cooldown + trần pending) — đồng nhất mọi provider (R13.6).
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

    // 4) Tạo deposit pending TRƯỚC để lấy id dùng làm payload invoice. usdt_amount giữ
    //    chuỗi thập phân; amount = creditVnd (VND kỳ vọng). transfer_code để NULL.
    const usdtAmount = String(usdt)
    const now = new Date().toISOString()
    const inserted = await db
      .prepare(
        "INSERT INTO deposits (user_id, provider, amount, status, asset, usdt_amount, created_at) VALUES (?, 'cryptobot', ?, 'pending', 'USDT', ?, ?) RETURNING id"
      )
      .bind(userId, creditVnd, usdtAmount, now)
      .first<{ id: number }>()

    if (!inserted) {
      return {
        success: false,
        error: { type: 'provider_error', message: t(lang, 'deposit.generic_error') },
      }
    }

    // 5) Gọi Crypto Pay createInvoice. Thất bại → XOÁ deposit vừa tạo (không để pending
    //    mồ côi — R10.4) rồi trả provider_error.
    try {
      // Token DB-first (CMS) → fallback secret Worker. Thiếu cả hai → createInvoice fail-fast.
      const cryptoPayToken = await resolveCryptoPayToken(db, env)
      const invoice = await createInvoice({
        token: cryptoPayToken,
        asset: 'USDT',
        amount: usdtAmount,
        description: `Nạp ${usdtAmount} USDT`,
        depositId: inserted.id,
        expiresIn: CRYPTO_INVOICE_EXPIRES_IN_SEC,
      })

      // Chọn liên kết thanh toán theo kênh khởi tạo; fallback payUrl chung.
      const payUrl =
        (channel === 'miniapp' ? invoice.miniAppInvoiceUrl : invoice.botInvoiceUrl) ?? invoice.payUrl
      if (!payUrl) {
        throw new CryptoPayApiError('Crypto Pay không trả về liên kết thanh toán')
      }

      // Gắn invoice id vào deposit (idempotency cho webhook).
      await db
        .prepare("UPDATE deposits SET crypto_invoice_id = ? WHERE id = ? AND status = 'pending'")
        .bind(invoice.invoiceId, inserted.id)
        .run()

      return {
        success: true,
        output: {
          depositId: inserted.id,
          crypto: { payUrl, usdtAmount, invoiceId: invoice.invoiceId, creditVnd },
        },
      }
    } catch (cause) {
      // Dọn deposit mồ côi: chỉ xoá khi vẫn pending và chưa gắn invoice (an toàn idempotent).
      await db
        .prepare("DELETE FROM deposits WHERE id = ? AND status = 'pending' AND crypto_invoice_id IS NULL")
        .bind(inserted.id)
        .run()

      // Chi tiết lỗi nội bộ (VN, có thể chứa thông tin kỹ thuật) chỉ ghi log, KHÔNG hiển thị cho user.
      const detail = cause instanceof CryptoPayApiError ? cause.message : String(cause)
      console.error('[CryptoPayProvider] createInvoice thất bại cho deposit:', inserted.id, detail)
      return {
        success: false,
        error: { type: 'provider_error', message: t(lang, 'deposit.error.invoice_failed') },
      }
    }
  }
}

/** Instance dùng chung của CryptoPay provider. */
export const cryptoPayProvider: PaymentProvider = new CryptoPayProvider()
