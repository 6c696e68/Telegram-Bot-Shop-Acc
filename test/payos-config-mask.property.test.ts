import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { SignJWT } from 'jose'
import { app } from '../src/index'

/**
 * Property-based + unit tests cho masking secret PayOS trong admin config API.
 *
 * Property 21: PayOS secrets are never exposed by the admin config API
 *   — Với bất kỳ giá trị lưu trữ nào của `payos_api_key`/`payos_checksum_key`,
 *     `GET /api/admin/config` trả về chuỗi rỗng cho các key đó với `secrets_set` true,
 *     và `PUT` với giá trị rỗng cho chúng giữ nguyên giá trị đã lưu.
 *     `payos_client_id` (không phải secret) được trả về bình thường.
 *
 * **Validates: Requirements 21.1, 21.2, 21.3**
 */

const JWT_SECRET = 'test-jwt-secret'

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    last_login_at TEXT,
    failed_login_count INTEGER DEFAULT 0,
    locked_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER REFERENCES admin_users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL REFERENCES admin_users(id),
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id INTEGER,
    old_value TEXT,
    new_value TEXT,
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
]

async function applySchema(db: D1Database) {
  for (const stmt of SCHEMA_STATEMENTS) {
    await db.prepare(stmt).run()
  }
}

async function cleanTables(db: D1Database) {
  await db.prepare('DELETE FROM audit_logs').run()
  await db.prepare('DELETE FROM system_config').run()
  await db.prepare('DELETE FROM admin_users').run()
}

async function seedAdminUser(db: D1Database): Promise<number> {
  const hash = '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012'
  await db
    .prepare(
      "INSERT INTO admin_users (username, password_hash, display_name, created_at) VALUES ('testadmin', ?, 'Test Admin', datetime('now'))"
    )
    .bind(hash)
    .run()
  const admin = await db
    .prepare("SELECT id FROM admin_users WHERE username = 'testadmin'")
    .first<{ id: number }>()
  return admin!.id
}

async function generateJwt(adminId: number, username = 'testadmin'): Promise<string> {
  const secret = new TextEncoder().encode(JWT_SECRET)
  return new SignJWT({ sub: String(adminId), username })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secret)
}

// Env bindings KHÔNG đặt PAYOS_API_KEY/PAYOS_CHECKSUM_KEY để không nhiễu cờ secrets_set
// (test kiểm soát giá trị qua DB). PAYOS_CLIENT_ID cũng để trống.
function getEnvBindings() {
  return {
    DB: env.DB,
    SEPAY_API_KEY: 'test-sepay-key',
    BOT_TOKEN: 'test-bot-token',
    TELEGRAM_SECRET_TOKEN: 'test-telegram-secret',
    ADMIN_IDS: '123456789',
    JWT_SECRET,
  }
}

async function apiRequest(
  method: string,
  path: string,
  token: string,
  body?: unknown
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return app.request(path, init, getEnvBindings() as any)
}

async function setConfig(db: D1Database, key: string, value: string) {
  await db
    .prepare(
      "INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, datetime('now'))"
    )
    .bind(key, value)
    .run()
}

async function readStoredValue(db: D1Database, key: string): Promise<string | undefined> {
  const row = await db
    .prepare('SELECT value FROM system_config WHERE key = ?')
    .bind(key)
    .first<{ value: string }>()
  return row?.value
}

type ConfigGetResponse = {
  success: boolean
  data: { configs: Record<string, string>; secrets_set: Record<string, boolean> }
  error: unknown
}

// Secret/client values dùng prefix riêng + hex để (a) luôn không rỗng sau trim,
// (b) phân biệt nhau nên kiểm tra "không lộ giá trị" không dính va chạm chuỗi
// trùng ngẫu nhiên với các phần khác của JSON.
const arbApiKey = fc.hexaString({ minLength: 6, maxLength: 32 }).map((h) => `apikey-${h}`)
const arbChecksumKey = fc.hexaString({ minLength: 6, maxLength: 32 }).map((h) => `checksum-${h}`)
const arbClientId = fc.hexaString({ minLength: 6, maxLength: 32 }).map((h) => `clientid-${h}`)

// Giá trị rỗng/khoảng trắng — phải bị PUT bỏ qua cho secret key.
const arbBlankValue = fc.constantFrom('', '   ', '\t', '\n  ')

const SECRET_KEYS = ['payos_api_key', 'payos_checksum_key'] as const

