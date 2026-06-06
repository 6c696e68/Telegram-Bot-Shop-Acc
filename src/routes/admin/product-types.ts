import { Hono } from 'hono'
import type { Bindings } from '../../types'
import type { AdminVariables } from '../../middleware/jwt-auth'
import { jwtAuth } from '../../middleware/jwt-auth'
import type { DbProductType } from '../../types/db'

type AdminEnv = {
  Bindings: Bindings
  Variables: AdminVariables
}

const productTypesRoutes = new Hono<AdminEnv>()

// All routes require JWT
productTypesRoutes.use('/*', jwtAuth)

/**
 * GET /product-types
 * List product_types with pagination, includes stock counts (available/total).
 * Requirements: 11.4, 13.1, 13.2
 */
productTypesRoutes.get('/', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 20))
  const sort = c.req.query('sort') || 'sort_order'
  const order = c.req.query('order') === 'desc' ? 'DESC' : 'ASC'
  const search = c.req.query('search') || ''

  const offset = (page - 1) * limit

  // Whitelist sortable columns to prevent SQL injection
  const allowedSorts = ['id', 'name', 'price', 'sort_order', 'created_at', 'updated_at']
  const sortCol = allowedSorts.includes(sort) ? sort : 'sort_order'

  let whereClause = ''
  const params: unknown[] = []

  if (search) {
    whereClause = 'WHERE pt.name LIKE ?'
    params.push(`%${search}%`)
  }

  // Count total
  const countSql = `SELECT COUNT(*) as total FROM product_types pt ${whereClause}`
  const countResult = await c.env.DB.prepare(countSql).bind(...params).first<{ total: number }>()
  const total = countResult?.total ?? 0

  // List with stock counts
  const listSql = `
    SELECT 
      pt.*,
      COALESCE(stock.available, 0) as available_count,
      COALESCE(stock.total, 0) as total_count
    FROM product_types pt
    LEFT JOIN (
      SELECT 
        type_id,
        SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) as available,
        COUNT(*) as total
      FROM products
      GROUP BY type_id
    ) stock ON stock.type_id = pt.id
    ${whereClause}
    ORDER BY pt.${sortCol} ${order}
    LIMIT ? OFFSET ?
  `
  const listParams = [...params, limit, offset]
  const result = await c.env.DB.prepare(listSql).bind(...listParams).all()

  return c.json({
    success: true,
    data: result.results,
    error: null,
    meta: { total, page, limit },
  })
})

/**
 * POST /product-types
 * Create a new product_type. Validates name, description, price.
 * Writes audit_log.
 * Requirements: 11.4, 13.1, 13.5
 */
