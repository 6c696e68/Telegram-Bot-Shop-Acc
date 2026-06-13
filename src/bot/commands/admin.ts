/**
 * Admin Bot Commands — quản lý categories, products, thống kê qua Telegram bot.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
 *
 * i18n (R4.1): mọi chuỗi hiển thị cho user lấy qua `t(lang, 'admin.*')`. Nhãn nút
 * inline đổi text thoải mái vì routing dựa trên `callback_data` (không match text).
 */

import {
  sendMessage,
  editOrSendMessage,
  buildInlineKeyboard,
} from '../telegram-api'
import { getSession, setSession, clearSession } from '../session'
import { formatMoney } from '../../utils/format'
import { t, type Lang } from '../i18n'

// --- Constants ---

const PAGE_SIZE = 20
const MAX_BULK_PRODUCTS = 50
const MAX_CONTENT_LENGTH = 2000

// --- Validation ---

export interface ValidationResult {
  valid: boolean
  error?: string
}

export function validateName(name: string, lang: Lang = 'vi'): ValidationResult {
  const trimmed = name.trim()
  if (!trimmed) return { valid: false, error: t(lang, 'admin.err.name_empty') }
  if (trimmed.length > 100) return { valid: false, error: t(lang, 'admin.err.name_too_long') }
  return { valid: true }
}

export function validateDescription(description: string, lang: Lang = 'vi'): ValidationResult {
  if (description.length > 500) return { valid: false, error: t(lang, 'admin.err.desc_too_long') }
  return { valid: true }
}

export function validatePrice(input: string, lang: Lang = 'vi'): ValidationResult {
  const price = parseInt(input.replace(/[.,\s]/g, ''), 10)
  if (isNaN(price) || !Number.isInteger(price)) {
    return { valid: false, error: t(lang, 'admin.err.price_not_integer') }
  }
  if (price < 1) return { valid: false, error: t(lang, 'admin.err.price_too_low') }
  if (price > 999999999) return { valid: false, error: t(lang, 'admin.err.price_too_high') }
  return { valid: true }
}

export function parsePrice(input: string): number {
  return parseInt(input.replace(/[.,\s]/g, ''), 10)
}

// --- 1. Admin Panel ---

/**
 * Hiển thị bảng điều khiển Admin với inline keyboard.
 */
export async function handleAdminPanel(
  db: D1Database,
  botToken: string,
  chatId: number,
  messageId: number | undefined,
  lang: Lang
): Promise<void> {
  const text = t(lang, 'admin.panel.title')

  const keyboard = buildInlineKeyboard([
    [
      { text: t(lang, 'admin.btn.add_type'), callback_data: 'adm:addtype' },
      { text: t(lang, 'admin.btn.list_types'), callback_data: 'adm:listtypes' },
    ],
    [
      { text: t(lang, 'admin.btn.add_product'), callback_data: 'adm:addproduct' },
      { text: t(lang, 'admin.btn.stats'), callback_data: 'adm:stats' },
    ],
  ])

  await editOrSendMessage(botToken, chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  })
}

// --- 2. Add Type Flow ---

/**
 * Multi-step flow thêm danh mục: tên → mô tả → tạo.
 */
export async function handleAddTypeFlow(
  db: D1Database,
  botToken: string,
  chatId: number,
  userId: number,
  step: string,
  lang: Lang,
  data?: Record<string, any>
): Promise<void> {
  switch (step) {
    case 'start': {
      setSession(userId, 'admin_add_type', 'name', {})
      await sendMessage(botToken, chatId, t(lang, 'admin.addtype.prompt_name'), {
        parse_mode: 'HTML',
      })
      break
    }

    case 'name': {
      const name = data?.input?.trim() ?? ''
      const validation = validateName(name, lang)
      if (!validation.valid) {
        await sendMessage(botToken, chatId, `${validation.error}\n\n${t(lang, 'admin.addtype.retry_name')}`, {
          parse_mode: 'HTML',
        })
        return
      }
      setSession(userId, 'admin_add_type', 'description', { name })
      await sendMessage(botToken, chatId, t(lang, 'admin.addtype.prompt_desc'), {
        parse_mode: 'HTML',
      })
      break
    }

    case 'description': {
      const session = getSession(userId)
      let description = data?.input ?? ''
      if (description.trim() === '.') description = ''

      const validation = validateDescription(description, lang)
      if (!validation.valid) {
        await sendMessage(botToken, chatId, `${validation.error}\n\n${t(lang, 'admin.addtype.retry_desc')}`, {
          parse_mode: 'HTML',
        })
        return
      }

      const name = session?.data?.name ?? ''
      const finalDescription = description.trim()

      // Insert vào DB
      const now = new Date().toISOString()
      await db.prepare(
        'INSERT INTO product_types (name, description, created_at, updated_at) VALUES (?, ?, ?, ?)'
      ).bind(name, finalDescription || null, now, now).run()

      clearSession(userId)

      const confirmText = t(lang, 'admin.addtype.created', {
        name,
        description: finalDescription || t(lang, 'admin.value.none'),
      })

      const keyboard = buildInlineKeyboard([
        [{ text: t(lang, 'admin.btn.panel'), callback_data: 'adm:panel' }],
      ])

      await sendMessage(botToken, chatId, confirmText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      })
      break
    }
  }
}

