import { Hono } from 'hono'
import type { Bindings } from '../../types'
import type { AdminVariables } from '../../middleware/jwt-auth'
import { jwtAuth } from '../../middleware/jwt-auth'

type AdminEnv = {
  Bindings: Bindings
  Variables: AdminVariables
}

const orderRoutes = new Hono<AdminEnv>()

// Apply JWT auth to all order routes
orderRoutes.use('/*', jwtAuth)

/**
 * GET /orders
 * List orders with pagination + filters: status, product_type_id, date range (from/to).
 * JOIN product_types and users for display info.
 * Requirements: 11.7, 13.1, 13.3
 */
orderRoutes.get('/', async (c) => {
  const page = Math.max(1, Number(c.req.query('page') || '1'))
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || '20')))
  const offset = (page - 1) * limit
  const sort = c.req.query('sort') || 'created_at'
  const order = c.req.query('order') === 'asc' ? 'ASC' : 'DESC'

  // Filters
  const status = c.req.query('filter[status]') || c.req.query('status')
  const productTypeId = c.req.query('filter[product_type_id]') || c.req.query('product_type_id')
  const dateFrom = c.req.query('filter[from]') || c.req.query('from')
  const dateTo = c.req.query('filter[to]') || c.req.query('to')

  // Validate sort field to prevent SQL injection
  const allowedSorts = ['created_at', 'total_amount', 'quantity', 'id']
  const sortField = allowedSorts.includes(sort) ? `o.${sort}` : 'o.created_at'

  // Build WHERE clause
  const conditions: string[] = []
  const bindings: unknown[] = []

  if (status) {
    conditions.push('o.status = ?')
    bindings.push(status)
  }
  if (productTypeId) {
    conditions.push('o.product_type_id = ?')
    bindings.push(Number(productTypeId))
  }
  if (dateFrom) {
    conditions.push('o.created_at >= ?')
    bindings.push(dateFrom)
  }
  if (dateTo) {
    conditions.push('o.created_at <= ?')
    bindings.push(dateTo)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  // Count total
  const countSql = `SELECT COUNT(*) as total FROM orders o ${whereClause}`
  const countResult = await c.env.DB.prepare(countSql).bind(...bindings).first<{ total: number }>()
  const total = countResult?.total || 0

  // Fetch orders with JOINs
  const dataSql = `
    SELECT 
      o.id, o.user_id, o.product_type_id, o.quantity, o.total_amount, 
      o.transaction_id, o.status, o.created_at,
      pt.name as product_type_name, pt.emoji as product_type_emoji, pt.price as unit_price,
      u.telegram_id, u.username, u.first_name
    FROM orders o
    LEFT JOIN product_types pt ON o.product_type_id = pt.id
    LEFT JOIN users u ON o.user_id = u.id
    ${whereClause}
    ORDER BY ${sortField} ${order}
    LIMIT ? OFFSET ?
  `
  const dataBindings = [...bindings, limit, offset]
  const { results } = await c.env.DB.prepare(dataSql).bind(...dataBindings).all()

  return c.json({
    success: true,
    data: results || [],
    error: null,
    meta: { total, page, limit },
  })
})

/**
 * GET /orders/:id
 * Order detail including user info, product_type info, and order_items with product content.
 * Requirements: 11.7, 13.1
 */
orderRoutes.get('/:id', async (c) => {
  const orderId = Number(c.req.param('id'))

  if (!orderId || isNaN(orderId)) {
    return c.json({ success: false, data: null, error: 'invalid_order_id' }, 400)
  }

  // Fetch order with user and product_type info
  const order = await c.env.DB.prepare(`
    SELECT 
      o.id, o.user_id, o.product_type_id, o.quantity, o.total_amount, 
      o.transaction_id, o.status, o.created_at,
      pt.name as product_type_name, pt.emoji as product_type_emoji, pt.price as unit_price,
      u.telegram_id, u.username, u.first_name, u.balance as user_balance
    FROM orders o
    LEFT JOIN product_types pt ON o.product_type_id = pt.id
    LEFT JOIN users u ON o.user_id = u.id
    WHERE o.id = ?
  `).bind(orderId).first()

  if (!order) {
    return c.json({ success: false, data: null, error: 'order_not_found' }, 404)
  }

  // Fetch order items with product content
  const { results: items } = await c.env.DB.prepare(`
    SELECT 
      oi.id, oi.product_id, oi.created_at,
      p.content, p.status as product_status, p.sold_at
    FROM order_items oi
    LEFT JOIN products p ON oi.product_id = p.id
    WHERE oi.order_id = ?
    ORDER BY oi.id ASC
  `).bind(orderId).all()

  return c.json({
    success: true,
    data: {
      ...order,
      items: items || [],
    },
    error: null,
  })
})

export { orderRoutes }
