# Implementation Plan: PayOS Deposit + Provider-Agnostic Deposits Schema

## Overview

Hai phần gắn liền, thực hiện theo thứ tự an toàn cho code tiền:

- **Phần A (làm trước, làm trọn):** rebuild `deposits` sang mô hình provider-agnostic (migration `0014`), cập nhật `DbDeposit`, tổng quát hoá `deposit-service`, chuyển mọi caller (sepay/cryptopay/credit-awaiting/providers) sang cột chung, cập nhật 5 file test tự khai schema, chạy `npm test` xanh.
- **Phần B (chỉ bắt đầu sau khi Phần A xanh):** thêm `payos` (types + config + client + provider + webhook + registry/register + bindings/mount), CMS card + i18n, caller Bot/Mini App xử lý nhánh `payos`, và test mới cho PayOS.

Ngôn ngữ: TypeScript (Cloudflare Workers + Hono, D1, Vue 3 cho CMS). Tuân thủ AGENTS.md: chỉ thêm file migration mới, giữ tính atomic D1 `batch()` + concurrency guard, không emoji do agent tự thêm.

Mỗi task tham chiếu requirement (granular) và correctness property liên quan. Test sub-task đánh dấu `*` (tuỳ chọn, có thể skip cho MVP nhưng nên chạy với code tiền).

---

## Tasks

### Phần A — Tổng quát hoá schema `deposits` (BẮT BUỘC HOÀN TẤT TRƯỚC PHẦN B)

