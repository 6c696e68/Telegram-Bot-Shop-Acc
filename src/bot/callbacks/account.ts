/**
 * Callback handler: Thông tin tài khoản.
 * Hiển thị username, first_name, balance, tổng transactions, ngày tham gia.
 * Nội dung + định dạng tiền/ngày theo Language của user (R4.1, R4.6).
 * Requirements: 1.4, 4.1, 4.6
 */

import { editOrSendMessage, buildInlineKeyboard, buildBackButton } from '../telegram-api'
import { formatMoneyFor, formatDateTime, type CurrencyContext } from '../../utils/format'
import { t, type Lang } from '../i18n'

interface UserInfo {
  id: number
  username: string | null
  first_name: string | null
  balance: number
  created_at: string
}

/**
 * Hiển thị thông tin tài khoản user: username, tên, số dư, tổng giao dịch, ngày tham gia.
 */
export async function handleAccount(
  db: D1Database,
  botToken: string,
  chatId: number,
  messageId: number | undefined,
  userId: number,
  lang: Lang,
  ctx: CurrencyContext
): Promise<void> {
  const user = await db
    .prepare(
      `SELECT id, username, first_name, balance, created_at
       FROM users
       WHERE telegram_id = ?`
    )
    .bind(userId)
    .first<UserInfo>()

  if (!user) {
    await editOrSendMessage(botToken, chatId, messageId, t(lang, 'account.not_found'), {
      reply_markup: buildInlineKeyboard([buildBackButton('menu:main', lang)]),
    })
    return
  }

  const txCount = await db
    .prepare(`SELECT COUNT(*) as count FROM transactions WHERE user_id = ?`)
    .bind(user.id)
    .first<{ count: number }>()

  const usernameDisplay = user.username ? `@${user.username}` : t(lang, 'account.value_empty')
  const nameDisplay = user.first_name || t(lang, 'account.value_empty')
  const balanceDisplay = formatMoneyFor(user.balance, ctx)
  const txDisplay = txCount?.count ?? 0
  const joinDateDisplay = formatDateTime(user.created_at, lang)

  const text = [
    `${t(lang, 'account.title')}\n`,
    t(lang, 'account.username', { value: usernameDisplay }),
    t(lang, 'account.name', { value: nameDisplay }),
    t(lang, 'account.balance', { value: balanceDisplay }),
    t(lang, 'account.tx_count', { value: txDisplay }),
    t(lang, 'account.join_date', { value: joinDateDisplay }),
  ].join('\n')

  const keyboard = buildInlineKeyboard([
    [{ text: t(lang, 'account.btn.settings'), callback_data: 'set:menu' }],
    buildBackButton('menu:main', lang),
  ])

  await editOrSendMessage(botToken, chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  })
}
