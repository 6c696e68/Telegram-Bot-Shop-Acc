/**
 * Payment Provider abstraction — trừu tượng hoá luồng nạp tiền theo provider.
 *
 * Mục tiêu (OCP): thêm một phương thức nạp mới = thêm một implement của
 * `PaymentProvider` + đăng ký vào registry, KHÔNG sửa logic cộng tiền dùng chung
 * (`deposit-service.completeDeposit`) hay route/bot/miniapp lõi.
 *
 * Nguyên tắc DRY: tái dùng kiểu sẵn có thay vì khai lại.
 *  - `Region` import từ `src/i18n/locales.ts` (single source of truth).
 *  - `Bindings` import từ `src/types/bindings.ts`.
 *  - `BankConfig` import từ `src/services/bank-config.ts` cho nhánh VietQR.
 *  - `DepositPolicyReason` import từ `src/services/deposit-policy.ts` cho lỗi chính sách.
 */

import type { Region } from '../../i18n/locales'
import type { Bindings } from '../../types/bindings'
import type { BankConfig } from '../bank-config'
import type { DepositPolicyReason } from '../deposit-policy'
import type { Lang } from '../../i18n/locales'

/** Định danh loại phương thức nạp được hỗ trợ. */
export type ProviderId = 'sepay' | 'cryptobot'

/**
 * Đơn vị nhập tiền của provider — quyết định cách validate hạn mức.
 *  - `vnd`: SePay_Provider nhập theo VND.
 *  - `usdt`: CryptoPay_Provider nhập theo USDT (quy đổi sang VND khi cộng tiền).
 */
export type AmountUnit = 'vnd' | 'usdt'

/**
 * Kênh khởi tạo yêu cầu nạp — quyết định loại `pay_url` provider trả về
 * (vd Crypto Pay có `bot_invoice_url` vs `mini_app_invoice_url`).
 */
export type DepositChannel = 'bot' | 'miniapp'

/** Đầu vào chung để tạo một yêu cầu nạp, độc lập với provider cụ thể. */
export interface CreateDepositInput {
  /** D1 binding. */
  db: D1Database
  /** Worker bindings (secret/env, vd CRYPTO_PAY_API_TOKEN). */
  env: Bindings
  /** `users.id` nội bộ (KHÔNG phải `telegram_id`). */
  userId: number
  /** `telegram_id` của user (phục vụ notify/đối soát). */
  telegramId: number
  /** Số tiền nhập: VND (sepay) hoặc USDT (cryptobot) — đơn vị theo `provider.amountUnit`. */
  rawAmount: number
  /** Ngôn ngữ hiển thị của user (đã resolve) — dùng render message lỗi/hạn mức theo lang (R4.1/R4.2). */
  lang: Lang
  /** Kênh khởi tạo, dùng để chọn đúng liên kết thanh toán. Mặc định `bot`. */
  channel?: DepositChannel
}

/** Dữ liệu hiển thị cho nhánh nạp VietQR (SePay_Provider). */
export interface VietQrDepositData {
  /** Liên kết ảnh QR VietQR. */
  qrUrl: string
  /** Mã chuyển khoản dùng để SePay đối soát. */
  transferCode: string
  /** Thông tin tài khoản ngân hàng nhận tiền. */
  bank: BankConfig
  /** Số VND cần chuyển. */
  amountVnd: number
}

/** Dữ liệu hiển thị cho nhánh nạp USDT (CryptoPay_Provider). */
export interface CryptoDepositData {
  /** Liên kết thanh toán Crypto Pay (theo kênh khởi tạo). */
  payUrl: string
  /** Số USDT cần thanh toán (chuỗi thập phân, giữ nguyên độ chính xác). */
  usdtAmount: string
  /** Định danh Crypto_Invoice (dùng cho idempotency webhook). */
  invoiceId: string
  /** VND quy đổi kỳ vọng = floor(usdt × rate) — để hiển thị cho user biết ~bao nhiêu VND. */
  creditVnd: number
}

/**
 * Kết quả tạo deposit thành công: id deposit pending + dữ liệu thanh toán.
 * Đúng một trong hai nhánh (`vietqr` hoặc `crypto`) được điền theo provider.
 */
export interface CreateDepositOutput {
  /** `deposits.id` vừa tạo ở trạng thái `pending`. */
  depositId: number
  /** Dữ liệu hiển thị cho nhánh SePay. */
  vietqr?: VietQrDepositData
  /** Dữ liệu hiển thị cho nhánh CryptoBot. */
  crypto?: CryptoDepositData
}

/** Lý do tạo deposit bị từ chối (provider tự validate trước khi tạo pending). */
export type CreateDepositError =
  /** Số tiền ngoài hạn mức (VND min/max hoặc USDT tối thiểu). */
  | { type: 'limit'; message: string }
  /** Bị chặn bởi chính sách cooldown / trần pending. */
  | { type: 'policy'; reason: DepositPolicyReason; retryAfterMs?: number }
  /** Lỗi phía provider khi tạo hoá đơn (vd Crypto Pay `createInvoice` thất bại — R10.4). */
  | { type: 'provider_error'; message: string }

/** Kết quả của `PaymentProvider.createDeposit`. */
export type CreateDepositResult =
  | { success: true; output: CreateDepositOutput }
  | { success: false; error: CreateDepositError }

/**
 * Giao diện chung cho mọi phương thức nạp.
 *
 * Mỗi implement chịu trách nhiệm: validate hạn mức/chính sách theo `amountUnit`,
 * tạo bản ghi deposit `pending` (set `provider`), và trả dữ liệu thanh toán.
 * Việc cộng tiền khi xác nhận do `deposit-service.completeDeposit` đảm nhiệm (dùng chung).
 */
export interface PaymentProvider {
  /** Định danh provider (khớp `deposits.provider`). */
  readonly id: ProviderId
  /** Đơn vị nhập của provider — quyết định cách validate hạn mức. */
  readonly amountUnit: AmountUnit
  /** Tạo yêu cầu nạp pending + dữ liệu thanh toán. Tự validate hạn mức/chính sách. */
  createDeposit(input: CreateDepositInput): Promise<CreateDepositResult>
}
