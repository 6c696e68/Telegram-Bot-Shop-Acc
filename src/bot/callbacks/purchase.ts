/**
 * Purchase flow handlers — flow mua tài khoản.
 * Nội dung + định dạng tiền theo Language của user (R4.1, R4.6).
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 4.1, 4.6, 7.5, 7.6, 7.7
 */

import type { DbProductType } from '../../types/db'
import type { InlineKeyboardButton } from '../../types/telegram'
import {
  editOrSendMessage,
  sendMessage,
  buildInlineKeyboard,
  buildBackButton,
} from '../telegram-api'
import { formatMoneyFor, buildCurrencyContext, type CurrencyContext } from '../../utils/format'
import { transactionService } from '../../services/transaction'
import { renderSuccessMessage } from '../../utils/telegram-template'
import { loadProductTypeTemplates } from '../../services/product-template'
import { resolveLang } from '../../services/user-locale'
import { t, type Lang } from '../i18n'
import { type Region } from '../../i18n/locales'
import { setSession } from '../session'
import {
  consumeToken,
  shouldSendNotice,
  retryAfterSeconds,
  PURCHASE_RULE,
} from '../rate-limit'

const PAGE_SIZE = 5
const MAX_QTY = 50

// --- Interfaces ---

interface CategoryWithStock {
  id: number
  name: string
  price: number
  emoji: string
  stock: number
}

// --- 1. Category List ---

/**
 * Hiển thị danh sách categories có product available, phân trang 5 items/page.
 * Callback: `cat:list` hoặc `page:cat:{pageNum}`
 */
export async function handleCategoryList(
  db: D1Database,
  botToken: string,
  chatId: number,
  messageId: number | undefined,
  lang: Lang,
  ctx: CurrencyContext,
  page = 0
): Promise<void> {
  // Query categories có stock > 0
  const result = await db
    .prepare(
      `SELECT pt.id, pt.name, pt.price, pt.emoji,
              COUNT(p.id) as stock
       FROM product_types pt
       INNER JOIN products p ON p.type_id = pt.id AND p.status = 'available'
       WHERE pt.is_visible = 1
       GROUP BY pt.id
       HAVING stock > 0
       ORDER BY pt.sort_order ASC, pt.name ASC`
    )
    .all<CategoryWithStock>()

  const categories = result.results

  if (categories.length === 0) {
    await editOrSendMessage(botToken, chatId, messageId, t(lang, 'shop.empty'), {
      parse_mode: 'HTML',
      reply_markup: buildInlineKeyboard([buildBackButton('menu:main', lang)]),
    })
    return
  }

  // Paginate
  const totalPages = Math.ceil(categories.length / PAGE_SIZE)
  const safePage = Math.max(0, Math.min(page, totalPages - 1))
  const pageItems = categories.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  // Build category buttons (1 per row)
  const buttons: InlineKeyboardButton[][] = pageItems.map((cat) => [
    {
      text: t(lang, 'shop.item_label', {
        emoji: cat.emoji,
        name: cat.name,
        price: formatMoneyFor(cat.price, ctx),
        stock: cat.stock,
      }),
      callback_data: `cat:${cat.id}`,
    },
  ])

  // Pagination nav buttons
  const navRow: InlineKeyboardButton[] = []
  if (safePage > 0) {
    navRow.push({ text: t(lang, 'shop.prev'), callback_data: `page:cat:${safePage - 1}` })
  }
  if (safePage < totalPages - 1) {
    navRow.push({ text: t(lang, 'shop.next'), callback_data: `page:cat:${safePage + 1}` })
  }
  if (navRow.length > 0) {
    buttons.push(navRow)
  }

  // Back button
  buttons.push(buildBackButton('menu:main', lang))

  const text = [
    t(lang, 'shop.title'),
    '',
    t(lang, 'shop.list_header', { page: safePage + 1, total: totalPages }),
  ].join('\n')

  await editOrSendMessage(botToken, chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: buildInlineKeyboard(buttons),
  })
}

