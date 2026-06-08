import { createMiddleware } from 'hono/factory'
import type { Bindings } from '../types'
import { resolveCryptoPayToken } from '../services/cryptopay-config'
import { timingSafeEqualHex, toHex } from '../utils/crypto-signature'

/**
 * Context variables được set bởi `cryptoPayAuth`.
 *
 * Middleware đọc raw body một lần để tính HMAC, rồi lưu vào context dưới key
 * `rawBody`. Route handler (task 6.2) KHÔNG gọi lại `c.req.text()` (sẽ gặp lỗi
 * "body already consumed" trong một số runtime) mà lấy lại body đã xác thực qua
 * `c.get('rawBody')` rồi tự `JSON.parse` khi cần.
 */
export type CryptoPayVariables = {
  /** Raw request body (text) đã được middleware đọc và xác thực chữ ký. */
  rawBody: string
}

type CryptoPayEnv = {
  Bindings: Bindings
  Variables: CryptoPayVariables
}

/** Tên header chứa chữ ký webhook của Crypto Pay. */
const SIGNATURE_HEADER = 'crypto-pay-api-signature'

/**
 * Middleware xác thực webhook từ Crypto Pay (R19.2 - R19.5).
 *
 * Quy trình:
 * 1. Đọc raw body (`c.req.text()`), lưu vào context (`rawBody`) cho handler dùng lại.
 * 2. `secret = SHA256(CRYPTO_PAY_API_TOKEN)` (bytes của digest, KHÔNG hex).
 * 3. `hmac = HMAC_SHA256(secret, rawBody)` ở dạng hex.
 * 4. So sánh hằng-thời-gian với header `crypto-pay-api-signature`.
 *
 * Trả 401 và log lý do (KHÔNG log token — R19.5) khi:
 * - Thiếu header chữ ký.
 * - Thiếu cấu hình `CRYPTO_PAY_API_TOKEN`.
 * - HMAC không khớp chữ ký.
 *
 * Dùng Web Crypto (`crypto.subtle`) sẵn có trên Cloudflare Workers.
 */
export const cryptoPayAuth = createMiddleware<CryptoPayEnv>(async (c, next) => {
  const signature = c.req.header(SIGNATURE_HEADER)
  if (!signature) {
    console.warn('[cryptopay-auth] Từ chối: thiếu header chữ ký crypto-pay-api-signature')
    return c.json({ success: false }, 401)
  }

  const token = await resolveCryptoPayToken(c.env.DB, c.env)
  if (!token) {
    console.warn('[cryptopay-auth] Từ chối: chưa cấu hình CRYPTO_PAY_API_TOKEN')
    return c.json({ success: false }, 401)
  }

  // Đọc raw body một lần; lưu lại để handler dùng tránh "body already consumed".
  const rawBody = await c.req.text()

  const encoder = new TextEncoder()

  // secret = SHA256(token) — dùng bytes của digest làm key cho HMAC.
  const secret = await crypto.subtle.digest('SHA-256', encoder.encode(token))

  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const hmacBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody))
  const expectedSignature = toHex(hmacBuffer)

  if (!timingSafeEqualHex(expectedSignature, signature)) {
    console.warn('[cryptopay-auth] Từ chối: chữ ký HMAC không khớp')
    return c.json({ success: false }, 401)
  }

  c.set('rawBody', rawBody)
  await next()
})