// --- 3. List Types (paginated) ---

/**
 * Hiển thị danh sách categories, phân trang 20 items.
 */
export async function handleListTypes(
  db: D1Database,
  botToken: string,
  chatId: number,
  messageId: number | undefined,
  page: number,
  lang: Lang
): Promise<void> {
  const offset = page * PAGE_SIZE

  // Count total
  const countResult = await db.prepare('SELECT COUNT(*) as total FROM product_types').first<{ total: number }>()
  const total = countResult?.total ?? 0

  if (total === 0) {
    const keyboard = buildInlineKeyboard([
      [{ text: t(lang, 'admin.btn.panel'), callback_data: 'adm:panel' }],
    ])
    await editOrSendMessage(botToken, chatId, messageId, t(lang, 'admin.listtypes.empty'), {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    })
    return
  }

  // Get categories with product + stock info
  const categories = await db.prepare(`
    SELECT pt.*,
      COUNT(DISTINCT p.id) as stock_total,
      COUNT(CASE WHEN pi.status = 'available' THEN 1 END) as stock_available
    FROM product_types pt
    LEFT JOIN products p ON p.product_type_id = pt.id
    LEFT JOIN product_items pi ON pi.product_id = p.id
    GROUP BY pt.id
    ORDER BY pt.sort_order ASC, pt.id ASC
    LIMIT ? OFFSET ?
  `).bind(PAGE_SIZE, offset).all()

  const totalPages = Math.ceil(total / PAGE_SIZE)

  let text = t(lang, 'admin.listtypes.title', { page: page + 1, total: totalPages })

  const buttons: Array<Array<{ text: string; callback_data: string }>> = []

  for (const cat of categories.results) {
    const c = cat as any
    text += t(lang, 'admin.listtypes.item', {
      emoji: c.emoji || '',
      name: c.name,
      available: c.stock_available,
      total: c.stock_total,
    })

    buttons.push([
      { text: t(lang, 'admin.btn.edit', { name: c.name }), callback_data: `adm:edit:${c.id}` },
      { text: t(lang, 'admin.btn.delete'), callback_data: `adm:del:${c.id}` },
    ])
  }

  // Pagination buttons
  const navButtons: Array<{ text: string; callback_data: string }> = []
  if (page > 0) {
    navButtons.push({ text: t(lang, 'admin.btn.prev'), callback_data: `adm:listtypes:${page - 1}` })
  }
  if (page < totalPages - 1) {
    navButtons.push({ text: t(lang, 'admin.btn.next'), callback_data: `adm:listtypes:${page + 1}` })
  }
  if (navButtons.length > 0) {
    buttons.push(navButtons)
  }

  buttons.push([{ text: t(lang, 'admin.btn.panel'), callback_data: 'adm:panel' }])

  const keyboard = buildInlineKeyboard(buttons)

  await editOrSendMessage(botToken, chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  })
}

// --- 4. Edit Type Flow ---

/**
 * Multi-step flow sửa loại sản phẩm.
 */
