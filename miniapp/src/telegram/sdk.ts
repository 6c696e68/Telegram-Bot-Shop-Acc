/**
 * sdk.ts — Lớp bọc (wrapper) quanh `window.Telegram.WebApp`.
 *
 * Mục tiêu:
 *  - Khởi tạo WebApp (`ready`/`expand`), đồng bộ theme + safe-area, lắng nghe thay đổi runtime.
 *  - Export `initData` (chuỗi thô) để API client gắn vào header `X-Telegram-Init-Data` (task 11.4).
 *  - Cung cấp tiện ích `haptic`, `showMainButton`, `showBackButton`.
 *
 * Nguyên tắc fail-safe: TOÀN BỘ hàm phải chạy được khi mở ngoài Telegram (trình duyệt thường, dev).
 * Khi `window.Telegram?.WebApp` không tồn tại → no-op, `initData` = '' (chuỗi rỗng).
 */

import {
  applySafeArea,
  applyTheme,
  type ColorScheme,
  type SafeAreaInsets,
  type ThemeParams,
} from './theme'

// ── Kiểu dữ liệu tối thiểu của Telegram WebApp (chỉ các phần được dùng) ──────────────

type TelegramEventType =
  | 'themeChanged'
  | 'viewportChanged'
  | 'safeAreaChanged'
  | 'contentSafeAreaChanged'

type TelegramEventHandler = (...args: unknown[]) => void

/** Kiểu va chạm cho `HapticFeedback.impactOccurred`. */
type ImpactStyle = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'
/** Kiểu thông báo cho `HapticFeedback.notificationOccurred`. */
type NotificationType = 'success' | 'warning' | 'error'

interface HapticFeedback {
  impactOccurred(style: ImpactStyle): void
  notificationOccurred(type: NotificationType): void
  selectionChanged(): void
}

interface MainButton {
  text: string
  isVisible: boolean
  isActive: boolean
  setText(text: string): MainButton
  show(): MainButton
  hide(): MainButton
  enable(): MainButton
  disable(): MainButton
  onClick(handler: () => void): MainButton
  offClick(handler: () => void): MainButton
}

interface BackButton {
  isVisible: boolean
  show(): BackButton
  hide(): BackButton
  onClick(handler: () => void): BackButton
  offClick(handler: () => void): BackButton
}

interface TelegramWebApp {
  initData: string
  colorScheme: ColorScheme
  themeParams: ThemeParams
  isExpanded: boolean
  viewportHeight: number
  viewportStableHeight: number
  /** Vùng an toàn thiết bị (notch/home indicator) — Bot API 8.0+. */
  safeAreaInset?: SafeAreaInsets
  /** Vùng an toàn nội dung (bị UI Telegram che) — Bot API 8.0+. */
  contentSafeAreaInset?: SafeAreaInsets
  HapticFeedback?: HapticFeedback
  MainButton: MainButton
  BackButton: BackButton
  ready(): void
  expand(): void
  openLink?(url: string): void
  openTelegramLink?(url: string): void
  onEvent(eventType: TelegramEventType, handler: TelegramEventHandler): void
  offEvent(eventType: TelegramEventType, handler: TelegramEventHandler): void
}

declare global {
  interface Window {
    Telegram?: {
      WebApp: TelegramWebApp
    }
  }
}

// ── Truy cập WebApp an toàn ──────────────────────────────────────────────────────────

/** Trả về instance WebApp nếu đang chạy trong Telegram, ngược lại `undefined`. */
function getWebApp(): TelegramWebApp | undefined {
  if (typeof window === 'undefined') return undefined
  return window.Telegram?.WebApp
}

/**
 * Đọc chuỗi `initData` thô của Telegram TƯƠI mỗi lần gọi (KHÔNG cache lúc nạp module).
 *
 * Lý do: khi mở Mini App lần đầu (cold start), `window.Telegram.WebApp.initData` có thể chưa
 * được Telegram nạp xong ngay tại thời điểm module được eval (script telegram-web-app.js tải
 * qua mạng + `ready()` chưa chạy). Nếu cache vào một hằng số lúc import, giá trị rỗng sẽ bị
 * "đóng băng" cả phiên → mọi request gửi initData rỗng → Worker trả 401 → buộc phải reload.
 * Đọc tươi mỗi request đảm bảo lấy đúng giá trị sau khi WebApp đã sẵn sàng.
 *
 * Ngoài Telegram → '' (chuỗi rỗng) để API client vẫn gửi header mà không vỡ.
 */
export function getInitData(): string {
  return getWebApp()?.initData ?? ''
}

