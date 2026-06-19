/**
 * Mini App business API — prefix `/api/app/*`.
 *
 * Lớp HTTP mỏng (controller) cho Telegram Mini App: KHÔNG viết lại logic nghiệp
 * vụ, chỉ điều phối request → service/util hiện hữu rồi map sang `ApiResponse`.
 *
 * Mọi endpoint dưới prefix này đều qua `miniAppAuth` (`miniAppApi.use('/*', ...)`)
 * nên luôn yêu cầu header `X-Telegram-Init-Data` hợp lệ. Người mua được định danh
 * qua `c.get('user')` (đã JOIN/lọc theo `telegram_id`); controller KHÔNG nhận
 * `user_id` từ client (chống IDOR).
 *
 * File này sẽ được MỞ RỘNG ở các task sau (deposits, orders); giữ cấu trúc phẳng
 * theo từng endpoint để dễ bổ sung.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6,
 * 6.7, 7.1, 7.2, 7.3, 7.5, 8.1, 8.2, 8.3, 8.4, 8.5, 10.1, 10.3, 10.4, 11.1, 11.2, 11.3,
 * 11.4, 12.1, 12.2, 12.3, 15.3, 16.2, 16.3
 */

import { Hono } from 'hono'
import type { Bindings } from '../types'
import type { DbDeposit } from '../types/db'
import type { ApiResponse } from '../types/api'
import type {
  MeDto,
  CategoryListItemDto,
  ProductListItemDto,
  ProductDetailDto,
  PurchaseResultDto,
  DepositCreatedDto,
  CryptoDepositCreatedDto,
  PayosDepositCreatedDto,
  DepositMethodDto,
  DepositStatusDto,
  OrderListItemDto,
  OrderDetailDto,
  BannerDto,
} from '../types/miniapp'
import { miniAppAuth, type MiniAppVariables } from '../middleware/miniapp-auth'
import { formatMoney, formatMoneyFor, buildCurrencyContext } from '../utils/format'
import { transactionService } from '../services/transaction'
import { renderSuccessMessage } from '../utils/telegram-template'
import { loadProductTemplates } from '../services/product-template'
import { resolveLang, setRegion, setLanguage } from '../services/user-locale'
import { isSupportedLang, type Lang, type Region } from '../i18n/locales'
import {
  buildDisplayPlaceholder,
  loadDisplayLang,
  loadProductTranslations,
  loadProductTypeTranslations,
  resolveDisplayText,
} from '../services/i18n-catalog'
import { t } from '../bot/i18n'
import { sendMessage, sendPhoto, sendChunkedMessage } from '../bot/telegram-api'
import { consumeToken, PURCHASE_RULE } from '../bot/rate-limit'
import { depositPolicyMessage } from '../services/deposit-policy'
import { resolveBotToken } from '../services/telegram-config'
import { sePayProvider, buildDepositCaption } from '../services/payments/sepay-provider'
import { cryptoPayProvider } from '../services/payments/cryptopay-provider'
import { payOsProvider } from '../services/payments/payos-provider'
import { isMethodAllowedForRegion, enabledMethodsForRegion, isProviderEnabled } from '../services/payments/registry'
import type { ProviderId } from '../services/payments/types'

type MiniAppEnv = {
  Bindings: Bindings
  Variables: MiniAppVariables
}

/** Lối tắt nhanh hiển thị ở trang chủ; frontend chịu trách nhiệm điều hướng (Req 4.3, 4.4). */
const HOME_SHORTCUTS = ['shop', 'deposit', 'history', 'account'] as const

/**
 * Trần CỨNG số lượng cho mỗi lần mua (chặn trên tuyệt đối). Trần thực tế hiển thị cho
 * client là `min(products.max_per_order, MAX_PURCHASE_QUANTITY)`. Giữ = 50 đồng bộ với
 * `MAX_QTY` của bot để Mini App và bot hành xử nhất quán.
 */
const MAX_PURCHASE_QUANTITY = 50

/** Dữ liệu trang chủ `GET /api/app/home` (Req 4). */
interface HomeDto {
  balance: number
  balance_display: string
  shortcuts: readonly string[]
}

/** Một dòng query danh mục tầng 1. */
interface CategoryListRow {
  id: number
  name: string
  description: string | null
  content: string | null
  emoji: string | null
  image_data: string | null
  sort_order: number
  product_count: number
  stock: number
}

/** Một dòng kết quả query Product bán được (tầng 2), giữ DTO cũ để tương thích Mini App. */
interface CatalogProductRow {
  id: number
  product_type_id: number
  name: string
  description: string | null
  content: string | null
  emoji: string | null
  image_data: string | null
  price: number
  sort_order: number
  max_per_order: number
  category_name: string
  category_description: string | null
  category_content: string | null
  category_emoji: string | null
  stock: number // COUNT(product_items.status='available') — LEFT JOIN nên có thể = 0
}

const miniAppApi = new Hono<MiniAppEnv>()

// Toàn bộ prefix yêu cầu initData hợp lệ (Req 1) — verify per-request, stateless.
miniAppApi.use('/*', miniAppAuth)

async function resolveCategoryDto(
  db: D1Database,
  row: CategoryListRow,
  displayLang: Lang,
  defaultLang: Lang
): Promise<CategoryListItemDto> {
  const translations = await loadProductTypeTranslations(db, row.id)
  const placeholder = buildDisplayPlaceholder(row.id)

  return {
    id: row.id,
    name: resolveDisplayText(translations, 'name', row.name, displayLang, defaultLang, placeholder),
    emoji: row.emoji,
    image_url: row.image_data ?? null,
    description: resolveDisplayText(translations, 'description', row.description, displayLang, defaultLang, placeholder),
    content: resolveDisplayText(translations, 'content', row.content, displayLang, defaultLang, placeholder),
    product_count: row.product_count,
    stock: row.stock,
    in_stock: row.stock > 0,
  }
}