export async function handleEditType(
  db: D1Database,
  botToken: string,
  chatId: number,
  userId: number,
  typeId: number,
  step: string,
  lang: Lang,
  value?: string
): Promise<void> {
  switch (step) {
    case 'start': {
      const category = await db.prepare('SELECT * FROM product_types WHERE id = ?').bind(typeId).first()
      if (!category) {
        await sendMessage(botToken, chatId, t(lang, 'admin.type_not_found'))
        return
      }

      const c = category as any
      setSession(userId, 'admin_edit_type', 'name', { typeId, name: c.name, description: c.description ?? '' })

      const text = t(lang, 'admin.edittype.start', {
        name: c.name,
        description: c.description || t(lang, 'admin.value.none'),
      })

      await sendMessage(botToken, chatId, text, { parse_mode: 'HTML' })
      break
    }

    case 'name': {
      const session = getSession(userId)
      if (!session) return

      const input = value?.trim() ?? ''
      if (input !== '.') {
        const validation = validateName(input, lang)
        if (!validation.valid) {
          await sendMessage(botToken, chatId, `${validation.error}\n\n${t(lang, 'admin.edittype.retry_name')}`, {
            parse_mode: 'HTML',
          })
          return
        }
        session.data.name = input
      }

      setSession(userId, 'admin_edit_type', 'description', session.data)
      await sendMessage(botToken, chatId, t(lang, 'admin.edittype.prompt_desc'), {
        parse_mode: 'HTML',
      })
      break
    }

    case 'description': {
      const session = getSession(userId)
      if (!session) return

      const input = value ?? ''
      if (input.trim() === '-') {
        session.data.description = ''
      } else if (input.trim() !== '.') {
        const validation = validateDescription(input, lang)
        if (!validation.valid) {
          await sendMessage(botToken, chatId, `${validation.error}\n\n${t(lang, 'admin.edittype.retry_desc')}`, {
            parse_mode: 'HTML',
          })
          return
        }
        session.data.description = input.trim()
      }

      // Update DB
      const { typeId: id, name, description } = session.data
      const now = new Date().toISOString()
      await db.prepare(
        'UPDATE product_types SET name = ?, description = ?, updated_at = ? WHERE id = ?'
      ).bind(name, description || null, now, id).run()

      clearSession(userId)

      const confirmText = t(lang, 'admin.edittype.updated', {
        name,
        description: description || t(lang, 'admin.value.none'),
      })

      const keyboard = buildInlineKeyboard([
        [{ text: t(lang, 'admin.btn.list_types'), callback_data: 'adm:listtypes' }],
        [{ text: t(lang, 'admin.btn.panel'), callback_data: 'adm:panel' }],
      ])

      await sendMessage(botToken, chatId, confirmText, {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      })
      break
    }
  }
}

// --- 5. Delete Type ---

/**
 * Xoá loại sản phẩm — check available products, xác nhận.
 */
export async function handleDeleteType(
  db: D1Database,
  botToken: string,
  chatId: number,
  messageId: number | undefined,
  typeId: number,
  lang: Lang
): Promise<void> {
  const category = await db.prepare('SELECT * FROM product_types WHERE id = ?').bind(typeId).first()
  if (!category) {
    await editOrSendMessage(botToken, chatId, messageId, t(lang, 'admin.type_not_found'), {
      parse_mode: 'HTML',
    })
    return
  }

  const c = category as any
  const availableCount = await db.prepare(
    'SELECT COUNT(*) as count FROM products WHERE product_type_id = ?'
  ).bind(typeId).first<{ count: number }>()

  const childCount = availableCount?.count ?? 0

  if (childCount > 0) {
    const text = t(lang, 'admin.deltype.has_products', { name: c.name, count: childCount })
    const keyboard = buildInlineKeyboard([
      [{ text: t(lang, 'admin.btn.list_types'), callback_data: 'adm:listtypes' }],
    ])
    await editOrSendMessage(botToken, chatId, messageId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    })
    return
  }

  const text = t(lang, 'admin.deltype.confirm', {
    name: c.name,
  })

  const keyboard = buildInlineKeyboard([
    [
      { text: t(lang, 'admin.btn.confirm_delete'), callback_data: `adm:delconfirm:${typeId}` },
      { text: t(lang, 'admin.btn.cancel'), callback_data: 'adm:listtypes' },
    ],
  ])

  await editOrSendMessage(botToken, chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  })
}

/**
 * Xác nhận xoá loại sản phẩm (sau khi user bấm confirm).
 */
