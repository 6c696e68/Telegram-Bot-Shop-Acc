/**
 * CryptoPay config — resolve token Crypto Pay API (@CryptoBot) cho luồng nạp USDT.
 *
 * Thứ tự ưu tiên: **DB trước, env sau** (giống `sepay-config`).
 *  1. `system_config` (key `crypto_pay_api_token`) — admin chỉnh qua CMS, đổi runtime
 *     không cần redeploy/đặt lại secret.
 *  2. Fallback secret Worker `CRYPTO_PAY_API_TOKEN` khi DB chưa có hoặc bỏ trống — giữ
 *     tương thích với cấu hình cũ (đặt bằng `wrangler secret put`).
 *
 * Token dùng cho cả tạo hoá đơn (`createInvoice`) lẫn xác thực chữ ký webhook
 * (`cryptopay-auth`). Tuyệt đối KHÔNG log/echo giá trị token (R19.5).
 */

import type { Bindings } from '../types/bindings'
import { readSystemConfigValue, preferDbValue } from '../utils/system-config'

/** Key `system_config` lưu token Crypto Pay API (do CMS ghi). */
export const CRYPTO_PAY_API_TOKEN_CONFIG = 'crypto_pay_api_token'

/** Resolve token Crypto Pay (DB-first, fallback `env.CRYPTO_PAY_API_TOKEN`). */
export async function resolveCryptoPayToken(db: D1Database, env: Bindings): Promise<string> {
  return preferDbValue(await readSystemConfigValue(db, CRYPTO_PAY_API_TOKEN_CONFIG), env.CRYPTO_PAY_API_TOKEN)
}
