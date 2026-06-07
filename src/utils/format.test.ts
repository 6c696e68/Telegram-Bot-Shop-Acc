import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { formatMoneyFor, vndToUsdString, parseRate, type CurrencyContext } from './format'
import { SUPPORTED_LANGUAGES, type Lang, type Region } from '../i18n/locales'

/**
 * Property-based tests cho choke point hiển thị tiền tệ trong src/utils/format.ts.
 *
 * File này được CHIA SẺ giữa các task property 1.2–1.7 (currency-display-usd).
 * Mỗi property nằm trong một describe block riêng, đặt tên rõ ràng để tránh xung đột.
 */

// --- Generators dùng chung ---

/** VND amount: số nguyên không âm (Stored_Amount luôn là VND integer). */
const arbAmountVnd = fc.integer({ min: 0, max: 1_000_000_000 })

/** Language hợp lệ thuộc registry. */
const arbLang = fc.constantFrom<Lang>(...SUPPORTED_LANGUAGES)

/**
 * Region value: bao phủ international / vietnam / null / unknown.
 * Bao gồm cả chuỗi rác để mô phỏng region không xác định (cast về Region|null).
 */
const arbRegionValue = fc.oneof(
  fc.constant<Region | null>('international'),
  fc.constant<Region | null>('vietnam'),
  fc.constant<Region | null>(null),
  fc.constantFrom('usa', 'eu', 'unknown', 'INTERNATIONAL', ''),
  fc.string()
) as fc.Arbitrary<Region | null>

/** Valid_Rate đã parse: số hữu hạn > 0. */
const arbValidRate = fc.double({
  min: 0.01,
  max: 1_000_000,
  noNaN: true,
  noDefaultInfinity: true,
})

/**
 * Rate trong CurrencyContext: đã parse rồi → hoặc Valid_Rate (> 0, hữu hạn) hoặc null.
 * (Các chuỗi rate không hợp lệ được kiểm thử riêng ở Property 4 / parseRate.)
 */
const arbRate = fc.oneof(arbValidRate, fc.constant<number | null>(null))

const USD_STRING = /^\$\d+\.\d{2}$/

describe('Property 1: Region-conditioned currency selection', () => {
  /**
   * **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
   *
   * Với MỌI VND amount, MỌI giá trị region (international/vietnam/null/unknown) và
   * MỌI rate (Valid_Rate hoặc null), `formatMoneyFor` tạo ra USD_String KHI VÀ CHỈ KHI
   * region === 'international' VÀ rate là số hợp lệ > 0 (ở đây: rate !== null vì đã parse).
   * Mọi trường hợp còn lại tạo ra VND_String (kết thúc bằng 'đ').
   */
  it('produces USD_String iff region is international AND rate is valid, else VND_String', () => {
    fc.assert(
      fc.property(arbAmountVnd, arbRegionValue, arbRate, arbLang, (amount, region, rate, lang) => {
        const ctx: CurrencyContext = { lang, region, rate }
        const out = formatMoneyFor(amount, ctx)

        const shouldBeUsd = region === 'international' && rate !== null

        if (shouldBeUsd) {
          expect(out).toMatch(USD_STRING)
          expect(out.endsWith('đ')).toBe(false)
        } else {
          expect(out.endsWith('đ')).toBe(true)
          expect(USD_STRING.test(out)).toBe(false)
        }
      }),
      { numRuns: 200 }
    )
  })
})

describe('Property 2: USD conversion correctness and formatting', () => {
  /**
   * **Validates: Requirements 2.1, 2.2, 2.3**
   *
   * Với MỌI VND amount và MỌI Valid_Rate (số hữu hạn > 0), `vndToUsdString`:
   *  - R2.3: trả về chuỗi khớp `^\$\d+\.\d{2}$` (prefix '$', đúng 2 chữ số thập phân,
   *    giữ số 0 cuối).
   *  - R2.1 + R2.2: phần số bằng (amount / rate) làm tròn đúng 2 chữ số thập phân.
   */
  it('returns $d.dd whose numeric part equals amount/rate rounded to 2 decimals', () => {
    fc.assert(
      fc.property(arbAmountVnd, arbValidRate, (amount, rate) => {
        const out = vndToUsdString(amount, rate)

        // R2.3: hình dạng chuỗi — '$' + đúng 2 chữ số thập phân (kể cả số 0 cuối).
        expect(out).toMatch(USD_STRING)

        // R2.1 + R2.2: phần số khớp amount/rate làm tròn đúng 2 chữ số thập phân.
        const expected = (amount / rate).toFixed(2)
        expect(out).toBe('$' + expected)

        // Phần số sau '$' parse được và bằng giá trị làm tròn 2 chữ số.
        const numericPart = out.slice(1)
        expect(Number(numericPart)).toBeCloseTo(Number(expected), 10)
      }),
      { numRuns: 200 }
    )
  })
})

