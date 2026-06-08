# Design Document — PayOS Deposit + Provider-Agnostic Deposits Schema

## Overview

Tính năng gồm hai phần gắn liền:

- **Phần A — Tổng quát hoá schema `deposits`.** Migration `0014_*.sql` rebuild bảng `deposits` theo mô hình provider-agnostic: ba cột chung `correlation_ref` / `provider_txn_id` / `metadata`, bỏ các cột riêng (`transfer_code`, `sepay_transaction_id`, `bank_ref`, `crypto_invoice_id`, `asset`, `usdt_amount`, `exchange_rate`), cột `provider` đổi sang `TEXT` không CHECK. `completeDeposit`/`markAwaitingCredit` và mọi caller (webhook SePay/CryptoBot, credit-awaiting, các provider) chuyển sang cột chung.
- **Phần B — PayOS_Provider.** Thêm `payos` (đơn vị nhập VND, khả dụng cả Bot lẫn Mini App): tạo Payment_Link qua PayOS API, webhook xác nhận → cộng tiền NGAY qua `completeDeposit` dùng chung (không `awaiting_credit`, không tỷ giá). Cấu hình credentials DB-first, bật/tắt qua `payment_payos_enabled`, vùng `vietnam`.

Nguyên tắc xuyên suốt: Open/Closed — thêm provider mới = thêm một implement `PaymentProvider` + một route webhook + đăng ký vào registry, KHÔNG sửa logic cộng tiền dùng chung. Sau Phần A, mọi provider tương lai dùng lại cột chung nên **không cần migration DB nữa**.

Ngôn ngữ: TypeScript (Cloudflare Workers + Hono), D1 (SQLite), Vue 3 cho CMS. Tuân thủ AGENTS.md: không emoji do agent thêm; giữ tính atomic D1 `batch()` + concurrency guard; chỉ thêm file migration mới.

## Architecture

### Luồng tổng thể PayOS

```
User (Bot / Mini App)
  -> bot/callbacks/deposit.ts hoặc routes/miniapp-api.ts
     -> getProvider('payos') (registry, đã lọc enabled + region)
        -> payOsProvider.createDeposit(input)
           1. validate amount (số nguyên dương) + readDepositLimits + checkDepositPolicy
           2. sinh orderCode (unique, != deposits.id)
           3. INSERT deposits pending (provider='payos', correlation_ref=orderCode)
           4. payOsClient.createPaymentLink(...) — ký HMAC-SHA256(checksumKey)
           5. UPDATE provider_txn_id=paymentLinkId, metadata={checkoutUrl,qrCode}
           6. trả CreateDepositOutput.payos { checkoutUrl, qrCode, paymentLinkId, ... }
        (lỗi B4 -> dọn deposit mồ côi -> provider_error)

PayOS  --webhook-->  POST /webhook/payos (routes/payos.ts)
  1. đọc raw body, verify Webhook_Signature = HMAC-SHA256(checksumKey, sortObjDataByKey(data))
  2. lookup deposit theo correlation_ref == data.orderCode (provider='payos')
  3. completeDeposit(...) cộng VND đúng số trên deposit -> completed
  4. notify user (renderDepositSuccess) qua waitUntil
```

### So sánh chữ ký webhook giữa các provider (điểm khác biệt quan trọng)

| Provider | Cách ký webhook |
|----------|-----------------|
| CryptoBot | `HMAC-SHA256(secret = SHA256(token), rawBody)` so với header `crypto-pay-api-signature`. Ký trên **raw body**. |
| PayOS | `HMAC-SHA256(checksumKey, sortObjDataByKey(payload.data))` so với `payload.signature`. Ký trên **các trường `data` sắp xếp theo khoá**, KHÔNG phải raw body. |

Vì PayOS ký trên object `data` đã sort key (không phải raw body), PayOS dùng **route-level verification** trong `routes/payos.ts` (parse JSON trước rồi verify trường `data`), thay vì middleware kiểu CryptoBot. Lý do: phải parse body để lấy `data` + `signature` trước khi tính chữ ký.

### Các thành phần mới / sửa đổi

| File | Loại | Mục đích |
|------|------|----------|
| `migrations/0014_payments_provider_agnostic.sql` | mới | Rebuild `deposits` sang cột chung. |
| `src/types/db.ts` | sửa | `DbDeposit` cột chung + provider thêm `'payos'`. |
| `src/services/deposit-service.ts` | sửa | `completeDeposit`/`markAwaitingCredit` tổng quát hoá. |
| `src/services/credit-awaiting.ts` | sửa | Đọc `usdt_amount` qua `json_extract(metadata,...)`. |
| `src/routes/sepay.ts` | sửa | Map cũ→mới (idempotency theo `provider_txn_id`, lookup theo `correlation_ref`). |
| `src/routes/cryptopay.ts` | sửa | Lookup/đối soát qua cột chung. |
| `src/services/payments/types.ts` | sửa | `ProviderId += 'payos'`; nhánh `payos` trong `CreateDepositOutput`. |
| `src/services/payments/registry.ts` | sửa | `METHODS_BY_REGION.vietnam += 'payos'`; `payment_payos_enabled`. |
| `src/services/payments/register.ts` | sửa | Thêm `payOsProvider` vào `builtInProviders`. |
| `src/services/payments/payos-client.ts` | mới | `createPaymentLink` + ký HMAC + timeout. |
| `src/services/payments/payos-provider.ts` | mới | Implement `PaymentProvider` cho `payos`. |
| `src/services/payos-config.ts` | mới | Resolve 3 khoá DB-first → env. |
| `src/routes/payos.ts` | mới | Webhook handler verify + completeDeposit. |
| `src/types/bindings.ts` | sửa | Thêm `PAYOS_CLIENT_ID/PAYOS_API_KEY/PAYOS_CHECKSUM_KEY`. |
| `src/index.ts` | sửa | Mount `/webhook/payos`. |
| `cms/src/views/ConfigView.vue` + i18n | sửa | Card PayOS + toggle + nhãn vi/en. |
| `src/routes/admin/config.ts` | sửa | Thêm `payos_api_key`/`payos_checksum_key` vào `SECRET_CONFIG_KEYS` (mask GET, bỏ qua PUT rỗng). |
| `src/bot/callbacks/deposit.ts` | sửa | Gỡ guard cứng + dispatch nhánh `payos` (sub-flow VND) + nút inline `checkout_url`. |
| `src/bot/router.ts` | sửa | Dispatch session step `payos_amount` + preset callback PayOS tới handler PayOS (không rơi vào SePay). |
| `src/routes/admin/deposits.ts` | sửa | Call site `completeDeposit` đổi `sepayTransactionId`→`providerTxnId` (duyệt tay sepay). |
| `cms/src/views/DepositsView.vue` | sửa | Bỏ phụ thuộc cột cũ; đọc `correlation_ref`/`provider_txn_id`/`metadata`(JSON); provider thêm `payos`. |
| `src/routes/admin/payos.ts` (hoặc gộp admin) | mới | Route `POST /api/admin/payos/confirm-webhook` đăng ký webhook URL với PayOS. |
| `src/bot/i18n/catalogs/{vi,en}.ts` | sửa | Thêm `deposit.method.payos` + key lỗi/limit PayOS. |
| `src/routes/miniapp-api.ts` | sửa | `amountUnitByProvider.payos='vnd'`; nhánh `payos` trả `PayosDepositCreatedDto`. |
| `src/types/miniapp.ts` | sửa | `DepositMethodDto.id`/`DepositStatusDto.provider` thêm `payos`; thêm `PayosDepositCreatedDto`. |
| `miniapp/src/types/index.ts` | sửa | Mirror các DTO trên cho frontend. |
| `miniapp/src/views/DepositView.vue` | sửa | Bỏ giới hạn `Method` nhị phân; thêm nhánh PayOS (nhập VND, mở `checkout_url`, poll). |
| `miniapp/src/i18n/**` | sửa | Nhãn/mô tả PayOS (vi/en) cho Mini App. |

