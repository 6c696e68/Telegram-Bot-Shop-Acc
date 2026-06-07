// Feature: telegram-mini-app, Property 11
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import {
  renderSuccessMessage,
  escapeHtml,
  type SuccessTemplateVars,
} from '../src/utils/telegram-template'
import type { Lang } from '../src/i18n/locales'

/**
 * Helper: dựng `Map<Lang,string|null>` 1 ngôn ngữ để gọi API mới
 * `renderSuccessMessage(templatesByLang, vars, lang)`. `null` template →
 * renderer dùng body mặc định theo lang.
 */
function templatesFor(template: string | null, lang: Lang = 'vi'): Map<Lang, string | null> {
  return new Map<Lang, string | null>([[lang, template]])
}

/**
 * Property 11: Escape HTML cho giá trị động trong tin nhắn mua hàng.
 *
 * **Validates: Requirements 7.4, 15.1**
 *
 * `renderSuccessMessage(template, vars)` dựng tin nhắn "Mua hàng thành công"
 * gồm HEADER cố định + BODY. Các giá trị động do người dùng/sản phẩm cung cấp
 * (`name` và từng phần tử `contents[]`) PHẢI được escape HTML (`&` `<` `>`)
 * trước khi ghép vào chuỗi HTML gửi qua Telegram Bot API. Các thẻ HTML cố định
 * của template (`<b>`, `<code>`) cố ý KHÔNG bị escape.
 *
 * Hàm là pure — không cần DB.
 *
 * Feature: telegram-mini-app, Property 11
 */

// --- Generators -------------------------------------------------------------

/**
 * Token pool đối nghịch: trộn ký tự đặc biệt HTML (`& < >`), các chuỗi giống thẻ
 * (`<script>`, `<b>`...) và các mảnh giống entity (`amp;`, `lt;`) cùng văn bản
 * thường/unicode. Mục tiêu: ép `renderSuccessMessage` xử lý đúng cả khi dữ liệu
 * động cố tình chứa cú pháp HTML.
 */
const tokenArb = fc.constantFrom(
  '&',
  '<',
  '>',
  '<b>',
  '</b>',
  '<code>',
  '</code>',
  '<script>',
  '</script>',
  '&amp;',
  'amp;',
  'lt;',
  'a',
  'B',
  'Z',
  '9',
  ' ',
  'é',
  '名',
  '"',
  "'",
  '/',
  'user:pass'
)

/** Chuỗi động (name / content) có thể chứa cú pháp HTML thô. */
const dynamicStringArb = fc
  .array(tokenArb, { minLength: 0, maxLength: 12 })
  .map((parts) => parts.join(''))

/**
 * Emoji được truyền THÔ (không escape) theo thiết kế, nên generator emoji chỉ
 * gồm ký tự an toàn (không chứa `& < >`) để không tạo false-positive.
 */
const emojiArb = fc.constantFrom('🎬', '🎵', '🔥', '✅', '🛒', '⭐️', '')

const varsArb = fc.record({
  emoji: emojiArb,
  name: dynamicStringArb,
  quantity: fc.integer({ min: 1, max: 50 }),
  totalAmount: fc.integer({ min: 0, max: 1_000_000_000 }),
  balanceAfter: fc.integer({ min: 0, max: 1_000_000_000 }),
  contents: fc.array(dynamicStringArb, { minLength: 0, maxLength: 5 }),
})

// --- Helpers ----------------------------------------------------------------

/**
 * Loại bỏ MỌI markup "hợp lệ" khỏi chuỗi đã render:
 *  - Các entity do `escapeHtml` sinh ra: `&amp;`, `&lt;`, `&gt;`.
 *  - Các thẻ HTML cố định của template: `<b>`, `</b>`, `<code>`, `</code>`.
 *
 * Sau khi loại bỏ, nếu vẫn còn `<`, `>` hoặc `&` thì đó chắc chắn là ký tự thô
 * CHƯA escape đến từ dữ liệu động — tức là một lỗ hổng. Đây là kiểm tra mạnh và
 * không phụ thuộc vị trí của giá trị động trong tin nhắn.
 */
function stripKnownMarkup(html: string): string {
  return html
    .replace(/&amp;/g, '')
    .replace(/&lt;/g, '')
    .replace(/&gt;/g, '')
    .replace(/<\/?b>/g, '')
    .replace(/<\/?code>/g, '')
}

