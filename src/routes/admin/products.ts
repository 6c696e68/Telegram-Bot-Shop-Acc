import { Hono, type Context } from 'hono'
import type { Bindings } from '../../types'
import type { AdminVariables } from '../../middleware/jwt-auth'
import { jwtAuth } from '../../middleware/jwt-auth'
import type { DbProduct } from '../../types/db'
import {
  normalizeTranslationFields,
  validatePrice,
  validateSupportedLang,
} from '../../services/catalog-validation'
import { writeAuditLog } from '../../middleware/audit'

type AdminEnv = {
  Bindings: Bindings
  Variables: AdminVariables
}
type AdminContext = Context<AdminEnv>

const MAX_IMAGE_LEN = 700_000
const productRoutes = new Hono<AdminEnv>()

productRoutes.use('/*', jwtAuth)

function clientIp(c: AdminContext): string | null {
  return c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null
}

async function readJsonObject(c: AdminContext): Promise<Record<string, unknown>> {
  return c.req.json<Record<string, unknown>>().catch(() => ({}))
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function isValidImageData(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (v.length === 0 || v.length > MAX_IMAGE_LEN) return false
  return /^data:image\/(png|jpe?g|webp|gif);base64,/.test(v) || /^https:\/\//.test(v)
}

function normalizeImage(value: unknown): string | null | 'invalid_image' | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'string' && value.trim().length === 0) return null
  return isValidImageData(value) ? value.trim() : 'invalid_image'
}

function validateName(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return 'name_required'
  if (value.trim().length > 200) return 'name_too_long'
  return null
}

function validateTemplate(template?: string | null): string | null {
  if (template === undefined || template === null) return null
  const tpl = template.trim()
  if (tpl.length === 0) return null
  if (tpl.length > 3500) return 'template_too_long'

  const allowedTags = [
    'b',
    'strong',
    'i',
    'em',
    'u',
    'ins',
    's',
    'strike',
    'del',
    'code',
    'pre',
    'a',
    'tg-spoiler',
    'blockquote',
  ]
  const tagRegex = /<\/?([a-zA-Z-]+)(?:\s[^>]*)?>/g
  const stack: string[] = []
  let m: RegExpExecArray | null
  while ((m = tagRegex.exec(tpl)) !== null) {
    const raw = m[0]
    const tag = m[1].toLowerCase()
    if (!allowedTags.includes(tag)) return 'template_tag_not_allowed'
    if (raw.startsWith('</')) {
      const last = stack.pop()
      if (last !== tag) return 'template_tag_unbalanced'
    } else if (!raw.endsWith('/>')) {
      stack.push(tag)
    }
  }
  return stack.length > 0 ? 'template_tag_unclosed' : null
}

async function productTypeExists(db: D1Database, productTypeId: number): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM product_types WHERE id = ?').bind(productTypeId).first<{ id: number }>()
  return Boolean(row)
}

productRoutes.get('/', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 20))
  const offset = (page - 1) * limit
  const productTypeId = c.req.query('filter[product_type_id]') || c.req.query('product_type_id')
  const search = c.req.query('search')?.trim() || ''
  const sort = c.req.query('sort') || 'sort_order'
  const order = c.req.query('order') === 'desc' ? 'DESC' : 'ASC'

  const conditions: string[] = []
  const params: unknown[] = []
  if (productTypeId) {
    conditions.push('p.product_type_id = ?')
    params.push(Number(productTypeId))
  }
  if (search) {
    conditions.push('p.name LIKE ?')
    params.push(`%${search}%`)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const allowedSorts = ['id', 'name', 'price', 'sort_order', 'created_at', 'updated_at']
  const sortCol = allowedSorts.includes(sort) ? sort : 'sort_order'

  const total =
    (await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM products p ${where}`)
      .bind(...params)
      .first<{ total: number }>())?.total ?? 0

  const { results } = await c.env.DB.prepare(
    `SELECT p.*,
            pt.name AS product_type_name,
            pt.emoji AS product_type_emoji,
            COALESCE(SUM(CASE WHEN pi.status = 'available' THEN 1 ELSE 0 END), 0) AS available_count,
            COUNT(pi.id) AS total_count
     FROM products p
     LEFT JOIN product_types pt ON pt.id = p.product_type_id
     LEFT JOIN product_items pi ON pi.product_id = p.id
     ${where}
     GROUP BY p.id
     ORDER BY p.${sortCol} ${order}, p.id ASC
     LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all()

  return c.json({ success: true, data: results ?? [], error: null, meta: { total, page, limit } })
})

