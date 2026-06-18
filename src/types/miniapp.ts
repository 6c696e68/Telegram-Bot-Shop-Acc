/**
 * DTO tầng Mini App — KHÔNG phải bảng DB.
 *
 * Đây là các kiểu dữ liệu trả về cho API `/api/app/*`, tách bạch với
 * model D1 (`src/types/db.ts`). Field dùng snake_case để đồng bộ với
 * shape JSON mà frontend Mini App tiêu thụ. Mọi giá trị tiền (`*_amount`,
 * `balance`, `price`) là INTEGER VNĐ; các field `*_display` là chuỗi đã
 * format qua `formatCurrency` để hiển thị thống nhất với hệ thống hiện tại.
 */

/**
 * Kết quả verify initData. Re-export từ util xác thực để các module tầng
 * Mini App import một chỗ duy nhất (single source of truth, tránh trùng định nghĩa).
 */
export type { InitDataParsed } from '../utils/telegram-initdata'

/** `GET /api/app/me` — thông tin tài khoản + số dư (Req 12). KHÔNG chứa field admin. */
export interface MeDto {
  telegram_id: number
  username: string | null
  first_name: string | null
  balance: number
  balance_display: string
  region: 'vietnam' | 'international' | null
  language: string | null
  // rate: số chia VND-per-USD để client hiển thị tổng tiền động (price × qty) theo vùng; null → fallback VND.
  rate: number | null
}

/** Phần tử `GET /api/app/deposit-methods` — phương thức nạp khả dụng theo vùng (Req 8.3). */
export interface DepositMethodDto {
  id: 'sepay' | 'cryptobot' | 'payos'
  amount_unit: 'vnd' | 'usdt'
}

/** `POST /api/app/deposits` (method=cryptobot) — invoice Crypto Pay vừa tạo (Req 10.1, 10.3). */
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

/** `POST /api/app/deposits` (method=payos) — link thanh toán PayOS vừa tạo. */
export interface PayosDepositCreatedDto {
  deposit_id: number
  method: 'payos'
  checkout_url: string
  amount: number
  amount_display: string
  status: 'pending'
}

/** Phần tử danh sách sản phẩm có giá (tầng 2) — `GET /api/app/categories/:id/products` hoặc alias `/product-types`. */
export interface ProductListItemDto {
  id: number
  product_type_id: number
  category_id: number
  category_name: string
  name: string
  emoji: string | null
  /** Ảnh minh hoạ (data URL/HTTPS) do admin upload; null → Mini App fallback emoji. */
  image_url: string | null
  description: string | null
  content: string | null
  price: number
  price_display: string
  stock: number // COUNT(product_items.status='available')
  in_stock: boolean // stock > 0
}

/** Chi tiết sản phẩm có giá (tầng 2) — `GET /api/app/product-types/:id`. KHÔNG trả `success_template`. */
export interface ProductDetailDto {
  id: number
  product_type_id: number
  category_id: number
  category_name: string
  name: string
  emoji: string | null
  /** Ảnh minh hoạ (data URL/HTTPS) do admin upload; null → Mini App fallback emoji. */
  image_url: string | null
  description: string | null
  content: string | null
  price: number
  price_display: string
  stock: number // COUNT(product_items.status='available')
  in_stock: boolean // stock > 0
  max_quantity: number // trần số lượng cho mỗi lần mua
}

/** Phần tử `GET /api/app/categories` — danh mục Product_Type tầng 1. */
export interface CategoryListItemDto {
  id: number
  name: string
  emoji: string | null
  image_url: string | null
  description: string | null
  content: string | null
  product_count: number
  stock: number
  in_stock: boolean
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
  provider: 'sepay' | 'cryptobot' | 'payos'
  status: 'pending' | 'completed' | 'expired' | 'cancelled' | 'awaiting_credit'
  amount: number
  new_balance?: number // chỉ có khi status='completed' (đã cộng tiền qua webhook)
  new_balance_display?: string // region-aware display, chỉ có khi completed
}

/** Phần tử danh sách `GET /api/app/orders` — lịch sử đơn hàng (Req 11.1, 11.2). */
export interface OrderListItemDto {
  id: number
  product_name: string
  emoji: string | null
  quantity: number
  total_amount: number
  total_display: string
  status: 'completed' | 'refunded'
  created_at: string
}

/** `GET /api/app/orders/:id` — chi tiết đơn; `contents` chỉ trả khi đơn thuộc người mua hiện tại (Req 11.3, 15.3). */
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