- [x] 1. Rebuild schema + dịch vụ + caller dùng cột chung
  - [x] 1.1 Tạo migration `migrations/0014_payments_provider_agnostic.sql`
    - Theo mẫu an toàn `0008` (`PRAGMA foreign_keys=OFF` → `deposits_new` → `INSERT...SELECT` → `DROP` → `RENAME` → tạo index → `PRAGMA foreign_keys=ON`)
    - Cột chung `correlation_ref`/`provider_txn_id`/`metadata` (TEXT nullable); `provider` TEXT KHÔNG CHECK; giữ `id,user_id,provider,amount,status,completed_at,expired_at,created_at`; bỏ các cột riêng
    - Partial unique index `(provider, correlation_ref) WHERE correlation_ref IS NOT NULL` và `(provider, provider_txn_id) WHERE provider_txn_id IS NOT NULL`; giữ index `(user_id,status)`, `(status,created_at)`
    - Migrate dữ liệu thật: sepay (`correlation_ref=transfer_code`, `provider_txn_id=sepay_transaction_id` NHƯNG `'manual-approve'` cũ → `'manual-'||id` để không vỡ unique index, `metadata=json_object('bank_ref',bank_ref)` khi bank_ref khác NULL); cryptobot (`correlation_ref=provider_txn_id=crypto_invoice_id`, `metadata` chứa `asset/usdt_amount/exchange_rate`); NULL nguồn → NULL đích
    - TRƯỚC `db:migrate:remote`: kiểm D1 remote không còn trùng `provider_txn_id` sau biến đổi (`SELECT provider, provider_txn_id, COUNT(*) ... GROUP BY 1,2 HAVING COUNT(*)>1`) vì index `(provider,provider_txn_id)` chuyển non-unique→unique; nếu có trùng phải de-dup trước (local đã xác nhận 0 trùng)
    - KHÔNG sửa bất kỳ migration `0001`–`0013` đã chạy
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 1.2 Viết migration smoke + property test cho 0014
    - Áp `0014` lên DB seed (vài hàng sepay/cryptobot, gồm NULL `bank_ref`), assert cấu trúc bảng + index + dữ liệu migrate
    - **Property 1: Migration preserves common columns** — _Validates: Requirements 2.1_
    - **Property 2: SePay column mapping is faithful** — _Validates: Requirements 2.2, 2.6_
    - **Property 3: SePay bank_ref preserved in metadata** — _Validates: Requirements 2.3_
    - **Property 4: CryptoBot column mapping is faithful** — _Validates: Requirements 2.4, 2.5, 2.6_

  - [x] 1.3 Cập nhật kiểu `DbDeposit` trong `src/types/db.ts`
    - Thêm `correlation_ref: string | null`, `provider_txn_id: string | null`, `metadata: string | null`
    - Bỏ `transfer_code`, `sepay_transaction_id`, `bank_ref`, `crypto_invoice_id`, `asset`, `usdt_amount`, `exchange_rate`
    - `provider: 'sepay' | 'cryptobot' | 'payos'`
    - _Requirements: 3.1, 3.2, 3.3_

  - [x] 1.4 Tổng quát hoá `src/services/deposit-service.ts`
    - `completeDeposit`: nhận `providerTxnId?`/`correlationRef?`/`metadata?`; một câu UPDATE chung dùng `COALESCE` ghi `provider_txn_id`/`correlation_ref`/`metadata` (service tự `JSON.stringify`); GIỮ NGUYÊN D1 `batch()` nguyên tử, guard trạng thái `status IN ('pending','expired','awaiting_credit')`, `changes===0 → already_processed`, batch lỗi → `db_error`
    - `markAwaitingCredit`: nhận `metadata: Record<string,unknown>` ghi vào cột chung `metadata` (thay `usdt_amount` riêng), chỉ tác động khi status `pending`/`expired`
    - _Requirements: 4.1, 4.2, 4.3_

  - [x] 1.5 Viết property test cho `deposit-service` đã tổng quát hoá
    - **Property 5: completeDeposit credits exactly once** — _Validates: Requirements 4.2, 12.9, 13.4_
    - **Property 6: completeDeposit persists provider fields via common columns** — _Validates: Requirements 4.1_
    - **Property 7: markAwaitingCredit only affects creditable deposits** — _Validates: Requirements 4.3_

  - [x] 1.6 Cập nhật `src/routes/sepay.ts` sang cột chung
    - Idempotency theo `provider_txn_id` (`String(payload.id)`); lookup pending theo `correlation_ref`; `completeDeposit({ provider:'sepay', providerTxnId, metadata: { bank_ref } khi có })`
    - Giữ TTL guard, range guard, 500 khi `db_error`, 200 cho mọi no-op
    - _Requirements: 4.4_

  - [x] 1.7 Cập nhật `src/routes/cryptopay.ts` sang cột chung
    - Lookup theo `provider_txn_id` (invoice id); đọc lại USDT từ `json_extract(metadata,'$.usdt_amount')` khi cần; `markAwaitingCredit(db,id,{ usdt_amount })`; `completeDeposit({ provider:'cryptobot', providerTxnId/correlationRef=invoiceId, metadata:{ asset, usdt_amount, exchange_rate } })`
    - _Requirements: 4.5_

  - [x] 1.8 Cập nhật `src/services/credit-awaiting.ts` sang cột chung
    - SELECT đọc `json_extract(metadata,'$.usdt_amount') AS usdt_amount` và `provider_txn_id AS crypto_invoice_id`; gọi `completeDeposit` với `metadata` đầy đủ
    - _Requirements: 4.6_

  - [x] 1.9 Cập nhật `sepay-provider.ts` + `cryptopay-provider.ts` INSERT pending qua cột chung
    - SePay: INSERT `(user_id, provider='sepay', correlation_ref=transferCode, amount, status='pending', created_at)`
    - CryptoBot: INSERT `(user_id, provider='cryptobot', amount, status='pending', metadata=JSON({asset,usdt_amount}), created_at)`; sau `createInvoice` UPDATE `provider_txn_id`/`correlation_ref`; dọn mồ côi `DELETE ... WHERE id=? AND status='pending' AND provider_txn_id IS NULL`
    - _Requirements: 4.6_

  - [x] 1.10 Cập nhật test + script e2e tự khai/dùng schema `deposits`
    - 12 vitest tự khai schema (đổi `CREATE TABLE deposits` sang cột chung `correlation_ref`/`provider_txn_id`/`metadata`, bỏ cột riêng; sửa mọi INSERT/SELECT/assert tương ứng): `integration.test.ts`, `sepay-webhook.property.test.ts`, `deposit-service.property.test.ts`, `miniapp-deposit-range.property.test.ts`, `miniapp-deposit-notify.property.test.ts`, `miniapp-deposit-code-qr.property.test.ts`, `miniapp-deposit-vietqr-vnd.test.ts`, `region-methods.property.test.ts`, `cryptopay-webhook.property.test.ts`, `transaction.property.test.ts`, `cms-api.property.test.ts`, `miniapp-serve.test.ts`
    - Lưu ý `region-methods.property.test.ts`: `getDeposit` đọc `transfer_code/crypto_invoice_id/asset/usdt_amount` + assert → đổi sang đọc `correlation_ref`/`provider_txn_id` + `json_extract(metadata,...)`
    - 2 script e2e: `test/e2e_full_flow.sh`, `test/sepay_flow_test.sh` — `INSERT`/`SELECT` deposits đổi `transfer_code` → `correlation_ref`
    - `test/seed_local.sql`: INSERT seed deposits đang dùng cột bỏ (`transfer_code`/`sepay_transaction_id`/`asset`/`usdt_amount`/`exchange_rate`/`crypto_invoice_id`) → đổi sang cột chung (`correlation_ref`/`provider_txn_id`/`metadata`)
    - _Requirements: 17.1, 17.2, 17.3_

  - [x] 1.12 Cập nhật caller schema cũ còn lại: admin route + bot cancel + CMS DepositsView
    - `src/routes/admin/deposits.ts` (`POST /:id/approve`): đổi `completeDeposit({...sepayTransactionId:'manual-approve'})` → `providerTxnId:\`manual-${depositId}\`` (KHÔNG dùng hằng số: index mới `(provider,provider_txn_id)` UNIQUE → hằng số trùng sẽ vỡ ở lần duyệt tay thứ 2); giữ guard duyệt tay chỉ `sepay` (Worker phải biên dịch lại được)
    - `src/bot/callbacks/deposit.ts` (`handleDepositCancel`): đổi `SELECT id, amount, transfer_code` + `Pick<DbDeposit,'transfer_code'>` + `pendingDeposit.transfer_code` sang `correlation_ref`; nếu không sửa sẽ vỡ tsc sau task 1.3 + lỗi runtime khi user huỷ nạp
    - `cms/src/views/DepositsView.vue`: interface + template bỏ cột cũ (`transfer_code`/`sepay_transaction_id`/`bank_ref`/`crypto_invoice_id`/`asset`/`usdt_amount`/`exchange_rate`); đọc `correlation_ref`/`provider_txn_id` + parse `metadata` (JSON) cho asset/usdt_amount/exchange_rate/bank_ref
    - _Requirements: 4.6, 4.7, 22.1, 22.2, 22.4_

  - [x] 1.13 Checkpoint Phần A — Ensure all tests pass, ask the user if questions arise.
    - Chạy `npm test` (background process, đọc log dần) + `npm run build:cms`; xác nhận biên dịch không lỗi kiểu (Worker + CMS) với schema mới; chỉ qua Phần B khi xanh
    - _Requirements: 4.8, 17.3, 22.4_