async function resolveCatalogProductDto(
  db: D1Database,
  row: CatalogProductRow,
  displayLang: Lang,
  defaultLang: Lang,
  priceDisplay: string
): Promise<ProductListItemDto> {
  const [productTranslations, categoryTranslations] = await Promise.all([
    loadProductTranslations(db, row.id),
    loadProductTypeTranslations(db, row.product_type_id),
  ])
  const productPlaceholder = buildDisplayPlaceholder(row.id)
  const categoryPlaceholder = buildDisplayPlaceholder(row.product_type_id)
  const categoryName = resolveDisplayText(
    categoryTranslations,
    'name',
    row.category_name,
    displayLang,
    defaultLang,
    categoryPlaceholder
  )

  return {
    id: row.id,
    product_type_id: row.product_type_id,
    category_id: row.product_type_id,
    category_name: categoryName,
    name: resolveDisplayText(productTranslations, 'name', row.name, displayLang, defaultLang, productPlaceholder),
    emoji: row.emoji ?? row.category_emoji,
    image_url: row.image_data ?? null,
    description: resolveDisplayText(
      productTranslations,
      'description',
      row.description,
      displayLang,
      defaultLang,
      productPlaceholder
    ),
    content: resolveDisplayText(productTranslations, 'content', row.content, displayLang, defaultLang, productPlaceholder),
    price: row.price,
    price_display: priceDisplay,
    stock: row.stock,
    in_stock: row.stock > 0,
  }
}

/**
 * GET /me — Thông tin tài khoản + số dư (Req 12).
 *
 * Trả `MeDto` dựng từ `c.get('user')` (bản ghi `users` đã upsert theo `telegram_id`).
 * `balance_display` format qua `formatCurrency` để đồng bộ định dạng tiền tệ (Req 4.2).
 * KHÔNG trả bất kỳ field quản trị nào — chỉ các field định danh người mua (Req 12.3).
 */
miniAppApi.get('/me', async (c) => {
  const user = c.get('user')

  // Currency context theo Region của người mua (USD cho international + valid rate, else VND).
  const lang = await resolveLang(c.env.DB, user)
  const ctx = await buildCurrencyContext(c.env.DB, { lang, region: user.region })

  const body: ApiResponse<MeDto> = {
    success: true,
    data: {
      telegram_id: user.telegram_id,
      username: user.username,
      first_name: user.first_name,
      balance: user.balance,
      balance_display: formatMoneyFor(user.balance, ctx),
      region: user.region,
      language: user.language,
      rate: ctx.rate,
    },
    error: null,
  }

  return c.json(body)
})

/**
 * GET /home — Trang chủ (Req 4).
 *
 * Trả số dư hiện tại của người mua (lấy từ `users` theo `telegram_id`, Req 4.1),
 * `balance_display` đã format (Req 4.2) và danh sách lối tắt nhanh (Req 4.3).
 */
miniAppApi.get('/home', async (c) => {
  const user = c.get('user')

  const lang = await resolveLang(c.env.DB, user)
  const ctx = await buildCurrencyContext(c.env.DB, { lang, region: user.region })

  const body: ApiResponse<HomeDto> = {
    success: true,
    data: {
      balance: user.balance,
      balance_display: formatMoneyFor(user.balance, ctx),
      shortcuts: HOME_SHORTCUTS,
    },
    error: null,
  }

  return c.json(body)
})

/**
 * GET /banners — ảnh banner giới thiệu cho storefront (Req storefront redesign).
 *
 * Chỉ trả banner `is_active = 1`, sắp theo `sort_order`. `image_url` là data URL (base64)
 * hoặc URL HTTPS do admin cấu hình qua CMS. Chưa có banner → mảng rỗng (frontend ẩn carousel).
 */
miniAppApi.get('/banners', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, image_data, link_url FROM banners WHERE is_active = 1 ORDER BY sort_order ASC, id ASC'
  ).all<{ id: number; image_data: string; link_url: string | null }>()

  const data: BannerDto[] = results.map((r) => ({
    id: r.id,
    image_url: r.image_data,
    link_url: r.link_url,
  }))

  const body: ApiResponse<BannerDto[]> = { success: true, data, error: null }
  return c.json(body)
})

/**
 * POST /region — đặt/đổi vùng của người mua (R2.3, R2.4, R5.2).
 *
 * Body `{ region: 'vietnam' | 'international' }`. Cập nhật `setRegion` (set ngôn ngữ
 * khởi tạo nếu user chưa tự đổi). Trả `MeDto` đã cập nhật để frontend đồng bộ ngay.
 */
miniAppApi.post('/region', async (c) => {
  const user = c.get('user')

  let payload: { region?: unknown } = {}
  try {
    payload = await c.req.json()
  } catch {
    // payload rỗng → region không hợp lệ bên dưới.
  }

  const region = payload.region
  if (region !== 'vietnam' && region !== 'international') {
    const bad: ApiResponse<null> = { success: false, data: null, error: 'invalid_region' }
    return c.json(bad, 400)
  }

  await setRegion(c.env.DB, user.id, region as Region)

  // Đọc lại bản ghi để phản ánh region + language (có thể vừa set theo vùng).
  const updated = await c.env.DB.prepare(
    'SELECT region, language, balance FROM users WHERE id = ?'
  )
    .bind(user.id)
    .first<{ region: 'vietnam' | 'international' | null; language: string | null; balance: number }>()

  const effectiveRegion = updated?.region ?? (region as Region)
  const effectiveBalance = updated?.balance ?? user.balance
  const lang = await resolveLang(c.env.DB, { language: updated?.language ?? user.language })
  const ctx = await buildCurrencyContext(c.env.DB, { lang, region: effectiveRegion })

  const body: ApiResponse<MeDto> = {
    success: true,
    data: {
      telegram_id: user.telegram_id,
      username: user.username,
      first_name: user.first_name,
      balance: effectiveBalance,
      balance_display: formatMoneyFor(effectiveBalance, ctx),
      region: updated?.region ?? region,
      language: updated?.language ?? user.language,
      rate: ctx.rate,
    },
    error: null,
  }
  return c.json(body)
})

/**
 * PUT /language — đổi ngôn ngữ hiển thị, độc lập với vùng (R6.2, R6.3, R6.4).
 *
 * Body `{ language: <mã locale> }`. Validate theo registry `SUPPORTED_LANGUAGES`;
 * `setLanguage` đặt `language_locked=1` để đổi vùng sau không ghi đè.
 */
