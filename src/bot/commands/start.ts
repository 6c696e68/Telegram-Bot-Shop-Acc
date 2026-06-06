/**
 * /start command handler — đăng ký/cập nhật user và hiển thị menu chính.
 * Requirements: 1.1, 1.2, 1.3, 1.5, 7.1, 7.2, 7.10
 */

import type { TelegramUser } from '../../types/telegram'
import type { DbUser } from '../../types/db'
import { sendMessage, buildMainMenu, buildInlineKeyboard } from '../telegram-api'
import { formatMoney } from '../../utils/format'
import { handleBotError } from '../../utils/error-handler'
import { resolveLang } from '../../services/user-locale'
import { sendRegionOnboarding } from '../callbacks/region'
import { t, BASE_FALLBACK_LANG } from '../i18n'

/**
 * Handle /start command:
 * 1. Upsert user (create or update telegram info)
 * 2. Fetch shop name from system_config
 * 3. Send welcome message with Reply Keyboard menu
 */
export async function handleStart(
  db: D1Database,
  botToken: string,
  chatId: number,
  from: TelegramUser
): Promise<void> {
  try {
    const now = new Date().toISOString()
    const telegramId = from.id
    const username = from.username ?? null
    const firstName = from.first_name ?? null

    // Query existing user by telegram_id
    const existingUser = await db
      .prepare('SELECT * FROM users WHERE telegram_id = ?')
      .bind(telegramId)
      .first<DbUser>()

    let balance = 0

    if (!existingUser) {
      // Create new user
      await db
        .prepare(
          `INSERT INTO users (telegram_id, username, first_name, balance, is_active, last_interaction_at, created_at, updated_at)
           VALUES (?, ?, ?, 0, 1, ?, ?, ?)`
        )
        .bind(telegramId, username, firstName, now, now, now)
        .run()
    } else {
      // Update existing user info + last_interaction_at
      balance = existingUser.balance
      await db
        .prepare(
          `UPDATE users SET username = ?, first_name = ?, last_interaction_at = ?, updated_at = ?
           WHERE telegram_id = ?`
        )
        .bind(username, firstName, now, now, telegramId)
        .run()
    }

    // Fetch shop name from system_config (fallback to default)
    const shopConfig = await db
      .prepare("SELECT value FROM system_config WHERE key = 'shop_name'")
      .first<{ value: string }>()

    const shopName = shopConfig?.value ?? 'Telegram Shop Bot'

    // Lấy region + language hiện tại (sau upsert) để gate onboarding + chọn ngôn ngữ.
    const currentUser = await db
      .prepare('SELECT region, language FROM users WHERE telegram_id = ?')
      .bind(telegramId)
      .first<Pick<DbUser, 'region' | 'language'>>()

    const region = currentUser?.region ?? null
    const lang = await resolveLang(db, { language: currentUser?.language ?? null })

    // Chưa onboarding (region NULL) → gửi inline keyboard chọn vùng, KHÔNG hiện menu (R1.1, R1.2).
    if (region === null) {
      await sendRegionOnboarding(botToken, chatId, lang)
      return
    }

    // Đã có region → hiển thị menu chính như cũ (R1.5).
    const displayName = firstName ?? from.first_name ?? ''
    const welcomeText = [
      t(lang, 'onboarding.welcome', { shop: `<b>${shopName}</b>`, name: `<b>${displayName}</b>` }),
      t(lang, 'onboarding.balance', { balance: `<b>${formatMoney(balance, lang)}</b>` }),
    ].join('\n')

    // 1. Welcome + reply keyboard sticky (4 nút dưới khung chat)
    await sendMessage(botToken, chatId, welcomeText, {
      parse_mode: 'HTML',
      reply_markup: buildMainMenu(lang),
    })

    // 2. Inline action shortcuts để bấm trực tiếp trong message
    await sendMessage(botToken, chatId, t(lang, 'menu.quick_access'), {
      parse_mode: 'HTML',
      reply_markup: buildInlineKeyboard([
        [
          { text: t(lang, 'menu.shop'), callback_data: 'cat:list' },
          { text: t(lang, 'menu.deposit'), callback_data: 'dep:menu' },
        ],
        [
          { text: t(lang, 'menu.history'), callback_data: 'hist' },
          { text: t(lang, 'menu.account'), callback_data: 'acc' },
        ],
      ]),
    })
  } catch (error) {
    handleBotError(error, {
      userId: from.id,
      command: '/start',
      operation: 'handleStart',
    })

    // Attempt to notify user about the error (lang chưa resolve được ở nhánh lỗi → dùng fallback).
    try {
      await sendMessage(botToken, chatId, t(BASE_FALLBACK_LANG, 'common.system_error'))
    } catch {
      // If even error notification fails, silently log (already logged above)
    }
  }
}
