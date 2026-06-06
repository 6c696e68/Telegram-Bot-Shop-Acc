import { describe, it, expect } from 'vitest'
import { formatCurrency, formatMoney, formatNumber, formatDate } from '../src/utils/format'
import { generateTransferCode } from '../src/utils/transfer-code'
import { generateVietQRUrl } from '../src/utils/vietqr'
import { AppError, handleBotError, handleApiError } from '../src/utils/error-handler'
import { d1WithRetry } from '../src/utils/retry'

describe('formatCurrency', () => {
  it('formats number with vi grouping (dot) and đ suffix', () => {
    // R4.6: thống nhất hiển thị VND theo locale vi (nhóm bằng dấu chấm)
    expect(formatCurrency(150000)).toBe('150.000đ')
    expect(formatCurrency(1000000)).toBe('1.000.000đ')
    expect(formatCurrency(0)).toBe('0đ')
    expect(formatCurrency(500)).toBe('500đ')
    expect(formatCurrency(30000)).toBe('30.000đ')
  })
})

describe('formatNumber', () => {
  it('groups with dot for vi locale', () => {
    expect(formatNumber(150000, 'vi')).toBe('150.000')
    expect(formatNumber(1000000, 'vi')).toBe('1.000.000')
    expect(formatNumber(0, 'vi')).toBe('0')
  })

  it('groups with comma for en locale', () => {
    expect(formatNumber(150000, 'en')).toBe('150,000')
    expect(formatNumber(1000000, 'en')).toBe('1,000,000')
    expect(formatNumber(0, 'en')).toBe('0')
  })
})

describe('formatMoney', () => {
  it('keeps VND suffix while switching grouping per locale', () => {
    expect(formatMoney(150000, 'vi')).toBe('150.000đ')
    expect(formatMoney(150000, 'en')).toBe('150,000đ')
    expect(formatMoney(0, 'vi')).toBe('0đ')
    expect(formatMoney(0, 'en')).toBe('0đ')
  })
})

describe('formatDate', () => {
  it('converts ISO 8601 UTC to DD/MM/YYYY HH:mm', () => {
    expect(formatDate('2024-07-02T11:08:33.000Z')).toBe('02/07/2024 11:08')
    expect(formatDate('2024-01-15T00:00:00.000Z')).toBe('15/01/2024 00:00')
    expect(formatDate('2024-12-31T23:59:59.000Z')).toBe('31/12/2024 23:59')
  })
})

describe('generateTransferCode', () => {
  it('starts with NAP prefix', () => {
    const code = generateTransferCode(12345)
    expect(code.startsWith('NAP')).toBe(true)
  })

  it('has length between 6 and 20 chars', () => {
    const code = generateTransferCode(999999)
    expect(code.length).toBeGreaterThanOrEqual(6)
    expect(code.length).toBeLessThanOrEqual(20)
  })

  it('matches NAP[A-Z0-9]{4,17} regex', () => {
    const code = generateTransferCode(42)
    expect(code).toMatch(/^NAP[A-Z0-9]{4,17}$/)
  })

  it('generates different codes for same userId', () => {
    const code1 = generateTransferCode(100)
    const code2 = generateTransferCode(100)
    expect(code1).not.toBe(code2)
  })
})

describe('generateVietQRUrl', () => {
  it('builds correct URL with all params', () => {
    const url = generateVietQRUrl({
      bankId: 'VCB',
      accountNo: '1017588888',
      accountName: 'NGUYEN VAN A',
      amount: 100000,
      description: 'NAP0042A3B7CF',
    })

    expect(url).toContain('https://img.vietqr.io/image/VCB-1017588888-compact.png')
    expect(url).toContain('amount=100000')
    expect(url).toContain('addInfo=NAP0042A3B7CF')
    expect(url).toContain('accountName=NGUYEN+VAN+A')
  })
})

describe('AppError', () => {
  it('creates error with message and statusCode', () => {
    const err = new AppError('Not found', 404)
    expect(err.message).toBe('Not found')
    expect(err.statusCode).toBe(404)
    expect(err.name).toBe('AppError')
  })

  it('defaults statusCode to 500', () => {
    const err = new AppError('Server error')
    expect(err.statusCode).toBe(500)
  })

  it('stores optional details', () => {
    const err = new AppError('Validation', 400, { field: 'name' })
    expect(err.details).toEqual({ field: 'name' })
  })
})

describe('handleBotError', () => {
  it('returns user-friendly message', () => {
    const result = handleBotError(new Error('DB timeout'))
    expect(result.message).toContain('lỗi hệ thống')
    expect(result.shouldNotifyUser).toBe(true)
  })
})

describe('handleApiError', () => {
  it('returns ApiResponse format with AppError message', () => {
    const result = handleApiError(new AppError('Không tìm thấy', 404))
    expect(result.success).toBe(false)
    expect(result.data).toBeNull()
    expect(result.error).toBe('Không tìm thấy')
  })

  it('returns generic message for non-AppError', () => {
    const result = handleApiError(new Error('unexpected'))
    expect(result.success).toBe(false)
    expect(result.error).toContain('lỗi hệ thống')
  })
})

describe('d1WithRetry', () => {
  it('returns result on first success', async () => {
    const result = await d1WithRetry(() => Promise.resolve('ok'))
    expect(result).toBe('ok')
  })

  it('retries on failure and succeeds', async () => {
    let attempt = 0
    const result = await d1WithRetry(
      () => {
        attempt++
        if (attempt < 2) throw new Error('fail')
        return Promise.resolve('recovered')
      },
      { delayMs: 10 }
    )
    expect(result).toBe('recovered')
    expect(attempt).toBe(2)
  })

  it('throws after all retries exhausted', async () => {
    let attempt = 0
    await expect(
      d1WithRetry(
        () => {
          attempt++
          throw new Error('always fail')
        },
        { maxRetries: 2, delayMs: 10 }
      )
    ).rejects.toThrow('always fail')
    expect(attempt).toBe(3) // 1 initial + 2 retries
  })
})
