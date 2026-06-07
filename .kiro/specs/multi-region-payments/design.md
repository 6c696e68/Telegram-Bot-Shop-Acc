# Design Document

## Overview

Tài liệu thiết kế cho tính năng **multi-region-payments**: bổ sung onboarding chọn vùng (Việt Nam / Quốc tế), đa ngôn ngữ VI/EN cho Bot + Mini App + CMS, tích hợp **@CryptoBot (Crypto Pay API)** nhận USDT, và **trừu tượng hoá luồng nạp tiền theo Payment_Provider** để dễ mở rộng.

Nguyên tắc thiết kế xuyên suốt:

- **Bám kiến trúc sẵn có**: Hono routes + services + D1 `batch()` atomic + `system_config` DB-first (không cache) + thông báo bot qua `executionCtx.waitUntil`. Không thay đổi mô hình số dư (VND, `users.balance` INTEGER, CHECK `>= 0`).
- **Không phá vỡ SePay**: hành vi SePay hiện tại (idempotency theo `sepay_transaction_id`, TTL 15 phút bỏ qua cộng khi quá hạn) được giữ nguyên, chỉ tổng quát hoá phần dùng chung.
- **Mở rộng không sửa lõi (OCP)**: thêm provider mới = thêm một implement của interface `PaymentProvider` + đăng ký vào registry, không đụng logic cộng tiền atomic dùng chung.
- **Không làm mất tiền đã trả**: USDT đến trễ sau khi deposit `expired` vẫn cộng (idempotent); USDT đã trả mà tỷ giá lỗi → giữ ở `awaiting_credit` rồi cộng khi tỷ giá hợp lệ.
- **Mở rộng được nhiều ngôn ngữ (i18n-first)**: ngôn ngữ là **tập mở**. Một `SUPPORTED_LANGUAGES` registry duy nhất + catalog tách theo locale + bảng `product_type_templates` khóa theo `lang`. Thêm ngôn ngữ mới = thêm dữ liệu/catalog, KHÔNG sửa schema, không sửa lõi, không CHECK constraint cứng. Region và language tách rời (R6).
- **Quy tắc chuỗi mới**: mọi chuỗi i18n và thông báo MỚI do tính năng này sinh ra dùng **chữ thuần, không emoji** (theo AGENTS.md). Emoji cũ trong header template VI và thông báo SePay hiện hữu giữ nguyên, không nhân rộng.

Tham chiếu: các mục thiết kế ánh xạ tới Requirements R1–R20 trong `requirements.md` (xem mục Traceability cuối tài liệu).

## Architecture

### Sơ đồ thành phần (high-level)

```
                         ┌──────────────────────────────────────────────┐
                         │            Cloudflare Worker (Hono)            │
                         │                                                │
  Telegram  ──webhook──▶ │  routes/telegram.ts ─▶ bot/router.ts           │
                         │      │                  ├─ commands/start (onboarding) 
                         │      │                  ├─ callbacks/region (mới)
                         │      │                  └─ callbacks/deposit (đa provider)
                         │      ▼                                          │
  SePay     ──webhook──▶ │  routes/sepay.ts ───────┐                       │
                         │                          ├─▶ services/payments/* │
  @CryptoBot ─webhook──▶ │  routes/cryptopay.ts ───┘     (PaymentProvider)  │
                         │                                 │               │
  Mini App  ──HTTPS────▶ │  routes/miniapp-api.ts ─────────┤               │
                         │      (region, deposit-methods,  ▼               │
                         │       deposits đa provider)  services/           │
                         │                              deposit-service ───▶ D1 (batch atomic)
  CMS       ──HTTPS────▶ │  routes/admin/* (config, templates EN, users)   │
                         │                                                  │
  Cron (15') ─scheduled▶ │  services/deposit-expiry  + credit-awaiting (mới)│
                         └──────────────────────────────────────────────┘
                                   i18n catalog (bot) · vue-i18n (Mini App, CMS)
```

### Quyết định kiến trúc chính

1. **Webhook CryptoBot tách route riêng** `routes/cryptopay.ts` (đối xứng `routes/sepay.ts`), middleware xác thực chữ ký riêng. Không gộp vào route SePay để giữ Single Responsibility.
2. **Tầng `services/payments/`** chứa abstraction `PaymentProvider` + registry + hai implement (`sepay`, `cryptobot`). `DepositService` là điểm vào dùng chung cho cộng tiền atomic.
3. **`completeDeposit` provider-agnostic** thay cho `executeDeposit` (đang gắn cứng SePay). Logic cộng tiền (balance + deposit status + transaction) dùng chung; phần đặc thù (mã giao dịch, USDT, rate) truyền qua tham số.
4. **i18n**: Bot dùng catalog TS thuần (không cần thư viện, message tĩnh). Mini App + CMS dùng `vue-i18n` (đã là Vue 3). Nguồn ngôn ngữ người dùng: `users.language` → `default_language` (config) → `'en'`.
5. **Vùng quyết định tập phương thức; ngôn ngữ tách rời vùng** (R6): region chỉ set ngôn ngữ khởi tạo; `users.language_locked` đánh dấu user đã tự đổi để không bị ghi đè khi đổi vùng.

