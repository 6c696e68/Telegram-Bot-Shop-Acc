import { Hono, type Context } from 'hono'
import type { Bindings } from '../../types'
import type { AdminVariables } from '../../middleware/jwt-auth'
import { jwtAuth } from '../../middleware/jwt-auth'
import type { DbProductType } from '../../types/db'
import {
  normalizeTranslationFields,
  validateSupportedLang,
} from '../../services/catalog-validation'
import { writeAuditLog } from '../../middleware/audit'

type AdminEnv = {
  Bindings: Bindings
  Variables: AdminVariables
}
type AdminContext = Context<AdminEnv>

const MAX_IMAGE_LEN = 700_000

function isValidImageData(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (v.length === 0 || v.length > MAX_IMAGE_LEN) return false
  return /^data:image\/(png|jpe?g|webp|gif);base64,/.test(v) || /^https:\/\//.test(v)
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function validateBaseName(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return 'name_required'
  if (value.trim().length > 200) return 'name_too_long'
  return null
}

function normalizeImage(value: unknown): string | null | 'invalid_image' | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'string' && value.trim().length === 0) return null
  return isValidImageData(value) ? value.trim() : 'invalid_image'
}

const productTypesRoutes = new Hono<AdminEnv>()

productTypesRoutes.use('/*', jwtAuth)

function clientIp(c: AdminContext): string | null {
  return c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || null
}

async function readJsonObject(c: AdminContext): Promise<Record<string, unknown>> {
  return c.req.json<Record<string, unknown>>().catch(() => ({}))
}

productTypesRoutes.get('/', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 20))
  const offset = (page - 1) * limit
  const sort = c.req.query('sort') || 'sort_order'
  const order = c.req.query('order') === 'desc' ? 'DESC' : 'ASC'
  const search = c.req.query('search')?.trim() || ''

  const allowedSorts = ['id', 'name', 'sort_order', 'created_at', 'updated_at']
  const sortCol = allowedSorts.includes(sort) ? sort : 'sort_order'
  const where = search ? 'WHERE pt.name LIKE ?' : ''
  const params = search ? [`%${search}%`] : []

  const total =
    (await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM product_types pt ${where}`)
      .bind(...params)
      .first<{ total: number }>())?.total ?? 0

  const { results } = await c.env.DB.prepare(
    `SELECT pt.*,
            COUNT(DISTINCT p.id) AS product_count,
            COALESCE(SUM(CASE WHEN pi.status = 'available' THEN 1 ELSE 0 END), 0) AS available_count,
            COUNT(pi.id) AS total_count
     FROM product_types pt
     LEFT JOIN products p ON p.product_type_id = pt.id
     LEFT JOIN product_items pi ON pi.product_id = p.id
     ${where}
     GROUP BY pt.id
     ORDER BY pt.${sortCol} ${order}, pt.id ASC
     LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all()

  return c.json({ success: true, data: results ?? [], error: null, meta: { total, page, limit } })
})

