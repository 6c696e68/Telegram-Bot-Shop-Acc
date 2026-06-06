import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import {
  resolveLang,
  setRegion,
  setLanguage,
} from '../src/services/user-locale'
import {
  SUPPORTED_LANGUAGES,
  BASE_FALLBACK_LANG,
  isSupportedLang,
  type Lang,
  type Region,
} from '../src/i18n/locales'

/**
 * Property-based tests cho fallback ngôn ngữ + lock của User Locale service.
 *
 * Target: src/services/user-locale.ts (resolveLang, setRegion, setLanguage) và
 * registry src/i18n/locales.ts. Dùng D1 thật qua @cloudflare/vitest-pool-workers
 * (miniflare) để bám đúng hành vi câu lệnh UPDATE/SELECT.
 */

// --- Schema tối thiểu: phản chiếu shape users sau migration 0008 + system_config ---

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
  await env.DB.prepare('DELETE FROM users').run()
  await env.DB.prepare('DELETE FROM system_config').run()
}

/** Tạo user với region/language/language_locked tuỳ chọn; trả về users.id. */
async function seedUser(opts: {
  telegramId: number
  region?: Region | null
  language?: string | null
  languageLocked?: 0 | 1
}): Promise<number> {
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO users (telegram_id, username, first_name, balance, region, language, language_locked, created_at, updated_at)
     VALUES (?, 'u', 'U', 0, ?, ?, ?, ?, ?)`
  )
    .bind(
      opts.telegramId,
      opts.region ?? null,
      opts.language ?? null,
      opts.languageLocked ?? 0,
      now,
      now
    )
    .run()
  const row = await env.DB.prepare('SELECT id FROM users WHERE telegram_id = ?')
    .bind(opts.telegramId)
    .first<{ id: number }>()
  return row!.id
}

async function readUser(
  userId: number
): Promise<{ region: string | null; language: string | null; language_locked: number }> {
  const row = await env.DB.prepare(
    'SELECT region, language, language_locked FROM users WHERE id = ?'
  )
    .bind(userId)
    .first<{ region: string | null; language: string | null; language_locked: number }>()
  return row!
}

async function setDefaultLanguageConfig(value: string | null): Promise<void> {
  if (value === null) return // không cấu hình -> mô phỏng key vắng mặt
  await env.DB.prepare(
    "INSERT INTO system_config (key, value) VALUES ('default_language', ?)"
  )
    .bind(value)
    .run()
}

// --- Generators ---

const arbLang = fc.constantFrom<Lang>(...SUPPORTED_LANGUAGES)
const arbRegion = fc.constantFrom<Region>('vietnam', 'international')
const arbTelegramId = fc.integer({ min: 1, max: 9_999_999_999 })

/** Chuỗi tuỳ ý: gồm cả mã hợp lệ, rỗng, và rác (mô phỏng config/user.language sai). */
const arbMaybeLangValue = fc.oneof(
  fc.constantFrom('vi', 'en'),
  fc.constant(''),
  fc.constant('  '),
  fc.constant('VI'),
  fc.constant('fr'),
  fc.constant('xx'),
  fc.string()
)

beforeEach(async () => {
  await applySchema()
  await cleanTables()
})

// Feature: multi-region-payments, Property 7
describe('Property 7: Ngôn ngữ độc lập vùng', () => {
  /**
   * **Validates: Requirements 6.4**
   * setLanguage đặt language_locked=1; sau đó đổi region (qua bất kỳ chuỗi region nào)
   * KHÔNG làm thay đổi language. Region vẫn được cập nhật như yêu cầu.
   */
  it('setLanguage locks language; subsequent setRegion never changes it', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbTelegramId,
        arbLang,
        fc.array(arbRegion, { minLength: 1, maxLength: 5 }),
        // region khởi tạo của user (có thể null = chưa onboarding)
        fc.option(arbRegion, { nil: null }),
        async (telegramId, chosenLang, regionSequence, initialRegion) => {
          await cleanTables()

          const userId = await seedUser({
            telegramId,
            region: initialRegion,
            language: null,
            languageLocked: 0,
          })

          // User tự chọn ngôn ngữ -> phải set lock=1.
          await setLanguage(env.DB, userId, chosenLang)
          const afterSetLang = await readUser(userId)
          expect(afterSetLang.language).toBe(chosenLang)
          expect(afterSetLang.language_locked).toBe(1)

          // Đổi region nhiều lần -> language phải giữ nguyên, region phải cập nhật.
          for (const region of regionSequence) {
            await setRegion(env.DB, userId, region)
            const afterSetRegion = await readUser(userId)
            expect(afterSetRegion.language).toBe(chosenLang)
            expect(afterSetRegion.language_locked).toBe(1)
            expect(afterSetRegion.region).toBe(region)
          }
        }
      ),
      { numRuns: 50 }
    )
  })
})

// Feature: multi-region-payments, Property 8
describe('Property 8: Mở rộng ngôn ngữ an toàn', () => {
  /**
   * **Validates: Requirements 4.3, 17.5**
   * resolveLang luôn trả một Lang hợp lệ (thuộc SUPPORTED_LANGUAGES) với MỌI đầu vào —
   * kể cả user.language rác/null và default_language trong config sai/vắng mặt — và không
   * bao giờ ném lỗi. Kết quả tuân thủ đúng chuỗi fallback xác định:
   *   user.language (nếu hợp lệ) -> default_language config (nếu hợp lệ) -> BASE_FALLBACK_LANG.
   */
  it('resolveLang always returns a valid Lang following the deterministic fallback chain', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(arbMaybeLangValue, fc.constant<string | null>(null)),
        fc.oneof(arbMaybeLangValue, fc.constant<string | null>(null)),
        async (userLang, configLang) => {
          await cleanTables()
          await setDefaultLanguageConfig(configLang)

          const result = await resolveLang(env.DB, { language: userLang })

          // 1) Luôn là một Lang hợp lệ thuộc registry.
          expect(SUPPORTED_LANGUAGES).toContain(result)
          expect(isSupportedLang(result)).toBe(true)

          // 2) Tuân thủ chuỗi fallback xác định.
          const expected: Lang = isSupportedLang(userLang)
            ? userLang
            : isSupportedLang(configLang)
              ? configLang
              : BASE_FALLBACK_LANG
          expect(result).toBe(expected)
        }
      ),
      { numRuns: 100 }
    )
  })
})
