# Implementation Plan — Multi-Region Payments

## Overview

Kế hoạch triển khai theo thứ tự tăng dần và **không phá vỡ SePay**: nền tảng dữ liệu/i18n → trừu tượng Payment_Provider (đưa SePay vào khung) → CryptoBot → quy đổi/awaiting-credit → template song ngữ → Bot → Mini App → CMS → đấu nối & cấu hình.

Nguyên tắc: tái dùng tối đa service/util hiện có (`transaction` atomic batch, `deposit-policy`, `deposit-limits`, `system-config`, `telegram-template`, `miniapp-auth`), tuân thủ OCP (thêm provider/ngôn ngữ không sửa lõi), và quy tắc AGENTS.md (chuỗi mới chữ thuần không emoji; CMS dùng Icon.vue). Ngôn ngữ triển khai: TypeScript (Hono + Web Crypto) và Vue 3 (Mini App, CMS).

Mỗi task tham chiếu Requirements và/hoặc Correctness Property trong `design.md`.

## Tasks

- [x] 1. Nền tảng dữ liệu: migration + types
  - [x] 1.1 Viết migration `migrations/0008_multi_region_payments.sql`
    - Thêm cột `users.region` (CHECK vietnam|international, nullable), `users.language` (TEXT, KHÔNG CHECK cứng), `users.language_locked` (INTEGER DEFAULT 0)
    - Tạo bảng `product_type_templates(id, product_type_id FK ON DELETE CASCADE, lang, success_template, updated_at, UNIQUE(product_type_id, lang))` + index; migrate `product_types.success_template` hiện có → dòng `lang='vi'`
    - Rebuild bảng `deposits`: thêm `provider` (CHECK sepay|cryptobot, DEFAULT 'sepay'), `transfer_code` nullable, `crypto_invoice_id`, `asset`, `usdt_amount` (TEXT), `exchange_rate` (INTEGER), mở rộng `status` thêm `awaiting_credit`; copy dữ liệu cũ với provider='sepay'; tạo unique index từng phần cho `transfer_code` và `crypto_invoice_id`, các index còn lại. Lưu ý: `PRAGMA foreign_keys` là no-op trong transaction D1 (giữ chỉ để tài liệu); rebuild an toàn vì không bảng nào FK trỏ tới `deposits`. Bắt buộc `db:migrate:local` kiểm tra giữ nguyên dữ liệu trước khi remote
    - Seed `system_config`: `exchange_rate_usdt_vnd`, `crypto_min_usdt`, `default_language`
    - _Requirements: 3.1, 3.2, 7.1, 7.5, 7.7, 12.1, 13.5, 16.1_
  - [x] 1.2 Cập nhật `src/types/db.ts`
    - `DbUser` thêm `region`, `language: string | null`, `language_locked`; thêm `DbProductTypeTemplate`; `DbDeposit` thêm `provider`, `transfer_code` nullable, `crypto_invoice_id`, `asset`, `usdt_amount`, `exchange_rate`, status union thêm `awaiting_credit`
    - _Requirements: 3.1, 3.2, 7.1, 16.1_
  - [x] 1.3 Cập nhật `src/types/bindings.ts` + `.dev.vars.example`
    - Thêm `CRYPTO_PAY_API_TOKEN`; bổ sung mẫu trong `.dev.vars.example` (không ghi giá trị thật)
    - _Requirements: 19.1_

