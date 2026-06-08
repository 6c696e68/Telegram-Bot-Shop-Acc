/**
 * SePayProvider — implement `PaymentProvider` cho luồng nạp tiền VietQR qua SePay.
 *
 * Đây là NGUỒN LOGIC CHUNG cho việc tạo yêu cầu nạp SePay (trước đây lặp ở
 * `bot/callbacks/deposit.ts` và `routes/miniapp-api.ts`). Cả Bot lẫn Mini App gọi
 * `sePayProvider.createDeposit` thay vì tự dựng lại transfer_code + VietQR + validate.
 *
 * Trách nhiệm `createDeposit` (đơn vị VND):
 *  1. Validate hạn mức `min/max_deposit` (`readDepositLimits`) → lỗi `limit`.
 *  2. Kiểm tra luật chống lạm dụng (`checkDepositPolicy`) → lỗi `policy`.
 *  3. Sinh `transfer_code` theo `telegramId` (khớp đối soát SePay, đồng nhất 2 kênh).
 *  4. INSERT `deposits` pending với `provider='sepay'`.
 *  5. Resolve thông tin ngân hàng (`resolveBankConfig`) + dựng VietQR (`generateVietQRUrl`).
 *
 * Việc cộng tiền khi SePay xác nhận do `deposit-service.completeDeposit` (dùng chung) đảm nhiệm.
 *
 * Đăng ký vào registry để dùng provider-agnostic được làm ở module đăng ký (task 5.3);
 * ở đây chỉ export instance `sePayProvider` để caller hiện hữu dùng trực tiếp.
 */

import type { Bindings } from '../../types/bindings'
import { generateTransferCode } from '../../utils/transfer-code'
import { generateVietQRUrl } from '../../utils/vietqr'
import { formatMoney } from '../../utils/format'
import { escapeHtml } from '../../utils/telegram-template'
import { t, type Lang } from '../../bot/i18n'
import { readDepositLimits } from '../deposit-limits'
import { checkDepositPolicy } from '../deposit-policy'
import { resolveBankConfig, type BankConfig } from '../bank-config'
import type {
  AmountUnit,
  CreateDepositInput,
  CreateDepositResult,
  PaymentProvider,
  ProviderId,
} from './types'

/** Implement nội bộ — export qua instance `sePayProvider` (không cần nhiều bản). */
class SePayProvider implements PaymentProvider {
  readonly id: ProviderId = 'sepay'
  readonly amountUnit: AmountUnit = 'vnd'

  async createDeposit(input: CreateDepositInput): Promise<CreateDepositResult> {
    const { db, env, userId, telegramId, rawAmount, lang } = input

    // 1) Hạn mức VND theo system_config (admin chỉnh qua CMS) — đồng bộ Bot/Mini App/webhook.
    const limits = await readDepositLimits(db)
    if (!Number.isInteger(rawAmount) || rawAmount < limits.min || rawAmount > limits.max) {
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

    // 2) Luật chống lạm dụng dùng chung (D1-backed): cooldown + trần pending. Key theo users.id.
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

    // 3) transfer_code sinh theo telegram_id để khớp flow đối soát SePay (2 kênh đồng nhất).
    const transferCode = generateTransferCode(telegramId)
    const now = new Date().toISOString()

    // 4) Tạo deposit pending — set provider='sepay' tường minh (phân tách provider — Property 5).
    //    correlation_ref = transfer_code (mã đối soát nội bộ, cột chung schema mới).
    const inserted = await db
      .prepare(
        "INSERT INTO deposits (user_id, provider, correlation_ref, amount, status, created_at) VALUES (?, 'sepay', ?, ?, 'pending', ?) RETURNING id"
      )
      .bind(userId, transferCode, rawAmount, now)
      .first<{ id: number }>()

    if (!inserted) {
      return {
        success: false,
        error: { type: 'provider_error', message: t(lang, 'deposit.generic_error') },
      }
    }

    // 5) Thông tin ngân hàng (DB-first, fallback env) + VietQR (addInfo = transfer_code).
    const bank = await resolveBankConfig(db, env)
    const qrUrl = generateVietQRUrl({
      bankId: bank.bankName,
      accountNo: bank.bankAccount,
      accountName: bank.bankOwner,
      amount: rawAmount,
      description: transferCode,
    })

    return {
      success: true,
      output: {
        depositId: inserted.id,
        vietqr: { qrUrl, transferCode, bank, amountVnd: rawAmount },
      },
    }
  }
}

/** Instance dùng chung của SePay provider. */
export const sePayProvider: PaymentProvider = new SePayProvider()

/**
 * Dựng caption HTML "Thông tin chuyển khoản" cho ảnh VietQR — DÙNG CHUNG cho Bot + Mini App
 * (trước đây lặp ở cả hai nơi). Render theo `lang` qua catalog (R4.1/R4.2). ESCAPE HTML mọi
 * giá trị động (`bankName`/`bankAccount`/`bankOwner`/`transferCode`) vì thông tin ngân hàng lấy
 * từ `system_config` (admin nhập qua CMS) — tránh phá vỡ HTML/injection (Req 10.3, 15.1).
 */
export function buildDepositCaption(
  bank: BankConfig,
  amountVnd: number,
  transferCode: string,
  lang: Lang
): string {
  return [
    t(lang, 'deposit.caption.title'),
    '',
    t(lang, 'deposit.caption.bank', { bank: escapeHtml(bank.bankName) }),
    t(lang, 'deposit.caption.account', { account: escapeHtml(bank.bankAccount) }),
    t(lang, 'deposit.caption.owner', { owner: escapeHtml(bank.bankOwner) }),
    t(lang, 'deposit.caption.amount', { amount: formatMoney(amountVnd, lang) }),
    t(lang, 'deposit.caption.code', { code: escapeHtml(transferCode) }),
    '',
    t(lang, 'deposit.caption.important'),
    t(lang, 'deposit.caption.auto'),
  ].join('\n')
}
