import { Hono } from 'hono'
import type { Bindings } from '../../types'
import type { AdminVariables } from '../../middleware/jwt-auth'
import { jwtAuth } from '../../middleware/jwt-auth'
import type { DbBanner } from '../../types/db'

type BannerEnv = {
  Bindings: Bindings
  Variables: AdminVariables
}

/** Trần số banner để tránh lạm dụng + giữ DB nhẹ (D1 lưu data URL). */
const MAX_BANNERS = 12
/** Trần kích thước mỗi chuỗi ảnh (~700KB data URL). CMS nén client-side trước khi gửi. */
const MAX_IMAGE_LEN = 700_000

const bannerRoutes = new Hono<BannerEnv>()

bannerRoutes.use('/*', jwtAuth)

/** Một banner do client gửi lên khi lưu (PUT). */
interface BannerInput {
  image_data?: unknown
  link_url?: unknown
  is_active?: unknown
}

/** Hợp lệ khi là data URL ảnh hoặc URL HTTPS, trong giới hạn độ dài. */
function isValidImageData(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (v.length === 0 || v.length > MAX_IMAGE_LEN) return false
  return /^data:image\/(png|jpe?g|webp|gif);base64,/.test(v) || /^https:\/\//.test(v)
}

/**
 * GET /banners — danh sách banner (mọi trạng thái), sắp theo sort_order.
 * Dùng cho CMS quản trị (gồm cả banner đang ẩn).
 */
bannerRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, image_data, link_url, sort_order, is_active, created_at FROM banners ORDER BY sort_order ASC, id ASC'
  ).all<DbBanner>()

  return c.json({ success: true, data: results, error: null })
})

/**
 * PUT /banners — thay TOÀN BỘ tập banner (repeater).
 * Body: { banners: [{ image_data, link_url?, is_active? }] } theo đúng thứ tự hiển thị.
 * Xoá hết bản ghi cũ rồi chèn lại trong một batch (atomic). sort_order = chỉ số mảng.
 */
bannerRoutes.put('/', async (c) => {
  let body: { banners?: unknown } = {}
  try {
    body = await c.req.json()
  } catch {
    return c.json({ success: false, data: null, error: 'invalid_body' }, 400)
  }

  const list = body.banners
  if (!Array.isArray(list)) {
    return c.json({ success: false, data: null, error: 'banners_required' }, 400)
  }
  if (list.length > MAX_BANNERS) {
    return c.json({ success: false, data: null, error: 'too_many_banners' }, 400)
  }

  // Validate từng phần tử trước khi ghi (fail-fast, không ghi một phần).
  const rows: { image_data: string; link_url: string | null; is_active: number }[] = []
  for (const raw of list as BannerInput[]) {
    if (!isValidImageData(raw.image_data)) {
      return c.json({ success: false, data: null, error: 'invalid_image' }, 400)
    }
    const link =
      typeof raw.link_url === 'string' && raw.link_url.trim() !== '' ? raw.link_url.trim() : null
    if (link !== null && !/^https?:\/\//.test(link)) {
      return c.json({ success: false, data: null, error: 'invalid_link' }, 400)
    }
    rows.push({
      image_data: (raw.image_data as string).trim(),
      link_url: link,
      is_active: raw.is_active === false || raw.is_active === 0 ? 0 : 1,
    })
  }

  const now = new Date().toISOString()
  const stmts: D1PreparedStatement[] = [c.env.DB.prepare('DELETE FROM banners')]
  rows.forEach((r, idx) => {
    stmts.push(
      c.env.DB.prepare(
        'INSERT INTO banners (image_data, link_url, sort_order, is_active, created_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(r.image_data, r.link_url, idx, r.is_active, now)
    )
  })

  await c.env.DB.batch(stmts)

  return c.json({ success: true, data: { count: rows.length }, error: null })
})

export { bannerRoutes }