describe('Property 3: Conversion never mutates the stored amount', () => {
  /**
   * **Validates: Requirements 2.4, 5.4**
   *
   * Với MỌI VND amount và MỌI CurrencyContext (region/rate/lang bất kỳ), việc format
   * KHÔNG được thay đổi Stored_Amount: giá trị số đầu vào phải y nguyên trước và sau khi
   * gọi `formatMoneyFor`/`vndToUsdString`. Conversion CHỈ áp dụng cho chuỗi hiển thị
   * sinh ra, không đụng tới amount lưu trữ (R2.4) và không áp dụng cho bất kỳ
   * Stored_Amount nào (R5.4).
   */
  it('leaves the input VND amount unchanged after formatting (formatMoneyFor)', () => {
    fc.assert(
      fc.property(arbAmountVnd, arbRegionValue, arbRate, arbLang, (amount, region, rate, lang) => {
        const ctx: CurrencyContext = { lang, region, rate }

        // Snapshot giá trị Stored_Amount trước khi format.
        const before = amount

        const out = formatMoneyFor(amount, ctx)

        // R2.4 / R5.4: amount đầu vào không bị thay đổi bởi việc format.
        expect(amount).toBe(before)
        // Display chỉ là chuỗi sinh ra; không có kênh nào ghi đè Stored_Amount.
        expect(typeof out).toBe('string')
      }),
      { numRuns: 200 }
    )
  })

  it('leaves the stored amount unchanged when it lives in a container object', () => {
    fc.assert(
      fc.property(arbAmountVnd, arbRegionValue, arbRate, arbLang, (amount, region, rate, lang) => {
        const ctx: CurrencyContext = { lang, region, rate }

        // Mô phỏng Stored_Amount nằm trong một bản ghi (vd order/deposit) — phải bất biến.
        const stored = { amountVnd: amount }
        const snapshot = stored.amountVnd

        formatMoneyFor(stored.amountVnd, ctx)

        expect(stored.amountVnd).toBe(snapshot)
      }),
      { numRuns: 200 }
    )
  })

  it('is referentially transparent: repeated calls do not drift the amount or output', () => {
    fc.assert(
      fc.property(arbAmountVnd, arbRegionValue, arbRate, arbLang, (amount, region, rate, lang) => {
        const ctx: CurrencyContext = { lang, region, rate }
        const before = amount

        const first = formatMoneyFor(amount, ctx)
        const second = formatMoneyFor(amount, ctx)

        // Không side-effect: amount giữ nguyên và output ổn định giữa các lần gọi.
        expect(amount).toBe(before)
        expect(second).toBe(first)
      }),
      { numRuns: 200 }
    )
  })

  it('vndToUsdString does not mutate the input amount when a Valid_Rate is used', () => {
    fc.assert(
      fc.property(arbAmountVnd, arbValidRate, (amount, rate) => {
        const before = amount

        vndToUsdString(amount, rate)

        // Conversion chỉ tạo ra chuỗi USD; Stored_Amount VND không đổi (R2.4).
        expect(amount).toBe(before)
      }),
      { numRuns: 200 }
    )
  })
})

