import { Hono } from 'hono'
import type { Bindings } from '../../types'
import type { AdminVariables } from '../../middleware/jwt-auth'
import { jwtAuth } from '../../middleware/jwt-auth'
import type { DbUser, DbTransaction, DbOrder } from '../../types/db'

type AdminEnv = {
  Bindings: Bindings
  Variables: AdminVariables
}

const usersRoutes = new Hono<AdminEnv>()

// Apply JWT auth to all users routes
usersRoutes.use('/*', jwtAuth)

/**
 * GET /users
 * List users with pagination, search by username or telegram_id.
 * Sort by created_at DESC.
 * Requirements: 11.3, 13.1, 13.2, 13.3
 */
usersRoutes.get('/', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 20))
  const search = c.req.query('search')?.trim() || ''
  const offset = (page - 1) * limit

  let countQuery = 'SELECT COUNT(*) as total FROM users'
  let dataQuery = 'SELECT * FROM users'
  const conditions: string[] = []
  const params: (string | number)[] = []

  if (search) {
    conditions.push('(username LIKE ? OR CAST(telegram_id AS TEXT) LIKE ?)')
    params.push(`%${search}%`, `%${search}%`)
  }

  if (conditions.length > 0) {
    const where = ' WHERE ' + conditions.join(' AND ')
    countQuery += where
    dataQuery += where
  }

  dataQuery += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'

  // Execute count query
  const countStmt = c.env.DB.prepare(countQuery)
  const countResult = await (params.length > 0
    ? countStmt.bind(...params)
    : countStmt
  ).first<{ total: number }>()

  const total = countResult?.total ?? 0

  // Execute data query
  const dataStmt = c.env.DB.prepare(dataQuery)
  const dataResult = await (params.length > 0
    ? dataStmt.bind(...params, limit, offset)
    : dataStmt.bind(limit, offset)
  ).all<DbUser>()

  return c.json({
    success: true,
    data: dataResult.results,
    error: null,
    meta: { total, page, limit },
  })
})

/**
 * GET /users/:id
 * User detail with balance, recent transactions (limit 20), recent orders (limit 10).
 * Requirements: 11.3, 13.1
 */
usersRoutes.get('/:id', async (c) => {
  const userId = Number(c.req.param('id'))

  if (!userId || isNaN(userId)) {
    return c.json({ success: false, data: null, error: 'invalid_user_id' }, 400)
  }

  const user = await c.env.DB.prepare(
    'SELECT * FROM users WHERE id = ?'
  ).bind(userId).first<DbUser>()

  if (!user) {
    return c.json({ success: false, data: null, error: 'user_not_found' }, 404)
  }

  // Recent transactions (limit 20)
  const transactions = await c.env.DB.prepare(
    'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20'
  ).bind(userId).all<DbTransaction>()

  // Recent orders (limit 10) with product name
  const orders = await c.env.DB.prepare(
    `SELECT o.*, p.name as product_name, pt.name as category_name
     FROM orders o 
     LEFT JOIN products p ON o.product_id = p.id
     LEFT JOIN product_types pt ON p.product_type_id = pt.id
     WHERE o.user_id = ? 
     ORDER BY o.created_at DESC LIMIT 10`
  ).bind(userId).all<DbOrder & { product_name: string | null; category_name: string | null }>()

  return c.json({
    success: true,
    data: {
      user,
      transactions: transactions.results,
      orders: orders.results,
    },
    error: null,
  })
})

/**
 * POST /users/:id/adjust-balance
 * Adjust user balance manually. Requires reason.
 * Creates transaction type='adjustment', writes audit_log.
 * Requirements: 13.8, 11.3
 */
usersRoutes.post('/:id/adjust-balance', async (c) => {
  const userId = Number(c.req.param('id'))

  if (!userId || isNaN(userId)) {
    return c.json({ success: false, data: null, error: 'invalid_user_id' }, 400)
  }

  const body = await c.req.json<{ amount?: number; reason?: string }>()

  if (body.amount === undefined || body.amount === null || typeof body.amount !== 'number') {
    return c.json({ success: false, data: null, error: 'amount_required' }, 400)
  }

  if (!body.reason || body.reason.trim().length === 0) {
    return c.json({ success: false, data: null, error: 'reason_required' }, 400)
  }

  const { amount, reason } = body

  // amount can be positive (add) or negative (deduct)
  if (!Number.isInteger(amount)) {
    return c.json({ success: false, data: null, error: 'amount_must_be_integer' }, 400)
  }

  const user = await c.env.DB.prepare(
    'SELECT * FROM users WHERE id = ?'
  ).bind(userId).first<DbUser>()

  if (!user) {
    return c.json({ success: false, data: null, error: 'user_not_found' }, 404)
  }

  const balanceBefore = user.balance
  const balanceAfter = balanceBefore + amount

  if (balanceAfter < 0) {
    return c.json(
      { success: false, data: null, error: 'adjustment_negative_balance' },
      400
    )
  }

  const now = new Date().toISOString()
  const adminId = c.get('adminId')
  const description = `Admin adjustment: ${reason.trim()}`

  // Atomic: update balance + create transaction + write audit log
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE users SET balance = ?, updated_at = ? WHERE id = ?'
    ).bind(balanceAfter, now, userId),
    c.env.DB.prepare(
      `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, reference_type, description, status, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(userId, 'adjustment', amount, balanceBefore, balanceAfter, 'admin_adjustment', description, 'success', now),
    c.env.DB.prepare(
      `INSERT INTO audit_logs (admin_id, action, resource_type, resource_id, old_value, new_value, ip_address, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      adminId,
      'adjust_balance',
      'user',
      userId,
      JSON.stringify({ balance: balanceBefore }),
      JSON.stringify({ balance: balanceAfter, reason: reason.trim() }),
      c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null,
      now
    ),
  ])

  return c.json({
    success: true,
    data: {
      user_id: userId,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      amount,
      reason: reason.trim(),
    },
    error: null,
  })
})

