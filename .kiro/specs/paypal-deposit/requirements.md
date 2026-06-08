# Requirements Document

## Introduction

Tính năng này bổ sung **PayPal** làm một phương thức nạp tiền (top-up) mới cho Telegram Shop Bot, khả dụng trên **cả Bot lẫn Mini App**. PayPal nhận thanh toán bằng **USD**; User nhập số tiền USD, hệ thống quy đổi sang VND theo tỷ giá thủ công sẵn có rồi cộng vào số dư VND duy nhất của User (giống cơ chế hiện hành của CryptoPay_Provider).

Tính năng tuân thủ nghiêm ngặt **nguyên tắc Open/Closed** của lớp trừu tượng thanh toán hiện có trong `src/services/payments/`: bổ sung một `PaymentProvider` mới (`paypal`) và đăng ký vào registry, **KHÔNG sửa** logic cộng tiền dùng chung (`deposit-service.completeDeposit`), luật/hạn mức nạp dùng chung, hay route lõi của Bot/Mini App.

Quyết định nền tảng đã chốt với người dùng:
- **Đơn vị nhập:** PayPal nhận **USD**. User nhập số tiền USD. Bổ sung một AmountUnit mới `usd`.
- **Quy đổi USD → VND:** Tái dùng **nguyên trạng** key tỷ giá `exchange_rate_usdt_vnd` trong `system_config` (USD được xử lý như USDT cho mục đích quy đổi). **Bỏ qua** tỷ giá FX của PayPal. `creditVnd = floor(usdAmount × rate)` — làm tròn xuống, phản chiếu hành vi CryptoPay_Provider hiện có.
- **Định danh provider mới:** Bổ sung ProviderId `paypal`.
- **Mặc định TẮT:** Provider mặc định **disabled** cho tới khi Admin bật trong CMS qua cờ `system_config.payment_paypal_enabled` (đúng cơ chế R7.6 cho provider mới; chỉ `sepay` luôn-bật).
- **Khả dụng theo vùng:** Quản lý qua `METHODS_BY_REGION` trong `registry.ts`.
- **Xác nhận thanh toán:** Dùng PayPal Checkout Orders API v2 (tạo order → User duyệt qua approve URL → capture/confirm qua webhook). Một Webhook_Handler + middleware xác thực nhận xác nhận từ PayPal và gọi `completeDeposit` dùng chung (idempotent).
- **Idempotency:** Khoá theo **PayPal order id** lưu trong bảng `deposits` (cột mới qua migration mới); cập nhật union `provider` và cột order id trong `src/types/db.ts`.
- **Luật & hạn mức dùng chung:** Cooldown, trần pending, và hạn mức VND áp dụng đồng nhất như CryptoPay_Provider.
- **Credentials:** Client ID/Secret cấp qua `wrangler secret` cho production, `.dev.vars` cho local.
- **Bản địa hoá:** Thông báo lỗi/hạn mức/thành công tôn trọng ngôn ngữ User (vi/en) như các provider hiện có.
- **Rủi ro nghiệp vụ:** PayPal có tranh chấp (dispute)/bồi hoàn (chargeback)/hoàn tiền (refund) khác với chuyển khoản một chiều và crypto không thể đảo ngược. Phạm vi tài liệu này: **chỉ cộng tiền cho thanh toán đã capture thành công**; xử lý dispute/refund sau capture được ghi nhận là ràng buộc/cân nhắc, không tự động trừ số dư trong phạm vi này.

Tài liệu này tập trung mô tả *cái gì* hệ thống phải làm. Chi tiết *làm như thế nào* (schema, abstraction code, file) thuộc tài liệu Thiết kế.

## Glossary

