import { Hono } from 'hono'
import type { Bindings } from '../../types'
import type { AdminVariables } from '../../middleware/jwt-auth'
import { jwtAuth } from '../../middleware/jwt-auth'
import { completeDeposit } from '../../services/deposit-service'
import type { DbDeposit } from '../../types/db'

type DepositsEnv = {
  Bindings: Bindings
  Variables: AdminVariables
}

const depositsRoutes = new Hono<DepositsEnv>()

// All deposits routes require JWT
depositsRoutes.use('/*', jwtAuth)

/**
 * GET /deposits
 * List deposits with pagination and status filter.
 * JOIN users for telegram_id/username. Sort by created_at DESC.
 * Requirements: 11.9, 13.10
 */
depositsRoutes.get('/', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 20))
  const offset = (page - 1) * limit
  const status = c.req.query('status') // pending | completed | expired | cancelled

  const validStatuses = ['pending', 'completed', 'expired', 'cancelled', 'awaiting_credit']

  let whereClause = ''
  const bindParams: (string | number)[] = []

  if (status && validStatuses.includes(status)) {
    whereClause = 'WHERE d.status = ?'
    bindParams.push(status)
  }

  // Count total
  const countQuery = `SELECT COUNT(*) as total FROM deposits d ${whereClause}`
  const countStmt = bindParams.length > 0
    ? c.env.DB.prepare(countQuery).bind(...bindParams)
    : c.env.DB.prepare(countQuery)
  const countResult = await countStmt.first<{ total: number }>()
  const total = countResult?.total ?? 0

  // Fetch deposits with user info
  const dataQuery = `
    SELECT d.*, u.telegram_id, u.username
    FROM deposits d
    LEFT JOIN users u ON d.user_id = u.id
    ${whereClause}
    ORDER BY d.created_at DESC
    LIMIT ? OFFSET ?
  `
  const dataParams = [...bindParams, limit, offset]
  const dataResult = await c.env.DB.prepare(dataQuery).bind(...dataParams).all()

  return c.json({
    success: true,
    data: dataResult.results,
    error: null,
    meta: { total, page, limit },
  })
})

/**
 * POST /deposits/:id/approve
 * Manually approve a pending deposit (fallback when SePay webhook missed).
 * Calls completeDeposit (provider='sepay'), writes audit_log.
 * Requirements: 11.9, 13.10
 */
depositsRoutes.post('/:id/approve', async (c) => {
  const depositId = Number(c.req.param('id'))

  if (!depositId || isNaN(depositId)) {
    return c.json(
      { success: false, data: null, error: 'invalid_deposit_id' },
      400
    )
  }

  // Fetch deposit
  const deposit = await c.env.DB.prepare(
    'SELECT * FROM deposits WHERE id = ?'
  ).bind(depositId).first<DbDeposit>()

  if (!deposit) {
    return c.json(
      { success: false, data: null, error: 'deposit_not_found' },
      404
    )
  }

  if (deposit.status !== 'pending') {
    return c.json(
      { success: false, data: null, error: 'deposit_not_pending' },
      400
    )
  }

  // Duyệt tay chỉ áp cho SePay (fallback khi webhook miss). CryptoBot hoàn tất qua webhook
  // Crypto Pay (xác nhận thanh toán USDT + quy đổi) — không cộng tay để tránh sai provider/số tiền.
  if (deposit.provider !== 'sepay') {
    return c.json(
      { success: false, data: null, error: 'manual_approve_sepay_only' },
      400
    )
  }

  // Execute deposit via DepositService (manual SePay tx id như cũ)
  const result = await completeDeposit({
    db: c.env.DB,
    depositId,
    userId: deposit.user_id,
    creditVnd: deposit.amount,
    provider: 'sepay',
    sepayTransactionId: 'manual-approve',
  })

  if (!result.success) {
    return c.json(
      { success: false, data: null, error: 'approve_failed' },
      400
    )
  }

  // Write audit log
  const adminId = c.get('adminId')
  const now = new Date().toISOString()

  await c.env.DB.prepare(
    'INSERT INTO audit_logs (admin_id, action, resource_type, resource_id, old_value, new_value, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(
    adminId,
    'approve',
    'deposit',
    depositId,
    JSON.stringify({ status: 'pending' }),
    JSON.stringify({ status: 'completed', new_balance: result.newBalance }),
    c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null,
    now
  ).run()

  return c.json({
    success: true,
    data: {
      deposit_id: depositId,
      new_balance: result.newBalance,
      approved_at: now,
    },
    error: null,
  })
})

export { depositsRoutes }