## Data Models

### Migration mới `0008_multi_region_payments.sql`

Vì SQLite không hỗ trợ bỏ ràng buộc `NOT NULL/UNIQUE` qua `ALTER`, bảng `deposits` cần **rebuild** (transfer_code phải cho phép NULL với deposit không phải SePay — R7.7). Các bảng khác chỉ cần `ADD COLUMN`.

**users — thêm cột:**

```sql
ALTER TABLE users ADD COLUMN region TEXT
  CHECK(region IN ('vietnam','international'));            -- NULL = chưa onboarding
ALTER TABLE users ADD COLUMN language TEXT;               -- mã locale (vd 'vi','en','th'); NULL = dùng default_language
ALTER TABLE users ADD COLUMN language_locked INTEGER NOT NULL DEFAULT 0; -- 1 = user tự đổi ngôn ngữ (R6.4)
```

> **Scale ngôn ngữ:** `language` cố tình KHÔNG dùng CHECK `IN ('vi','en')`. Tập ngôn ngữ hợp lệ là tập MỞ, kiểm tra ở tầng ứng dụng theo registry `SUPPORTED_LANGUAGES` (single source of truth). Thêm ngôn ngữ mới = thêm vào registry + catalog, KHÔNG cần migration. Lưu mã locale dạng chuẩn (BCP-47 rút gọn: `vi`, `en`, `th`, `zh`...).

**product_type_templates — bảng template đa ngôn ngữ (thay cho cột cứng, R16):**

Hai cột (`success_template` + `success_template_en`) không mở rộng được tới N ngôn ngữ, nên dùng **bảng con khóa theo (product_type_id, lang)** — mỗi ngôn ngữ là một dòng, thêm ngôn ngữ không đổi schema:

```sql
CREATE TABLE product_type_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_type_id INTEGER NOT NULL REFERENCES product_types(id) ON DELETE CASCADE,
  lang TEXT NOT NULL,                                  -- mã locale
  success_template TEXT,                               -- body template cho ngôn ngữ này
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(product_type_id, lang)
);
CREATE INDEX idx_ptt_type_lang ON product_type_templates(product_type_id, lang);

-- Di trú dữ liệu cũ: success_template hiện hữu trở thành bản 'vi'
INSERT INTO product_type_templates (product_type_id, lang, success_template)
SELECT id, 'vi', success_template FROM product_types WHERE success_template IS NOT NULL;
```

> Cột `product_types.success_template` cũ GIỮ NGUYÊN vật lý (SQLite drop tốn kém) nhưng **ngừng sử dụng**; nguồn sự thật chuyển sang `product_type_templates` (tránh hai nguồn dữ liệu — DRY).

**deposits — rebuild để tổng quát hoá đa provider:**

> **Lưu ý D1 migration:** D1 chạy mỗi file migration trong một transaction ngầm, mà `PRAGMA foreign_keys` là **no-op khi đang trong transaction** (SQLite chỉ cho đổi ngoài transaction). Hai dòng `PRAGMA foreign_keys=OFF/ON` dưới đây vì thế **không có tác dụng thực tế** trên D1 — giữ lại chỉ mang tính tài liệu. May mắn là **không bảng nào có FOREIGN KEY trỏ TỚI `deposits`** (`transactions.reference_id` là tham chiếu đa hình, không phải FK thật; `products.order_id` trỏ `orders`), nên việc DROP + RENAME `deposits` an toàn mà không cần tắt FK. Trước khi chạy `db:migrate:remote` phải chạy `db:migrate:local` kiểm tra rebuild giữ nguyên dữ liệu cũ.

```sql
PRAGMA foreign_keys=OFF;

CREATE TABLE deposits_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL DEFAULT 'sepay' CHECK(provider IN ('sepay','cryptobot')),
  amount INTEGER NOT NULL CHECK(amount > 0),          -- VND kỳ vọng (lúc tạo) / VND đã cộng (sau hoàn tất)
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','completed','expired','cancelled','awaiting_credit')),
  -- SePay
  transfer_code TEXT,                                  -- NULL với provider != sepay (R7.7)
  sepay_transaction_id TEXT,
  bank_ref TEXT,
  -- CryptoBot
  crypto_invoice_id TEXT,                              -- id invoice Crypto Pay (idempotency)
  asset TEXT,                                          -- 'USDT'
  usdt_amount TEXT,                                    -- chuỗi thập phân, giữ nguyên độ chính xác
  exchange_rate INTEGER,                               -- VND cho 1 USDT, áp lúc cộng tiền
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

-- Unique từng phần: chỉ ràng buộc khi giá trị tồn tại (cho phép nhiều NULL)
CREATE UNIQUE INDEX idx_deposits_transfer_code ON deposits(transfer_code) WHERE transfer_code IS NOT NULL;
CREATE UNIQUE INDEX idx_deposits_crypto_invoice ON deposits(crypto_invoice_id) WHERE crypto_invoice_id IS NOT NULL;
CREATE INDEX idx_deposits_user_status ON deposits(user_id, status);
CREATE INDEX idx_deposits_status_created ON deposits(status, created_at);
CREATE INDEX idx_deposits_sepay_tx ON deposits(sepay_transaction_id) WHERE sepay_transaction_id IS NOT NULL;

PRAGMA foreign_keys=ON;
```

