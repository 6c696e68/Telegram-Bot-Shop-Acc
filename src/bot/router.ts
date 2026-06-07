/**
 * Callback Query Router & Text Message Router.
 * Parse callback_data format "action:param1:param2", dispatch tới handler tương ứng.
 * Xử lý text messages: detect flow context (session), route input text tương ứng.
 * Requirements: 7.4, 7.8, 1.3, 1.4, 1.6, 3.7, 4.1
 */

import type { CallbackQuery, Message } from '../types/telegram'
import type { Bindings } from '../types/bindings'
import type { DbUser } from '../types/db'
import {
  answerCallbackQuery,
  sendMessage,
  buildMainMenu,
  buildInlineKeyboard,
  buildQuickAccessKeyboard,
  editOrSendMessage,
} from './telegram-api'
import { readMiniAppUrl } from '../utils/system-config'
import { getSession, clearSession } from './session'
import { handleStart } from './commands/start'
import { handleBotError } from '../utils/error-handler'
import { isAdmin } from '../utils/admin'
import { handleAdminCallbackRouted, handleAdminTextInputRouted, handleAdminPanel } from './commands/admin'
import {
  handleCategoryList,
  handleCategoryDetail,
  handleQuantitySelect,
  handlePurchaseConfirm,
  handlePurchaseTextInput,
} from './callbacks/purchase'
import { handleHistory, handleOrderDetail } from './callbacks/history'
import { handleAccount } from './callbacks/account'
import {
  handleDepositMenu,
  handleDepositMethod,
  handleDepositAmount,
  handleCryptoDepositAmount,
  handleDepositCancel,
} from './callbacks/deposit'
import { handleRegionCallback, sendRegionOnboarding, sendRegionPicker } from './callbacks/region'
import { handleLanguageCallback, sendLanguagePicker } from './callbacks/language'
import { handleSettingsMenu } from './callbacks/settings'
import { resolveLang } from '../services/user-locale'
import { t, BASE_FALLBACK_LANG, type Lang } from './i18n'
import { MENU_ACTION_BY_LABEL } from './i18n/menu'
import { buildCurrencyContext, type CurrencyContext } from '../utils/format'

// --- Types ---

export interface ParsedCallback {
  action: string
  params: string[]
}

/** Region + ngôn ngữ hiển thị của user (đã resolve) — dùng cho guard onboarding + i18n. */
interface UserLocale {
  /** Bản ghi user tồn tại trong DB hay chưa (chưa /start → null). */
  exists: boolean
  region: 'vietnam' | 'international' | null
  lang: Lang
  /** Context tiền tệ (region + lang + rate) cho hiển thị tiền theo Region. */
  ctx: CurrencyContext
}

// --- Helper: parse callback_data ---

/**
 * Parse callback_data string → action + params.
 * Format: "action:param1:param2:..."
 */
export function parseCallbackData(data: string): ParsedCallback {
  const parts = data.split(':')
  const action = parts[0] ?? ''
  const params = parts.slice(1)
  return { action, params }
}

/**
 * Tải region + ngôn ngữ hiển thị của user theo `telegram_id`.
 * User chưa tồn tại → `exists=false`, region=null, lang=Default_Language.
 */