## Components and Interfaces

### Phần A.1 — Migration 0014 (rebuild `deposits`)

Theo đúng mẫu an toàn của `0008` (`PRAGMA foreign_keys=OFF` → tạo `deposits_new` → `INSERT...SELECT` → `DROP` → `RENAME` → tạo index → `PRAGMA foreign_keys=ON`). Không bảng nào có FK trỏ TỚI `deposits` (`transactions.reference_id` là tham chiếu đa hình, không phải FK thật) nên rebuild an toàn.

```sql
-- migrations/0014_payments_provider_agnostic.sql
-- =============================================
-- Provider-agnostic deposits
--   Rebuild deposits: bo cot rieng theo provider, dung 3 cot chung
--   correlation_ref / provider_txn_id / metadata. provider -> TEXT bo CHECK
--   (hop le hoa provider chuyen len tang ung dung qua registry).
--   Migrate du lieu that: sepay + cryptobot sang mo hinh moi khong mat mat.
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
```

Ghi chú:
- `json_object` của SQLite bỏ qua key có value NULL khi build? Không — `json_object('k', NULL)` tạo `{"k":null}`. Với cryptobot các cột thường có giá trị; nếu cần loại key NULL có thể dùng `CASE`, nhưng giữ JSON đơn giản là chấp nhận được vì caller đọc bằng `json_extract` trả NULL.
- `provider DEFAULT 'sepay'` giữ tương thích insert cũ; mọi provider mới luôn set `provider` tường minh.
- `INSERT...SELECT` tách hai câu theo provider để map đúng nguồn; các provider khác (nếu có dữ liệu lạ) sẽ không được migrate — hiện chỉ tồn tại `sepay`/`cryptobot`.

### Phần A.2 — `DbDeposit` mới (`src/types/db.ts`)

```ts
export interface DbDeposit {
  id: number
  user_id: number
  provider: 'sepay' | 'cryptobot' | 'payos'
  amount: number
  status: 'pending' | 'completed' | 'expired' | 'cancelled' | 'awaiting_credit'
  correlation_ref: string | null   // transfer_code (sepay) / orderCode (payos) / invoice_id (cryptobot)
  provider_txn_id: string | null    // sepay_transaction_id / paymentLinkId / invoice_id — idempotency
  metadata: string | null           // JSON đặc thù provider
  completed_at: string | null
  expired_at: string | null
  created_at: string
}
```

Loại bỏ hoàn toàn `transfer_code`, `sepay_transaction_id`, `bank_ref`, `crypto_invoice_id`, `asset`, `usdt_amount`, `exchange_rate`.

### Phần A.3 — `deposit-service.ts` tổng quát hoá

Chữ ký mới truyền dữ liệu provider qua cột chung; service tự `JSON.stringify` metadata:

```ts
export interface CompleteDepositInput {
  db: D1Database
  depositId: number
  userId: number
  creditVnd: number
  provider: ProviderId
  /** Định danh giao dịch phía provider → cột chung provider_txn_id (idempotency). */
  providerTxnId?: string
  /** Mã đối soát nội bộ → cột chung correlation_ref (chỉ set khi cần cập nhật). */
  correlationRef?: string
  /** Dữ liệu đặc thù provider → cột chung metadata. Service tự JSON.stringify. */
  metadata?: Record<string, unknown>
}
```

`completeDeposit` cập nhật `deposits` qua một câu UPDATE chung (không còn rẽ nhánh theo provider):

```ts
const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null
const depositUpdate = db.prepare(
  `UPDATE deposits
     SET status = 'completed', completed_at = ?, amount = ?,
         provider_txn_id = COALESCE(?, provider_txn_id),
         correlation_ref = COALESCE(?, correlation_ref),
         metadata        = COALESCE(?, metadata)
   WHERE id = ? AND status IN ('pending','expired','awaiting_credit')`
).bind(now, creditVnd, providerTxnId ?? null, correlationRef ?? null, metadataJson, depositId)
```

GIỮ NGUYÊN: D1 `batch()` nguyên tử; tăng balance bằng `balance = balance + ?` có guard `EXISTS (... status IN ('pending','expired','awaiting_credit'))`; `INSERT ... SELECT ... WHERE EXISTS` cho transaction; kiểm `results[last].meta.changes === 0 → already_processed`; batch ném lỗi → `db_error` (cho retry). `COALESCE` đảm bảo không xoá giá trị cột chung đã có khi caller không truyền.

`markAwaitingCredit` tổng quát hoá metadata:

```ts
export async function markAwaitingCredit(
  db: D1Database,
  depositId: number,
  metadata: Record<string, unknown>   // ví dụ { usdt_amount }
): Promise<void> {
  await db.prepare(
    `UPDATE deposits SET status = 'awaiting_credit', metadata = COALESCE(?, metadata)
     WHERE id = ? AND status IN ('pending','expired')`
  ).bind(JSON.stringify(metadata), depositId).run()
}
```

