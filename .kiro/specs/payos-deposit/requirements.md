# Requirements Document

## Introduction

Tính năng này có **hai phần gắn liền nhau**:

**Phần A — Tổng quát hoá schema `deposits` (dọn sạch một lần cuối).** Hiện `deposits` còn các cột gắn cứng theo từng provider (`transfer_code`, `sepay_transaction_id`, `bank_ref` cho SePay; `crypto_invoice_id`, `asset`, `usdt_amount`, `exchange_rate` cho CryptoBot). Mỗi provider mới lại phải thêm cột + migration. Phần A rebuild bảng `deposits` qua migration `0014_*.sql` theo mô hình **provider-agnostic**: ba cột chung `correlation_ref` (mã đối soát nội bộ), `provider_txn_id` (định danh giao dịch phía provider, khoá idempotency) và `metadata` (JSON chứa dữ liệu đặc thù provider), bỏ các cột riêng. Cột `provider` đổi sang `TEXT` **bỏ ràng buộc CHECK** (việc hợp lệ hoá provider chuyển lên tầng ứng dụng qua registry). Dữ liệu tiền thật hiện có **phải được migrate** sang mô hình mới không mất mát. Mục tiêu: **cổng thanh toán tương lai KHÔNG cần migration DB nữa**.

**Phần B — Tích hợp PayOS làm phương thức nạp mới.** Bổ sung Payment_Provider `payos` nhận thanh toán bằng **VND** (giống SePay), khả dụng trên **cả Bot lẫn Mini_App**. User chọn nạp qua PayOS, hệ thống sinh một liên kết thanh toán PayOS; khi PayOS gửi webhook xác nhận, hệ thống **cộng tiền NGAY** vào số dư VND của User qua `Deposit_Service.completeDeposit` dùng chung (giống SePay), **không** đi qua trạng thái `awaiting_credit` và **không** cần tỷ giá (PayOS đã là VND).

Quyết định nền tảng đã chốt với người dùng:
- **Đơn vị nhập:** VND. Bổ sung Payment_Provider mới với thuộc tính đơn vị nhập `vnd`.
- **Định danh giao dịch & đối soát:** PayOS dùng `orderCode` là **số nguyên duy nhất sinh riêng** (theo timestamp/random), **KHÔNG** dùng thẳng `deposits.id`. `orderCode` lưu vào cột chung `correlation_ref`. Webhook map `orderCode` → Deposit qua `correlation_ref`.
- **Idempotency:** khoá theo `provider_txn_id` = `paymentLinkId` do PayOS cấp.
- **Cộng tiền:** NGAY khi webhook xác nhận hợp lệ, gọi `completeDeposit` trực tiếp (như SePay). KHÔNG dùng `markAwaitingCredit`/credit-awaiting; KHÔNG quy đổi tỷ giá.
- **Hạn mức & luật:** dùng CHUNG `deposit_limits` (`readDepositLimits`) và `Deposit_Policy` như SePay; không có min/max riêng cho PayOS.
- **Liên kết quay lại:** `returnUrl`/`cancelUrl` dùng CHUNG `system_config.miniapp_url` cho CẢ hai kênh (Bot lẫn Mini_App) — quyết định (A). Hệ thống hiện không có nguồn `bot_username`/deep-link nên tái dùng `miniapp_url` (đọc qua `readMiniAppUrl`). Nếu `miniapp_url` chưa cấu hình → PayOS_Provider không tạo được link (lỗi cấu hình).
- **Định danh provider mới:** bổ sung `ProviderId` `payos`; bổ sung `AmountUnit` `vnd` đã có (tái dùng).
- **Cấu hình credentials:** `PAYOS_CLIENT_ID` / `PAYOS_API_KEY` / `PAYOS_CHECKSUM_KEY`, đọc theo thứ tự DB-first (`system_config`/CMS) rồi mới tới env/secret.
- **Mặc định TẮT:** provider mới mặc định disabled tới khi Admin bật trong CMS qua cờ `payment_payos_enabled` (đúng cơ chế cho provider mới; chỉ `sepay` luôn-bật).
- **Khả dụng theo vùng:** quản lý qua `METHODS_BY_REGION`; PayOS thuộc vùng `vietnam`.
- **Bản địa hoá:** thông báo lỗi/hạn mức/thành công theo Language của User (vi/en).
- **CMS:** thêm card cấu hình credentials + công tắc bật/tắt PayOS.
- **Test:** mọi test tự khai schema `deposits` phải cập nhật theo schema mới.

Tài liệu này tập trung mô tả *cái gì* hệ thống phải làm. Chi tiết *làm như thế nào* (SQL cụ thể, abstraction code, đường dẫn file) thuộc tài liệu Thiết kế.

## Glossary

