import { describe, it, expect } from 'vitest'
import { splitTelegramMessage, TELEGRAM_MESSAGE_LIMIT } from '../src/bot/telegram-api'

/**
 * Unit test cho splitTelegramMessage — đảm bảo giao hàng số lượng lớn không vỡ
 * vì giới hạn 4096 ký tự của Telegram (bug: mua 50 account không giao/không xem được).
 */
describe('splitTelegramMessage', () => {
  it('giữ nguyên 1 chunk khi text ngắn hơn giới hạn', () => {
    const text = 'dòng 1\ndòng 2\ndòng 3'
    const chunks = splitTelegramMessage(text)
    expect(chunks).toEqual([text])
  })

  it('chia danh sách nhiều dòng thành nhiều chunk, mỗi chunk <= giới hạn', () => {
    // 200 dòng, mỗi dòng ~60 ký tự → vượt xa 3900.
    const line = '1234567890123456789012345678901234567890123456789012345678' // 58 ký tự
    const lines = Array.from({ length: 200 }, (_, i) => `${i}. ${line}`)
    const text = lines.join('\n')

    const chunks = splitTelegramMessage(text)

    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT)
    }
    // Cắt theo ranh giới dòng → nối lại bằng '\n' khôi phục nguyên văn.
    expect(chunks.join('\n')).toBe(text)
  })

  it('không cắt giữa một dòng nội dung (ranh giới dòng được giữ)', () => {
    const line = 'x'.repeat(100)
    const lines = Array.from({ length: 100 }, () => line)
    const chunks = splitTelegramMessage(lines.join('\n'))
    for (const chunk of chunks) {
      // Mỗi dòng trong chunk phải đủ 100 ký tự (không bị cắt dở).
      for (const l of chunk.split('\n')) {
        expect(l.length).toBe(100)
      }
    }
  })

  it('cắt cứng dòng đơn lẻ dài hơn giới hạn', () => {
    const giant = 'a'.repeat(TELEGRAM_MESSAGE_LIMIT * 2 + 123)
    const chunks = splitTelegramMessage(giant)
    expect(chunks.length).toBe(3)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT)
    }
    expect(chunks.join('')).toBe(giant)
  })
})