### Phần A.4 — Cập nhật caller

**`routes/sepay.ts`** (map cũ→mới):
- Idempotency: `SELECT id FROM deposits WHERE provider='sepay' AND provider_txn_id = ?` (bind `String(payload.id)`).
- Lookup pending: `SELECT *, age_sec FROM deposits WHERE provider='sepay' AND correlation_ref = ? AND status='pending'`.
- `completeDeposit({ ..., provider:'sepay', providerTxnId: String(payload.id), metadata: payload.referenceCode ? { bank_ref: payload.referenceCode } : undefined })`.
- Giữ TTL guard, range guard, 500 khi `db_error`, 200 cho mọi no-op.

**`routes/cryptopay.ts`**:
- Lookup: `SELECT id,user_id,status,metadata FROM deposits WHERE provider='cryptobot' AND provider_txn_id = ?` (invoice id).
- USDT lấy từ payload webhook (`paid_amount`/`amount`) như cũ; khi cần đọc lại từ deposit dùng `json_extract(metadata,'$.usdt_amount')`.
- `markAwaitingCredit(db, id, { usdt_amount: usdtAmountStr })`.
- `completeDeposit({ ..., provider:'cryptobot', providerTxnId: invoiceId, correlationRef: invoiceId, metadata: { asset:'USDT', usdt_amount: usdtAmountStr, exchange_rate: rate } })`.

**`credit-awaiting.ts`**: SELECT đọc `json_extract(metadata,'$.usdt_amount') AS usdt_amount` và `provider_txn_id AS crypto_invoice_id`; phần còn lại giữ nguyên (gọi `completeDeposit` với `metadata` đầy đủ).

**`sepay-provider.ts`** / **`cryptopay-provider.ts`**: INSERT pending dùng cột chung:
- SePay: `INSERT INTO deposits (user_id, provider, correlation_ref, amount, status, created_at) VALUES (?, 'sepay', ?, ?, 'pending', ?)` (correlation_ref = transferCode).
- CryptoBot: `INSERT ... (user_id, provider, amount, status, metadata, created_at) VALUES (?, 'cryptobot', ?, 'pending', ?, ?)` với `metadata = JSON.stringify({ asset:'USDT', usdt_amount })`; sau `createInvoice` → `UPDATE deposits SET provider_txn_id=?, correlation_ref=? WHERE id=? AND status='pending'`; dọn mồ côi `DELETE ... WHERE id=? AND status='pending' AND provider_txn_id IS NULL`.

### Phần B.1 — `types.ts`

```ts
export type ProviderId = 'sepay' | 'cryptobot' | 'payos'

/** Dữ liệu hiển thị cho nhánh nạp PayOS (PayOS_Provider). */
export interface PayOsDepositData {
  /** URL trang thanh toán PayOS để mở cho user. */
  checkoutUrl: string
  /** Chuỗi QR (EMV) PayOS trả về — render QR tại client nếu cần. */
  qrCode: string
  /** paymentLinkId PayOS cấp (đã lưu vào provider_txn_id). */
  paymentLinkId: string
  /** Số VND cần thanh toán. */
  amountVnd: number
  /** orderCode đã sinh (đã lưu vào correlation_ref). */
  orderCode: number
}

export interface CreateDepositOutput {
  depositId: number
  vietqr?: VietQrDepositData
  crypto?: CryptoDepositData
  payos?: PayOsDepositData   // mới
}
```

### Phần B.2 — `payos-client.ts`

Tầng HTTP thuần tới PayOS, đối xứng `crypto-pay-client.ts` (fail-fast, không log secret).

```ts
const PAYOS_CREATE_PAYMENT_URL = 'https://api-merchant.payos.vn/v2/payment-requests'
const PAYOS_TIMEOUT_MS = 30_000

export interface CreatePaymentLinkParams {
  clientId: string
  apiKey: string
  checksumKey: string
  orderCode: number
  amount: number            // VND, số nguyên dương
  description: string       // PayOS giới hạn <= 9 ký tự (lưu ý dưới)
  returnUrl: string
  cancelUrl: string
}

export interface CreatePaymentLinkResult {
  checkoutUrl: string
  qrCode: string
  paymentLinkId: string
}

export class PayOsApiError extends Error {
  readonly httpStatus?: number
  readonly apiCode?: string
  constructor(message: string, options?: { httpStatus?: number; apiCode?: string }) { ... }
}
```

Thuật toán ký request (theo chuẩn PayOS `createPaymentLink`):
1. Lấy đúng các trường tham gia ký: `amount`, `cancelUrl`, `description`, `orderCode`, `returnUrl`.
2. Sắp xếp theo **thứ tự alphabet của khoá** rồi nối thành `amount=...&cancelUrl=...&description=...&orderCode=...&returnUrl=...`.
3. `signature = HMAC_SHA256(checksumKey, chuỗi trên)` ở dạng hex (Web Crypto `crypto.subtle`).
4. Body gửi: `{ orderCode, amount, description, returnUrl, cancelUrl, signature }`.

Request:
- `POST` JSON tới `PAYOS_CREATE_PAYMENT_URL`, headers `x-client-id: clientId`, `x-api-key: apiKey`, `Content-Type: application/json`.
- Timeout 30s qua `AbortController` (`setTimeout(() => controller.abort(), PAYOS_TIMEOUT_MS)`, clear trong `finally`).
- Thành công: PayOS trả `{ code: '00', data: { checkoutUrl, qrCode, paymentLinkId, ... } }` → trả `{ checkoutUrl, qrCode, paymentLinkId }`.
- Fail-fast → ném `PayOsApiError` (KHÔNG trả link) khi: HTTP không 2xx; `code !== '00'`; thiếu `data.checkoutUrl`/`paymentLinkId`; abort (timeout); lỗi mạng.
- Thông điệp lỗi KHÔNG chứa `apiKey`/`checksumKey` (chỉ dùng `code`/`httpStatus`).

### Phần B.3 — `payos-provider.ts`

Implement `PaymentProvider`, `id='payos'`, `amountUnit='vnd'`. `createDeposit`:

