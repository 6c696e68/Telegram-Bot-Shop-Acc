/**
 * Telegram Bot API helper — gọi API, xây dựng keyboard utilities.
 * Requirements: 7.3, 7.6, 7.9
 */

import type {
  InlineKeyboardMarkup,
  InlineKeyboardButton,
  ReplyKeyboardMarkup,
} from '../types/telegram'
import { t, type Lang } from './i18n'

// --- Telegram API response ---

interface TelegramApiResponse {
  ok: boolean
  result?: unknown
  description?: string
  error_code?: number
}

// --- Base API call ---

/**
 * Gọi Telegram Bot API method với POST JSON.
 * Throws nếu response không ok.
 */
export async function callTelegramApi(
  botToken: string,
  method: string,
  body: Record<string, unknown>
): Promise<TelegramApiResponse> {
  const url = `https://api.telegram.org/bot${botToken}/${method}`

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const data = (await response.json()) as TelegramApiResponse
  return data
}

// --- Message options ---

export interface SendMessageOptions {
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2'
  reply_markup?: InlineKeyboardMarkup | ReplyKeyboardMarkup
  disable_web_page_preview?: boolean
}

export interface EditMessageOptions {
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2'
  reply_markup?: InlineKeyboardMarkup
  disable_web_page_preview?: boolean
}

export interface SendPhotoOptions {
  caption?: string
  parse_mode?: 'HTML' | 'Markdown' | 'MarkdownV2'
  reply_markup?: InlineKeyboardMarkup | ReplyKeyboardMarkup
}

export interface AnswerCallbackQueryOptions {
  text?: string
  show_alert?: boolean
  cache_time?: number
}

// --- API methods ---

/**
 * Gửi tin nhắn mới.
 */
export async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
  options?: SendMessageOptions
): Promise<TelegramApiResponse> {
  return callTelegramApi(botToken, 'sendMessage', {
    chat_id: chatId,
    text,
    ...options,
  })
}

/**
 * Sửa nội dung tin nhắn đã gửi.
 */
export async function editMessageText(
  botToken: string,
  chatId: number,
  messageId: number,
  text: string,
  options?: EditMessageOptions
): Promise<TelegramApiResponse> {
  return callTelegramApi(botToken, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    ...options,
  })
}

/**
 * Gửi ảnh (URL hoặc file_id).
 */
export async function sendPhoto(
  botToken: string,
  chatId: number,
  photo: string,
  options?: SendPhotoOptions
): Promise<TelegramApiResponse> {
  return callTelegramApi(botToken, 'sendPhoto', {
    chat_id: chatId,
    photo,
    ...options,
  })
}

/**
 * Trả lời callback query (dismiss loading indicator trên client).
 */
export async function answerCallbackQuery(
  botToken: string,
  callbackQueryId: string,
  options?: AnswerCallbackQueryOptions
): Promise<TelegramApiResponse> {
  return callTelegramApi(botToken, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    ...options,
  })
}

/**
 * Edit message nếu có thể, fallback sang send message mới nếu edit fail.
 * Use case: message quá cũ hoặc đã bị xóa → gửi mới (Req 7.9).
 */
export async function editOrSendMessage(
  botToken: string,
  chatId: number,
  messageId: number | undefined,
  text: string,
  options?: SendMessageOptions & EditMessageOptions
): Promise<TelegramApiResponse> {
  if (messageId) {
    const editResult = await editMessageText(botToken, chatId, messageId, text, {
      parse_mode: options?.parse_mode,
      reply_markup: options?.reply_markup as InlineKeyboardMarkup | undefined,
      disable_web_page_preview: options?.disable_web_page_preview,
    })

    if (editResult.ok) {
      return editResult
    }
    // Edit failed (message too old, deleted, etc.) → fallback to sendMessage
  }

  return sendMessage(botToken, chatId, text, options)
}

// --- Keyboard builders ---

/**
 * Build InlineKeyboardMarkup từ 2D array of buttons.
 */
export function buildInlineKeyboard(
  buttons: InlineKeyboardButton[][]
): InlineKeyboardMarkup {
  return { inline_keyboard: buttons }
}

/**
 * Reply Keyboard cố định cho menu chính.
 * Hiển thị 4 nút: Mua hàng, Nạp tiền, Lịch sử, Số dư (2×2 grid).
 *
 * Nhãn render theo `lang` qua catalog i18n. Reply-keyboard dùng CHÍNH text làm
 * khóa routing nên router tra `MENU_ACTION_BY_LABEL` (gộp nhãn mọi locale) để
 * khớp đúng bất kể ngôn ngữ. Bản `vi` giữ nhãn emoji cũ (không gián đoạn UX).
 */
export function buildMainMenu(lang: Lang): ReplyKeyboardMarkup {
  return {
    keyboard: [
      [{ text: t(lang, 'menu.shop') }, { text: t(lang, 'menu.deposit') }],
      [{ text: t(lang, 'menu.history') }, { text: t(lang, 'menu.account') }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  }
}

/**
 * Tạo một hàng nút "Quay lại" inline keyboard, nhãn theo `lang` (catalog `common.back`).
 */
export function buildBackButton(callbackData: string, lang: Lang): InlineKeyboardButton[] {
  return [{ text: t(lang, 'common.back'), callback_data: callbackData }]
}
