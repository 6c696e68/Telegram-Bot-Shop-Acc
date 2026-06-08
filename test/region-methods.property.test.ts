import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import {
  methodsForRegion,
  isMethodAllowedForRegion,
  isProviderEnabled,
  enabledMethodsForRegion,
  providerEnabledConfigKey,
} from '../src/services/payments/registry'
import { sePayProvider } from '../src/services/payments/sepay-provider'
import { cryptoPayProvider } from '../src/services/payments/cryptopay-provider'
import type { Region } from '../src/i18n/locales'
import type { ProviderId } from '../src/services/payments/types'

/**
 * Property-based tests cho phương thức nạp theo vùng + phân tách provider/đơn vị.
 *
 * Validates: Requirements 7.7, 8.4, 13.2
 *  - Property 5 (Phân tách provider/đơn vị): deposit `sepay` luôn có `correlation_ref` +
 *    đơn vị VND; deposit `cryptobot` luôn có `provider_txn_id` + `asset='USDT'` + USDT (metadata);
 *    không lẫn lộn.
 *  - Property 6 (Method hợp lệ theo vùng): `methodsForRegion` đúng theo vùng; provider
 *    ngoài danh sách của vùng bị từ chối (enforce `isMethodAllowedForRegion`).
 *
 * Dùng D1 thật qua @cloudflare/vitest-pool-workers; mock `fetch` cho Crypto Pay createInvoice.
 */

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
    region TEXT CHECK(region IN ('vietnam','international')),
    language TEXT,
    language_locked INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    last_interaction_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL DEFAULT 'sepay',
    amount INTEGER NOT NULL CHECK(amount > 0),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','completed','expired','cancelled','awaiting_credit')),
    correlation_ref TEXT,
    provider_txn_id TEXT,
    metadata TEXT,
    completed_at TEXT,
    expired_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER
  )`,
]

async function applySchema(): Promise<void> {
  for (const stmt of SCHEMA_STATEMENTS) {
    await env.DB.prepare(stmt).run()
  }
}

async function cleanTables(): Promise<void> {
  await env.DB.prepare('DELETE FROM deposits').run()
  await env.DB.prepare('DELETE FROM users').run()
  await env.DB.prepare('DELETE FROM system_config').run()
}

async function seedConfig(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO system_config (key, value) VALUES
       ('min_deposit', '20000'),
       ('max_deposit', '100000000'),
       ('exchange_rate_usdt_vnd', '25000'),
       ('crypto_min_usdt', '5')`
  ).run()
}