export async function handleDeleteTypeConfirm(
  db: D1Database,
  botToken: string,
  chatId: number,
  messageId: number | undefined,
  typeId: number,
  lang: Lang
): Promise<void> {
  // Double-check available products
  const availableCount = await db.prepare(
    'SELECT COUNT(*) as count FROM products WHERE product_type_id = ?'
  ).bind(typeId).first<{ count: number }>()

  if ((availableCount?.count ?? 0) > 0) {
    await editOrSendMessage(botToken, chatId, messageId, t(lang, 'admin.deltype.has_products_short'), {
      parse_mode: 'HTML',
      reply_markup: buildInlineKeyboard([
        [{ text: t(lang, 'admin.btn.list_types'), callback_data: 'adm:listtypes' }],
      ]),
    })
    return
  }

  await db.prepare('DELETE FROM product_types WHERE id = ?').bind(typeId).run()

  const keyboard = buildInlineKeyboard([
    [{ text: t(lang, 'admin.btn.list_types'), callback_data: 'adm:listtypes' }],
    [{ text: t(lang, 'admin.btn.panel'), callback_data: 'adm:panel' }],
  ])

  await editOrSendMessage(botToken, chatId, messageId, t(lang, 'admin.deltype.success'), {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  })
}

// --- 6. Add Product Flow ---

/**
 * Multi-step flow thêm sản phẩm: chọn danh mục → tên Product → giá → nhập kho Product_Item.
 */
