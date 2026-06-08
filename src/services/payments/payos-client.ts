/**
 * PayOS API client — tạo liên kết thanh toán (`createPaymentLink`) và xác nhận
 * webhook (`confirmWebhook`) cho cổng PayOS (https://payos.vn/docs/api).
 *
 * Phạm vi: chỉ là tầng gọi HTTP thuần (transport) tới PayOS API. Không chứa logic
 * nghiệp vụ (validate hạn mức, lưu deposit, chọn URL) — phần đó do `PayOsProvider`/
 * caller xử lý. Đối xứng `crypto-pay-client.ts`.
 *
 * Nguyên tắc:
 *  - Fail-fast: HTTP không 2xx, `code !== '00'`, thiếu `data`, abort (timeout) hoặc
 *    lỗi mạng → ném `PayOsApiError` rõ ràng, KHÔNG trả link, KHÔNG fallback (R7.4).
 *  - Bảo mật: `apiKey`/`checksumKey` nhận qua tham số (từ `resolvePayOsConfig`),
 *    KHÔNG đọc global. Tuyệt đối KHÔNG log/echo `apiKey`/`checksumKey` trong bất kỳ
 *    thông báo lỗi nào — chỉ dùng `code`/`httpStatus` (R7.5, R24.1).
 *  - Dùng `fetch` + `crypto.subtle` global của Cloudflare Workers (không dependency).
 */

/** Endpoint PayOS để tạo liên kết thanh toán. */
const PAYOS_CREATE_PAYMENT_URL = 'https://api-merchant.payos.vn/v2/payment-requests'

/** Endpoint PayOS để xác nhận/đăng ký webhook URL. */
const PAYOS_CONFIRM_WEBHOOK_URL = 'https://api-merchant.payos.vn/confirm-webhook'

/** Timeout cho mọi request PayOS (30 giây). */
const PAYOS_TIMEOUT_MS = 30_000

/** Tham số đầu vào để tạo một liên kết thanh toán PayOS. */
export interface CreatePaymentLinkParams {
  /** Client ID PayOS — lấy từ cấu hình (`resolvePayOsConfig`). */
  clientId: string
  /** API key PayOS (header `x-api-key`). KHÔNG log. */
  apiKey: string
  /** Checksum key để ký HMAC-SHA256 request. KHÔNG log. */
  checksumKey: string
  /** Mã đơn hàng (số nguyên dương) — đối soát webhook qua `correlation_ref`. */
  orderCode: number
  /** Số tiền cần thanh toán (VND, số nguyên dương). */
  amount: number
  /** Mô tả hiển thị (PayOS giới hạn rất ngắn, <= 9 ký tự ở `createPaymentLink`). */
  description: string
  /** URL chuyển hướng khi thanh toán thành công. */
  returnUrl: string
  /** URL chuyển hướng khi huỷ thanh toán. */
  cancelUrl: string
}

/** Kết quả chuẩn hoá trả về cho caller khi tạo liên kết thành công. */
export interface CreatePaymentLinkResult {
  /** Liên kết trang thanh toán PayOS. */
  checkoutUrl: string
  /** Chuỗi QR code (VietQR) để hiển thị. */
  qrCode: string
  /** Định danh liên kết thanh toán (khớp `deposits.provider_txn_id`). */
  paymentLinkId: string
}

/** Tham số xác nhận/đăng ký webhook URL với PayOS (R24). */
export interface ConfirmWebhookParams {
  /** Client ID PayOS (header `x-client-id`). */
  clientId: string
  /** API key PayOS (header `x-api-key`). KHÔNG log. */
  apiKey: string
  /** URL webhook public muốn đăng ký với PayOS. */
  webhookUrl: string
}

/**
 * Body request gửi tới PayOS `createPaymentLink`.
 * Tham chiếu: https://payos.vn/docs/api/#operation/payment-request-create
 */