- **System**: Toàn bộ ứng dụng Telegram Shop Bot chạy trên một Cloudflare Worker.
- **Bot**: Thành phần xử lý webhook Telegram (lệnh, reply keyboard, inline keyboard).
- **Mini_App**: Ứng dụng Vue 3 chạy trong Telegram Web App, phục vụ tại base `/app/`.
- **CMS**: Ứng dụng Vue 3 quản trị, phục vụ tại `/cms/`, bảo vệ bằng JWT.
- **User**: Người dùng cuối tương tác qua Bot hoặc Mini_App; lưu trong bảng `users`, định danh bởi `telegram_id`.
- **Admin**: Người quản trị đăng nhập CMS.
- **Region**: Vùng của User, nhận một trong hai giá trị: `vietnam` hoặc `international`.
- **Language**: Ngôn ngữ hiển thị của User, nhận một trong hai giá trị: `vi` hoặc `en`.
- **Payment_Provider**: Một loại phương thức nạp tiền (ví dụ `sepay`, `cryptobot`, `paypal`), mô tả bằng định danh loại thống nhất qua giao diện `PaymentProvider`.
- **PayPal_Provider**: Payment_Provider mới nạp tiền qua PayPal, nhận USD, định danh `paypal`.
- **Deposit_Service**: Thành phần cộng tiền nạp dùng chung (`completeDeposit`), độc lập với Payment_Provider cụ thể.
- **Deposit**: Một yêu cầu nạp tiền lưu ở bảng `deposits`, có vòng đời trạng thái `pending` → `completed`/`expired`/`cancelled`/`awaiting_credit`.
- **PayPal_Order**: Order tạo qua PayPal Checkout Orders API v2; có `approve_url` để User duyệt và một định danh order id.
- **PayPal_Order_Id**: Định danh duy nhất của PayPal_Order, lưu trong `deposits` làm khoá idempotency cho PayPal_Provider.
- **Approve_Url**: Liên kết PayPal để User phê duyệt và thanh toán cho một PayPal_Order.
- **Webhook_Handler**: Thành phần nhận callback từ PayPal để xác nhận thanh toán đã capture.
- **PayPal_Auth_Middleware**: Middleware xác thực tính hợp lệ của callback PayPal trước khi xử lý.
- **Exchange_Rate**: Tỷ giá quy đổi 1 USD/USDT sang VND, lưu ở key `exchange_rate_usdt_vnd` trong `system_config`.
- **Deposit_Limits**: Hạn mức số tiền nạp đọc từ `system_config` (VND tối thiểu/tối đa) dùng chung mọi provider.
- **Deposit_Policy**: Luật chống lạm dụng dùng chung (cooldown + trần pending) áp cho mọi provider.
- **Provider_Enabled_Flag**: Cờ `system_config.payment_paypal_enabled` quyết định PayPal_Provider có được mở cho User hay không.
- **USD**: Đơn vị tiền PayPal nhận thanh toán; User nhập theo USD.
- **PayPal_Min_USD**: Số USD tối thiểu cho một yêu cầu nạp qua PayPal_Provider; cấu hình được trong `system_config`, mặc định 5 USD khi chưa cấu hình.

## Requirements

### Requirement 1: Đăng ký PayPal_Provider theo nguyên tắc Open/Closed

**User Story:** Là nhà phát triển, tôi muốn thêm PayPal_Provider mà không sửa logic cộng tiền hay route lõi, để mở rộng phương thức nạp an toàn và không gây hồi quy.

#### Acceptance Criteria

1. THE System SHALL cung cấp một PayPal_Provider hiện thực đầy đủ giao diện `PaymentProvider` (gồm thuộc tính định danh, thuộc tính đơn vị nhập, và thao tác tạo yêu cầu nạp), với thuộc tính định danh có giá trị `paypal` và thuộc tính đơn vị nhập có giá trị `usd`.
2. THE System SHALL đăng ký PayPal_Provider vào registry thanh toán dùng chung thông qua danh sách provider tích hợp sẵn, sao cho việc tra cứu registry theo định danh `paypal` trả về đúng một instance PayPal_Provider.
3. THE System SHALL thực hiện cộng tiền (cập nhật số dư) cho mọi Deposit của PayPal_Provider duy nhất thông qua `Deposit_Service.completeDeposit` dùng chung, và SHALL không định nghĩa bất kỳ logic cộng tiền hoặc cập nhật số dư riêng nào bên trong PayPal_Provider.
4. THE System SHALL bổ sung giá trị `paypal` vào kiểu `ProviderId`.
5. THE System SHALL bổ sung giá trị `usd` vào kiểu `AmountUnit`.

### Requirement 2: Khởi tạo yêu cầu nạp qua PayPal

**User Story:** Là một User, tôi muốn nhập số tiền USD và nhận liên kết thanh toán PayPal, để nạp tiền vào số dư của tôi.

#### Acceptance Criteria

