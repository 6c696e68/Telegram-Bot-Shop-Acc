import { Hono } from 'hono'
import type { Bindings } from '../../types'
import type { AdminVariables } from '../../middleware/jwt-auth'
import { jwtAuth } from '../../middleware/jwt-auth'

type StatsEnv = {
  Bindings: Bindings
  Variables: AdminVariables
}

const statsRoutes = new Hono<StatsEnv>()

// All stats routes require JWT
statsRoutes.use('/*', jwtAuth)

/**
 * GET /dashboard
 * Dữ liệu tổng hợp: tổng doanh thu (today, 7d, 30d, all), tổng users, tổng orders,
 * products remaining per category.
 * Requirements: 11.2, 13.6
 */
statsRoutes.get('/dashboard', async (c) => {
  const db = c.env.DB
  const now = new Date()

  // Compute date boundaries in ISO format (UTC)
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const [revenueAgg, totalUsers, totalOrders, productsPerCategory] = await Promise.all([
    // Doanh thu today/7d/30d/all-time trong MỘT query (conditional SUM) thay vì 4 lần quét
    // bảng orders. Lọc status='completed' (idx_orders_status_created hỗ trợ).
    db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN created_at >= ?1 THEN total_amount END), 0) AS today,
           COALESCE(SUM(CASE WHEN created_at >= ?2 THEN total_amount END), 0) AS last7,
           COALESCE(SUM(CASE WHEN created_at >= ?3 THEN total_amount END), 0) AS last30,
           COALESCE(SUM(total_amount), 0) AS all_time
         FROM orders
         WHERE status = 'completed'`
      )
      .bind(todayStart, sevenDaysAgo, thirtyDaysAgo)
      .first<{ today: number; last7: number; last30: number; all_time: number }>(),

    // Total users
    db.prepare(`SELECT COUNT(*) as count FROM users`).first<{ count: number }>(),

    // Total orders
    db.prepare(`SELECT COUNT(*) as count FROM orders`).first<{ count: number }>(),

    // Product items remaining per category
    db.prepare(
      `SELECT pt.id, pt.name, pt.emoji, COUNT(p.id) as available_count
       FROM product_types pt
       LEFT JOIN products pr ON pr.product_type_id = pt.id
       LEFT JOIN product_items p ON p.product_id = pr.id AND p.status = 'available'
       GROUP BY pt.id
       ORDER BY pt.sort_order ASC, pt.name ASC`
    ).all<{ id: number; name: string; emoji: string; available_count: number }>(),
  ])

  return c.json({
    success: true,
    data: {
      revenue: {
        today: revenueAgg?.today ?? 0,
        last7days: revenueAgg?.last7 ?? 0,
        last30days: revenueAgg?.last30 ?? 0,
        allTime: revenueAgg?.all_time ?? 0,
      },
      totalUsers: totalUsers?.count ?? 0,
      totalOrders: totalOrders?.count ?? 0,
      productsPerCategory: productsPerCategory?.results ?? [],
    },
    error: null,
  })
})

/**
 * GET /revenue?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Doanh thu theo ngày cho biểu đồ (line chart).
 * Requirements: 11.2, 13.7
 */
statsRoutes.get('/revenue', async (c) => {
  const db = c.env.DB
  const from = c.req.query('from')
  const to = c.req.query('to')

  if (!from || !to) {
    return c.json(
      { success: false, data: null, error: 'date_range_required' },
      400
    )
  }

  // Validate date format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/
  if (!dateRegex.test(from) || !dateRegex.test(to)) {
    return c.json(
      { success: false, data: null, error: 'invalid_date_format' },
      400
    )
  }

  // Query daily revenue grouped by date
  const result = await db.prepare(
    `SELECT DATE(created_at) as date, SUM(total_amount) as revenue, COUNT(*) as order_count
     FROM orders
     WHERE status = 'completed'
       AND DATE(created_at) >= ?
       AND DATE(created_at) <= ?
     GROUP BY DATE(created_at)
     ORDER BY date ASC`
  ).bind(from, to).all<{ date: string; revenue: number; order_count: number }>()

  return c.json({
    success: true,
    data: result.results,
    error: null,
  })
})

/**
 * GET /top-products
   * Top sản phẩm bán chạy nhất (by quantity sold, limit 10).
 * Requirements: 11.11, 13.6
 */
statsRoutes.get('/top-products', async (c) => {
  const db = c.env.DB

  const result = await db.prepare(
    `SELECT p.id, p.name, p.emoji, p.price,
            SUM(o.quantity) as total_sold,
            SUM(o.total_amount) as total_revenue
     FROM orders o
     JOIN products p ON p.id = o.product_id
     WHERE o.status = 'completed'
     GROUP BY p.id
     ORDER BY total_sold DESC
     LIMIT 10`
  ).all<{ id: number; name: string; emoji: string; price: number; total_sold: number; total_revenue: number }>()

  return c.json({
    success: true,
    data: result.results,
    error: null,
  })
})

/**
 * GET /top-users
 * Top users mua nhiều nhất (by purchase amount, limit 10).
 * Requirements: 11.11, 13.6
 */
statsRoutes.get('/top-users', async (c) => {
  const db = c.env.DB

  const result = await db.prepare(
    `SELECT u.id, u.telegram_id, u.username, u.first_name,
            SUM(o.total_amount) as total_spent,
            COUNT(o.id) as order_count
     FROM orders o
     JOIN users u ON u.id = o.user_id
     WHERE o.status = 'completed'
     GROUP BY u.id
     ORDER BY total_spent DESC
     LIMIT 10`
  ).all<{ id: number; telegram_id: number; username: string | null; first_name: string | null; total_spent: number; order_count: number }>()

  return c.json({
    success: true,
    data: result.results,
    error: null,
  })
})

export { statsRoutes }
