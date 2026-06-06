import { Hono } from 'hono'
import type { Bindings } from '../../types'
import type { AdminVariables } from '../../middleware/jwt-auth'
import { jwtAuth } from '../../middleware/jwt-auth'
import type { DbProduct, DbProductType } from '../../types/db'

type AdminEnv = {
  Bindings: Bindings
  Variables: AdminVariables
}

const productRoutes = new Hono<AdminEnv>()

// All routes require JWT authentication
productRoutes.use('/*', jwtAuth)

/**
 * GET /products
 * List products with pagination, filter by type_id and status.
 * Includes product_type name via JOIN.
 * Requirements: 11.5, 13.1
 */
productRoutes.get('/', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 20))
  const offset = (page - 1) * limit

  const typeId = c.req.query('filter[type_id]') || c.req.query('type_id')
  const status = c.req.query('filter[status]') || c.req.query('status')
  const sort = c.req.query('sort') || 'created_at'
  const order = c.req.query('order') === 'asc' ? 'ASC' : 'DESC'

  // Validate sort field to prevent SQL injection
  const allowedSorts = ['id', 'created_at', 'sold_at', 'status', 'type_id']
  const safeSort = allowedSorts.includes(sort) ? sort : 'created_at'

  // Build WHERE clauses
  const conditions: string[] = []
  const params: (string | number)[] = []

  if (typeId) {
    conditions.push('p.type_id = ?')
    params.push(Number(typeId))
  }

  if (status && ['available', 'sold', 'reserved'].includes(status)) {
    conditions.push('p.status = ?')
    params.push(status)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  // Count total
  const countSql = `SELECT COUNT(*) as total FROM products p ${whereClause}`
  const countResult = await c.env.DB.prepare(countSql).bind(...params).first<{ total: number }>()
  const total = countResult?.total ?? 0

  // Fetch products with product_type name
  const dataSql = `
    SELECT p.id, p.type_id, p.content, p.status, p.buyer_id, p.order_id, p.created_at, p.sold_at,
           pt.name as type_name
    FROM products p
    LEFT JOIN product_types pt ON p.type_id = pt.id
    ${whereClause}
    ORDER BY p.${safeSort} ${order}
    LIMIT ? OFFSET ?
  `
  const dataParams = [...params, limit, offset]
  const { results } = await c.env.DB.prepare(dataSql).bind(...dataParams).all()

  return c.json({
    success: true,
    data: results,
    error: null,
    meta: { total, page, limit },
  })
})

/**
 * POST /products/import
 * Import products in bulk.
 * Body: { category_id: number, contents: string[] }
 * Check duplicates per category (UNIQUE index on type_id + content).
 * D1 batch insert non-duplicates.
 * Return: { imported: number, duplicates: string[], errors: string[] }
 * Requirements: 11.6, 13.9
 */
productRoutes.post('/import', async (c) => {
  const body = await c.req.json<{ category_id?: number; contents?: string[] }>()

  if (!body.category_id || !Array.isArray(body.contents) || body.contents.length === 0) {
    return c.json(
      { success: false, data: null, error: 'category_contents_required' },
      400
    )
  }

  const { category_id, contents } = body

  // Verify category exists
  const category = await c.env.DB.prepare(
    'SELECT id FROM product_types WHERE id = ?'
  ).bind(category_id).first<Pick<DbProductType, 'id'>>()

  if (!category) {
    return c.json(
      { success: false, data: null, error: 'category_not_found' },
      404
    )
  }

  // Filter out empty/whitespace-only contents
  const validContents = contents
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  if (validContents.length === 0) {
    return c.json(
      { success: false, data: null, error: 'no_valid_contents' },
      400
    )
  }

  // Check existing products in this category to find duplicates
  // Build placeholders for IN clause
  const placeholders = validContents.map(() => '?').join(', ')
  const existingQuery = `
    SELECT content FROM products WHERE type_id = ? AND content IN (${placeholders})
  `
  const existingParams = [category_id, ...validContents]
  const { results: existingProducts } = await c.env.DB.prepare(existingQuery)
    .bind(...existingParams)
    .all<{ content: string }>()

  const existingSet = new Set(existingProducts.map((p) => p.content))

  const duplicates: string[] = []
  const toInsert: string[] = []

  for (const content of validContents) {
    if (existingSet.has(content)) {
      duplicates.push(content)
    } else {
      // Also deduplicate within the input itself
      if (toInsert.includes(content)) {
        duplicates.push(content)
      } else {
        toInsert.push(content)
      }
    }
  }

  const errors: string[] = []
  let imported = 0

  if (toInsert.length > 0) {
    const now = new Date().toISOString()
    const stmts = toInsert.map((content) =>
      c.env.DB.prepare(
        'INSERT INTO products (type_id, content, status, created_at) VALUES (?, ?, ?, ?)'
      ).bind(category_id, content, 'available', now)
    )

    try {
      // D1 batch insert
      const results = await c.env.DB.batch(stmts)
      imported = results.filter((r) => r.meta.changes > 0).length
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown database error'
      errors.push(message)
    }
  }

  // Log audit
  const adminId = c.get('adminId')
  await c.env.DB.prepare(
    'INSERT INTO audit_logs (admin_id, action, resource_type, resource_id, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(
    adminId,
    'import',
    'product',
    category_id,
    JSON.stringify({ imported, duplicates: duplicates.length, errors: errors.length }),
    new Date().toISOString()
  ).run()

  return c.json({
    success: true,
    data: { imported, duplicates, errors },
    error: null,
  })
})

/**
 * DELETE /products/:id
 * Only allow deleting products with status='available'.
 * Return error if sold/reserved.
 * Requirements: 11.5, 13.1
 */
productRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))

  if (!id || isNaN(id)) {
    return c.json(
      { success: false, data: null, error: 'invalid_product_id' },
      400
    )
  }

  // Find the product
  const product = await c.env.DB.prepare(
    'SELECT id, type_id, content, status FROM products WHERE id = ?'
  ).bind(id).first<Pick<DbProduct, 'id' | 'type_id' | 'content' | 'status'>>()

  if (!product) {
    return c.json(
      { success: false, data: null, error: 'product_not_found' },
      404
    )
  }

  if (product.status !== 'available') {
    return c.json(
      { success: false, data: null, error: 'product_not_deletable' },
      400
    )
  }

  // Delete the product
  await c.env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id).run()

  // Log audit
  const adminId = c.get('adminId')
  await c.env.DB.prepare(
    'INSERT INTO audit_logs (admin_id, action, resource_type, resource_id, old_value, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(
    adminId,
    'delete',
    'product',
    id,
    JSON.stringify({ type_id: product.type_id, content: product.content }),
    new Date().toISOString()
  ).run()

  return c.json({
    success: true,
    data: { id },
    error: null,
  })
})

export { productRoutes }