1. WHEN một User gửi yêu cầu nạp qua PayPal_Provider với một số USD nằm trong khoảng từ 1.00 đến 10,000.00 (tối đa 2 chữ số thập phân), THE PayPal_Provider SHALL quy đổi sang VND theo công thức `creditVnd = floor(usdAmount × Exchange_Rate)`.
2. WHEN PayPal_Provider tạo một PayPal_Order thành công, THE PayPal_Provider SHALL tạo một Deposit ở trạng thái `pending` với `provider = 'paypal'` và lưu PayPal_Order_Id vào Deposit.
3. WHEN PayPal_Provider tạo Deposit `pending` thành công, THE PayPal_Provider SHALL trả về Approve_Url tương ứng với PayPal_Order để User phê duyệt thanh toán.
4. IF Exchange_Rate thiếu hoặc không phải số dương hợp lệ, THEN THE PayPal_Provider SHALL từ chối yêu cầu với thông báo lỗi tỷ giá chưa cấu hình và SHALL không tạo Deposit.
5. IF số USD nhập vào không phải số dương hữu hạn, nhỏ hơn 1.00, lớn hơn 10,000.00, hoặc có nhiều hơn 2 chữ số thập phân, THEN THE PayPal_Provider SHALL từ chối yêu cầu với thông báo lỗi số tiền không hợp lệ và SHALL không tạo Deposit.
6. WHEN PayPal_Provider được khởi tạo từ Bot, THE PayPal_Provider SHALL trả về Approve_Url phù hợp với kênh Bot; WHEN được khởi tạo từ Mini_App, THE PayPal_Provider SHALL trả về Approve_Url phù hợp với kênh Mini_App.
7. IF việc tạo PayPal_Order tại PayPal API thất bại hoặc không phản hồi trong vòng 30 giây, THEN THE PayPal_Provider SHALL từ chối yêu cầu với thông báo lỗi không tạo được đơn thanh toán và SHALL không tạo Deposit.

### Requirement 3: Hạn mức và luật nạp dùng chung

**User Story:** Là Admin, tôi muốn PayPal_Provider tuân thủ cùng hạn mức và luật chống lạm dụng như các provider khác, để vận hành nhất quán và an toàn.

#### Acceptance Criteria

1. WHEN một User gửi yêu cầu nạp qua PayPal_Provider với số USD nhỏ hơn PayPal_Min_USD (so sánh: số USD nhập vào < PayPal_Min_USD; bằng PayPal_Min_USD được chấp nhận), THE PayPal_Provider SHALL từ chối yêu cầu với thông báo nêu rõ mức USD tối thiểu hiện hành và SHALL không tạo Deposit.
2. IF PayPal_Min_USD chưa được cấu hình trong `system_config`, THEN THE PayPal_Provider SHALL áp dụng giá trị mặc định PayPal_Min_USD bằng 5 USD.
3. WHEN giá trị `creditVnd` quy đổi vượt quá hạn mức VND tối đa trong Deposit_Limits, THE PayPal_Provider SHALL từ chối yêu cầu với thông báo nêu rõ hạn mức VND tối đa và SHALL không tạo Deposit.
4. WHEN một User gửi yêu cầu nạp qua PayPal_Provider, THE PayPal_Provider SHALL áp dụng Deposit_Policy dùng chung (cooldown và trần pending) trước khi tạo Deposit.
5. IF Deposit_Policy chặn yêu cầu, THEN THE PayPal_Provider SHALL từ chối yêu cầu với thông báo nêu rõ lý do chặn (cooldown chưa kết thúc, hoặc đã đạt trần số Deposit pending) kèm thời gian chờ còn lại tính bằng giây khi lý do là cooldown, và SHALL không tạo Deposit.

### Requirement 4: Bật/tắt provider qua cấu hình

**User Story:** Là Admin, tôi muốn PayPal_Provider mặc định tắt cho tới khi tôi bật trong CMS, để chỉ mở cho User sau khi đã chạy thử thành công.

#### Acceptance Criteria

1. WHERE Provider_Enabled_Flag chưa được cấu hình, THE System SHALL coi PayPal_Provider là tắt.
2. WHERE Provider_Enabled_Flag sau khi chuẩn hoá (trim khoảng trắng, chuyển chữ thường) bằng `1` hoặc `true`, THE System SHALL coi PayPal_Provider là bật.
3. WHERE Provider_Enabled_Flag có giá trị khác `1`/`true` (chuỗi rỗng, `0`, `false`, hoặc giá trị không hợp lệ), THE System SHALL coi PayPal_Provider là tắt.
4. WHEN System dựng danh sách phương thức nạp khả dụng trả về cho User VÀ PayPal_Provider đang tắt, THE System SHALL loại PayPal_Provider khỏi danh sách đó.
5. IF một User cố khởi tạo yêu cầu nạp qua PayPal_Provider trong khi provider đang tắt, THEN THE System SHALL từ chối yêu cầu, SHALL không tạo Deposit, và SHALL trả về thông báo cho biết phương thức không khả dụng.
6. THE System SHALL dùng key cấu hình `payment_paypal_enabled` làm Provider_Enabled_Flag, theo đúng quy ước đặt tên key cờ provider hiện có.