async function seedUser(region: Region): Promise<{ id: number; telegramId: number }> {
  const telegramId = Math.floor(Math.random() * 2_000_000_000)
  await env.DB.prepare(
    "INSERT INTO users (telegram_id, username, first_name, balance, region, language, created_at, updated_at) VALUES (?, 'u', 'U', 0, ?, 'vi', datetime('now'), datetime('now'))"
  )
    .bind(telegramId, region)
    .run()
  const row = await env.DB.prepare('SELECT id FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<{ id: number }>()
  return { id: row!.id, telegramId }
}

async function getDeposit(depositId: number): Promise<{
  provider: string
  correlation_ref: string | null
  provider_txn_id: string | null
  asset: string | null
  usdt_amount: string | null
}> {
  const row = await env.DB.prepare(
    `SELECT provider, correlation_ref, provider_txn_id,
            json_extract(metadata, '$.asset') AS asset,
            json_extract(metadata, '$.usdt_amount') AS usdt_amount
     FROM deposits WHERE id = ?`
  )
    .bind(depositId)
    .first<{
      provider: string
      correlation_ref: string | null
      provider_txn_id: string | null
      asset: string | null
      usdt_amount: string | null
    }>()
  return row!
}

function testEnv() {
  return {
    DB: env.DB,
    BOT_TOKEN: 'test-bot-token',
    TELEGRAM_SECRET_TOKEN: 'x',
    SEPAY_API_KEY: 'x',
    ADMIN_IDS: '1',
    JWT_SECRET: 'x',
    BANK_NAME: 'MB',
    BANK_ACCOUNT: '0123456789',
    BANK_OWNER: 'NGUYEN VAN TEST',
    CRYPTO_PAY_API_TOKEN: 'test-crypto-token',
  } as never
}

beforeEach(async () => {
  await applySchema()
  await cleanTables()
  await seedConfig()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Feature: multi-region-payments, Property 6
describe('Property 6: Method hợp lệ theo vùng', () => {
  /**
   * **Validates: Requirements 8.4**
   * methodsForRegion đúng theo vùng và provider ngoài danh sách bị từ chối.
   */
  it('methodsForRegion + isMethodAllowedForRegion phản ánh đúng chính sách vùng', () => {
    expect(methodsForRegion('vietnam')).toEqual(['sepay', 'payos', 'cryptobot'])
    expect(methodsForRegion('international')).toEqual(['cryptobot'])

    // vietnam cho cả ba; international chỉ cryptobot (sepay + payos bị từ chối).
    expect(isMethodAllowedForRegion('vietnam', 'sepay')).toBe(true)
    expect(isMethodAllowedForRegion('vietnam', 'payos')).toBe(true)
    expect(isMethodAllowedForRegion('vietnam', 'cryptobot')).toBe(true)
    expect(isMethodAllowedForRegion('international', 'cryptobot')).toBe(true)
    expect(isMethodAllowedForRegion('international', 'sepay')).toBe(false)
    expect(isMethodAllowedForRegion('international', 'payos')).toBe(false)
  })

  /**
   * **Validates: Requirements 8.4**
   * Với mọi (vùng, provider): provider khả dụng ⇔ thuộc methodsForRegion(vùng).
   */
  it('isMethodAllowedForRegion nhất quán với methodsForRegion cho mọi cặp', () => {
    const regions: Region[] = ['vietnam', 'international']
    const providers: ProviderId[] = ['sepay', 'payos', 'cryptobot']
    fc.assert(
      fc.property(fc.constantFrom(...regions), fc.constantFrom(...providers), (region, provider) => {
        const inList = methodsForRegion(region).includes(provider)
        expect(isMethodAllowedForRegion(region, provider)).toBe(inList)
      })
    )
  })
})

// Feature: multi-region-payments, Property 5
describe('Property 5: Phân tách provider/đơn vị', () => {
  /**
   * **Validates: Requirements 7.7, 13.2**
   * Deposit SePay luôn có correlation_ref (transfer_code, VND); KHÔNG có provider_txn_id lúc tạo.
   */
  it('SePay deposit luôn có correlation_ref (VND), không có provider_txn_id', async () => {
    expect(sePayProvider.amountUnit).toBe('vnd')
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 20_000, max: 1_000_000 }), async (amountVnd) => {
        await cleanTables()
        await seedConfig()
        const user = await seedUser('vietnam')

        const result = await sePayProvider.createDeposit({
          db: env.DB,
          env: testEnv(),
          userId: user.id,
          telegramId: user.telegramId,
          rawAmount: amountVnd,
          lang: 'vi',
          channel: 'bot',
        })

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.output.vietqr).toBeDefined()
        expect(result.output.vietqr!.transferCode).toBeTruthy()
        expect(result.output.crypto).toBeUndefined()

        const dep = await getDeposit(result.output.depositId)
        expect(dep.provider).toBe('sepay')
        expect(dep.correlation_ref).toBeTruthy()
        expect(dep.provider_txn_id).toBeNull()
      }),
      { numRuns: 25 }
    )
  })

  /**
   * **Validates: Requirements 7.7, 13.2**
   * Deposit CryptoBot luôn có provider_txn_id (invoice id) + asset='USDT' + usdt_amount (qua metadata).
   */
  it('CryptoBot deposit luôn có provider_txn_id + USDT (metadata)', async () => {
    expect(cryptoPayProvider.amountUnit).toBe('usdt')

    // Mock Crypto Pay createInvoice → trả invoice hợp lệ.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (String(url).includes('createInvoice')) {
          const invoiceId = Math.floor(Math.random() * 2_000_000_000)
          return new Response(
            JSON.stringify({
              ok: true,
              result: {
                invoice_id: invoiceId,
                bot_invoice_url: `https://t.me/CryptoBot?start=inv_${invoiceId}`,
                mini_app_invoice_url: `https://t.me/CryptoBot/app?startapp=inv_${invoiceId}`,
                pay_url: `https://pay.crypt.bot/inv_${invoiceId}`,
              },
            }),
            { status: 200 }
          )
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      })
    )

    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 5, max: 1000 }), async (usdt) => {
        await cleanTables()
        await seedConfig()
        const user = await seedUser('international')

        const result = await cryptoPayProvider.createDeposit({
          db: env.DB,
          env: testEnv(),
          userId: user.id,
          telegramId: user.telegramId,
          rawAmount: usdt,
          lang: 'en',
          channel: 'bot',
        })

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.output.crypto).toBeDefined()
        expect(result.output.crypto!.invoiceId).toBeTruthy()
        expect(result.output.crypto!.usdtAmount).toBe(String(usdt))
        expect(result.output.crypto!.payUrl).toBeTruthy()
        expect(result.output.vietqr).toBeUndefined()

        const dep = await getDeposit(result.output.depositId)
        expect(dep.provider).toBe('cryptobot')
        expect(dep.provider_txn_id).toBeTruthy()
        expect(dep.asset).toBe('USDT')
        expect(dep.usdt_amount).toBe(String(usdt))
      }),
      { numRuns: 25 }
    )
  })
})

