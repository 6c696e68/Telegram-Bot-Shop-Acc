-- =============================================
-- Them cau hinh miniapp_url vao system_config (R: nut mo Mini App tu bot).
--   Bot doc key nay de hien nut web_app "Mo Mini App" o menu truy cap nhanh.
--   De trong => bot KHONG hien nut (an toan khi chua cau hinh).
--   Quan ly qua CMS -> Cau hinh. Gia tri la URL tuyet doi HTTPS tro toi `/app`.
-- =============================================

INSERT OR IGNORE INTO system_config (key, value, description) VALUES
  ('miniapp_url', '', 'URL tuyet doi HTTPS toi Mini App (vd https://<worker>/app). De trong se an nut mo Mini App trong bot.');
