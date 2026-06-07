/**
 * Callback màn Cài đặt — `set:menu` / `set:lang` / `set:region`.
 *
 * Gom các tuỳ chọn cá nhân (đổi ngôn ngữ, đổi khu vực) vào một màn hiển thị inline,
 * mở từ màn "Số dư" (account). Trước đây chỉ có lệnh `/language` và `/region` nên
 * người dùng khó thấy; màn này làm các tuỳ chọn đó hiển thị bằng nút bấm.
 *
 * `set:lang` / `set:region` tái dùng picker sẵn có (render inline qua messageId),
 * sau khi chọn sẽ do `handleLanguageCallback` / `handleRegionCallback` xác nhận.
 * Requirements: 5.1, 6.1
 */

import type { DbUser } from '../../types/db'
import { editOrSendMessage, buildInlineKeyboard, buildBackButton } from '../telegram-api'
import { resolveLang } from '../../services/user-locale'
import { t, type MessageKey, type Lang } from '../i18n'

/** Nhãn khu vực hiển thị (key catalog `region.name.<region>`). */
function regionLabel(lang: Lang, region: 'vietnam' | 'international' | null): string {
  if (region === null) return t(lang, 'account.value_empty')
  return t(lang, `region.name.${region}` as MessageKey)
}

/**
 * Hiển thị màn Cài đặt: ngôn ngữ + khu vực hiện tại, kèm nút đổi từng mục.
 * Đọc lại region/language thực tế từ DB để hiển thị giá trị hiện hành.
 */
export async function handleSettingsMenu(
  db: D1Database,
  botToken: string,
  chatId: number,
  messageId: number | undefined,
  telegramId: number,
  lang: Lang
): Promise<void> {
  const user = await db
    .prepare('SELECT region, language FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<Pick<DbUser, 'region' | 'language'>>()

  const currentLang = await resolveLang(db, { language: user?.language ?? null })

  const text = [
    `${t(lang, 'settings.title')}\n`,
    t(lang, 'settings.current_language', { value: t(lang, `language.name.${currentLang}` as MessageKey) }),
    t(lang, 'settings.current_region', { value: regionLabel(lang, user?.region ?? null) }),
  ].join('\n')

  const keyboard = buildInlineKeyboard([
    [{ text: t(lang, 'settings.btn.language'), callback_data: 'set:lang' }],
    [{ text: t(lang, 'settings.btn.region'), callback_data: 'set:region' }],
    buildBackButton('menu:main', lang),
  ])

  await editOrSendMessage(botToken, chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  })
}
