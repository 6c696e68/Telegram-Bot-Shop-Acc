/**
 * Purchase flow handlers — flow mua tài khoản.
 * Nội dung + định dạng tiền theo Language của user (R4.1, R4.6).
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 4.1, 4.6, 7.5, 7.6, 7.7
 */

import type { InlineKeyboardButton } from '../../types/telegram'
import {
  editOrSendMessage,
  sendMessage,
  buildInlineKeyboard,
  buildBackButton,
} from '../telegram-api'
import { formatMoneyFor, buildCurrencyContext, type CurrencyContext } from '../../utils/format'
import { transactionService } from '../../services/transaction'
import { escapeHtml, renderSuccessMessage } from '../../utils/telegram-template'
import { loadProductTemplates } from '../../services/product-template'
import { resolveLang } from '../../services/user-locale'
import { t, BASE_FALLBACK_LANG, type Lang } from '../i18n'
import { type Region } from '../../i18n/locales'
import { setSession } from '../session'
import {
  buildDisplayPlaceholder,
  isValidText,
  loadDisplayLang,
  loadProductTranslations,
  loadProductTypeTranslations,
  resolveDisplayText,
  type EntityTranslations,
  type Field,
} from '../../services/i18n-catalog'
import {
  consumeToken,
  shouldSendNotice,
  retryAfterSeconds,
  PURCHASE_RULE,
} from '../rate-limit'

const PAGE_SIZE = 5
const MAX_QTY = 50

// --- Interfaces ---

interface CategoryRow {
  id: number
  name: string
  description: string | null
  content: string | null
  emoji: string | null
  product_count: number
  stock: number
}

interface ProductRow {
  id: number
  product_type_id: number
  name: string
  description: string | null
  content: string | null
  price: number
  emoji: string | null
  category_name: string
  category_emoji: string | null
  stock: number
}

function withEmoji(emoji: string | null, text: string): string {
  const trimmed = typeof emoji === 'string' ? emoji.trim() : ''
  return trimmed ? `${trimmed} ${text}` : text
}

async function resolveCategoryName(db: D1Database, row: Pick<CategoryRow, 'id' | 'name'>, lang: Lang): Promise<string> {
  const [defaultLang, translations] = await Promise.all([
    loadDisplayLang(db),
    loadProductTypeTranslations(db, row.id),
  ])
  return resolveDisplayText(translations, 'name', row.name, lang, defaultLang, buildDisplayPlaceholder(row.id))
}

async function resolveProductName(db: D1Database, row: Pick<ProductRow, 'id' | 'name'>, lang: Lang): Promise<string> {
  const [defaultLang, translations] = await Promise.all([
    loadDisplayLang(db),
    loadProductTranslations(db, row.id),
  ])
  return resolveDisplayText(translations, 'name', row.name, lang, defaultLang, buildDisplayPlaceholder(row.id))
}

function resolveOptionalDisplayText(
  translations: EntityTranslations,
  field: Field,
  baseValue: string | null,
  displayLang: Lang,
  defaultLang: Lang
): string | null {
  for (const candidateLang of [displayLang, defaultLang, BASE_FALLBACK_LANG]) {
    const value = translations.byLang.get(candidateLang)?.[field]
    if (isValidText(value)) return value.trim()
  }
  return isValidText(baseValue) ? baseValue.trim() : null
}