- **System**: Toàn bộ ứng dụng Telegram Shop Bot chạy trên một Cloudflare Worker.
- **Bot**: Thành phần xử lý webhook Telegram (lệnh, reply keyboard, inline keyboard).
- **Mini_App**: Ứng dụng Vue 3 chạy trong Telegram Web App.
- **CMS**: Ứng dụng Vue 3 quản trị, bảo vệ bằng JWT.
- **User**: Người dùng cuối tương tác qua Bot hoặc Mini_App; lưu ở bảng `users`, định danh bởi `telegram_id`.
- **Admin**: Người quản trị đăng nhập CMS.
- **Region**: Vùng của User, nhận một trong hai giá trị: `vietnam` hoặc `international`.
- **Language**: Ngôn ngữ hiển thị của User, nhận một trong hai giá trị: `vi` hoặc `en`.
- **Payment_Provider**: Một loại phương thức nạp tiền (ví dụ `sepay`, `cryptobot`, `payos`), mô tả qua giao diện `PaymentProvider`.
- **Deposit_Service**: Thành phần cộng tiền nạp dùng chung (`completeDeposit`, `markAwaitingCredit`), độc lập với Payment_Provider cụ thể.
- **Deposit**: Một yêu cầu nạp tiền lưu ở bảng `deposits`, vòng đời `pending` → `completed`/`expired`/`cancelled`/`awaiting_credit`.
- **Deposits_Table**: Bảng `deposits` trong cơ sở dữ liệu D1.
- **Correlation_Ref**: Cột chung `correlation_ref` của Deposits_Table — mã đối soát nội bộ do System sinh cho mỗi Deposit (ví dụ `transfer_code` của SePay, `orderCode` của PayOS).
- **Provider_Txn_Id**: Cột chung `provider_txn_id` của Deposits_Table — định danh giao dịch do phía provider cấp, dùng làm khoá idempotency.
- **Metadata**: Cột chung `metadata` của Deposits_Table — chuỗi JSON chứa dữ liệu đặc thù provider không thuộc các cột chung.
- **Schema_Migration**: File migration `0014_*.sql` rebuild Deposits_Table sang mô hình provider-agnostic.
- **PayOS**: Cổng thanh toán bên thứ ba nhận thanh toán VND qua liên kết thanh toán.
- **PayOS_Provider**: Payment_Provider mới nạp tiền qua PayOS, nhận VND, định danh `payos`.
- **Order_Code**: Số nguyên duy nhất do System sinh riêng (theo timestamp/random) cho mỗi yêu cầu nạp PayOS; lưu vào Correlation_Ref; KHÔNG bằng `deposits.id`.
- **Payment_Link**: Liên kết thanh toán PayOS tạo qua PayOS API; có URL để User thanh toán.
- **Payment_Link_Id**: Định danh `paymentLinkId` do PayOS cấp cho một Payment_Link; lưu vào Provider_Txn_Id làm khoá idempotency.
- **PayOS_Client**: Thành phần gọi HTTP tới PayOS API (`createPaymentLink`) và ký yêu cầu.
- **PayOS_Config**: Cấu hình credentials PayOS gồm `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY`.
- **Checksum_Key**: Khoá bí mật `PAYOS_CHECKSUM_KEY` dùng tính chữ ký HMAC-SHA256 cho yêu cầu và webhook PayOS.
- **Webhook_Handler**: Endpoint nhận callback xác nhận thanh toán từ PayOS.
- **Webhook_Signature**: Chữ ký HMAC-SHA256 trên dữ liệu webhook (các trường `data` sắp xếp theo khoá) dùng Checksum_Key để xác thực callback PayOS.
- **Deposit_Limits**: Hạn mức số tiền nạp VND (tối thiểu/tối đa) đọc qua `readDepositLimits` từ `system_config`, dùng chung mọi provider.
- **Deposit_Policy**: Luật chống lạm dụng dùng chung (cooldown + trần pending) áp cho mọi provider.
- **Provider_Enabled_Flag**: Cờ `system_config.payment_payos_enabled` quyết định PayOS_Provider có được mở cho User hay không.
- **Methods_By_Region**: Bảng tra `METHODS_BY_REGION` ánh xạ mỗi Region tới danh sách `ProviderId` khả dụng theo thứ tự hiển thị.
- **Return_Url**: Liên kết PayOS chuyển User về sau khi thanh toán thành công; dùng `system_config.miniapp_url` cho mọi kênh (quyết định A).
- **Cancel_Url**: Liên kết PayOS chuyển User về sau khi huỷ thanh toán; dùng `system_config.miniapp_url` cho mọi kênh (quyết định A).
- **MiniApp_Url**: Giá trị `system_config.miniapp_url` (đọc qua `readMiniAppUrl`) — nguồn dùng chung cho Return_Url/Cancel_Url.
- **Deposit_Method_Dto**: DTO `DepositMethodDto` trả ở `GET /api/app/deposit-methods` (`id`, `amount_unit`), có bản backend (`src/types/miniapp.ts`) và bản mirror frontend (`miniapp/src/types/index.ts`).
- **Deposit_View**: Màn `miniapp/src/views/DepositView.vue` của Mini_App cho User chọn phương thức và nhập số tiền nạp.
- **Secret_Config_Keys**: Tập key cấu hình nhạy cảm trong `src/routes/admin/config.ts` được mask khi GET và bỏ qua khi PUT giá trị rỗng.

## Requirements

### Requirement 1: Tổng quát hoá schema Deposits_Table qua migration 0014

**User Story:** Là nhà phát triển, tôi muốn Deposits_Table dùng các cột chung provider-agnostic, để thêm cổng thanh toán tương lai không cần migration DB.

#### Acceptance Criteria