1. Validate `Number.isInteger(rawAmount) && rawAmount > 0`; nếu sai → `{ type:'limit', message: t(lang,'deposit.limit.vnd_invalid') }`, KHÔNG tạo deposit (R8.5).
2. `readDepositLimits(db)` → ngoài `[min,max]` → `{ type:'limit', message: t(lang,'deposit.limit.vnd_range', {min,max}) }` (R9.1, R9.2).
3. `checkDepositPolicy(db, userId)` → bị chặn → `{ type:'policy', reason, retryAfterMs }` (R9.3, R9.4).
4. Sinh `orderCode` duy nhất, khác `deposits.id`: ví dụ `Date.now() * 1000 + randomInt(0,999)` (số nguyên an toàn, theo timestamp+random). Vì có partial unique index `(provider, correlation_ref)`, nếu trùng (cực hiếm) INSERT sẽ lỗi → thử lại tối đa N lần.
5. INSERT pending: `INSERT INTO deposits (user_id, provider, correlation_ref, amount, status, created_at) VALUES (?, 'payos', ?, ?, 'pending', ?) RETURNING id` (correlation_ref = orderCode).
6. Return_Url/Cancel_Url (quyết định A): đọc `system_config.miniapp_url` qua `readMiniAppUrl(db)` và dùng CHUNG cho cả `returnUrl` lẫn `cancelUrl`, KHÔNG phụ thuộc `channel`. Nếu `miniapp_url` rỗng/null → trả lỗi cấu hình (`provider_error` localized), KHÔNG tạo deposit (R8.5). Lý do: hệ thống không có `bot_username`/deep-link; `miniapp_url` là URL hợp lệ sẵn có cho mọi kênh.
7. `resolvePayOsConfig(db, env)` → `payOsClient.createPaymentLink(...)`.
8. Thành công → `UPDATE deposits SET provider_txn_id = ?, metadata = ? WHERE id = ? AND status='pending'` với `metadata = JSON.stringify({ checkoutUrl, qrCode })`; trả `output.payos`.
9. Lỗi `createPaymentLink` → dọn mồ côi: `DELETE FROM deposits WHERE id = ? AND status='pending' AND provider_txn_id IS NULL` (R14.1, R14.2); log chi tiết nội bộ (`console.error`, không hiển thị user); trả `{ type:'provider_error', message: t(lang,'deposit.error.payos_failed') }` chung chung (R14.3, R14.4).

`description` PayOS ≤ 9 ký tự: dùng chuỗi ngắn cố định an toàn (ví dụ `"NAP"` + phần ngắn) — **lưu ý thiết kế**: PayOS giới hạn `description` rất ngắn (tối đa 9 ký tự ở `createPaymentLink`), nên KHÔNG nhồi orderCode dài vào description; orderCode đi qua trường `orderCode` riêng. Chọn description tĩnh hợp lệ (vd `"Nap tien"` = 8 ký tự ASCII, không emoji).

### Phần B.4 — `payos-config.ts`

Mẫu `cryptopay-config.ts`, ba khoá DB-first → env qua `preferDbValue`:

```ts
export const PAYOS_CLIENT_ID_CONFIG = 'payos_client_id'
export const PAYOS_API_KEY_CONFIG = 'payos_api_key'
export const PAYOS_CHECKSUM_KEY_CONFIG = 'payos_checksum_key'

export interface PayOsConfig { clientId: string; apiKey: string; checksumKey: string }

export async function resolvePayOsConfig(db: D1Database, env: Bindings): Promise<PayOsConfig> {
  const map = await readSystemConfigMap(db, [
    PAYOS_CLIENT_ID_CONFIG, PAYOS_API_KEY_CONFIG, PAYOS_CHECKSUM_KEY_CONFIG,
  ])
  return {
    clientId:    preferDbValue(map.get(PAYOS_CLIENT_ID_CONFIG),    env.PAYOS_CLIENT_ID),
    apiKey:      preferDbValue(map.get(PAYOS_API_KEY_CONFIG),      env.PAYOS_API_KEY),
    checksumKey: preferDbValue(map.get(PAYOS_CHECKSUM_KEY_CONFIG), env.PAYOS_CHECKSUM_KEY),
  }
}
```

`preferDbValue` đã có: chỉ ưu tiên DB khi non-empty sau trim, ngược lại dùng env (R6.1–R6.3). Không log giá trị `apiKey`/`checksumKey` (R6.4).

### Phần B.5 — `bindings.ts`

Thêm vào `Bindings`:
```ts
PAYOS_CLIENT_ID: string
PAYOS_API_KEY: string
PAYOS_CHECKSUM_KEY: string
```
Cập nhật `.dev.vars.example` (placeholder, không giá trị thật).

### Phần B.6 — Webhook handler `routes/payos.ts`

Mirror `routes/sepay.ts` về quy ước mã trạng thái (500 cho `db_error`, 200 cho mọi no-op). Verify chữ ký kiểu PayOS (khác CryptoBot):

```ts
const payOsWebhook = new Hono<AppEnv>()
payOsWebhook.post('/payos', async (c) => {
  const db = c.env.DB
  let body: PayOsWebhookBody
  try { body = await c.req.json() } catch { return c.json({ success: true }) }

  // 1) Verify signature: HMAC-SHA256(checksumKey, sortObjDataByKey(body.data)) == body.signature
  const { checksumKey } = await resolvePayOsConfig(db, c.env)
  if (!checksumKey || !body?.data || !body?.signature) return c.json({ success: false }, 401)
  const expected = await signPayOsData(body.data, checksumKey)   // hex
  if (!timingSafeEqualHex(expected, body.signature)) return c.json({ success: false }, 401)

  // 2) Chỉ xử lý sự kiện thanh toán thành công (code==='00' / data.code==='00')
  if (!isSuccessfulPayment(body)) return c.json({ success: true })  // no-op (R12.7)

  // 3) Lookup deposit theo correlation_ref == orderCode (provider='payos')
  const orderCode = String(body.data.orderCode)
  const deposit = await db.prepare(
    `SELECT id, user_id, status, amount FROM deposits
     WHERE provider='payos' AND correlation_ref = ?`
  ).bind(orderCode).first<...>()
  if (!deposit) return c.json({ success: true })                   // không khớp (R12.7)
  if (deposit.status === 'completed') return c.json({ success: true }) // idempotent (R12.6)

  // 4) Cộng tiền NGAY (không tỷ giá, không awaiting_credit) — VND đúng trên deposit (R13.2/R13.3)
  const result = await completeDeposit({
    db, depositId: deposit.id, userId: deposit.user_id,
    creditVnd: deposit.amount, provider: 'payos',
    providerTxnId: body.data.paymentLinkId ? String(body.data.paymentLinkId) : undefined, // KHÔNG truyền '' — COALESCE sẽ ghi đè provider_txn_id thật đã set lúc tạo → phá idempotency
    metadata: { payos_status: body.data.code },
  })
  if (!result.success && result.error === 'db_error') return c.json({ success:false }, 500) // (R12.8)
  if (!result.success) return c.json({ success: true })            // already_processed/not_found
  // 5) notify user theo lang qua renderDepositSuccess (waitUntil) — R15.2/R15.4
  ...
  return c.json({ success: true })
})
```

