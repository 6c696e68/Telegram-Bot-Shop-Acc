import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { miniAppApi } from '../src/routes/miniapp-api'
import { _resetRateLimiter } from '../src/bot/rate-limit'
import {
  enabledMethodsForRegion,
  isMethodAllowedForRegion,
  isProviderEnabled,
  providerEnabledConfigKey,
  getProvider,
} from '../src/services/payments/registry'
import { ensureProvidersRegistered } from '../src/services/payments/register'
import type { Region } from '../src/i18n/locales'
import type { ProviderId } from '../src/services/payments/types'
import type { ApiResponse } from '../src/types/api'
import type {
  DepositMethodDto,
  DepositCreatedDto,
  CryptoDepositCreatedDto,
  PayosDepositCreatedDto,
} from '../src/types/miniapp'

/**
 * Property-based tests cho round-trip phương thức nạp giữa frontend (Mini App API) và
 * backend (provider/registry). Task 4.9.
 *
 * Validates:
 *  - Property 22: Mini App deposit method round-trips for any returned method
 *      — Requirements 18.5, 19.1, 19.3, 19.4
 *    GET /api/app/deposit-methods trả tập phương thức theo vùng + cờ bật; với MỌI phương
 *    thức trả về, POST /api/app/deposits với phương thức đó SHALL thành công và trả đúng
 *    DTO theo phương thức (sepay→DepositCreatedDto, cryptobot→CryptoDepositCreatedDto,
 *    payos→PayosDepositCreatedDto).
 *  - Property 23: Bot accepts exactly the region-and-enabled allowed methods
 *      — Requirements 20.1, 20.2
 *    Logic chấp nhận phương thức của bot (`handleDepositMethod`) chấp nhận một phương thức
 *    KHI VÀ CHỈ KHI nó thuộc tập region-allowed ∩ enabled (== `enabledMethodsForRegion`).
 *
 * Dùng D1 thật qua @cloudflare/vitest-pool-workers; mount router `miniAppApi` trực tiếp với
 * initData ký hợp lệ; stub `fetch` cho CryptoBot `createInvoice`, PayOS `createPaymentLink`
 * và Telegram (sendPhoto/sendMessage).
 */

const BOT_TOKEN = 'test-bot-token'
const MINIAPP_URL = 'https://miniapp.example.com/app'

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
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_provider_correlation
     ON deposits(provider, correlation_ref) WHERE correlation_ref IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_provider_txn
     ON deposits(provider, provider_txn_id) WHERE provider_txn_id IS NOT NULL`,
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

/** Seed hạn mức + tỷ giá + cấu hình PayOS + miniapp_url. */
async function seedBaseConfig(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO system_config (key, value) VALUES
       ('min_deposit', '20000'),
       ('max_deposit', '100000000'),
       ('exchange_rate_usdt_vnd', '25000'),
       ('crypto_min_usdt', '5'),
       ('payos_client_id', 'test-client-id'),
       ('payos_api_key', 'test-api-key'),
       ('payos_checksum_key', 'test-checksum-key'),
       ('miniapp_url', ?)`
  )
    .bind(MINIAPP_URL)
    .run()
}

/** Ghi/ghi đè một cờ bật provider. */
async function setEnabled(id: ProviderId, on: boolean): Promise<void> {
  await env.DB.prepare('INSERT OR REPLACE INTO system_config (key, value) VALUES (?, ?)')
    .bind(providerEnabledConfigKey(id), on ? '1' : '0')
    .run()
}