1. THE System SHALL rebuild Deposits_Table thông qua một file Schema_Migration mới đặt tên theo tiền tố `0014_` mà SHALL không sửa bất kỳ migration đã chạy nào (`0001` đến `0013`).
2. THE Deposits_Table sau Schema_Migration SHALL có cột `correlation_ref` kiểu TEXT nullable làm Correlation_Ref dùng chung mọi provider.
3. THE Deposits_Table sau Schema_Migration SHALL có cột `provider_txn_id` kiểu TEXT nullable làm Provider_Txn_Id dùng chung mọi provider.
4. THE Deposits_Table sau Schema_Migration SHALL có cột `metadata` kiểu TEXT nullable lưu chuỗi JSON Metadata đặc thù provider.
5. THE Deposits_Table sau Schema_Migration SHALL khai báo cột `provider` kiểu TEXT không có ràng buộc CHECK trên danh sách giá trị provider.
6. THE Deposits_Table sau Schema_Migration SHALL loại bỏ các cột riêng theo provider `transfer_code`, `sepay_transaction_id`, `bank_ref`, `crypto_invoice_id`, `asset`, `usdt_amount`, `exchange_rate`.
7. THE Deposits_Table sau Schema_Migration SHALL giữ các cột chung `id`, `user_id`, `provider`, `amount`, `status`, `completed_at`, `expired_at`, `created_at`.
8. THE Deposits_Table sau Schema_Migration SHALL có một chỉ mục unique từng phần trên cặp (`provider`, `correlation_ref`) chỉ áp dụng khi `correlation_ref` không NULL.
9. THE Deposits_Table sau Schema_Migration SHALL có một chỉ mục unique từng phần trên cặp (`provider`, `provider_txn_id`) chỉ áp dụng khi `provider_txn_id` không NULL.

### Requirement 2: Migrate dữ liệu nạp tiền thật hiện có

**User Story:** Là Admin, tôi muốn dữ liệu nạp tiền thật hiện có được chuyển sang schema mới không mất mát, để lịch sử giao dịch và đối soát vẫn chính xác.

#### Acceptance Criteria

1. WHEN Schema_Migration được áp lên cơ sở dữ liệu có sẵn các hàng Deposit, THE System SHALL giữ nguyên `id`, `user_id`, `provider`, `amount`, `status`, `completed_at`, `expired_at`, `created_at` của mỗi hàng.
2. WHEN Schema_Migration chuyển một Deposit có `provider = 'sepay'`, THE System SHALL đặt `correlation_ref` bằng giá trị `transfer_code` cũ và `provider_txn_id` bằng giá trị `sepay_transaction_id` cũ, NGOẠI TRỪ khi `sepay_transaction_id` cũ bằng hằng số `'manual-approve'` thì THE System SHALL đặt `provider_txn_id` thành `'manual-' || id` (duy nhất theo Deposit) để không vi phạm chỉ mục unique `(provider, provider_txn_id)` khi có nhiều Deposit duyệt tay cũ.
3. WHEN Schema_Migration chuyển một Deposit có `provider = 'sepay'` mà có giá trị `bank_ref` cũ, THE System SHALL ghi `bank_ref` cũ vào Metadata dưới dạng JSON với khoá `bank_ref`.
4. WHEN Schema_Migration chuyển một Deposit có `provider = 'cryptobot'`, THE System SHALL đặt `correlation_ref` và `provider_txn_id` cùng bằng giá trị `crypto_invoice_id` cũ.
5. WHEN Schema_Migration chuyển một Deposit có `provider = 'cryptobot'`, THE System SHALL ghi vào Metadata dưới dạng JSON các khoá `asset`, `usdt_amount`, `exchange_rate` lấy từ các cột cũ tương ứng.
6. WHEN một giá trị nguồn dùng để dựng Correlation_Ref hoặc Provider_Txn_Id là NULL trong hàng cũ, THE System SHALL ghi NULL vào cột đích tương ứng cho hàng đó.

### Requirement 3: Cập nhật kiểu DB cho schema mới

**User Story:** Là nhà phát triển, tôi muốn kiểu TypeScript của Deposit khớp schema mới, để code biên dịch đúng và an toàn kiểu.

#### Acceptance Criteria

1. THE System SHALL cập nhật kiểu `DbDeposit` trong `src/types/db.ts` để có các trường `correlation_ref` (`string | null`), `provider_txn_id` (`string | null`) và `metadata` (`string | null`).
2. THE System SHALL loại bỏ khỏi kiểu `DbDeposit` các trường cột riêng đã bỏ: `transfer_code`, `sepay_transaction_id`, `bank_ref`, `crypto_invoice_id`, `asset`, `usdt_amount`, `exchange_rate`.
3. THE System SHALL khai báo trường `provider` của kiểu `DbDeposit` là kiểu chuỗi cho phép các giá trị `'sepay'`, `'cryptobot'`, `'payos'`.

### Requirement 4: Tổng quát hoá Deposit_Service và cập nhật mọi caller

**User Story:** Là nhà phát triển, tôi muốn `completeDeposit`/`markAwaitingCredit` và mọi nơi dùng schema cũ chuyển sang cột chung, để không còn phụ thuộc cột riêng theo provider.

#### Acceptance Criteria