### Phần B — Tích hợp PayOS (chỉ bắt đầu sau khi Phần A xanh)

- [x] 2. Types, bindings, config, client PayOS
  - [x] 2.1 Thêm `payos` vào `src/services/payments/types.ts`
    - `ProviderId += 'payos'`; thêm interface `PayOsDepositData` và nhánh `payos?` trong `CreateDepositOutput`
    - _Requirements: 5.4_

  - [x] 2.2 Thêm bindings PayOS vào `src/types/bindings.ts` + `.dev.vars.example`
    - `PAYOS_CLIENT_ID`/`PAYOS_API_KEY`/`PAYOS_CHECKSUM_KEY`; placeholder trong `.dev.vars.example` (không giá trị thật)
    - _Requirements: 6.1_

  - [x] 2.3 Tạo `src/services/payos-config.ts`
    - Hằng key `payos_client_id`/`payos_api_key`/`payos_checksum_key`; `resolvePayOsConfig(db, env)` DB-first → env qua `preferDbValue`; KHÔNG log `apiKey`/`checksumKey`
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 2.4 Viết property test cho `payos-config`
    - **Property 8: PayOS config resolution is DB-first then env** — _Validates: Requirements 6.1, 6.2, 6.3_

  - [x] 2.5 Tạo `src/services/payments/payos-client.ts`
    - `createPaymentLink` POST `https://api-merchant.payos.vn/v2/payment-requests`, headers `x-client-id`/`x-api-key`; ký HMAC-SHA256 trên `amount&cancelUrl&description&orderCode&returnUrl` sắp xếp theo khoá; timeout 30s qua `AbortController`; fail-fast ném `PayOsApiError` (không trả link, không lộ secret) khi non-2xx/`code!=='00'`/thiếu data/abort/lỗi mạng; trả `{ checkoutUrl, qrCode, paymentLinkId }`
    - `confirmWebhook({clientId, apiKey, webhookUrl})` POST `https://api-merchant.payos.vn/confirm-webhook` body `{ webhookUrl }`; fail-fast `PayOsApiError` không lộ secret (dùng cho R24)
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 24.1_

  - [x] 2.6 Viết property test cho `payos-client` (mock fetch)
    - **Property 9: PayOS request signature matches the sorted-key HMAC** — _Validates: Requirements 7.2_
    - **Property 10: PayOS client fails closed without leaking secrets** — _Validates: Requirements 7.4, 7.5_

  - [x] 2.7 Cập nhật DTO Mini App (backend + mirror frontend)
    - `src/types/miniapp.ts` VÀ `miniapp/src/types/index.ts`: `DepositMethodDto.id` và `DepositStatusDto.provider` thêm `'payos'`; thêm `PayosDepositCreatedDto` (`deposit_id`, `method:'payos'`, `checkout_url`, `amount`, `amount_display`, `status:'pending'`)
    - _Requirements: 18.1, 18.2, 18.3_

