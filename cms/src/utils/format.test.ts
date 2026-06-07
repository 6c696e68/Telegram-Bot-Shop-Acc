import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import i18n from '@/i18n'
import { formatMoney } from '@/utils/format'

// BCP-47 tag theo locale CMS hiện tại — phản chiếu logic riêng tư bcp47() trong format.ts
// để dựng chuỗi VND kỳ vọng trong test mà không phụ thuộc locale cố định.
function bcp47(): string {
  return i18n.global.locale.value === 'vi' ? 'vi-VN' : 'en-US'
}

describe('Property 6: CMS dual string with VND as primary', () => {
  // **Validates: Requirements 4.1, 4.2**
  // For any VND amount and any Valid_Rate (finite > 0), CMS formatMoney produces a
  // CMS_Dual_String of the form `…đ (~$d.dd)` where the VND value is primary (appears
  // first) and the USD value appears in parentheses.
  it('renders VND primary then USD in parentheses for any amount and any valid rate', () => {
    fc.assert(
      fc.property(
        // VND amount: số nguyên không âm (stored amount luôn là số nguyên VND).
        fc.nat({ max: 1_000_000_000_000 }),
        // Valid_Rate: số hữu hạn > 0. Giới hạn khoảng để thương số luôn hữu hạn.
        fc.double({ min: 1e-4, max: 1e9, noNaN: true, noDefaultInfinity: true }),
        (amountVnd, rate) => {
          const result = formatMoney(amountVnd, rate)

          const vnd = amountVnd.toLocaleString(bcp47()) + 'đ'
          const usd = (amountVnd / rate).toFixed(2)

          // Chuỗi kép đúng dạng `…đ (~$d.dd)` với VND đứng trước, USD trong ngoặc.
          expect(result).toBe(`${vnd} (~$${usd})`)

          // VND là giá trị chính (đứng đầu chuỗi).
          expect(result.startsWith(vnd)).toBe(true)

          // VND (kết thúc bằng 'đ') xuất hiện trước phần USD ('$').
          expect(result.indexOf('đ')).toBeLessThan(result.indexOf('$'))

          // USD nằm trong cặp ngoặc đơn ở dạng (~$d.dd).
          expect(/\(~\$\d+\.\d{2}\)$/.test(result)).toBe(true)
        },
      ),
      { numRuns: 100 },
    )
  })
})

describe('Property 7: CMS VND-only fallback when rate invalid', () => {
  // **Validates: Requirements 4.4**
  // For any VND amount, if no Valid_Rate is available (rate is undefined, null, 0,
  // negative, NaN, or non-finite), CMS formatMoney produces a VND_String only:
  // it ends with 'đ' and contains no USD segment ('$').
  it('renders VND-only (no $ segment) for any amount when rate is invalid/absent', () => {
    // Generator cho rate KHÔNG hợp lệ: undefined, null, 0, âm, NaN, ±Infinity.
    const invalidRate = fc.oneof(
      fc.constant(undefined),
      fc.constant(null),
      fc.constant(0),
      fc.constant(Number.NaN),
      fc.constant(Number.POSITIVE_INFINITY),
      fc.constant(Number.NEGATIVE_INFINITY),
      // Số âm hữu hạn (loại trừ 0 để không trùng nhánh trên).
      fc.double({ min: -1e9, max: -1e-4, noNaN: true, noDefaultInfinity: true }),
    )

    fc.assert(
      fc.property(
        fc.nat({ max: 1_000_000_000_000 }),
        invalidRate,
        (amountVnd, rate) => {
          const result = formatMoney(amountVnd, rate as number | null | undefined)

          const vnd = amountVnd.toLocaleString(bcp47()) + 'đ'

          // Chỉ có chuỗi VND, không có phần USD.
          expect(result).toBe(vnd)

          // Kết thúc bằng 'đ'.
          expect(result.endsWith('đ')).toBe(true)

          // Không chứa ký hiệu '$' (không có đoạn USD nào).
          expect(result.includes('$')).toBe(false)
        },
      ),
      { numRuns: 100 },
    )
  })
})
