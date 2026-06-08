INSERT INTO product_types (name, description, price, emoji, sort_order, is_visible, success_template) VALUES
 ('Gmail New', 'Tai khoan Gmail moi tao', 15000, '📧', 1, 1, 'Cam on ban da mua [name] [emoji]\n[content]\nTong: [total] - So du: [balance]'),
 ('Facebook Clone', 'Acc Facebook clone co', 50000, '👤', 2, 1, NULL),
 ('Het hang demo', 'Loai khong con hang', 9000, '📦', 3, 1, NULL);
INSERT INTO users (telegram_id, username, first_name, balance, is_active, region, language, language_locked, created_at, updated_at) VALUES
 (5551111, 'buyer_vn', 'Nguyen Van A', 250000, 1, 'vietnam', 'vi', 0, datetime('now'), datetime('now')),
 (5552222, 'buyer_intl', 'John Doe', 0, 1, 'international', 'en', 1, datetime('now'), datetime('now')),
 (5553333, 'newbie', 'Chua Onboarding', 0, 1, NULL, NULL, 0, datetime('now'), datetime('now'));
INSERT INTO products (type_id, content, status) VALUES
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
