/**
 * Catalog migration mapping — hàm THUẦN (pure) phản chiếu logic của
 * `migrations/0015_product_three_tier_i18n.sql` ở dạng in-memory, không chạm DB/IO.
 *
 * Mục đích: tách ngữ nghĩa ánh xạ "hai tầng → ba tầng" ra khỏi SQL để kiểm chứng
 * bằng property-based testing (task 2.2/2.3). Mọi quyết định ánh xạ ở đây phải
 * khớp 1:1 với migration 0015:
 *   - GIỮ NGUYÊN id: products MỚI.id = product_types CŨ.id (D4, R2.2).
 *   - Mỗi `category` DISTINCT (khác null/rỗng sau trim) → đúng 1 danh mục (R2.5).
 *   - Mọi bản ghi thiếu `category` (null/rỗng/whitespace) → danh mục mặc định id=1;
 *     không tạo default nếu không có bản ghi thiếu category (R2.6, R2.12).
 *   - Category hợp lệ trùng tên hiển thị default vẫn là danh mục riêng, nhờ map theo
 *     category gốc thay vì lookup bằng tên hiển thị (R2.13).
 *   - Kho cũ (`products` CŨ) → `product_items`, `type_id` → `product_id`, GIỮ NGUYÊN
 *     content/status/buyer_id/order_id/created_at/sold_at (R2.3, R2.4).
 *   - orders.product_type_id → product_id (giữ giá trị id), order_items.product_id →
 *     product_item_id (giữ giá trị id) (R2.7, R9.6).
 *   - product_type_templates copy 1:1, không thêm/xoá/sửa bản ghi nào (R11.1).
 *
 * Hàm tất định (deterministic): cùng đầu vào → cùng đầu ra. Id danh mục sinh thêm
 * được gán theo thứ tự alphabet của category đã trim, bắt đầu từ 2 nếu có danh mục
 * mặc định, hoặc từ 1 nếu không có danh mục mặc định.
 */

import type {
  DbProductType,
  DbProduct,
  DbProductItem,
  DbOrder,
  DbOrderItem,
  DbProductTypeTemplate,
} from '../types/db'

/** Danh mục mặc định cố định, duy nhất khi có bản ghi thiếu `category` (R2.6, R2.12). */
export const DEFAULT_CATEGORY_ID = 1
export const DEFAULT_CATEGORY_NAME = 'Chưa phân loại'
/** Mốc thời gian mặc định cho bản ghi danh mục sinh mới (migration dùng datetime('now')). */
export const DEFAULT_TIMESTAMP = '1970-01-01 00:00:00'

// ---------------------------------------------------------------------------
// Mô hình "DB cũ" (hai tầng) — in-memory, phản chiếu schema trước migration 0015.
// ---------------------------------------------------------------------------

/**
 * `product_types` CŨ: vừa là danh mục vừa là sản phẩm có giá.
 * Các cột tích luỹ qua 0001 (name/description/price/emoji/sort_order/is_visible),
 * 0002 (success_template), 0012 (image_data), 0013 (category).
 */
export interface LegacyProductType {
  id: number
  name: string
  description: string | null
  price: number
  emoji: string | null
  image_data: string | null
  category: string | null
  sort_order: number
  is_visible: number
  success_template: string | null
  created_at: string
  updated_at: string
}

/** `products` CŨ = kho tài khoản cụ thể (sẽ thành `product_items`). */
export interface LegacyStockItem {
  id: number
  type_id: number
  content: string
  status: 'available' | 'sold' | 'reserved'
  buyer_id: number | null
  order_id: number | null
  created_at: string
  sold_at: string | null
}

/** `orders` CŨ — tham chiếu `product_type_id`. */
export interface LegacyOrder {
  id: number
  user_id: number
  product_type_id: number
  quantity: number
  total_amount: number
  transaction_id: number | null
  status: 'completed' | 'refunded'
  created_at: string
}

