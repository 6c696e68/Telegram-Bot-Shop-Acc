/**
 * Telegram Bot API types — subset cần thiết cho bot.
 */

export interface TelegramUpdate {
  update_id: number
  message?: Message
  callback_query?: CallbackQuery
}

export interface Message {
  message_id: number
  from?: TelegramUser
  chat: Chat
  date: number
  text?: string
  photo?: PhotoSize[]
  reply_markup?: InlineKeyboardMarkup | ReplyKeyboardMarkup
}

export interface CallbackQuery {
  id: string
  from: TelegramUser
  message?: Message
  chat_instance: string
  data?: string
}

export interface TelegramUser {
  id: number
  is_bot: boolean
  first_name: string
  last_name?: string
  username?: string
  language_code?: string
}

export interface Chat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
  first_name?: string
  last_name?: string
}

export interface PhotoSize {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][]
}

export interface InlineKeyboardButton {
  text: string
  callback_data?: string
  url?: string
  /** Mở Telegram Mini App (web_app) khi bấm — chỉ dùng trong private chat. */
  web_app?: { url: string }
}

export interface ReplyKeyboardMarkup {
  keyboard: KeyboardButton[][]
  resize_keyboard?: boolean
  one_time_keyboard?: boolean
  is_persistent?: boolean
}

export interface KeyboardButton {
  text: string
}

export interface ReplyKeyboardRemove {
  remove_keyboard: true
}