miniAppApi.put('/language', async (c) => {
  const user = c.get('user')

  let payload: { language?: unknown } = {}
  try {
    payload = await c.req.json()
  } catch {
    // payload rỗng → language không hợp lệ bên dưới.
  }

  const language = payload.language
  if (typeof language !== 'string' || !isSupportedLang(language)) {
    const bad: ApiResponse<null> = { success: false, data: null, error: 'invalid_language' }
    return c.json(bad, 400)
  }

  await setLanguage(c.env.DB, user.id, language)

  const body: ApiResponse<{ language: string }> = {
    success: true,
    data: { language },
    error: null,
  }
  return c.json(body)
})

/**
 * GET /deposit-methods — phương thức nạp khả dụng theo vùng hiện tại (R8.3).
 *
 * Region chưa xác định → trả mảng rỗng (frontend sẽ điều hướng onboarding).
 */
miniAppApi.get('/deposit-methods', async (c) => {
  const user = c.get('user')

  const amountUnitByProvider: Record<ProviderId, 'vnd' | 'usdt'> = {
    sepay: 'vnd',
    cryptobot: 'usdt',
    payos: 'vnd',
  }

  // Chỉ provider đã được bật (R7.6) + thuộc vùng (R8.3).
  const ids = user.region === null ? [] : await enabledMethodsForRegion(c.env.DB, user.region)
  const methods: DepositMethodDto[] = ids.map((id) => ({ id, amount_unit: amountUnitByProvider[id] }))

  const body: ApiResponse<DepositMethodDto[]> = {
    success: true,
    data: methods,
    error: null,
  }
  return c.json(body)
})

/**
 * GET /product-types — alias tương thích: danh sách Product bán được + tồn kho.
 *
 * Sau migration 0015, `product_types` là danh mục tầng 1, còn giá/tồn kho thuộc
 * `products` và `product_items`. Endpoint cũ vẫn trả shape `ProductType*Dto` để
 * Mini App hiện tại không vỡ route, nhưng `id` giờ là `products.id`.
 */
miniAppApi.get('/product-types', async (c) => {
  const user = c.get('user')
  const lang = await resolveLang(c.env.DB, user)
  const defaultLang = await loadDisplayLang(c.env.DB)
  const ctx = await buildCurrencyContext(c.env.DB, { lang, region: user.region })

  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.product_type_id, p.name, p.description, p.content, p.emoji,
            p.image_data, p.price, p.sort_order,
            pt.name AS category_name,
            pt.description AS category_description,
            pt.content AS category_content,
            pt.emoji AS category_emoji,
            COUNT(CASE WHEN pi.status = 'available' THEN 1 END) AS stock
     FROM products p
     JOIN product_types pt ON pt.id = p.product_type_id
     LEFT JOIN product_items pi ON pi.product_id = p.id
     WHERE p.is_visible = 1 AND pt.is_visible = 1
     GROUP BY p.id
     ORDER BY pt.sort_order ASC, p.sort_order ASC, p.name ASC`
  ).all<CatalogProductRow>()

  const data: ProductListItemDto[] = await Promise.all(
    results.map((row) =>
      resolveCatalogProductDto(c.env.DB, row, lang, defaultLang, formatMoneyFor(row.price, ctx))
    )
  )

  const body: ApiResponse<ProductListItemDto[]> = {
    success: true,
    data,
    error: null,
  }

  return c.json(body)
})

/**
 * GET /categories — danh sách Product_Type tầng 1.
 */
miniAppApi.get('/categories', async (c) => {
  const user = c.get('user')
  const lang = await resolveLang(c.env.DB, user)
  const defaultLang = await loadDisplayLang(c.env.DB)

  const { results } = await c.env.DB.prepare(
    `SELECT pt.id, pt.name, pt.description, pt.content, pt.emoji, pt.image_data, pt.sort_order,
            COUNT(DISTINCT p.id) AS product_count,
            COUNT(CASE WHEN pi.status = 'available' THEN 1 END) AS stock
     FROM product_types pt
     LEFT JOIN products p ON p.product_type_id = pt.id AND p.is_visible = 1
     LEFT JOIN product_items pi ON pi.product_id = p.id
     WHERE pt.is_visible = 1
     GROUP BY pt.id
     ORDER BY pt.sort_order ASC, pt.name ASC`
  ).all<CategoryListRow>()

  const data = await Promise.all(
    results.map((row) => resolveCategoryDto(c.env.DB, row, lang, defaultLang))
  )
  const body: ApiResponse<CategoryListItemDto[]> = { success: true, data, error: null }
  return c.json(body)
})

/**
 * GET /categories/:id/products — Product trong một danh mục.
 */
miniAppApi.get('/categories/:id/products', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    const notFound: ApiResponse<null> = { success: false, data: null, error: 'not_found' }
    return c.json(notFound, 404)
  }

  const lang = await resolveLang(c.env.DB, user)
  const defaultLang = await loadDisplayLang(c.env.DB)
  const ctx = await buildCurrencyContext(c.env.DB, { lang, region: user.region })

  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.product_type_id, p.name, p.description, p.content, p.emoji,
            p.image_data, p.price, p.sort_order,
            pt.name AS category_name,
            pt.description AS category_description,
            pt.content AS category_content,
            pt.emoji AS category_emoji,
            COUNT(CASE WHEN pi.status = 'available' THEN 1 END) AS stock
     FROM products p
     JOIN product_types pt ON pt.id = p.product_type_id
     LEFT JOIN product_items pi ON pi.product_id = p.id
     WHERE p.product_type_id = ? AND p.is_visible = 1 AND pt.is_visible = 1
     GROUP BY p.id
     ORDER BY p.sort_order ASC, p.name ASC`
  )
    .bind(id)
    .all<CatalogProductRow>()

  const data: ProductListItemDto[] = await Promise.all(
    results.map((row) =>
      resolveCatalogProductDto(c.env.DB, row, lang, defaultLang, formatMoneyFor(row.price, ctx))
    )
  )
  const body: ApiResponse<ProductListItemDto[]> = { success: true, data, error: null }
  return c.json(body)
})

