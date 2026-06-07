-- =============================================
-- Nhom danh muc (category) cho product_types.
--   Cho phep gom nhieu product_types vao mot nhom (vd: "AI", "Giai tri", "VPN").
--   Mini App sinh cac pill danh muc tu gia tri distinct de loc san pham (kem "Tat ca").
--   Null/rong = chua phan nhom (van hien o "Tat ca").
-- =============================================

ALTER TABLE product_types ADD COLUMN category TEXT;

-- Doc nhanh khi loc/nhom theo category tren storefront.
CREATE INDEX IF NOT EXISTS idx_product_types_category ON product_types(category);
