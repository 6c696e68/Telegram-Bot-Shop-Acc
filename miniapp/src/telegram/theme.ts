/**
 * theme.ts — Ánh xạ Telegram WebApp `themeParams` + safe-area sang CSS variables.
 *
 * Hợp đồng biến CSS (theo design.md → khớp với src/style.css của task 11.2):
 *  - `applyTheme` ghi các biến THÔ của Telegram lên :root dưới dạng `--tg-theme-<key-kebab>`
 *    (ví dụ themeParams.bg_color → `--tg-theme-bg-color`). style.css dẫn xuất token ứng dụng
 *    qua `var(--tg-theme-bg-color, <fallback>)` (→ `--tg-bg`, `--tg-text`, `--tg-accent`...).
 *  - Chế độ sáng/tối: bật/tắt class `dark` trên <html> theo `colorScheme` (Req 13.6).
 *  - `applySafeArea` ghi `--safe-top/right/bottom/left` (px) đè lên fallback `env(safe-area-inset-*)`
 *    để tôn trọng vùng an toàn do Telegram khai báo (Req 13.7).
 *
 * Mọi hàm an toàn khi chạy NGOÀI Telegram: tham số rỗng/undefined → không làm gì hại.
 */

/** Chế độ màu do Telegram cung cấp. */
export type ColorScheme = 'light' | 'dark'

/**
 * Bộ tham số theme của Telegram WebApp (khóa snake_case, giá trị màu hex `#rrggbb`).
 * Liệt kê các khóa thường dùng; index signature cho phép map mọi khóa khác Telegram thêm về sau.
 */
export interface ThemeParams {
  bg_color?: string
  text_color?: string
  hint_color?: string
  link_color?: string
  button_color?: string
  button_text_color?: string
  secondary_bg_color?: string
  header_bg_color?: string
  bottom_bar_bg_color?: string
  accent_text_color?: string
  section_bg_color?: string
  section_header_text_color?: string
  section_separator_color?: string
  subtitle_text_color?: string
  destructive_text_color?: string
  [key: string]: string | undefined
}

/** Khoảng đệm vùng an toàn (px) theo từng cạnh. */
export interface SafeAreaInsets {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * Áp dụng themeParams lên CSS variables và đồng bộ chế độ sáng/tối (Req 13.6).
 * @param themeParams Bộ màu Telegram cung cấp (có thể undefined khi ngoài Telegram).
 * @param colorScheme 'light' | 'dark' — quyết định class `dark` trên <html>.
 */
export function applyTheme(
  themeParams: ThemeParams | undefined | null,
  colorScheme: ColorScheme | undefined | null,
): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement

  if (themeParams) {
    for (const [key, value] of Object.entries(themeParams)) {
      // Chỉ ghi giá trị màu hợp lệ; bỏ qua undefined/chuỗi rỗng để giữ fallback trong style.css.
      if (typeof value !== 'string' || value.length === 0) continue
      const cssVar = `--tg-theme-${key.replace(/_/g, '-')}`
      root.style.setProperty(cssVar, value)
    }
  }

  // Obsidian Glass là design DARK-ONLY: luôn giữ class `dark` bất kể colorScheme Telegram,
  // để token màu cố định (tailwind) hiển thị đúng. Tham số colorScheme được giữ cho tương thích.
  void colorScheme
  root.classList.add('dark')
  root.setAttribute('data-theme', 'dark')
}

/**
 * Áp dụng vùng an toàn do Telegram khai báo lên CSS variables (Req 13.7).
 * Chỉ ghi khi có giá trị số hợp lệ; khi `insets` rỗng → giữ nguyên fallback `env(safe-area-inset-*)`.
 * @param insets Khoảng đệm theo cạnh (cho phép thiếu cạnh).
 */
export function applySafeArea(insets: Partial<SafeAreaInsets> | undefined | null): void {
  if (typeof document === 'undefined' || !insets) return
  const root = document.documentElement

  const setEdge = (cssVar: string, value: number | undefined): void => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      root.style.setProperty(cssVar, `${Math.max(0, value)}px`)
    }
  }

  setEdge('--safe-top', insets.top)
  setEdge('--safe-right', insets.right)
  setEdge('--safe-bottom', insets.bottom)
  setEdge('--safe-left', insets.left)
}