/**
 * GET /product-types/:id — alias tương thích: chi tiết Product bán được.
 */
miniAppApi.get('/product-types/:id', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    const notFound: ApiResponse<null> = { success: false, data: null, error: 'not_found' }
    return c.json(notFound, 404)
  }

  const row = await c.env.DB.prepare(
    `SELECT p.id, p.product_type_id, p.name, p.description, p.content, p.emoji,
            p.image_data, p.price, p.sort_order, p.max_per_order,
            pt.name AS category_name,
            pt.description AS category_description,
            pt.content AS category_content,
            pt.emoji AS category_emoji,
            COUNT(CASE WHEN pi.status = 'available' THEN 1 END) AS stock
     FROM products p
     JOIN product_types pt ON pt.id = p.product_type_id
     LEFT JOIN product_items pi ON pi.product_id = p.id
     WHERE p.id = ? AND p.is_visible = 1 AND pt.is_visible = 1
     GROUP BY p.id`
  )
    .bind(id)
    .first<CatalogProductRow>()

  if (!row) {
    const notFound: ApiResponse<null> = { success: false, data: null, error: 'not_found' }
    return c.json(notFound, 404)
  }

  const lang = await resolveLang(c.env.DB, user)
  const defaultLang = await loadDisplayLang(c.env.DB)
  const ctx = await buildCurrencyContext(c.env.DB, { lang, region: user.region })
  const productDto = await resolveCatalogProductDto(
    c.env.DB,
    row,
    lang,
    defaultLang,
    formatMoneyFor(row.price, ctx)
  )

  const data: ProductDetailDto = {
    ...productDto,
    max_quantity: Math.min(row.max_per_order, MAX_PURCHASE_QUANTITY),
  }

  const body: ApiResponse<ProductDetailDto> = {
    success: true,
    data,
    error: null,
  }

  return c.json(body)
})

/**
 * POST /purchase — Mua hàng atomic (Req 6, 7, 15.3, 16.2, 16.3).
 *
 * Controller mỏng: KHÔNG viết lại logic atomic — chỉ điều phối validate → rate-limit →
 * load Product bán được → `transactionService.executePurchase` (reuse) → đồng bộ tin nhắn bot
 * sau commit. Tổng tiền tính SERVER-SIDE (`price × quantity`), KHÔNG tin client (Req 6.1, 16.3).
 *
 * Request body: `{ productId: number, quantity: number }`. `productTypeId` vẫn nhận như alias legacy.
 *
 * Luồng mã lỗi:
 *  - JSON hỏng / `quantity` không phải integer trong `[1, MAX_PURCHASE_QUANTITY]` → 400 `validation_error` (Req 6.1)
 *  - double-tap vượt `PURCHASE_RULE` (reuse rate-limit của bot) → 429 `rate_limited`
 *  - Product không tồn tại hoặc bị ẩn → 404 `not_found` (Req 5.4)
 *  - lỗi service: `insufficient_balance`/`insufficient_stock` → 409, `db_error` → 500 (Req 6.3, 6.4)
 *
 * Sau commit (Req 7): dựng HTML qua `renderSuccessMessage` rồi `sendMessage` fire-and-forget qua
 * `c.executionCtx.waitUntil(promise.catch(log))` — lỗi gửi tin KHÔNG rollback giao dịch đã commit (Req 7.5).
 * Trả `PurchaseResultDto` gồm `order_id`, `quantity`, `total_amount`, số dư mới + display, `contents` (Req 6.6, 6.7).
 */