/**
 * POST /users/:id/ban
 * Khoá user: set is_active = 0, ghi banned_at, viết audit_log.
 * User bị khoá sẽ không thể nhắn bot hay thao tác Mini App. Không cần lý do.
 */
usersRoutes.post('/:id/ban', async (c) => {
  const userId = Number(c.req.param('id'))

  if (!userId || isNaN(userId)) {
    return c.json({ success: false, data: null, error: 'invalid_user_id' }, 400)
  }

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(userId)
    .first<DbUser>()

  if (!user) {
    return c.json({ success: false, data: null, error: 'user_not_found' }, 404)
  }

  if (user.is_active === 0) {
    return c.json({ success: false, data: null, error: 'user_already_banned' }, 409)
  }

  const now = new Date().toISOString()
  const adminId = c.get('adminId')

  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE users SET is_active = 0, banned_at = ?, updated_at = ? WHERE id = ?'
    ).bind(now, now, userId),
    c.env.DB.prepare(
      `INSERT INTO audit_logs (admin_id, action, resource_type, resource_id, old_value, new_value, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      adminId,
      'ban_user',
      'user',
      userId,
      JSON.stringify({ is_active: user.is_active }),
      JSON.stringify({ is_active: 0 }),
      c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null,
      now
    ),
  ])

  return c.json({
    success: true,
    data: { user_id: userId, is_active: 0, banned_at: now },
    error: null,
  })
})

/**
 * POST /users/:id/unban
 * Mở khoá user: set is_active = 1, xoá banned_at, viết audit_log.
 */
usersRoutes.post('/:id/unban', async (c) => {
  const userId = Number(c.req.param('id'))

  if (!userId || isNaN(userId)) {
    return c.json({ success: false, data: null, error: 'invalid_user_id' }, 400)
  }

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(userId)
    .first<DbUser>()

  if (!user) {
    return c.json({ success: false, data: null, error: 'user_not_found' }, 404)
  }

  if (user.is_active === 1) {
    return c.json({ success: false, data: null, error: 'user_not_banned' }, 409)
  }

  const now = new Date().toISOString()
  const adminId = c.get('adminId')

  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE users SET is_active = 1, banned_at = NULL, updated_at = ? WHERE id = ?'
    ).bind(now, userId),
    c.env.DB.prepare(
      `INSERT INTO audit_logs (admin_id, action, resource_type, resource_id, old_value, new_value, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      adminId,
      'unban_user',
      'user',
      userId,
      JSON.stringify({ is_active: user.is_active }),
      JSON.stringify({ is_active: 1 }),
      c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null,
      now
    ),
  ])

  return c.json({
    success: true,
    data: { user_id: userId, is_active: 1 },
    error: null,
  })
})

/**
 * PUT /users/:id/region
 * Cập nhật Region của user (R5.4). Giữ nguyên số dư + ngôn ngữ (ngôn ngữ độc lập vùng).
 * Validate region thuộc {vietnam, international}; viết audit_log.
 */
usersRoutes.put('/:id/region', async (c) => {
  const userId = Number(c.req.param('id'))
  if (!userId || isNaN(userId)) {
    return c.json({ success: false, data: null, error: 'invalid_user_id' }, 400)
  }

  const body = await c.req.json<{ region?: unknown }>().catch(() => ({ region: undefined }))
  const region = body.region
  if (region !== 'vietnam' && region !== 'international') {
    return c.json({ success: false, data: null, error: 'region_invalid' }, 400)
  }

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first<DbUser>()
  if (!user) {
    return c.json({ success: false, data: null, error: 'user_not_found' }, 404)
  }

  const now = new Date().toISOString()
  const adminId = c.get('adminId')

  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET region = ?, updated_at = ? WHERE id = ?').bind(region, now, userId),
    c.env.DB.prepare(
      `INSERT INTO audit_logs (admin_id, action, resource_type, resource_id, old_value, new_value, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      adminId,
      'update_region',
      'user',
      userId,
      JSON.stringify({ region: user.region }),
      JSON.stringify({ region }),
      c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null,
      now
    ),
  ])

  return c.json({ success: true, data: { user_id: userId, region }, error: null })
})

export { usersRoutes }
