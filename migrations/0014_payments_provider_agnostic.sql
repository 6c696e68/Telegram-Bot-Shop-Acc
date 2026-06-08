-- =============================================
-- Provider-agnostic deposits
--   Rebuild deposits: bo cot rieng theo provider, dung 3 cot chung
--   correlation_ref / provider_txn_id / metadata. provider -> TEXT bo CHECK
--   (hop le hoa provider chuyen len tang ung dung qua registry).
--   Migrate du lieu that: sepay + cryptobot sang mo hinh moi khong mat mat.
--
--   Luu y D1: PRAGMA foreign_keys la no-op khi dang trong transaction (giu chi de
--   tai lieu). Rebuild an toan vi khong bang nao co FOREIGN KEY tro TOI deposits
--   (transactions.reference_id la tham chieu da hinh, khong phai FK that).
-- =============================================
PRAGMA foreign_keys=OFF;

CREATE TABLE deposits_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL DEFAULT 'sepay',              -- KHONG CHECK: registry hop le hoa
  amount INTEGER NOT NULL CHECK(amount > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','completed','expired','cancelled','awaiting_credit')),
  correlation_ref TEXT,                                -- ma doi soat noi bo (transfer_code / orderCode)
  provider_txn_id TEXT,                                -- dinh danh phia provider (idempotency)
  metadata TEXT,                                       -- JSON dac thu provider
  completed_at TEXT,
  expired_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Migrate sepay: correlation_ref=transfer_code, provider_txn_id=sepay_transaction_id,
-- NHUNG sepay_transaction_id = 'manual-approve' cu -> 'manual-' || id de khong vo
-- chi muc unique (provider, provider_txn_id) khi co nhieu Deposit duyet tay cu.
-- metadata = json_object('bank_ref', bank_ref) CHI khi bank_ref khong NULL (con lai NULL).
INSERT INTO deposits_new
  (id, user_id, provider, amount, status, correlation_ref, provider_txn_id, metadata, completed_at, expired_at, created_at)
SELECT
  id, user_id, 'sepay', amount, status,
  transfer_code,
  CASE WHEN sepay_transaction_id = 'manual-approve' THEN 'manual-' || id ELSE sepay_transaction_id END,
  CASE WHEN bank_ref IS NOT NULL THEN json_object('bank_ref', bank_ref) ELSE NULL END,
  completed_at, expired_at, created_at
FROM deposits WHERE provider = 'sepay';

-- Migrate cryptobot: correlation_ref=provider_txn_id=crypto_invoice_id,
-- metadata = json_object('asset', asset, 'usdt_amount', usdt_amount, 'exchange_rate', exchange_rate).
-- NULL nguon -> NULL dich (crypto_invoice_id NULL -> correlation_ref/provider_txn_id NULL).
INSERT INTO deposits_new
  (id, user_id, provider, amount, status, correlation_ref, provider_txn_id, metadata, completed_at, expired_at, created_at)
SELECT
  id, user_id, 'cryptobot', amount, status,
  crypto_invoice_id,
  crypto_invoice_id,
  json_object('asset', asset, 'usdt_amount', usdt_amount, 'exchange_rate', exchange_rate),
  completed_at, expired_at, created_at
FROM deposits WHERE provider = 'cryptobot';

DROP TABLE deposits;
ALTER TABLE deposits_new RENAME TO deposits;

-- Unique tung phan: chi rang buoc khi gia tri ton tai (cho phep nhieu NULL).
CREATE UNIQUE INDEX idx_deposits_provider_correlation
  ON deposits(provider, correlation_ref) WHERE correlation_ref IS NOT NULL;
CREATE UNIQUE INDEX idx_deposits_provider_txn
  ON deposits(provider, provider_txn_id) WHERE provider_txn_id IS NOT NULL;
-- Index truy van pho bien (giu nhu 0008).
CREATE INDEX idx_deposits_user_status ON deposits(user_id, status);
CREATE INDEX idx_deposits_status_created ON deposits(status, created_at);

PRAGMA foreign_keys=ON;
