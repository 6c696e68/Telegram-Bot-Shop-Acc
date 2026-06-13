import type { DbProduct, DbProductItem, DbProductType } from '../types/db'

export interface StockLike {
  status: string
}

export interface ProductWithStock extends DbProduct {
  stock: number
}

export type Thumbnail =
  | { kind: 'image'; value: string }
  | { kind: 'emoji'; value: string }
  | { kind: 'none'; value: null }

export function computeStock(items: readonly StockLike[]): number {
  return items.reduce((count, item) => count + (item.status === 'available' ? 1 : 0), 0)
}

export function isInStock(stock: number): boolean {
  return stock > 0
}

function validText(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function pickThumbnail(
  product: Pick<DbProduct, 'image_data' | 'emoji'>,
  productType?: Pick<DbProductType, 'emoji'> | null
): Thumbnail {
  const image = validText(product.image_data)
  if (image) return { kind: 'image', value: image }
  const productEmoji = validText(product.emoji)
  if (productEmoji) return { kind: 'emoji', value: productEmoji }
  const typeEmoji = validText(productType?.emoji)
  if (typeEmoji) return { kind: 'emoji', value: typeEmoji }
  return { kind: 'none', value: null }
}

export async function getProductStock(db: D1Database, productId: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS stock FROM product_items WHERE product_id = ? AND status = 'available'")
    .bind(productId)
    .first<{ stock: number }>()
  return row?.stock ?? 0
}

export async function listVisibleCategories(db: D1Database): Promise<DbProductType[]> {
  const { results } = await db
    .prepare('SELECT * FROM product_types WHERE is_visible = 1 ORDER BY sort_order ASC, id ASC')
    .all<DbProductType>()
  return results ?? []
}

export async function listVisibleProducts(db: D1Database, productTypeId: number): Promise<DbProduct[]> {
  const { results } = await db
    .prepare(
      'SELECT * FROM products WHERE product_type_id = ? AND is_visible = 1 ORDER BY sort_order ASC, id ASC'
    )
    .bind(productTypeId)
    .all<DbProduct>()
  return results ?? []
}

export async function listProductsWithStock(
  db: D1Database,
  productTypeId: number
): Promise<ProductWithStock[]> {
  const { results } = await db
    .prepare(
      `SELECT p.*,
              COALESCE(SUM(CASE WHEN pi.status = 'available' THEN 1 ELSE 0 END), 0) AS stock
       FROM products p
       LEFT JOIN product_items pi ON pi.product_id = p.id
       WHERE p.product_type_id = ? AND p.is_visible = 1
       GROUP BY p.id
       ORDER BY p.sort_order ASC, p.id ASC`
    )
    .bind(productTypeId)
    .all<ProductWithStock>()
  return results ?? []
}

export async function loadAvailableProductItems(
  db: D1Database,
  productId: number,
  quantity: number
): Promise<DbProductItem[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM product_items WHERE product_id = ? AND status = 'available' ORDER BY created_at ASC, id ASC LIMIT ?"
    )
    .bind(productId, quantity)
    .all<DbProductItem>()
  return results ?? []
}