- [x] 2. Lõi i18n + locale registry
  - [x] 2.1 Viết `src/i18n/locales.ts`
    - `SUPPORTED_LANGUAGES` (['vi','en'] hiện tại), type `Lang`, `BASE_FALLBACK_LANG='en'`, `isSupportedLang`, `REGION_DEFAULT_LANG` (bảng tra)
    - _Requirements: 4.5, 3.3, 3.4_
  - [x] 2.2 Viết `src/services/user-locale.ts`
    - `resolveLang(db, user)` theo chuỗi fallback `user.language → default_language(config, validate registry) → BASE_FALLBACK_LANG`; `regionDefaultLang(region)`; `setRegion(db, userId, region)` (set language khởi tạo nếu `language_locked=0`); `setLanguage(db, userId, lang)` (validate registry + set `language_locked=1`)
    - _Requirements: 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 6.3, 6.4_
  - [x] 2.4 Viết helper định dạng theo locale `src/utils/format.ts`
    - Thêm `formatMoney(amountVnd, lang)` / `formatNumber(n, lang)` dùng `Intl.NumberFormat`: nhánh `vi`→`vi-VN` (nhóm dấu chấm), `en`→`en-US` (dấu phẩy). Hiện trạng KHÔNG nhất quán: `format.ts` đang dùng `en-US` còn `transaction.ts` dùng `vi-VN` ở mô tả deposit → thống nhất qua helper. Giữ `formatCurrency` cũ làm alias `formatMoney(amount,'vi')` (hoặc thay toàn bộ nơi gọi sang `formatMoney(amount, lang)`); cập nhật mô tả deposit trong `transaction.ts`/`deposit-service.ts` dùng helper. Lưu ý UX: hiển thị VND cho user `vi` đổi `150,000đ`→`150.000đ`. Mini App/CMS khai báo number formats trong vue-i18n
    - _Requirements: 4.6_
  - [x] 2.3 Property test fallback ngôn ngữ + lock
    - **Property 7: Ngôn ngữ độc lập vùng** và **Property 8: Mở rộng ngôn ngữ an toàn**
    - **Validates: Requirements 6.4, 4.3, 17.5**
    - `setLanguage` đặt lock; đổi region sau đó không đổi language; `resolveLang` luôn trả `Lang` hợp lệ với mọi đầu vào (kể cả config sai)
    - Tag: `Feature: multi-region-payments, Property 7` và `Property 8`

- [x] 3. Trừu tượng Payment_Provider + cộng tiền dùng chung
  - [x] 3.1 Viết `src/services/payments/types.ts` + `registry.ts`
    - Interface `PaymentProvider` (`id`, `amountUnit`, `createDeposit`), input/output types; `registry` Map + `getProvider`, `methodsForRegion(region)` (vietnam→[sepay,cryptobot], international→[cryptobot])
    - _Requirements: 7.1, 7.2, 7.4, 8.1, 8.2_
  - [x] 3.2 Viết `src/services/deposit-service.ts` (generalize `executeDeposit`)
    - `completeDeposit(input)`: D1 batch atomic (balance + deposits status/provider fields/usdt/rate + transaction), set `amount=creditVnd`, guard `WHERE id=? AND status IN ('pending','expired','awaiting_credit')`, `changes===0 → already_processed`; trả `error='db_error'` riêng biệt khi batch ném lỗi (để caller retry — R14.5, không coi là đã xử lý)
    - `markAwaitingCredit(db, depositId, usdtAmount)`: guard `WHERE id=? AND status IN ('pending','expired')` để KHÔNG ghi đè deposit `completed` (bảo toàn idempotency khi callback trùng lúc rate tạm lỗi)
    - Giữ `transaction.ts.executePurchase` nguyên trạng; chuyển nơi gọi `executeDeposit` (sepay.ts) sang `completeDeposit` rồi **gỡ hẳn `executeDeposit`** khỏi `TransactionService` (DRY)
    - _Requirements: 7.3, 7.5, 11.1, 11.2, 14.1, 14.2, 14.3, 14.4, 14.5_
  - [x] 3.3 Property test cộng tiền idempotent + số dư không âm
    - **Property 1: Cộng tiền đúng một lần**, **Property 2: Số dư không âm**
    - **Validates: Requirements 11.2, 14.3, 14.4**
    - Gọi `completeDeposit` lặp/đồng thời cho cùng deposit → cộng đúng 1 lần; balance luôn `>=0` (D1 thật)
    - Tag: `Feature: multi-region-payments, Property 1` và `Property 2`

  - [x] 4. SePay provider (refactor, giữ hành vi)
  - [x] 4.1 Viết `src/services/payments/sepay-provider.ts`
    - Đưa logic tạo deposit VietQR (transfer_code + `generateVietQRUrl` + `readDepositLimits` + `checkDepositPolicy`) vào `SePayProvider.createDeposit` (`amountUnit='vnd'`), set `provider='sepay'`
    - **Gộp trùng**: thay cả `bot/callbacks/deposit.ts handleDepositAmount` lẫn `miniapp-api POST /deposits` để gọi `SePayProvider.createDeposit`; tách `buildDepositCaption` dùng chung (gỡ bản trùng ở hai nơi)
    - _Requirements: 7.2, 9.1, 13.1, 13.3_
  - [x] 4.2 Cập nhật `src/routes/sepay.ts` dùng `completeDeposit`
    - Thay `transactionService.executeDeposit` → `completeDeposit(provider='sepay')`; giữ idempotency `sepay_transaction_id`, TTL 15' bỏ qua khi `expired` (R15.3); thông báo nạp thành công theo `language` của user; khi `completeDeposit` trả `db_error` (atomic lỗi sau khi đã match giao dịch tiền vào) → log lỗi và dựa vào retry của SePay (không đánh dấu hoàn tất) (R14.5)
    - _Requirements: 9.2, 9.3, 9.4, 9.5, 14.5, 15.3_