// --- 2. Category Detail ---

/**
 * Hiển thị chi tiết category + grid số lượng 1-10 (5×2).
 * Callback: `cat:{id}`
 */
export async function handleCategoryDetail(
  db: D1Database,
  botToken: string,
  chatId: number,
  messageId: number | undefined,
  categoryId: number,
  userId: number,
  lang: Lang,
  ctx: CurrencyContext
): Promise<void> {
  // Query category info + stock count
  const category = await db
    .prepare('SELECT * FROM product_types WHERE id = ?')
    .bind(categoryId)
    .first<DbProductType>()

  if (!category) {
    await editOrSendMessage(botToken, chatId, messageId, t(lang, 'shop.not_found'), {
      reply_markup: buildInlineKeyboard([buildBackButton('cat:list', lang)]),
    })
    return
  }

  const stockResult = await db
    .prepare(
      `SELECT COUNT(*) as stock FROM products WHERE type_id = ? AND status = 'available'`
    )
    .bind(categoryId)
    .first<{ stock: number }>()

  const stock = stockResult?.stock ?? 0

  if (stock === 0) {
    await editOrSendMessage(
      botToken,
      chatId,
      messageId,
      `${category.emoji} <b>${category.name}</b>\n\n${t(lang, 'shop.out_of_stock')}`,
      {
        parse_mode: 'HTML',
        reply_markup: buildInlineKeyboard([buildBackButton('cat:list', lang)]),
      }
    )
    return
  }

  // Set session for free-text quantity input
  setSession(userId, 'purchase', 'quantity', { categoryId })

  // Build info text
  const description = category.description ? `📝 ${category.description}\n` : ''
  const text = [
    `${category.emoji} <b>${category.name}</b>`,
    '',
    description,
    t(lang, 'shop.detail_price', { price: formatMoneyFor(category.price, ctx) }),
    t(lang, 'shop.detail_stock', { stock }),
    '',
    t(lang, 'shop.detail_choose_qty'),
    t(lang, 'shop.detail_qty_hint', { max: Math.min(MAX_QTY, stock) }),
  ].join('\n')

  // Build qty grid 5×2 (rows of 5)
  const maxGrid = Math.min(10, stock)
  const qtyButtons: InlineKeyboardButton[][] = []
  for (let i = 1; i <= maxGrid; i += 5) {
    const row: InlineKeyboardButton[] = []
    for (let j = i; j < i + 5 && j <= maxGrid; j++) {
      row.push({ text: String(j), callback_data: `qty:${categoryId}:${j}` })
    }
    qtyButtons.push(row)
  }

  // Back button
  qtyButtons.push(buildBackButton('cat:list', lang))

  await editOrSendMessage(botToken, chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: buildInlineKeyboard(qtyButtons),
  })
}

// --- 3. Quantity Select (Confirmation) ---

/**
 * Hiển thị xác nhận: tổng tiền + nút xác nhận mua.
 * Callback: `qty:{catId}:{qty}`
 */
