import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { miniAppApi } from '../src/routes/miniapp-api'
import type { ApiResponse } from '../src/types/api'
import type { CategoryListItemDto, ProductListItemDto } from '../src/types/miniapp'
import {
  resetThreeTierSchema,
  seedCategory,
  seedPricedProduct,
  seedProductItems,
} from './helpers/three-tier-schema'

const BOT_TOKEN = 'test-bot-token'
const BUYER_TELEGRAM_ID = 990_100_001
const encoder = new TextEncoder()

function bindings() {
  return { DB: env.DB, BOT_TOKEN }
}

async function hmacSha256(keyBytes: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', key, encoder.encode(message))
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function signedInitData(): Promise<string> {
  const fields: Record<string, string> = {
    user: JSON.stringify({ id: BUYER_TELEGRAM_ID, username: 'buyer', first_name: 'Buyer' }),
    auth_date: String(Math.floor(Date.now() / 1000)),
  }
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n')
  const secretKey = await hmacSha256(encoder.encode('WebAppData'), BOT_TOKEN)
  const hash = toHex(await hmacSha256(secretKey, dataCheckString))
  const params = new URLSearchParams(fields)
  params.append('hash', hash)
  return params.toString()
}

async function apiGet<T>(path: string): Promise<ApiResponse<T>> {
  const res = await miniAppApi.request(
    path,
    { headers: { 'X-Telegram-Init-Data': await signedInitData() } },
    bindings() as any
  )
  expect(res.status).toBe(200)
  return (await res.json()) as ApiResponse<T>
}

beforeEach(async () => {
  await resetThreeTierSchema(env.DB)
})

describe('Mini App catalog DTO', () => {
  it('returns categories as filters, empty category products, and product prices from Product', async () => {
    const emptyCategoryId = await seedCategory(env.DB, 'Empty category', true, 0)
    const categoryId = await seedCategory(env.DB, 'AI category', true, 1)
    const productId = await seedPricedProduct(env.DB, {
      categoryId,
      name: 'AI 30 days',
      price: 123_456,
      emoji: null,
    })
    await seedProductItems(env.DB, productId, 2, 'available')

    const categories = await apiGet<CategoryListItemDto[]>('/categories')
    expect(categories.success).toBe(true)
    expect(categories.data!.map((category) => category.id)).toEqual([emptyCategoryId, categoryId])
    expect(categories.data!.find((category) => category.id === emptyCategoryId)?.product_count).toBe(0)

    const emptyProducts = await apiGet<ProductListItemDto[]>(`/categories/${emptyCategoryId}/products`)
    expect(emptyProducts.success).toBe(true)
    expect(emptyProducts.data).toEqual([])

    const products = await apiGet<ProductListItemDto[]>(`/categories/${categoryId}/products`)
    expect(products.success).toBe(true)
    expect(products.data).toHaveLength(1)
    expect(products.data![0]).toMatchObject({
      id: productId,
      product_type_id: categoryId,
      category_id: categoryId,
      name: 'AI 30 days',
      price: 123_456,
      stock: 2,
      in_stock: true,
    })
  })
})
