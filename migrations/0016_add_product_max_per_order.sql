-- 0016 - Thêm trần số lượng mỗi đơn theo từng sản phẩm.
-- Mỗi `products` có `max_per_order` riêng (mặc định 10). Trần cứng hệ thống là 50
-- (đồng bộ với MAX_QTY của bot và MAX_PURCHASE_QUANTITY của Mini App) để câu lệnh
-- giành stock `IN (...)` luôn an toàn dưới giới hạn bound-param của D1.
ALTER TABLE products
  ADD COLUMN max_per_order INTEGER NOT NULL DEFAULT 10
  CHECK (max_per_order >= 1 AND max_per_order <= 50);