productTypesRoutes.post('/', async (c) => {
  const body = await c.req.json<{
    name?: string
    description?: string
    price?: number
    emoji?: string
    sort_order?: number
    is_visible?: number
    success_template?: string
  }>()

  // Validation
  const errors = validateProductType(body)
  if (errors) {
    return c.json({ success: false, data: null, error: errors }, 400)
  }

  const name = body.name!.trim()
  const description = body.description?.trim() ?? null
  const price = body.price!
  const emoji = body.emoji?.trim() || '📦'
  const sortOrder = body.sort_order ?? 0
  const isVisible = body.is_visible ?? 1
  const successTemplate = body.success_template?.trim() || null
  const now = new Date().toISOString()
  const adminId = c.get('adminId')

  const insertResult = await c.env.DB.prepare(
    `INSERT INTO product_types (name, description, price, emoji, sort_order, is_visible, success_template, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(name, description, price, emoji, sortOrder, isVisible, successTemplate, now, now).run()

  const newId = insertResult.meta.last_row_id

  // Write audit log
  await c.env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, resource_type, resource_id, old_value, new_value, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    adminId,
    'create',
    'product_type',
    newId,
    null,
    JSON.stringify({ name, description, price, emoji, sort_order: sortOrder, is_visible: isVisible, success_template: successTemplate }),
    c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null,
    now
  ).run()

  // Return created record
  const created = await c.env.DB.prepare(
    'SELECT * FROM product_types WHERE id = ?'
  ).bind(newId).first<DbProductType>()

  return c.json({
    success: true,
    data: created,
    error: null,
  }, 201)
})

/**
 * PUT /product-types/:id
 * Update product_type fields. Same validation. Writes audit_log with old_value/new_value.
 * Requirements: 11.4, 13.1, 13.5
 */
productTypesRoutes.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!id || isNaN(id)) {
    return c.json({ success: false, data: null, error: 'invalid_product_type_id' }, 400)
  }

  // Find existing record
  const existing = await c.env.DB.prepare(
    'SELECT * FROM product_types WHERE id = ?'
  ).bind(id).first<DbProductType>()

  if (!existing) {
    return c.json({ success: false, data: null, error: 'product_type_not_found' }, 404)
  }

  const body = await c.req.json<{
    name?: string
    description?: string
    price?: number
    emoji?: string
    sort_order?: number
    is_visible?: number
    success_template?: string | null
  }>()

  // Validate only fields that are provided
  const errors = validateProductTypeUpdate(body)
  if (errors) {
    return c.json({ success: false, data: null, error: errors }, 400)
  }

  // Build dynamic update
  const updates: string[] = []
  const values: unknown[] = []
  const now = new Date().toISOString()

  if (body.name !== undefined) {
    updates.push('name = ?')
    values.push(body.name.trim())
  }
  if (body.description !== undefined) {
    updates.push('description = ?')
    values.push(body.description?.trim() ?? null)
  }
  if (body.price !== undefined) {
    updates.push('price = ?')
    values.push(body.price)
  }
  if (body.emoji !== undefined) {
    updates.push('emoji = ?')
    values.push(body.emoji.trim() || '📦')
  }
  if (body.sort_order !== undefined) {
    updates.push('sort_order = ?')
    values.push(body.sort_order)
  }
  if (body.is_visible !== undefined) {
    updates.push('is_visible = ?')
    values.push(body.is_visible)
  }
  if (body.success_template !== undefined) {
    updates.push('success_template = ?')
    const tpl = typeof body.success_template === 'string' ? body.success_template.trim() : ''
    values.push(tpl || null)
  }

  if (updates.length === 0) {
    return c.json({ success: false, data: null, error: 'no_fields_to_update' }, 400)
  }

  updates.push('updated_at = ?')
  values.push(now)
  values.push(id)

  await c.env.DB.prepare(
    `UPDATE product_types SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...values).run()

  // Write audit log with old_value / new_value
  const adminId = c.get('adminId')
  const updated = await c.env.DB.prepare(
    'SELECT * FROM product_types WHERE id = ?'
  ).bind(id).first<DbProductType>()

  await c.env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, resource_type, resource_id, old_value, new_value, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    adminId,
    'update',
    'product_type',
    id,
    JSON.stringify(existing),
    JSON.stringify(updated),
    c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null,
    now
  ).run()

  return c.json({
    success: true,
    data: updated,
    error: null,
  })
})

/**
 * DELETE /product-types/:id
 * Delete product_type if no available products exist.
 * If available products > 0, return 400 error.
 * Writes audit_log.
 * Requirements: 11.4, 13.1, 13.2
 */
productTypesRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!id || isNaN(id)) {
    return c.json({ success: false, data: null, error: 'invalid_product_type_id' }, 400)
  }

  // Find existing record
  const existing = await c.env.DB.prepare(
    'SELECT * FROM product_types WHERE id = ?'
  ).bind(id).first<DbProductType>()

  if (!existing) {
    return c.json({ success: false, data: null, error: 'product_type_not_found' }, 404)
  }

  // Check if there are available products
  const stockCount = await c.env.DB.prepare(
    "SELECT COUNT(*) as count FROM products WHERE type_id = ? AND status = 'available'"
  ).bind(id).first<{ count: number }>()

  const availableCount = stockCount?.count ?? 0

  if (availableCount > 0) {
    return c.json({
      success: false,
      data: null,
      error: 'product_type_has_stock',
    }, 400)
  }

  // Delete
  await c.env.DB.prepare('DELETE FROM product_types WHERE id = ?').bind(id).run()

  // Write audit log
  const adminId = c.get('adminId')
  const now = new Date().toISOString()

  await c.env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, resource_type, resource_id, old_value, new_value, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    adminId,
    'delete',
    'product_type',
    id,
    JSON.stringify(existing),
    null,
    c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null,
    now
  ).run()

  return c.json({
    success: true,
    data: { id },
    error: null,
  })
})

/**
 * GET /product-types/:id/templates
 * Đọc toàn bộ template bán hàng đa ngôn ngữ của một product_type (R16.2).
 * Trả mảng `{ lang, success_template }` cho mọi lang đã có dòng.
 */
productTypesRoutes.get('/:id/templates', async (c) => {
  const id = Number(c.req.param('id'))
  if (!id || isNaN(id)) {
    return c.json({ success: false, data: null, error: 'invalid_product_type_id' }, 400)
  }

  const { results } = await c.env.DB.prepare(
    'SELECT lang, success_template FROM product_type_templates WHERE product_type_id = ?'
  )
    .bind(id)
    .all<{ lang: string; success_template: string | null }>()

  return c.json({ success: true, data: results, error: null })
})

/**
 * PUT /product-types/:id/templates
 * Upsert MỘT bản template theo (product_type_id, lang) (R16.2).
 * Body `{ lang, success_template }`. Validate tag HTML như template chung.
 */
