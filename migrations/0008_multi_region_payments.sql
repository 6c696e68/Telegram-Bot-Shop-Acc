-- =============================================
-- Multi-Region Payments
--   1. users: them region (vietnam|international), language (locale mo, khong CHECK
--      cung de scale ngon ngu), language_locked (user da tu doi ngon ngu).
--   2. product_type_templates: bang con khoa theo (product_type_id, lang) thay cho
--      cot cung; di tru success_template hien huu -> dong lang='vi'.
--   3. deposits: rebuild de tong quat hoa da provider (sepay|cryptobot), cho phep
--      transfer_code NULL voi provider khong phai SePay, them truong CryptoBot.
--   4. system_config: seed exchange_rate_usdt_vnd, crypto_min_usdt, default_language.
-- =============================================

-- ---------------------------------------------
-- 1. users: them cot region / language / language_locked
-- ---------------------------------------------
ALTER TABLE users ADD COLUMN region TEXT
  CHECK(region IN ('vietnam','international'));            -- NULL = chua onboarding
ALTER TABLE users ADD COLUMN language TEXT;               -- ma locale ('vi','en',...); NULL = dung default_language
ALTER TABLE users ADD COLUMN language_locked INTEGER NOT NULL DEFAULT 0; -- 1 = user tu doi ngon ngu

-- ---------------------------------------------
-- 2. product_type_templates: template ban hang da ngon ngu
--    Tap ngon ngu la tap MO, kiem tra o tang ung dung theo SUPPORTED_LANGUAGES.
-- ---------------------------------------------
CREATE TABLE product_type_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_type_id INTEGER NOT NULL REFERENCES product_types(id) ON DELETE CASCADE,
  lang TEXT NOT NULL,                                  -- ma locale
  success_template TEXT,                               -- body template cho ngon ngu nay
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(product_type_id, lang)
);
CREATE INDEX idx_ptt_type_lang ON product_type_templates(product_type_id, lang);

-- Di tru du lieu cu: success_template hien huu tro thanh ban 'vi'
INSERT INTO product_type_templates (product_type_id, lang, success_template)
SELECT id, 'vi', success_template FROM product_types WHERE success_template IS NOT NULL;

-- ---------------------------------------------
-- 3. deposits: rebuild de tong quat hoa da provider
--    Luu y D1: PRAGMA foreign_keys la no-op khi dang trong transaction (giu chi de
--    tai lieu). Rebuild an toan vi khong bang nao co FOREIGN KEY tro TOI deposits
--    (transactions.reference_id la tham chieu da hinh, khong phai FK that).
-- ---------------------------------------------
PRAGMA foreign_keys=OFF;

CREATE TABLE deposits_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL DEFAULT 'sepay' CHECK(provider IN ('sepay','cryptobot')),
  amount INTEGER NOT NULL CHECK(amount > 0),          -- VND ky vong (luc tao) / VND da cong (sau hoan tat)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','completed','expired','cancelled','awaiting_credit')),
  -- SePay
  transfer_code TEXT,                                  -- NULL voi provider != sepay
  sepay_transaction_id TEXT,
  bank_ref TEXT,
  -- CryptoBot
  crypto_invoice_id TEXT,                              -- id invoice Crypto Pay (idempotency)
  asset TEXT,                                          -- 'USDT'
  usdt_amount TEXT,                                    -- chuoi thap phan, giu nguyen do chinh xac
  exchange_rate INTEGER,                               -- VND cho 1 USDT, ap luc cong tien
  completed_at TEXT,
  expired_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO deposits_new
  (id, user_id, provider, amount, status, transfer_code, sepay_transaction_id, bank_ref, completed_at, expired_at, created_at)
SELECT id, user_id, 'sepay', amount, status, transfer_code, sepay_transaction_id, bank_ref, completed_at, expired_at, created_at
FROM deposits;

DROP TABLE deposits;
ALTER TABLE deposits_new RENAME TO deposits;

-- Unique tung phan: chi rang buoc khi gia tri ton tai (cho phep nhieu NULL)
CREATE UNIQUE INDEX idx_deposits_transfer_code ON deposits(transfer_code) WHERE transfer_code IS NOT NULL;
CREATE UNIQUE INDEX idx_deposits_crypto_invoice ON deposits(crypto_invoice_id) WHERE crypto_invoice_id IS NOT NULL;
CREATE INDEX idx_deposits_user_status ON deposits(user_id, status);
CREATE INDEX idx_deposits_status_created ON deposits(status, created_at);
CREATE INDEX idx_deposits_sepay_tx ON deposits(sepay_transaction_id) WHERE sepay_transaction_id IS NOT NULL;

PRAGMA foreign_keys=ON;

-- ---------------------------------------------
-- 4. system_config: seed cau hinh moi
-- ---------------------------------------------
INSERT INTO system_config (key, value, description) VALUES
  ('exchange_rate_usdt_vnd', '20000', 'Ty gia quy doi 1 USDT sang VND (admin chinh)'),
  ('crypto_min_usdt', '5', 'So USDT toi thieu cho nap qua CryptoBot'),
  ('default_language', 'en', 'Ma locale mac dinh khi user chua xac dinh');
