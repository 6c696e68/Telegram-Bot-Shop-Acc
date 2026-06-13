INSERT INTO product_types (name, description, content, emoji, sort_order, is_visible) VALUES
 ('Email', 'Tai khoan email', NULL, NULL, 1, 1),
 ('Mang xa hoi', 'Tai khoan mang xa hoi', NULL, NULL, 2, 1),
 ('Demo', 'Danh muc demo', NULL, NULL, 3, 1);
INSERT INTO products (product_type_id, name, description, content, price, emoji, sort_order, is_visible) VALUES
 (1, 'Gmail New', 'Tai khoan Gmail moi tao', NULL, 15000, NULL, 1, 1),
 (2, 'Facebook Clone', 'Acc Facebook clone co', NULL, 50000, NULL, 2, 1),
 (3, 'Het hang demo', 'San pham khong con hang', NULL, 9000, NULL, 3, 1);
INSERT INTO product_type_templates (product_type_id, lang, success_template) VALUES
 (1, 'vi', 'Cam on ban da mua [name] [emoji]\n[content]\nTong: [total] - So du: [balance]');
INSERT INTO users (telegram_id, username, first_name, balance, is_active, region, language, language_locked, created_at, updated_at) VALUES
 (5551111, 'buyer_vn', 'Nguyen Van A', 250000, 1, 'vietnam', 'vi', 0, datetime('now'), datetime('now')),
 (5552222, 'buyer_intl', 'John Doe', 0, 1, 'international', 'en', 1, datetime('now'), datetime('now')),
 (5553333, 'newbie', 'Chua Onboarding', 0, 1, NULL, NULL, 0, datetime('now'), datetime('now'));
INSERT INTO product_items (product_id, content, status) VALUES
 (1, 'gmail1@example.com|pass1', 'available'),
 (1, 'gmail2@example.com|pass2', 'available'),
 (2, 'fb1|pass', 'available');
INSERT INTO deposits (user_id, provider, correlation_ref, provider_txn_id, amount, status, completed_at, created_at) VALUES
 (1, 'sepay', 'NAPABC123', 'SEPAY-TX-1', 100000, 'completed', datetime('now'), datetime('now'));
INSERT INTO deposits (user_id, provider, correlation_ref, provider_txn_id, amount, status, metadata, completed_at, created_at) VALUES
 (2, 'cryptobot', 'INV-555', 'INV-555', 150000, 'completed', json_object('asset', 'USDT', 'usdt_amount', '5', 'exchange_rate', 26000), datetime('now'), datetime('now'));
INSERT INTO deposits (user_id, provider, correlation_ref, amount, status, created_at) VALUES
 (1, 'sepay', 'NAPPEND01', 50000, 'pending', datetime('now'));
INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, status, created_at) VALUES
 (1, 'deposit', 100000, 0, 100000, 'deposit', 1, 'Nap 100.000d', 'success', datetime('now')),
 (2, 'deposit', 150000, 0, 150000, 'deposit', 2, 'Nap 150.000d', 'success', datetime('now'));
