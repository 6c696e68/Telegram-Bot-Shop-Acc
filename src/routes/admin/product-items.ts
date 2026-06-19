import { Hono, type Context } from 'hono'
import type { Bindings } from '../../types'
import type { AdminVariables } from '../../middleware/jwt-auth'
import { jwtAuth } from '../../middleware/jwt-auth'
import type { DbProductItem } from '../../types/db'

type AdminEnv = {
  Bindings: Bindings
  Variables: AdminVariables
}
type AdminContext = Context<AdminEnv>

const productItemRoutes = new Hono<AdminEnv>()

productItemRoutes.use('/*', jwtAuth)

async function readJsonObject(c: AdminContext): Promise<Record<string, unknown>> {
  return c.req.json<Record<string, unknown>>().catch(() => ({}))
}

async function productExists(db: D1Database, productId: number): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM products WHERE id = ?').bind(productId).first<{ id: number }>()
  return Boolean(row)
}

function normalizeContents(contents: unknown): string[] {
  if (!Array.isArray(contents)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of contents) {
    if (typeof raw !== 'string') continue
    const content = raw.trim()
    if (!content || seen.has(content)) continue
    seen.add(content)
    result.push(content)
  }
  return result
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

/**
 * D1 giới hạn 100 bound parameters cho mỗi câu lệnh (kể cả từng statement trong batch).
 * - Truy vấn check trùng dùng `IN (...)`: mỗi chunk gồm 1 param product_id + contents → giữ <= 99 content.
 * - Insert nhiều dòng: mỗi dòng 3 param (product_id, content, created_at) → tối đa 33 dòng/statement.
 */
const DUP_CHECK_CHUNK = 90
const INSERT_ROW_CHUNK = 30
// Số statement insert tối đa cho mỗi lần batch() để tránh chạm giới hạn query/invocation và 30s.
const INSERT_BATCH_STMTS = 20

productItemRoutes.get('/', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1)
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 20))
  const offset = (page - 1) * limit
  const productId = c.req.query('filter[product_id]') || c.req.query('product_id')
  const status = c.req.query('filter[status]') || c.req.query('status')
  const sort = c.req.query('sort') || 'created_at'
  const order = c.req.query('order') === 'asc' ? 'ASC' : 'DESC'

  const conditions: string[] = []
  const params: unknown[] = []
  if (productId) {
    conditions.push('pi.product_id = ?')
    params.push(Number(productId))
  }
  if (status && ['available', 'sold', 'reserved'].includes(status)) {
    conditions.push('pi.status = ?')
    params.push(status)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const allowedSorts = ['id', 'created_at', 'sold_at', 'status', 'product_id']
  const sortCol = allowedSorts.includes(sort) ? sort : 'created_at'

  const total =
    (await c.env.DB.prepare(`SELECT COUNT(*) AS total FROM product_items pi ${where}`)
      .bind(...params)
      .first<{ total: number }>())?.total ?? 0

  const { results } = await c.env.DB.prepare(
    `SELECT pi.*,
            p.name AS product_name,
            pt.name AS product_type_name
     FROM product_items pi
     LEFT JOIN products p ON p.id = pi.product_id
     LEFT JOIN product_types pt ON pt.id = p.product_type_id
     ${where}
     ORDER BY pi.${sortCol} ${order}, pi.id DESC
     LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all()

  return c.json({ success: true, data: results ?? [], error: null, meta: { total, page, limit } })
})

productItemRoutes.post('/', async (c) => {
  const body = await readJsonObject(c)
  const productId = Number(body.product_id)
  const content = typeof body.content === 'string' ? body.content.trim() : ''
  if (!productId || Number.isNaN(productId) || !content) {
    return c.json({ success: false, data: null, error: 'product_content_required' }, 400)
  }
  if (!(await productExists(c.env.DB, productId))) {
    return c.json({ success: false, data: null, error: 'product_not_found' }, 404)
  }

  const now = new Date().toISOString()
  try {
    const inserted = await c.env.DB.prepare(
      "INSERT INTO product_items (product_id, content, status, created_at) VALUES (?, ?, 'available', ?)"
    )
      .bind(productId, content, now)
      .run()
    const item = await c.env.DB.prepare('SELECT * FROM product_items WHERE id = ?')
      .bind(inserted.meta.last_row_id)
      .first<DbProductItem>()
    return c.json({ success: true, data: item, error: null }, 201)
  } catch {
    return c.json({ success: false, data: null, error: 'product_item_duplicate' }, 409)
  }
})

productItemRoutes.post('/import', async (c) => {
  const body = await readJsonObject(c)
  const productId = Number(body.product_id)
  const contents = normalizeContents(body.contents)
  if (!productId || Number.isNaN(productId) || contents.length === 0) {
    return c.json({ success: false, data: null, error: 'product_contents_required' }, 400)
  }
  if (!(await productExists(c.env.DB, productId))) {
    return c.json({ success: false, data: null, error: 'product_not_found' }, 404)
  }

  // Check trùng theo từng chunk để không vượt giới hạn 100 bound parameters của D1.
  const duplicateSet = new Set<string>()
  for (const part of chunk(contents, DUP_CHECK_CHUNK)) {
    const placeholders = part.map(() => '?').join(', ')
    const { results: existing } = await c.env.DB.prepare(
      `SELECT content FROM product_items WHERE product_id = ? AND content IN (${placeholders})`
    )
      .bind(productId, ...part)
      .all<{ content: string }>()
    for (const row of existing ?? []) duplicateSet.add(row.content)
  }
  const toInsert = contents.filter((content) => !duplicateSet.has(content))
  const duplicates = contents.filter((content) => duplicateSet.has(content))

  let imported = 0
  const errors: string[] = []
  if (toInsert.length > 0) {
    const now = new Date().toISOString()
    // Gom thành câu INSERT nhiều dòng (mỗi dòng 3 param) rồi chia batch để tránh
    // chạm giới hạn query/invocation và thời lượng 30s của D1.
    const rowChunks = chunk(toInsert, INSERT_ROW_CHUNK)
    const stmts = rowChunks.map((rows) => {
      const valuePlaceholders = rows.map(() => "(?, ?, 'available', ?)").join(', ')
      const binds: unknown[] = []
      for (const content of rows) binds.push(productId, content, now)
      return c.env.DB.prepare(
        `INSERT INTO product_items (product_id, content, status, created_at) VALUES ${valuePlaceholders}`
      ).bind(...binds)
    })
    for (const batchPart of chunk(stmts, INSERT_BATCH_STMTS)) {
      try {
        const results = await c.env.DB.batch(batchPart)
        for (const r of results) imported += r.meta.changes ?? 0
      } catch (err) {
        errors.push(err instanceof Error ? err.message : 'db_error')
      }
    }
  }

  return c.json({ success: true, data: { imported, duplicates, errors }, error: null })
})

productItemRoutes.delete('/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!id || Number.isNaN(id)) return c.json({ success: false, data: null, error: 'invalid_product_item_id' }, 400)

  const item = await c.env.DB.prepare('SELECT * FROM product_items WHERE id = ?').bind(id).first<DbProductItem>()
  if (!item) return c.json({ success: false, data: null, error: 'product_item_not_found' }, 404)
  if (item.status !== 'available') {
    return c.json({ success: false, data: null, error: 'product_item_not_deletable' }, 400)
  }

  await c.env.DB.prepare('DELETE FROM product_items WHERE id = ?').bind(id).run()
  return c.json({ success: true, data: { id }, error: null })
})

export { productItemRoutes }
