/**
 * DTO tầng Mini App (frontend) — mirror chính xác `src/types/miniapp.ts` của backend.
 *
 * Đây là shape JSON mà API `/api/app/*` trả về (đã unwrap khỏi `ApiResponse`).
 * Field dùng snake_case để khớp 1-1 với payload server, tránh phải map lại.
 * Mọi giá trị tiền (`*_amount`, `balance`, `price`) là INTEGER VNĐ; các field
 * `*_display` là chuỗi đã format sẵn từ server để hiển thị thống nhất.
 *
 * Single source of truth cho view (13.x) import qua `@/types`.
 */

/** Meta phân trang — khớp `PaginationMeta` backend (`src/types/api.ts`). */
export interface PaginationMeta {
  total: number
  page: number
  limit: number
}

/** `GET /api/app/me` — thông tin tài khoản + số dư (Req 12). KHÔNG chứa field admin. */
export interface MeDto {
  telegram_id: number
  username: string | null
  first_name: string | null
  balance: number
  balance_display: string
  region: 'vietnam' | 'international' | null
  language: string | null
  /** Tỉ giá VNĐ trên 1 USD (divisor) để client format giá trị động region-aware; null → fallback VNĐ. */
  rate: number | null
}

/** `GET /api/app/deposit-methods` — phương thức nạp khả dụng theo vùng (Req 8.3). */
export interface DepositMethodDto {
  id: 'sepay' | 'cryptobot'
  amount_unit: 'vnd' | 'usdt'
}

/** `POST /api/app/deposits` (method=cryptobot) — invoice Crypto Pay (Req 10.1, 10.3). */
export interface CryptoDepositCreatedDto {
  deposit_id: number
  method: 'cryptobot'
  pay_url: string
  usdt_amount: string
  invoice_id: string
  credit_vnd: number // VND quy đổi để user biết ~bao nhiêu
  credit_vnd_display: string // VND quy đổi để user biết ~bao nhiêu
  status: 'pending'
}

/** `GET /api/app/home` — số dư + lối tắt trang chủ (Req 4). */
export interface HomeDto {
  balance: number
  balance_display: string
  shortcuts: string[]
}

/** Phần tử danh sách `GET /api/app/product-types` (Req 5.1, 5.2). Bao gồm cả loại hết hàng. */
export interface ProductTypeListItemDto {
  id: number
  name: string
  emoji: string
  price: number
  price_display: string
  stock: number // COUNT(products.status='available')
  in_stock: boolean // stock > 0
}

/** `GET /api/app/product-types/:id` — chi tiết loại sản phẩm (Req 5.3, 5.4). KHÔNG trả `success_template`. */
export interface ProductTypeDetailDto {
  id: number
  name: string
  emoji: string
  description: string | null
  price: number
  price_display: string
  stock: number // COUNT(products.status='available')
  in_stock: boolean // stock > 0
  max_quantity: number // trần số lượng cho mỗi lần mua
}

/** `POST /api/app/purchase` — kết quả mua hàng thành công (Req 6.6, 6.7). */
export interface PurchaseResultDto {
  order_id: number
  quantity: number
  total_amount: number
  new_balance: number
  new_balance_display: string
  contents: string[] // products.content vừa mua
}

/** `POST /api/app/deposits` — yêu cầu nạp vừa tạo + VietQR (Req 8.4, 10.1). */
export interface DepositCreatedDto {
  deposit_id: number
  transfer_code: string
  amount: number
  amount_display: string
  bank_name: string
  bank_account: string
  bank_owner: string
  qr_url: string
  status: 'pending'
}

/** `GET /api/app/deposits/:id` — trạng thái yêu cầu nạp để frontend poll (Req 8.5, 9.1). */
export interface DepositStatusDto {
  deposit_id: number
  provider: 'sepay' | 'cryptobot'
  status: 'pending' | 'completed' | 'expired' | 'cancelled' | 'awaiting_credit'
  amount: number
  new_balance?: number // chỉ có khi status='completed'
  new_balance_display?: string // region-aware display, chỉ có khi completed
}

/** Phần tử danh sách `GET /api/app/orders` — lịch sử đơn hàng (Req 11.1, 11.2). */
export interface OrderListItemDto {
  id: number
  product_name: string
  emoji: string
  quantity: number
  total_amount: number
  total_display: string
  status: 'completed' | 'refunded'
  created_at: string
}

/** `GET /api/app/orders/:id` — chi tiết đơn; `contents` chỉ trả khi đơn thuộc người mua (Req 11.3, 15.3). */
export interface OrderDetailDto extends OrderListItemDto {
  contents: string[] // products.content thuộc đơn
}

/** Phần tử `GET /api/app/banners` — ảnh banner storefront (chỉ banner is_active=1). */
export interface BannerDto {
  id: number
  /** data URL (base64) hoặc URL HTTPS của ảnh banner. */
  image_url: string
  /** Link mở khi chạm banner (tuỳ chọn). */
  link_url: string | null
}