/** `order_items` CŨ — tham chiếu `product_id` (kho cũ). */
export interface LegacyOrderItem {
  id: number
  order_id: number
  product_id: number
  created_at: string
}

/** `product_type_templates` CŨ — copy 1:1 sang mô hình mới (R11.1). */
export interface LegacyProductTypeTemplate {
  id: number
  product_type_id: number
  lang: string
  success_template: string | null
  updated_at: string
}

/** Toàn bộ "DB cũ" cần cho ánh xạ. */
export interface LegacyDatabase {
  productTypes: LegacyProductType[]
  /** Kho tài khoản cũ (bảng `products` CŨ). */
  products: LegacyStockItem[]
  orders: LegacyOrder[]
  orderItems: LegacyOrderItem[]
  productTypeTemplates: LegacyProductTypeTemplate[]
}

/** Mô hình ba tầng MỚI sau ánh xạ. */
export interface ThreeTierDatabase {
  /** Danh mục (KHÔNG giá). */
  productTypes: DbProductType[]
  /** Sản phẩm có giá (id giữ nguyên từ product_types CŨ). */
  products: DbProduct[]
  /** Kho tài khoản (đổi tên từ products CŨ). */
  productItems: DbProductItem[]
  orders: DbOrder[]
  orderItems: DbOrderItem[]
  productTypeTemplates: DbProductTypeTemplate[]
}

/** Tuỳ chọn ánh xạ (cho phép cố định timestamp để test tất định). */
export interface MapOptions {
  /** Giá trị created_at/updated_at gán cho danh mục sinh mới. */
  now?: string
}

/**
 * Trả về giá trị `category` đã trim nếu hợp lệ (khác null và khác rỗng sau trim),
 * ngược lại trả về null — khớp điều kiện SQL `category IS NOT NULL AND TRIM(category) <> ''`.
 */
function normalizeCategory(category: string | null): string | null {
  if (category == null) return null
  const trimmed = category.trim()
  return trimmed.length > 0 ? trimmed : null
}

const utf8Encoder = new TextEncoder()

/** So sánh text theo thứ tự byte UTF-8, khớp gần nhất với SQLite BINARY collation. */
function compareSqliteBinaryText(a: string, b: string): number {
  const ab = utf8Encoder.encode(a)
  const bb = utf8Encoder.encode(b)
  const len = Math.min(ab.length, bb.length)
  for (let i = 0; i < len; i += 1) {
    const delta = ab[i] - bb[i]
    if (delta !== 0) return delta
  }
  return ab.length - bb.length
}

/**
 * Ánh xạ "DB cũ" hai tầng sang mô hình ba tầng MỚI (R2.2, R2.4, R2.5, R2.6,
 * R2.7, R2.8, R2.10, R2.11, R2.12, R2.13, R9.6, R11.1). Hàm THUẦN,
 * tất định, không chạm DB/IO.
 */