### Requirement 5: Khả dụng theo vùng

**User Story:** Là một User, tôi muốn chỉ thấy PayPal_Provider ở những vùng được phép, để danh sách phương thức nạp phù hợp với vùng của tôi.

#### Acceptance Criteria

1. THE System SHALL lưu trong bảng tra `METHODS_BY_REGION` một ánh xạ từ mỗi vùng hợp lệ (`vietnam` hoặc `international`) tới danh sách `ProviderId` được phép, theo đúng thứ tự hiển thị; PayPal_Provider chỉ khả dụng ở vùng mà `ProviderId` của nó xuất hiện trong danh sách tương ứng.
2. WHILE vùng của một User không chứa PayPal_Provider trong `METHODS_BY_REGION`, THE System SHALL loại bỏ hoàn toàn PayPal_Provider khỏi danh sách phương thức nạp trả về cho User đó (không hiển thị mục PayPal dưới bất kỳ trạng thái nào).
3. WHEN System dựng danh sách phương thức nạp cho một User, THE System SHALL chỉ bao gồm PayPal_Provider khi và chỉ khi cả hai điều kiện đồng thời đúng: (a) vùng của User chứa PayPal_Provider trong `METHODS_BY_REGION`, VÀ (b) `Provider_Enabled_Flag` của PayPal_Provider đang ở trạng thái bật.
4. WHEN System dựng danh sách phương thức nạp cho một User, THE System SHALL sắp xếp các phương thức được bao gồm theo đúng thứ tự `ProviderId` đã khai báo trong danh sách của vùng đó trong `METHODS_BY_REGION`.
5. IF vùng của User bị thiếu hoặc không phải `vietnam` hay `international`, THEN THE System SHALL loại bỏ PayPal_Provider khỏi danh sách phương thức nạp trả về cho User đó.

### Requirement 6: Webhook xác nhận thanh toán PayPal

**User Story:** Là System, tôi cần nhận xác nhận thanh toán từ PayPal và cộng tiền đúng một lần, để số dư User được cập nhật chính xác.

#### Acceptance Criteria

1. THE System SHALL cung cấp một endpoint Webhook_Handler nhận callback xác nhận thanh toán từ PayPal và phản hồi trong vòng 10 giây kể từ khi nhận callback.
2. WHEN một callback PayPal báo một PayPal_Order đã được capture thành công VÀ Exchange_Rate là số dương (> 0), THE Webhook_Handler SHALL quy đổi `creditVnd = floor(usdAmount × Exchange_Rate)` và gọi `Deposit_Service.completeDeposit` cho Deposit tương ứng với PayPal_Order_Id.
3. WHEN một callback PayPal báo một sự kiện không phải capture thành công, THE Webhook_Handler SHALL không cộng tiền và SHALL phản hồi báo PayPal không cần gửi lại callback.
4. WHEN một callback PayPal tham chiếu một PayPal_Order_Id mà Deposit tương ứng đã ở trạng thái `completed`, THE Webhook_Handler SHALL bỏ qua việc cộng tiền, giữ nguyên số dư, và phản hồi báo không cần gửi lại callback.
5. WHEN một callback PayPal tham chiếu một PayPal_Order_Id không khớp Deposit nào, THE Webhook_Handler SHALL không cộng tiền và phản hồi báo không cần gửi lại callback.
6. IF Exchange_Rate thiếu, không phải số, hoặc nhỏ hơn hoặc bằng 0 tại thời điểm nhận callback capture thành công, THEN THE Webhook_Handler SHALL giữ Deposit ở trạng thái `awaiting_credit` mà không cộng tiền và không đánh dấu thất bại.
7. IF `Deposit_Service.completeDeposit` trả lỗi cộng tiền tạm thời (`db_error`) sau khi thanh toán đã được xác nhận, THEN THE Webhook_Handler SHALL giữ nguyên trạng thái Deposit trước đó (không đánh dấu hoàn tất) và phản hồi báo lỗi để PayPal gửi lại callback.
8. WHEN nhiều callback capture thành công cho cùng một PayPal_Order_Id được xử lý đồng thời hoặc lặp lại, THE System SHALL cộng tiền cho Deposit tương ứng đúng một lần duy nhất.