- [x] 5. CryptoBot client + provider
  - [x] 5.1 Viết `src/services/payments/crypto-pay-client.ts`
    - `createInvoice({asset:'USDT', amount, description, payload:depositId, expires_in})` gọi `https://pay.crypt.bot/api/createInvoice` với header token; parse `invoice_id`, `pay_url`; xử lý lỗi API
    - _Requirements: 10.1, 10.2, 10.3, 10.5, 19.1, 19.5_
  - [x] 5.2 Viết `src/services/payments/cryptopay-provider.ts`
    - `CryptoPayProvider.createDeposit` (`amountUnit='usdt'`): validate `usdt >= crypto_min_usdt` và `floor(usdt×rate) <= max_deposit` (R13.2/13.4/13.5); tạo invoice; lưu deposit pending (`provider='cryptobot'`, `crypto_invoice_id`, `asset='USDT'`, `amount=floor(usdt×rate)`); reuse `checkDepositPolicy`; trả `payUrl` theo `channel` (bot/miniapp)
    - Lỗi createInvoice → không tạo pending, trả lỗi (R10.4)
    - _Requirements: 10.1, 10.2, 10.4, 10.5, 13.2, 13.4, 13.5, 13.6_
  - [x] 5.3 Đăng ký SePay + CryptoBot vào registry
    - _Requirements: 7.2, 7.4_

- [x] 6. CryptoBot webhook + xác thực chữ ký
  - [x] 6.1 Viết `src/middleware/cryptopay-auth.ts`
    - Verify `crypto-pay-api-signature`: `secret=SHA256(token)`, `hmac=HMAC_SHA256(secret, rawBody)` hex, so sánh hằng-thời-gian; sai → 401 + log lý do; dùng Web Crypto
    - _Requirements: 19.2, 19.3, 19.4, 19.5_
  - [x] 6.2 Viết `src/routes/cryptopay.ts` (`POST /cryptopay`)
    - Chỉ xử lý `invoice_paid`; idempotency theo `crypto_invoice_id` đã completed; đọc `exchange_rate` → thiếu/không hợp lệ thì `markAwaitingCredit` + log (R12.4); hợp lệ thì `creditVnd=floor(paid_usdt×rate)` + `completeDeposit` (cộng kể cả khi `expired` — R11.4/R15.4); `db_error` → trả 500 để Crypto Pay retry callback (R14.5, không trả 200); `success`/`already_processed` → notify theo `language` (R11.3) + trả 200 (R11.5)
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 12.2, 12.4, 12.5, 12.6, 14.5, 15.4_
  - [x] 6.3 Property test webhook crypto
    - **Property 3: Bảo toàn tiền đã trả**, **Property 4: Quy đổi xác định**
    - **Validates: Requirements 11.4, 12.2, 12.6, 12.7**
    - Chữ ký giả → 401; invoice trùng → bỏ qua; paid-after-expired → vẫn cộng đúng 1 lần; `creditVnd=floor(usdt×rate)`; rate lỗi → awaiting_credit (chưa cộng); `completeDeposit` db_error → webhook trả 500 (retry, chưa đánh dấu hoàn tất — R14.5); callback trùng tới khi đã `completed` → `markAwaitingCredit` không ghi đè
    - Tag: `Feature: multi-region-payments, Property 3` và `Property 4`

