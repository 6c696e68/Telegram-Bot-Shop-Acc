/**
 * User Locale service — quản lý Region và Language của User.
 *
 * Tách rời Region (vùng, quyết định tập phương thức nạp) và Language (ngôn ngữ hiển thị):
 *  - `resolveLang`: chuỗi fallback xác định để chọn ngôn ngữ hiển thị.
 *  - `regionDefaultLang`: ngôn ngữ khởi tạo theo vùng (bảng tra trong registry, không if/else cứng).
 *  - `setRegion`: lưu vùng; chỉ set ngôn ngữ khởi tạo khi user CHƯA tự đổi (`language_locked=0`) — R6.4.
 *  - `setLanguage`: lưu ngôn ngữ user tự chọn + khoá (`language_locked=1`) để đổi vùng sau không ghi đè.
 *
 * Nguồn ngôn ngữ hợp lệ là registry `SUPPORTED_LANGUAGES` (single source of truth ở `src/i18n/locales.ts`),
 * KHÔNG hardcode rời rạc. `default_language` đọc runtime từ `system_config` (DB-first, không cache),
 * có validate theo registry; giá trị sai → lùi `BASE_FALLBACK_LANG` (fail-safe, không che lỗi nghiệp vụ khác).
 */

import {
  BASE_FALLBACK_LANG,
  isSupportedLang,
  REGION_DEFAULT_LANG,
  type Lang,
  type Region,
} from '../i18n/locales'
import type { DbUser } from '../types/db'
import { readSystemConfigValue } from '../utils/system-config'

/** Key trong `system_config` chứa mã locale mặc định toàn hệ thống. */
const DEFAULT_LANGUAGE_KEY = 'default_language'

/**
 * Xác định ngôn ngữ hiển thị cho một User theo chuỗi fallback xác định:
 *   `user.language` → `default_language` (config) → `BASE_FALLBACK_LANG`.
 * Mỗi mắt xích phải `isSupportedLang` mới được chấp nhận; không hợp lệ thì đi tiếp.
 *
 * @returns luôn là một `Lang` hợp lệ (không bao giờ ném lỗi vì thiếu/sai cấu hình) — R4.1/4.2/4.3/4.4.
 */
export async function resolveLang(
  db: D1Database,
  user: Pick<DbUser, 'language'>
): Promise<Lang> {
  if (isSupportedLang(user.language)) {
    return user.language
  }

  const defaultLanguage = await readSystemConfigValue(db, DEFAULT_LANGUAGE_KEY)
  if (isSupportedLang(defaultLanguage)) {
    return defaultLanguage
  }

  return BASE_FALLBACK_LANG
}

/** Ngôn ngữ khởi tạo theo vùng (R3.3/3.4). */
export function regionDefaultLang(region: Region): Lang {
  return REGION_DEFAULT_LANG[region]
}

/**
 * Lưu Region cho User. Nếu User CHƯA tự đổi ngôn ngữ (`language_locked=0`),
 * đồng thời set `language` = ngôn ngữ khởi tạo của vùng (R3.3/3.4).
 * Nếu đã khoá (`language_locked=1`) thì GIỮ NGUYÊN `language` (R6.4 — ngôn ngữ độc lập vùng).
 *
 * Cập nhật trong một câu lệnh nguyên tử dùng `CASE` để tránh đọc-rồi-ghi (race-free).
 */
export async function setRegion(
  db: D1Database,
  userId: number,
  region: Region
): Promise<void> {
  const now = new Date().toISOString()
  await db
    .prepare(
      `UPDATE users
         SET region = ?,
             language = CASE WHEN language_locked = 0 THEN ? ELSE language END,
             updated_at = ?
       WHERE id = ?`
    )
    .bind(region, regionDefaultLang(region), now, userId)
    .run()
}

/**
 * Lưu Language do User tự chọn và khoá (`language_locked=1`) để các lần đổi vùng sau
 * không ghi đè (R6.3/6.4). Validate theo registry trước khi ghi (fail-fast khi mã sai).
 *
 * @throws Error nếu `lang` không thuộc `SUPPORTED_LANGUAGES`.
 */
export async function setLanguage(
  db: D1Database,
  userId: number,
  lang: Lang
): Promise<void> {
  if (!isSupportedLang(lang)) {
    throw new Error(`setLanguage: mã ngôn ngữ không được hỗ trợ: ${lang}`)
  }

  const now = new Date().toISOString()
  await db
    .prepare(
      `UPDATE users
         SET language = ?,
             language_locked = 1,
             updated_at = ?
       WHERE id = ?`
    )
    .bind(lang, now, userId)
    .run()
}
