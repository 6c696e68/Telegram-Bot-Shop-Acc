/**
 * DB model types — mapping 1:1 với D1/SQLite schema.
 * INTEGER cho monetary values (VNĐ, không thập phân).
 * TEXT ISO 8601 UTC cho timestamps.
 */

export interface DbUser {
  id: number
  telegram_id: number
  username: string | null
  first_name: string | null
  balance: number
  is_active: number // 1 = hoạt động, 0 = bị ban
  banned_at: string | null // ISO 8601 UTC — thời điểm bị ban (null nếu đang hoạt động)
  last_interaction_at: string | null
  region: 'vietnam' | 'international' | null // null = chưa onboarding
  language: string | null // mã locale ('vi','en',...); null = dùng default_language
  language_locked: number // 1 = user đã tự đổi ngôn ngữ
  created_at: string
  updated_at: string
}

export interface DbProductTypeTemplate {
  id: number
  product_type_id: number
  lang: string // mã locale
  success_template: string | null
  updated_at: string
}

export interface DbProductType {
  id: number
  name: string
  description: string | null
  price: number
  emoji: string
  /** Ảnh minh hoạ: data URL (base64) hoặc URL HTTPS; null = chưa có (Mini App fallback emoji). */
  image_data: string | null
  sort_order: number
  is_visible: number // 0 | 1
  success_template: string | null
  created_at: string
  updated_at: string
}

export interface DbProduct {
  id: number
  type_id: number
  content: string
  status: 'available' | 'sold' | 'reserved'
  buyer_id: number | null
  order_id: number | null
  created_at: string
  sold_at: string | null
}

export interface DbOrder {
  id: number
  user_id: number
  product_type_id: number
  quantity: number
  total_amount: number
  transaction_id: number | null
  status: 'completed' | 'refunded'
  created_at: string
}

export interface DbOrderItem {
  id: number
  order_id: number
  product_id: number
  created_at: string
}

export interface DbTransaction {
  id: number
  user_id: number
  type: 'deposit' | 'purchase' | 'refund' | 'adjustment'
  amount: number
  balance_before: number
  balance_after: number
  reference_type: string | null
  reference_id: number | null
  description: string | null
  status: 'success' | 'failed' | 'pending'
  created_at: string
}

export interface DbDeposit {
  id: number
  user_id: number
  provider: 'sepay' | 'cryptobot' | 'payos'
  amount: number // VND kỳ vọng (lúc tạo) / VND đã cộng (sau hoàn tất)
  status: 'pending' | 'completed' | 'expired' | 'cancelled' | 'awaiting_credit'
  correlation_ref: string | null // mã đối soát nội bộ: transfer_code (sepay) / orderCode (payos) / invoice_id (cryptobot)
  provider_txn_id: string | null // định danh phía provider: sepay_transaction_id / paymentLinkId / invoice_id — idempotency
  metadata: string | null // JSON đặc thù provider
  completed_at: string | null
  expired_at: string | null
  created_at: string
}

export interface DbAdminUser {
  id: number
  username: string
  password_hash: string
  display_name: string | null
  last_login_at: string | null
  failed_login_count: number
  locked_until: string | null
  created_at: string
}

export interface DbSystemConfig {
  key: string
  value: string
  description: string | null
  updated_at: string
  updated_by: number | null
}

export interface DbAuditLog {
  id: number
  admin_id: number
  action: string
  resource_type: string
  resource_id: number | null
  old_value: string | null
  new_value: string | null
  ip_address: string | null
  created_at: string
}

/** Bảng `banners` — ảnh banner giới thiệu cho Mini App storefront (migration 0011). */
export interface DbBanner {
  id: number
  /** data URL (data:image/...;base64,...) hoặc URL HTTPS. */
  image_data: string
  /** Link mở khi chạm banner (tuỳ chọn). */
  link_url: string | null
  sort_order: number
  /** 1 = hiển thị, 0 = ẩn. */
  is_active: number
  created_at: string
}