Thuật toán `sortObjDataByKey` + ký (route-level, dùng Web Crypto):
1. `sortObjDataByKey(data)`: lấy `Object.keys(data).sort()` (alphabet), với mỗi key build `key=value` (value: object/array → `JSON.stringify`; `null`/`undefined` → chuỗi rỗng; còn lại → `String(value)`), nối bằng `&`.
2. `signPayOsData = HMAC_SHA256(checksumKey, sortedStr)` → hex.
3. So sánh hằng-thời-gian với `body.signature` (tái dùng `timingSafeEqualHex` + `toHex` — tách thành util dùng chung giữa `cryptopay-auth` và `payos`; hiện cả hai private trong `cryptopay-auth.ts`).

Verify trước xử lý nghiệp vụ; sai chữ ký hoặc thiếu `checksumKey` → 401, KHÔNG cộng tiền, giữ nguyên số dư (R12.2, R12.3). Idempotency cuối cùng dựa trên guard trạng thái trong `completeDeposit` + partial unique `(provider, provider_txn_id)` (R12.9, R13.1, R13.4).

### Phần B.7 — registry + register

`registry.ts`:
```ts
const METHODS_BY_REGION: Record<Region, readonly ProviderId[]> = {
  vietnam: ['sepay', 'payos', 'cryptobot'],   // thứ tự hiển thị: sepay, payos, cryptobot
  international: ['cryptobot'],
}
```
`payos` KHÔNG nằm trong `ALWAYS_ENABLED_PROVIDERS` → mặc định tắt; `isProviderEnabled('payos')` đọc `payment_payos_enabled` (chuẩn hoá trim+lowercase, true khi `'1'`/`'true'`) — `providerEnabledConfigKey('payos') === 'payment_payos_enabled'` (R10.1–R10.6). `enabledMethodsForRegion` tự lọc theo cờ nên payos chỉ xuất hiện khi region cho phép VÀ cờ bật (R11.3).

`register.ts`: `builtInProviders = [sePayProvider, cryptoPayProvider, payOsProvider]`.

### Phần B.8 — Caller (Bot / Mini App) xử lý nhánh `payos`

`CreateDepositOutput.payos` → gửi cho user nút mở `checkoutUrl` (Bot: inline button URL; Mini App: trả `checkout_url` để client mở). Validate enabled+region trước khi gọi (R10.5: nếu disabled → thông báo không khả dụng, không tạo deposit). Nhập số VND giống flow SePay (mệnh giá/tuỳ ý).

### Phần B.10 — DTO Mini App hỗ trợ PayOS (`src/types/miniapp.ts` + `miniapp/src/types/index.ts`)

Hiện `DepositMethodDto.id` và `DepositStatusDto.provider` là union cứng `'sepay' | 'cryptobot'`. Cập nhật ở CẢ HAI file (backend + mirror frontend):

```ts
export interface DepositMethodDto { id: 'sepay' | 'cryptobot' | 'payos'; amount_unit: 'vnd' | 'usdt' }

export interface DepositStatusDto {
  deposit_id: number
  provider: 'sepay' | 'cryptobot' | 'payos'
  status: 'pending' | 'completed' | 'expired' | 'cancelled' | 'awaiting_credit'
  amount: number
  new_balance?: number
  new_balance_display?: string
}

/** POST /api/app/deposits (method=payos) — link thanh toán PayOS vừa tạo. */
export interface PayosDepositCreatedDto {
  deposit_id: number
  method: 'payos'
  checkout_url: string
  amount: number
  amount_display: string
  status: 'pending'
}
```

`src/routes/miniapp-api.ts`:
- `amountUnitByProvider: Record<ProviderId, 'vnd' | 'usdt'> = { sepay:'vnd', cryptobot:'usdt', payos:'vnd' }` (bắt buộc — nếu thiếu sẽ lỗi kiểu khi `ProviderId` có `payos`).
- POST `/deposits`: nới `method` để nhận `'payos'`; `provider = getProvider(method)` (hoặc map payos→payOsProvider); nhánh `payos` đọc `result.output.payos` → trả `PayosDepositCreatedDto`.
- Giữ nguyên `isMethodAllowedForRegion` + `isProviderEnabled` guard (đã provider-agnostic).

### Phần B.11 — Mini App `DepositView.vue` + i18n

`miniapp/src/views/DepositView.vue` hiện hard-code nhị phân:
- `type Method = 'sepay' | 'cryptobot'` → đổi thành `'sepay' | 'cryptobot' | 'payos'`.
- `methodOptions` label binary (`m.id === 'sepay' ? sepay : cryptobot`) → map theo từng id (sepay/cryptobot/payos) qua i18n.
- `isCrypto` giữ nguyên (chỉ true cho cryptobot); PayOS coi như nhánh VND: dùng lại grid mệnh giá + validate số nguyên (điều kiện `!isCrypto` đã đúng cho payos).
- card 1-phương-thức + icon: thay biểu thức nhị phân bằng map theo id (icon `Landmark`/`CircleDollarSign`/icon PayOS).
- `submitDeposit`: tách nhánh theo `selectedMethod` — `payos` → `post<PayosDepositCreatedDto>('/deposits', { method:'payos', amount })`, set `createdPayos`, `openLink(res.checkout_url)`, `startPolling()`.
- thêm ref `createdPayos`, đưa vào `created` computed; render khối "đang chờ" + nút "Mở thanh toán" mở lại `checkout_url`.
- SegmentedControl cast `$event as Method` (bỏ cast cứng `'sepay'|'cryptobot'`).

i18n Mini App (`miniapp/src/i18n/**`): thêm `deposit.method_payos_short`, `deposit.method_payos`, `deposit.method_payos_desc`, `deposit.pay_payos` (vi/en).

