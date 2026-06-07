/**
 * avatar.ts — màu nền/gradient xác định (deterministic) cho icon fallback khi không có ảnh.
 *
 * Obsidian Glass: dùng bảng màu pastel hài hoà với token thiết kế (xanh primary, lavender,
 * peach tertiary, teal...) thay cho bảng iOS rực trước đây — tránh màu chỏi với nền obsidian.
 * Mỗi sản phẩm/đơn suy ra một màu cố định từ seed (id/tên) → cùng mục luôn cùng màu.
 */

/** Bảng màu pastel hài hoà với palette Obsidian Glass (đủ tương phản trên nền tối). */
const PALETTE: readonly string[] = [
  '#adc6ff', // primary blue
  '#c2c1ff', // secondary lavender
  '#ffb595', // tertiary peach
  '#8ab4ff', // sky blue
  '#b9a8ff', // violet
  '#7fd1c4', // teal
  '#ffc78a', // amber
  '#9fd0ff', // light blue
  '#d2b3ff', // soft purple
  '#8fe0c0', // mint
] as const

/** Hash chuỗi đơn giản (FNV-ish) → số nguyên không âm. */
function hashSeed(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Trả về màu (hex) xác định theo seed. */
export function avatarColor(seed: string | number): string {
  const s = String(seed)
  return PALETTE[hashSeed(s) % PALETTE.length]
}

/** Nền mờ (rgba alpha thấp) cho ô icon tròn/vuông — đọc tốt trên nền tối. */
export function tileTint(seed: string | number): string {
  return hexToRgba(avatarColor(seed), 0.22)
}

/** Gradient nền cho ô fallback (chéo 135deg, alpha vừa phải để không chỏi). */
export function tileGradient(seed: string | number): string {
  const c = avatarColor(seed)
  return `linear-gradient(135deg, ${hexToRgba(c, 0.28)}, ${hexToRgba(c, 0.12)})`
}

/** Chuyển hex (#rrggbb) sang rgba với alpha cho trước. */
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
