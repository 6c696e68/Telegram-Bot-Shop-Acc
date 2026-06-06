/**
 * Thiết lập vue-i18n cho CMS (Composition API, legacy:false).
 *
 * R18: mặc định `en` (R18.3); bộ chọn ngôn ngữ render từ các locale đã nạp; đổi locale
 * reactive không reload (R18.4). Nạp message động qua `import.meta.glob` — thêm
 * `messages/<lang>.json` là tự có locale mới (đồng bộ registry SUPPORTED_LANGUAGES).
 * `missing` trả lại key để không vỡ giao diện khi thiếu bản dịch.
 */

import { createI18n } from 'vue-i18n'

/** Cây message lồng nhau (lá là chuỗi). */
type MessageTree = { [key: string]: string | MessageTree }

/** CMS mặc định tiếng Anh (R18.3). */
export const DEFAULT_LOCALE = 'en'

const STORAGE_KEY = 'cms_locale'

const modules = import.meta.glob<{ default: MessageTree }>('./messages/*.json', { eager: true })

const messages: Record<string, MessageTree> = {}
for (const path in modules) {
  const match = path.match(/\/([a-z-]+)\.json$/i)
  if (match) messages[match[1]] = modules[path].default
}

/** Danh sách locale có message (cho bộ chọn ngôn ngữ — R18.2). */
export const AVAILABLE_LOCALES = Object.keys(messages)

/** Locale khởi tạo: ưu tiên lựa chọn đã lưu của admin, ngược lại mặc định en. */
function initialLocale(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved && AVAILABLE_LOCALES.includes(saved)) return saved
  } catch {
    // localStorage không khả dụng → dùng mặc định.
  }
  return DEFAULT_LOCALE
}

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: initialLocale(),
  fallbackLocale: DEFAULT_LOCALE,
  missingWarn: false,
  fallbackWarn: false,
  missing: (_locale, key) => key,
  messages,
  datetimeFormats: {
    vi: { short: { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' } },
    en: { short: { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' } },
  },
})

/** Đổi ngôn ngữ CMS reactive + lưu lựa chọn (R18.4). */
export function setLocale(lang: string): void {
  if (!AVAILABLE_LOCALES.includes(lang)) return
  i18n.global.locale.value = lang
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    // bỏ qua nếu không lưu được
  }
}

export default i18n