### Phần B.12 — Bot deposit flow (`src/bot/callbacks/deposit.ts` + `router.ts` + i18n)

- `handleDepositMethod` guard hiện: `(method !== 'sepay' && method !== 'cryptobot') || !isMethodAllowedForRegion(...)`. Đổi sang validate theo registry: chấp nhận mọi `ProviderId` hợp lệ (`getProvider(method) !== undefined`) rồi mới `isMethodAllowedForRegion` + `isProviderEnabled`; bỏ allowlist cứng.
- `startDepositMethod` dispatch hiện nhị phân (`cryptobot` → crypto, else sepay). Thêm nhánh `payos` → `startPayOsDeposit`.
- **QUAN TRỌNG — session step (gap đã phát hiện):** SePay dùng step `'amount'` và `handleDepositAmount` **gắn cứng `sePayProvider`**; CryptoBot dùng step riêng `'crypto_amount'` + `handleCryptoDepositAmount`. PayOS PHẢI theo mẫu CryptoBot: thêm step riêng `'payos_amount'` + handler `handlePayOsDepositAmount` gọi `payOsProvider.createDeposit({channel:'bot'})`. KHÔNG reuse step `'amount'` (sẽ tạo deposit SePay).
- `src/bot/router.ts`: trong `handleSessionInput` thêm nhánh `step === 'payos_amount'` → `handlePayOsDepositAmount`; nếu PayOS dùng grid mệnh giá thì preset callback phải khác `dep:{amount}` (đang route về SePay) — vd `dep:payos:{amount}` route tới handler PayOS. Đơn giản nhất: PayOS nhập số qua text (như CryptoBot) để tránh đụng callback `dep:{amount}`.
- Khi tạo Payment_Link thành công → gửi inline button mở `checkout_url`.
- i18n bot (`src/bot/i18n/catalogs/{vi,en}.ts`): thêm `deposit.method.payos` (nhãn menu) + key lỗi `deposit.limit.vnd_invalid`/`deposit.error.payos_failed`.

### Phần B.14 — Caller còn lại của schema cũ (admin + CMS)

- `src/routes/admin/deposits.ts` (`POST /deposits/:id/approve`): đổi `completeDeposit({ ..., sepayTransactionId: 'manual-approve' })` → `providerTxnId: \`manual-${depositId}\`` theo chữ ký mới. **QUAN TRỌNG:** KHÔNG dùng hằng số `'manual-approve'` — index mới `(provider, provider_txn_id)` là UNIQUE nên hằng số trùng sẽ vỡ ở lần duyệt tay thứ 2 (trong 0008 `idx_deposits_sepay_tx` vốn NON-unique nên hằng số cũ không sao). Dùng `manual-${depositId}` đảm bảo duy nhất. Giữ guard duyệt tay chỉ `sepay`. (Phần A — nếu không sửa sẽ vỡ biên dịch Worker + vỡ unique khi duyệt tay.)
- `cms/src/views/DepositsView.vue`: interface + template hiện hardcode `transfer_code`/`sepay_transaction_id`/`bank_ref`/`crypto_invoice_id`/`asset`/`usdt_amount`/`exchange_rate`. Đổi sang đọc `correlation_ref` (mã đối soát), `provider_txn_id` (mã giao dịch provider), và parse `metadata` (JSON) cho asset/usdt_amount/exchange_rate/bank_ref; provider union thêm `'payos'` + nhãn `providerLabel('payos')`. (Phần A cho phần schema; nhãn payos thuộc Phần B.)

### Phần B.15 — PayOS không cho huỷ (R23)

Lý do: `completeDeposit` guard cộng từ `pending`/`expired`/`awaiting_credit` nhưng KHÔNG từ `cancelled`. Nếu user huỷ rồi vẫn trả trên trang PayOS → webhook tới khi deposit `cancelled` → không cộng → mất tiền. Giải pháp KHÔNG đụng guard money:
- Backend: `POST /api/app/deposits/:id/cancel` và bot `handleDepositCancel` — khi deposit `provider==='payos'` → KHÔNG set `cancelled` (trả lỗi/no-op, giữ pending). Deposit PayOS chỉ rời `pending` qua TTL → `expired` (cron), mà `expired` vẫn cộng được khi thanh toán tới sau.
- UI: Mini App `DepositView` + bot ẩn nút Huỷ khi phương thức/deposit là `payos`.

### Phần B.16 — Đăng ký webhook với PayOS (R24)

- `payos-client.ts` thêm `confirmWebhook({clientId, apiKey, webhookUrl})` → `POST https://api-merchant.payos.vn/confirm-webhook` body `{ webhookUrl }`, headers `x-client-id`/`x-api-key`; PayOS gửi ping thử + trả 200 nếu URL hợp lệ. Fail-fast `PayOsApiError`, không lộ secret.
- Route admin `POST /api/admin/payos/confirm-webhook` (JWT): dựng `webhookUrl = ${origin}/webhook/payos`, resolve config, gọi `confirmWebhook`, trả kết quả.
- CMS card PayOS: nút "Đăng ký webhook" gọi route trên; hiển thị thành công/lỗi.
- Webhook_Handler đã xử lý ping thử: orderCode không khớp deposit → 200 no-op (R24.4).

### Phần B.13 — Mask secret PayOS (`src/routes/admin/config.ts`)

- `SECRET_CONFIG_KEYS` thêm `'payos_api_key'`, `'payos_checksum_key'` → GET mask thành rỗng + báo `secrets_set`; PUT bỏ qua khi giá trị rỗng (không xoá secret).
- `payos_client_id` KHÔNG phải secret → để như config thường; có thể thêm vào `envFallback` (đọc `c.env.PAYOS_CLIENT_ID`) để CMS hiển thị giá trị hiệu lực, và `secretEnv` cho 2 secret để cờ `secrets_set` phản ánh cả khi chỉ đặt qua `wrangler secret`.

### Phần B.9 — CMS (`ConfigView.vue` + i18n)