miniAppApi.post('/purchase', async (c) => {
  const user = c.get('user')

  // Đọc body — guard JSON hỏng → coi là input không hợp lệ (Req 6.1).
  let payload: { productId?: unknown; productTypeId?: unknown; quantity?: unknown }
  try {
    payload = await c.req.json()
  } catch {
    const bad: ApiResponse<null> = { success: false, data: null, error: 'validation_error' }
    return c.json(bad, 400)
  }

  const productId = Number(payload.productId ?? payload.productTypeId)
  const quantity = Number(payload.quantity)

  // Validate quantity: integer trong [1, MAX_PURCHASE_QUANTITY] (Req 6.1).
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_PURCHASE_QUANTITY) {
    const bad: ApiResponse<null> = { success: false, data: null, error: 'validation_error' }
    return c.json(bad, 400)
  }

  // productId không hợp lệ → 404 (đồng bộ ngữ nghĩa với GET /product-types/:id).
  if (!Number.isInteger(productId) || productId <= 0) {
    const notFound: ApiResponse<null> = { success: false, data: null, error: 'not_found' }
    return c.json(notFound, 404)
  }

  // Rate-limit double-tap (reuse consumeToken + PURCHASE_RULE) → 429. Key theo telegram_id (Req 16.3).
  const verdict = consumeToken(`app:buy:${user.telegram_id}`, PURCHASE_RULE)
  if (!verdict.allowed) {
    const limited: ApiResponse<null> = { success: false, data: null, error: 'rate_limited' }
    return c.json(limited, 429)
  }

  // Lấy Product đang hiển thị kèm danh mục cha — ẩn/không tồn tại → 404 (Req 5.4).
  const product = await c.env.DB.prepare(
    `SELECT p.id, p.product_type_id, p.name, p.description, p.content, p.emoji,
            p.image_data, p.price, p.sort_order, p.max_per_order,
            pt.name AS category_name,
            pt.description AS category_description,
            pt.content AS category_content,
            pt.emoji AS category_emoji,
            COUNT(CASE WHEN pi.status = 'available' THEN 1 END) AS stock
     FROM products p
     JOIN product_types pt ON pt.id = p.product_type_id
     LEFT JOIN product_items pi ON pi.product_id = p.id
     WHERE p.id = ? AND p.is_visible = 1 AND pt.is_visible = 1
     GROUP BY p.id`
  )
    .bind(productId)
    .first<CatalogProductRow>()
  if (!product) {
    const notFound: ApiResponse<null> = { success: false, data: null, error: 'not_found' }
    return c.json(notFound, 404)
  }

  // Trần số lượng/đơn theo cấu hình sản phẩm (kẹp dưới trần cứng) — vượt → 400 (Req 6.1).
  const maxPerOrder = Math.min(product.max_per_order, MAX_PURCHASE_QUANTITY)
  if (quantity > maxPerOrder) {
    const bad: ApiResponse<null> = { success: false, data: null, error: 'validation_error' }
    return c.json(bad, 400)
  }

  // Tổng tiền tính server-side (Req 6.1, 16.3) — KHÔNG tin client.
  const totalAmount = product.price * quantity

  // Giao dịch atomic (Req 6.2..6.5, 16.2) — reuse nguyên service, truyền product.price làm unitPrice.
  const result = await transactionService.executePurchase(c.env.DB, user.id, product.id, quantity, product.price)

  if (result.success === false) {
    const statusByError = {
      insufficient_balance: 409,
      insufficient_stock: 409,
      db_error: 500,
    } as const
    const errorCode = result.error ?? 'db_error'
    const fail: ApiResponse<null> = { success: false, data: null, error: errorCode }
    return c.json(fail, statusByError[errorCode])
  }

  const productItems = result.productItems ?? []
  const contents = productItems.map((p) => p.content)
  // executePurchase trả số dư sau commit từ UPDATE ... RETURNING để tránh lệch khi cùng user mua đồng thời.
  const balanceAfter = result.balanceAfter ?? user.balance - totalAmount

  // Đồng bộ bot SAU commit (Req 7) — fire-and-forget, lỗi gửi tin KHÔNG rollback (Req 7.5).
  // renderSuccessMessage tự escape giá trị động (content/name) (Req 7.4, 15.1).
  const lang = await resolveLang(c.env.DB, user)
  const defaultLang = await loadDisplayLang(c.env.DB)
  const ctx = await buildCurrencyContext(c.env.DB, { lang, region: user.region })
  const templatesByLang = await loadProductTemplates(c.env.DB, product.id)
  const displayName = resolveDisplayText(
    await loadProductTranslations(c.env.DB, product.id),
    'name',
    product.name,
    lang,
    defaultLang,
    buildDisplayPlaceholder(product.id)
  )
  const html = renderSuccessMessage(
    templatesByLang,
    {
      emoji: product.emoji ?? product.category_emoji ?? '',
      name: displayName,
      quantity,
      totalAmount,
      balanceAfter,
      contents,
    },
    ctx,
    defaultLang
  )
  const notify = sendChunkedMessage(
    await resolveBotToken(c.env.DB, c.env),
    user.telegram_id,
    undefined,
    html,
    { parse_mode: 'HTML' }
  ).catch((err) => console.error('[MiniApp] notify purchase failed:', err))
  c.executionCtx?.waitUntil?.(notify)

  // Trả nội dung tài khoản + số dư mới cho app (Req 6.6, 6.7).
  const data: PurchaseResultDto = {
    order_id: result.order?.id ?? 0,
    quantity,
    total_amount: totalAmount,
    new_balance: balanceAfter,
    new_balance_display: formatMoneyFor(balanceAfter, ctx),
    contents,
  }

  const body: ApiResponse<PurchaseResultDto> = {
    success: true,
    data,
    error: null,
  }

  return c.json(body)
})

/**
 * POST /deposits — Tạo yêu cầu nạp + VietQR (Req 8.1, 8.2, 8.3, 8.4, 8.5, 10.1, 10.3, 10.4).
 *
 * Controller mỏng: validate khoảng số tiền theo `system_config` → rate-limit → huỷ pending
 * cũ → tạo `deposits` pending với `transfer_code` duy nhất → dựng `qr_url` VietQR → đồng bộ
 * ảnh QR qua bot sau commit. Người mua định danh qua `c.get('user')`; `transfer_code` sinh
 * theo `telegram_id` (khớp flow bot `handleDepositAmount`).
 *
 * Request body: `{ amount: number }` (đọc qua `c.req.json()`).
 *
 * Luồng mã lỗi:
 *  - JSON hỏng / `amount` không phải integer trong `[min_deposit, max_deposit]` → 400 với message
 *    nêu rõ giới hạn (đã `formatCurrency`); KHÔNG tạo bản ghi `deposits` (Req 8.2).
 *  - vi phạm luật nạp dùng chung (`checkDepositPolicy`): quá 3 deposit pending còn hiệu lực
 *    hoặc chưa qua cooldown 5 phút → 429 với `error` là message tiếng Việt cụ thể.
 *
 * Sau commit (Req 10.1): dựng caption qua `buildDepositCaption` (escape giá trị động — Req 10.3)
 * rồi `sendPhoto` fire-and-forget qua `c.executionCtx.waitUntil(promise.catch(log))` — lỗi gửi tin
 * KHÔNG rollback yêu cầu nạp đã tạo (Req 10.4). Trả `DepositCreatedDto`.
 */