interface CreatePaymentLinkRequestBody {
  orderCode: number
  amount: number
  description: string
  returnUrl: string
  cancelUrl: string
  /** HMAC-SHA256 hex trên chuỗi các trường tham gia ký sắp theo alphabet. */
  signature: string
}

/**
 * Đối tượng `data` trả về trong response của PayOS `createPaymentLink`.
 * Chỉ khai báo các trường client cần dùng; các trường khác bỏ qua.
 */
interface PayOsPaymentData {
  checkoutUrl?: string
  qrCode?: string
  paymentLinkId?: string
}

/**
 * Khung response chung của PayOS API: `{ code, desc, data }`.
 * `code === '00'` là thành công; các mã khác là lỗi nghiệp vụ.
 */
interface PayOsApiResponse<T> {
  code?: string
  desc?: string
  data?: T
}

/**
 * Lỗi khi gọi PayOS API. Thông điệp KHÔNG chứa `apiKey`/`checksumKey` (R7.5, R24.1).
 */
export class PayOsApiError extends Error {
  /** Mã HTTP status (nếu lỗi tầng HTTP). */
  readonly httpStatus?: number
  /** Mã lỗi nghiệp vụ do PayOS trả (`code` field) nếu có. */
  readonly apiCode?: string

  constructor(message: string, options?: { httpStatus?: number; apiCode?: string }) {
    super(message)
    this.name = 'PayOsApiError'
    this.httpStatus = options?.httpStatus
    this.apiCode = options?.apiCode
  }
}

/** Chuyển ArrayBuffer sang chuỗi hex thường. */
function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * Ký request PayOS theo chuẩn `createPaymentLink`:
 *  1. Lấy các trường tham gia ký: `amount`, `cancelUrl`, `description`, `orderCode`, `returnUrl`.
 *  2. Sắp theo thứ tự alphabet của khoá rồi nối `key=value` bằng `&`.
 *  3. `signature = HMAC_SHA256(checksumKey, chuỗi trên)` ở dạng hex.
 *
 * Dùng Web Crypto (`crypto.subtle`) sẵn có trên Cloudflare Workers.
 */
async function signPaymentLinkRequest(
  checksumKey: string,
  params: Pick<CreatePaymentLinkParams, 'amount' | 'cancelUrl' | 'description' | 'orderCode' | 'returnUrl'>,
): Promise<string> {
  // Các trường tham gia ký, sắp theo thứ tự alphabet của khoá.
  const signedFields: Record<string, string | number> = {
    amount: params.amount,
    cancelUrl: params.cancelUrl,
    description: params.description,
    orderCode: params.orderCode,
    returnUrl: params.returnUrl,
  }
  const signaturePayload = Object.keys(signedFields)
    .sort()
    .map((key) => `${key}=${signedFields[key]}`)
    .join('&')

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(checksumKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const hmacBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(signaturePayload))
  return toHex(hmacBuffer)
}