- Thêm vào `form`: `payos_client_id`, `payos_api_key`, `payos_checksum_key`, `payment_payos_enabled` ('0' mặc định).
- Card "PayOS" mới: ba input (api_key/checksum_key dạng password có toggle hiện/ẩn), một công tắc bật/tắt ghi `payment_payos_enabled`, hiển thị `payosWebhookUrl = ${origin}/webhook/payos`.
- Lưu vào `system_config` qua API admin hiện có (đảm bảo backend whitelist 4 key mới).
- Nhãn/text theo i18n CMS (`cms/src/i18n/messages/vi.json` + `en.json`): thêm nhóm khoá `config.payos.*`.
- Lưu ý hiển thị: nhắc Admin description PayOS ≤ 9 ký tự (chỉ là ghi chú nếu CMS cho sửa description; mặc định description tĩnh trong code).

### Bản địa hoá (i18n bot/notify)

Thêm key mới vào catalog bot i18n (`src/bot/i18n`) cho vi/en:
- `deposit.limit.vnd_invalid` — số tiền không hợp lệ (R8.5).
- `deposit.error.payos_failed` — lỗi tạo liên kết PayOS chung chung (R14.3).
- (Tái dùng `deposit.limit.vnd_range`, `deposit.success.*` đã có.)

Thông báo thành công PayOS tái dùng `renderDepositSuccess(currencyCtx, amountVnd, newBalance)` — đồng nhất SePay/CryptoBot. Fallback lang theo `resolveLang` hiện hữu (`user.language` → `default_language` config → `BASE_FALLBACK_LANG`='en'; admin đặt `default_language='vi'` cho shop VN) khi Language thiếu/không hợp lệ (R15.3). Notify gửi qua `waitUntil`; lỗi gửi không hoàn tác số dư (R15.4).

## Data Models

### Deposits (sau 0014)

| Cột | Kiểu | Ghi chú |
|-----|------|---------|
| id | INTEGER PK | |
| user_id | INTEGER FK users(id) | |
| provider | TEXT (no CHECK) | `'sepay' \| 'cryptobot' \| 'payos'` (hợp lệ hoá ở tầng app) |
| amount | INTEGER >0 | VND kỳ vọng/đã cộng |
| status | TEXT CHECK | pending/completed/expired/cancelled/awaiting_credit |
| correlation_ref | TEXT null | transfer_code / orderCode / invoice_id |
| provider_txn_id | TEXT null | sepay_transaction_id / paymentLinkId / invoice_id — idempotency |
| metadata | TEXT null | JSON đặc thù provider |
| completed_at / expired_at / created_at | TEXT | ISO timestamps |

Index: `UNIQUE(provider, correlation_ref) WHERE correlation_ref IS NOT NULL`; `UNIQUE(provider, provider_txn_id) WHERE provider_txn_id IS NOT NULL`; `(user_id, status)`; `(status, created_at)`.

### Metadata theo provider

| Provider | metadata JSON |
|----------|---------------|
| sepay | `{ "bank_ref": "..." }` (khi có) |
| cryptobot | `{ "asset":"USDT", "usdt_amount":"...", "exchange_rate":<num> }` |
| payos | `{ "checkoutUrl":"...", "qrCode":"..." }` lúc tạo; `{ "payos_status":"00" }` có thể bổ sung lúc completeDeposit |

### system_config keys mới

`payos_client_id`, `payos_api_key`, `payos_checksum_key`, `payment_payos_enabled`.

## Error Handling

- **PayOS client**: mọi lỗi → `PayOsApiError`, thông điệp không chứa secret; timeout 30s qua AbortController.
- **createDeposit**: lỗi link → dọn deposit mồ côi (guarded DELETE) → `provider_error` chung; log chi tiết nội bộ riêng.
- **Webhook**: sai/thiếu chữ ký → 401, không cộng tiền; `db_error` sau xác nhận → 500 để PayOS retry; no-op (không khớp/đã completed/không phải success) → 200.
- **Idempotency**: guard trạng thái trong `completeDeposit` (`changes===0 → already_processed`) + partial unique `(provider, provider_txn_id)` đảm bảo cộng đúng một lần dù callback lặp/đồng thời.
- **Notify**: fire-and-forget; lỗi gửi không ảnh hưởng số dư đã cộng.

## Testing Strategy

Dual approach: property tests (≥100 iterations, fast-check) cho logic phổ quát; example/edge tests cho UI/wiring/error message; smoke cho cấu trúc migration và type/build.

Mỗi property test gắn tag: `Feature: payos-deposit, Property {n}: {text}`.

### Test cần cập nhật schema `deposits` (tự khai schema)

- `test/integration.test.ts`
- `test/sepay-webhook.property.test.ts`
- `test/deposit-service.property.test.ts`
- `test/miniapp-deposit-range.property.test.ts`
- `test/miniapp-deposit-notify.property.test.ts`

→ Mọi `CREATE TABLE deposits (...)` / INSERT trong test phải đổi sang cột chung (`correlation_ref`, `provider_txn_id`, `metadata`) và bỏ cột riêng.

### Test mới

- `test/payos-client.property.test.ts` — ký HMAC, success/failure, timeout (mock fetch).
- `test/payos-provider.property.test.ts` — tạo deposit, orderCode unique, dọn mồ côi, limit/policy.
- `test/payos-webhook.property.test.ts` — verify chữ ký, cộng tiền idempotent theo paymentLinkId, db_error→500, no-op→200.
- `test/payos-config.property.test.ts` — DB-first→env cho 3 khoá.
- Migration smoke: áp `0014` lên DB seed, assert schema + dữ liệu migrate.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — a formal statement bridging human-readable specs and machine-verifiable correctness.*

### Property 1: Migration preserves common columns

For all pre-existing deposit rows, after applying migration 0014 each row retains identical `id`, `user_id`, `provider`, `amount`, `status`, `completed_at`, `expired_at`, `created_at`.

**Validates: Requirements 2.1**

### Property 2: SePay column mapping is faithful

For any legacy `sepay` deposit row, after migration `correlation_ref` equals the old `transfer_code` and `provider_txn_id` equals the old `sepay_transaction_id`, with NULL sources producing NULL destinations.

**Validates: Requirements 2.2, 2.6**

### Property 3: SePay bank_ref preserved in metadata

For any legacy `sepay` deposit row with a non-null `bank_ref`, after migration `json_extract(metadata,'$.bank_ref')` equals the old `bank_ref`.

**Validates: Requirements 2.3**

### Property 4: CryptoBot column mapping is faithful

For any legacy `cryptobot` deposit row, after migration both `correlation_ref` and `provider_txn_id` equal the old `crypto_invoice_id`, and `metadata` carries `asset`, `usdt_amount`, `exchange_rate` matching the old columns.