async function loadVisibleProduct(db: D1Database, productId: number): Promise<ProductRow | null> {
  return db
    .prepare(
      `SELECT p.id, p.product_type_id, p.name, p.description, p.content, p.price, p.emoji,
              pt.name AS category_name,
              pt.emoji AS category_emoji,
              COUNT(CASE WHEN pi.status = 'available' THEN 1 END) AS stock
       FROM products p
       JOIN product_types pt ON pt.id = p.product_type_id
       LEFT JOIN product_items pi ON pi.product_id = p.id
       WHERE p.id = ? AND p.is_visible = 1 AND pt.is_visible = 1
       GROUP BY p.id`
    )
    .bind(productId)
    .first<ProductRow>()
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
  // Query danh mục hiển thị; không lọc tồn kho để danh mục rỗng vẫn có trạng thái rõ ràng.
  const result = await db
    .prepare(
      `SELECT pt.id, pt.name, pt.description, pt.content, pt.emoji,
              COUNT(DISTINCT p.id) AS product_count,
              COUNT(CASE WHEN pi.status = 'available' THEN 1 END) AS stock
       FROM product_types pt
       LEFT JOIN products p ON p.product_type_id = pt.id AND p.is_visible = 1
       LEFT JOIN product_items pi ON pi.product_id = p.id
       WHERE pt.is_visible = 1
       GROUP BY pt.id
       ORDER BY pt.sort_order ASC, pt.name ASC`
    )
    .all<CategoryRow>()

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
  const buttons: InlineKeyboardButton[][] = await Promise.all(
    pageItems.map(async (cat) => {
      const name = await resolveCategoryName(db, cat, lang)
      return [
        {
          text: `${withEmoji(cat.emoji, name)} (${cat.product_count})`,
          callback_data: `cat:${cat.id}`,
        },
      ]
    })
  )

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

// --- 2. Product List In Category ---

/**
 * Hiển thị danh sách Product thuộc một Product_Type.
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
  // Query category info
  const category = await db
    .prepare('SELECT id, name, description, content, emoji, 0 AS product_count, 0 AS stock FROM product_types WHERE id = ? AND is_visible = 1')
    .bind(categoryId)
    .first<CategoryRow>()

  if (!category) {
    await editOrSendMessage(botToken, chatId, messageId, t(lang, 'shop.not_found'), {
      reply_markup: buildInlineKeyboard([buildBackButton('cat:list', lang)]),
    })
    return
  }

  const categoryName = await resolveCategoryName(db, category, lang)
  const result = await db
    .prepare(
      `SELECT p.id, p.product_type_id, p.name, p.description, p.content, p.price, p.emoji,
              pt.name AS category_name,
              pt.emoji AS category_emoji,
              COUNT(CASE WHEN pi.status = 'available' THEN 1 END) AS stock
       FROM products p
       JOIN product_types pt ON pt.id = p.product_type_id
       LEFT JOIN product_items pi ON pi.product_id = p.id
       WHERE p.product_type_id = ? AND p.is_visible = 1 AND pt.is_visible = 1
       GROUP BY p.id
       ORDER BY p.sort_order ASC, p.name ASC`
    )
    .bind(categoryId)
    .all<ProductRow>()

  if (result.results.length === 0) {
    await editOrSendMessage(
      botToken,
      chatId,
      messageId,
      `${escapeHtml(withEmoji(category.emoji, categoryName))}\n\n${t(lang, 'shop.empty')}`,
      {
        parse_mode: 'HTML',
        reply_markup: buildInlineKeyboard([buildBackButton('cat:list', lang)]),
      }
    )
    return
  }

  const buttons: InlineKeyboardButton[][] = await Promise.all(
    result.results.map(async (product) => {
      const name = await resolveProductName(db, product, lang)
      return [
        {
          text: t(lang, 'shop.item_label', {
            emoji: product.emoji ?? product.category_emoji ?? '',
            name,
            price: formatMoneyFor(product.price, ctx),
            stock: product.stock,
          }),
          callback_data: `prod:${product.id}`,
        },
      ]
    })
  )
  buttons.push(buildBackButton('cat:list', lang))

  const text = [
    `<b>${escapeHtml(withEmoji(category.emoji, categoryName))}</b>`,
    '',
    t(lang, 'shop.list_header', { page: 1, total: 1 }),
  ].join('\n')

  await editOrSendMessage(botToken, chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: buildInlineKeyboard(buttons),
  })
}

// --- 3. Product Detail ---

/**
 * Hiển thị chi tiết Product + grid số lượng 1-10 (5×2).
 * Callback: `prod:{id}`
 */
export async function handleProductDetail(
  db: D1Database,
  botToken: string,
  chatId: number,
  messageId: number | undefined,
  productId: number,
  userId: number,
  lang: Lang,
  ctx: CurrencyContext
): Promise<void> {
  const product = await loadVisibleProduct(db, productId)

  if (!product) {
    await editOrSendMessage(botToken, chatId, messageId, t(lang, 'shop.not_found'), {
      reply_markup: buildInlineKeyboard([buildBackButton('cat:list', lang)]),
    })
    return
  }

  const [defaultLang, translations] = await Promise.all([
    loadDisplayLang(db),
    loadProductTranslations(db, product.id),
  ])
  const productName = resolveDisplayText(
    translations,
    'name',
    product.name,
    lang,
    defaultLang,
    buildDisplayPlaceholder(product.id)
  )
  const productDescription = resolveOptionalDisplayText(translations, 'description', product.description, lang, defaultLang)
  const displayEmoji = product.emoji ?? product.category_emoji

  if (product.stock === 0) {
    await editOrSendMessage(
      botToken,
      chatId,
      messageId,
      `<b>${escapeHtml(withEmoji(displayEmoji, productName))}</b>\n\n${t(lang, 'shop.out_of_stock')}`,
      {
        parse_mode: 'HTML',
        reply_markup: buildInlineKeyboard([buildBackButton(`cat:${product.product_type_id}`, lang)]),
      }
    )
    return
  }

  // Set session for free-text quantity input
  setSession(userId, 'purchase', 'quantity', { productId })

  // Build info text
  const description = productDescription ? `${escapeHtml(productDescription)}\n` : ''
  const text = [
    `<b>${escapeHtml(withEmoji(displayEmoji, productName))}</b>`,
    '',
    description,
    t(lang, 'shop.detail_price', { price: formatMoneyFor(product.price, ctx) }),
    t(lang, 'shop.detail_stock', { stock: product.stock }),
    '',
    t(lang, 'shop.detail_choose_qty'),
    t(lang, 'shop.detail_qty_hint', { max: Math.min(MAX_QTY, product.stock) }),
  ].join('\n')

  // Build qty grid 5×2 (rows of 5)
  const maxGrid = Math.min(10, product.stock)
  const qtyButtons: InlineKeyboardButton[][] = []
  for (let i = 1; i <= maxGrid; i += 5) {
    const row: InlineKeyboardButton[] = []
    for (let j = i; j < i + 5 && j <= maxGrid; j++) {
      row.push({ text: String(j), callback_data: `qty:${product.id}:${j}` })
    }
    qtyButtons.push(row)
  }

  // Back button
  qtyButtons.push(buildBackButton(`cat:${product.product_type_id}`, lang))

  await editOrSendMessage(botToken, chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: buildInlineKeyboard(qtyButtons),
  })
}