1. THE System SHALL cập nhật `Deposit_Service.completeDeposit` để ghi định danh giao dịch provider vào cột chung `provider_txn_id` và dữ liệu đặc thù provider vào cột chung `metadata` thay cho các cột riêng đã bỏ.
2. THE System SHALL giữ tính nguyên tử (D1 `batch()`) và cơ chế chống cộng trùng theo trạng thái (chỉ hoàn tất khi Deposit còn `pending`, `expired`, hoặc `awaiting_credit`) của `Deposit_Service.completeDeposit` sau khi tổng quát hoá.
3. THE System SHALL cập nhật `Deposit_Service.markAwaitingCredit` để lưu dữ liệu đặc thù provider qua cột chung `metadata` thay cho cột riêng `usdt_amount`.
4. THE System SHALL cập nhật route webhook SePay để tạo và hoàn tất Deposit qua các cột chung (`correlation_ref` = transfer_code, `provider_txn_id` = mã giao dịch SePay, `metadata` chứa `bank_ref`).
5. THE System SHALL cập nhật route webhook CryptoBot để tra cứu, đối soát và hoàn tất Deposit qua các cột chung (`correlation_ref`/`provider_txn_id` = invoice id, `metadata` chứa `asset`/`usdt_amount`/`exchange_rate`).
6. THE System SHALL cập nhật dịch vụ credit-awaiting, SePay_Provider, CryptoPay_Provider, bot deposit callback, và Mini_App API để đọc/ghi Deposit qua các cột chung của schema mới.
7. THE System SHALL cập nhật call site `completeDeposit` trong `src/routes/admin/deposits.ts` (duyệt tay `POST /deposits/:id/approve`) sang chữ ký tổng quát mới, dùng một `provider_txn_id` DUY NHẤT theo từng Deposit (ví dụ `manual-<depositId>`) thay cho hằng số dùng chung, để không vi phạm chỉ mục unique `(provider, provider_txn_id)`; giữ hành vi duyệt tay chỉ cho `sepay`.
8. WHEN toàn bộ cập nhật Phần A hoàn tất, THE System SHALL biên dịch không lỗi kiểu và toàn bộ bộ test hiện có SHALL chạy đạt với schema mới.

### Requirement 5: Đăng ký PayOS_Provider theo nguyên tắc Open/Closed

**User Story:** Là nhà phát triển, tôi muốn thêm PayOS_Provider mà không sửa logic cộng tiền hay route lõi, để mở rộng phương thức nạp an toàn.

#### Acceptance Criteria

1. THE System SHALL cung cấp một PayOS_Provider hiện thực đầy đủ giao diện `PaymentProvider`, với thuộc tính định danh có giá trị `payos` và thuộc tính đơn vị nhập có giá trị `vnd`.
2. THE System SHALL đăng ký PayOS_Provider vào registry thanh toán dùng chung qua danh sách provider tích hợp sẵn, sao cho tra cứu registry theo định danh `payos` trả về đúng một instance PayOS_Provider.
3. THE System SHALL thực hiện cộng tiền cho mọi Deposit của PayOS_Provider duy nhất qua `Deposit_Service.completeDeposit` dùng chung, và SHALL không định nghĩa logic cộng tiền hay cập nhật số dư riêng bên trong PayOS_Provider.
4. THE System SHALL bổ sung giá trị `payos` vào kiểu `ProviderId`.

### Requirement 6: Cấu hình credentials PayOS theo thứ tự DB-first

**User Story:** Là Admin, tôi muốn cấu hình credentials PayOS trong CMS hoặc qua secret, để vận hành PayOS mà không sửa code.

#### Acceptance Criteria

1. THE System SHALL đọc từng giá trị PayOS_Config (`PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY`) theo thứ tự ưu tiên: giá trị trong `system_config` trước, sau đó tới giá trị env/secret của Worker.
2. WHERE một giá trị PayOS_Config có trong `system_config` với chuỗi không rỗng sau khi trim, THE System SHALL dùng giá trị từ `system_config` và SHALL không dùng giá trị env tương ứng.
3. WHERE một giá trị PayOS_Config trong `system_config` thiếu hoặc rỗng sau khi trim, THE System SHALL dùng giá trị env/secret tương ứng.
4. WHEN System ghi log liên quan tới PayOS_Config, THE System SHALL không ghi giá trị `PAYOS_API_KEY` hoặc `PAYOS_CHECKSUM_KEY` vào log.

### Requirement 7: PayOS_Client tạo Payment_Link và ký HMAC

**User Story:** Là System, tôi cần gọi PayOS API để tạo liên kết thanh toán có chữ ký hợp lệ, để User thanh toán được.

#### Acceptance Criteria

1. WHEN PayOS_Provider yêu cầu tạo một Payment_Link, THE PayOS_Client SHALL gọi PayOS `createPaymentLink` với các tham số bắt buộc gồm Order_Code, số tiền VND, mô tả, Return_Url và Cancel_Url.
2. WHEN PayOS_Client dựng yêu cầu tạo Payment_Link, THE PayOS_Client SHALL tính chữ ký HMAC-SHA256 trên dữ liệu yêu cầu bằng Checksum_Key và đính chữ ký vào yêu cầu theo định dạng PayOS yêu cầu.
3. WHEN PayOS API trả về Payment_Link thành công, THE PayOS_Client SHALL trả về cho caller URL thanh toán và Payment_Link_Id.
4. IF lời gọi PayOS API thất bại, trả mã lỗi nghiệp vụ, hoặc không phản hồi trong vòng 30 giây, THEN THE PayOS_Client SHALL ném lỗi rõ ràng và SHALL không trả về Payment_Link.
5. WHEN PayOS_Client ném lỗi, THE PayOS_Client SHALL không đưa giá trị `PAYOS_API_KEY` hoặc `PAYOS_CHECKSUM_KEY` vào thông điệp lỗi.

### Requirement 8: Khởi tạo yêu cầu nạp qua PayOS

**User Story:** Là một User, tôi muốn nhập số tiền VND và nhận liên kết thanh toán PayOS, để nạp vào số dư của tôi.

#### Acceptance Criteria