- [x] 3. PayOS provider + registry/register
  - [x] 3.1 Tạo `src/services/payments/payos-provider.ts`
    - Implement `PaymentProvider`, `id='payos'`, `amountUnit='vnd'`; `createDeposit`: validate số nguyên dương → `readDepositLimits` → `checkDepositPolicy` → sinh `orderCode` unique (≠ `deposits.id`, retry khi đụng partial unique) → INSERT pending `correlation_ref=orderCode` → `returnUrl=cancelUrl=readMiniAppUrl(db)` (quyết định A; rỗng/null → lỗi cấu hình, không tạo deposit) → `payos-client.createPaymentLink` → UPDATE `provider_txn_id=paymentLinkId`, `metadata={checkoutUrl,qrCode}` → trả `output.payos`; cộng tiền CHỈ qua `completeDeposit` dùng chung (không tự cập nhật balance)
    - Lỗi link: dọn mồ côi `DELETE ... WHERE id=? AND status='pending' AND provider_txn_id IS NULL`; log chi tiết nội bộ; trả `provider_error` thông báo chung (localized) không lộ chi tiết kỹ thuật
    - _Requirements: 5.1, 5.3, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 9.1, 9.2, 9.3, 9.4, 13.1, 14.1, 14.2, 14.3, 14.4, 15.1_

  - [x] 3.2 Viết property test cho `payos-provider`
    - **Property 11: Order codes are unique and distinct from deposit ids** — _Validates: Requirements 8.1_
    - **Property 12: Successful PayOS creation round-trips correlation and link id** — _Validates: Requirements 8.2, 8.3, 13.1_
    - **Property 13: Return/cancel URLs use configured miniapp_url** — _Validates: Requirements 8.4, 8.5_
    - **Property 14: Invalid amounts are rejected without creating a deposit** — _Validates: Requirements 8.6, 9.1, 9.2_
    - **Property 15: Deposit policy is enforced before creation** — _Validates: Requirements 9.3_
    - **Property 20: Orphan pending deposit is cleaned up on link-creation failure** — _Validates: Requirements 14.1, 14.2_

  - [x] 3.3 Cập nhật `src/services/payments/registry.ts`
    - `METHODS_BY_REGION.vietnam = ['sepay','payos','cryptobot']`; `payos` KHÔNG trong `ALWAYS_ENABLED_PROVIDERS`; `providerEnabledConfigKey('payos')==='payment_payos_enabled'` (chuẩn hoá trim+lowercase, bật khi `'1'`/`'true'`); `enabledMethodsForRegion` lọc theo region VÀ cờ
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.6, 11.1, 11.2, 11.3, 11.4_

  - [x] 3.4 Viết property test cho registry (enabled + region)
    - **Property 16: Enabled flag normalization governs availability** — _Validates: Requirements 10.1, 10.2, 10.3, 10.6_
    - **Property 17: PayOS appears only when region-allowed and enabled** — _Validates: Requirements 10.4, 11.1, 11.2, 11.3, 11.4_

  - [x] 3.5 Đăng ký `payOsProvider` trong `src/services/payments/register.ts`
    - `builtInProviders = [sePayProvider, cryptoPayProvider, payOsProvider]` để `getProvider('payos')` trả đúng một instance
    - _Requirements: 5.2_

