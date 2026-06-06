/**
 * Crypto Pay API client — tạo hoá đơn (`createInvoice`) cho thanh toán USDT
 * qua @CryptoBot (https://help.crypt.bot/crypto-pay-api).
 *
 * Phạm vi: chỉ là tầng gọi HTTP thuần (transport) tới Crypto Pay API. Không chứa
 * logic nghiệp vụ (validate hạn mức, lưu deposit, chọn URL theo kênh) — phần đó do
 * `CryptoPayProvider`/caller xử lý. Client trả ĐỦ các URL thanh toán để caller chọn
 * đúng liên kết theo kênh (bot vs mini app).
 *
 * Nguyên tắc:
 *  - Fail-fast: HTTP lỗi hoặc API trả `ok===false` → ném `CryptoPayApiError` rõ ràng,
 *    KHÔNG nuốt lỗi, KHÔNG fallback (R10.4).
 *  - Bảo mật: token nhận qua tham số (từ `Bindings.CRYPTO_PAY_API_TOKEN`), KHÔNG đọc
 *    global. Tuyệt đối KHÔNG log/echo token trong bất kỳ thông báo lỗi nào (R19.5).
 *  - Dùng `fetch` global của Cloudflare Workers (không thêm dependency).
 */

/** Endpoint mainnet của Crypto Pay API cho `createInvoice`. */
const CRYPTO_PAY_CREATE_INVOICE_URL = 'https://pay.crypt.bot/api/createInvoice'

/** Tài sản (crypto asset) được hỗ trợ cho luồng nạp hiện tại. */
export type CryptoPayAsset = 'USDT'

/** Tham số đầu vào để tạo một hoá đơn Crypto Pay. */
export interface CreateInvoiceParams {
  /** Token Crypto Pay API — lấy từ `Bindings.CRYPTO_PAY_API_TOKEN`. */
  token: string
  /** Tài sản thanh toán (hiện chỉ `USDT`). */
  asset: CryptoPayAsset
  /** Số tiền cần thanh toán — chuỗi thập phân, giữ nguyên độ chính xác. */
  amount: string
  /** Mô tả hiển thị cho người dùng trên hoá đơn. */
  description: string
  /** Định danh deposit nội bộ để đối soát webhook (`payload`). */
  depositId: number | string
  /** Thời gian sống của hoá đơn tính bằng giây (vd 10800 = 3 giờ). */
  expiresIn: number
}

/**
 * Body request gửi tới Crypto Pay API `createInvoice`.
 * Tham chiếu: https://help.crypt.bot/crypto-pay-api#createInvoice
 */
interface CreateInvoiceRequestBody {
  /** Loại tiền: luôn `crypto` cho luồng asset USDT. */
  currency_type: 'crypto'
  /** Mã tài sản crypto. */
  asset: CryptoPayAsset
  /** Số tiền dạng chuỗi thập phân. */
  amount: string
  /** Mô tả hoá đơn. */
  description: string
  /** Payload tuỳ ý (ở đây là deposit id dạng chuỗi) để khôi phục khi nhận webhook. */
  payload: string
  /** TTL hoá đơn (giây). */
  expires_in: number
}

/**
 * Đối tượng `Invoice` trả về trong `result` của Crypto Pay API.
 * Chỉ khai báo các trường client cần dùng; các trường khác bỏ qua.
 */
interface CryptoPayInvoice {
  /** Định danh hoá đơn (số nguyên). */
  invoice_id: number
  /** Liên kết mở hoá đơn trong bot @CryptoBot. */
  bot_invoice_url?: string
  /** Liên kết mở hoá đơn dưới dạng Mini App. */
  mini_app_invoice_url?: string
  /** Liên kết web app (tên trường tuỳ phiên bản API). */
  web_app_invoice_url?: string
  /** Liên kết thanh toán (alias cũ của một số phiên bản API). */
  pay_url?: string
}

/**
 * Khung response chung của Crypto Pay API: `{ ok, result }` khi thành công,
 * `{ ok: false, error }` khi lỗi nghiệp vụ.
 */
interface CryptoPayApiResponse<T> {
  ok: boolean
  result?: T
  error?: unknown
}