1. WHEN một User gửi yêu cầu nạp qua PayOS_Provider, THE PayOS_Provider SHALL sinh một Order_Code là số nguyên duy nhất (theo timestamp/random) khác `deposits.id` và SHALL không tái sử dụng giá trị Order_Code của một Deposit PayOS đang tồn tại.
2. WHEN PayOS_Provider chuẩn bị tạo Payment_Link, THE PayOS_Provider SHALL tạo một Deposit ở trạng thái `pending` với `provider = 'payos'` và lưu Order_Code vào Correlation_Ref của Deposit đó.
3. WHEN PayOS API trả về Payment_Link thành công, THE PayOS_Provider SHALL lưu Payment_Link_Id vào Provider_Txn_Id của Deposit và trả về URL thanh toán cho User.
4. WHEN PayOS_Provider tạo Payment_Link (bất kể kênh Bot hay Mini_App), THE PayOS_Provider SHALL dùng `system_config.miniapp_url` (đọc qua `readMiniAppUrl`) làm cả Return_Url và Cancel_Url (quyết định A).
5. IF `system_config.miniapp_url` chưa cấu hình (rỗng/null), THEN THE PayOS_Provider SHALL từ chối yêu cầu với thông báo lỗi cấu hình và SHALL không tạo Deposit.
6. IF số VND nhập vào không phải số nguyên dương, THEN THE PayOS_Provider SHALL từ chối yêu cầu với thông báo lỗi số tiền không hợp lệ và SHALL không tạo Deposit.

### Requirement 9: Hạn mức và luật nạp dùng chung

**User Story:** Là Admin, tôi muốn PayOS_Provider tuân thủ cùng hạn mức và luật chống lạm dụng như SePay, để vận hành nhất quán.

#### Acceptance Criteria

1. WHEN một User gửi yêu cầu nạp qua PayOS_Provider với số VND nhỏ hơn hạn mức tối thiểu trong Deposit_Limits hoặc lớn hơn hạn mức tối đa, THE PayOS_Provider SHALL từ chối yêu cầu với thông báo nêu rõ khoảng hạn mức VND và SHALL không tạo Deposit.
2. THE PayOS_Provider SHALL đọc hạn mức qua `readDepositLimits` dùng chung và SHALL không định nghĩa hạn mức tối thiểu hay tối đa riêng cho PayOS.
3. WHEN một User gửi yêu cầu nạp qua PayOS_Provider, THE PayOS_Provider SHALL áp dụng Deposit_Policy dùng chung (cooldown và trần pending) trước khi tạo Deposit.
4. IF Deposit_Policy chặn yêu cầu, THEN THE PayOS_Provider SHALL từ chối yêu cầu với thông báo nêu rõ lý do chặn kèm thời gian chờ còn lại tính bằng giây khi lý do là cooldown, và SHALL không tạo Deposit.

### Requirement 10: Bật/tắt PayOS_Provider qua cấu hình

**User Story:** Là Admin, tôi muốn PayOS_Provider mặc định tắt cho tới khi tôi bật trong CMS, để chỉ mở cho User sau khi đã chạy thử thành công.

#### Acceptance Criteria

1. WHERE Provider_Enabled_Flag chưa được cấu hình, THE System SHALL coi PayOS_Provider là tắt.
2. WHERE Provider_Enabled_Flag sau khi chuẩn hoá (trim khoảng trắng, chuyển chữ thường) bằng `1` hoặc `true`, THE System SHALL coi PayOS_Provider là bật.
3. WHERE Provider_Enabled_Flag có giá trị khác `1`/`true` (chuỗi rỗng, `0`, `false`, hoặc giá trị không hợp lệ), THE System SHALL coi PayOS_Provider là tắt.
4. WHEN System dựng danh sách phương thức nạp khả dụng trả về cho User VÀ PayOS_Provider đang tắt, THE System SHALL loại PayOS_Provider khỏi danh sách đó.
5. IF một User cố khởi tạo yêu cầu nạp qua PayOS_Provider trong khi provider đang tắt, THEN THE System SHALL từ chối yêu cầu, SHALL không tạo Deposit, và SHALL trả về thông báo cho biết phương thức không khả dụng.
6. THE System SHALL dùng key cấu hình `payment_payos_enabled` làm Provider_Enabled_Flag, theo đúng quy ước đặt tên key cờ provider hiện có.

### Requirement 11: Khả dụng theo vùng

**User Story:** Là một User, tôi muốn chỉ thấy PayOS_Provider ở vùng được phép, để danh sách phương thức nạp phù hợp với vùng của tôi.

#### Acceptance Criteria

1. THE System SHALL khai báo PayOS_Provider trong Methods_By_Region thuộc danh sách `ProviderId` của vùng `vietnam`, theo đúng thứ tự hiển thị mong muốn.
2. WHILE vùng của một User không chứa PayOS_Provider trong Methods_By_Region, THE System SHALL loại bỏ hoàn toàn PayOS_Provider khỏi danh sách phương thức nạp trả về cho User đó.
3. WHEN System dựng danh sách phương thức nạp cho một User, THE System SHALL chỉ bao gồm PayOS_Provider khi và chỉ khi cả hai điều kiện đồng thời đúng: (a) vùng của User chứa PayOS_Provider trong Methods_By_Region, VÀ (b) Provider_Enabled_Flag của PayOS_Provider đang ở trạng thái bật.
4. IF vùng của User bị thiếu hoặc không phải `vietnam` hay `international`, THEN THE System SHALL loại bỏ PayOS_Provider khỏi danh sách phương thức nạp trả về cho User đó.

### Requirement 12: Webhook xác nhận thanh toán PayOS

**User Story:** Là System, tôi cần nhận xác nhận thanh toán từ PayOS và cộng tiền đúng một lần, để số dư User được cập nhật chính xác.

#### Acceptance Criteria