- [x] 4. Webhook + wiring + caller Bot/Mini App
  - [x] 4.1 Tạo `src/routes/payos.ts` webhook + util chữ ký dùng chung
    - Parse JSON → verify `HMAC-SHA256(checksumKey, sortObjDataByKey(body.data)) === body.signature` (so sánh hằng-thời-gian; tách CẢ `timingSafeEqualHex` LẪN `toHex` từ `cryptopay-auth.ts` thành util dùng chung — hiện cả hai đang private); thiếu `checksumKey`/sai chữ ký → 401 không cộng tiền; chỉ xử lý sự kiện thành công; lookup deposit theo `correlation_ref==orderCode`; `completeDeposit` cộng đúng VND NGAY (không tỷ giá, không `awaiting_credit`); `db_error`→500, mọi no-op (không khớp/đã completed/không phải success)→200; notify user theo lang qua `renderDepositSuccess` bằng `waitUntil`
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 13.2, 13.3, 13.4, 15.2, 15.4, 24.4_

  - [x] 4.2 Viết property test cho webhook PayOS
    - **Property 18: Webhook verification gates crediting** — _Validates: Requirements 12.2, 12.3_
    - **Property 19: Verified success on a pending deposit credits exact VND immediately** — _Validates: Requirements 12.4, 12.5, 13.2, 13.3_

  - [x] 4.3 Mount `/webhook/payos` trong `src/index.ts`
    - Gắn router `payOsWebhook` vào app
    - _Requirements: 12.1_

  - [x] 4.4 Thêm key i18n bot/notify (`src/bot/i18n`) vi/en
    - `deposit.limit.vnd_invalid` (R8.5) và `deposit.error.payos_failed` (R14.3); tái dùng `deposit.limit.vnd_range`, `deposit.success.*`; fallback lang theo `resolveLang` (Default_Language hệ thống, `BASE_FALLBACK_LANG`='en')
    - _Requirements: 15.1, 15.3, 8.5, 14.3_

  - [x] 4.5 Xử lý nhánh `payos` trong `src/bot/callbacks/deposit.ts` + `router.ts` + i18n bot
    - Gỡ guard cứng `(method !== 'sepay' && method !== 'cryptobot')`: validate theo registry (`getProvider(method)` tồn tại) rồi `isMethodAllowedForRegion` + `isProviderEnabled`; disabled/không thuộc vùng → thông báo không khả dụng, không tạo deposit
    - `startDepositMethod` thêm nhánh `payos` → `startPayOsDeposit` đặt session step RIÊNG `'payos_amount'` (mẫu CryptoBot, KHÔNG reuse step `'amount'` vì handler đó gắn cứng sePayProvider); thêm `handlePayOsDepositAmount` gọi `payOsProvider.createDeposit({channel:'bot'})` → gửi inline button mở `checkout_url`
    - `src/bot/router.ts`: `handleSessionInput` thêm nhánh `step === 'payos_amount'` → `handlePayOsDepositAmount`; PayOS nhập số qua text (tránh đụng preset callback `dep:{amount}` đang route về SePay)
    - Thêm key i18n `deposit.method.payos` (vi/en) trong `src/bot/i18n/catalogs/{vi,en}.ts`
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 10.5_

  - [x] 4.6 Xử lý nhánh `payos` trong `src/routes/miniapp-api.ts`
    - Thêm key `payos:'vnd'` vào object literal `amountUnitByProvider: Record<ProviderId,...>` trong `miniapp-api.ts` (literal phải đủ mọi key của `ProviderId`, nếu thiếu → lỗi kiểu); nới `method` nhận `'payos'`; map `provider` cho payos; nhánh `payos` đọc `result.output.payos` trả `PayosDepositCreatedDto` (`checkout_url`); giữ guard `isMethodAllowedForRegion`+`isProviderEnabled`
    - _Requirements: 18.4, 18.5, 8.4, 10.5_

  - [x] 4.7 Viết integration/example test luồng PayOS end-to-end
    - Bao phủ tạo Deposit qua provider và webhook cộng tiền idempotent theo `paymentLinkId` (no-op→200, lặp callback không cộng trùng)
    - _Requirements: 17.4_

  - [x] 4.8 Cập nhật frontend Mini App `miniapp/src/views/DepositView.vue` + i18n
    - `type Method` thêm `'payos'`; bỏ cast cứng `'sepay'|'cryptobot'` ở SegmentedControl; `methodOptions` + card 1-phương-thức map nhãn/icon theo từng id; `selectedMethod` mặc định theo `list[0].id`
    - `submitDeposit` thêm nhánh `payos`: `post<PayosDepositCreatedDto>('/deposits',{method:'payos',amount})` (VND, số nguyên) → `createdPayos` → `openLink(res.checkout_url)` → `startPolling()`; thêm ref `createdPayos` vào `created` + khối chờ + nút mở lại link; `resetDeposit()` phải clear thêm `createdPayos`
    - i18n `miniapp/src/i18n/**`: `deposit.method_payos_short`, `deposit.method_payos`, `deposit.method_payos_desc`, `deposit.pay_payos` (vi/en)
    - _Requirements: 19.1, 19.2, 19.3, 19.4, 19.5_

  - [x] 4.9 Test frontend/backend round-trip phương thức nạp
    - **Property 22: Mini App deposit method round-trips for any returned method** — _Validates: Requirements 18.5, 19.1, 19.3, 19.4_
    - **Property 23: Bot accepts exactly the region-and-enabled allowed methods** — _Validates: Requirements 20.1, 20.2_

  - [x] 4.10 PayOS không cho huỷ (R23) — backend + UI
    - `POST /api/app/deposits/:id/cancel` và bot `handleDepositCancel`: khi `deposit.provider==='payos'` → KHÔNG set `cancelled` (no-op/lỗi rõ), giữ `pending` (để TTL→expired vẫn cộng được)
    - Mini App `DepositView` + bot ẩn nút Huỷ khi phương thức/deposit là `payos`; KHÔNG đổi guard `completeDeposit`
    - _Requirements: 23.1, 23.2, 23.3, 23.4_

  - [x] 4.11 Test PayOS không huỷ
    - **Property 24: PayOS deposits are never cancelled** — _Validates: Requirements 23.1, 23.2, 23.3_

  - [x] 4.12 Route admin đăng ký webhook PayOS (R24)
    - `POST /api/admin/payos/confirm-webhook` (JWT): dựng `webhookUrl=${origin}/webhook/payos`, `resolvePayOsConfig`, gọi `payos-client.confirmWebhook`; trả thành công/lỗi; KHÔNG log secret
    - MOUNT route: `adminApi.route('/payos', payosAdminRoutes)` trong `src/routes/admin/index.ts` (nếu không mount → endpoint unreachable)
    - _Requirements: 24.1, 24.3_