### Requirement 7: Idempotency theo PayPal order id

**User Story:** Là System, tôi cần chống cộng tiền trùng cho cùng một thanh toán PayPal, để số dư không bị cộng nhiều lần.

#### Acceptance Criteria

1. THE System SHALL lưu PayPal_Order_Id của mỗi Deposit PayPal trong một cột riêng của bảng `deposits`, với ràng buộc mỗi PayPal_Order_Id ánh xạ tới nhiều nhất một Deposit.
2. WHEN PayPal_Provider tạo một Deposit PayPal, THE System SHALL gắn PayPal_Order_Id vào Deposit đó tại thời điểm khởi tạo.
3. WHEN Webhook_Handler cần xác định Deposit để cộng tiền, THE System SHALL tra cứu Deposit bằng PayPal_Order_Id làm khoá.
4. WHEN một callback capture thành công được xử lý cho một PayPal_Order_Id, THE System SHALL cộng tiền cho Deposit tương ứng đúng một lần duy nhất thông qua cập nhật có điều kiện theo trạng thái (chỉ cộng khi Deposit còn `pending`).
5. WHEN một callback PayPal tham chiếu một PayPal_Order_Id không khớp Deposit nào, THE System SHALL không cộng tiền và không tạo bản ghi mới.
6. WHEN nhiều callback trùng cho cùng một PayPal_Order_Id đã được cộng tiền, THE System SHALL bỏ qua việc cộng tiền lặp và giữ nguyên số dư.

### Requirement 8: Xác thực callback PayPal

**User Story:** Là System, tôi cần xác thực callback đến từ PayPal, để chỉ cộng tiền cho thông báo thanh toán hợp lệ.

#### Acceptance Criteria

1. WHEN một callback đến endpoint Webhook_Handler, THE PayPal_Auth_Middleware SHALL xác thực tính hợp lệ của callback (kiểm tra transmission headers và certificate đối chiếu credentials đã cấu hình) trước khi handler xử lý.
2. WHEN xác thực callback hợp lệ, THE PayPal_Auth_Middleware SHALL chuyển tiếp callback cho Webhook_Handler xử lý.
3. IF xác thực callback thất bại, THEN THE PayPal_Auth_Middleware SHALL từ chối yêu cầu với mã trạng thái 401, SHALL không cộng tiền, và SHALL giữ nguyên số dư User.
4. IF cấu hình credentials PayPal cần cho xác thực bị thiếu hoặc rỗng, THEN THE PayPal_Auth_Middleware SHALL từ chối yêu cầu với mã trạng thái 401.
5. IF quá trình xác thực callback không hoàn tất trong vòng 10 giây, THEN THE PayPal_Auth_Middleware SHALL từ chối yêu cầu (fail-closed) và SHALL không cộng tiền.
6. WHEN PayPal_Auth_Middleware ghi log lý do từ chối, THE System SHALL không ghi giá trị credentials PayPal vào log.

### Requirement 9: Bản địa hoá thông báo

**User Story:** Là một User, tôi muốn nhận thông báo nạp tiền bằng ngôn ngữ của tôi, để hiểu rõ trạng thái giao dịch.

#### Acceptance Criteria

1. WHEN PayPal_Provider trả về một thông báo lỗi hoặc hạn mức cho một User có Language hợp lệ (`vi` hoặc `en`), THE System SHALL hiển thị thông báo theo Language đó với nội dung phản ánh đúng loại lỗi/hạn mức tương ứng.
2. WHEN một thanh toán PayPal được cộng tiền thành công cho một User có Language hợp lệ, THE System SHALL gửi cho User thông báo thành công theo Language đó, bao gồm số tiền đã cộng và số dư mới.
3. IF Language của User thiếu hoặc không thuộc {`vi`, `en`}, THEN THE System SHALL hiển thị thông báo theo ngôn ngữ mặc định `vi`.
4. IF khóa dịch cho một thông báo bị thiếu, THEN THE System SHALL áp dụng chuỗi fallback xác định (Language → `vi` → khóa) mà không gây gián đoạn luồng.
5. IF việc gửi thông báo thành công cho User thất bại, THEN THE System SHALL giữ nguyên số dư đã cộng (không hoàn tác) và ghi nhận lỗi gửi.