export async function handleAddProduct(
  db: D1Database,
  botToken: string,
  chatId: number,
  userId: number,
  step: string,
  lang: Lang,
  data?: Record<string, any>
): Promise<void> {
  switch (step) {
    case 'start': {
      // Hiển thị danh sách categories để chọn
      const categories = await db.prepare(
        'SELECT id, name, emoji FROM product_types ORDER BY sort_order ASC, id ASC'
      ).all()

      if (!categories.results.length) {
        const keyboard = buildInlineKeyboard([
          [{ text: t(lang, 'admin.btn.panel'), callback_data: 'adm:panel' }],
        ])
        await sendMessage(botToken, chatId, t(lang, 'admin.addproduct.no_types'), {
          parse_mode: 'HTML',
          reply_markup: keyboard,
        })
        return
      }

	      const buttons = categories.results.map((cat: any) => [
	        {
	          text: t(lang, 'admin.addproduct.type_btn', {
	            emoji: cat.emoji || '',
	            name: cat.name,
	          }),
	          callback_data: `adm:addprod:${cat.id}`,
        },
      ])
      buttons.push([{ text: t(lang, 'admin.btn.panel'), callback_data: 'adm:panel' }])

      const keyboard = buildInlineKeyboard(buttons)
      await sendMessage(botToken, chatId, t(lang, 'admin.addproduct.choose_type'), {
        parse_mode: 'HTML',
        reply_markup: keyboard,
      })
      break
    }

    case 'category': {
      const categoryId = data?.categoryId
      if (!categoryId) return

      const category = await db.prepare('SELECT * FROM product_types WHERE id = ?').bind(categoryId).first()
      if (!category) {
        await sendMessage(botToken, chatId, t(lang, 'admin.type_not_found'))
        return
      }

	      const c = category as any
	      setSession(userId, 'admin_add_product', 'name', { categoryId, categoryName: c.name })

	      const text = t(lang, 'admin.addproduct.prompt_name', { name: c.name })
	      await sendMessage(botToken, chatId, text, { parse_mode: 'HTML' })
	      break
	    }

    case 'name': {
      const session = getSession(userId)
      if (!session) return

      const name = data?.input?.trim() ?? ''
      const validation = validateName(name, lang)
      if (!validation.valid) {
        await sendMessage(botToken, chatId, `${validation.error}\n\n${t(lang, 'admin.addproduct.retry_name')}`, {
          parse_mode: 'HTML',
        })
        return
      }

      setSession(userId, 'admin_add_product', 'price', { ...session.data, productName: name })
      await sendMessage(botToken, chatId, t(lang, 'admin.addproduct.prompt_price'), {
        parse_mode: 'HTML',
      })
      break
    }

    case 'price': {
      const session = getSession(userId)
      if (!session) return

      const input = data?.input ?? ''
      const validation = validatePrice(input, lang)
      if (!validation.valid) {
        await sendMessage(botToken, chatId, `${validation.error}\n\n${t(lang, 'admin.addproduct.retry_price')}`, {
          parse_mode: 'HTML',
        })
        return
      }

      setSession(userId, 'admin_add_product', 'content', { ...session.data, price: parsePrice(input) })
      await sendMessage(botToken, chatId, t(lang, 'admin.addproduct.prompt_content', {
        name: session.data.productName,
        max: MAX_BULK_PRODUCTS,
      }), { parse_mode: 'HTML' })
      break
    }

    case 'content': {
      const session = getSession(userId)
      if (!session) return

      const input = data?.input ?? ''
	      const categoryId = session.data.categoryId
	      const categoryName = session.data.categoryName
	      const productName = session.data.productName
	      const price = session.data.price

      // Parse lines
      const lines = input
        .split('\n')
        .map((l: string) => l.trim())
        .filter((l: string) => l.length > 0)

      if (lines.length === 0) {
        await sendMessage(botToken, chatId, t(lang, 'admin.addproduct.err_empty'), { parse_mode: 'HTML' })
        return
      }

      if (lines.length > MAX_BULK_PRODUCTS) {
        await sendMessage(botToken, chatId, t(lang, 'admin.addproduct.err_too_many', { max: MAX_BULK_PRODUCTS, count: lines.length }), {
          parse_mode: 'HTML',
        })
        return
      }

      // Validate content length
      const invalidLines: string[] = []
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].length > MAX_CONTENT_LENGTH) {
          invalidLines.push(t(lang, 'admin.addproduct.err_line_too_long', { line: i + 1, max: MAX_CONTENT_LENGTH }))
        }
      }
      if (invalidLines.length > 0) {
        await sendMessage(botToken, chatId, t(lang, 'admin.addproduct.err_lines', { errors: invalidLines.join('\n') }), {
          parse_mode: 'HTML',
        })
        return
      }

      // Check duplicates within input
      const inputDups = lines.filter((item: string, index: number) => lines.indexOf(item) !== index)
      if (inputDups.length > 0) {
        const uniqueDups = [...new Set(inputDups)]
        await sendMessage(botToken, chatId, t(lang, 'admin.addproduct.err_dup_input', { items: uniqueDups.slice(0, 5).join('\n') }), {
          parse_mode: 'HTML',
        })
        return
      }

	      // Create Product then batch insert Product_Item stock.
	      const now = new Date().toISOString()
	      const created = await db.prepare(
	        `INSERT INTO products
	           (product_type_id, name, description, content, price, emoji, image_data, sort_order, is_visible, created_at, updated_at)
	         VALUES (?, ?, NULL, NULL, ?, NULL, NULL, 0, 1, ?, ?)
	         RETURNING id`
	      ).bind(categoryId, productName, price, now, now).first<{ id: number }>()

	      if (!created) {
	        await sendMessage(botToken, chatId, t(lang, 'shop.tx_error'), { parse_mode: 'HTML' })
	        return
	      }

	      const stmts = lines.map((content: string) =>
	        db.prepare(
	          "INSERT INTO product_items (product_id, content, status, created_at) VALUES (?, ?, 'available', ?)"
	        ).bind(created.id, content, now)
	      )

	      try {
	        await db.batch(stmts)
	      } catch (err) {
	        await db.prepare('DELETE FROM products WHERE id = ?').bind(created.id).run().catch(() => {})
	        throw err
	      }

      clearSession(userId)

	      const keyboard = buildInlineKeyboard([
	        [{ text: t(lang, 'admin.btn.add_more'), callback_data: `adm:addprod:${categoryId}` }],
	        [{ text: t(lang, 'admin.btn.panel'), callback_data: 'adm:panel' }],
	      ])

      await sendMessage(
	        botToken,
	        chatId,
	        t(lang, 'admin.addproduct.success', { count: lines.length, name: productName || categoryName }),
	        { parse_mode: 'HTML', reply_markup: keyboard }
	      )
      break
    }
  }
}

// --- 7. Stats ---

/**
 * Hiển thị thống kê tổng quan.
 */
