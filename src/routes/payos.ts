/**
 * PayOS Webhook Route — xử lý callback từ PayOS khi một payment link được thanh toán.
 *
 * Đối xứng `routes/sepay.ts` về quy ước mã trạng thái (500 cho `db_error`, 200 cho mọi
 * no-op) nhưng khác cách xác thực chữ ký:
 *  - CryptoBot ký trên RAW body → dùng middleware đọc body trước.
 *  - PayOS ký trên các trường `data` đã sắp xếp theo khoá (`sortObjDataByKey(data)`),
 *    KHÔNG phải raw body → phải parse JSON trước để lấy `data` + `signature` rồi mới
 *    verify. Vì vậy verify ở tầng route (không qua middleware).
 *
 * Luồng:
 *  1. Parse JSON; lỗi parse → 200 (không có gì để xử lý, tránh PayOS retry vô ích).
 *  2. Verify `HMAC-SHA256(checksumKey, sortObjDataByKey(body.data)) === body.signature`
 *     (so sánh hằng-thời-gian). Thiếu `checksumKey`/`data`/`signature` hoặc sai chữ ký
 *     → 401, KHÔNG cộng tiền, giữ nguyên số dư (R12.2, R12.3).
 *  3. Chỉ xử lý sự kiện thanh toán thành công; loại khác → 200 no-op (R12.7).
 *  4. Lookup deposit theo `correlation_ref == orderCode` (provider='payos').
 *  5. `completeDeposit` cộng đúng số VND trên deposit NGAY (không tỷ giá, không
 *     `awaiting_credit`) (R12.4, R12.5, R13.2, R13.3). `db_error` → 500 để PayOS retry
 *     (R12.8); mọi no-op (không khớp / đã completed / không phải success) → 200 (R12.6,
 *     R12.7, R12.9, R13.4).
 *  6. Notify user theo ngôn ngữ qua `renderDepositSuccess` bằng `waitUntil` (R15.2, R15.4).
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 13.2, 13.3, 13.4,
 * 15.2, 15.4, 24.4
 */
import { Hono } from 'hono'
import type { AppEnv } from '../types'
import type { DbUser } from '../types/db'
import { completeDeposit } from '../services/deposit-service'
import { resolvePayOsConfig } from '../services/payos-config'
import { resolveBotToken } from '../services/telegram-config'
import { resolveLang } from '../services/user-locale'
import { sendMessage } from '../bot/telegram-api'
import { renderDepositSuccess } from '../bot/notify-deposit'
import { buildCurrencyContext } from '../utils/format'
import { timingSafeEqualHex, toHex } from '../utils/crypto-signature'

/**
 * Trường `data` trong webhook PayOS (chỉ khai báo các trường được dùng — PayOS có thể
 * gửi thêm trường khác, tất cả vẫn tham gia tính chữ ký qua `sortObjDataByKey`).
 */
interface PayOsWebhookData {
  /** Mã đơn hàng — khớp `deposits.correlation_ref` (lưu dạng chuỗi). */
  orderCode?: number | string
  /** Định danh payment link — khớp `deposits.provider_txn_id` (idempotency). */
  paymentLinkId?: string
  /** Mã trạng thái giao dịch ('00' = thành công). */
  code?: string
  /** Các trường khác PayOS gửi kèm (đều tham gia ký). */
  [key: string]: unknown
}

/** Thân webhook PayOS. */
interface PayOsWebhookBody {
  /** Mã kết quả webhook ('00' = thành công). */
  code?: string
  /** Cờ thành công (một số phiên bản gửi kèm). */
  success?: boolean
  /** Dữ liệu giao dịch (đối tượng được ký). */
  data?: PayOsWebhookData
  /** Chữ ký HMAC-SHA256 hex trên `sortObjDataByKey(data)`. */
  signature?: string
}

/** Cột deposit cần để cộng tiền + notify. */
interface PayOsDepositRow {
  id: number
  user_id: number
  status: 'pending' | 'completed' | 'expired' | 'cancelled' | 'awaiting_credit'
  amount: number
}

/**
 * Build chuỗi ký PayOS từ object `data` — KHỚP CHÍNH XÁC thuật toán SDK PayOS
 * (`sortObjDataByKey` + `convertObjToQueryStr` của payos-lib-node):
 *  1. Sắp các khoá top-level theo alphabet.
 *  2. Với mỗi khoá, nối `key=value`:
 *     - value là MẢNG → `JSON.stringify(value.map(el => sort key của el nếu el là object))`.
 *     - value ∈ {null, undefined, 'null', 'undefined'} → chuỗi rỗng.
 *     - còn lại (số/chuỗi/object thường) → coerce mặc định (`${value}`), giống SDK.
 *  3. Nối bằng `&`.
 *
 * Lưu ý: chuẩn này khác bản rút gọn cũ ở 2 điểm tinh tế (mảng có object lồng + chuỗi
 * sentinel 'null'/'undefined'), bảo đảm verify đúng kể cả khi PayOS thêm field mảng vào
 * `data` (tránh 401 oan → user trả tiền nhưng không được cộng).
 */
function sortObjElementByKey(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, k) => {
      acc[k] = obj[k]
      return acc
    }, {})
}

function sortObjDataByKey(data: Record<string, unknown>): string {
  return Object.keys(data)
    .sort()
    .map((key) => {
      let value = data[key]
      if (Array.isArray(value)) {
        value = JSON.stringify(
          value.map((el) =>
            el !== null && typeof el === 'object' && !Array.isArray(el)
              ? sortObjElementByKey(el as Record<string, unknown>)
              : el
          )
        )
      }
      if (value === null || value === undefined || value === 'null' || value === 'undefined') {
        value = ''
      }
      return `${key}=${value}`
    })
    .join('&')
}