- [x] 5. CMS cấu hình PayOS
  - [x] 5.1 Thêm card PayOS vào `cms/src/views/ConfigView.vue`
    - `form`: `payos_client_id`, `payos_api_key`, `payos_checksum_key`, `payment_payos_enabled` ('0' mặc định); input api_key/checksum_key dạng password có toggle; công tắc bật/tắt ghi `payment_payos_enabled`; hiển thị `payosWebhookUrl=${origin}/webhook/payos`; lưu qua `PUT /api/admin/config` (đã hỗ trợ key tuỳ ý qua INSERT OR REPLACE — KHÔNG cần whitelist write; masking secret xử lý ở task 5.4)
    - _Requirements: 16.1, 16.2, 16.3_

  - [x] 5.2 Thêm nhóm khoá i18n `config.payos.*` cho CMS (`cms/src/i18n/messages/vi.json` + `en.json`)
    - Nhãn/text card PayOS theo Language hiện hành (vi/en)
    - _Requirements: 16.4_

  - [x] 5.3 Verify build CMS
    - `npm run build:cms` không lỗi (vue-tsc + vite)
    - _Requirements: 16.1, 16.4_

  - [x] 5.4 Mask secret PayOS trong `src/routes/admin/config.ts`
    - Thêm `payos_api_key`, `payos_checksum_key` vào `SECRET_CONFIG_KEYS` (GET mask + `secrets_set`; PUT bỏ qua giá trị rỗng); `payos_client_id` để cấu hình thường; tuỳ chọn thêm `PAYOS_*` vào `envFallback`/`secretEnv` để cờ phản ánh secret đặt qua `wrangler secret`
    - _Requirements: 21.1, 21.2, 21.3, 21.4_

  - [x] 5.5 Test mask secret PayOS
    - **Property 21: PayOS secrets are never exposed by the admin config API** — _Validates: Requirements 21.1, 21.2, 21.3_

  - [x] 5.6 Thêm nhãn provider `payos` vào `cms/src/views/DepositsView.vue`
    - Mở rộng union `provider` thêm `'payos'`; `providerLabel('payos')` + i18n nhãn; hiển thị giao dịch PayOS đúng (mã đối soát từ `correlation_ref`, link id từ `provider_txn_id`)
    - _Requirements: 22.3_

  - [x] 5.7 Nút "Đăng ký webhook" PayOS trong CMS ConfigView
    - Gọi `POST /api/admin/payos/confirm-webhook`; hiển thị kết quả thành công/lỗi; i18n vi/en
    - _Requirements: 24.2, 24.3_