/**
 * Gọi `fetch` với timeout qua `AbortController`. Ném `PayOsApiError` khi abort
 * (timeout) hoặc lỗi mạng — thông điệp KHÔNG chứa secret.
 */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PAYOS_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') {
      throw new PayOsApiError(`PayOS API quá thời gian chờ (${PAYOS_TIMEOUT_MS}ms)`)
    }
    throw new PayOsApiError(
      `Không gọi được PayOS API: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Tạo một liên kết thanh toán PayOS và trả về `{ checkoutUrl, qrCode, paymentLinkId }`.
 *
 * Ném `PayOsApiError` (KHÔNG trả link) khi:
 *  - HTTP không 2xx.
 *  - `code !== '00'` (lỗi nghiệp vụ).
 *  - Thiếu `data.checkoutUrl`/`data.paymentLinkId`.
 *  - Abort (timeout 30s) hoặc lỗi mạng.
 *
 * @throws {PayOsApiError} Khi gọi API thất bại — KHÔNG nuốt lỗi, KHÔNG lộ secret (R7.4, R7.5).
 */
export async function createPaymentLink(params: CreatePaymentLinkParams): Promise<CreatePaymentLinkResult> {
  const { clientId, apiKey, checksumKey, orderCode, amount, description, returnUrl, cancelUrl } = params

  if (!clientId || !apiKey || !checksumKey) {
    // Fail-fast: thiếu cấu hình secret. Không lộ giá trị ra ngoài.
    throw new PayOsApiError('Thiếu cấu hình PayOS (clientId/apiKey/checksumKey) khi tạo liên kết thanh toán')
  }

  const signature = await signPaymentLinkRequest(checksumKey, {
    amount,
    cancelUrl,
    description,
    orderCode,
    returnUrl,
  })

  const body: CreatePaymentLinkRequestBody = {
    orderCode,
    amount,
    description,
    returnUrl,
    cancelUrl,
    signature,
  }

  const response = await fetchWithTimeout(PAYOS_CREATE_PAYMENT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': clientId,
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
  })

  // Parse JSON (thử cả khi HTTP lỗi để lấy `code` nghiệp vụ nếu có).
  let parsed: PayOsApiResponse<PayOsPaymentData> | undefined
  try {
    const rawText = await response.text()
    parsed = rawText ? (JSON.parse(rawText) as PayOsApiResponse<PayOsPaymentData>) : undefined
  } catch {
    parsed = undefined
  }

  if (!response.ok) {
    throw new PayOsApiError(`PayOS API trả lỗi HTTP ${response.status}`, {
      httpStatus: response.status,
      apiCode: parsed?.code,
    })
  }

  if (!parsed || parsed.code !== '00') {
    throw new PayOsApiError('PayOS API trả về không thành công (code khác 00)', {
      httpStatus: response.status,
      apiCode: parsed?.code,
    })
  }

  const data = parsed.data
  if (!data || !data.checkoutUrl || !data.paymentLinkId) {
    throw new PayOsApiError('PayOS API thiếu checkoutUrl/paymentLinkId trong data', {
      httpStatus: response.status,
      apiCode: parsed.code,
    })
  }

  return {
    checkoutUrl: data.checkoutUrl,
    qrCode: data.qrCode ?? '',
    paymentLinkId: String(data.paymentLinkId),
  }
}

/**
 * Xác nhận/đăng ký webhook URL với PayOS (R24). PayOS gửi ping thử tới `webhookUrl`
 * và trả `code === '00'` nếu URL hợp lệ.
 *
 * Ném `PayOsApiError` (KHÔNG lộ secret) khi HTTP không 2xx, `code !== '00'`,
 * abort (timeout) hoặc lỗi mạng.
 *
 * @throws {PayOsApiError} Khi gọi API thất bại — KHÔNG nuốt lỗi, KHÔNG lộ secret (R24.1).
 */
export async function confirmWebhook(params: ConfirmWebhookParams): Promise<void> {
  const { clientId, apiKey, webhookUrl } = params

  if (!clientId || !apiKey) {
    throw new PayOsApiError('Thiếu cấu hình PayOS (clientId/apiKey) khi đăng ký webhook')
  }

  const response = await fetchWithTimeout(PAYOS_CONFIRM_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': clientId,
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ webhookUrl }),
  })

  let parsed: PayOsApiResponse<unknown> | undefined
  try {
    const rawText = await response.text()
    parsed = rawText ? (JSON.parse(rawText) as PayOsApiResponse<unknown>) : undefined
  } catch {
    parsed = undefined
  }

  if (!response.ok) {
    throw new PayOsApiError(`PayOS confirm-webhook trả lỗi HTTP ${response.status}`, {
      httpStatus: response.status,
      apiCode: parsed?.code,
    })
  }

  if (!parsed || parsed.code !== '00') {
    throw new PayOsApiError('PayOS confirm-webhook không thành công (code khác 00)', {
      httpStatus: response.status,
      apiCode: parsed?.code,
    })
  }
}