- [x] 7. Awaiting-credit + expiry đa provider
  - [x] 7.1 Viết `src/services/credit-awaiting.ts`
    - Khi `exchange_rate` hợp lệ: quét deposit `awaiting_credit`, `completeDeposit` idempotent từ `usdt_amount×rate`, notify user (R12.7)
    - _Requirements: 12.7_
  - [x] 7.2 Đấu nối cron trong `src/index.ts` (`scheduled`)
    - Gọi `creditAwaitingDeposits(env, ctx)` (cần `env` để resolve bot token + `ctx.waitUntil` để notify) sau `expirePendingDeposits`; xác nhận `deposit-expiry` áp cho mọi provider (provider-agnostic theo status/age)
    - _Requirements: 12.7, 15.1, 15.2_

- [x] 8. Template bán hàng đa ngôn ngữ
  - [x] 8.1 Viết loader + cập nhật `src/utils/telegram-template.ts`
    - `loadProductTypeTemplates(db, productTypeId)` → `Map<Lang,string|null>`; `renderSuccessMessage(templatesByLang, vars, lang)` chọn theo `lang → BASE_FALLBACK_LANG → body mặc định`; header lấy từ catalog bot theo `lang`; giữ placeholder + escape HTML
    - Cập nhật nơi gọi (bot purchase, `miniapp-api purchase`) truyền templates map + `lang` user
    - _Requirements: 16.1, 16.3, 16.4, 16.5, 16.6_

- [x] 9. Bot: onboarding, locale, phương thức nạp
  - [x] 9.1 Viết catalog i18n bot `src/bot/i18n/`
    - `catalogs: Record<Lang, ...>` + `t(lang, key, vars?)` fallback `BASE_FALLBACK_LANG → key`; chuỗi MỚI chữ thuần, không emoji
    - _Requirements: 4.1, 17.5_
  - [x] 9.2 Onboarding + guard + menu đa ngôn ngữ trong `commands/start.ts` và `bot/router.ts`
    - `/start`: region NULL → inline keyboard [Việt Nam][Quốc tế] bằng default_language, không hiện menu; có region → menu (R1.1/1.2/1.5); guard: region NULL + input khác chọn vùng → hiện lại onboarding (R1.6, R3.7)
    - Thêm `src/bot/callbacks/region.ts` xử lý `reg:*` → `setRegion` → menu (R1.3, R1.4); router thêm case `reg`
    - `buildMainMenu(lang)` nhãn theo lang; thêm `src/bot/i18n/menu.ts` map `MENU_ACTION_BY_LABEL` gộp nhãn mọi locale → action; `handleTextMessage` tra map thay `switch` chuỗi cứng; cập nhật mọi nơi gọi `buildMainMenu()` truyền lang
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 3.7, 4.1_
  - [x] 9.3 Lệnh đổi vùng/ngôn ngữ
    - `/region`, `/language` (hoặc nút menu) gọi `setRegion`/`setLanguage`
    - _Requirements: 5.1, 6.1_
  - [x] 9.4 Chọn phương thức nạp theo vùng trong `callbacks/deposit.ts`
    - `dep:menu` liệt kê theo `methodsForRegion(region)`; nhiều → bước chọn (`dep:method:sepay`/`dep:method:cryptobot`), một → vào thẳng; SePay giữ flow VND; CryptoBot session step `crypto_amount` (nhập USDT) → `CryptoPayProvider.createDeposit` → gửi nút `pay_url`; enforce method theo vùng
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 10.1, 10.3_
  - [x] 9.5 Property test method theo vùng
    - **Property 5: Phân tách provider/đơn vị**, **Property 6: Method hợp lệ theo vùng**
    - **Validates: Requirements 7.7, 8.4, 13.2**
    - `methodsForRegion` đúng theo vùng; tạo deposit qua provider ngoài danh sách bị từ chối; deposit sepay luôn có transfer_code, cryptobot luôn có invoice_id+USDT
    - Tag: `Feature: multi-region-payments, Property 5` và `Property 6`