productTypesRoutes.put('/:id/templates', async (c) => {
  const id = Number(c.req.param('id'))
  if (!id || isNaN(id)) {
    return c.json({ success: false, data: null, error: 'invalid_product_type_id' }, 400)
  }

  const body = await c.req
    .json<{ lang?: string; success_template?: string | null }>()
    .catch(() => ({ lang: undefined, success_template: undefined }))

  const lang = typeof body.lang === 'string' ? body.lang.trim() : ''
  if (!lang) {
    return c.json({ success: false, data: null, error: 'lang_required' }, 400)
  }

  const tplErr = validateTemplate(body.success_template ?? null)
  if (tplErr) {
    return c.json({ success: false, data: null, error: tplErr }, 400)
  }

  // product_type phải tồn tại (FK + tránh tạo template mồ côi).
  const pt = await c.env.DB.prepare('SELECT id FROM product_types WHERE id = ?').bind(id).first<{ id: number }>()
  if (!pt) {
    return c.json({ success: false, data: null, error: 'product_type_not_found' }, 404)
  }

  const value =
    typeof body.success_template === 'string' && body.success_template.trim().length > 0
      ? body.success_template.trim()
      : null
  const now = new Date().toISOString()

  // Upsert theo UNIQUE(product_type_id, lang).
  await c.env.DB.prepare(
    `INSERT INTO product_type_templates (product_type_id, lang, success_template, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(product_type_id, lang) DO UPDATE SET
       success_template = excluded.success_template,
       updated_at = excluded.updated_at`
  )
    .bind(id, lang, value, now)
    .run()

  const adminId = c.get('adminId')
  await c.env.DB.prepare(
    `INSERT INTO audit_logs (admin_id, action, resource_type, resource_id, old_value, new_value, ip_address, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      adminId,
      'update_template',
      'product_type',
      id,
      null,
      JSON.stringify({ lang, has_template: value !== null }),
      c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null,
      now
    )
    .run()

  return c.json({ success: true, data: { product_type_id: id, lang, success_template: value }, error: null })
})

// --- Validation helpers ---
function validateProductType(body: {
  name?: string
  description?: string
  price?: number
  success_template?: string | null
}): string | null {
  if (!body.name || body.name.trim().length === 0) {
    return 'name_required'
  }
  if (body.name.trim().length > 100) {
    return 'name_too_long'
  }
  if (body.description !== undefined && body.description !== null && body.description.length > 500) {
    return 'description_too_long'
  }
  if (body.price === undefined || body.price === null) {
    return 'price_required'
  }
  if (!Number.isInteger(body.price) || body.price < 1000 || body.price > 999999999) {
    return 'price_out_of_range'
  }
  const tplErr = validateTemplate(body.success_template)
  if (tplErr) return tplErr
  return null
}

function validateProductTypeUpdate(body: {
  name?: string
  description?: string
  price?: number
  success_template?: string | null
}): string | null {
  if (body.name !== undefined) {
    if (body.name.trim().length === 0) {
      return 'name_required'
    }
    if (body.name.trim().length > 100) {
      return 'name_too_long'
    }
  }
  if (body.description !== undefined && body.description !== null && body.description.length > 500) {
    return 'description_too_long'
  }
  if (body.price !== undefined) {
    if (!Number.isInteger(body.price) || body.price < 1000 || body.price > 999999999) {
      return 'price_out_of_range'
    }
  }
  const tplErr = validateTemplate(body.success_template)
  if (tplErr) return tplErr
  return null
}

/**
 * Validate success_template:
 * - Tối đa 3500 ký tự (chừa chỗ cho [content] khi render, Telegram limit 4096).
 * - Cân bằng tag HTML cơ bản mà Telegram hỗ trợ (b, i, u, s, code, pre, a).
 */
function validateTemplate(template?: string | null): string | null {
  if (template === undefined || template === null) return null
  const tpl = template.trim()
  if (tpl.length === 0) return null
  if (tpl.length > 3500) {
    return 'template_too_long'
  }

  const allowedTags = ['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'a', 'tg-spoiler', 'blockquote']
  const tagRegex = /<\/?([a-zA-Z-]+)(?:\s[^>]*)?>/g
  const stack: string[] = []
  let m: RegExpExecArray | null
  while ((m = tagRegex.exec(tpl)) !== null) {
    const raw = m[0]
    const tag = m[1].toLowerCase()
    if (!allowedTags.includes(tag)) {
      return 'template_tag_not_allowed'
    }
    if (raw.startsWith('</')) {
      const last = stack.pop()
      if (last !== tag) {
        return 'template_tag_unbalanced'
      }
    } else if (!raw.endsWith('/>')) {
      stack.push(tag)
    }
  }
  if (stack.length > 0) {
    return 'template_tag_unclosed'
  }
  return null
}

export { productTypesRoutes }