export function mapLegacyToThreeTier(
  legacy: LegacyDatabase,
  options: MapOptions = {}
): ThreeTierDatabase {
  const now = options.now ?? DEFAULT_TIMESTAMP

  // --- BƯỚC 3: Sinh danh mục ------------------------------------------------
  // 3a. Danh mục mặc định cố định id=1 chỉ được tạo khi có bản ghi thiếu category (R2.6, R2.12).
  const categories: DbProductType[] = []
  const hasMissingCategory = legacy.productTypes.some((pt) => normalizeCategory(pt.category) === null)
  if (hasMissingCategory) {
    categories.push({
      id: DEFAULT_CATEGORY_ID,
      name: DEFAULT_CATEGORY_NAME,
      description: null,
      content: null,
      emoji: null,
      image_data: null,
      sort_order: 0,
      is_visible: 1,
      created_at: now,
      updated_at: now,
    })
  }

  // 3b/3c. Mỗi `category` DISTINCT (khác null/rỗng) → 1 danh mục (R2.5).
  //         Gán id theo thứ tự alphabet, giống ROW_NUMBER() OVER (ORDER BY category_key).
  //         Không lookup bằng name nên category hợp lệ trùng tên default không bị gộp nhầm (R2.13).
  const categoryIdByName = new Map<string, number>()
  const categoryKeys = Array.from(
    new Set(
      legacy.productTypes
        .map((pt) => normalizeCategory(pt.category))
        .filter((cat): cat is string => cat !== null)
    )
  ).sort(compareSqliteBinaryText)

  let nextCategoryId = hasMissingCategory ? DEFAULT_CATEGORY_ID + 1 : DEFAULT_CATEGORY_ID
  for (const cat of categoryKeys) {
    categoryIdByName.set(cat, nextCategoryId)
    categories.push({
      id: nextCategoryId,
      name: cat,
      description: null,
      content: null,
      emoji: null,
      image_data: null,
      sort_order: 0,
      is_visible: 1,
      created_at: now,
      updated_at: now,
    })
    nextCategoryId += 1
  }

  // --- BƯỚC 4: products MỚI = sản phẩm có giá, GIỮ NGUYÊN id cũ (R2.2, D4) ---
  const products: DbProduct[] = legacy.productTypes.map((pt) => {
    const cat = normalizeCategory(pt.category)
    const productTypeId =
      cat !== null ? categoryIdByName.get(cat) ?? DEFAULT_CATEGORY_ID : DEFAULT_CATEGORY_ID
    return {
      id: pt.id, // id-preserving (D4)
      product_type_id: productTypeId,
      name: pt.name,
      description: pt.description,
      content: null, // migration chèn NULL cho content hiển thị
      price: pt.price, // giá giữ nguyên (R2.2)
      emoji: pt.emoji,
      image_data: pt.image_data,
      sort_order: pt.sort_order,
      is_visible: pt.is_visible,
      created_at: pt.created_at,
      updated_at: pt.updated_at,
    }
  })

  // --- BƯỚC 1: product_items = kho cũ, type_id → product_id (R2.3, R2.4) ----
  const productItems: DbProductItem[] = legacy.products.map((item) => ({
    id: item.id,
    product_id: item.type_id, // type_id CŨ = id product_types CŨ = id products MỚI
    content: item.content,
    status: item.status,
    buyer_id: item.buyer_id,
    order_id: item.order_id,
    created_at: item.created_at,
    sold_at: item.sold_at,
  }))

  // --- BƯỚC 6: orders, product_type_id → product_id (giữ giá trị id) (R2.7) -
  const orders: DbOrder[] = legacy.orders.map((o) => ({
    id: o.id,
    user_id: o.user_id,
    product_id: o.product_type_id, // tự khớp products.id (id-preserving)
    quantity: o.quantity,
    total_amount: o.total_amount,
    transaction_id: o.transaction_id,
    status: o.status,
    created_at: o.created_at,
  }))

  // --- BƯỚC 7: order_items, product_id → product_item_id (giữ giá trị id) ---
  const orderItems: DbOrderItem[] = legacy.orderItems.map((oi) => ({
    id: oi.id,
    order_id: oi.order_id,
    product_item_id: oi.product_id, // tự khớp product_items.id (id-preserving)
    created_at: oi.created_at,
  }))

  // --- BƯỚC 5: product_type_templates copy 1:1, KHÔNG đổi nội dung (R11.1) --
  const productTypeTemplates: DbProductTypeTemplate[] = legacy.productTypeTemplates.map(
    (t) => ({
      id: t.id,
      product_type_id: t.product_type_id, // = id products MỚI (id-preserving)
      lang: t.lang,
      success_template: t.success_template,
      updated_at: t.updated_at,
    })
  )

  return {
    productTypes: categories,
    products,
    productItems,
    orders,
    orderItems,
    productTypeTemplates,
  }
}