async function loadUserLocale(db: D1Database, telegramId: number): Promise<UserLocale> {
  const row = await db
    .prepare('SELECT region, language FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<Pick<DbUser, 'region' | 'language'>>()

  const lang = await resolveLang(db, { language: row?.language ?? null })
  const region = row?.region ?? null
  const ctx = await buildCurrencyContext(db, { lang, region })
  return { exists: !!row, region, lang, ctx }
}

// --- Deposit callback dispatcher ---

async function handleDepositCallback(
  db: D1Database,
  botToken: string,
  chatId: number,
  messageId: number | undefined,
  params: string[],
  userId: number,
  env: Bindings
): Promise<void> {
  const subAction = params[0]

  if (subAction === 'menu' || !subAction) {
    await handleDepositMenu(db, botToken, chatId, userId, env, messageId)
    return
  }

  if (subAction === 'method') {
    await handleDepositMethod(db, botToken, chatId, userId, params[1], env, messageId)
    return
  }

  if (subAction === 'cancel') {
    await handleDepositCancel(db, botToken, chatId, userId, messageId)
    return
  }

  // subAction is an amount (e.g., "50000")
  const amount = parseInt(subAction, 10)
  if (!isNaN(amount)) {
    await handleDepositAmount(db, botToken, chatId, userId, amount, env)
    return
  }

  // Unknown deposit sub-action
  await handleDepositMenu(db, botToken, chatId, userId, env, messageId)
}

// --- Admin callback dispatcher ---

async function handleAdminCallback(
  db: D1Database,
  botToken: string,
  chatId: number,
  messageId: number | undefined,
  params: string[],
  userId: number,
  env: Bindings,
  lang: Lang
): Promise<void> {
  if (!isAdmin(userId, env.ADMIN_IDS)) {
    await editOrSendMessage(botToken, chatId, messageId, t(lang, 'common.no_permission'), {
      parse_mode: 'HTML',
    })
    return
  }
  await handleAdminCallbackRouted(db, env.BOT_TOKEN, chatId, messageId, userId, params, lang)
}

// --- Main Callback Query Handler ---

/**
 * Dispatch callback query tới handler tương ứng dựa trên action prefix.
 */
export async function handleCallbackQuery(
  db: D1Database,
  botToken: string,
  callbackQuery: CallbackQuery,
  env: Bindings
): Promise<void> {
  const chatId = callbackQuery.message?.chat.id
  const messageId = callbackQuery.message?.message_id
  const userId = callbackQuery.from.id
  const data = callbackQuery.data

  if (!chatId) return

  let lang: Lang = BASE_FALLBACK_LANG

  try {
    // Answer callback query ngay lập tức (dismiss loading indicator)
    await answerCallbackQuery(botToken, callbackQuery.id)

    const locale = await loadUserLocale(db, userId)
    lang = locale.lang

    // Nếu không có data → invalid callback
    if (!data) {
      await sendMessage(botToken, chatId, t(lang, 'common.invalid_request'), {
        reply_markup: buildMainMenu(lang),
      })
      return
    }

    const { action, params } = parseCallbackData(data)

    // Onboarding callback luôn được xử lý (kể cả khi region NULL).
    if (action === 'reg') {
      await handleRegionCallback(db, botToken, chatId, params, userId)
      return
    }

    // Đổi ngôn ngữ — cho phép kể cả khi chưa chọn vùng (ngôn ngữ độc lập vùng — R6).
    if (action === 'lang') {
      await handleLanguageCallback(db, botToken, chatId, params, userId)
      return
    }

    // Guard onboarding (R1.6, R3.7): user đã tồn tại nhưng chưa chọn vùng → bắt chọn vùng.
    if (locale.exists && locale.region === null) {
      await sendRegionOnboarding(botToken, chatId, lang)
      return
    }

    switch (action) {
      case 'cat':
        if (params[0] === 'list') {
          await handleCategoryList(db, botToken, chatId, messageId, lang, locale.ctx)
        } else {
          const catId = parseInt(params[0], 10)
          if (!isNaN(catId)) {
            await handleCategoryDetail(db, botToken, chatId, messageId, catId, userId, lang, locale.ctx)
          }
        }
        break

      case 'qty': {
        const catId = parseInt(params[0], 10)
        const qty = parseInt(params[1], 10)
        if (!isNaN(catId) && !isNaN(qty)) {
          await handleQuantitySelect(db, botToken, chatId, messageId, catId, qty, userId, lang, locale.ctx)
        }
        break
      }

      case 'buy': {
        const catId = parseInt(params[0], 10)
        const qty = parseInt(params[1], 10)
        if (!isNaN(catId) && !isNaN(qty)) {
          await handlePurchaseConfirm(db, botToken, chatId, messageId, catId, qty, userId, lang, locale.ctx)
        }
        break
      }

      case 'dep':
        await handleDepositCallback(db, botToken, chatId, messageId, params, userId, env)
        break

      case 'page':
        // page:cat:{pageNum} — pagination for category list
        if (params[0] === 'cat') {
          const pageNum = parseInt(params[1], 10)
          await handleCategoryList(db, botToken, chatId, messageId, lang, locale.ctx, isNaN(pageNum) ? 0 : pageNum)
        }
        break

      case 'menu':
        // menu:main → hiển thị menu chính với inline shortcuts (nhãn theo lang) + nút Mini App.
        await sendMessage(botToken, chatId, t(lang, 'menu.title'), {
          parse_mode: 'HTML',
          reply_markup: buildQuickAccessKeyboard(lang, await readMiniAppUrl(db)),
        })
        break

      case 'adm':
        await handleAdminCallback(db, botToken, chatId, messageId, params, userId, env, lang)
        break

      case 'hist': {
        // hist → danh sách; hist:<orderId> → chi tiết đơn (xem lại nội dung đã mua).
        const orderId = parseInt(params[0], 10)
        if (params[0] !== undefined && !isNaN(orderId)) {
          await handleOrderDetail(db, botToken, chatId, messageId, orderId, userId, lang, locale.ctx)
        } else {
          await handleHistory(db, botToken, chatId, messageId, userId, lang, locale.ctx)
        }
        break
      }

      case 'acc':
        await handleAccount(db, botToken, chatId, messageId, userId, lang, locale.ctx)
        break

      case 'set':
        // Màn Cài đặt: set:menu (mở), set:lang / set:region (picker inline).
        if (params[0] === 'lang') {
          await sendLanguagePicker(botToken, chatId, lang, messageId)
        } else if (params[0] === 'region') {
          await sendRegionPicker(botToken, chatId, lang, messageId)
        } else {
          await handleSettingsMenu(db, botToken, chatId, messageId, userId, lang)
        }
        break

      default:
        // Unknown action → thông báo lỗi + menu chính
        await sendMessage(botToken, chatId, t(lang, 'common.invalid_request'), {
          reply_markup: buildMainMenu(lang),
        })
        break
    }
  } catch (error) {
    const { shouldNotifyUser } = handleBotError(error, {
      userId,
      command: `callback:${data}`,
      operation: 'handleCallbackQuery',
    })

    if (shouldNotifyUser && chatId) {
      try {
        await sendMessage(botToken, chatId, t(lang, 'common.system_error'), {
          reply_markup: buildMainMenu(lang),
        })
      } catch {
        // Silent fail — đã log ở trên
      }
    }
  }
}

// --- Text Message Handler ---

/**
 * Dispatch text message: reply keyboard buttons → commands → session flows → fallback.
 */
export async function handleTextMessage(
  db: D1Database,
  botToken: string,
  message: Message,
  env: Bindings
): Promise<void> {
  const chatId = message.chat.id
  const from = message.from
  const text = message.text?.trim() ?? ''
  const userId = from?.id

  if (!userId || !from) return

  let lang: Lang = BASE_FALLBACK_LANG

  try {
    // /start luôn được xử lý trước (đăng ký user + onboarding/menu).
    if (text === '/start') {
      await handleStart(db, botToken, chatId, from)
      return
    }

    const locale = await loadUserLocale(db, userId)
    lang = locale.lang

    // Lệnh đổi vùng/ngôn ngữ — xử lý trước guard onboarding (R5.1, R6.1).
    // `/language` cho phép kể cả khi chưa chọn vùng (ngôn ngữ độc lập vùng — R6).
    if (text === '/region') {
      await sendRegionPicker(botToken, chatId, lang)
      return
    }
    if (text === '/language' || text === '/lang') {
      await sendLanguagePicker(botToken, chatId, lang)
      return
    }

    // Guard onboarding (R1.6, R3.7): user đã tồn tại nhưng chưa chọn vùng → bắt chọn vùng
    // trước mọi thao tác khác (trừ /start ở trên).
    if (locale.exists && locale.region === null) {
      await sendRegionOnboarding(botToken, chatId, lang)
      return
    }

    // 1. Reply keyboard buttons — tra map nhãn (gộp mọi locale) thay switch chuỗi cứng.
    const menuAction = MENU_ACTION_BY_LABEL.get(text)
    if (menuAction) {
      switch (menuAction) {
        case 'shop':
          await handleCategoryList(db, botToken, chatId, undefined, lang, locale.ctx)
          return
        case 'deposit':
          await handleDepositMenu(db, botToken, chatId, userId, env, undefined)
          return
        case 'history':
          await handleHistory(db, botToken, chatId, undefined, userId, lang, locale.ctx)
          return
        case 'account':
          await handleAccount(db, botToken, chatId, undefined, userId, lang, locale.ctx)
          return
      }
    }

    // 2. Commands
    if (text === '/admin') {
      if (!isAdmin(userId, env.ADMIN_IDS)) {
        await sendMessage(botToken, chatId, t(lang, 'common.no_permission'))
        return
      }
      await handleAdminPanel(db, env.BOT_TOKEN, chatId, undefined, lang)
      return
    }

    if (text === '/huy' || text === '/cancel') {
      const session = getSession(userId)
      if (session && session.flow === 'deposit') {
        // Cancel pending deposit in DB + clear session
        await handleDepositCancel(db, botToken, chatId, userId, undefined)
        return
      }
      if (session) {
        clearSession(userId)
        await sendMessage(botToken, chatId, t(lang, 'common.cancelled'), {
          reply_markup: buildMainMenu(lang),
        })
      } else {
        // Even without session, try to cancel any pending deposit
        await handleDepositCancel(db, botToken, chatId, userId, undefined)
      }
      return
    }

    // 3. Check active session — route input text theo flow context
    const session = getSession(userId)
    if (session && session.flow) {
      await handleSessionInput(db, botToken, chatId, userId, text, session.flow, session.step, env, lang, locale.ctx)
      return
    }

    // 4. Fallback — lệnh không hợp lệ
    await sendMessage(botToken, chatId, t(lang, 'common.invalid_request'), {
      reply_markup: buildMainMenu(lang),
    })
  } catch (error) {
    const { shouldNotifyUser } = handleBotError(error, {
      userId,
      command: text,
      operation: 'handleTextMessage',
    })

    if (shouldNotifyUser) {
      try {
        await sendMessage(botToken, chatId, t(lang, 'common.system_error'), {
          reply_markup: buildMainMenu(lang),
        })
      } catch {
        // Silent fail — đã log ở trên
      }
    }
  }
}

// --- Session Input Router ---

/**
 * Route text input dựa trên session flow và step hiện tại.
 * Mỗi flow handler sẽ xử lý validation và next step riêng.
 */
async function handleSessionInput(
  db: D1Database,
  botToken: string,
  chatId: number,
  userId: number,
  text: string,
  flow: string,
  step: string | null,
  env: Bindings,
  lang: Lang,
  ctx: CurrencyContext
): Promise<void> {
  switch (flow) {
    case 'deposit':
      // User nhập số tiền nạp tùy ý
      await handleDepositTextInput(db, botToken, chatId, userId, text, step, env, lang)
      break

    case 'purchase':
      // User nhập số lượng mua tự do
      await handlePurchaseSessionInput(db, botToken, chatId, userId, text, step, lang, ctx)
      break

    case 'admin_add_type':
    case 'admin_edit_type':
    case 'admin_add_product':
      // Admin multi-step flows
      await handleAdminTextInput(db, botToken, chatId, userId, text, flow, step, env, lang)
      break

    default:
      // Flow không xác định → clear session, fallback menu
      clearSession(userId)
      await sendMessage(botToken, chatId, t(lang, 'common.session_expired'), {
        reply_markup: buildMainMenu(lang),
      })
      break
  }
}

// --- Session text input handlers ---

async function handlePurchaseSessionInput(
  db: D1Database,
  botToken: string,
  chatId: number,
  userId: number,
  text: string,
  step: string | null,
  lang: Lang,
  ctx: CurrencyContext
): Promise<void> {
  if (step === 'quantity') {
    const session = getSession(userId)
    const categoryId = session?.data?.categoryId
    if (!categoryId) {
      clearSession(userId)
      await sendMessage(botToken, chatId, t(lang, 'common.session_expired'), {
        reply_markup: buildMainMenu(lang),
      })
      return
    }
    await handlePurchaseTextInput(db, botToken, chatId, userId, text, categoryId, lang, ctx)
  } else {
    clearSession(userId)
    await sendMessage(botToken, chatId, t(lang, 'common.session_expired'), {
      reply_markup: buildMainMenu(lang),
    })
  }
}

async function handleDepositTextInput(
  db: D1Database,
  botToken: string,
  chatId: number,
  userId: number,
  text: string,
  step: string | null,
  env: Bindings,
  lang: Lang
): Promise<void> {
  if (step === 'amount') {
    // Parse amount from text input
    const amount = parseInt(text.replace(/[.,\s]/g, ''), 10)
    if (isNaN(amount)) {
      await sendMessage(botToken, chatId, t(lang, 'deposit.amount.invalid'), {
        parse_mode: 'HTML',
      })
      return
    }
    await handleDepositAmount(db, botToken, chatId, userId, amount, env)
  } else if (step === 'crypto_amount') {
    // Nhập số USDT (cho phép thập phân) → tạo invoice Crypto Pay.
    const usdt = Number(text.replace(/\s/g, '').replace(',', '.'))
    if (!Number.isFinite(usdt) || usdt <= 0) {
      await sendMessage(botToken, chatId, t(lang, 'deposit.crypto.invalid'), {
        parse_mode: 'HTML',
      })
      return
    }
    await handleCryptoDepositAmount(db, botToken, chatId, userId, usdt, env)
  } else {
    clearSession(userId)
    await sendMessage(botToken, chatId, t(lang, 'common.session_expired'), {
      reply_markup: buildMainMenu(lang),
    })
  }
}

async function handleAdminTextInput(
  db: D1Database,
  botToken: string,
  chatId: number,
  userId: number,
  text: string,
  flow: string,
  step: string | null,
  env: Bindings,
  lang: Lang
): Promise<void> {
  if (!isAdmin(userId, env.ADMIN_IDS)) {
    clearSession(userId)
    await sendMessage(botToken, chatId, t(lang, 'common.no_permission'))
    return
  }
  await handleAdminTextInputRouted(db, botToken, chatId, userId, text, flow, step, lang)
}
