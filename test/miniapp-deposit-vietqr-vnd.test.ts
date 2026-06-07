import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { miniAppApi } from '../src/routes/miniapp-api'
import { _resetRateLimiter } from '../src/bot/rate-limit'
import { formatMoney, formatMoneyFor, buildCurrencyContext } from '../src/utils/format'
import { isMethodAllowedForRegion } from '../src/services/payments/registry'
import type { ApiResponse } from '../src/types/api'
import type { DepositCreatedDto } from '../src/types/miniapp'

// Feature: currency-display-usd, Property 8 — integration check (task 4.3)
/**
 * Integration check cho `POST /api/app/deposits` (nhánh SePay/VietQR) — số tiền PHẢI
 * chuyển khoản (`amount_display`) luôn là VND_String, KHÔNG bao giờ là USD `$...`, kể cả
 * khi đã cấu hình một Valid_Rate hợp lệ (rate này SẼ khiến các hiển thị khác đổi sang USD
 * cho user `international`).
 *
 * **Property 8: VietQR payable amount stays VND**
 * **Validates: Requirements 5.5**
 *
 * Ghi chú về "any region (including international)":
 * Theo chính sách vùng (`METHODS_BY_REGION`), `international` CHỈ được dùng `cryptobot` —
 * `isMethodAllowedForRegion('international','sepay') === false`. Vì vậy user `international`
 * KHÔNG bao giờ chạm tới nhánh VietQR qua endpoint (bị chặn `method_unavailable`), nên
 * payable VietQR theo USD là bất khả thi về mặt cấu trúc. Vùng duy nhất tạo được VietQR là
 * `vietnam`. Do `amount_display` của nhánh SePay được dựng bằng `formatMoney(amountVnd, lang)`
 * (KHÔNG nhận `region`/`rate`), nó luôn là VND bất kể vùng.
 *
 * Kiểm chứng ở ĐÚNG code path thật (endpoint), không reconstruct logic:
 *  1. user `vietnam` + rate hợp lệ '25000' đã seed → POST /deposits (SePay) trả 200 và
 *     `amount_display` kết thúc bằng 'đ', KHÔNG chứa '$', `amount` == số VND yêu cầu.
 *  2. `amount_display` BẰNG ĐÚNG `formatMoney(amount, lang)` — chứng minh dùng VND formatter,
 *     KHÔNG phải `vndToUsdString`, dù rate hợp lệ đang tồn tại.
 *  3. Tương phản: với cùng rate đó, một `CurrencyContext` vùng `international` khiến
 *     `formatMoneyFor(amount, ctx)` ra chuỗi USD `$...` → bằng chứng rate này ĐỦ để đổi các
 *     hiển thị khác sang USD, nhưng payable VietQR vẫn cố tình giữ VND (R5.5).
 *
 * Mount router `miniAppApi` trực tiếp; router áp `miniAppAuth` nên cần `X-Telegram-Init-Data`
 * ký hợp lệ. Endpoint gọi `sendPhoto` qua global fetch trong `waitUntil` → stub fetch + cấp
 * executionCtx có `waitUntil`. SePay luôn bật (ALWAYS_ENABLED_PROVIDERS) nên không cần seed cờ.
 * Chạy dưới @cloudflare/vitest-pool-workers (Web Crypto + D1 thật).
 */

const BOT_TOKEN = 'test-bot-token'

const MIN_DEPOSIT = 1_000
const MAX_DEPOSIT = 100_000_000
// Rate hợp lệ (VND-per-USD): đủ để các hiển thị khác đổi sang USD cho user international.
const VALID_RATE = '25000'