- [x] 10. Mini App backend API
  - [x] 10.1 Mở rộng `src/routes/miniapp-api.ts`
    - `GET /me` trả thêm `region`, `language`; `POST /region {region}` → `setRegion`; `PUT /language {language}` → `setLanguage`; `GET /deposit-methods` theo region; `POST /deposits {method, amount}` điều phối provider (sepay=VND giữ nguyên, cryptobot=USDT trả `pay_url`), enforce method theo region; `GET /deposits/:id` hỗ trợ provider crypto (read-only)
    - _Requirements: 2.3, 2.4, 5.2, 6.2, 8.3, 8.4, 10.1, 10.2, 10.3_

- [x] 11. Mini App frontend
  - [x] 11.1 Thiết lập `vue-i18n` trong `miniapp/`
    - `miniapp/src/i18n/` nạp `messages/<lang>.json` động (`import.meta.glob`), `fallbackLocale=en`, missing handler trả text/key (R17.5), đổi locale reactive (R17.4); set locale từ `language` của `/me`
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5_
  - [x] 11.2 Onboarding + Settings view
    - `OnboardingView` hiện khi `region` NULL → gọi `POST /region` (R2.1–2.5); Settings cho đổi region + language (R5.2, R6.2)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 5.2, 6.2_
  - [x] 11.3 UI nạp theo phương thức
    - Màn nạp lấy `GET /deposit-methods`; SePay giữ VietQR; CryptoBot nhập USDT → `POST /deposits` → mở `pay_url` (openInvoice/openLink) → poll `GET /deposits/:id`
    - _Requirements: 8.3, 10.1, 10.3_

- [x] 12. CMS
  - [x] 12.1 Thiết lập `vue-i18n` trong `cms/`
    - `cms/src/i18n/` default `en`, bộ chọn ngôn ngữ render từ `SUPPORTED_LANGUAGES`, reactive không reload; chuỗi UI dùng Icon.vue không emoji
    - _Requirements: 18.1, 18.2, 18.3, 18.4_
  - [x] 12.2 Trang Settings cấu hình thanh toán
    - Xem/sửa `exchange_rate_usdt_vnd`, `min/max_deposit`, `crypto_min_usdt`, `default_language`; validate max>=min (R20.7); API admin tương ứng
    - _Requirements: 12.3, 20.1, 20.2, 20.3, 20.4, 20.7_
  - [x] 12.3 Trình soạn template theo tab ngôn ngữ
    - ProductType: tab ngôn ngữ sinh từ `SUPPORTED_LANGUAGES`, mỗi tab CRUD một dòng `product_type_templates`; API admin đọc/ghi template theo (product_type_id, lang)
    - _Requirements: 16.1, 16.2_
  - [x] 12.4 Tra cứu giao dịch + sửa region user
    - Danh sách giao dịch nạp hiển thị provider + (USDT, exchange_rate) qua JOIN deposits; trang User cho đổi region
    - _Requirements: 5.4, 20.6_