1. THE System SHALL cung cấp một endpoint Webhook_Handler nhận callback xác nhận thanh toán từ PayOS.
2. WHEN một callback đến Webhook_Handler, THE System SHALL xác thực Webhook_Signature bằng HMAC-SHA256 trên các trường `data` sắp xếp theo khoá với Checksum_Key trước khi xử lý nghiệp vụ.
3. IF xác thực Webhook_Signature thất bại hoặc Checksum_Key cần cho xác thực bị thiếu, THEN THE Webhook_Handler SHALL từ chối callback, SHALL không cộng tiền, và SHALL giữ nguyên số dư User.
4. WHEN một callback PayOS đã xác thực báo một thanh toán thành công, THE Webhook_Handler SHALL tra cứu Deposit tương ứng bằng Correlation_Ref bằng Order_Code trong callback.
5. WHEN Webhook_Handler xác định được Deposit `pending` tương ứng từ một callback thanh toán thành công đã xác thực, THE Webhook_Handler SHALL gọi `Deposit_Service.completeDeposit` để cộng số tiền VND của Deposit và chuyển Deposit sang `completed`.
6. WHEN một callback PayOS đã xác thực tham chiếu một Deposit đã ở trạng thái `completed`, THE Webhook_Handler SHALL bỏ qua việc cộng tiền, giữ nguyên số dư, và phản hồi 200.
7. WHEN một callback PayOS đã xác thực không khớp Deposit nào hoặc biểu thị một sự kiện không phải thanh toán thành công, THE Webhook_Handler SHALL không cộng tiền và phản hồi 200.
8. IF `Deposit_Service.completeDeposit` trả lỗi cộng tiền tạm thời (`db_error`) sau khi thanh toán đã xác nhận, THEN THE Webhook_Handler SHALL giữ nguyên trạng thái Deposit trước đó và phản hồi 500 để PayOS gửi lại callback.
9. WHEN nhiều callback thành công đã xác thực cho cùng một Deposit được xử lý đồng thời hoặc lặp lại, THE System SHALL cộng tiền cho Deposit đó đúng một lần duy nhất.

### Requirement 13: Idempotency theo Payment_Link_Id và cộng tiền tức thì

**User Story:** Là System, tôi cần chống cộng tiền trùng cho cùng một thanh toán PayOS và cộng ngay khi xác nhận, để số dư chính xác và User nhận tiền nhanh.

#### Acceptance Criteria

1. WHEN PayOS_Provider tạo một Deposit PayOS thành công, THE System SHALL gán Payment_Link_Id vào Provider_Txn_Id của Deposit đó, với ràng buộc mỗi cặp (`provider`, Provider_Txn_Id) ánh xạ tới nhiều nhất một Deposit.
2. WHEN một callback thanh toán thành công đã xác thực được xử lý cho một Deposit còn `pending`, THE System SHALL cộng tiền NGAY qua `Deposit_Service.completeDeposit` và SHALL không chuyển Deposit sang `awaiting_credit`.
3. THE PayOS_Provider và Webhook_Handler SHALL không thực hiện quy đổi tỷ giá và SHALL cộng đúng số tiền VND đã ghi trên Deposit.
4. WHEN nhiều callback trùng cho cùng một thanh toán PayOS đã được cộng tiền, THE System SHALL bỏ qua việc cộng tiền lặp và giữ nguyên số dư.

### Requirement 14: Dọn dẹp khi tạo Payment_Link thất bại

**User Story:** Là System, tôi không muốn để lại Deposit `pending` mồ côi khi tạo Payment_Link thất bại, để dữ liệu nạp tiền sạch và không chiếm slot pending sai.

#### Acceptance Criteria

1. IF việc tạo Payment_Link qua PayOS API thất bại VÀ Deposit tương ứng vẫn ở trạng thái `pending` VÀ chưa được gắn Payment_Link_Id, THEN THE PayOS_Provider SHALL xóa Deposit `pending` tương ứng đó.
2. IF việc tạo Payment_Link thất bại NHƯNG Deposit tương ứng không còn ở trạng thái `pending` HOẶC đã được gắn Payment_Link_Id, THEN THE PayOS_Provider SHALL giữ nguyên Deposit đó mà không xóa.
3. IF việc tạo Payment_Link thất bại, THEN THE PayOS_Provider SHALL trả về lỗi provider cho caller với thông báo chung không kèm chi tiết kỹ thuật nội bộ (không stack trace, không thông điệp nguyên gốc từ PayOS API).
4. WHEN PayOS_Provider trả về lỗi provider cho User, THE PayOS_Provider SHALL ghi log nội bộ chi tiết lỗi gốc phục vụ chẩn đoán, tách biệt với thông báo chung hiển thị cho User.

### Requirement 15: Bản địa hoá thông báo

**User Story:** Là một User, tôi muốn nhận thông báo nạp tiền bằng ngôn ngữ của tôi, để hiểu rõ trạng thái giao dịch.

#### Acceptance Criteria

1. WHEN PayOS_Provider trả về một thông báo lỗi hoặc hạn mức cho một User có Language hợp lệ (`vi` hoặc `en`), THE System SHALL hiển thị thông báo theo Language đó với nội dung phản ánh đúng loại lỗi/hạn mức.
2. WHEN một thanh toán PayOS được cộng tiền thành công cho một User có Language hợp lệ, THE System SHALL gửi cho User thông báo thành công theo Language đó, bao gồm số tiền đã cộng và số dư mới.
3. IF Language của User thiếu hoặc không thuộc {`vi`, `en`}, THEN THE System SHALL hiển thị thông báo theo Default_Language của hệ thống (đọc qua chuỗi fallback dùng chung `resolveLang`: `user.language` → `default_language` trong `system_config` → `BASE_FALLBACK_LANG`), nhất quán với quy ước ngôn ngữ mặc định toàn hệ thống của spec `multi-region-payments` (mặc định `en` khi `default_language` chưa cấu hình; admin có thể đặt `default_language='vi'`).
4. IF việc gửi thông báo thành công cho User thất bại, THEN THE System SHALL giữ nguyên số dư đã cộng (không hoàn tác) và ghi nhận lỗi gửi.

