/**
 * Callback handler: Lịch sử đơn hàng + chi tiết đơn.
 *
 * - `handleHistory` (`hist`): 10 đơn gần nhất, mỗi đơn là một nút bấm mở chi tiết.
 * - `handleOrderDetail` (`hist:<orderId>`): xem lại nội dung tài khoản đã mua của đơn,
 *   guard chủ sở hữu theo `telegram_id` (chống IDOR — chỉ chủ đơn xem được content).
 *
 * Nội dung + định dạng tiền/ngày theo Language của user (R4.1, R4.6).
 * Requirements: 4.1, 4.6, 4.7, 4.8
 */

import type { InlineKeyboardButton } from '../../types/telegram'
import { editOrSendMessage, sendChunkedMessage, buildInlineKeyboard, buildBackButton } from '../telegram-api'
import { escapeHtml } from '../../utils/telegram-template'
import { formatMoneyFor, formatDateTime, type CurrencyContext } from '../../utils/format'
import { t, type Lang, type MessageKey } from '../i18n'
import {
  buildDisplayPlaceholder,
  loadDisplayLang,
  loadProductTranslations,
  resolveDisplayText,
} from '../../services/i18n-catalog'

interface OrderRow {
  id: number
  quantity: number
  total_amount: number
  status: 'completed' | 'refunded'
  created_at: string
  product_id: number
  name: string
  emoji: string | null
}

/**
 * Hiển thị lịch sử 10 đơn hàng gần nhất của user dưới dạng nút bấm.
 * Bấm một đơn → mở chi tiết (`hist:<orderId>`) để xem lại nội dung đã mua.
 * Nếu không có đơn hàng → thông báo "chưa có đơn hàng".
 */
export async function handleHistory(
  db: D1Database,
  botToken: string,
  chatId: number,
  messageId: number | undefined,
  userId: number,
  lang: Lang,
  ctx: CurrencyContext
): Promise<void> {
  const { results } = await db
	   .prepare(
	      `SELECT o.id, o.quantity, o.total_amount, o.status, o.created_at,
	              p.id AS product_id,
	              p.name,
	              COALESCE(p.emoji, pt.emoji) AS emoji
	       FROM orders o
	       JOIN products p ON p.id = o.product_id
	       JOIN product_types pt ON pt.id = p.product_type_id
	       JOIN users u ON u.id = o.user_id
	       WHERE u.telegram_id = ?
	       ORDER BY o.created_at DESC
       LIMIT 10`
    )
    .bind(userId)
    .all<OrderRow>()

  if (!results || results.length === 0) {
    await editOrSendMessage(botToken, chatId, messageId, t(lang, 'history.empty'), {
      parse_mode: 'HTML',
      reply_markup: buildInlineKeyboard([buildBackButton('menu:main', lang)]),
    })
    return
  }

  // Mỗi đơn = một nút bấm (1 nút/hàng) mở chi tiết đơn.
  const defaultLang = await loadDisplayLang(db)
  const buttons: InlineKeyboardButton[][] = await Promise.all(
    results.map(async (order) => {
      const translations = await loadProductTranslations(db, order.product_id)
      const name = resolveDisplayText(
        translations,
        'name',
        order.name,
        lang,
        defaultLang,
        buildDisplayPlaceholder(order.product_id)
      )
      return [
        {
          text: t(lang, 'history.item_button', {
            emoji: order.emoji ?? '',
            name,
            qty: order.quantity,
            total: formatMoneyFor(order.total_amount, ctx),
          }),
          callback_data: `hist:${order.id}`,
        },
      ]
    })
  )
  buttons.push(buildBackButton('menu:main', lang))

  const text = `${t(lang, 'history.title')}\n\n${t(lang, 'history.tap_hint')}`

  await editOrSendMessage(botToken, chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: buildInlineKeyboard(buttons),
  })
}

interface OrderDetailRow {
  id: number
  quantity: number
  total_amount: number
  status: 'completed' | 'refunded'
  created_at: string
  product_id: number
  name: string
  emoji: string | null
}

/** Nhãn trạng thái đơn theo lang (catalog `order.status.<status>`). */
function statusLabel(lang: Lang, status: 'completed' | 'refunded'): string {
  return t(lang, `order.status.${status}` as MessageKey)
}

/**
 * Hiển thị chi tiết một đơn + nội dung tài khoản đã mua (xem lại để copy).
 * Guard chủ sở hữu: chỉ trả đơn thuộc `telegram_id` hiện tại (R15.3, chống IDOR).
 * Đơn không tồn tại hoặc không thuộc user → thông báo "không tìm thấy".
 */
export async function handleOrderDetail(
  db: D1Database,
  botToken: string,
  chatId: number,
  messageId: number | undefined,
  orderId: number,
  userId: number,
  lang: Lang,
  ctx: CurrencyContext
): Promise<void> {
  // Guard chủ sở hữu — JOIN users theo telegram_id, lọc đúng đơn của user.
  const order = await db
	   .prepare(
	      `SELECT o.id, o.quantity, o.total_amount, o.status, o.created_at,
	              p.id AS product_id,
	              p.name,
	              COALESCE(p.emoji, pt.emoji) AS emoji
	       FROM orders o
	       JOIN products p ON p.id = o.product_id
	       JOIN product_types pt ON pt.id = p.product_type_id
	       JOIN users u ON u.id = o.user_id
	       WHERE o.id = ? AND u.telegram_id = ?`
    )
    .bind(orderId, userId)
    .first<OrderDetailRow>()

  if (!order) {
    await editOrSendMessage(botToken, chatId, messageId, t(lang, 'order.not_found'), {
      parse_mode: 'HTML',
      reply_markup: buildInlineKeyboard([buildBackButton('hist', lang)]),
    })
    return
  }

  // Nội dung tài khoản thuộc đơn (chỉ truy vấn sau khi đã xác nhận đơn thuộc user — R15.3).
  const { results } = await db
	   .prepare(
	      `SELECT pi.content
	       FROM order_items oi
	       JOIN product_items pi ON pi.id = oi.product_item_id
	       WHERE oi.order_id = ?`
    )
    .bind(order.id)
    .all<{ content: string }>()

  const defaultLang = await loadDisplayLang(db)
  const translations = await loadProductTranslations(db, order.product_id)
  const productName = resolveDisplayText(
    translations,
    'name',
    order.name,
    lang,
    defaultLang,
    buildDisplayPlaceholder(order.product_id)
  )

  const lines: string[] = [
    t(lang, 'order.detail_title', { id: order.id }),
    '',
    `${order.emoji ?? ''} ${escapeHtml(productName)}`.trim(),
    t(lang, 'order.detail_qty', { qty: order.quantity }),
    t(lang, 'order.detail_total', { total: formatMoneyFor(order.total_amount, ctx) }),
    t(lang, 'order.detail_status', { status: statusLabel(lang, order.status) }),
    t(lang, 'order.detail_date', { date: formatDateTime(order.created_at, lang) }),
    '',
    t(lang, 'order.detail_content_label'),
  ]

  if (results.length === 0) {
    lines.push(t(lang, 'order.detail_empty'))
  } else {
    const contentList = results
      .map((r, i) => `${i + 1}. <code>${escapeHtml(r.content)}</code>`)
      .join('\n')
    lines.push(contentList)
  }

  // Danh sách content có thể vượt 4096 ký tự với đơn lớn → chia nhỏ tin nhắn (chunk).
  await sendChunkedMessage(botToken, chatId, messageId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: buildInlineKeyboard([buildBackButton('hist', lang)]),
  })
}
