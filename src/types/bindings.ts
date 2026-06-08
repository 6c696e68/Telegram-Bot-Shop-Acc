/**
 * Hono Bindings type — environment variables và D1 binding cho Cloudflare Worker.
 */
export type Bindings = {
  /** Cloudflare D1 database binding */
  DB: D1Database
  /** Telegram Bot API token */
  BOT_TOKEN: string
  /** Secret token để xác thực webhook từ Telegram */
  TELEGRAM_SECRET_TOKEN: string
  /** API key xác thực webhook từ SePay */
  SEPAY_API_KEY: string
  /** Danh sách Telegram IDs của admin, phân cách bằng dấu phẩy */
  ADMIN_IDS: string
  /** Secret key cho JWT signing (CMS auth) */
  JWT_SECRET: string
  /** Tên ngân hàng nhận thanh toán */
  BANK_NAME: string
  /** Số tài khoản ngân hàng nhận thanh toán */
  BANK_ACCOUNT: string
  /** Tên chủ tài khoản ngân hàng */
  BANK_OWNER: string
  /** Token Crypto Pay API (secret) cho thanh toán crypto đa khu vực */
  CRYPTO_PAY_API_TOKEN: string
  /** PayOS Client ID (định danh merchant) cho nạp tiền PayOS */
  PAYOS_CLIENT_ID: string
  /** PayOS API key (secret) — không log */
  PAYOS_API_KEY: string
  /** PayOS Checksum key (secret) dùng ký/verify chữ ký — không log */
  PAYOS_CHECKSUM_KEY: string
  /** KV namespace cho static assets (Wrangler Sites) */
  __STATIC_CONTENT: KVNamespace
}

export type AppEnv = {
  Bindings: Bindings
}

// Wrangler Sites injects this global at build time
declare const __STATIC_CONTENT_MANIFEST: string