productRoutes.post('/', async (c) => {
  const body = await readJsonObject(c)
  const productTypeId = Number(body.product_type_id)
  if (!productTypeId || Number.isNaN(productTypeId)) {
    return c.json({ success: false, data: null, error: 'invalid_product_type_id' }, 400)
  }
  if (!(await productTypeExists(c.env.DB, productTypeId))) {
    return c.json({ success: false, data: null, error: 'product_type_not_found' }, 404)
  }

  const nameErr = validateName(body.name)
  if (nameErr) return c.json({ success: false, data: null, error: nameErr }, 400)
  const priceErr = validatePrice(body.price)
  if (priceErr) return c.json({ success: false, data: null, error: priceErr }, 400)
  const image = normalizeImage(body.image_data)
  if (image === 'invalid_image') return c.json({ success: false, data: null, error: 'invalid_image' }, 400)

  const now = new Date().toISOString()
  const insert = await c.env.DB.prepare(
    `INSERT INTO products
       (product_type_id, name, description, content, price, emoji, image_data, sort_order, is_visible, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      productTypeId,
      String(body.name).trim(),
      normalizeOptionalText(body.description),
      normalizeOptionalText(body.content),
      body.price,
      normalizeOptionalText(body.emoji),
      image ?? null,
      Number.isInteger(body.sort_order) ? Number(body.sort_order) : 0,
      body.is_visible === 0 ? 0 : 1,
      now,
      now
    )
    .run()

  const created = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?')
    .bind(insert.meta.last_row_id)
    .first<DbProduct>()
  await writeAuditLog(c.env.DB, {
    adminId: c.get('adminId'),
    action: 'create',
    resourceType: 'product',
    resourceId: created?.id ?? insert.meta.last_row_id,
    newValue: JSON.stringify(created),
    ipAddress: clientIp(c),
  })
  return c.json({ success: true, data: created, error: null }, 201)
})

productRoutes.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!id || Number.isNaN(id)) return c.json({ success: false, data: null, error: 'invalid_product_id' }, 400)

  const existing = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<DbProduct>()
  if (!existing) return c.json({ success: false, data: null, error: 'product_not_found' }, 404)

  const body = await readJsonObject(c)
  const updates: string[] = []
  const values: unknown[] = []

  if (body.product_type_id !== undefined) {
    const productTypeId = Number(body.product_type_id)
    if (!productTypeId || Number.isNaN(productTypeId)) {
      return c.json({ success: false, data: null, error: 'invalid_product_type_id' }, 400)
    }
    if (!(await productTypeExists(c.env.DB, productTypeId))) {
      return c.json({ success: false, data: null, error: 'product_type_not_found' }, 404)
    }
    updates.push('product_type_id = ?')
    values.push(productTypeId)
  }
  if (body.name !== undefined) {
    const err = validateName(body.name)
    if (err) return c.json({ success: false, data: null, error: err }, 400)
    updates.push('name = ?')
    values.push(String(body.name).trim())
  }
  if (body.description !== undefined) {
    updates.push('description = ?')
    values.push(normalizeOptionalText(body.description))
  }
  if (body.content !== undefined) {
    updates.push('content = ?')
    values.push(normalizeOptionalText(body.content))
  }
  if (body.price !== undefined) {
    const err = validatePrice(body.price)
    if (err) return c.json({ success: false, data: null, error: err }, 400)
    updates.push('price = ?')
    values.push(body.price)
  }
  if (body.emoji !== undefined) {
    updates.push('emoji = ?')
    values.push(normalizeOptionalText(body.emoji))
  }
  if (body.image_data !== undefined) {
    const image = normalizeImage(body.image_data)
    if (image === 'invalid_image') return c.json({ success: false, data: null, error: 'invalid_image' }, 400)
    updates.push('image_data = ?')
    values.push(image ?? null)
  }
  if (body.sort_order !== undefined) {
    updates.push('sort_order = ?')
    values.push(Number.isInteger(body.sort_order) ? Number(body.sort_order) : 0)
  }
  if (body.is_visible !== undefined) {
    updates.push('is_visible = ?')
    values.push(body.is_visible === 0 ? 0 : 1)
  }
  if (updates.length === 0) {
    return c.json({ success: false, data: null, error: 'no_fields_to_update' }, 400)
  }

  updates.push('updated_at = ?')
  values.push(new Date().toISOString(), id)
  await c.env.DB.prepare(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run()

  const updated = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<DbProduct>()
  await writeAuditLog(c.env.DB, {
    adminId: c.get('adminId'),
    action: 'update',
    resourceType: 'product',
    resourceId: id,
    oldValue: JSON.stringify(existing),
    newValue: JSON.stringify(updated),
    ipAddress: clientIp(c),
  })
  return c.json({ success: true, data: updated, error: null })
})

productRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!id || Number.isNaN(id)) return c.json({ success: false, data: null, error: 'invalid_product_id' }, 400)

  const existing = await c.env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first<DbProduct>()
  if (!existing) return c.json({ success: false, data: null, error: 'product_not_found' }, 404)

  const childCount =
    (await c.env.DB.prepare('SELECT COUNT(*) AS count FROM product_items WHERE product_id = ?')
      .bind(id)
      .first<{ count: number }>())?.count ?? 0
  if (childCount > 0) return c.json({ success: false, data: null, error: 'product_has_items' }, 400)

  await c.env.DB.prepare('DELETE FROM products WHERE id = ?').bind(id).run()
  await writeAuditLog(c.env.DB, {
    adminId: c.get('adminId'),
    action: 'delete',
    resourceType: 'product',
    resourceId: id,
    oldValue: JSON.stringify(existing),
    ipAddress: clientIp(c),
  })
  return c.json({ success: true, data: { id }, error: null })
})

productRoutes.get('/:id/templates', async (c) => {
  const id = Number(c.req.param('id'))
  if (!id || Number.isNaN(id)) return c.json({ success: false, data: null, error: 'invalid_product_id' }, 400)
  const { results } = await c.env.DB.prepare(
    'SELECT lang, success_template FROM product_type_templates WHERE product_type_id = ? ORDER BY lang ASC'
  )
    .bind(id)
    .all<{ lang: string; success_template: string | null }>()
  return c.json({ success: true, data: results ?? [], error: null })
})

productRoutes.put('/:id/templates', async (c) => {
  const id = Number(c.req.param('id'))
  if (!id || Number.isNaN(id)) return c.json({ success: false, data: null, error: 'invalid_product_id' }, 400)
  const existing = await c.env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(id).first<{ id: number }>()
  if (!existing) return c.json({ success: false, data: null, error: 'product_not_found' }, 404)

  const body = await readJsonObject(c)
  const lang = typeof body.lang === 'string' ? body.lang.trim() : ''
  const langErr = validateSupportedLang(lang)
  if (langErr) return c.json({ success: false, data: null, error: langErr }, 400)

  const templateInput = typeof body.success_template === 'string' ? body.success_template : null
  const tplErr = validateTemplate(templateInput)
  if (tplErr) return c.json({ success: false, data: null, error: tplErr }, 400)
  const value = normalizeOptionalText(templateInput)
  const now = new Date().toISOString()

  await c.env.DB.prepare(
    `INSERT INTO product_type_templates (product_type_id, lang, success_template, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(product_type_id, lang) DO UPDATE SET
       success_template = excluded.success_template,
       updated_at = excluded.updated_at`
  )
    .bind(id, lang, value, now)
    .run()

  return c.json({ success: true, data: { product_id: id, lang, success_template: value }, error: null })
})

productRoutes.get('/:id/translations', async (c) => {
  const id = Number(c.req.param('id'))
  if (!id || Number.isNaN(id)) return c.json({ success: false, data: null, error: 'invalid_product_id' }, 400)
  const { results } = await c.env.DB.prepare(
    'SELECT lang, name, description, content, updated_at FROM product_translations WHERE product_id = ? ORDER BY lang ASC'
  )
    .bind(id)
    .all()
  return c.json({ success: true, data: results ?? [], error: null })
})

async function saveProductTranslation(c: AdminContext, createOnly: boolean) {
  const id = Number(c.req.param('id'))
  if (!id || Number.isNaN(id)) return c.json({ success: false, data: null, error: 'invalid_product_id' }, 400)
  const existing = await c.env.DB.prepare('SELECT id FROM products WHERE id = ?').bind(id).first<{ id: number }>()
  if (!existing) return c.json({ success: false, data: null, error: 'product_not_found' }, 404)

  const body = await readJsonObject(c)
  const lang = typeof body.lang === 'string' ? body.lang.trim() : ''
  const langErr = validateSupportedLang(lang)
  if (langErr) return c.json({ success: false, data: null, error: langErr }, 400)

  const fields = normalizeTranslationFields(body)
  if (typeof fields === 'string') return c.json({ success: false, data: null, error: fields }, 400)

  if (createOnly) {
    const duplicate = await c.env.DB.prepare('SELECT id FROM product_translations WHERE product_id = ? AND lang = ?')
      .bind(id, lang)
      .first<{ id: number }>()
    if (duplicate) return c.json({ success: false, data: null, error: 'translation_exists' }, 409)
  }

  const now = new Date().toISOString()
  await c.env.DB.prepare(
    `INSERT INTO product_translations (product_id, lang, name, description, content, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(product_id, lang) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       content = excluded.content,
       updated_at = excluded.updated_at`
  )
    .bind(id, lang, fields.name, fields.description, fields.content, now)
    .run()

  return c.json({ success: true, data: { product_id: id, lang, ...fields, updated_at: now }, error: null })
}

productRoutes.post('/:id/translations', (c) => saveProductTranslation(c, true))
productRoutes.put('/:id/translations', (c) => saveProductTranslation(c, false))

export { productRoutes }