export async function handleQuantitySelect(
  db: D1Database,
  botToken: string,
  chatId: number,
  messageId: number | undefined,
  categoryId: number,
  quantity: number,
  userId: number,
  lang: Lang,
  ctx: CurrencyContext
): Promise<void> {
  // Validate quantity
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_QTY) {
    await editOrSendMessage(
      botToken,
      chatId,
      messageId,
      t(lang, 'shop.qty_invalid', { max: MAX_QTY }),
      {
        reply_markup: buildInlineKeyboard([buildBackButton(`cat:${categoryId}`, lang)]),
      }
    )
    return
  }

  // Query category price + available stock
  const category = await db
    .prepare('SELECT * FROM product_types WHERE id = ?')
    .bind(categoryId)
    .first<DbProductType>()

  if (!category) {
    await editOrSendMessage(botToken, chatId, messageId, t(lang, 'shop.type_not_found'), {
      reply_markup: buildInlineKeyboard([buildBackButton('cat:list', lang)]),
    })
    return
  }

  const stockResult = await db
    .prepare(
      `SELECT COUNT(*) as stock FROM products WHERE type_id = ? AND status = 'available'`
    )
    .bind(categoryId)
    .first<{ stock: number }>()

  const stock = stockResult?.stock ?? 0

  // Check stock >= quantity
  if (stock < quantity) {
    const buttons: InlineKeyboardButton[][] = []
    if (stock > 0) {
      buttons.push([
        {
          text: t(lang, 'shop.buy_remaining', { stock }),
          callback_data: `qty:${categoryId}:${stock}`,
        },
      ])
    }
    buttons.push(buildBackButton(`cat:${categoryId}`, lang))

    await editOrSendMessage(
      botToken,
      chatId,
      messageId,
      t(lang, 'shop.stock_short', { stock, qty: quantity }),
      {
        parse_mode: 'HTML',
        reply_markup: buildInlineKeyboard(buttons),
      }
    )
    return
  }

  // Show confirmation
  const totalAmount = category.price * quantity
  const text = [
    t(lang, 'shop.confirm_title'),
    '',
    `${category.emoji} ${category.name}`,
    t(lang, 'shop.confirm_qty', { qty: quantity }),
    t(lang, 'shop.confirm_unit', { price: formatMoneyFor(category.price, ctx) }),
    t(lang, 'shop.confirm_total', { total: formatMoneyFor(totalAmount, ctx) }),
    '',
    t(lang, 'shop.confirm_hint'),
  ].join('\n')

  const buttons = [
    [{ text: t(lang, 'shop.confirm_btn'), callback_data: `buy:${categoryId}:${quantity}` }],
    buildBackButton(`cat:${categoryId}`, lang),
  ]

  await editOrSendMessage(botToken, chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: buildInlineKeyboard(buttons),
  })
}

// --- 4. Purchase Confirm ---

/**
 * Thực hiện mua hàng: gọi TransactionService.executePurchase → gửi product contents.
 * Callback: `buy:{catId}:{qty}`
 */