let telegramSeq = 1_000_000
async function seedUser(region: Region): Promise<{ id: number; telegramId: number }> {
  const telegramId = telegramSeq++
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

// --- initData signing (Telegram WebApp) ---

const encoder = new TextEncoder()

async function hmacSha256(keyBytes: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', key, encoder.encode(message))
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function signInitData(fields: Record<string, string>, botToken: string): Promise<string> {
  const pairs = Object.keys(fields)
    .filter((k) => k !== 'hash')
    .map((k) => `${k}=${fields[k]}`)
  pairs.sort()
  const dataCheckString = pairs.join('\n')
  const secretKey = await hmacSha256(encoder.encode('WebAppData'), botToken)
  const hash = toHex(await hmacSha256(secretKey, dataCheckString))
  const params = new URLSearchParams()
  for (const k of Object.keys(fields)) params.append(k, fields[k])
  params.append('hash', hash)
  return params.toString()
}

async function signBuyerInitData(telegramId: number): Promise<string> {
  const user = { id: telegramId, username: 'buyer', first_name: 'Buyer' }
  const fields: Record<string, string> = {
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
  }
  return signInitData(fields, BOT_TOKEN)
}

function getEnvBindings() {
  return {
    DB: env.DB,
    BOT_TOKEN,
    BANK_NAME: 'MB',
    BANK_ACCOUNT: '0123456789',
    BANK_OWNER: 'NGUYEN VAN TEST',
    CRYPTO_PAY_API_TOKEN: 'test-crypto-token',
    PAYOS_CLIENT_ID: 'test-client-id',
    PAYOS_API_KEY: 'test-api-key',
    PAYOS_CHECKSUM_KEY: 'test-checksum-key',
  }
}

function getExecutionCtx() {
  return { waitUntil: (_p: Promise<unknown>) => {}, passThroughOnException: () => {} }
}

async function getDepositMethods(telegramId: number): Promise<DepositMethodDto[]> {
  const raw = await signBuyerInitData(telegramId)
  const res = await miniAppApi.request(
    '/deposit-methods',
    { method: 'GET', headers: { 'X-Telegram-Init-Data': raw } },
    getEnvBindings() as never,
    getExecutionCtx() as never
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as ApiResponse<DepositMethodDto[]>
  expect(body.success).toBe(true)
  return body.data!
}

async function postDeposit(telegramId: number, method: ProviderId, amount: number) {
  const raw = await signBuyerInitData(telegramId)
  return miniAppApi.request(
    '/deposits',
    {
      method: 'POST',
      headers: { 'X-Telegram-Init-Data': raw, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, amount }),
    },
    getEnvBindings() as never,
    getExecutionCtx() as never
  )
}

/**
 * Stub global fetch để bao mọi external call trong round-trip:
 *  - CryptoBot `createInvoice` → invoice hợp lệ (invoice_id duy nhất).
 *  - PayOS `createPaymentLink` (api-merchant.payos.vn/.../payment-requests) → link hợp lệ.
 *  - Telegram (api.telegram.org sendPhoto/sendMessage) → ok.
 */
function stubExternalFetch(): void {
  let n = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url)
      n += 1
      if (u.includes('payment-requests')) {
        return new Response(
          JSON.stringify({
            code: '00',
            desc: 'success',
            data: {
              checkoutUrl: `https://pay.payos.vn/web/link-${n}`,
              qrCode: `qr-${n}`,
              paymentLinkId: `plink-${n}-${Math.floor(Math.random() * 1_000_000)}`,
            },
          }),
          { status: 200 }
        )
      }
      if (u.includes('createInvoice')) {
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
      // Telegram API hoặc bất kỳ call khác → ok.
      void init
      return new Response('{"ok":true,"result":{}}', { status: 200 })
    })
  )
}

/** Số tiền hợp lệ theo đơn vị của phương thức. */
function amountForUnit(unit: 'vnd' | 'usdt'): number {
  return unit === 'usdt' ? 10 : 50_000
}

