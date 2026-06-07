/**
 * System Config helpers — đọc `system_config` (key-value) dùng chung cho mọi config service.
 *
 * Gom phần lặp giữa `bank-config`/`sepay-config`/`telegram-config`/`deposit-limits`:
 *  - `readSystemConfigMap`: đọc nhiều key trong MỘT query, trả `Map<key, value>`.
 *  - `readSystemConfigValue`: đọc một key đơn lẻ.
 *  - `preferDbValue`: quy tắc DB-first/env-fallback dùng chung (DB chỉ thắng khi non-empty
 *    sau `trim()`; rỗng coi như "chưa cấu hình" để admin có thể xoá trong CMS và hệ thống
 *    tự quay về secret/var env).
 *
 * KHÔNG cache: nguồn sự thật luôn là D1 nên config admin đổi qua CMS có hiệu lực ngay,
 * và hành vi đọc nhất quán dưới đồng thời/nhiều isolate.
 */

/**
 * Đọc nhiều key từ `system_config` trong một truy vấn.
 * @returns `Map<key, value>` chỉ chứa các key tồn tại trong bảng.
 */
export async function readSystemConfigMap(
  db: D1Database,
  keys: readonly string[]
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map()

  const placeholders = keys.map(() => '?').join(', ')
  const { results } = await db
    .prepare(`SELECT key, value FROM system_config WHERE key IN (${placeholders})`)
    .bind(...keys)
    .all<{ key: string; value: string }>()

  return new Map(results.map((r) => [r.key, r.value]))
}

/** Đọc một giá trị config đơn lẻ; không tồn tại → `undefined`. */
export async function readSystemConfigValue(
  db: D1Database,
  key: string
): Promise<string | undefined> {
  const row = await db
    .prepare('SELECT value FROM system_config WHERE key = ?')
    .bind(key)
    .first<{ value: string }>()
  return row?.value
}

/** Chọn giá trị DB nếu non-empty sau `trim()`, ngược lại fallback env. */
export function preferDbValue(
  dbValue: string | undefined,
  envValue: string | undefined
): string {
  const trimmed = dbValue?.trim()
  return trimmed ? trimmed : (envValue ?? '')
}

/**
 * Đọc URL Mini App đã cấu hình (`system_config.miniapp_url`).
 * Rỗng/chưa cấu hình → `null` (bot sẽ ẩn nút mở Mini App).
 */
export async function readMiniAppUrl(db: D1Database): Promise<string | null> {
  const value = (await readSystemConfigValue(db, 'miniapp_url'))?.trim()
  return value ? value : null
}