**system_config — seed cấu hình mới:**

```sql
INSERT INTO system_config (key, value, description) VALUES
  ('exchange_rate_usdt_vnd', '26000', 'Tỷ giá quy đổi 1 USDT sang VND (admin chỉnh)'),
  ('crypto_min_usdt', '5', 'Số USDT tối thiểu cho nạp qua CryptoBot'),
  ('default_language', 'en', 'Mã locale mặc định khi user chưa xác định');
```

> `SUPPORTED_LANGUAGES` (danh sách ngôn ngữ bật) khai báo trong code (registry, xem mục Components) để frontend bundle catalog tương ứng; `default_language` trong `system_config` cho phép admin đổi mặc định runtime, có validate phải thuộc registry.

> Ghi chú: `transactions` KHÔNG đổi schema. Provider + USDT + rate của một deposit được lấy qua JOIN `transactions.reference_id = deposits.id` (reference_type='deposit') — đủ cho tra cứu CMS (R20.6), tránh trùng dữ liệu (DRY).

### Cập nhật `src/types/db.ts`

- `DbUser`: thêm `region: 'vietnam' | 'international' | null`, `language: string | null` (mã locale, không hardcode union để scale), `language_locked: number`.
- Thêm `DbProductTypeTemplate`: `{ id, product_type_id, lang, success_template: string | null, updated_at }`.
- `DbProductType`: giữ `success_template` (deprecated, không dùng cho render mới).
- `DbDeposit`: thêm `provider: 'sepay' | 'cryptobot'`; `transfer_code: string | null`; thêm `crypto_invoice_id`, `asset`, `usdt_amount`, `exchange_rate` (nullable); mở rộng union `status` thêm `'awaiting_credit'`.

### Cập nhật `src/types/bindings.ts`

- Thêm `CRYPTO_PAY_API_TOKEN: string` (secret). Production set qua `wrangler secret put`, local qua `.dev.vars` (mẫu thêm vào `.dev.vars.example`).

## Components and Interfaces

### 1. Payment Provider abstraction — `src/services/payments/`

```typescript
// types.ts
export type ProviderId = 'sepay' | 'cryptobot'
export type Region = 'vietnam' | 'international'

export interface CreateDepositInput {
  db: D1Database
  env: Bindings
  userId: number          // users.id nội bộ
  telegramId: number
  rawAmount: number       // VND (sepay) hoặc USDT (cryptobot) — đơn vị theo provider
}

export interface CreateDepositOutput {
  depositId: number
  // Dữ liệu hiển thị cho client (1 trong 2 nhánh)
  vietqr?: { qrUrl: string; transferCode: string; bank: BankInfo; amountVnd: number }
  crypto?: { payUrl: string; usdtAmount: string; invoiceId: string }
}

export interface PaymentProvider {
  readonly id: ProviderId
  /** Đơn vị nhập của provider — quyết định cách validate hạn mức. */
  readonly amountUnit: 'vnd' | 'usdt'
  /** Tạo yêu cầu nạp pending + dữ liệu thanh toán. Tự validate hạn mức. */
  createDeposit(input: CreateDepositInput): Promise<CreateDepositResult>
}
```

- **Registry** (`src/services/payments/registry.ts`): `Map<ProviderId, PaymentProvider>` + `getProvider(id)` + `methodsForRegion(region)`:
  - `vietnam → ['sepay', 'cryptobot']` (R8.1)
  - `international → ['cryptobot']` (R8.2)
  - Thêm provider mới = đăng ký vào map + khai báo vùng khả dụng; không sửa lõi (R7.4).
- **`SePayProvider`** (`amountUnit='vnd'`): di chuyển logic tạo deposit VietQR hiện có (transfer_code + `generateVietQRUrl` + `readDepositLimits` + `checkDepositPolicy`) vào đây. Giữ nguyên hành vi. **Gộp trùng lặp**: hiện logic này lặp ở `bot/callbacks/deposit.ts` và `miniapp-api POST /deposits` — cả hai sẽ gọi `SePayProvider.createDeposit` + một `buildDepositCaption` dùng chung (gỡ bản trùng).
- **`CryptoPayProvider`** (`amountUnit='usdt'`): validate `usdt >= crypto_min_usdt` và `floor(usdt × rate) <= max_deposit` (R13); gọi Crypto Pay `createInvoice`; lưu deposit `pending` với `provider='cryptobot'`, `crypto_invoice_id`, `asset='USDT'`, `amount = floor(usdt × rate_hiện_tại)` (VND kỳ vọng để hiển thị/hạn mức).