/**
 * Mở một liên kết thanh toán (vd `pay_url` của Crypto Pay).
 *  - Link `t.me/...` → `openTelegramLink` (mở trong Telegram, giữ Mini App sống).
 *  - Link khác → `openLink` của WebApp.
 *  - Ngoài Telegram → `window.open` (dev/trình duyệt thường).
 */
export function openLink(url: string): void {
  const wa = getWebApp()
  if (wa) {
    if (url.startsWith('https://t.me/') && typeof wa.openTelegramLink === 'function') {
      wa.openTelegramLink(url)
      return
    }
    if (typeof wa.openLink === 'function') {
      wa.openLink(url)
      return
    }
  }
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener')
}

// ── Khởi tạo ──────────────────────────────────────────────────────────────────────────

/**
 * Gộp `safeAreaInset` + `contentSafeAreaInset` thành tổng vùng an toàn cho nội dung.
 * Telegram khuyến nghị cộng dồn 2 vùng (thiết bị + UI Telegram). Trả `null` khi không có dữ liệu.
 */
function resolveSafeArea(wa: TelegramWebApp): SafeAreaInsets | null {
  const device = wa.safeAreaInset
  const content = wa.contentSafeAreaInset
  if (!device && !content) return null
  const sum = (a: number | undefined, b: number | undefined): number => (a ?? 0) + (b ?? 0)
  return {
    top: sum(device?.top, content?.top),
    right: sum(device?.right, content?.right),
    bottom: sum(device?.bottom, content?.bottom),
    left: sum(device?.left, content?.left),
  }
}

/**
 * Khởi tạo Telegram WebApp: ready/expand, áp theme + safe-area, đăng ký lắng nghe thay đổi.
 * No-op khi chạy ngoài Telegram.
 */
export function initTelegram(): void {
  const wa = getWebApp()
  if (!wa) return

  wa.ready()
  wa.expand()

  // Áp theme + safe-area lần đầu (Req 13.6, 13.7).
  applyTheme(wa.themeParams, wa.colorScheme)
  applySafeArea(resolveSafeArea(wa))

  // Đồng bộ runtime khi người dùng đổi theme hệ thống hoặc viewport/safe-area thay đổi.
  wa.onEvent('themeChanged', () => applyTheme(wa.themeParams, wa.colorScheme))
  wa.onEvent('viewportChanged', () => applySafeArea(resolveSafeArea(wa)))
  wa.onEvent('safeAreaChanged', () => applySafeArea(resolveSafeArea(wa)))
  wa.onEvent('contentSafeAreaChanged', () => applySafeArea(resolveSafeArea(wa)))
}

// ── Haptic ─────────────────────────────────────────────────────────────────────────────

/** Loại phản hồi haptic hỗ trợ (Req 13.5). */
export type HapticKind = 'light' | 'medium' | 'heavy' | 'success' | 'warning' | 'error'

const NOTIFICATION_KINDS: ReadonlySet<HapticKind> = new Set(['success', 'warning', 'error'])

/**
 * Kích hoạt phản hồi haptic. No-op khi WebApp/HapticFeedback không khả dụng.
 *  - 'light' | 'medium' | 'heavy' → impactOccurred
 *  - 'success' | 'warning' | 'error' → notificationOccurred
 */
export function haptic(kind: HapticKind): void {
  const hf = getWebApp()?.HapticFeedback
  if (!hf) return
  if (NOTIFICATION_KINDS.has(kind)) {
    hf.notificationOccurred(kind as NotificationType)
  } else {
    hf.impactOccurred(kind as ImpactStyle)
  }
}

// ── MainButton / BackButton ──────────────────────────────────────────────────────────

/** Hàm dọn dẹp: gỡ handler + ẩn nút. An toàn khi gọi nhiều lần. */
export type Cleanup = () => void

const NOOP_CLEANUP: Cleanup = () => {}

/**
 * Cấu hình & hiển thị MainButton của Telegram, gắn handler click.
 * @returns hàm cleanup gỡ click + ẩn nút (gọi khi rời màn hình). No-op ngoài Telegram.
 */
export function showMainButton(text: string, onClick: () => void): Cleanup {
  const button = getWebApp()?.MainButton
  if (!button) return NOOP_CLEANUP

  button.setText(text)
  button.onClick(onClick)
  button.show()

  return () => {
    button.offClick(onClick)
    button.hide()
  }
}

/**
 * Hiển thị BackButton của Telegram, gắn handler click (thường gọi `router.back()`).
 * @returns hàm cleanup gỡ click + ẩn nút. No-op ngoài Telegram.
 */
export function showBackButton(onClick: () => void): Cleanup {
  const button = getWebApp()?.BackButton
  if (!button) return NOOP_CLEANUP

  button.onClick(onClick)
  button.show()

  return () => {
    button.offClick(onClick)
    button.hide()
  }
}
