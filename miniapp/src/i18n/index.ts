/**
 * Thiết lập vue-i18n cho Mini App (Composition API, legacy:false).
 *
 * Nguyên tắc (R17):
 *  - Nạp message động qua `import.meta.glob` từ `messages/<lang>.json` — thêm một file
 *    locale là tự nhận, KHÔNG sửa lõi (OCP, đồng bộ với registry `SUPPORTED_LANGUAGES`).
 *  - `fallbackLocale = 'en'` (BASE_FALLBACK_LANG) — thiếu key ở locale hiện tại lùi về en.
 *  - `missing` handler trả lại chính text/key để VẪN render khi thiếu bản dịch (R17.5),
 *    không cảnh báo ồn (missingWarn/fallbackWarn tắt).
 *  - Đổi `locale` reactive, không reload trang (R17.4).
 *  - Number format theo locale (VND) cho R4.6.
 */

import { createI18n } from 'vue-i18n'

/** Cây message lồng nhau (lá là chuỗi) — khớp schema JSON locale. */
type MessageTree = { [key: string]: string | MessageTree }

/** Locale mặc định khi chưa xác định ngôn ngữ user (BASE_FALLBACK_LANG). */
export const FALLBACK_LOCALE = 'en'

// Nạp tất cả message JSON tại build-time. Thêm messages/<lang>.json là tự có locale mới.
const modules = import.meta.glob<{ default: MessageTree }>('./messages/*.json', {
  eager: true,
})

const messages: Record<string, MessageTree> = {}
for (const path in modules) {
  // './messages/vi.json' -> 'vi'
  const match = path.match(/\/([a-z-]+)\.json$/i)
  if (match) {
    messages[match[1]] = modules[path].default
  }
}

/** Danh sách locale có message (suy ra từ file đã nạp). */
export const AVAILABLE_LOCALES = Object.keys(messages)

/** Number format theo locale: VND, nhóm chữ số theo locale (R4.6). */
const numberFormats = {
  vi: {
    currency: { style: 'currency' as const, currency: 'VND', currencyDisplay: 'symbol' as const },
    decimal: { style: 'decimal' as const },
  },
  en: {
    currency: { style: 'currency' as const, currency: 'VND', currencyDisplay: 'symbol' as const },
    decimal: { style: 'decimal' as const },
  },
}

/** Datetime format theo locale (R4.6) — giữ UTC để khớp timestamp ISO của server. */
const datetimeFormats = {
  vi: {
    short: {
      year: 'numeric' as const,
      month: '2-digit' as const,
      day: '2-digit' as const,
      hour: '2-digit' as const,
      minute: '2-digit' as const,
      timeZone: 'UTC',
    },
  },
  en: {
    short: {
      year: 'numeric' as const,
      month: '2-digit' as const,
      day: '2-digit' as const,
      hour: '2-digit' as const,
      minute: '2-digit' as const,
      timeZone: 'UTC',
    },
  },
}

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: FALLBACK_LOCALE,
  fallbackLocale: FALLBACK_LOCALE,
  missingWarn: false,
  fallbackWarn: false,
  // Thiếu bản dịch → trả lại key (text) để không vỡ giao diện (R17.5).
  missing: (_locale, key) => key,
  messages,
  numberFormats,
  datetimeFormats,
})

/**
 * Đổi ngôn ngữ hiển thị reactive (R17.4). Chỉ đổi khi locale có trong danh sách đã nạp;
 * locale lạ → giữ nguyên (fail-safe, tránh hiển thị toàn key).
 */
export function setLocale(lang: string | null | undefined): void {
  if (lang && AVAILABLE_LOCALES.includes(lang)) {
    i18n.global.locale.value = lang
  }
}

export default i18n
