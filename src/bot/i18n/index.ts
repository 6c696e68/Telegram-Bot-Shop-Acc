/**
 * i18n Bot — catalog TS thuan (message tinh, khong can thu vien).
 *
 * Kien truc (R4.1, R17.5):
 *  - `catalogs: Record<Lang, Record<MessageKey, string>>` gom moi locale.
 *  - `t(lang, key, vars?)` lay chuoi theo `lang`, noi suy `{var}`.
 *  - Fallback xac dinh: `lang` -> `BASE_FALLBACK_LANG` -> tra ve `key` (KHONG vo
 *    giao dien khi thieu ban dich — hien text/key thay vi crash).
 *
 * Them ngon ngu = them 1 file catalog (chu thuan, khong emoji) + 1 dong trong
 * SUPPORTED_LANGUAGES + 1 entry duoi day. KHONG sua helper, KHONG sua key (OCP).
 */

import { SUPPORTED_LANGUAGES, BASE_FALLBACK_LANG, type Lang } from '../../i18n/locales'
import type { MessageKey } from './keys'
import { en } from './catalogs/en'
import { vi } from './catalogs/vi'

export type { MessageKey } from './keys'

/** Tap bien noi suy truyen vao `t` (gia tri se duoc ep ve chuoi). */
export type TemplateVars = Record<string, string | number>

/** Catalog cua mot locale: phang theo MessageKey. */
export type Catalog = Record<MessageKey, string>

/**
 * Registry catalog theo locale. Khoa = ma trong SUPPORTED_LANGUAGES.
 * Moi catalog deu la Record<MessageKey,string> nen dong bo key duoc bao dam o type.
 */
export const catalogs: Record<Lang, Catalog> = {
  en,
  vi,
}

/**
 * Noi suy `{var}` trong template bang gia tri tu `vars`.
 * Placeholder khong co gia tri -> giu nguyen (khong vo, de phat hien thieu bien).
 */
function interpolate(template: string, vars?: TemplateVars): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * Lay chuoi da dich theo ngon ngu, noi suy bien.
 *
 * Thu tu fallback (R17.5 — khong vo khi thieu key/ban dich):
 *   catalogs[lang][key] -> catalogs[BASE_FALLBACK_LANG][key] -> key
 *
 * @param lang - ngon ngu hien thi cua user (da resolve qua resolveLang).
 * @param key  - khoa message (namespace, vd `onboarding.region.prompt`).
 * @param vars - bien noi suy `{var}` (tuy chon).
 */
export function t(lang: Lang, key: MessageKey, vars?: TemplateVars): string {
  const template =
    catalogs[lang]?.[key] ??
    catalogs[BASE_FALLBACK_LANG]?.[key] ??
    key
  return interpolate(template, vars)
}

/** Danh sach ma ngon ngu duoc bat (re-export tien dung cho cac handler bot). */
export { SUPPORTED_LANGUAGES, BASE_FALLBACK_LANG, type Lang }