### Requirement 16: Cấu hình PayOS trong CMS

**User Story:** Là Admin, tôi muốn cấu hình credentials và bật/tắt PayOS trong CMS, để quản lý phương thức nạp mà không cần truy cập hệ thống.

#### Acceptance Criteria

1. THE CMS SHALL cung cấp một card cấu hình PayOS cho phép Admin nhập và lưu `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY` vào `system_config`.
2. THE CMS SHALL cung cấp một công tắc bật/tắt PayOS ghi vào cờ `payment_payos_enabled`.
3. WHEN Admin lưu cấu hình PayOS trong CMS, THE System SHALL lưu các giá trị vào `system_config` để PayOS_Config đọc theo thứ tự DB-first.
4. THE CMS SHALL hiển thị nhãn và văn bản card PayOS theo Language hiện hành của CMS (vi/en).

### Requirement 17: Cập nhật test theo schema mới

**User Story:** Là nhà phát triển, tôi muốn mọi test tự khai schema Deposits_Table được cập nhật, để bộ test phản ánh schema mới và chạy đạt.

#### Acceptance Criteria

1. THE System SHALL cập nhật mọi test tự khai (tự dựng) schema Deposits_Table để dùng các cột chung `correlation_ref`, `provider_txn_id`, `metadata` và loại bỏ các cột riêng đã bỏ.
2. THE System SHALL cập nhật các script e2e (`test/e2e_full_flow.sh`, `test/sepay_flow_test.sh`) để mọi `INSERT`/`SELECT` trên `deposits` dùng `correlation_ref` thay cho `transfer_code` (provider mặc định `sepay`), sao cho script chạy được trên schema mới.
3. WHEN bộ test được chạy sau khi cập nhật, THE System SHALL không có test thất bại do lệch schema Deposits_Table.
4. THE System SHALL bổ sung test bao phủ luồng PayOS_Provider tạo Deposit và Webhook_Handler cộng tiền idempotent theo Payment_Link_Id.

### Requirement 18: DTO phương thức nạp hỗ trợ PayOS (backend + frontend mirror)

**User Story:** Là nhà phát triển, tôi muốn các DTO nạp tiền biết tới `payos`, để type khớp giữa backend và frontend và biên dịch đúng.

#### Acceptance Criteria

1. THE System SHALL mở rộng `DepositMethodDto.id` để bao gồm `'payos'` ở cả `src/types/miniapp.ts` và bản mirror `miniapp/src/types/index.ts`.
2. THE System SHALL mở rộng `DepositStatusDto.provider` để bao gồm `'payos'` ở cả hai file DTO nói trên.
3. THE System SHALL bổ sung một DTO kết quả tạo nạp PayOS (ví dụ `PayosDepositCreatedDto`) chứa `deposit_id`, `method='payos'`, `checkout_url`, `amount`, `amount_display`, `status='pending'` ở cả hai file DTO.
4. THE System SHALL cập nhật bảng tra `amountUnitByProvider` trong `src/routes/miniapp-api.ts` để có entry `payos` với đơn vị `vnd`, sao cho `GET /api/app/deposit-methods` không lỗi kiểu khi `ProviderId` có `payos`.
5. WHEN một User gọi `POST /api/app/deposits` với `method='payos'` hợp lệ, THE Mini_App API SHALL gọi PayOS_Provider và trả `PayosDepositCreatedDto` với `checkout_url` để client mở.

### Requirement 19: Mini App hiển thị và xử lý PayOS

**User Story:** Là một User dùng Mini_App, tôi muốn chọn PayOS và nhận liên kết thanh toán, để nạp tiền ngay trong Mini_App.

#### Acceptance Criteria

1. THE Deposit_View SHALL coi `payos` là một phương thức hợp lệ (không còn giới hạn cứng ở `'sepay' | 'cryptobot'`), bao gồm kiểu `Method`, giá trị `selectedMethod` mặc định theo danh sách trả về, và xử lý sự kiện chọn trên SegmentedControl.
2. WHEN phương thức đang chọn là `payos`, THE Deposit_View SHALL nhập số tiền theo VND (giống SePay: grid mệnh giá + nhập số nguyên) và SHALL không áp logic USDT/tỷ giá.
3. WHEN User xác nhận nạp qua `payos`, THE Deposit_View SHALL gọi `POST /api/app/deposits` với `{ method: 'payos', amount }`, mở `checkout_url` trả về, và poll trạng thái như các phương thức hiện có.
4. THE Deposit_View SHALL hiển thị nhãn/mô tả riêng cho PayOS (không dùng nhãn của SePay hay CryptoBot) qua khoá i18n Mini_App vi/en mới.
5. WHILE `payos` không nằm trong danh sách `GET /api/app/deposit-methods` trả về, THE Deposit_View SHALL không hiển thị tuỳ chọn PayOS.

### Requirement 20: Bot hiển thị và xử lý PayOS

**User Story:** Là một User dùng Bot, tôi muốn chọn PayOS trong menu nạp tiền và nhận liên kết thanh toán, để nạp tiền qua Bot.

#### Acceptance Criteria

