import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import {
  resolvePayOsConfig,
  PAYOS_CLIENT_ID_CONFIG,
  PAYOS_API_KEY_CONFIG,
  PAYOS_CHECKSUM_KEY_CONFIG,
} from '../src/services/payos-config'
import type { Bindings } from '../src/types/bindings'

/**
 * Property + unit tests cho `payos-config.ts` (resolvePayOsConfig).
 *
 * Target: src/services/payos-config.ts. Dùng D1 thật qua
 * @cloudflare/vitest-pool-workers (miniflare) cho bảng `system_config`, khớp convention
 * setup schema + env.DB như test/region-methods.property.test.ts.
 *
 * Validates:
 *  - Property 8: PayOS config resolution is DB-first then env — Requirements 6.1, 6.2, 6.3
 *    Cho mọi tổ hợp (giá trị DB tồn-tại-non-empty-sau-trim / DB rỗng-hoặc-thiếu) ×
 *    (giá trị env tồn tại / vắng) cho từng khoá trong 3 khoá, resolvePayOsConfig trả giá
 *    trị DB (đã trim) khi DB có giá trị non-empty sau trim, ngược lại fallback giá trị env.
 *    Mỗi khoá độc lập (per-key independence).
 */

// system_config: phản chiếu migration 0001 (key-value). resolvePayOsConfig chỉ đọc key/value.
const SCHEMA_STATEMENTS = [
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
  await env.DB.prepare('DELETE FROM system_config').run()
}

/** Ghi một giá trị config (giá trị '' hợp lệ vì cột value chỉ NOT NULL). */
async function seedConfig(key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO system_config (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  )
    .bind(key, value)
    .run()
}

/** Dựng Bindings tối thiểu — resolvePayOsConfig chỉ đọc 3 trường PAYOS_*. */
function makeEnv(
  clientId: string | undefined,
  apiKey: string | undefined,
  checksumKey: string | undefined
): Bindings {
  return {
    PAYOS_CLIENT_ID: clientId,
    PAYOS_API_KEY: apiKey,
    PAYOS_CHECKSUM_KEY: checksumKey,
  } as unknown as Bindings
}

/** Quy tắc kỳ vọng (độc lập với impl): DB thắng khi non-empty sau trim, ngược lại env ?? ''. */
function expectedResolved(dbValue: string | null, envValue: string | undefined): string {
  const trimmed = dbValue?.trim()
  return trimmed ? trimmed : (envValue ?? '')
}

beforeEach(async () => {
  await applySchema()
  await cleanTables()
})

// --- Generators ---

/**
 * Trạng thái giá trị DB cho một khoá:
 *  - `null`  → khoá KHÔNG có trong system_config (thiếu)
 *  - `''`    → khoá tồn tại nhưng rỗng
 *  - whitespace-only → tồn tại nhưng trim ra rỗng (coi như chưa cấu hình)
 *  - non-empty (có/không bao quanh khoảng trắng) → DB thắng (giá trị đã trim)
 */
const dbValueArb: fc.Arbitrary<string | null> = fc.oneof(
  fc.constant(null),
  fc.constant(''),
  fc.constantFrom('   ', '\t', '  \n ', ' \t '),
  fc
    .string({ minLength: 1, maxLength: 30 })
    .filter((s) => s.trim().length > 0)
    .map((s) => ` ${s} `),
  fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0)
)

/** Trạng thái env cho một khoá: vắng (undefined), rỗng, hoặc có giá trị. */
const envValueArb: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constant(undefined),
  fc.constant(''),
  fc.string({ minLength: 1, maxLength: 30 })
)

/** Tổ hợp (db, env) cho một khoá. */
const keyStateArb = fc.record({ db: dbValueArb, env: envValueArb })

