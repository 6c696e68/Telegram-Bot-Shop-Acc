-- =============================================
-- Provider enablement flags (R7.6)
--   Provider MOI (vd cryptobot) chi duoc MO cho user sau khi admin xac nhan da chay
--   thu mot giao dich nap thanh cong. Mac dinh TAT (='0'); admin bat trong CMS -> Cau hinh.
--   SePay la provider hien huu -> luon bat (khong can co).
-- =============================================

INSERT OR IGNORE INTO system_config (key, value, description) VALUES
  ('payment_cryptobot_enabled', '0', 'Bat nap CryptoBot (USDT) cho user sau khi test thanh cong (R7.6)');