1. THE Bot deposit flow SHALL chấp nhận `payos` là phương thức hợp lệ trong bước chọn phương thức (`dep:method:<id>`), gỡ bỏ ràng buộc cứng chỉ cho `'sepay'`/`'cryptobot'`, đồng thời vẫn enforce khả dụng theo vùng và cờ bật.
2. WHEN User chọn `payos` trong Bot, THE Bot SHALL điều phối vào sub-flow PayOS (nhập số VND như SePay) thay vì sub-flow SePay hoặc CryptoBot.
3. WHEN PayOS_Provider tạo Payment_Link thành công trong luồng Bot, THE Bot SHALL gửi cho User một nút inline mở `checkout_url`.
4. THE Bot SHALL có khoá i18n `deposit.method.payos` (vi/en) làm nhãn phương thức PayOS trong menu chọn.

### Requirement 21: Mask credentials PayOS trong cấu hình admin

**User Story:** Là Admin, tôi muốn credentials PayOS được bảo vệ như các secret khác trong CMS, để không bị lộ hay xoá nhầm.

#### Acceptance Criteria

1. THE System SHALL thêm `payos_api_key` và `payos_checksum_key` vào Secret_Config_Keys trong `src/routes/admin/config.ts`.
2. WHEN `GET /api/admin/config` trả cấu hình, THE System SHALL mask `payos_api_key` và `payos_checksum_key` (trả rỗng) và báo trạng thái đã đặt qua `secrets_set`, KHÔNG trả giá trị thật.
3. WHEN `PUT /api/admin/config` nhận `payos_api_key` hoặc `payos_checksum_key` với giá trị rỗng sau trim, THE System SHALL bỏ qua (giữ nguyên giá trị secret hiện có) thay vì ghi đè rỗng.
4. WHERE `payos_client_id` không phải secret, THE System SHALL cho phép hiển thị/ghi như cấu hình thường (không mask).

### Requirement 22: CMS DepositsView khớp schema mới + hỗ trợ PayOS

**User Story:** Là Admin, tôi muốn màn quản lý nạp tiền trong CMS hiển thị đúng theo schema mới và nhận diện PayOS, để theo dõi giao dịch không bị vỡ sau migration.

#### Acceptance Criteria

1. THE System SHALL cập nhật interface và template `cms/src/views/DepositsView.vue` để KHÔNG còn phụ thuộc các trường cột riêng đã bỏ (`transfer_code`, `sepay_transaction_id`, `bank_ref`, `crypto_invoice_id`, `asset`, `usdt_amount`, `exchange_rate`).
2. THE DepositsView SHALL đọc dữ liệu hiển thị từ các cột chung mới: mã đối soát từ `correlation_ref`, định danh giao dịch provider từ `provider_txn_id`, và dữ liệu đặc thù (asset/usdt_amount/exchange_rate/bank_ref) parse từ `metadata` (JSON).
3. THE DepositsView SHALL mở rộng union `provider` để bao gồm `'payos'` và hiển thị nhãn provider tương ứng cho `payos`.
4. WHEN bản build CMS được chạy sau cập nhật, THE System SHALL biên dịch `DepositsView.vue` không lỗi kiểu (vue-tsc).

### Requirement 23: PayOS Deposit không cho huỷ thủ công (tránh mất tiền)

**User Story:** Là System, tôi không muốn User huỷ một Deposit PayOS rồi vẫn thanh toán trên trang PayOS, để tiền đã trả luôn được cộng đúng.

#### Acceptance Criteria

1. THE System SHALL không cho phép huỷ thủ công một Deposit có `provider = 'payos'`; Mini_App và Bot SHALL không hiển thị thao tác huỷ cho Deposit PayOS.
2. WHEN một yêu cầu huỷ (`POST /api/app/deposits/:id/cancel` hoặc thao tác huỷ trong Bot) nhắm vào một Deposit có `provider = 'payos'`, THE System SHALL từ chối chuyển Deposit sang `cancelled` và giữ nguyên trạng thái hiện tại của Deposit.
3. THE System SHALL để một Deposit PayOS `pending` hết hạn theo TTL chung (chuyển `expired` qua cron), KHÔNG qua trạng thái `cancelled`, sao cho một thanh toán xác nhận tới sau vẫn được `completeDeposit` cộng tiền (vì guard cho phép hoàn tất từ `pending` và `expired`).
4. THE System SHALL không thay đổi guard trạng thái của `completeDeposit` để đạt được hành vi này.

### Requirement 24: Đăng ký Webhook URL với PayOS

**User Story:** Là Admin, tôi muốn đăng ký webhook URL với PayOS từ CMS, để PayOS gửi callback xác nhận thanh toán về hệ thống.

#### Acceptance Criteria

1. THE System SHALL cung cấp một endpoint admin (bảo vệ JWT) để đăng ký webhook URL của hệ thống với PayOS thông qua API `confirm-webhook` của PayOS, dùng `PAYOS_CLIENT_ID`/`PAYOS_API_KEY` đã cấu hình.
2. THE CMS SHALL cung cấp thao tác (nút) trong card PayOS để Admin kích hoạt đăng ký webhook URL `${origin}/webhook/payos`.
3. WHEN PayOS xác nhận đăng ký thành công, THE System SHALL báo kết quả thành công cho Admin; IF đăng ký thất bại, THEN THE System SHALL báo lỗi cho Admin và SHALL không ghi giá trị `PAYOS_API_KEY`/`PAYOS_CHECKSUM_KEY` vào log.
4. WHEN Webhook_Handler nhận callback ping kiểm tra từ PayOS (orderCode không khớp Deposit nào), THE Webhook_Handler SHALL phản hồi 200 mà không cộng tiền.