// --- Schema tối thiểu (đồng bộ các test deposit hiện có; users có cột region) ---

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
    is_active INTEGER DEFAULT 1,
    region TEXT CHECK(region IN ('vietnam','international')),
    language TEXT,
    language_locked INTEGER NOT NULL DEFAULT 0,
    last_interaction_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL DEFAULT 'sepay' CHECK(provider IN ('sepay','cryptobot')),
    transfer_code TEXT UNIQUE NOT NULL,
    amount INTEGER NOT NULL CHECK(amount > 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','expired','cancelled','awaiting_credit')),
    sepay_transaction_id TEXT,
    bank_ref TEXT,
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

/** Seed giới hạn nạp + rate USDT-VND hợp lệ (để các hiển thị khác SẼ đổi sang USD). */
async function seedConfig(): Promise<void> {
  await env.DB.prepare("INSERT INTO system_config (key, value) VALUES ('min_deposit', ?)")
    .bind(String(MIN_DEPOSIT))
    .run()
  await env.DB.prepare("INSERT INTO system_config (key, value) VALUES ('max_deposit', ?)")
    .bind(String(MAX_DEPOSIT))
    .run()
  await env.DB.prepare("INSERT INTO system_config (key, value) VALUES ('exchange_rate_usdt_vnd', ?)")
    .bind(VALID_RATE)
    .run()
}

/** Buyer vùng vietnam (vùng DUY NHẤT được tạo VietQR), language vi → grouping vi-VN. */
async function seedVietnamBuyer(telegramId: number): Promise<void> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO users (telegram_id, username, first_name, balance, is_active, region, language, last_interaction_at, created_at, updated_at)
     VALUES (?, 'buyer', 'Buyer', 0, 1, 'vietnam', 'vi', ?, ?, ?)`
  )
    .bind(telegramId, now, now, now)
    .run()
}

function getEnvBindings() {
  return {
    DB: env.DB,
    BOT_TOKEN,
    BANK_NAME: 'MB',
    BANK_ACCOUNT: '0123456789',
    BANK_OWNER: 'NGUYEN VAN A',
  }
}

function getExecutionCtx() {
  return {
    waitUntil: (_promise: Promise<unknown>) => {},
    passThroughOnException: () => {},
  }
}

// --- Helper: ký initData hợp lệ (tái hiện thuật toán Telegram WebApp) ---

const encoder = new TextEncoder()

async function hmacSha256(keyBytes: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
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

async function postDeposit(telegramId: number, amount: number) {
  const raw = await signBuyerInitData(telegramId)
  return miniAppApi.request(
    '/deposits',
    {
      method: 'POST',
      headers: {
        'X-Telegram-Init-Data': raw,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ amount }),
    },
    getEnvBindings() as any,
    getExecutionCtx() as any
  )
}

// --- Setup ---

beforeEach(async () => {
  await applySchema()
  await cleanTables()
  await seedConfig()
  _resetRateLimiter()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// --- Property 8 (integration check) ---

describe('Property 8: VietQR payable amount stays VND (integration)', () => {
  /**
   * **Validates: Requirements 5.5**
   * Với rate hợp lệ đã cấu hình, payable `amount_display` của VietQR vẫn là VND_String
   * (kết thúc 'đ', không có '$'), `amount` == số VND yêu cầu, và dùng đúng VND formatter
   * chứ không phải bộ chuyển USD — dù cùng rate đó SẼ đổi hiển thị khác sang USD.
   */
  it('keeps amount_display in VND even with a valid exchange rate configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    )

    // Tiền đề: rate '25000' parse thành Valid_Rate và SẼ đổi hiển thị international sang USD.
    const intlCtx = await buildCurrencyContext(env.DB, { lang: 'vi', region: 'international' })
    expect(intlCtx.rate).toBe(25000)

    // Tiền đề chính sách vùng: international KHÔNG được dùng sepay → VietQR không bao giờ
    // phát payable USD cho international (bị chặn ở endpoint).
    expect(isMethodAllowedForRegion('international', 'sepay')).toBe(false)

    const amounts = [1_000, 25_000, 150_000, 1_234_567, 100_000_000]

    for (let i = 0; i < amounts.length; i++) {
      const amount = amounts[i]
      await cleanTables()
      await seedConfig()
      _resetRateLimiter()

      const telegramId = 5_000_000 + i
      await seedVietnamBuyer(telegramId)

      const res = await postDeposit(telegramId, amount)
      expect(res.status).toBe(200)

      const body = (await res.json()) as ApiResponse<DepositCreatedDto>
      expect(body.success).toBe(true)
      expect(body.error).toBeNull()
      expect(body.data).not.toBeNull()

      const data = body.data!

      // R5.5: payable amount == số VND yêu cầu (không bị chuyển đổi).
      expect(data.amount).toBe(amount)

      // R5.5: payable display là VND_String — kết thúc 'đ', KHÔNG chứa '$'.
      expect(data.amount_display.endsWith('đ')).toBe(true)
      expect(data.amount_display).not.toContain('$')

      // Dùng ĐÚNG VND formatter (vi-VN grouping), KHÔNG phải bộ chuyển USD.
      expect(data.amount_display).toBe(formatMoney(amount, 'vi'))

      // Tương phản: cùng rate hợp lệ đó, context international SẼ đổi sang USD ($...),
      // chứng minh payable VietQR cố tình giữ VND thay vì theo region-aware converter.
      const wouldConvert = formatMoneyFor(amount, intlCtx)
      expect(wouldConvert.startsWith('$')).toBe(true)
      expect(data.amount_display).not.toBe(wouldConvert)
    }
  })
})