### Requirement 10: Dọn dẹp khi tạo order thất bại

**User Story:** Là System, tôi không muốn để lại Deposit `pending` mồ côi khi tạo PayPal_Order thất bại, để dữ liệu nạp tiền sạch và không chiếm slot pending sai.

#### Acceptance Criteria

1. IF việc tạo PayPal_Order qua PayPal Checkout Orders API thất bại VÀ Deposit tương ứng vẫn ở trạng thái `pending` VÀ chưa được gắn PayPal_Order_Id, THEN THE PayPal_Provider SHALL xóa Deposit `pending` tương ứng đó.
2. IF việc tạo PayPal_Order thất bại NHƯNG Deposit tương ứng không còn ở trạng thái `pending` HOẶC đã được gắn PayPal_Order_Id, THEN THE PayPal_Provider SHALL giữ nguyên Deposit đó mà không xóa.
3. IF việc tạo PayPal_Order qua PayPal Checkout Orders API thất bại, THEN THE PayPal_Provider SHALL trả về lỗi provider cho caller với thông báo lỗi chung chỉ ra rằng tạo order thất bại, không kèm chi tiết kỹ thuật nội bộ (không stack trace, không mã lỗi nội bộ, không thông điệp nguyên gốc từ PayPal API).
4. WHEN PayPal_Provider trả về lỗi provider cho User, THE PayPal_Provider SHALL ghi log nội bộ chi tiết lỗi gốc phục vụ chẩn đoán, tách biệt với thông báo lỗi chung hiển thị cho User.

### Requirement 11: Schema và migration cho PayPal

**User Story:** Là nhà phát triển, tôi muốn lưu trữ dữ liệu PayPal trong schema một cách nhất quán với quy ước dự án, để hỗ trợ idempotency và truy vết.

#### Acceptance Criteria

1. THE System SHALL bổ sung cột PayPal_Order_Id vào bảng `deposits` thông qua một file migration mới `0014_*.sql` mà không sửa bất kỳ migration đã chạy nào.
2. THE System SHALL khai báo cột PayPal_Order_Id là nullable, sao cho các Deposit của provider khác (`sepay`, `cryptobot`) có giá trị NULL ở cột này.
3. WHEN migration được áp lên cơ sở dữ liệu đang có các hàng deposit, THE System SHALL giữ nguyên các hàng hiện hữu với giá trị PayPal_Order_Id bằng NULL.
4. THE System SHALL cập nhật union `provider` trong `src/types/db.ts` thành `'sepay' | 'cryptobot' | 'paypal'`.
5. THE System SHALL bổ sung trường PayPal_Order_Id (kiểu chuỗi nullable, `string | null`) vào kiểu Deposit trong `src/types/db.ts`.

### Requirement 12: Chỉ cộng tiền cho thanh toán đã capture thành công

**User Story:** Là Admin, tôi muốn hệ thống chỉ cộng số dư cho thanh toán PayPal đã capture thành công, để hạn chế rủi ro từ tranh chấp và bồi hoàn.

#### Acceptance Criteria

1. WHEN một callback webhook đã xác thực chữ ký báo PayPal_Order được capture thành công, THE Webhook_Handler SHALL cộng cho Deposit tương ứng số tiền `creditVnd` quy đổi và chuyển Deposit sang trạng thái `completed`.
2. WHILE một PayPal_Order chưa nhận được sự kiện webhook đã xác thực xác nhận capture, THE System SHALL giữ Deposit tương ứng ở trạng thái `pending` và SHALL không cộng tiền.
3. WHEN nhiều sự kiện capture trùng cho cùng một PayPal_Order được nhận, THE System SHALL không cộng tiền lặp, giữ nguyên số dư và trạng thái, và ghi log sự kiện.
4. IF một sự kiện capture không xác thực được chữ ký hoặc không khớp Deposit nào, THEN THE System SHALL không cộng tiền, giữ nguyên trạng thái, và ghi log sự kiện.
5. WHERE một sự kiện PayPal biểu thị tranh chấp, bồi hoàn, hoặc hoàn tiền sau khi đã capture, THE System SHALL không tự động điều chỉnh số dư User trong phạm vi tính năng này và SHALL ghi log sự kiện (thời điểm, order id, loại sự kiện, số tiền) để Admin xử lý thủ công.
