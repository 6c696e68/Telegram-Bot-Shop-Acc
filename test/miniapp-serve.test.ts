import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { app } from '../src/index'
import { miniAppApi } from '../src/routes/miniapp-api'
import { _resetRateLimiter } from '../src/bot/rate-limit'

// Nội dung `dist/miniapp/index.html` được đọc host-side (Node) lúc load `vitest.config.ts`, mã hoá
// BASE64 rồi nội suy vào đây qua Vite `define` (xem config). KHÔNG dùng `node:fs`/`?raw` trong
// test vì workerd (@cloudflare/vitest-pool-workers) không có filesystem thật. Base64 để truyền an
// toàn qua header của pool (ByteString chỉ nhận 0..255; index.html có ký tự tiếng Việt > 255).
// File chưa build → chuỗi rỗng → test build artifact (Req 14.2) fail có ý nghĩa.
declare const __MINIAPP_INDEX_HTML_B64__: string

/** Decode base64 (đã nội suy host-side) về chuỗi UTF-8 nội dung index.html đã build. */
function builtMiniAppIndexHtml(): string {
  const b64 = __MINIAPP_INDEX_HTML_B64__
  if (!b64) return ''
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/**
 * Smoke / integration test cho lớp BUILD & SERVE của Mini App (task 14.4).
 *
 * Bao phủ:
 *  - Req 14.2: `build:miniapp` tạo `dist/miniapp/index.html` (chứa SDK + mount div).
 *  - Req 14.3, 14.4: `/app` được serve bởi `miniAppStatic`; `/cms` và `/webhook/*` vẫn hoạt
 *    động trong CÙNG Worker (không rơi vào 404 JSON catch-all).
 *  - Req 10.1: tạo yêu cầu nạp trên Mini App → bot gửi ảnh VietQR qua `sendPhoto` đúng tham số.
 *  - Req 10.2: SePay cộng tiền cho deposit → bot gửi tin xác nhận qua `sendMessage` đúng tham số.
 *
 * Đây là kiểm tra hạ tầng/cấu hình (KHÔNG phải property-based test).
 */

const BOT_TOKEN = 'test-bot-token'
const SEPAY_API_KEY = 'test-sepay-api-key-12345'
const BANK_NAME = 'MB'
const BANK_ACCOUNT = '0123456789'
const BANK_OWNER = 'NGUYEN VAN TEST'
const USERNAME = 'buyer'
const FIRST_NAME = 'Buyer'

const MIN_DEPOSIT = 20_000
const MAX_DEPOSIT = 100_000_000

// ============================
// Schema & helpers
// ============================

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
    is_active INTEGER DEFAULT 1,
    region TEXT DEFAULT 'vietnam' CHECK(region IN ('vietnam','international')),
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
  `CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL CHECK(type IN ('deposit','purchase','refund','adjustment')),
    amount INTEGER NOT NULL,
    balance_before INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reference_type TEXT,
    reference_id INTEGER,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success','failed','pending')),
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

async function applySchema(db: D1Database) {
  for (const stmt of SCHEMA_STATEMENTS) {
    await db.prepare(stmt).run()
  }
}

async function cleanTables(db: D1Database) {
  await db.prepare('DELETE FROM transactions').run()
  await db.prepare('DELETE FROM deposits').run()
  await db.prepare('DELETE FROM users').run()
  await db.prepare('DELETE FROM system_config').run()
}

async function seedDepositLimits(db: D1Database) {
  await db
    .prepare("INSERT INTO system_config (key, value) VALUES ('min_deposit', ?), ('max_deposit', ?)")
    .bind(String(MIN_DEPOSIT), String(MAX_DEPOSIT))
    .run()
}

/** Env bindings đầy đủ cho app.request / miniAppApi.request. */
function getEnvBindings() {
  return {
    DB: env.DB,
    SEPAY_API_KEY,
    BOT_TOKEN,
    TELEGRAM_SECRET_TOKEN: 'test-telegram-secret',
    ADMIN_IDS: '123456789',
    JWT_SECRET: 'test-jwt-secret',
    BANK_NAME,
    BANK_ACCOUNT,
    BANK_OWNER,
  }
}

// --- executionCtx thật: waitUntil thu promise để await (notify chạy xong trước khi assert) ---

let pendingWaits: Promise<unknown>[] = []

function getExecutionCtx() {
  return {
    waitUntil: (p: Promise<unknown>) => {
      pendingWaits.push(Promise.resolve(p).catch(() => {}))
    },
    passThroughOnException: () => {},
  }
}

// --- Stub fetch: ghi lại (url, body JSON) từng request gửi tới Telegram Bot API ---

interface CapturedCall {
  url: string
  body: Record<string, unknown> | null
}

function stubFetchCapture(): CapturedCall[] {
  const calls: CapturedCall[] = []
  const fn = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    let body: Record<string, unknown> | null = null
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body)
      } catch {
        body = null
      }
    }
    calls.push({ url: String(url), body })
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  })
  vi.stubGlobal('fetch', fn)
  return calls
}

// --- Helper: ký initData hợp lệ (thuật toán Telegram WebApp) ---

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

async function freshInitData(telegramId: number): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  const user = JSON.stringify({ id: telegramId, username: USERNAME, first_name: FIRST_NAME })
  return signInitData({ user, auth_date: String(nowSec) }, BOT_TOKEN)
}

/** telegram_id duy nhất mỗi test để tránh tích luỹ rate-limit. */
let telegramSeq = 0
const BASE_TELEGRAM_ID = 950_000_000
function nextTelegramId(): number {
  return BASE_TELEGRAM_ID + telegramSeq++
}

// ============================
// 1. Build artifact (Req 14.2)
// ============================

describe('Build & serve — artifact build:miniapp (Req 14.2)', () => {
  it('build:miniapp tạo dist/miniapp/index.html chứa Telegram SDK + mount div', () => {
    // Nội dung được nội suy host-side qua `define` (base64) → non-empty nghĩa là file đã build (Req 14.2).
    const html = builtMiniAppIndexHtml()
    expect(html.length).toBeGreaterThan(0)
    // Script SDK Telegram WebApp phải có để window.Telegram.WebApp sẵn sàng.
    expect(html).toContain('telegram.org/js/telegram-web-app.js')
    // Mount point của Vue app.
    expect(html).toContain('id="app"')
  })
})

// ============================
// 2. App routing smoke (Req 14.3, 14.4)
// ============================

/**
 * Một response được coi là "do route tĩnh xử lý" khi KHÔNG phải JSON 404 catch-all
 * (`app.all('*') → c.json({ error: 'Not Found' }, 404)`). Static handler trả text/plain
 * hoặc text/html nên content-type không bao giờ là application/json.
 */
function expectHandledByStaticRoute(res: Response) {
  expect([200, 404]).toContain(res.status)
  const ct = res.headers.get('content-type') ?? ''
  expect(ct.includes('application/json')).toBe(false)
}

describe('Build & serve — routing trong cùng Worker (Req 14.3, 14.4)', () => {
  beforeEach(async () => {
    await applySchema(env.DB)
    await cleanTables(env.DB)
  })

  it('GET /health → 200 { status: "ok" }', async () => {
    const res = await app.request('/health', {}, getEnvBindings() as any, getExecutionCtx() as any)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('GET /app/ được xử lý bởi miniAppStatic (không rơi vào 404 JSON catch-all)', async () => {
    const res = await app.request('/app/', {}, getEnvBindings() as any, getExecutionCtx() as any)
    expectHandledByStaticRoute(res)
    // Khi __STATIC_CONTENT có sẵn asset trong pool → phục vụ index.html (200) chứa SDK.
    if (res.status === 200) {
      const html = await res.text()
      expect(html).toContain('telegram.org/js/telegram-web-app.js')
    }
  })

  it('GET /cms/ vẫn hoạt động (không rơi vào 404 JSON catch-all)', async () => {
    const res = await app.request('/cms/', {}, getEnvBindings() as any, getExecutionCtx() as any)
    expectHandledByStaticRoute(res)
  })

  it('POST /webhook/sepay với API key sai → 401', async () => {
    const res = await app.request(
      '/webhook/sepay',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Apikey wrong-key' },
        body: JSON.stringify({ id: 1, transferType: 'in', content: 'NAP1234XY', transferAmount: 50_000 }),
      },
      getEnvBindings() as any,
      getExecutionCtx() as any
    )
    expect(res.status).toBe(401)
  })

  it('route không tồn tại → 404 JSON catch-all (để đối chiếu)', async () => {
    const res = await app.request('/khong-ton-tai', {}, getEnvBindings() as any, getExecutionCtx() as any)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Not Found' })
  })
})

// ============================
// 3. Bot notify params (Req 10.1, 10.2)
// ============================

describe('Build & serve — đồng bộ tin nhắn bot đúng tham số (Req 10.1, 10.2)', () => {
  beforeEach(async () => {
    await applySchema(env.DB)
    await cleanTables(env.DB)
    await seedDepositLimits(env.DB)
    _resetRateLimiter()
    pendingWaits = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('POST /api/app/deposits → sendPhoto gọi đúng tham số (Req 10.1)', async () => {
    const calls = stubFetchCapture()
    const telegramId = nextTelegramId()
    const amount = 50_000
    const raw = await freshInitData(telegramId)

    const res = await miniAppApi.request(
      '/deposits',
      {
        method: 'POST',
        headers: { 'X-Telegram-Init-Data': raw, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      },
      getEnvBindings() as any,
      getExecutionCtx() as any
    )
    await Promise.all(pendingWaits)

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      success: boolean
      data: { qr_url: string; transfer_code: string }
    }
    expect(body.success).toBe(true)

    // sendPhoto được gọi đúng endpoint + tham số.
    const photoCall = calls.find((c) => c.url.includes('/sendPhoto'))
    expect(photoCall).toBeDefined()
    expect(photoCall!.url).toContain('/sendPhoto')
    expect(photoCall!.body).not.toBeNull()
    // photo = đúng URL VietQR đã trả về cho client, mang đúng amount + transfer_code.
    expect(photoCall!.body!.photo).toBe(body.data.qr_url)
    expect(String(photoCall!.body!.photo)).toContain('img.vietqr.io')
    expect(String(photoCall!.body!.photo)).toContain(`amount=${amount}`)
    expect(String(photoCall!.body!.photo)).toContain(body.data.transfer_code)
    // caption + parse_mode HTML + đúng người nhận.
    expect(typeof photoCall!.body!.caption).toBe('string')
    expect((photoCall!.body!.caption as string).length).toBeGreaterThan(0)
    expect(photoCall!.body!.parse_mode).toBe('HTML')
    expect(photoCall!.body!.chat_id).toBe(telegramId)
  })

  it('SePay cộng tiền cho deposit → sendMessage xác nhận đúng tham số (Req 10.2)', async () => {
    const db = env.DB
    const calls = stubFetchCapture()
    const telegramId = nextTelegramId()
    const transferCode = 'NAP0042A3B7CF'
    const depositAmount = 100_000
    const initialBalance = 50_000

    // Seed user + pending deposit bắt nguồn từ Mini App. User vùng VN (language='vi')
    // → thông báo nạp thành công dùng nhánh tiếng Việt (giữ UX + emoji cũ).
    await db
      .prepare(
        "INSERT INTO users (telegram_id, username, first_name, balance, language, last_interaction_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'vi', datetime('now'), datetime('now'), datetime('now'))"
      )
      .bind(telegramId, USERNAME, FIRST_NAME, initialBalance)
      .run()
    const user = await db.prepare('SELECT id FROM users WHERE telegram_id = ?').bind(telegramId).first<{ id: number }>()
    await db
      .prepare(
        "INSERT INTO deposits (user_id, transfer_code, amount, status, created_at) VALUES (?, ?, ?, 'pending', datetime('now'))"
      )
      .bind(user!.id, transferCode, depositAmount)
      .run()

    const payload = {
      id: 9876543,
      gateway: 'Vietcombank',
      transactionDate: '2024-07-02 11:08:33',
      accountNumber: BANK_ACCOUNT,
      subAccount: null,
      code: 'SEVN63DC8E5C',
      content: `${transferCode} chuyen tien nap`,
      transferType: 'in',
      description: 'Transfer',
      transferAmount: depositAmount,
      accumulated: 10_000_000,
      referenceCode: 'FT24012345678',
    }

    const res = await app.request(
      '/webhook/sepay',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Apikey ${SEPAY_API_KEY}` },
        body: JSON.stringify(payload),
      },
      getEnvBindings() as any,
      getExecutionCtx() as any
    )
    await Promise.all(pendingWaits)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })

    // Deposit đã completed + số dư cộng đúng (tiền đề cho thông báo Req 10.2).
    const deposit = await db
      .prepare('SELECT status FROM deposits WHERE transfer_code = ?')
      .bind(transferCode)
      .first<{ status: string }>()
    expect(deposit!.status).toBe('completed')

    // sendMessage được gọi đúng endpoint + tham số xác nhận cộng tiền.
    const msgCall = calls.find((c) => c.url.includes('/sendMessage'))
    expect(msgCall).toBeDefined()
    expect(msgCall!.url).toContain('/sendMessage')
    expect(msgCall!.body).not.toBeNull()
    expect(msgCall!.body!.chat_id).toBe(telegramId)
    expect(msgCall!.body!.parse_mode).toBe('HTML')
    expect(String(msgCall!.body!.text)).toContain('thành công')
  })
})