/** Custom template chỉ dùng placeholder + văn bản thuần (không thẻ HTML thô). */
const CUSTOM_TEMPLATE = '[emoji] [name] x[quantity]\nDanh sách:\n[content]\nTong: [total] | Du: [balance]'

/** Khẳng định bất biến escape cho một chuỗi đã render bất kỳ. */
function assertNoRawDynamicMarkup(rendered: string, vars: SuccessTemplateVars): void {
  // (1) name luôn xuất hiện ở dạng đã escape (header luôn render escapeHtml(name)).
  expect(rendered.includes(escapeHtml(vars.name))).toBe(true)

  // (2) Mỗi content xuất hiện ở dạng đã escape và được bọc <code>...</code>.
  for (const content of vars.contents) {
    expect(rendered.includes(`<code>${escapeHtml(content)}</code>`)).toBe(true)
  }

  // (3) Sau khi gỡ entity + thẻ cố định, không còn ký tự HTML thô nào sót lại.
  const residual = stripKnownMarkup(rendered)
  expect(residual.includes('<')).toBe(false)
  expect(residual.includes('>')).toBe(false)
  expect(residual.includes('&')).toBe(false)
}

// --- Property tests ---------------------------------------------------------

describe('Property 11: Escape HTML giá trị động trong tin nhắn mua hàng', () => {
  it('default body (template null): không lộ ký tự HTML thô từ name/contents', () => {
    fc.assert(
      fc.property(varsArb, (vars) => {
        const rendered = renderSuccessMessage(templatesFor(null), vars, { lang: 'vi', region: null, rate: null })
        assertNoRawDynamicMarkup(rendered, vars)
      }),
      { numRuns: 200 }
    )
  })

  it('custom template ([name]/[content]): không lộ ký tự HTML thô từ name/contents', () => {
    fc.assert(
      fc.property(varsArb, (vars) => {
        const rendered = renderSuccessMessage(templatesFor(CUSTOM_TEMPLATE), vars, { lang: 'vi', region: null, rate: null })
        assertNoRawDynamicMarkup(rendered, vars)
      }),
      { numRuns: 200 }
    )
  })
})

// --- Example tests (ví dụ tường minh) ---------------------------------------

describe('Property 11 — ví dụ escape cụ thể', () => {
  const baseVars: SuccessTemplateVars = {
    emoji: '🎬',
    name: 'A & B <script>',
    quantity: 2,
    totalAmount: 100000,
    balanceAfter: 50000,
    contents: ['u<1>&p>', 'normal:pass'],
  }

  it('default body: name & content được escape, không còn <script> thô', () => {
    const out = renderSuccessMessage(templatesFor(null), baseVars, { lang: 'vi', region: null, rate: null })

    // name escape: 'A & B <script>' → 'A &amp; B &lt;script&gt;'
    expect(out).toContain('A &amp; B &lt;script&gt;')
    // content escape + bọc <code>
    expect(out).toContain('<code>u&lt;1&gt;&amp;p&gt;</code>')
    expect(out).toContain('<code>normal:pass</code>')

    // Không còn dạng thô nguy hiểm
    expect(out).not.toContain('<script>')
    expect(out).not.toContain('A & B') // '&' thô đã thành '&amp;'
    expect(out).not.toContain('u<1>')
  })

  it('custom template: name & content được escape, không còn <script> thô', () => {
    const out = renderSuccessMessage(templatesFor(CUSTOM_TEMPLATE), baseVars, { lang: 'vi', region: null, rate: null })

    expect(out).toContain('A &amp; B &lt;script&gt;')
    expect(out).toContain('<code>u&lt;1&gt;&amp;p&gt;</code>')
    expect(out).not.toContain('<script>')
    expect(out).not.toContain('u<1>')
  })

  it('header luôn escape name kể cả khi template không tham chiếu [name]', () => {
    const out = renderSuccessMessage(templatesFor('[content]'), {
      ...baseVars,
      name: '<b>boom</b> & <i>x</i>',
    }, { lang: 'vi', region: null, rate: null })

    expect(out).toContain('&lt;b&gt;boom&lt;/b&gt; &amp; &lt;i&gt;x&lt;/i&gt;')
    // Phần name thô không xuất hiện như thẻ thật
    expect(out).not.toContain('<i>x</i>')
  })
})
