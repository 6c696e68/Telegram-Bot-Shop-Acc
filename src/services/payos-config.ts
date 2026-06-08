/**
 * PayOS config — resolve 3 khoá merchant PayOS (client id + api key + checksum key)
 * cho luồng nạp tiền PayOS.
 *
 * Thứ tự ưu tiên: **DB trước, env sau** (giống `cryptopay-config`/`sepay-config`).
 *  1. `system_config` (key `payos_client_id`/`payos_api_key`/`payos_checksum_key`) — admin
 *     chỉnh qua CMS, đổi runtime không cần redeploy/đặt lại secret.
 *  2. Fallback secret Worker `PAYOS_CLIENT_ID`/`PAYOS_API_KEY`/`PAYOS_CHECKSUM_KEY` khi DB
 *     chưa có hoặc bỏ trống — giữ tương thích với cấu hình đặt bằng `wrangler secret put`.
 *
 * `apiKey` dùng gọi API tạo payment link; `checksumKey` dùng ký request và verify chữ ký
 * webhook. Tuyệt đối KHÔNG log/echo `apiKey`/`checksumKey` (R6.4).
 */

import type { Bindings } from '../types/bindings'
import { readSystemConfigMap, preferDbValue } from '../utils/system-config'

/** Key `system_config` lưu PayOS Client ID (do CMS ghi). */
export const PAYOS_CLIENT_ID_CONFIG = 'payos_client_id'
/** Key `system_config` lưu PayOS API key (secret, do CMS ghi). */
export const PAYOS_API_KEY_CONFIG = 'payos_api_key'
/** Key `system_config` lưu PayOS Checksum key (secret, do CMS ghi). */
export const PAYOS_CHECKSUM_KEY_CONFIG = 'payos_checksum_key'

/** Bộ ba khoá merchant PayOS đã resolve. Khoá rỗng nghĩa là chưa cấu hình. */
export interface PayOsConfig {
  clientId: string
  apiKey: string
  checksumKey: string
}

/**
 * Resolve cấu hình PayOS (DB-first, fallback env). Đọc cả 3 khoá trong một query rồi
 * áp quy tắc `preferDbValue` cho từng khoá.
 *
 * @returns `PayOsConfig`; bất kỳ trường nào có thể rỗng nếu cả DB lẫn env đều chưa cấu
 *          hình — caller phải coi rỗng là "chưa cấu hình" và xử lý phù hợp (từ chối,
 *          báo lỗi cấu hình, không cộng tiền).
 */
export async function resolvePayOsConfig(db: D1Database, env: Bindings): Promise<PayOsConfig> {
  const map = await readSystemConfigMap(db, [
    PAYOS_CLIENT_ID_CONFIG,
    PAYOS_API_KEY_CONFIG,
    PAYOS_CHECKSUM_KEY_CONFIG,
  ])
  return {
    clientId: preferDbValue(map.get(PAYOS_CLIENT_ID_CONFIG), env.PAYOS_CLIENT_ID),
    apiKey: preferDbValue(map.get(PAYOS_API_KEY_CONFIG), env.PAYOS_API_KEY),
    checksumKey: preferDbValue(map.get(PAYOS_CHECKSUM_KEY_CONFIG), env.PAYOS_CHECKSUM_KEY),
  }
}