- [x] 13. Đấu nối & cấu hình cuối
  - [x] 13.1 Đăng ký route `cryptopay` trong `src/index.ts`
    - Mount `cryptoPayWebhook` tại `app.route('/webhook', cryptoPayWebhook)` với sub-route `POST /cryptopay` (đồng bộ convention SePay), áp `cryptopay-auth`
    - _Requirements: 11.1, 19.2_
  - [x] 13.2 Tài liệu cấu hình secret + tỷ giá + đăng ký webhook CryptoBot
    - README: `wrangler secret put CRYPTO_PAY_API_TOKEN`, seed config; **bật Webhooks trong app @CryptoBot và set URL `https://<domain>/webhook/cryptopay`**; KHÔNG commit giá trị thật
    - _Requirements: 19.1, 19.5_
  - [x] 13.3 i18n coverage test
    - Test kiểm mọi locale trong `SUPPORTED_LANGUAGES` đủ key như locale gốc (bot catalog + miniapp + cms)
    - _Requirements: 4.5, 17.1, 18.1_

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1.1", "1.2", "1.3"], "dependsOn": [] },
    { "wave": 2, "tasks": ["2.1", "2.2", "2.3", "2.4", "3.1", "3.2", "3.3"], "dependsOn": ["1.1", "1.2", "1.3"] },
    { "wave": 3, "tasks": ["4.1", "4.2", "5.1", "5.2", "5.3", "8.1"], "dependsOn": ["2.1", "2.2", "3.1", "3.2"] },
    { "wave": 4, "tasks": ["6.1", "6.2", "6.3", "7.1", "7.2"], "dependsOn": ["5.1", "5.2", "5.3", "3.2"] },
    { "wave": 5, "tasks": ["9.1", "9.2", "9.3", "9.4", "9.5"], "dependsOn": ["2.1", "2.2", "3.2", "4.1", "5.2", "8.1"] },
    { "wave": 6, "tasks": ["10.1"], "dependsOn": ["2.2", "3.2", "4.1", "5.2"] },
    { "wave": 7, "tasks": ["11.1", "11.2", "11.3", "12.1", "12.2", "12.3", "12.4"], "dependsOn": ["10.1", "2.1"] },
    { "wave": 8, "tasks": ["13.1", "13.2", "13.3"], "dependsOn": ["6.2", "9.4", "10.1", "11.1", "12.1"] }
  ]
}
```

Thứ tự đề xuất theo wave 1 → 8. Property tests (2.3, 3.3, 6.3, 9.5) chạy ngay sau task lõi tương ứng trong cùng wave.

## Notes

- **Không phá vỡ SePay**: task 4 chỉ refactor để dùng `completeDeposit` + đưa tạo deposit vào provider; hành vi quan sát được (idempotency, TTL bỏ qua khi expired, thông báo) giữ nguyên.
- **Migration một chiều**: task 1 rebuild bảng `deposits` — chạy `db:migrate:local` kiểm tra trước; chỉ `db:migrate:remote` khi user yêu cầu deploy. Không sửa migration cũ (0001–0007).
- **Scale ngôn ngữ**: thêm ngôn ngữ về sau = thêm mã vào `SUPPORTED_LANGUAGES` (task 2.1) + catalog cho bot/miniapp/cms + (tùy chọn) tab template trong CMS; không đụng schema/lõi.
- **Quy tắc emoji**: chuỗi i18n và thông báo MỚI dùng chữ thuần; giữ nguyên emoji cũ ở header template `vi` và thông báo SePay hiện hữu.
- **Secret**: `CRYPTO_PAY_API_TOKEN` qua `wrangler secret put` (production) / `.dev.vars` (local); không echo/log giá trị.
- **Verify**: sau mỗi nhóm task chạy `npm test`; sau khi đụng `miniapp/` hoặc `cms/` chạy build tương ứng trước khi coi là xong.