**Validates: Requirements 2.4, 2.5, 2.6**

### Property 5: completeDeposit credits exactly once

For any deposit and any number of repeated or concurrent `completeDeposit` calls referencing it, the user balance increases by `creditVnd` exactly once and exactly one matching `deposit` transaction is recorded.

**Validates: Requirements 4.2, 12.9, 13.4**

### Property 6: completeDeposit persists provider fields via common columns

For any `completeDeposit` call with `providerTxnId`/`metadata`, the resulting completed deposit row stores those values in `provider_txn_id`/`metadata` and the status becomes `completed`.

**Validates: Requirements 4.1**

### Property 7: markAwaitingCredit only affects creditable deposits

For any deposit, `markAwaitingCredit` stores the metadata and sets `awaiting_credit` only when the deposit status is `pending` or `expired`, and never overwrites a `completed` deposit.

**Validates: Requirements 4.3**

### Property 8: PayOS config resolution is DB-first then env

For any combination of `system_config` value (absent, empty, whitespace, or non-empty) and env value for each PayOS credential, `resolvePayOsConfig` returns the trimmed-non-empty `system_config` value when present, otherwise the env value.

**Validates: Requirements 6.1, 6.2, 6.3**

### Property 9: PayOS request signature matches the sorted-key HMAC

For any set of payment-link parameters, the signature computed by `payos-client` equals `HMAC-SHA256(checksumKey, "amount=..&cancelUrl=..&description=..&orderCode=..&returnUrl=..")` over the keys sorted alphabetically.

**Validates: Requirements 7.2**

### Property 10: PayOS client fails closed without leaking secrets

For any PayOS API response that is non-2xx, signals a business error code, or times out, `createPaymentLink` throws a `PayOsApiError`, never returns a payment link, and the error message contains neither `PAYOS_API_KEY` nor `PAYOS_CHECKSUM_KEY`.

**Validates: Requirements 7.4, 7.5**

### Property 11: Order codes are unique and distinct from deposit ids

For any sequence of PayOS deposit requests, every generated `orderCode` is pairwise distinct, is not equal to any `deposits.id`, and is never reused by an existing PayOS deposit.

**Validates: Requirements 8.1**

### Property 12: Successful PayOS creation round-trips correlation and link id

For any valid PayOS deposit request that succeeds, a `pending` deposit exists with `provider='payos'`, `correlation_ref` equal to the generated `orderCode`, `provider_txn_id` equal to the returned `paymentLinkId`, and the output exposes the `checkoutUrl`.

**Validates: Requirements 8.2, 8.3, 13.1**

### Property 13: Return/cancel URLs use configured miniapp_url

For any initiating channel (`bot` or `miniapp`), PayOS deposit creation passes `returnUrl` and `cancelUrl` both equal to `system_config.miniapp_url`; when `miniapp_url` is empty/null the creation is rejected with a config error and no deposit is created.

**Validates: Requirements 8.4, 8.5**

### Property 14: Invalid amounts are rejected without creating a deposit

For any VND amount that is not a positive integer, or is below the minimum or above the maximum of `readDepositLimits`, PayOS deposit creation is rejected with the appropriate localized message and no deposit row is created.

**Validates: Requirements 8.6, 9.1, 9.2**

### Property 15: Deposit policy is enforced before creation

For any user blocked by the shared deposit policy, PayOS deposit creation is rejected, no deposit row is created, and no PayOS API call is made.

**Validates: Requirements 9.3**

### Property 16: Enabled flag normalization governs availability

For any raw `payment_payos_enabled` value, PayOS is treated as enabled if and only if the value trimmed and lower-cased equals `1` or `true`; otherwise it is treated as disabled.

**Validates: Requirements 10.1, 10.2, 10.3, 10.6**

### Property 17: PayOS appears only when region-allowed and enabled

For any combination of user region and enabled-flag state, PayOS is included in the methods returned for the user if and only if the region's `METHODS_BY_REGION` list contains `payos` and the enabled flag is on.

**Validates: Requirements 10.4, 11.1, 11.2, 11.3, 11.4**

### Property 18: Webhook verification gates crediting

For any webhook payload, the handler credits a deposit only when the signature equals the sorted-key HMAC computed with the checksum key; for any tampered signature or missing checksum key the handler rejects the callback, performs no crediting, and leaves the user balance unchanged.

**Validates: Requirements 12.2, 12.3**

### Property 19: Verified success on a pending deposit credits exact VND immediately

For any pending PayOS deposit, a verified successful callback referencing it via `correlation_ref` credits exactly the deposit's VND amount (no exchange conversion), transitions the deposit to `completed`, and never sets `awaiting_credit`.

**Validates: Requirements 12.4, 12.5, 13.2, 13.3**

### Property 20: Orphan pending deposit is cleaned up on link-creation failure

For any PayOS link-creation failure where the deposit is still `pending` and has no `provider_txn_id`, the deposit row is deleted; if the deposit is no longer `pending` or already has a `provider_txn_id`, it is retained.

**Validates: Requirements 14.1, 14.2**

### Property 21: PayOS secrets are never exposed by the admin config API

For any stored value of `payos_api_key`/`payos_checksum_key`, `GET /api/admin/config` returns an empty string for those keys with `secrets_set` true, and a `PUT` with an empty value for them leaves the stored value unchanged.

**Validates: Requirements 21.1, 21.2, 21.3**

### Property 22: Mini App deposit method round-trips for any returned method

For any method id returned by `GET /api/app/deposit-methods` (including `payos`), the Mini App submits `POST /deposits` with that exact id (never coerced to `sepay`/`cryptobot`) and renders the method-specific label.

**Validates: Requirements 18.5, 19.1, 19.3, 19.4**

### Property 23: Bot accepts exactly the region-and-enabled allowed methods

For any method id chosen in the bot, the deposit flow proceeds if and only if the provider exists in the registry, is allowed for the user region, and is enabled; `payos` dispatches to the PayOS sub-flow rather than the SePay sub-flow.

**Validates: Requirements 20.1, 20.2**

### Property 24: PayOS deposits are never cancelled

For any cancel request targeting a `payos` deposit (via Mini App API or bot), the deposit status is not changed to `cancelled`; the deposit remains creditable (`pending`/`expired`) so a later verified payment still credits exactly once.

**Validates: Requirements 23.1, 23.2, 23.3**