productTypesRoutes.post('/', async (c) => {
  const body = await readJsonObject(c)
  const nameError = validateBaseName(body.name)
  if (nameError) return c.json({ success: false, data: null, error: nameError }, 400)

  const image = normalizeImage(body.image_data)
  if (image === 'invalid_image') return c.json({ success: false, data: null, error: 'invalid_image' }, 400)

  const now = new Date().toISOString()
  const name = String(body.name).trim()
  const description = normalizeOptionalText(body.description)
  const content = normalizeOptionalText(body.content)
  const emoji = normalizeOptionalText(body.emoji)
  const sortOrder = Number.isInteger(body.sort_order) ? Number(body.sort_order) : 0
  const isVisible = body.is_visible === 0 ? 0 : 1

  const insert = await c.env.DB.prepare(
    `INSERT INTO product_types (name, description, content, emoji, image_data, sort_order, is_visible, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(name, description, content, emoji, image ?? null, sortOrder, isVisible, now, now)
    .run()

  const created = await c.env.DB.prepare('SELECT * FROM product_types WHERE id = ?')
    .bind(insert.meta.last_row_id)
    .first<DbProductType>()

  await writeAuditLog(c.env.DB, {
    adminId: c.get('adminId'),
    action: 'create',
    resourceType: 'product_type',
    resourceId: created?.id ?? insert.meta.last_row_id,
    newValue: JSON.stringify(created),
    ipAddress: clientIp(c),
  })

  return c.json({ success: true, data: created, error: null }, 201)
})

productTypesRoutes.put('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!id || Number.isNaN(id)) {
    return c.json({ success: false, data: null, error: 'invalid_product_type_id' }, 400)
  }

  const existing = await c.env.DB.prepare('SELECT * FROM product_types WHERE id = ?')
    .bind(id)
    .first<DbProductType>()
  if (!existing) return c.json({ success: false, data: null, error: 'product_type_not_found' }, 404)

  const body = await readJsonObject(c)
  const updates: string[] = []
  const values: unknown[] = []

  if (body.name !== undefined) {
    const err = validateBaseName(body.name)
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

  await c.env.DB.prepare(`UPDATE product_types SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run()

  const updated = await c.env.DB.prepare('SELECT * FROM product_types WHERE id = ?')
    .bind(id)
    .first<DbProductType>()

  await writeAuditLog(c.env.DB, {
    adminId: c.get('adminId'),
    action: 'update',
    resourceType: 'product_type',
    resourceId: id,
    oldValue: JSON.stringify(existing),
    newValue: JSON.stringify(updated),
    ipAddress: clientIp(c),
  })

  return c.json({ success: true, data: updated, error: null })
})

productTypesRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!id || Number.isNaN(id)) {
    return c.json({ success: false, data: null, error: 'invalid_product_type_id' }, 400)
  }

  const existing = await c.env.DB.prepare('SELECT * FROM product_types WHERE id = ?')
    .bind(id)
    .first<DbProductType>()
  if (!existing) return c.json({ success: false, data: null, error: 'product_type_not_found' }, 404)

  const children =
    (await c.env.DB.prepare('SELECT COUNT(*) AS count FROM products WHERE product_type_id = ?')
      .bind(id)
      .first<{ count: number }>())?.count ?? 0
  if (children > 0) {
    return c.json({ success: false, data: null, error: 'product_type_has_children' }, 400)
  }

  await c.env.DB.prepare('DELETE FROM product_types WHERE id = ?').bind(id).run()
  await writeAuditLog(c.env.DB, {
    adminId: c.get('adminId'),
    action: 'delete',
    resourceType: 'product_type',
    resourceId: id,
    oldValue: JSON.stringify(existing),
    ipAddress: clientIp(c),
  })
  return c.json({ success: true, data: { id }, error: null })
})

productTypesRoutes.get('/:id/translations', async (c) => {
  const id = Number(c.req.param('id'))
  if (!id || Number.isNaN(id)) {
    return c.json({ success: false, data: null, error: 'invalid_product_type_id' }, 400)
  }
  const { results } = await c.env.DB.prepare(
    'SELECT lang, name, description, content, updated_at FROM product_type_translations WHERE product_type_id = ? ORDER BY lang ASC'
  )
    .bind(id)
    .all()
  return c.json({ success: true, data: results ?? [], error: null })
})

async function saveProductTypeTranslation(c: AdminContext, createOnly: boolean) {
  const id = Number(c.req.param('id'))
  if (!id || Number.isNaN(id)) {
    return c.json({ success: false, data: null, error: 'invalid_product_type_id' }, 400)
  }
  const parent = await c.env.DB.prepare('SELECT id FROM product_types WHERE id = ?').bind(id).first<{ id: number }>()
  if (!parent) return c.json({ success: false, data: null, error: 'product_type_not_found' }, 404)

  const body = await readJsonObject(c)
  const lang = typeof body.lang === 'string' ? body.lang.trim() : ''
  const langErr = validateSupportedLang(lang)
  if (langErr) return c.json({ success: false, data: null, error: langErr }, 400)

  const fields = normalizeTranslationFields(body)
  if (typeof fields === 'string') return c.json({ success: false, data: null, error: fields }, 400)

  if (createOnly) {
    const exists = await c.env.DB.prepare(
      'SELECT id FROM product_type_translations WHERE product_type_id = ? AND lang = ?'
    )
      .bind(id, lang)
      .first<{ id: number }>()
    if (exists) return c.json({ success: false, data: null, error: 'translation_exists' }, 409)
  }

  const now = new Date().toISOString()
  await c.env.DB.prepare(
    `INSERT INTO product_type_translations (product_type_id, lang, name, description, content, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(product_type_id, lang) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       content = excluded.content,
       updated_at = excluded.updated_at`
  )
    .bind(id, lang, fields.name, fields.description, fields.content, now)
    .run()

  return c.json({ success: true, data: { product_type_id: id, lang, ...fields, updated_at: now }, error: null })
}

productTypesRoutes.post('/:id/translations', (c) => saveProductTypeTranslation(c, true))
productTypesRoutes.put('/:id/translations', (c) => saveProductTypeTranslation(c, false))

export { productTypesRoutes }
