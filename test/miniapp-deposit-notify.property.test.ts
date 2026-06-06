import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { miniAppApi } from '../src/routes/miniapp-api'
import { escapeHtml } from '../src/utils/telegram-template'
import { _resetRateLimiter } from '../src/bot/rate-limit'

// Feature: telegram-mini-app, Property 11, Property 12
/**
 * Property-based + example test cho `POST /api/app/deposits` — đồng bộ tin nhắn bot khi nạp tiền.
 *
 * **Property 11: Escape HTML cho caption nạp tiền**
 * **Validates: Requirements 10.3, 15.1**
 *   Caption ảnh VietQR gửi qua `sendPhoto` PHẢI escape HTML các giá trị động (chủ TK
 *   `bank_owner`, nội dung CK `transfer_code`) trước khi gửi qua Telegram Bot API.
 *
 * **Property 12: Lỗi gửi tin nhắn bot không rollback yêu cầu nạp đã tạo**
 * **Validates: Requirements 10.4**
 *   `sendPhoto` chạy fire-and-forget SAU commit qua `c.executionCtx.waitUntil(...)`. Một lỗi
 *   khi gửi tin (Telegram API down) KHÔNG được phép làm hỏng HTTP response (vẫn 200 + success)
 *   và KHÔNG được rollback bản ghi `deposits` đã tạo (vẫn còn đúng 1 dòng `pending`).
 *
 * Cách bắt caption: stub `global.fetch` bằng `vi.fn` ghi lại body mỗi request. Endpoint gọi
 * Telegram `sendPhoto` → URL chứa `/sendPhoto`, body JSON `{ chat_id, photo, caption, parse_mode }`.
 *
 * Vì `sendPhoto` chạy trong `waitUntil`, cung cấp `executionCtx` thu các promise vào `pendingWaits`
 * rồi `await` để fetch thực sự được gọi trước khi assert.
 *
 * Mount router `miniAppApi` trực tiếp (không phụ thuộc đăng ký ở `src/index.ts`). Router đã áp
 * `miniAppAuth` nên mỗi request cần header `X-Telegram-Init-Data` ký hợp lệ. Chạy dưới
 * `@cloudflare/vitest-pool-workers` nên Web Crypto + D1 thật có sẵn.
 */

const BOT_TOKEN = 'test-bot-token'
const USERNAME = 'buyer'
const FIRST_NAME = 'Buyer'

// Giới hạn nạp seed vào system_config — để amount sinh ra luôn nằm trong khoảng hợp lệ.
const MIN_DEPOSIT = 20_000
const MAX_DEPOSIT = 100_000_000

// --- Schema tối thiểu cho luồng nạp tiền (trích migration 0001) ---

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

/** Dọn sạch các bảng liên quan (thứ tự tôn trọng FK). */
async function cleanTables(db: D1Database) {
  await db.prepare('DELETE FROM deposits').run()
  await db.prepare('DELETE FROM users').run()
  await db.prepare('DELETE FROM system_config').run()
}

/** Seed giới hạn nạp để mọi amount test nằm trong [min, max] → endpoint không trả 400. */
async function seedDepositLimits(db: D1Database) {
  await db
    .prepare("INSERT INTO system_config (key, value) VALUES ('min_deposit', ?), ('max_deposit', ?)")
    .bind(String(MIN_DEPOSIT), String(MAX_DEPOSIT))
    .run()
}

/** Env bindings cho request — cho phép truyền BANK_OWNER chứa ký tự HTML đặc biệt. */
function makeEnv(bankOwner: string) {
  return {
    DB: env.DB,
    BOT_TOKEN,
    BANK_NAME: 'MB',
    BANK_ACCOUNT: '0123456789',
    BANK_OWNER: bankOwner,
  }
}

// --- executionCtx thật: waitUntil thu promise để await (sendPhoto chạy xong trước khi assert) ---

let pendingWaits: Promise<unknown>[] = []

function makeExecutionCtx() {
  return {
    waitUntil: (p: Promise<unknown>) => {
      // Controller đã có .catch; bọc thêm để không gây unhandled rejection khi notify lỗi.
      pendingWaits.push(Promise.resolve(p).catch(() => {}))
    },
    passThroughOnException: () => {},
  }
}

// --- Helper: ký initData hợp lệ (thuật toán Telegram WebApp) ---

const encoder = new TextEncoder()