export async function handlePurchaseConfirm(
  db: D1Database,
  botToken: string,
  chatId: number,
  messageId: number | undefined,
  categoryId: number,
  quantity: number,
  userId: number,
  lang: Lang,
  ctx: CurrencyContext
): Promise<void> {
  // Cooldown chặt cho thao tác đắt + nhạy cảm tài chính: chặn double-tap "Xác nhận mua".
  const verdict = consumeToken(`buy:${userId}`, PURCHASE_RULE)
  if (!verdict.allowed) {
    if (shouldSendNotice(`buy:${userId}`)) {
      await sendMessage(
        botToken,
        chatId,
        t(lang, 'shop.cooldown', { sec: retryAfterSeconds(verdict.retryAfterMs) }),
        { parse_mode: 'HTML' }
      )
    }
    return
  }

  // Query user by telegram_id to get internal user.id
  const user = await db
    .prepare('SELECT id, balance, language, region FROM users WHERE telegram_id = ?')
    .bind(userId)
    .first<{ id: number; balance: number; language: string | null; region: Region | null }>()

  if (!user) {
    await editOrSendMessage(
      botToken,
      chatId,
      messageId,
      t(lang, 'deposit.account_not_found'),
      {
        reply_markup: buildInlineKeyboard([buildBackButton('menu:main', lang)]),
      }
    )
    return
  }

  // Query category for unitPrice
  const category = await db
    .prepare('SELECT * FROM product_types WHERE id = ?')
    .bind(categoryId)
    .first<DbProductType>()

  if (!category) {
    await editOrSendMessage(botToken, chatId, messageId, t(lang, 'shop.type_not_found'), {
      reply_markup: buildInlineKeyboard([buildBackButton('cat:list', lang)]),
    })
    return
  }

  const totalAmount = category.price * quantity

  // Execute purchase
  const result = await transactionService.executePurchase(
    db,
    user.id,
    categoryId,
    quantity,
    category.price
  )

  if (!result.success) {
    if (result.error === 'insufficient_balance') {
      const shortfall = totalAmount - user.balance
      const text = [
        t(lang, 'shop.insufficient_title'),
        '',
        t(lang, 'shop.insufficient_balance', { balance: formatMoneyFor(user.balance, ctx) }),
        t(lang, 'shop.insufficient_need', { total: formatMoneyFor(totalAmount, ctx) }),
        t(lang, 'shop.insufficient_topup', { shortfall: formatMoneyFor(shortfall, ctx) }),
      ].join('\n')

      const buttons = [
        [{ text: t(lang, 'menu.deposit'), callback_data: 'dep:menu' }],
        buildBackButton(`cat:${categoryId}`, lang),
      ]

      await editOrSendMessage(botToken, chatId, messageId, text, {
        parse_mode: 'HTML',
        reply_markup: buildInlineKeyboard(buttons),
      })
      return
    }

    if (result.error === 'insufficient_stock') {
      // Check actual remaining stock
      const stockResult = await db
        .prepare(
          `SELECT COUNT(*) as stock FROM products WHERE type_id = ? AND status = 'available'`
        )
        .bind(categoryId)
        .first<{ stock: number }>()

      const remaining = stockResult?.stock ?? 0

      const buttons: InlineKeyboardButton[][] = []
      if (remaining > 0) {
        buttons.push([
          {
            text: t(lang, 'shop.buy_remaining', { stock: remaining }),
            callback_data: `qty:${categoryId}:${remaining}`,
          },
        ])
      }
      buttons.push(buildBackButton(`cat:${categoryId}`, lang))

      await editOrSendMessage(
        botToken,
        chatId,
        messageId,
        t(lang, 'shop.stock_short2', { stock: remaining }),
        {
          parse_mode: 'HTML',
          reply_markup: buildInlineKeyboard(buttons),
        }
      )
      return
    }

    // db_error or unknown
    await editOrSendMessage(botToken, chatId, messageId, t(lang, 'shop.tx_error'), {
      reply_markup: buildInlineKeyboard([buildBackButton('menu:main', lang)]),
    })
    return
  }

  // --- Success: send product contents ---
  const products = result.products ?? []
  const balanceAfter = user.balance - totalAmount

  // Render tin nhắn thành công theo template đa ngôn ngữ của category (R16.5)
  const templatesByLang = await loadProductTypeTemplates(db, category.id)
  const successLang = await resolveLang(db, user)
  const successCtx = await buildCurrencyContext(db, { lang: successLang, region: user.region })
  const contentText = renderSuccessMessage(
    templatesByLang,
    {
      emoji: category.emoji,
      name: category.name,
      quantity,
      totalAmount,
      balanceAfter,
      contents: products.map((p) => p.content),
    },
    successCtx
  )

  const successButtons = [
    [
      { text: t(successLang, 'shop.buy_more'), callback_data: 'cat:list' },
      { text: t(successLang, 'common.back'), callback_data: 'menu:main' },
    ],
  ]

  await editOrSendMessage(botToken, chatId, messageId, contentText, {
    parse_mode: 'HTML',
    reply_markup: buildInlineKeyboard(successButtons),
  })
}

// --- 5. Handle text input for quantity ---

/**
 * Xử lý nhập số lượng tự do qua text message.
 * Gọi từ router khi session flow='purchase' và step='quantity'.
 */
export async function handlePurchaseTextInput(
  db: D1Database,
  botToken: string,
  chatId: number,
  userId: number,
  text: string,
  categoryId: number,
  lang: Lang,
  ctx: CurrencyContext
): Promise<void> {
  const qty = parseInt(text, 10)

  // Validate: integer, 1-50
  if (isNaN(qty) || !Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY) {
    await sendMessage(botToken, chatId, t(lang, 'shop.qty_invalid_input', { max: MAX_QTY }))
    return
  }

  // Delegate to quantity select handler (confirmation screen)
  await handleQuantitySelect(db, botToken, chatId, undefined, categoryId, qty, userId, lang, ctx)
}