/** Ghi (hoặc ghi đè) một giá trị `system_config` để điều khiển cờ bật provider. */
async function setConfig(key: string, value: string): Promise<void> {
  await env.DB.prepare(
    'INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)'
  )
    .bind(key, value)
    .run()
}

/** Chuẩn hoá giống registry: trim + lowercase, bật khi '1' hoặc 'true'. */
function expectedEnabled(raw: string): boolean {
  const norm = raw.trim().toLowerCase()
  return norm === '1' || norm === 'true'
}

// Feature: payos-deposit, Property 16
describe('Property 16: Enabled flag normalization governs availability', () => {
  /**
   * **Validates: Requirements 10.1, 10.2, 10.3, 10.6**
   * Với mọi giá trị thô của `payment_payos_enabled`, `isProviderEnabled('payos')` đúng
   * KHI VÀ CHỈ KHI giá trị sau chuẩn hoá (trim + lowercase) là '1' hoặc 'true'.
   */
  it('isProviderEnabled(payos) = (normalize(raw) ∈ {1,true}) cho mọi raw value', async () => {
    // Sinh raw value: phủ token có nghĩa (1/true/0/false/'') + biến thể hoa/thường +
    // khoảng trắng bao quanh + chuỗi rác bất kỳ.
    const meaningful = fc.constantFrom(
      '1',
      '0',
      'true',
      'false',
      'TRUE',
      'True',
      'FALSE',
      'yes',
      'no',
      'on',
      'off',
      '',
      '2',
      'enabled'
    )
    const ws = fc.constantFrom('', ' ', '  ', '\t', '\n', ' \t ', '\r\n')
    const rawArb = fc.oneof(
      fc.tuple(ws, meaningful, ws).map(([a, b, c]) => `${a}${b}${c}`),
      fc.string()
    )

    await fc.assert(
      fc.asyncProperty(rawArb, async (raw) => {
        await setConfig(providerEnabledConfigKey('payos'), raw)
        const enabled = await isProviderEnabled(env.DB, 'payos')
        expect(enabled).toBe(expectedEnabled(raw))
      }),
      { numRuns: 60 }
    )
  })

  /**
   * **Validates: Requirements 10.6**
   * Chưa cấu hình `payment_payos_enabled` → provider bị tắt (mặc định an toàn).
   */
  it('payos chưa cấu hình → disabled', async () => {
    await cleanTables()
    await seedConfig()
    expect(await isProviderEnabled(env.DB, 'payos')).toBe(false)
  })

  /**
   * **Validates: Requirements 10.1**
   * Provider luôn-bật (sepay) → true bất kể cờ; điều này phân biệt với provider mới.
   */
  it('sepay luôn enabled bất kể giá trị cờ', async () => {
    await setConfig(providerEnabledConfigKey('sepay'), '0')
    expect(await isProviderEnabled(env.DB, 'sepay')).toBe(true)
  })
})

// Feature: payos-deposit, Property 17
describe('Property 17: PayOS appears only when region-allowed and enabled', () => {
  /**
   * **Validates: Requirements 10.4, 11.1, 11.2, 11.3, 11.4**
   * `enabledMethodsForRegion` chứa 'payos' KHI VÀ CHỈ KHI vùng cho phép payos
   * (region.METHODS_BY_REGION chứa payos, tức 'vietnam') VÀ cờ payos bật.
   * Không bao giờ với 'international'. SePay luôn có mặt ở 'vietnam' bất kể cờ.
   */
  it('payos ∈ enabledMethodsForRegion ⇔ (region cho phép payos) ∧ (cờ bật)', async () => {
    const regions: Region[] = ['vietnam', 'international']
    const flagArb = fc.constantFrom('1', 'true', ' TRUE ', '0', 'false', '', 'garbage')

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...regions),
        flagArb,
        async (region, flag) => {
          await cleanTables()
          await seedConfig()
          await setConfig(providerEnabledConfigKey('payos'), flag)

          const methods = await enabledMethodsForRegion(env.DB, region)

          const regionAllowsPayos = isMethodAllowedForRegion(region, 'payos')
          const flagOn = expectedEnabled(flag)
          // Property 17 core: payos hiển thị ⇔ region cho phép ∧ cờ bật.
          expect(methods.includes('payos')).toBe(regionAllowsPayos && flagOn)

          // International không bao giờ có payos.
          if (region === 'international') {
            expect(methods.includes('payos')).toBe(false)
          }

          // sepay (always-enabled) luôn có mặt ở vietnam, bất kể cờ payos.
          if (region === 'vietnam') {
            expect(methods.includes('sepay')).toBe(true)
          }

          // Kết quả luôn là tập con (giữ thứ tự) của methodsForRegion(region).
          const ordered = methodsForRegion(region).filter((m) => methods.includes(m))
          expect(methods).toEqual(ordered)
        }
      ),
      { numRuns: 40 }
    )
  })
})