// Reset giữa các lần chạy property: chỉ xoá system_config (giữ admin_users để
// admin_id trong JWT vẫn tham chiếu hợp lệ khi PUT ghi audit_logs).
async function resetConfig(db: D1Database) {
  await db.prepare('DELETE FROM audit_logs').run()
  await db.prepare('DELETE FROM system_config').run()
}

describe('Property 21: PayOS secrets are never exposed by the admin config API', () => {
  let adminId: number
  let token: string

  beforeEach(async () => {
    await applySchema(env.DB)
    await cleanTables(env.DB)
    adminId = await seedAdminUser(env.DB)
    token = await generateJwt(adminId)
  })

  /**
   * **Validates: Requirements 21.2**
   * GET masks payos_api_key/payos_checksum_key to '' while reporting secrets_set=true
   * for any non-empty stored value. payos_client_id is returned verbatim.
   */
  it('GET masks PayOS secrets to empty with secrets_set, returns client_id normally', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbApiKey,
        arbChecksumKey,
        arbClientId,
        async (apiKey, checksumKey, clientId) => {
          await resetConfig(env.DB)

          await setConfig(env.DB, 'payos_api_key', apiKey)
          await setConfig(env.DB, 'payos_checksum_key', checksumKey)
          await setConfig(env.DB, 'payos_client_id', clientId)

          const res = await apiRequest('GET', '/api/admin/config', token)
          expect(res.status).toBe(200)
          const json = (await res.json()) as ConfigGetResponse

          // Secret keys masked to '' and never echo the real value.
          for (const key of SECRET_KEYS) {
            expect(json.data.configs[key]).toBe('')
            expect(json.data.secrets_set[key]).toBe(true)
          }
          // The raw secret values must not appear anywhere in the response body.
          const body = JSON.stringify(json)
          expect(body).not.toContain(apiKey)
          expect(body).not.toContain(checksumKey)

          // client_id is not a secret → returned verbatim, not flagged as secret.
          expect(json.data.configs['payos_client_id']).toBe(clientId)
          expect(json.data.secrets_set['payos_client_id']).toBeUndefined()
        }
      ),
      { numRuns: 25 }
    )
  })

  /**
   * **Validates: Requirements 21.3**
   * PUT with an empty/blank value for a PayOS secret key leaves the stored secret intact.
   */
  it('PUT with empty value preserves existing PayOS secret', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbApiKey,
        arbChecksumKey,
        arbBlankValue,
        arbBlankValue,
        async (apiKey, checksumKey, blankApi, blankChecksum) => {
          await resetConfig(env.DB)

          await setConfig(env.DB, 'payos_api_key', apiKey)
          await setConfig(env.DB, 'payos_checksum_key', checksumKey)

          const res = await apiRequest('PUT', '/api/admin/config', token, {
            configs: {
              payos_api_key: blankApi,
              payos_checksum_key: blankChecksum,
            },
          })
          expect(res.status).toBe(200)

          // Stored secrets unchanged (blank PUT skipped).
          expect(await readStoredValue(env.DB, 'payos_api_key')).toBe(apiKey)
          expect(await readStoredValue(env.DB, 'payos_checksum_key')).toBe(checksumKey)
        }
      ),
      { numRuns: 25 }
    )
  })

  /**
   * **Validates: Requirements 21.3**
   * PUT with a non-empty value DOES update the secret (counterpart to the skip rule),
   * so masking does not block legitimate rotation.
   */
  it('PUT with non-empty value updates the PayOS secret', async () => {
    await fc.assert(
      fc.asyncProperty(arbApiKey, arbApiKey, async (oldKey, newKey) => {
        await resetConfig(env.DB)
        await setConfig(env.DB, 'payos_api_key', oldKey)

        await apiRequest('PUT', '/api/admin/config', token, {
          configs: { payos_api_key: newKey },
        })

        expect(await readStoredValue(env.DB, 'payos_api_key')).toBe(newKey)
      }),
      { numRuns: 20 }
    )
  })

  /**
   * **Validates: Requirements 21.2**
   * When no value is stored (and no env secret), secrets_set is false and value masked.
   */
  it('reports secrets_set=false when no PayOS secret is stored', async () => {
    await setConfig(env.DB, 'payos_client_id', 'client-123')

    const res = await apiRequest('GET', '/api/admin/config', token)
    const json = (await res.json()) as ConfigGetResponse

    for (const key of SECRET_KEYS) {
      // Key absent from DB → not present in configs map, secrets_set false/undefined.
      expect(json.data.configs[key] ?? '').toBe('')
      expect(json.data.secrets_set[key] ?? false).toBe(false)
    }
    expect(json.data.configs['payos_client_id']).toBe('client-123')
  })
})