export async function handleStats(
  db: D1Database,
  botToken: string,
  chatId: number,
  messageId: number | undefined,
  lang: Lang
): Promise<void> {
  // Total users
  const usersResult = await db.prepare('SELECT COUNT(*) as total FROM users').first<{ total: number }>()
  const totalUsers = usersResult?.total ?? 0

  // Total revenue (sum of purchase transactions, amount is negative for purchases)
  const revenueResult = await db.prepare(
    "SELECT COALESCE(SUM(ABS(amount)), 0) as total FROM transactions WHERE type = 'purchase' AND status = 'success'"
  ).first<{ total: number }>()
  const totalRevenue = revenueResult?.total ?? 0

  // Products per category
  const categoryStats = await db.prepare(`
    SELECT
      pt.name,
      pt.emoji,
      COALESCE(SUM(CASE WHEN pi.status = 'sold' THEN 1 ELSE 0 END), 0) as sold,
      COALESCE(SUM(CASE WHEN pi.status = 'available' THEN 1 ELSE 0 END), 0) as available
    FROM product_types pt
	    LEFT JOIN products p ON p.product_type_id = pt.id
	    LEFT JOIN product_items pi ON pi.product_id = p.id
	    GROUP BY pt.id
	    ORDER BY pt.sort_order ASC, pt.id ASC
	  `).all()

  let text = t(lang, 'admin.stats.title')
  text += t(lang, 'admin.stats.total_users', { count: totalUsers })
  text += t(lang, 'admin.stats.total_revenue', { amount: formatMoney(totalRevenue, lang) })

  if (categoryStats.results.length > 0) {
    text += t(lang, 'admin.stats.by_type_header')
    for (const stat of categoryStats.results) {
      const s = stat as any
	      text += t(lang, 'admin.stats.by_type_item', {
	        emoji: s.emoji || '',
	        name: s.name,
        sold: s.sold,
        available: s.available,
      })
    }
  } else {
    text += t(lang, 'admin.stats.no_types')
  }

  const keyboard = buildInlineKeyboard([
    [{ text: t(lang, 'admin.btn.panel'), callback_data: 'adm:panel' }],
  ])

  await editOrSendMessage(botToken, chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  })
}

// --- Admin Callback Router ---

/**
 * Route admin callback queries dựa trên params.
 */
export async function handleAdminCallbackRouted(
  db: D1Database,
  botToken: string,
  chatId: number,
  messageId: number | undefined,
  userId: number,
  params: string[],
  lang: Lang
): Promise<void> {
  const subAction = params[0] ?? 'panel'

  switch (subAction) {
    case 'panel':
      await handleAdminPanel(db, botToken, chatId, messageId, lang)
      break

    case 'addtype':
      await handleAddTypeFlow(db, botToken, chatId, userId, 'start', lang)
      break

    case 'listtypes': {
      const page = params[1] ? parseInt(params[1], 10) : 0
      await handleListTypes(db, botToken, chatId, messageId, page, lang)
      break
    }

    case 'edit': {
      const typeId = parseInt(params[1], 10)
      if (isNaN(typeId)) return
      await handleEditType(db, botToken, chatId, userId, typeId, 'start', lang)
      break
    }

    case 'del': {
      const typeId = parseInt(params[1], 10)
      if (isNaN(typeId)) return
      await handleDeleteType(db, botToken, chatId, messageId, typeId, lang)
      break
    }

    case 'delconfirm': {
      const typeId = parseInt(params[1], 10)
      if (isNaN(typeId)) return
      await handleDeleteTypeConfirm(db, botToken, chatId, messageId, typeId, lang)
      break
    }

    case 'addproduct':
      await handleAddProduct(db, botToken, chatId, userId, 'start', lang)
      break

    case 'addprod': {
      const categoryId = parseInt(params[1], 10)
      if (isNaN(categoryId)) return
      await handleAddProduct(db, botToken, chatId, userId, 'category', lang, { categoryId })
      break
    }

    case 'stats':
      await handleStats(db, botToken, chatId, messageId, lang)
      break

    default:
      await handleAdminPanel(db, botToken, chatId, messageId, lang)
      break
  }
}

// --- Admin Text Input Handler ---

/**
 * Xử lý text input cho admin multi-step flows.
 */
export async function handleAdminTextInputRouted(
  db: D1Database,
  botToken: string,
  chatId: number,
  userId: number,
  text: string,
  flow: string,
  step: string | null,
  lang: Lang
): Promise<void> {
  switch (flow) {
    case 'admin_add_type':
      await handleAddTypeFlow(db, botToken, chatId, userId, step ?? 'name', lang, { input: text })
      break

    case 'admin_edit_type': {
      const session = getSession(userId)
      if (!session) return
      const typeId = session.data.typeId
      await handleEditType(db, botToken, chatId, userId, typeId, step ?? 'name', lang, text)
      break
    }

    case 'admin_add_product':
      await handleAddProduct(db, botToken, chatId, userId, step ?? 'content', lang, { input: text })
      break
  }
}