miniAppApi.post('/deposits', async (c) => {
  const user = c.get('user')

  // Đọc body — guard JSON hỏng → coi như amount không hợp lệ (provider trả lỗi `limit`).
  let payload: { amount?: unknown; method?: unknown } = {}
  try {
    payload = await c.req.json()
  } catch {
    // Giữ payload rỗng → amount = NaN → provider trả lỗi hạn mức (KHÔNG tạo deposit — Req 8.2).
  }

  const amount = Number(payload.amount)
  // method mặc định 'sepay' để giữ tương thích client cũ (chỉ gửi {amount}).
  const method: ProviderId =
    payload.method === 'cryptobot' ? 'cryptobot' : payload.method === 'payos' ? 'payos' : 'sepay'

  // Enforce phương thức theo vùng (R8.4). Region chưa xác định → bắt onboarding.
  if (user.region === null) {
    const need: ApiResponse<null> = { success: false, data: null, error: 'region_required' }
    return c.json(need, 400)
  }
  if (!isMethodAllowedForRegion(user.region, method)) {
    const unavailable: ApiResponse<null> = {
      success: false,
      data: null,
      error: 'method_unavailable',
    }
    return c.json(unavailable, 400)
  }

  // Enforce cờ bật provider (R7.6): provider mới chưa được admin mở → từ chối.
  if (!(await isProviderEnabled(c.env.DB, method))) {
    const unavailable: ApiResponse<null> = {
      success: false,
      data: null,
      error: 'method_unavailable',
    }
    return c.json(unavailable, 400)
  }

  const provider =
    method === 'cryptobot' ? cryptoPayProvider : method === 'payos' ? payOsProvider : sePayProvider

  // Ngôn ngữ hiển thị của user (đã resolve) — message lỗi/hạn mức trả về theo lang (R4.2).
  const depositLang = await resolveLang(c.env.DB, user)

  const result = await provider.createDeposit({
    db: c.env.DB,
    env: c.env,
    userId: user.id,
    telegramId: user.telegram_id,
    rawAmount: amount,
    lang: depositLang,
    channel: 'miniapp',
  })

  if (result.success === false) {
    const err = result.error
    if (err.type === 'policy') {
      // Vi phạm luật nạp dùng chung → 429 kèm message theo lang (Req 8.3).
      const limited: ApiResponse<null> = {
        success: false,
        data: null,
        error: depositPolicyMessage(
          {
            allowed: false,
            reason: err.reason,
            retryAfterMs: err.retryAfterMs,
          },
          depositLang
        ),
      }
      return c.json(limited, 429)
    }
    if (err.type === 'limit') {
      // Số tiền ngoài khoảng → 400, message nêu rõ giới hạn, KHÔNG tạo deposit (Req 8.2, 13.4).
      const invalid: ApiResponse<null> = { success: false, data: null, error: err.message }
      return c.json(invalid, 400)
    }
    // provider_error: lỗi tạo bản ghi nạp / createInvoice thất bại (R10.4).
    const failed: ApiResponse<null> = { success: false, data: null, error: err.message }
    return c.json(failed, 500)
  }

  // --- Nhánh CryptoBot: trả pay_url (Req 10.1, 10.3) ---
  if (method === 'cryptobot') {
    const { depositId, crypto } = result.output
    if (!crypto) {
      const failed: ApiResponse<null> = {
        success: false,
        data: null,
        error: t(depositLang, 'deposit.generic_error'),
      }
      return c.json(failed, 500)
    }
    const data: CryptoDepositCreatedDto = {
      deposit_id: depositId,
      method: 'cryptobot',
      pay_url: crypto.payUrl,
      usdt_amount: crypto.usdtAmount,
      invoice_id: crypto.invoiceId,
      credit_vnd: crypto.creditVnd,
      credit_vnd_display: formatMoney(crypto.creditVnd, depositLang),
      status: 'pending',
    }
    const body: ApiResponse<CryptoDepositCreatedDto> = { success: true, data, error: null }
    return c.json(body)
  }

  // --- Nhánh PayOS: trả checkout_url (Req 18.4, 18.5, 8.4) ---
  if (method === 'payos') {
    const { depositId, payos } = result.output
    if (!payos) {
      const failed: ApiResponse<null> = {
        success: false,
        data: null,
        error: t(depositLang, 'deposit.generic_error'),
      }
      return c.json(failed, 500)
    }
    const data: PayosDepositCreatedDto = {
      deposit_id: depositId,
      method: 'payos',
      checkout_url: payos.checkoutUrl,
      amount,
      amount_display: formatMoney(amount, depositLang),
      status: 'pending',
    }
    const body: ApiResponse<PayosDepositCreatedDto> = { success: true, data, error: null }
    return c.json(body)
  }

  // --- Nhánh SePay: VietQR (giữ nguyên shape DepositCreatedDto) ---
  const { depositId, vietqr } = result.output
  if (!vietqr) {
    const failed: ApiResponse<null> = {
      success: false,
      data: null,
      error: t(depositLang, 'deposit.generic_error'),
    }
    return c.json(failed, 500)
  }

  // Đồng bộ bot SAU commit (Req 10.1) — gửi ảnh VietQR + caption fire-and-forget,
  // lỗi gửi tin chỉ log, KHÔNG rollback yêu cầu nạp đã tạo (Req 10.4).
  // Caption dùng chung với flow bot (`buildDepositCaption`) — escape giá trị động (Req 10.3).
  const caption = buildDepositCaption(vietqr.bank, vietqr.amountVnd, vietqr.transferCode, depositLang)
  const notify = sendPhoto(
    await resolveBotToken(c.env.DB, c.env),
    user.telegram_id,
    vietqr.qrUrl,
    {
      caption,
      parse_mode: 'HTML',
    }
  ).catch((err) => console.error('[MiniApp] notify deposit failed:', err))
  c.executionCtx?.waitUntil?.(notify)

  // Trả thông tin chuyển khoản + VietQR cho app (Req 8.4, 8.5) — GIỮ NGUYÊN shape DepositCreatedDto.
  const data: DepositCreatedDto = {
    deposit_id: depositId,
    transfer_code: vietqr.transferCode,
    amount: vietqr.amountVnd,
    amount_display: formatMoney(vietqr.amountVnd, depositLang),
    bank_name: vietqr.bank.bankName,
    bank_account: vietqr.bank.bankAccount,
    bank_owner: vietqr.bank.bankOwner,
    qr_url: vietqr.qrUrl,
    status: 'pending',
  }

  const body: ApiResponse<DepositCreatedDto> = {
    success: true,
    data,
    error: null,
  }

  return c.json(body)
})

/**
 * GET /deposits/:id — Trạng thái yêu cầu nạp để frontend poll (Req 8.5, 9.1).
 *
 * READ-ONLY: chỉ đọc trạng thái deposit cho frontend poll (`pending` → `completed`).
 * Việc cộng tiền + chuyển `deposits` sang `completed` do `/webhook/sepay` đảm nhận (Req 9.1);
 * endpoint này TUYỆT ĐỐI KHÔNG sửa `balance` hay bản ghi `deposits`.
 *
 * Guard chủ sở hữu: SELECT `WHERE id = ? AND user_id = ?` (`user.id` từ `c.get('user')`).
 * Deposit không tồn tại HOẶC không thuộc người mua hiện tại đều trả 404 `not_found` —
 * KHÔNG phân biệt hai trường hợp để tránh dò ID (đồng bộ ngữ nghĩa với `GET /orders/:id`).
 *
 * `:id` parse sang integer — không hợp lệ → 404.
 *
 * Trả `DepositStatusDto` `{ deposit_id, status, amount, new_balance? }`. `new_balance` CHỈ
 * có khi `status === 'completed'`, set bằng số dư HIỆN TẠI của người mua (`user.balance` —
 * phản ánh bản ghi `users` mới nhất từ upsert/select của middleware sau khi SePay cộng tiền).
 */