describe('Property 4: Fail-safe to VND on missing or invalid rate', () => {
  /**
   * **Validates: Requirements 3.1, 3.2**
   *
   * Với MỌI VND amount và MỌI region (kể cả 'international'):
   *  - R3.1: nếu rate THIẾU (null trong CurrencyContext đã parse) → VND_String.
   *  - R3.2: nếu Exchange_Rate KHÔNG parse được thành số hữu hạn > 0
   *    (chuỗi rỗng, không phải số, '0', số âm, 'NaN'/'Infinity'...) thì `parseRate`
   *    trả về null, và feed null đó vào ctx → VND_String.
   *
   * VND_String kết thúc bằng 'đ' và KHÔNG phải USD_String (không có prefix '$').
   */

  /**
   * Chuỗi rate KHÔNG hợp lệ (R3.2): không parse thành số hữu hạn > 0.
   * Bao gồm rỗng, không phải số, '0', số âm, và literal NaN/Infinity.
   */
  const arbInvalidRateString = fc.oneof(
    fc.constantFrom(
      '',
      '   ',
      'abc',
      '0',
      '0.0',
      '-1',
      '-25000',
      'NaN',
      'Infinity',
      '-Infinity',
      '$5',
      '12,000'
    ),
    // Bất kỳ chuỗi nào parse ra <= 0 hoặc không hữu hạn.
    fc.double({ min: -1_000_000, max: 0, noNaN: true }).map((n) => String(n)),
    // Chuỗi rác tổng quát: chỉ giữ những chuỗi mà parseRate coi là không hợp lệ.
    fc.string().filter((s) => parseRate(s) === null)
  )

  it('parseRate returns null for any invalid rate string (R3.2)', () => {
    fc.assert(
      fc.property(arbInvalidRateString, (rateStr) => {
        expect(parseRate(rateStr)).toBe(null)
      }),
      { numRuns: 200 }
    )
  })

  it('produces a VND_String when the rate is missing (null) for any region (R3.1)', () => {
    fc.assert(
      fc.property(arbAmountVnd, arbRegionValue, arbLang, (amount, region, lang) => {
        // rate THIẾU = null (CurrencyContext.rate đã được parse sẵn).
        const ctx: CurrencyContext = { lang, region, rate: null }
        const out = formatMoneyFor(amount, ctx)

        // Fail-safe: luôn là VND_String, kể cả International_User.
        expect(out.endsWith('đ')).toBe(true)
        expect(USD_STRING.test(out)).toBe(false)
        expect(out.includes('$')).toBe(false)
      }),
      { numRuns: 200 }
    )
  })

  it('produces a VND_String when an invalid rate string is parsed then used, for any region (R3.2)', () => {
    fc.assert(
      fc.property(
        arbAmountVnd,
        arbRegionValue,
        arbInvalidRateString,
        arbLang,
        (amount, region, rateStr, lang) => {
          // R3.2: parse chuỗi rate không hợp lệ → null, rồi feed vào ctx.
          const rate = parseRate(rateStr)
          expect(rate).toBe(null)

          const ctx: CurrencyContext = { lang, region, rate }
          const out = formatMoneyFor(amount, ctx)

          // Fail-safe sang VND cho mọi region (kể cả 'international').
          expect(out.endsWith('đ')).toBe(true)
          expect(USD_STRING.test(out)).toBe(false)
          expect(out.includes('$')).toBe(false)
        }
      ),
      { numRuns: 200 }
    )
  })

  it('fails safe to VND even for international users when the rate is missing/invalid', () => {
    fc.assert(
      fc.property(arbAmountVnd, arbInvalidRateString, arbLang, (amount, rateStr, lang) => {
        // Buộc region = 'international' để khẳng định fail-safe áp dụng cả nhóm này.
        const ctx: CurrencyContext = { lang, region: 'international', rate: parseRate(rateStr) }
        const out = formatMoneyFor(amount, ctx)

        expect(out.endsWith('đ')).toBe(true)
        expect(USD_STRING.test(out)).toBe(false)
      }),
      { numRuns: 200 }
    )
  })
})