async function hmacSha256(
  keyBytes: ArrayBuffer | Uint8Array,
  message: string
): Promise<ArrayBuffer> {
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

/** initData tươi (auth_date = now) cho `telegramId` để vượt TTL. */
async function freshInitData(telegramId: number): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  const user = JSON.stringify({ id: telegramId, username: USERNAME, first_name: FIRST_NAME })
  return signInitData({ user, auth_date: String(nowSec) }, BOT_TOKEN)
}

// --- Stub fetch ---

interface CapturedCall {
  url: string
  body: Record<string, unknown> | null
}

/** Stub Telegram fetch thành công + ghi lại (url, body JSON) từng request. */
function stubFetchCapture(): { fn: ReturnType<typeof vi.fn>; calls: CapturedCall[] } {
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
  return { fn, calls }
}

/** Stub Telegram fetch lỗi (reject) — mô phỏng Telegram API down. */
function stubFetchThrow(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => {
    throw new Error('telegram down')
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

/** Tìm caption từ call `sendPhoto` đầu tiên đã ghi lại. */
function findSendPhotoCaption(calls: CapturedCall[]): string | undefined {
  const call = calls.find((c) => c.url.includes('/sendPhoto'))
  return call?.body?.caption as string | undefined
}

/** Gọi POST /deposits với initData hợp lệ rồi await mọi waitUntil (sendPhoto chạy xong). */
async function doDeposit(telegramId: number, amount: number, bankOwner: string): Promise<Response> {
  const raw = await freshInitData(telegramId)
  pendingWaits = []
  const res = await miniAppApi.request(
    '/deposits',
    {
      method: 'POST',
      headers: { 'X-Telegram-Init-Data': raw, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount }),
    },
    makeEnv(bankOwner) as unknown as Record<string, unknown>,
    makeExecutionCtx() as unknown as ExecutionContext
  )
  await Promise.all(pendingWaits)
  return res
}

/** Đọc tất cả deposit của một telegram_id (JOIN qua users.telegram_id). */
async function depositsOf(db: D1Database, telegramId: number) {
  return (
    await db
      .prepare(
        `SELECT d.amount, d.status, d.transfer_code
         FROM deposits d
         JOIN users u ON u.id = d.user_id
         WHERE u.telegram_id = ?`
      )
      .bind(telegramId)
      .all<{ amount: number; status: string; transfer_code: string }>()
  ).results
}

// --- telegram_id duy nhất mỗi iteration (tránh tích luỹ rate-limit; DEPOSIT_RULE capacity 3) ---

let telegramSeq = 0
const BASE_TELEGRAM_ID = 800_000_000

function nextTelegramId(): number {
  return BASE_TELEGRAM_ID + telegramSeq++
}

// --- Generators ---

/**
 * Token pool đối nghịch cho `bank_owner`: trộn ký tự đặc biệt HTML (`& < >`), chuỗi giống thẻ
 * và văn bản thường để ép caption phải escape đúng. Luôn chèn ít nhất một ký tự đặc biệt.
 */
const ownerTokenArb = fc.constantFrom(
  '&',
  '<',
  '>',
  '<b>',
  '</b>',
  '<script>',
  '&amp;',
  'A',
  'B',
  'Owner',
  ' ',
  'Công',
  'Ty'
)

/** Chủ TK chứa ít nhất một ký tự HTML đặc biệt (đảm bảo bất biến escape có ý nghĩa). */
const arbBankOwner = fc
  .array(ownerTokenArb, { minLength: 1, maxLength: 8 })
  .map((parts) => parts.join(''))
  .map((s) => (/[&<>]/.test(s) ? s : `${s} <X>`))

const arbAmount = fc.integer({ min: MIN_DEPOSIT, max: 2_000_000 })

// --- Setup ---

beforeEach(async () => {
  await applySchema(env.DB)
  await cleanTables(env.DB)
  await seedDepositLimits(env.DB)
  _resetRateLimiter()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// === PART A — Property 11: Escape HTML caption nạp tiền (Req 10.3, 15.1) ===

describe('Property 11: Escape HTML caption nạp tiền (deposit)', () => {
  /**
   * **Validates: Requirements 10.3, 15.1**
   * Ví dụ xác định: BANK_OWNER chứa `& < >` → caption chứa bản đã escape, KHÔNG còn `<Owner>` thô.
   */
  it('example: caption escapes bank_owner, không chứa "<Owner>" thô', async () => {
    const { fn, calls } = stubFetchCapture()
    const owner = 'A & B <Owner>'

    const res = await doDeposit(nextTelegramId(), 50_000, owner)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean }
    expect(body.success).toBe(true)
    expect(fn).toHaveBeenCalled()

    const caption = findSendPhotoCaption(calls)
    expect(caption).toBeDefined()

    // Owner đã escape: 'A & B <Owner>' → 'A &amp; B &lt;Owner&gt;'
    expect(caption!).toContain(escapeHtml(owner))
    expect(caption!).toContain('A &amp; B &lt;Owner&gt;')
    // KHÔNG còn dạng thô nguy hiểm
    expect(caption!).not.toContain('<Owner>')
    expect(caption!).not.toContain('A & B') // '&' thô đã thành '&amp;'
  })

  /**
   * **Validates: Requirements 10.3, 15.1**
   * Với mọi BANK_OWNER chứa ký tự HTML đặc biệt + amount trong khoảng: caption chứa bản
   * đã escape của owner; sau khi gỡ markup cố định (`<b>`/`<code>` + entity), không còn ký tự
   * `< > &` thô nào sót lại (transfer_code do server sinh là alphanumeric nên không tạo nhiễu).
   */
  it('property: dynamic bank_owner luôn được escape trong caption sendPhoto', async () => {
    await fc.assert(
      fc.asyncProperty(arbBankOwner, arbAmount, async (owner, amount) => {
        const { calls } = stubFetchCapture()

        const res = await doDeposit(nextTelegramId(), amount, owner)
        expect(res.status).toBe(200)

        const caption = findSendPhotoCaption(calls)
        expect(caption).toBeDefined()

        // (1) Owner xuất hiện ở dạng đã escape.
        expect(caption!.includes(escapeHtml(owner))).toBe(true)

        // (2) Sau khi gỡ thẻ cố định + entity hợp lệ, không còn ký tự HTML thô nào.
        const residual = caption!
          .replace(/&amp;/g, '')
          .replace(/&lt;/g, '')
          .replace(/&gt;/g, '')
          .replace(/<\/?b>/g, '')
          .replace(/<\/?code>/g, '')
        expect(residual.includes('<')).toBe(false)
        expect(residual.includes('>')).toBe(false)
        expect(residual.includes('&')).toBe(false)

        vi.unstubAllGlobals()
      }),
      { numRuns: 50 }
    )
  })
})

// === PART B — Property 12: Lỗi gửi tin không rollback deposit (Req 10.4) ===

describe('Property 12: Lỗi gửi tin nhắn bot không rollback yêu cầu nạp', () => {
  /**
   * **Validates: Requirements 10.4**
   * Ví dụ xác định: sendPhoto ném lỗi → response vẫn 200 + success, deposit vẫn `pending`.
   */
  it('example: sendPhoto throw → 200 + success và deposit còn pending', async () => {
    const fn = stubFetchThrow()
    const telegramId = nextTelegramId()
    const amount = 50_000

    const res = await doDeposit(telegramId, amount, 'Owner')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { success: boolean; data: { status: string } | null }
    expect(body.success).toBe(true)
    expect(body.data?.status).toBe('pending')
    expect(fn).toHaveBeenCalled() // notify đã được gọi và ném lỗi

    const rows = await depositsOf(env.DB, telegramId)
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('pending')
    expect(rows[0].amount).toBe(amount)
  })

  /**
   * **Validates: Requirements 10.4**
   * Với mọi amount trong khoảng: sendPhoto ném lỗi → response 200 + success và đúng 1 bản ghi
   * deposit `pending` với amount tương ứng (lỗi gửi tin bị nuốt, không rollback).
   */
  it('property: notify throw luôn để lại đúng 1 deposit pending + response 200', async () => {
    await fc.assert(
      fc.asyncProperty(arbAmount, async (amount) => {
        const fn = stubFetchThrow()
        const telegramId = nextTelegramId()

        const res = await doDeposit(telegramId, amount, 'Owner')
        expect(res.status).toBe(200) // Req 10.4: lỗi gửi tin KHÔNG ảnh hưởng response
        const body = (await res.json()) as { success: boolean }
        expect(body.success).toBe(true)
        expect(fn).toHaveBeenCalled()

        const rows = await depositsOf(env.DB, telegramId)
        expect(rows).toHaveLength(1)
        expect(rows[0].status).toBe('pending')
        expect(rows[0].amount).toBe(amount)

        vi.unstubAllGlobals()
      }),
      { numRuns: 50 }
    )
  })
})