// --- 3. Quantity Select (Confirmation) ---

/**
 * Hiển thị xác nhận: tổng tiền + nút xác nhận mua.
 * Callback: `qty:{productId}:{qty}`
 */
export async function handleQuantitySelect(
  db: D1Database,
  botToken: string,
  chatId: number,
  messageId: number | undefined,
  productId: number,
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
          reply_markup: buildInlineKeyboard([buildBackButton(`prod:${productId}`, lang)]),
        }
      )
    return
  }

  // Query product price + available stock
  const product = await loadVisibleProduct(db, productId)

  if (!product) {
    await editOrSendMessage(botToken, chatId, messageId, t(lang, 'shop.type_not_found'), {
      reply_markup: buildInlineKeyboard([buildBackButton('cat:list', lang)]),
    })
    return
  }

  const productName = await resolveProductName(db, product, lang)
  const displayEmoji = product.emoji ?? product.category_emoji

  // Check stock >= quantity
  if (product.stock < quantity) {
    const buttons: InlineKeyboardButton[][] = []
    if (product.stock > 0) {
      buttons.push([
        {
          text: t(lang, 'shop.buy_remaining', { stock: product.stock }),
          callback_data: `qty:${product.id}:${product.stock}`,
        },
      ])
    }
    buttons.push(buildBackButton(`prod:${product.id}`, lang))

    await editOrSendMessage(
      botToken,
      chatId,
      messageId,
      t(lang, 'shop.stock_short', { stock: product.stock, qty: quantity }),
      {
        parse_mode: 'HTML',
        reply_markup: buildInlineKeyboard(buttons),
      }
    )
    return
  }

  // Show confirmation
  const totalAmount = product.price * quantity
  const text = [
    t(lang, 'shop.confirm_title'),
    '',
    escapeHtml(withEmoji(displayEmoji, productName)),
    t(lang, 'shop.confirm_qty', { qty: quantity }),
    t(lang, 'shop.confirm_unit', { price: formatMoneyFor(product.price, ctx) }),
    t(lang, 'shop.confirm_total', { total: formatMoneyFor(totalAmount, ctx) }),
    '',
    t(lang, 'shop.confirm_hint'),
  ].join('\n')

  const buttons = [
    [{ text: t(lang, 'shop.confirm_btn'), callback_data: `buy:${product.id}:${quantity}` }],
    buildBackButton(`prod:${product.id}`, lang),
  ]

  await editOrSendMessage(botToken, chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: buildInlineKeyboard(buttons),
  })
}

