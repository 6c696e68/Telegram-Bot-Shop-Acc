import { Hono } from 'hono'
import type { AppEnv } from '../types'
import type { TelegramUpdate } from '../types/telegram'
import { telegramAuth } from '../middleware/telegram-auth'
import { handleCallbackQuery, handleTextMessage } from '../bot/router'
import { handleBotError } from '../utils/error-handler'
import {
  consumeToken,
  shouldSendNotice,
  retryAfterSeconds,
  FLOOD_RULE,
} from '../bot/rate-limit'
import { answerCallbackQuery, sendMessage } from '../bot/telegram-api'
import { isTelegramUserBanned } from '../services/user-ban'
import { resolveTelegramRuntimeConfig } from '../services/telegram-config'
import { resolveLang } from '../services/user-locale'
import { t } from '../bot/i18n'

/** Resolve ngôn ngữ hiển thị của user theo telegram_id (cho thông báo guard flood/ban). */
async function resolveLangByTelegramId(db: D1Database, telegramId: number) {
  const row = await db
    .prepare('SELECT language FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<{ language: string | null }>()
  return resolveLang(db, { language: row?.language ?? null })
}

/**
 * Telegram webhook route — POST /webhook/telegram
 * Requirements: 8.1, 8.4, 9.1, 9.3
 */
const telegramWebhook = new Hono<AppEnv>()

// Apply telegram-auth middleware to all routes
telegramWebhook.use('/telegram', telegramAuth)

telegramWebhook.post('/telegram', async (c) => {
  try {
    const update = await c.req.json<TelegramUpdate>()
    const db = c.env.DB

    // Resolve bot_token + admin_ids (DB-first, fallback env). Override env truyền xuống
    // router để mọi nhánh đọc `env.BOT_TOKEN`/`env.ADMIN_IDS` đều dùng giá trị đã resolve.
    const { botToken, adminIds } = await resolveTelegramRuntimeConfig(db, c.env)
    const env = { ...c.env, BOT_TOKEN: botToken, ADMIN_IDS: adminIds }

    // Extract telegram_id from the update for last_interaction_at tracking
    let telegramId: number | undefined

    if (update.callback_query) {
      telegramId = update.callback_query.from.id

      // Tầng flood toàn cục: chặn mash nút trước khi tốn bất kỳ tài nguyên nào.
      const verdict = consumeToken(`flood:${telegramId}`, FLOOD_RULE)
      if (!verdict.allowed) {
        // Luôn answer để client dừng spinner; chỉ hiện toast nhắc nhở có throttle.
        const notify = shouldSendNotice(`flood:${telegramId}`)
        let toastText: string | undefined
        if (notify) {
          const lang = await resolveLangByTelegramId(db, telegramId)
          toastText = t(lang, 'guard.flood_toast', { sec: retryAfterSeconds(verdict.retryAfterMs) })
        }
        await answerCallbackQuery(botToken, update.callback_query.id, {
          text: toastText,
          cache_time: 1,
        }).catch(() => {})
        return c.json({ ok: true })
      }

      // Chặn user bị ban: dismiss spinner + thông báo (throttle) rồi dừng, không xử lý nghiệp vụ.
      if (await isTelegramUserBanned(db, telegramId)) {
        const lang = await resolveLangByTelegramId(db, telegramId)
        await answerCallbackQuery(botToken, update.callback_query.id, {
          text: t(lang, 'guard.ban_toast'),
          cache_time: 5,
        }).catch(() => {})
        if (shouldSendNotice(`ban:${telegramId}`) && update.callback_query.message) {
          await sendMessage(botToken, update.callback_query.message.chat.id, t(lang, 'guard.ban_notice')).catch(() => {})
        }
        return c.json({ ok: true })
      }

      await handleCallbackQuery(db, botToken, update.callback_query, env)
    } else if (update.message) {
      telegramId = update.message.from?.id

      // Tầng flood toàn cục cho text message (gõ liên tục / paste flood).
      if (telegramId) {
        const verdict = consumeToken(`flood:${telegramId}`, FLOOD_RULE)
        if (!verdict.allowed) {
          if (shouldSendNotice(`flood:${telegramId}`)) {
            const lang = await resolveLangByTelegramId(db, telegramId)
            await sendMessage(
              botToken,
              update.message.chat.id,
              t(lang, 'guard.flood_text', { sec: retryAfterSeconds(verdict.retryAfterMs) })
            ).catch(() => {})
          }
          return c.json({ ok: true })
        }
      }

      // Chặn user bị ban: gửi thông báo (throttle) rồi dừng, không xử lý lệnh/flow.
      if (telegramId && (await isTelegramUserBanned(db, telegramId))) {
        if (shouldSendNotice(`ban:${telegramId}`)) {
          const lang = await resolveLangByTelegramId(db, telegramId)
          await sendMessage(botToken, update.message.chat.id, t(lang, 'guard.ban_notice')).catch(() => {})
        }
        return c.json({ ok: true })
      }

      const text = update.message.text?.trim() ?? ''

      // /start, /admin, /huy, /cancel lẫn text thường (reply keyboard, session input)
      // đều được điều phối qua handleTextMessage.
      await handleTextMessage(db, botToken, update.message, env)
    }

    // Fire-and-forget: update last_interaction_at for the user (ISO 8601 UTC — đồng nhất
    // định dạng timestamp với phần còn lại của hệ thống, vốn dùng `toISOString()`).
    if (telegramId) {
      c.executionCtx.waitUntil(
        db
          .prepare('UPDATE users SET last_interaction_at = ? WHERE telegram_id = ?')
          .bind(new Date().toISOString(), telegramId)
          .run()
          .catch(() => {
            // Silent fail — user might not exist yet (pre-/start)
          })
      )
    }
  } catch (error) {
    // Log error but always return 200 to Telegram
    handleBotError(error, {
      operation: 'telegramWebhook',
    })
  }

  // Always return HTTP 200 — Telegram expects this regardless of internal errors
  return c.json({ ok: true })
})

export { telegramWebhook }
