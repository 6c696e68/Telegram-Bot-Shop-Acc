import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { buildCurrencyContext } from '../src/utils/format'
import {
  handleCategoryDetail,
  handleCategoryList,
  handleProductDetail,
  handlePurchaseConfirm,
} from '../src/bot/callbacks/purchase'
import {
  resetThreeTierSchema,
  seedCategory,
  seedPricedProduct,
  seedProductItems,
} from './helpers/three-tier-schema'

const telegramApi = vi.hoisted(() => ({
  editOrSendMessage: vi.fn(),
  sendMessage: vi.fn(),
  sendChunkedMessage: vi.fn(),
}))

vi.mock('../src/bot/telegram-api', () => ({
  editOrSendMessage: telegramApi.editOrSendMessage,
  sendMessage: telegramApi.sendMessage,
  sendChunkedMessage: telegramApi.sendChunkedMessage,
  buildInlineKeyboard: (buttons: unknown) => ({ inline_keyboard: buttons }),
  buildBackButton: (callback_data: string) => [{ text: 'Back', callback_data }],
}))

const BOT_TOKEN = 'test-bot-token'
const CHAT_ID = 12345

async function seedUser(telegramId: number, balance: number, language: string | null = null): Promise<number> {
  const row = await env.DB
    .prepare('INSERT INTO users (telegram_id, balance, language) VALUES (?, ?, ?) RETURNING id')
    .bind(telegramId, balance, language)
    .first<{ id: number }>()
  return row!.id
}

beforeEach(async () => {
  await resetThreeTierSchema(env.DB)
  telegramApi.editOrSendMessage.mockReset()
  telegramApi.sendMessage.mockReset()
  telegramApi.sendChunkedMessage.mockReset()
})

describe('Bot purchase handlers', () => {
  it('shows an empty message when there are no visible categories', async () => {
    const ctx = await buildCurrencyContext(env.DB, { lang: 'vi', region: null })

    await handleCategoryList(env.DB, BOT_TOKEN, CHAT_ID, undefined, 'vi', ctx)

    expect(telegramApi.editOrSendMessage).toHaveBeenCalledTimes(1)
    const text = String(telegramApi.editOrSendMessage.mock.calls[0][3])
    expect(text).toContain('không có sản phẩm')
  })

  it('shows an empty product state for a category without visible products', async () => {
    const categoryId = await seedCategory(env.DB, 'AI category')
    const ctx = await buildCurrencyContext(env.DB, { lang: 'vi', region: null })

    await handleCategoryDetail(env.DB, BOT_TOKEN, CHAT_ID, undefined, categoryId, 1, 'vi', ctx)

    expect(telegramApi.editOrSendMessage).toHaveBeenCalledTimes(1)
    const text = String(telegramApi.editOrSendMessage.mock.calls[0][3])
    expect(text).toContain('AI category')
    expect(text).toContain('không có sản phẩm')
  })

  it('renders product detail description with the display-language translation', async () => {
    const categoryId = await seedCategory(env.DB, 'AI category')
    const productId = await seedPricedProduct(env.DB, {
      categoryId,
      name: 'AI product',
      description: 'Base description',
      price: 20_000,
    })
    await seedProductItems(env.DB, productId, 1, 'available')
    await env.DB
      .prepare('INSERT INTO product_translations (product_id, lang, name, description) VALUES (?, ?, ?, ?)')
      .bind(productId, 'vi', 'Sản phẩm AI', 'Mô tả tiếng Việt')
      .run()
    const ctx = await buildCurrencyContext(env.DB, { lang: 'vi', region: null })

    await handleProductDetail(env.DB, BOT_TOKEN, CHAT_ID, undefined, productId, 1, 'vi', ctx)

    expect(telegramApi.editOrSendMessage).toHaveBeenCalledTimes(1)
    const text = String(telegramApi.editOrSendMessage.mock.calls[0][3])
    expect(text).toContain('Sản phẩm AI')
    expect(text).toContain('Mô tả tiếng Việt')
    expect(text).not.toContain('Base description')
  })

  it('uses the default-language success template when the user language template is missing', async () => {
    const telegramId = 900_001
    await seedUser(telegramId, 100_000, 'vi')
    await env.DB
      .prepare('INSERT INTO system_config (key, value) VALUES (?, ?)')
      .bind('default_language', 'en')
      .run()
    const categoryId = await seedCategory(env.DB, 'AI category')
    const productId = await seedPricedProduct(env.DB, { categoryId, name: 'AI product', price: 20_000 })
    await seedProductItems(env.DB, productId, 1, 'available')
    await env.DB
      .prepare('INSERT INTO product_type_templates (product_type_id, lang, success_template) VALUES (?, ?, ?)')
      .bind(productId, 'en', 'Delivered [name]\n[content]\nBalance [balance]')
      .run()
    const ctx = await buildCurrencyContext(env.DB, { lang: 'vi', region: null })

    await handlePurchaseConfirm(env.DB, BOT_TOKEN, CHAT_ID, undefined, productId, 1, telegramId, 'vi', ctx)

    expect(telegramApi.sendChunkedMessage).toHaveBeenCalledTimes(1)
    const text = String(telegramApi.sendChunkedMessage.mock.calls[0][3])
    expect(text).toContain('Delivered AI product')
    expect(text).toContain('<code>item_')
    expect(text).toContain('Balance')
  })
})
