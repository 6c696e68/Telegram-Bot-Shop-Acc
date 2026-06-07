-- =============================================
-- Anh minh hoa cho danh muc san pham (product_types).
--   Admin upload 1 anh moi loai san pham qua CMS (tab Danh muc), luu duoi dang
--   data URL (base64) trong cot image_data — tai su dung co che giong bang banners,
--   KHONG can R2/object storage.
--   Mini App hien image_data lam anh san pham (dep hon emoji), fallback emoji khi rong.
-- =============================================

ALTER TABLE product_types ADD COLUMN image_data TEXT;
