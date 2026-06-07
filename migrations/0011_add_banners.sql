-- =============================================
-- Banner anh gioi thieu cho Mini App (storefront).
--   Admin upload nhieu anh banner qua CMS (tab Banner), luu duoi dang data URL
--   (base64) trong cot image_data — KHONG can R2/object storage.
--   Mini App doc cac banner is_active=1 sap theo sort_order de hien carousel.
-- =============================================

CREATE TABLE IF NOT EXISTS banners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  image_data TEXT NOT NULL,                       -- data URL (data:image/...;base64,...) hoac URL HTTPS
  link_url TEXT,                                  -- (tuy chon) link mo khi cham banner
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,           -- 1 = hien, 0 = an
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Doc nhanh cac banner dang hien, theo thu tu hien thi.
CREATE INDEX IF NOT EXISTS idx_banners_active_sort ON banners(is_active, sort_order);