/** Kết quả chuẩn hoá trả về cho caller — đủ URL để chọn theo kênh. */
export interface CreateInvoiceResult {
  /** Định danh hoá đơn dạng chuỗi (khớp `deposits.crypto_invoice_id`). */
  invoiceId: string
  /** Liên kết mở hoá đơn trong bot (dùng cho kênh `bot`). */
  botInvoiceUrl?: string
  /** Liên kết Mini App (dùng cho kênh `miniapp`). */
  miniAppInvoiceUrl?: string
  /** Liên kết thanh toán web/pay (fallback hiển thị). */
  payUrl?: string
}

/**
 * Lỗi khi gọi Crypto Pay API. Thông điệp KHÔNG chứa token (R19.5).
 */
export class CryptoPayApiError extends Error {
  /** Mã HTTP status (nếu lỗi tầng HTTP). */
  readonly httpStatus?: number
  /** Nội dung lỗi nghiệp vụ do API trả (`error` field) nếu có. */
  readonly apiError?: unknown

  constructor(message: string, options?: { httpStatus?: number; apiError?: unknown }) {
    super(message)
    this.name = 'CryptoPayApiError'
    this.httpStatus = options?.httpStatus
    this.apiError = options?.apiError
  }
}

/**
 * Tạo một hoá đơn Crypto Pay (USDT) và trả về `invoiceId` + các URL thanh toán.
 *
 * Ném `CryptoPayApiError` khi:
 *  - HTTP không 2xx (bao gồm cả khi không parse được JSON).
 *  - `ok === false` hoặc thiếu `result.invoice_id` (response không hợp lệ).
 *
 * @throws {CryptoPayApiError} Khi gọi API thất bại — KHÔNG nuốt lỗi (R10.4).
 */
export async function createInvoice(params: CreateInvoiceParams): Promise<CreateInvoiceResult> {
  const { token, asset, amount, description, depositId, expiresIn } = params

  if (!token) {
    // Fail-fast: thiếu cấu hình secret. Không lộ giá trị (vốn rỗng) ra ngoài.
    throw new CryptoPayApiError('Thiếu CRYPTO_PAY_API_TOKEN khi tạo hoá đơn Crypto Pay')
  }

  const body: CreateInvoiceRequestBody = {
    currency_type: 'crypto',
    asset,
    amount,
    description,
    payload: String(depositId),
    expires_in: expiresIn,
  }

  let response: Response
  try {
    response = await fetch(CRYPTO_PAY_CREATE_INVOICE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Crypto-Pay-API-Token': token,
      },
      body: JSON.stringify(body),
    })
  } catch (cause) {
    // Lỗi mạng/transport — không chứa token trong message.
    throw new CryptoPayApiError(
      `Không gọi được Crypto Pay API: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }

  // Parse JSON (thử cả khi HTTP lỗi để lấy `error` nghiệp vụ nếu có).
  let parsed: CryptoPayApiResponse<CryptoPayInvoice> | undefined
  let rawText: string | undefined
  try {
    rawText = await response.text()
    parsed = rawText ? (JSON.parse(rawText) as CryptoPayApiResponse<CryptoPayInvoice>) : undefined
  } catch {
    parsed = undefined
  }

  if (!response.ok) {
    throw new CryptoPayApiError(`Crypto Pay API trả lỗi HTTP ${response.status}`, {
      httpStatus: response.status,
      apiError: parsed?.error,
    })
  }

  if (!parsed || parsed.ok !== true || !parsed.result) {
    throw new CryptoPayApiError('Crypto Pay API trả về không hợp lệ (ok=false hoặc thiếu result)', {
      httpStatus: response.status,
      apiError: parsed?.error,
    })
  }

  const invoice = parsed.result
  if (invoice.invoice_id === undefined || invoice.invoice_id === null) {
    throw new CryptoPayApiError('Crypto Pay API thiếu invoice_id trong result', {
      httpStatus: response.status,
    })
  }

  return {
    invoiceId: String(invoice.invoice_id),
    botInvoiceUrl: invoice.bot_invoice_url,
    miniAppInvoiceUrl: invoice.mini_app_invoice_url,
    payUrl: invoice.pay_url ?? invoice.web_app_invoice_url,
  }
}
