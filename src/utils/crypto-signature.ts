/**
 * Tiện ích chữ ký dùng chung cho các webhook xác thực bằng HMAC (CryptoBot, PayOS).
 *
 * Tách `timingSafeEqualHex` và `toHex` ra một nơi để mọi provider dùng chung MỘT
 * implementation (tránh lệch hành vi giữa các bản sao chép). Cả hai trước đây là
 * hàm private trong `middleware/cryptopay-auth.ts`.
 */

/**
 * So sánh hai chuỗi hex theo kiểu hằng-thời-gian.
 *
 * Luôn duyệt hết độ dài của `a` (không early-return theo từng ký tự) để không rò rỉ
 * thông tin timing về vị trí ký tự sai. Khác độ dài → coi như không khớp nhưng vẫn
 * duyệt đủ vòng lặp.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const lengthMismatch = a.length !== b.length
  // Chọn chuỗi tham chiếu có độ dài cố định để số vòng lặp không phụ thuộc input.
  const reference = a
  let diff = lengthMismatch ? 1 : 0
  for (let i = 0; i < reference.length; i++) {
    const ca = reference.charCodeAt(i)
    // Nếu lệch độ dài, `b` có thể không có ký tự ở vị trí i → dùng 0 (vẫn lệch).
    const cb = i < b.length ? b.charCodeAt(i) : 0
    diff |= ca ^ cb
  }
  return diff === 0
}

/** Chuyển ArrayBuffer/Uint8Array sang chuỗi hex thường. */
export function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}