beforeEach(async () => {
  ensureProvidersRegistered()
  await applySchema()
  await cleanTables()
  _resetRateLimiter()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// Feature: payos-deposit, Property 22
describe('Property 22: Mini App deposit method round-trips for any returned method', () => {
  /**
   * **Validates: Requirements 18.5, 19.1, 19.3, 19.4**
   * GET /deposit-methods trả đúng tập theo vùng + cờ; với MỌI phương thức trả về,
   * POST /deposits thành công và trả đúng DTO theo phương thức.
   */
  it('every method returned by /deposit-methods succeeds on POST /deposits with its matching DTO', async () => {
    const regions: Region[] = ['vietnam', 'international']

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...regions),
        fc.boolean(), // payos enabled
        fc.boolean(), // cryptobot enabled
        async (region, payosOn, cryptoOn) => {
          await cleanTables()
          await seedBaseConfig()
          await setEnabled('payos', payosOn)
          await setEnabled('cryptobot', cryptoOn)
          _resetRateLimiter()
          stubExternalFetch()

          // 1) GET /deposit-methods cho một user của vùng — phải khớp registry.
          const lister = await seedUser(region)
          const methods = await getDepositMethods(lister.telegramId)
          const expected = await enabledMethodsForRegion(env.DB, region)
          expect(methods.map((m) => m.id)).toEqual([...expected])

          // 2) Với MỖI phương thức trả về: user mới (tránh cooldown) → POST thành công + DTO đúng.
          for (const m of methods) {
            const buyer = await seedUser(region)
            const amount = amountForUnit(m.amount_unit)
            const res = await postDeposit(buyer.telegramId, m.id, amount)

            expect(res.status).toBe(200)

            if (m.id === 'cryptobot') {
              const body = (await res.json()) as ApiResponse<CryptoDepositCreatedDto>
              expect(body.success).toBe(true)
              expect(body.data).not.toBeNull()
              const d = body.data!
              expect(d.method).toBe('cryptobot')
              expect(typeof d.pay_url).toBe('string')
              expect(d.pay_url.length).toBeGreaterThan(0)
              expect(d.usdt_amount).toBe(String(amount))
              expect(typeof d.invoice_id).toBe('string')
              expect(d.status).toBe('pending')
              expect(d.deposit_id).toBeGreaterThan(0)
            } else if (m.id === 'payos') {
              const body = (await res.json()) as ApiResponse<PayosDepositCreatedDto>
              expect(body.success).toBe(true)
              expect(body.data).not.toBeNull()
              const d = body.data!
              expect(d.method).toBe('payos')
              expect(typeof d.checkout_url).toBe('string')
              expect(d.checkout_url.length).toBeGreaterThan(0)
              expect(d.amount).toBe(amount)
              expect(typeof d.amount_display).toBe('string')
              expect(d.status).toBe('pending')
              expect(d.deposit_id).toBeGreaterThan(0)
            } else {
              // sepay → DepositCreatedDto (VietQR shape)
              const body = (await res.json()) as ApiResponse<DepositCreatedDto>
              expect(body.success).toBe(true)
              expect(body.data).not.toBeNull()
              const d = body.data!
              expect(typeof d.transfer_code).toBe('string')
              expect(d.transfer_code.length).toBeGreaterThan(0)
              expect(d.amount).toBe(amount)
              expect(typeof d.qr_url).toBe('string')
              expect(d.qr_url.length).toBeGreaterThan(0)
              expect(d.status).toBe('pending')
              expect(d.deposit_id).toBeGreaterThan(0)
            }

            // Sổ cái: deposit pending của đúng provider cho user này.
            const row = await env.DB.prepare(
              "SELECT provider, status FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 1"
            )
              .bind(buyer.id)
              .first<{ provider: string; status: string }>()
            expect(row!.provider).toBe(m.id)
            expect(row!.status).toBe('pending')
          }
        }
      ),
      { numRuns: 24 }
    )
  })
})

// Feature: payos-deposit, Property 23
describe('Property 23: Bot accepts exactly the region-and-enabled allowed methods', () => {
  /**
   * Mirror logic chấp nhận phương thức của `handleDepositMethod` (bot deposit flow):
   * chấp nhận ⇔ provider đã đăng ký ∧ thuộc vùng ∧ cờ bật.
   */
  async function botAccepts(region: Region, method: string): Promise<boolean> {
    const provider = getProvider(method as ProviderId)
    if (!provider || !isMethodAllowedForRegion(region, provider.id)) return false
    return isProviderEnabled(env.DB, provider.id)
  }

  /**
   * **Validates: Requirements 20.1, 20.2**
   * Với mọi (vùng, phương thức hợp lệ, cờ payos/cryptobot): bot chấp nhận phương thức KHI
   * VÀ CHỈ KHI nó nằm trong `enabledMethodsForRegion(region)` (region-allowed ∩ enabled).
   */
  it('botAccepts(region, method) ⇔ method ∈ enabledMethodsForRegion(region)', async () => {
    const regions: Region[] = ['vietnam', 'international']
    const providers: ProviderId[] = ['sepay', 'payos', 'cryptobot']

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...regions),
        fc.constantFrom(...providers),
        fc.boolean(),
        fc.boolean(),
        async (region, method, payosOn, cryptoOn) => {
          await cleanTables()
          await seedBaseConfig()
          await setEnabled('payos', payosOn)
          await setEnabled('cryptobot', cryptoOn)

          const accepted = await botAccepts(region, method)
          const enabled = await enabledMethodsForRegion(env.DB, region)
          expect(accepted).toBe(enabled.includes(method))
        }
      ),
      { numRuns: 40 }
    )
  })

  /**
   * **Validates: Requirements 20.1**
   * Phương thức không hợp lệ (không phải ProviderId đã đăng ký) luôn bị từ chối,
   * bất kể vùng/cờ (gỡ allowlist cứng KHÔNG có nghĩa chấp nhận chuỗi tuỳ ý).
   */
  it('unknown / unregistered methods are always rejected', async () => {
    await seedBaseConfig()
    await setEnabled('payos', true)
    await setEnabled('cryptobot', true)

    const bogus = ['', 'paypal', 'momo', 'SEPAY', 'pay os', 'bank']
    for (const region of ['vietnam', 'international'] as Region[]) {
      for (const m of bogus) {
        expect(await botAccepts(region, m)).toBe(false)
      }
    }
  })
})