- [x] 6. Checkpoint cuối — Ensure all tests pass, ask the user if questions arise.
  - Chạy `npm test` (background process, đọc log dần) + `npm run build:cms`; xác nhận toàn bộ test xanh và build sạch
  - _Requirements: 4.8, 17.3, 17.4, 22.4_

## Notes

- Task đánh dấu `*` là tuỳ chọn (test) và có thể skip cho MVP nhanh; với code tiền nên chạy đầy đủ.
- Phần A PHẢI xanh (`npm test` + biên dịch) trước khi bắt đầu Phần B — bảo toàn an toàn dữ liệu tiền thật.
- Mỗi task tham chiếu requirement granular; mỗi property test gắn property number + requirements clause được kiểm.
- Migration chỉ THÊM file `0014_*.sql`, không sửa migration đã chạy; cập nhật `src/types/db.ts` ngay sau khi đổi schema.
- Giữ tính atomic D1 `batch()` + concurrency guard trong `completeDeposit`; không emoji do agent tự thêm.
- Không log `PAYOS_API_KEY`/`PAYOS_CHECKSUM_KEY`; secret production qua `wrangler secret put`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3"] },
    { "id": 1, "tasks": ["1.2", "1.4"] },
    { "id": 2, "tasks": ["1.6", "1.7", "1.8", "1.9", "1.10", "1.12"] },
    { "id": 3, "tasks": ["1.5"] },
    { "id": 4, "tasks": ["2.1", "2.2", "2.3", "2.5", "2.7", "4.4", "5.2"] },
    { "id": 5, "tasks": ["2.4", "2.6", "3.1", "3.3", "5.1", "5.4"] },
    { "id": 6, "tasks": ["3.2", "3.4", "3.5", "4.1"] },
    { "id": 7, "tasks": ["4.2", "4.3", "4.5", "4.6", "4.12", "5.5", "5.6"] },
    { "id": 8, "tasks": ["4.8"] },
    { "id": 9, "tasks": ["4.10"] },
    { "id": 10, "tasks": ["4.7", "4.9", "4.11", "5.3", "5.7"] }
  ]
}
```
