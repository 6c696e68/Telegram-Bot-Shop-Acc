/**
 * Callback đổi ngôn ngữ — `lang:<code>` + bộ chọn ngôn ngữ cho lệnh `/language`.
 *
 * Ngôn ngữ tách rời vùng (R6): `setLanguage` đặt `language_locked=1` để các lần đổi
 * vùng sau không ghi đè. Bộ chọn render động từ `SUPPORTED_LANGUAGES` nên thêm ngôn
 * ngữ mới chỉ cần thêm mã + catalog, KHÔNG sửa lõi (OCP).
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */

import type { DbUser } from '../../types/db'
import { SUPPORTED_LANGUAGES, isSupportedLang, type Lang } from '../../i18n/locales'
import { sendMessage, editOrSendMessage, buildMainMenu, buildInlineKeyboard } from '../telegram-api'
import { setLanguage } from '../../services/user-locale'
import { t, type MessageKey } from '../i18n'

/** Nhãn ngôn ngữ trong bộ chọn (key catalog `language.name.<code>`). */
function languageLabel(displayLang: Lang, code: Lang): string {
  return t(displayLang, `language.name.${code}` as MessageKey)
}

/**
 * Gửi bộ chọn ngôn ngữ (inline keyboard `lang:<code>`), render động theo
 * `SUPPORTED_LANGUAGES`. `displayLang` là ngôn ngữ hiển thị hiện tại của user.
 *
 * `messageId` (tuỳ chọn): khi mở từ màn Cài đặt → edit message hiện tại;
 * khi gọi từ lệnh `/language` (không có messageId) → gửi tin mới.
 */
export async function sendLanguagePicker(
  botToken: string,
  chatId: number,
  displayLang: Lang,
  messageId?: number
): Promise<void> {
  const buttons = SUPPORTED_LANGUAGES.map((code) => ({
    text: languageLabel(displayLang, code),
    callback_data: `lang:${code}`,
  }))

  await editOrSendMessage(botToken, chatId, messageId, t(displayLang, 'language.prompt'), {
    parse_mode: 'HTML',
    reply_markup: buildInlineKeyboard([buttons]),
  })
}

/**
 * Xử lý callback `lang:<code>`:
 *  - Validate mã ngôn ngữ theo registry.
 *  - Lấy `users.id` từ `telegram_id`.
 *  - `setLanguage` (lưu + khoá `language_locked=1` — R6.3/6.4).
 *  - Xác nhận + hiển thị lại menu chính theo ngôn ngữ MỚI.
 */
export async function handleLanguageCallback(
  db: D1Database,
  botToken: string,
  chatId: number,
  params: string[],
  telegramId: number
): Promise<void> {
  const code = params[0]
  if (!isSupportedLang(code)) {
    // Mã không hợp lệ → bỏ qua, không thay đổi trạng thái.
    return
  }

  const user = await db
    .prepare('SELECT id FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<Pick<DbUser, 'id'>>()

  if (!user) {
    return
  }

  await setLanguage(db, user.id, code)

  await sendMessage(
    botToken,
    chatId,
    t(code, 'language.changed', { language: languageLabel(code, code) }),
    {
      parse_mode: 'HTML',
      reply_markup: buildMainMenu(code),
    }
  )
}