// --- 4. Purchase Confirm ---

/**
 * Thực hiện mua hàng: gọi TransactionService.executePurchase → gửi product contents.
 * Callback: `buy:{productId}:{qty}`
 */
export async function handlePurchaseConfirm(
  db: D1Database,
  botToken: string,
  chatId: number,
  messageId: number | undefined,
  productId: number,
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

  // Query product for unitPrice
  const product = await loadVisibleProduct(db, productId)

  if (!product) {
    await editOrSendMessage(botToken, chatId, messageId, t(lang, 'shop.type_not_found'), {
      reply_markup: buildInlineKeyboard([buildBackButton('cat:list', lang)]),
    })
    return
  }

  const productName = await resolveProductName(db, product, lang)
  const displayEmoji = product.emoji ?? product.category_emoji
  const totalAmount = product.price * quantity

  // Execute purchase
  const result = await transactionService.executePurchase(
    db,
    user.id,
    product.id,
    quantity,
    product.price
  )

  if (result.success === false) {
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
        buildBackButton(`prod:${product.id}`, lang),
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
          `SELECT COUNT(*) as stock FROM product_items WHERE product_id = ? AND status = 'available'`
        )
        .bind(product.id)
        .first<{ stock: number }>()

      const remaining = stockResult?.stock ?? 0

      const buttons: InlineKeyboardButton[][] = []
      if (remaining > 0) {
        buttons.push([
          {
            text: t(lang, 'shop.buy_remaining', { stock: remaining }),
            callback_data: `qty:${product.id}:${remaining}`,
          },
        ])
      }
      buttons.push(buildBackButton(`prod:${product.id}`, lang))

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
  const productItems = result.productItems ?? []
  const balanceAfter = result.balanceAfter ?? user.balance - totalAmount

  // Render tin nhắn thành công theo template đa ngôn ngữ của Product (R16.5)
  const templatesByLang = await loadProductTemplates(db, product.id)
  const successLang = await resolveLang(db, user)
  const defaultLang = await loadDisplayLang(db)
  const successCtx = await buildCurrencyContext(db, { lang: successLang, region: user.region })
  const contentText = renderSuccessMessage(
    templatesByLang,
    {
      emoji: displayEmoji ?? '',
      name: productName,
      quantity,
      totalAmount,
      balanceAfter,
      contents: productItems.map((p) => p.content),
    },
    successCtx,
    defaultLang
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
  productId: number,
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
  await handleQuantitySelect(db, botToken, chatId, undefined, productId, qty, userId, lang, ctx)
}