miniAppApi.get('/deposits/:id', async (c) => {
  const user = c.get('user')

  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    const notFound: ApiResponse<null> = { success: false, data: null, error: 'not_found' }
    return c.json(notFound, 404)
  }

  // Guard chủ sở hữu — chỉ lấy deposit thuộc user.id (chống dò ID/IDOR). Chỉ đọc.
  const deposit = await c.env.DB.prepare('SELECT id, provider, status, amount FROM deposits WHERE id = ? AND user_id = ?')
    .bind(id, user.id)
    .first<Pick<DbDeposit, 'id' | 'provider' | 'status' | 'amount'>>()

  // Không tồn tại HOẶC không thuộc người mua → 404 (không phân biệt) (Req 9.1).
  if (!deposit) {
    const notFound: ApiResponse<null> = { success: false, data: null, error: 'not_found' }
    return c.json(notFound, 404)
  }

  const data: DepositStatusDto = {
    deposit_id: deposit.id,
    provider: deposit.provider,
    status: deposit.status,
    amount: deposit.amount,
  }

  // new_balance CHỈ trả khi đã completed — số dư hiện tại từ middleware (Req 8.5).
  // Endpoint chỉ đọc; số dư đã được /webhook/sepay cộng trước đó (Req 9.1).
  if (deposit.status === 'completed') {
    // Currency context theo Region người mua để hiển thị số dư đúng (USD/VND).
    const lang = await resolveLang(c.env.DB, user)
    const ctx = await buildCurrencyContext(c.env.DB, { lang, region: user.region })
    data.new_balance = user.balance
    data.new_balance_display = formatMoneyFor(user.balance, ctx)
  }

  const body: ApiResponse<DepositStatusDto> = {
    success: true,
    data,
    error: null,
  }

  return c.json(body)
})

/**
 * POST /deposits/:id/cancel — Huỷ một yêu cầu nạp đang chờ của người mua.
 *
 * Guard chủ sở hữu: chỉ huỷ deposit thuộc `user.id` (chống IDOR). Chỉ huỷ khi đang
 * `pending` (idempotent với trạng thái khác). Đồng bộ hành vi với flow huỷ của bot
 * (`handleDepositCancel`): chuyển `deposits.status` sang `cancelled`, KHÔNG đụng `balance`.
 *
 * `:id` parse sang integer — không hợp lệ → 404. Deposit không tồn tại / không thuộc
 * người mua → 404 `not_found` (không phân biệt, tránh dò ID). Deposit không còn `pending`
 * → 409 `not_pending`. Deposit `provider = 'payos'` → 409 `payos_not_cancellable` (R23):
 * không cho huỷ thủ công, giữ nguyên `pending` để TTL→`expired` vẫn cộng được nếu thanh
 * toán tới sau.
 */
miniAppApi.post('/deposits/:id/cancel', async (c) => {
  const user = c.get('user')

  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    const notFound: ApiResponse<null> = { success: false, data: null, error: 'not_found' }
    return c.json(notFound, 404)
  }

  // Guard chủ sở hữu — chỉ lấy deposit thuộc user.id.
  const deposit = await c.env.DB.prepare(
    'SELECT id, provider, status, amount FROM deposits WHERE id = ? AND user_id = ?'
  )
    .bind(id, user.id)
    .first<Pick<DbDeposit, 'id' | 'provider' | 'status' | 'amount'>>()

  if (!deposit) {
    const notFound: ApiResponse<null> = { success: false, data: null, error: 'not_found' }
    return c.json(notFound, 404)
  }

  // Chỉ huỷ được khi đang chờ thanh toán.
  if (deposit.status !== 'pending') {
    const conflict: ApiResponse<null> = { success: false, data: null, error: 'not_pending' }
    return c.json(conflict, 409)
  }

  // PayOS (R23): KHÔNG cho huỷ thủ công. Giữ nguyên `pending` để TTL→`expired`
  // qua cron vẫn cho `completeDeposit` cộng tiền nếu thanh toán xác nhận tới sau.
  if (deposit.provider === 'payos') {
    const conflict: ApiResponse<null> = {
      success: false,
      data: null,
      error: 'payos_not_cancellable',
    }
    return c.json(conflict, 409)
  }

  await c.env.DB.prepare("UPDATE deposits SET status = 'cancelled' WHERE id = ?")
    .bind(deposit.id)
    .run()

  const data: DepositStatusDto = {
    deposit_id: deposit.id,
    provider: deposit.provider,
    status: 'cancelled',
    amount: deposit.amount,
  }
  const body: ApiResponse<DepositStatusDto> = { success: true, data, error: null }
  return c.json(body)
})

/**
 * Phân trang lịch sử đơn hàng (Req 11.1).
 *
 * `page` mặc định 1 (tối thiểu 1); `limit` mặc định 20, trần 100 để tránh
 * client yêu cầu trang quá lớn gây tải DB. Giá trị không hợp lệ → fallback default.
 */
const DEFAULT_ORDERS_PAGE = 1
const DEFAULT_ORDERS_LIMIT = 20
const MAX_ORDERS_LIMIT = 100

/** Parse query `page` sang integer ≥ 1; không hợp lệ → default. */
function parseOrdersPage(raw: string | undefined): number {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_ORDERS_PAGE
}

/** Parse query `limit` sang integer trong `[1, MAX_ORDERS_LIMIT]`; không hợp lệ → default. */
function parseOrdersLimit(raw: string | undefined): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) return DEFAULT_ORDERS_LIMIT
  return Math.min(n, MAX_ORDERS_LIMIT)
}

/** Một dòng kết quả query danh sách/chi tiết đơn hàng (Req 11.1, 11.2, 11.3). */
interface OrderRow {
  id: number
  quantity: number
  total_amount: number
  status: 'completed' | 'refunded'
  created_at: string
  product_id: number
  product_name: string
  emoji: string | null
}