### 2. DepositService — cộng tiền atomic dùng chung — `src/services/deposit-service.ts`

Thay thế `TransactionService.executeDeposit` (SePay-coupled) bằng hàm provider-agnostic, GIỮ nguyên pattern D1 `batch()` + concurrency guard. Sau khi chuyển, **gỡ hẳn `executeDeposit`** (không để hai hàm cộng tiền song song — DRY):

```typescript
export interface CompleteDepositInput {
  db: D1Database
  depositId: number
  userId: number
  creditVnd: number                 // số VND thực cộng
  provider: ProviderId
  sepayTransactionId?: string       // chỉ sepay
  cryptoInvoiceId?: string          // chỉ cryptobot
  usdtAmount?: string               // chỉ cryptobot (R12.5)
  exchangeRate?: number             // chỉ cryptobot (R12.5)
}

export type CompleteDepositResult =
  | { success: true; newBalance: number }
  | { success: false; error: 'already_processed' | 'not_found' | 'db_error' }
```

- Guard hoàn tất: `UPDATE deposits SET status='completed', ... WHERE id=? AND status IN ('pending','expired','awaiting_credit')`. `changes === 0` → `already_processed` (chống cộng trùng — R14.2, R14.4).
- Batch gồm: cộng `users.balance`, cập nhật `deposits` (status + provider fields + usdt/rate, **set `amount = creditVnd`** để record phản ánh đúng số VND thực cộng — R12.5), insert `transactions` (type='deposit', reference_type='deposit', reference_id=depositId). Atomic (R14.1).
- Cho phép hoàn tất từ trạng thái `expired` để phục vụ CryptoBot trả trễ (R11.4); SePay không gọi `completeDeposit` khi đã `expired` (route SePay tự bỏ qua — R15.3).
- `markAwaitingCredit(db, depositId, usdtAmount)`: set `status='awaiting_credit'`, lưu `usdt_amount` khi tỷ giá lỗi lúc nhận thanh toán (R12.4). **Guard `WHERE id=? AND status IN ('pending','expired')`**: không bao giờ ghi đè deposit đã `completed` (chống đảo trạng thái khi callback trùng tới lúc rate tạm lỗi — bảo toàn idempotency). `changes===0` → bỏ qua (đã hoàn tất hoặc đã ở awaiting_credit).

### 3. Crypto Pay client + webhook — `src/services/payments/crypto-pay-client.ts`, `src/routes/cryptopay.ts`, `src/middleware/cryptopay-auth.ts`

**Client** (`createInvoice`):
- Endpoint: `https://pay.crypt.bot/api/createInvoice` (mainnet). Header `Crypto-Pay-API-Token: <CRYPTO_PAY_API_TOKEN>`.
- Body: `{ currency_type: 'crypto', asset: 'USDT', amount: <usdt string>, description, payload: String(depositId), expires_in: <giây, dài hơn TTL local, vd 10800> }`.
- Trả `invoice_id` + các URL thanh toán. **Chọn URL theo kênh**: Bot dùng `bot_invoice_url`, Mini App dùng `mini_app_invoice_url`. `CreateDepositOutput.crypto.payUrl` được caller truyền kênh (`channel: 'bot' | 'miniapp'`) để client nhận đúng URL.

**Webhook verify** (`cryptopay-auth` middleware — R19.2):
- Đọc raw body. Tính `secret = SHA256(token)` (bytes). Tính `hmac = HMAC_SHA256(secret, rawBody)` hex. So sánh thời-gian-hằng với header `crypto-pay-api-signature`. Không khớp → 401, log lý do (R19.3, R19.4). Dùng WebCrypto (`crypto.subtle`) sẵn có trên Workers.

**Webhook handler** (`routes/cryptopay.ts`, `POST /cryptopay`):
1. Verify chữ ký (middleware). Parse update; chỉ xử lý `update_type === 'invoice_paid'`.
2. Lấy `invoiceId` + `payload(depositId)` + `paid_asset/paid_amount` (USDT thực nhận).
3. Idempotency: nếu deposit theo `crypto_invoice_id` đã `completed` → trả 200, bỏ qua (R11.2).
4. Đọc `exchange_rate_usdt_vnd`. Nếu thiếu/không hợp lệ → `markAwaitingCredit` (status `awaiting_credit`, lưu `usdt_amount`), log lỗi cấu hình, trả 200 (R12.4). KHÔNG mất tiền.
5. Nếu rate hợp lệ → `creditVnd = floor(paid_usdt × rate)`; gọi `completeDeposit(provider='cryptobot', ...)`. Hoàn tất kể cả khi deposit đang `expired` (R11.4, R15.4).
   - `success` hoặc `already_processed` → coi như đã cộng đúng một lần, đi tiếp bước 6.
   - `db_error` (lỗi atomic tạm thời sau khi thanh toán ĐÃ xác nhận) → **KHÔNG trả 200**: trả `500` để Crypto Pay **retry callback** cho tới khi cộng thành công (R14.5). Tiền không mất vì callback sẽ được gửi lại; idempotency guard đảm bảo không cộng trùng khi retry.
