import { describe, it, expect } from 'vitest'
import { SUPPORTED_LANGUAGES, BASE_FALLBACK_LANG } from '../src/i18n/locales'
import { catalogs } from '../src/bot/i18n'
import { en as botEn } from '../src/bot/i18n/catalogs/en'

// Mini App messages (nested JSON)
import miniEn from '../miniapp/src/i18n/messages/en.json'
import miniVi from '../miniapp/src/i18n/messages/vi.json'
// CMS messages (nested JSON)
import cmsEn from '../cms/src/i18n/messages/en.json'
import cmsVi from '../cms/src/i18n/messages/vi.json'

/**
 * i18n coverage — đảm bảo mọi locale có ĐỦ key như locale gốc (R4.5, R17.1, R18.1).
 *
 * Phát hiện thiếu/thừa bản dịch khi thêm ngôn ngữ ở 3 tầng: bot catalog, Mini App, CMS.
 * Locale gốc dùng để đối chiếu: bot = BASE_FALLBACK_LANG ('en'); miniapp/cms = 'en'.
 */

/** Làm phẳng key của object lồng nhau: { a: { b: 1 } } -> ['a.b']. */
function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k
    if (v !== null && typeof v === 'object') {
      keys.push(...flattenKeys(v as Record<string, unknown>, full))
    } else {
      keys.push(full)
    }
  }
  return keys.sort()
}

function expectSameKeys(base: string[], target: string[], label: string): void {
  const baseSet = new Set(base)
  const targetSet = new Set(target)
  const missing = base.filter((k) => !targetSet.has(k))
  const extra = target.filter((k) => !baseSet.has(k))
  expect(missing, `${label}: thiếu key`).toEqual([])
  expect(extra, `${label}: thừa key`).toEqual([])
}

describe('i18n coverage — bot catalog', () => {
  const baseKeys = Object.keys(botEn as Record<string, string>).sort()

  for (const lang of SUPPORTED_LANGUAGES) {
    it(`bot catalog [${lang}] đủ key như ${BASE_FALLBACK_LANG}`, () => {
      const catalog = catalogs[lang] as Record<string, string>
      expectSameKeys(baseKeys, Object.keys(catalog).sort(), `bot:${lang}`)
    })
  }
})

describe('i18n coverage — Mini App messages', () => {
  const baseKeys = flattenKeys(miniEn as Record<string, unknown>)
  const byLang: Record<string, Record<string, unknown>> = { en: miniEn, vi: miniVi }

  for (const lang of SUPPORTED_LANGUAGES) {
    it(`miniapp [${lang}] đủ key như en`, () => {
      expectSameKeys(baseKeys, flattenKeys(byLang[lang]), `miniapp:${lang}`)
    })
  }
})

describe('i18n coverage — CMS messages', () => {
  const baseKeys = flattenKeys(cmsEn as Record<string, unknown>)
  const byLang: Record<string, Record<string, unknown>> = { en: cmsEn, vi: cmsVi }

  for (const lang of SUPPORTED_LANGUAGES) {
    it(`cms [${lang}] đủ key như en`, () => {
      expectSameKeys(baseKeys, flattenKeys(byLang[lang]), `cms:${lang}`)
    })
  }
})