/**
 * GET /orders — Lịch sử đơn hàng của người mua hiện tại (Req 11.1, 11.2, 11.4).
 *
 * Cô lập dữ liệu theo người mua: query `WHERE o.user_id = ?` với `user.id` lấy từ
 * `c.get('user')` (đã JOIN/lọc qua `telegram_id`), KHÔNG nhận `user_id` từ client.
   * `JOIN products` để lấy `name`/`emoji`, `ORDER BY o.created_at DESC` (mới nhất
 * trước). Phân trang `LIMIT/OFFSET` theo query `page`/`limit`; `meta` mang `total`
 * (đếm cùng điều kiện WHERE), `page`, `limit`. Khi người mua chưa có đơn → trả mảng
 * rỗng `[]` (Req 11.4), `meta.total = 0`.
 */
miniAppApi.get('/orders', async (c) => {
  const user = c.get('user')

  const page = parseOrdersPage(c.req.query('page'))
  const limit = parseOrdersLimit(c.req.query('limit'))
  const offset = (page - 1) * limit

  const lang = await resolveLang(c.env.DB, user)
  const ctx = await buildCurrencyContext(c.env.DB, { lang, region: user.region })

  // Đếm tổng số đơn theo cùng điều kiện WHERE để dựng meta (Req 11.1).
  const totalRow = await c.env.DB.prepare('SELECT COUNT(*) AS total FROM orders WHERE user_id = ?')
    .bind(user.id)
    .first<{ total: number }>()
  const total = totalRow?.total ?? 0

  // Trang đơn hàng — sắp xếp mới nhất trước (Req 11.1, 11.2).
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.quantity, o.total_amount, o.status, o.created_at,
            p.id AS product_id,
            p.name AS product_name,
            COALESCE(p.emoji, pt.emoji) AS emoji
     FROM orders o
     JOIN products p ON p.id = o.product_id
     JOIN product_types pt ON pt.id = p.product_type_id
     WHERE o.user_id = ?
     ORDER BY o.created_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(user.id, limit, offset)
    .all<OrderRow>()

  // Mảng rỗng khi chưa có đơn (Req 11.4).
  const defaultLang = await loadDisplayLang(c.env.DB)
  const data: OrderListItemDto[] = await Promise.all(
    results.map(async (row) => {
      const translations = await loadProductTranslations(c.env.DB, row.product_id)
      return {
        id: row.id,
        product_name: resolveDisplayText(
          translations,
          'name',
          row.product_name,
          lang,
          defaultLang,
          buildDisplayPlaceholder(row.product_id)
        ),
        emoji: row.emoji,
        quantity: row.quantity,
        total_amount: row.total_amount,
        total_display: formatMoneyFor(row.total_amount, ctx),
        status: row.status,
        created_at: row.created_at,
      }
    })
  )

  const body: ApiResponse<OrderListItemDto[]> = {
    success: true,
    data,
    error: null,
    meta: { total, page, limit },
  }

  return c.json(body)
})

/**
 * GET /orders/:id — Chi tiết đơn + nội dung tài khoản (Req 11.3, 15.3).
 *
 * Guard chủ sở hữu: SELECT `WHERE o.id = ? AND o.user_id = ?` (`user.id` từ
 * `c.get('user')`). Đơn không tồn tại HOẶC không thuộc người mua hiện tại đều trả
 * 404 `not_found` — KHÔNG phân biệt hai trường hợp để tránh dò ID (Req 15.3, chống IDOR).
   * CHỈ khi đơn thuộc người mua mới truy vấn và trả `contents` (`product_items.content`) — bảo
 * đảm KHÔNG lộ nội dung đơn của người khác (Req 15.3).
 *
 * `:id` parse sang integer — không hợp lệ → 404.
 */
miniAppApi.get('/orders/:id', async (c) => {
  const user = c.get('user')

  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) {
    const notFound: ApiResponse<null> = { success: false, data: null, error: 'not_found' }
    return c.json(notFound, 404)
  }

  // Guard chủ sở hữu — chỉ lấy đơn thuộc user.id (Req 15.3). Rỗng → 404 (không phân biệt).
  const order = await c.env.DB.prepare(
    `SELECT o.id, o.quantity, o.total_amount, o.status, o.created_at,
            p.id AS product_id,
            p.name AS product_name,
            COALESCE(p.emoji, pt.emoji) AS emoji
     FROM orders o
     JOIN products p ON p.id = o.product_id
     JOIN product_types pt ON pt.id = p.product_type_id
     WHERE o.id = ? AND o.user_id = ?`
  )
    .bind(id, user.id)
    .first<OrderRow>()

  if (!order) {
    const notFound: ApiResponse<null> = { success: false, data: null, error: 'not_found' }
    return c.json(notFound, 404)
  }

  // Chỉ truy vấn nội dung khi đã xác nhận đơn thuộc người mua (Req 15.3).
  const { results } = await c.env.DB.prepare(
    `SELECT pi.content
     FROM order_items oi
     JOIN product_items pi ON pi.id = oi.product_item_id
     WHERE oi.order_id = ?`
  )
    .bind(order.id)
    .all<{ content: string }>()

  const lang = await resolveLang(c.env.DB, user)
  const defaultLang = await loadDisplayLang(c.env.DB)
  const ctx = await buildCurrencyContext(c.env.DB, { lang, region: user.region })
  const productTranslations = await loadProductTranslations(c.env.DB, order.product_id)

  const data: OrderDetailDto = {
    id: order.id,
    product_name: resolveDisplayText(
      productTranslations,
      'name',
      order.product_name,
      lang,
      defaultLang,
      buildDisplayPlaceholder(order.product_id)
    ),
    emoji: order.emoji,
    quantity: order.quantity,
    total_amount: order.total_amount,
    total_display: formatMoneyFor(order.total_amount, ctx),
    status: order.status,
    created_at: order.created_at,
    contents: results.map((r) => r.content),
  }

  const body: ApiResponse<OrderDetailDto> = {
    success: true,
    data,
    error: null,
  }

  return c.json(body)
})

export { miniAppApi }