/** `signature = HMAC_SHA256(checksumKey, sortObjDataByKey(data))` ở dạng hex. */
async function signPayOsData(data: Record<string, unknown>, checksumKey: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(checksumKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const buffer = await crypto.subtle.sign('HMAC', key, encoder.encode(sortObjDataByKey(data)))
  return toHex(buffer)
}

/**
 * Sự kiện thanh toán thành công khi mã kết quả là '00' ở cấp webhook HOẶC trong `data`.
 * PayOS gửi `code: '00'` cho giao dịch thành công.
 */
function isSuccessfulPayment(body: PayOsWebhookBody): boolean {
  return body.code === '00' || body.data?.code === '00'
}

const payOsWebhook = new Hono<AppEnv>()

payOsWebhook.post('/payos', async (c) => {
  const db = c.env.DB

  // 1) Parse JSON. Lỗi parse → 200 (không có gì để xử lý).
  let body: PayOsWebhookBody
  try {
    body = await c.req.json<PayOsWebhookBody>()
  } catch {
    return c.json({ success: true })
  }

  // 2) Verify chữ ký: HMAC-SHA256(checksumKey, sortObjDataByKey(data)) === signature.
  // Thiếu cấu hình/dữ liệu/chữ ký hoặc sai chữ ký → 401, KHÔNG cộng tiền (R12.2, R12.3).
  const { checksumKey } = await resolvePayOsConfig(db, c.env)
  if (!checksumKey || !body.data || !body.signature) {
    console.warn('[PayOS] Từ chối: thiếu checksumKey/data/signature')
    return c.json({ success: false }, 401)
  }

  const expectedSignature = await signPayOsData(body.data, checksumKey)
  if (!timingSafeEqualHex(expectedSignature, body.signature)) {
    console.warn('[PayOS] Từ chối: chữ ký webhook không khớp')
    return c.json({ success: false }, 401)
  }

  // 3) Chỉ xử lý sự kiện thanh toán thành công (R12.7).
  if (!isSuccessfulPayment(body)) {
    return c.json({ success: true })
  }

  // 4) Lookup deposit theo correlation_ref == orderCode (provider='payos').
  const orderCode = body.data.orderCode
  if (orderCode === undefined || orderCode === null) {
    console.warn('[PayOS] Sự kiện thành công thiếu orderCode, bỏ qua.')
    return c.json({ success: true })
  }

  const deposit = await db
    .prepare(
      `SELECT id, user_id, status, amount FROM deposits
       WHERE provider = 'payos' AND correlation_ref = ?`
    )
    .bind(String(orderCode))
    .first<PayOsDepositRow>()

  if (!deposit) {
    console.warn('[PayOS] Không tìm thấy deposit cho orderCode:', String(orderCode))
    return c.json({ success: true })
  }

  // Idempotency: deposit đã completed → bỏ qua, trả 200 (R12.6, R13.4).
  if (deposit.status === 'completed') {
    return c.json({ success: true })
  }

  // 5) Cộng tiền NGAY theo đúng số VND đã ghi trên deposit (không tỷ giá, không
  // awaiting_credit) — R12.4, R12.5, R13.2, R13.3.
  // providerTxnId: CHỈ truyền khi có paymentLinkId. KHÔNG truyền '' vì COALESCE sẽ ghi
  // đè provider_txn_id thật (đã set lúc tạo link) → phá idempotency partial unique.
  const paymentLinkId =
    typeof body.data.paymentLinkId === 'string' && body.data.paymentLinkId.length > 0
      ? body.data.paymentLinkId
      : undefined

  const result = await completeDeposit({
    db,
    depositId: deposit.id,
    userId: deposit.user_id,
    creditVnd: deposit.amount,
    provider: 'payos',
    providerTxnId: paymentLinkId,
    metadata: { payos_status: body.data.code },
  })

  if (!result.success && result.error === 'db_error') {
    // Lỗi atomic tạm thời SAU khi thanh toán đã xác nhận → 500 để PayOS retry callback.
    // Deposit chưa bị đánh dấu completed nên retry còn cộng được; guard trạng thái trong
    // completeDeposit + partial unique (provider, provider_txn_id) chặn cộng trùng (R12.8).
    console.error('[PayOS] completeDeposit db_error cho deposit:', deposit.id)
    return c.json({ success: false }, 500)
  }

  if (!result.success) {
    // already_processed / not_found → coi như xong, trả 200 idempotent, KHÔNG notify lại
    // (R12.9, R13.4).
    return c.json({ success: true })
  }

  // 6) Thành công → thông báo user theo ngôn ngữ (R15.2, R15.4) — fire-and-forget waitUntil.
  const user = await db
    .prepare('SELECT * FROM users WHERE id = ?')
    .bind(deposit.user_id)
    .first<DbUser>()

  if (user) {
    const botToken = await resolveBotToken(db, c.env)
    const lang = await resolveLang(db, user)
    const currencyCtx = await buildCurrencyContext(db, { lang, region: user.region })
    const text = renderDepositSuccess(currencyCtx, deposit.amount, result.newBalance)

    const notificationPromise = sendMessage(botToken, user.telegram_id, text, {
      parse_mode: 'HTML',
    }).catch((err) => {
      console.error('[PayOS] Gửi thông báo thất bại cho deposit:', deposit.id, err)
    })

    if (c.executionCtx?.waitUntil) {
      c.executionCtx.waitUntil(notificationPromise)
    }
  } else {
    console.error('[PayOS] Không tìm thấy user để notify cho deposit:', deposit.id)
  }

  return c.json({ success: true })
})

export { payOsWebhook }