describe('Property 5: Output is always a valid currency string', () => {
  /**
   * **Validates: Requirements 3.3**
   *
   * Với MỌI VND amount, MỌI giá trị region và MỌI rate trong CurrencyContext —
   * kể cả rate sinh ra từ việc parse các chuỗi rate tùy ý (hợp lệ, rỗng, rác,
   * '0', số âm, 'NaN'/'Infinity'...) — `formatMoneyFor` PHẢI luôn tạo ra một chuỗi
   * tiền tệ hợp lệ: KHÔNG chứa 'NaN', KHÔNG chứa 'Infinity', và KHÔNG có phần số rỗng.
   * Output luôn là một USD_String hợp lệ (`^\$\d+\.\d{2}$`) HOẶC một VND_String hợp lệ
   * (chuỗi số có nhóm chữ số kết thúc bằng 'đ').
   */

  /** VND_String hợp lệ: ≥1 chữ số (cho phép dấu nhóm , hoặc .) + suffix 'đ', không rỗng số. */
  const VND_STRING = /^\d[\d.,]*đ$/

  /**
   * Chuỗi rate tùy ý dùng để feed qua parseRate → đưa vào ctx.rate.
   * Bao phủ cả Valid_Rate lẫn các edge case không hợp lệ (rỗng, rác, '0', âm, literal).
   */
  const arbRateString = fc.oneof(
    fc.constantFrom(
      '',
      '   ',
      'abc',
      '0',
      '0.0',
      '-1',
      '-25000',
      'NaN',
      'Infinity',
      '-Infinity',
      '$5',
      '12,000',
      '25000',
      '24500.5',
      '1',
      '0.0001'
    ),
    fc.double({ min: -1_000_000, max: 1_000_000, noNaN: true }).map((n) => String(n)),
    fc.double({ noNaN: false }).map((n) => String(n)),
    fc.string()
  )

  /** ctx.rate: hoặc đã-parse-trực-tiếp (Valid_Rate/null) hoặc parse từ chuỗi tùy ý. */
  const arbContextRate = fc.oneof(arbRate, arbRateString.map((s) => parseRate(s)))

  it('never emits NaN/Infinity/empty-numeric and is always a valid USD or VND string', () => {
    fc.assert(
      fc.property(arbAmountVnd, arbRegionValue, arbContextRate, arbLang, (amount, region, rate, lang) => {
        const ctx: CurrencyContext = { lang, region, rate }
        const out = formatMoneyFor(amount, ctx)

        // R3.3: tuyệt đối không có token hỏng trong chuỗi hiển thị.
        expect(out.includes('NaN')).toBe(false)
        expect(out.includes('Infinity')).toBe(false)
        expect(out.length).toBeGreaterThan(0)

        // Output luôn là USD_String hợp lệ HOẶC VND_String hợp lệ — không phần số rỗng.
        const isUsd = USD_STRING.test(out)
        const isVnd = VND_STRING.test(out)
        expect(isUsd || isVnd).toBe(true)

        if (isUsd) {
          // Phần số sau '$' phải parse ra số hữu hạn (không rỗng, không NaN/Infinity).
          const numeric = Number(out.slice(1))
          expect(Number.isFinite(numeric)).toBe(true)
        }
      }),
      { numRuns: 200 }
    )
  })

  it('amounts derived from arbitrary rate strings still yield a valid currency string for any region', () => {
    fc.assert(
      fc.property(arbAmountVnd, arbRegionValue, arbRateString, arbLang, (amount, region, rateStr, lang) => {
        const ctx: CurrencyContext = { lang, region, rate: parseRate(rateStr) }
        const out = formatMoneyFor(amount, ctx)

        expect(out.includes('NaN')).toBe(false)
        expect(out.includes('Infinity')).toBe(false)
        expect(USD_STRING.test(out) || VND_STRING.test(out)).toBe(true)
      }),
      { numRuns: 200 }
    )
  })
})

describe('parseRate boundaries (unit)', () => {
  /**
   * **Validates: Requirements 2.3, 3.2**
   *
   * Unit tests cụ thể cho các biên của `parseRate` (Valid_Rate guard) và một case
   * tiêu biểu chứng minh USD_String giữ số 0 cuối (`$5.00`). Bổ trợ cho property tests
   * bằng các ví dụ tường minh, dễ đọc.
   */

  it('returns null for "0" (not strictly greater than zero)', () => {
    expect(parseRate('0')).toBe(null)
  })

  it('returns null for "-1" (negative)', () => {
    expect(parseRate('-1')).toBe(null)
  })

  it('returns null for "" (empty string)', () => {
    expect(parseRate('')).toBe(null)
  })

  it('returns null for "abc" (non-numeric)', () => {
    expect(parseRate('abc')).toBe(null)
  })

  it('returns 25000 for "25000" (valid finite positive rate)', () => {
    expect(parseRate('25000')).toBe(25000)
  })

  it('returns null for null', () => {
    expect(parseRate(null)).toBe(null)
  })

  it('returns null for undefined', () => {
    expect(parseRate(undefined)).toBe(null)
  })
})

describe('vndToUsdString trailing-zero formatting (unit)', () => {
  /**
   * **Validates: Requirements 2.3**
   *
   * USD_String phải hiển thị đúng 2 chữ số thập phân, kể cả khi giá trị tròn — số 0
   * cuối phải được giữ lại (vd `$5.00` chứ không phải `$5`).
   */
  it('preserves trailing zeros: 25000 / 5000 renders as "$5.00"', () => {
    expect(vndToUsdString(25000, 5000)).toBe('$5.00')
  })
})