6. Gửi thông báo nạp thành công cho user theo `language` (R11.3) qua `waitUntil`. Trả 200 (R11.5).

### 4. Credit-awaiting job — `src/services/credit-awaiting.ts`

Gọi trong `scheduled` (cron 15') sau `expirePendingDeposits`. Nếu `exchange_rate` hợp lệ: lấy các deposit `status='awaiting_credit'`, tính `creditVnd` từ `usdt_amount × rate`, gọi `completeDeposit` (idempotent), thông báo user (R12.7). Tỷ giá vẫn lỗi → bỏ qua lượt này.

### 5. Region & Language resolution — `src/i18n/locales.ts` + `src/services/user-locale.ts`

**Registry ngôn ngữ (single source of truth, `src/i18n/locales.ts`)** — dùng chung cho Bot/Mini App/CMS:

```typescript
// Thêm 1 ngôn ngữ = thêm 1 dòng ở đây + 1 catalog; KHÔNG sửa lõi.
export const SUPPORTED_LANGUAGES = ['vi', 'en'] as const   // sẽ mở rộng: 'th','zh',...
export type Lang = (typeof SUPPORTED_LANGUAGES)[number]
export const BASE_FALLBACK_LANG: Lang = 'en'               // mắt xích cuối chuỗi fallback

export function isSupportedLang(x: string | null | undefined): x is Lang {
  return !!x && (SUPPORTED_LANGUAGES as readonly string[]).includes(x)
}

// Vùng → ngôn ngữ khởi tạo (bảng tra mở rộng được, không if/else cứng)
export const REGION_DEFAULT_LANG: Record<Region, Lang> = {
  vietnam: 'vi',
  international: 'en',
}
```

**`src/services/user-locale.ts`** — chuỗi fallback xác định, validate theo registry:

```typescript
// Chuỗi: user.language → default_language(config) → BASE_FALLBACK_LANG; mỗi mắt xích phải isSupportedLang
export async function resolveLang(db: D1Database, user: Pick<DbUser,'language'>): Promise<Lang>   // R4
export function regionDefaultLang(region: Region): Lang                                            // = REGION_DEFAULT_LANG[region]
export async function setRegion(db, userId, region): Promise<void>
//   set region; nếu language_locked=0 → set language = regionDefaultLang(region) (R3.3/3.4, R6.4)
export async function setLanguage(db, userId, lang: Lang): Promise<void>
//   validate isSupportedLang; set language + language_locked=1 (R6.3, R6.4)
```

`default_language` đọc từ `system_config`; nếu giá trị không thuộc registry (vd admin gõ sai / ngôn ngữ vừa bị gỡ) → bỏ qua, lùi về `BASE_FALLBACK_LANG` (fail-safe).

### 6. i18n (kiến trúc đa ngôn ngữ, mở rộng theo file)

Nguyên tắc chung mọi tầng: **catalog tách theo locale, key phẳng nhất quán giữa Bot/Mini App/CMS**; thêm ngôn ngữ = thêm một catalog cho mỗi tầng + một dòng trong `SUPPORTED_LANGUAGES`. Không tầng nào hardcode danh sách ngôn ngữ rời rạc.

- **Bot** — `src/bot/i18n/`: `catalogs: Record<Lang, Record<MessageKey, string>>`; helper `t(lang, key, vars?)` nội suy `{var}`. Thiếu key ở `lang` → fallback `BASE_FALLBACK_LANG` → cuối cùng trả `key` (không vỡ). Mọi chuỗi bot MỚI dùng chữ thuần, không emoji.
- **Mini App** — `miniapp/src/i18n/` dùng `vue-i18n`: mỗi locale một file `messages/<lang>.json`, nạp động/`import.meta.glob` để thêm file là tự nhận. `fallbackLocale = BASE_FALLBACK_LANG`, `missingWarn=false`, handler `missing` trả về text/key để vẫn render khi thiếu (R17.5); đổi `locale` reactive không reload (R17.4).
- **CMS** — `cms/src/i18n/` cùng cơ chế `vue-i18n`, `fallbackLocale='en'`, mặc định `en` (R18.3), bộ chọn ngôn ngữ render từ `SUPPORTED_LANGUAGES` (tự có thêm mục khi mở rộng), reactive không reload (R18.4).

> Khóa key dùng namespace (vd `deposit.method.cryptobot`, `onboarding.region.vietnam`) để đồng bộ và dễ dò thiếu. Có thể thêm script kiểm tra "thiếu key giữa các locale" trong test.

**Định dạng tiền/số/ngày theo locale (R4.6):** thêm helper `formatMoney(amountVnd, lang)` / `formatNumber(n, lang)` dùng `Intl.NumberFormat` theo `lang` (giữ đơn vị VND, đổi cách nhóm số + nhãn).

> **Lưu ý hiện trạng KHÔNG nhất quán cần thống nhất:** `src/utils/format.ts` `formatCurrency` đang dùng `toLocaleString('en-US')` → ra **dấu phẩy** (`150,000đ`), TRONG KHI `src/services/transaction.ts` lại dùng `toLocaleString('vi-VN')` ở mô tả deposit (`Nạp 150.000đ` → dấu chấm). Khi gom về helper: nhánh `lang='vi'` SHALL dùng `vi-VN` (nhóm bằng dấu chấm), nhánh `lang='en'` dùng `en-US` (dấu phẩy). Hệ quả: mọi chỗ đang hiển thị VND qua `formatCurrency` cho user vùng/ngôn ngữ `vi` sẽ đổi `150,000đ` → `150.000đ` (thay đổi UX nhìn thấy được, có chủ đích). `formatCurrency` cũ giữ lại như alias gọi `formatMoney(amount,'vi')` để không vỡ nơi gọi cũ, hoặc thay thế toàn bộ nơi gọi bằng `formatMoney(amount, lang)`.

Bot dùng helper server-side; Mini App/CMS dùng `vue-i18n` number formats. Mọi nơi hiển thị tiền (số dư, hạn mức, thông báo nạp) đi qua helper này.

### 7. Template renderer đa ngôn ngữ — `src/utils/telegram-template.ts`

- Đọc template từ `product_type_templates` theo `lang` (không còn cột cứng). Chữ ký:
  `renderSuccessMessage(templatesByLang: Map<Lang,string|null>, vars, lang)`.
- Chọn template theo thứ tự: `lang` → `BASE_FALLBACK_LANG` → body mặc định dựng sẵn theo `lang` (R16.5).
- **Header cố định đa ngôn ngữ**: header lấy từ catalog i18n bot theo `lang` (key `purchase.success.header`), không nhúng chuỗi cứng trong renderer — thêm ngôn ngữ chỉ cần thêm catalog (R16.4). Bản `vi` giữ nguyên nội dung+emoji hiện tại; bản ngôn ngữ mới dùng chữ thuần.
- Placeholder `[content] [name] [emoji] [quantity] [total] [balance]` + escape HTML giá trị động: giữ nguyên cơ chế hiện tại (R16.6).
- Service tải templates: `loadProductTypeTemplates(db, productTypeId)` → `Map<Lang,string|null>` (một query `WHERE product_type_id=?`).

### 8. Onboarding & method gating tích hợp vào Bot / Mini App

**Bot:**
- `handleStart`: sau upsert, nếu `region` NULL → gửi inline keyboard onboarding (`reg:vietnam`, `reg:international`) bằng `default_language`, KHÔNG hiện menu (R1.1, R1.2). Đã có region → menu như cũ (R1.5).
- `callbacks/region.ts` (mới): xử lý `reg:*` → `setRegion` rồi hiện menu (R1.3, R1.4). Router thêm case `reg`.
- **Menu chính đa ngôn ngữ (reuse + scale)**: `buildMainMenu(lang)` render nhãn theo `lang`. Vì reply-keyboard hiện DÙNG CHÍNH text làm khóa routing (`router.ts` match `'🛒 Mua hàng'`...), thêm `src/bot/i18n/menu.ts` dựng `MENU_ACTION_BY_LABEL: Map<label, action>` **gộp nhãn của MỌI locale trong SUPPORTED_LANGUAGES** → action. `handleTextMessage` tra `MENU_ACTION_BY_LABEL.get(text)` thay cho `switch` chuỗi cứng, nên match đúng bất kể user đang ở ngôn ngữ nào (và vẫn nhận nhãn cũ trong giai đoạn chuyển). Mọi nơi gọi `buildMainMenu()` truyền `lang` của user.
- Guard onboarding: trong `handleTextMessage`/`handleCallbackQuery`, nếu `region` NULL và input không phải chọn vùng → hiện lại onboarding (R1.6, R3.7).
- `handleDepositMenu`: liệt kê phương thức theo `methodsForRegion(region)`. Nhiều phương thức → bước chọn phương thức (`dep:method:sepay` / `dep:method:cryptobot`); chỉ một → vào thẳng. Crypto: session step `crypto_amount`, nhập USDT.
- Đổi vùng/ngôn ngữ: command `/region`, `/language` (hoặc nút trong menu) → cập nhật, dùng `setRegion`/`setLanguage` (R5.1, R6.1).

**Mini App:**
- `GET /api/app/me` trả thêm `region`, `language`. Region NULL → frontend hiện `OnboardingView` (R2.1).
- `POST /api/app/region { region }` → `setRegion` (R2.3, R2.4).
- `GET /api/app/deposit-methods` → trả phương thức theo region (R8.3).
- `POST /api/app/deposits { method, amount }`: `method='sepay'` (amount VND, như hiện tại) hoặc `method='cryptobot'` (amount USDT → tạo invoice, trả `pay_url`). Enforce method theo region (R8.4).
- `PUT /api/app/language { language }` → `setLanguage` (R6.2). Settings view đổi region/ngôn ngữ (R5.2).

**CMS:** trang Settings cấu hình `exchange_rate_usdt_vnd`, `min/max_deposit`, `crypto_min_usdt`, `default_language` (R20.1–R20.3, validate max>=min — R20.7); trang ProductType có trình soạn template **theo tab ngôn ngữ** sinh từ `SUPPORTED_LANGUAGES` (mỗi tab = một dòng `product_type_templates`), thêm ngôn ngữ tự có tab (R16.2); danh sách giao dịch hiển thị provider + USDT + rate (JOIN deposits) (R20.6); trang User cho đổi region (R5.4).

## Luồng tuần tự

### Onboarding (Bot)

```
User /start → handleStart → upsert user
  region NULL? ── yes ─▶ gửi inline [Việt Nam][Quốc tế] (default_language)
                          User bấm reg:vietnam ─▶ setRegion(vietnam) (language=vi nếu chưa lock)
                                                  ─▶ hiển thị menu chính
  region set? ── yes ─▶ hiển thị menu chính (bỏ qua onboarding)
```

### Nạp SePay (giữ nguyên)

```
dep:method:sepay → SePayProvider.createDeposit (VND, transfer_code, VietQR)
SePay webhook → idempotency(sepay_transaction_id) → match pending → TTL 15' guard
  → completeDeposit(provider='sepay') → notify theo language
  (deposit đã expired → bỏ qua cộng, R15.3)
```

### Nạp CryptoBot (USDT)

```
dep:method:cryptobot → nhập USDT (>= crypto_min_usdt, <= max_deposit/rate)
  → CryptoPayProvider.createDeposit → createInvoice(USDT) → lưu pending(crypto_invoice_id)
  → gửi nút pay_url

CryptoBot invoice_paid webhook → verify chữ ký
  → idempotency(crypto_invoice_id đã completed?) → bỏ qua
  → rate hợp lệ? ── no ─▶ markAwaitingCredit (giữ tiền) ─▶ cron credit-awaiting cộng sau
                  ── yes ▶ creditVnd=floor(paid_usdt×rate) ─▶ completeDeposit('cryptobot')
                            (kể cả khi deposit đã expired — vẫn cộng) ─▶ notify theo language
```

## Error Handling

- **createInvoice thất bại** → không tạo deposit pending, báo lỗi cho user theo ngôn ngữ (R10.4).
- **Chữ ký webhook sai** → 401, log lý do, không cộng tiền (R19.3, R19.4). Không bao giờ log/echo `CRYPTO_PAY_API_TOKEN` (R19.5).
- **Tỷ giá lỗi lúc nhận thanh toán** → `awaiting_credit`, không mất tiền, cộng lại khi rate hợp lệ (R12.4, R12.7).
- **Cộng tiền đua/đồng thời** → guard `status IN (pending|expired|awaiting_credit)` + `changes===0` đảm bảo đúng một lần (R14.4).
- **Atomic cộng tiền lỗi tạm thời sau khi thanh toán đã xác nhận** → webhook crypto trả `500` để Crypto Pay retry callback; webhook SePay log lỗi và dựa vào retry của SePay. Không đánh dấu deposit hoàn tất khi `db_error` để lần retry còn cộng được (R14.5). Lưới an toàn bổ sung: job `credit-awaiting` (cron) cũng quét và cộng lại cho deposit chưa hoàn tất hợp lệ.
- **Method sai vùng** → từ chối tạo deposit, báo "phương thức không khả dụng" (R8.4).
- **Thiếu dịch i18n** → hiển thị text/key thay vì vỡ giao diện (R17.5).

## Correctness Properties

Các bất biến phải luôn đúng (cơ sở cho test thuộc tính):

### Property 1: Cộng tiền đúng một lần

Với mỗi deposit, tổng VND cộng vào `users.balance` qua các lần xử lý webhook/cron luôn bằng đúng một lần `creditVnd`, bất kể số callback trùng hay đồng thời.

**Validates: Requirements 11.2, 14.4**

### Property 2: Số dư không âm

Sau mọi thao tác nạp, `users.balance >= 0` (CHECK DB + logic).

**Validates: Requirements 14.3**

### Property 3: Bảo toàn tiền đã trả

Một thanh toán USDT hợp lệ luôn dẫn tới đúng một lần cộng tiền — hoặc ngay (rate hợp lệ), hoặc sau (qua `awaiting_credit`) — không bao giờ bị bỏ rơi kể cả khi deposit đã `expired`.

**Validates: Requirements 11.4, 12.7**

### Property 4: Quy đổi xác định

`creditVnd = floor(paid_usdt × exchange_rate)`; sai khác giữa VND kỳ vọng lúc tạo invoice và VND thực cộng không vượt quá 1 đơn vị VND do làm tròn.

**Validates: Requirements 12.2, 12.6**

### Property 5: Phân tách provider/đơn vị

Deposit `sepay` luôn có `transfer_code` và đơn vị VND; deposit `cryptobot` luôn có `crypto_invoice_id`, `asset='USDT'` và đơn vị nhập USDT; không lẫn lộn.

**Validates: Requirements 7.7, 13.2**

### Property 6: Method hợp lệ theo vùng

Không deposit nào được tạo qua provider ngoài `methodsForRegion(region)` của user.

**Validates: Requirements 8.4**

### Property 7: Ngôn ngữ độc lập vùng

Khi `language_locked=1`, đổi `region` không làm thay đổi `language`.

**Validates: Requirements 6.4**

### Property 8: Mở rộng ngôn ngữ an toàn

Mọi đường dẫn hiển thị (bot/miniapp/cms/template) luôn trả nội dung cho bất kỳ `lang ∈ SUPPORTED_LANGUAGES` theo chuỗi fallback xác định (`lang → BASE_FALLBACK_LANG → key/text`), và không bao giờ ném lỗi do thiếu bản dịch; thêm một ngôn ngữ mới không yêu cầu đổi schema hay lõi xử lý.

**Validates: Requirements 4.3, 17.5**

## Testing Strategy

Theo stack hiện có (Vitest + fast-check). Tập trung:

- **Unit**: `resolveLang`/`setRegion`/`setLanguage` (gồm `language_locked` + chuỗi fallback + validate registry); quy đổi `floor(usdt×rate)`; chọn template theo lang + fallback; `methodsForRegion`.
- **i18n coverage**: test tự động kiểm tra mọi locale trong `SUPPORTED_LANGUAGES` có đủ key như locale gốc (phát hiện thiếu bản dịch khi thêm ngôn ngữ).
- **Property**: idempotency `completeDeposit` (cộng đúng 1 lần dù gọi lặp/đồng thời); số dư luôn `>= 0`; sai số làm tròn VND không vượt 1 đơn vị.
- **Webhook**: xác thực chữ ký Crypto Pay (case hợp lệ/giả mạo); paid-after-expired vẫn cộng; rate lỗi → awaiting_credit; trùng invoice → bỏ qua.
- **Migration**: kiểm tra rebuild `deposits` giữ nguyên dữ liệu cũ (provider='sepay'), unique từng phần hoạt động.
- **E2E** (`test/e2e_full_flow.sh` mở rộng): onboarding → chọn vùng → nạp theo provider tương ứng.

Quy tắc realtime: chạy test/build/e2e qua background process, log từng bước (theo steering).

## Requirements Traceability

| Requirement | Thành phần thiết kế |
|---|---|
| R1, R2 Onboarding | `handleStart`, `callbacks/region.ts`, `OnboardingView`, `POST /api/app/region` |
| R3 Lưu region/language | migration users.region/language, `user-locale.setRegion` |
| R4 Ngôn ngữ hiển thị | `resolveLang`, i18n bot/miniapp/cms |
| R5 Đổi vùng | `/region`, Mini App settings, CMS user, `setRegion` |
| R6 Đổi ngôn ngữ độc lập | `setLanguage` + `language_locked` |
| R7 Trừu tượng provider | `PaymentProvider`, registry, `DepositService.completeDeposit` |
| R8 Method theo vùng | `methodsForRegion`, `GET /deposit-methods`, enforce khi tạo |
| R9 SePay | `SePayProvider`, `routes/sepay.ts` (+ notify theo lang) |
| R10 Tạo invoice | `CryptoPayProvider`, `crypto-pay-client.createInvoice` |
| R11 Webhook crypto | `routes/cryptopay.ts` (+ paid-after-expired) |
| R12 Quy đổi & rate | `exchange_rate_usdt_vnd`, `floor(usdt×rate)`, awaiting_credit |
| R13 Hạn mức | `crypto_min_usdt` + `readDepositLimits` + `deposit-policy` |
| R14 Atomic/idempotent | `completeDeposit` batch + guard; R14.5 retry: webhook crypto trả 500 cho Crypto Pay retry + cron credit-awaiting |
| R15 Expiry | `deposit-expiry` (provider-agnostic) + R11 carve-out |
| R16 Template song ngữ | `product_type_templates` (bảng theo lang), `renderSuccessMessage` + catalog header |
| R17, R18 i18n Mini App/CMS | `vue-i18n` |
| R19 Bảo mật webhook | `cryptopay-auth`, secret `CRYPTO_PAY_API_TOKEN` |
| R20 Quản trị CMS | trang Settings + ProductType + transactions + user |
