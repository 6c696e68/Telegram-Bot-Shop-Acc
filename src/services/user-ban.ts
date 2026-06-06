/**
 * User ban service — chốt chặn dùng chung cho cả bot webhook và Mini App.
 *
 * Quy ước: cột `users.is_active` là cờ ban duy nhất.
 *   - `is_active = 1` → user hoạt động bình thường.
 *   - `is_active = 0` → user bị ban: KHÔNG được nhắn tin với bot, KHÔNG thao tác Mini App.
 *
 * Việc bật/tắt ban do CMS đảm nhận (`POST /api/admin/users/:id/ban|unban`), ghi kèm
 * `banned_at` + `ban_reason` để lưu vết. Module này chỉ chịu trách nhiệm KIỂM TRA
 * trạng thái, không tự thay đổi dữ liệu (SRP). Thông điệp gửi user bị ban được render
 * theo ngôn ngữ qua catalog i18n (`guard.ban_notice`) ở tầng webhook, không hardcode ở đây.
 */

/**
 * Kiểm tra một telegram_id có đang bị ban hay không.
 *
 * Trả `false` khi user chưa tồn tại (chưa từng /start): user mới không thể bị ban,
 * nên cho phép luồng xử lý bình thường (sẽ tự tạo user qua /start). Chỉ trả `true`
 * khi tồn tại bản ghi với `is_active = 0`.
 *
 * @param db D1 database binding.
 * @param telegramId Định danh Telegram của người gửi update (KHÔNG phải `users.id`).
 */
export async function isTelegramUserBanned(
  db: D1Database,
  telegramId: number
): Promise<boolean> {
  const row = await db
    .prepare('SELECT is_active FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<{ is_active: number }>()

  return row !== null && row.is_active === 0
}