// Feature: payos-deposit, Property 8
describe('Property 8: PayOS config resolution is DB-first then env', () => {
  /**
   * **Validates: Requirements 6.1, 6.2, 6.3**
   * Cho 3 khoá độc lập, mỗi khoá lấy giá trị DB (đã trim) nếu DB non-empty sau trim,
   * ngược lại fallback env; per-key independence.
   */
  it('resolves each of the 3 keys DB-first then env, independently', async () => {
    await fc.assert(
      fc.asyncProperty(
        keyStateArb,
        keyStateArb,
        keyStateArb,
        async (clientState, apiState, checksumState) => {
          await cleanTables()

          if (clientState.db !== null) await seedConfig(PAYOS_CLIENT_ID_CONFIG, clientState.db)
          if (apiState.db !== null) await seedConfig(PAYOS_API_KEY_CONFIG, apiState.db)
          if (checksumState.db !== null)
            await seedConfig(PAYOS_CHECKSUM_KEY_CONFIG, checksumState.db)

          const cfg = await resolvePayOsConfig(
            env.DB,
            makeEnv(clientState.env, apiState.env, checksumState.env)
          )

          expect(cfg.clientId).toBe(expectedResolved(clientState.db, clientState.env))
          expect(cfg.apiKey).toBe(expectedResolved(apiState.db, apiState.env))
          expect(cfg.checksumKey).toBe(expectedResolved(checksumState.db, checksumState.env))
        }
      ),
      { numRuns: 80 }
    )
  })
})

// --- Unit tests minh hoạ các trường hợp biên ---

describe('resolvePayOsConfig — unit cases', () => {
  it('prefers non-empty DB values over env (R6.1, R6.2)', async () => {
    await seedConfig(PAYOS_CLIENT_ID_CONFIG, 'db_client')
    await seedConfig(PAYOS_API_KEY_CONFIG, 'db_api')
    await seedConfig(PAYOS_CHECKSUM_KEY_CONFIG, 'db_checksum')

    const cfg = await resolvePayOsConfig(env.DB, makeEnv('env_client', 'env_api', 'env_checksum'))

    expect(cfg).toEqual({ clientId: 'db_client', apiKey: 'db_api', checksumKey: 'db_checksum' })
  })

  it('falls back to env when DB keys are missing (R6.3)', async () => {
    const cfg = await resolvePayOsConfig(env.DB, makeEnv('env_client', 'env_api', 'env_checksum'))

    expect(cfg).toEqual({
      clientId: 'env_client',
      apiKey: 'env_api',
      checksumKey: 'env_checksum',
    })
  })

  it('treats empty / whitespace-only DB values as unconfigured and falls back to env', async () => {
    await seedConfig(PAYOS_CLIENT_ID_CONFIG, '')
    await seedConfig(PAYOS_API_KEY_CONFIG, '   ')

    const cfg = await resolvePayOsConfig(env.DB, makeEnv('env_client', 'env_api', undefined))

    expect(cfg.clientId).toBe('env_client')
    expect(cfg.apiKey).toBe('env_api')
    // DB thiếu + env vắng → rỗng.
    expect(cfg.checksumKey).toBe('')
  })

  it('trims surrounding whitespace from DB values', async () => {
    await seedConfig(PAYOS_CLIENT_ID_CONFIG, '  spaced_client  ')

    const cfg = await resolvePayOsConfig(env.DB, makeEnv(undefined, undefined, undefined))

    expect(cfg.clientId).toBe('spaced_client')
  })

  it('resolves independently per key (mix of DB and env sources)', async () => {
    await seedConfig(PAYOS_CLIENT_ID_CONFIG, 'db_client')
    // api_key chỉ ở env; checksum_key rỗng ở DB → env.

    await seedConfig(PAYOS_CHECKSUM_KEY_CONFIG, '')

    const cfg = await resolvePayOsConfig(env.DB, makeEnv(undefined, 'env_api', 'env_checksum'))

    expect(cfg.clientId).toBe('db_client')
    expect(cfg.apiKey).toBe('env_api')
    expect(cfg.checksumKey).toBe('env_checksum')
  })
})
