# Requirements Document

## Introduction

Tính năng này bổ sung khả năng **đa vùng (region)** cho Telegram Shop Bot: người dùng chọn vùng "Việt Nam" hoặc "Quốc tế" ngay lần đầu tương tác (qua bot hoặc Mini App), từ đó hệ thống xác định ngôn ngữ hiển thị (Tiếng Việt / Tiếng Anh) và tập phương thức nạp tiền khả dụng.

Tính năng đồng thời:
- Tích hợp **@CryptoBot (Crypto Pay API)** để nhận thanh toán **USDT**, theo mô hình "tạo invoice + webhook callback + idempotency" tương tự SePay đang dùng.
- **Tái cấu trúc (refactor)** luồng nạp tiền hiện đang gắn chặt với SePay thành mô hình theo **loại phương thức nạp (Payment Method Type / Provider)** để mở rộng phương thức mới về sau mà không sửa lõi.
- Bổ sung **đa ngôn ngữ (VI/EN)** cho Bot, Mini App và CMS.
- Bổ sung **template tin nhắn bán hàng song ngữ** (VI/EN).

Quyết định nền tảng đã chốt với người dùng:
- **Mô hình số dư:** Số dư duy nhất theo **VND** (giữ nguyên `users.balance` INTEGER, ràng buộc không âm, giá sản phẩm theo VND). Khoản nạp USDT được **quy đổi sang VND** theo tỷ giá rồi cộng vào số dư.
- **Tỷ giá USDT→VND:** Cấu hình **thủ công trong CMS** (lưu ở `system_config`), không gọi API tỷ giá ngoài.
- **Ngôn ngữ mặc định toàn hệ thống = Tiếng Anh (EN)** khi chưa được xác định. Bot/CMS/Mini App có ngôn ngữ mặc định cấu hình được; khi chưa cấu hình thì dùng EN.
- **Phương thức nạp theo vùng:** Việt Nam có SePay (VietQR) **và** CryptoBot (USDT); Quốc tế chỉ có CryptoBot (USDT).
- **Đơn vị nhập tiền nạp theo Payment_Provider (không theo vùng):** SePay_Provider nhập theo **VND**; CryptoPay_Provider nhập theo **USDT** với mức tối thiểu cấu hình được (mặc định 5 USDT). Số dư cộng vào luôn là VND quy đổi.
- **Thanh toán USDT đến trễ:** Một thanh toán USDT hợp lệ **vẫn được cộng tiền (idempotent)** kể cả khi yêu cầu nạp tương ứng đã chuyển trạng thái `expired`; việc hết hạn chỉ giải phóng slot `pending`, không làm mất khoản tiền đã trả.

Tài liệu này tập trung mô tả *cái gì* hệ thống phải làm. Chi tiết *làm như thế nào* (schema cụ thể, abstraction code, file) thuộc tài liệu Thiết kế.

## Glossary

- **System**: Toàn bộ ứng dụng Telegram Shop Bot chạy trên một Cloudflare Worker.
- **Bot**: Thành phần xử lý webhook Telegram (lệnh, reply keyboard, inline keyboard).
- **Mini_App**: Ứng dụng Vue 3 chạy trong Telegram Web App, phục vụ tại base `/app/`.
- **CMS**: Ứng dụng Vue 3 quản trị, phục vụ tại `/cms/`, bảo vệ bằng JWT.
- **User**: Người dùng cuối tương tác qua Bot hoặc Mini_App; lưu trong bảng `users`, định danh bởi `telegram_id`.
- **Admin**: Người quản trị đăng nhập CMS.
- **Region**: Vùng của User, nhận một trong hai giá trị: `vietnam` hoặc `international`.
- **Language**: Ngôn ngữ hiển thị của User, nhận một trong hai giá trị: `vi` hoặc `en`.
- **Default_Language**: Ngôn ngữ dùng khi Language của User chưa được xác định; giá trị mặc định là `en`, cấu hình được qua `system_config`.
- **Onboarding**: Bước yêu cầu User chọn Region trong lần tương tác đầu tiên.
- **Payment_Provider**: Một loại phương thức nạp tiền (ví dụ `sepay`, `cryptobot`), được mô tả bằng định danh loại thống nhất.
- **Deposit_Service**: Thành phần tạo và quản lý yêu cầu nạp tiền (deposit) độc lập với Payment_Provider cụ thể.
- **SePay_Provider**: Payment_Provider nạp tiền qua VietQR, xác nhận qua webhook SePay.
- **CryptoPay_Provider**: Payment_Provider nạp tiền qua @CryptoBot (Crypto Pay API), nhận USDT.
- **Crypto_Invoice**: Hoá đơn thanh toán tạo qua Crypto Pay API (`createInvoice`), kèm liên kết thanh toán `pay_url`.
- **Webhook_Handler**: Thành phần nhận callback từ Payment_Provider để xác nhận thanh toán.
- **Exchange_Rate**: Tỷ giá quy đổi 1 USDT sang VND, lưu trong `system_config`.
- **Deposit_Limits**: Hạn mức số tiền nạp đọc từ `system_config`. Gồm hạn mức VND (tối thiểu/tối đa) dùng chung và hạn mức USDT tối thiểu riêng cho CryptoPay_Provider.
- **Crypto_Min_USDT**: Số USDT tối thiểu cho một yêu cầu nạp qua CryptoPay_Provider; mặc định 5 USDT; cấu hình được trong `system_config`.
- **Success_Template**: Mẫu nội dung tin nhắn "Mua hàng thành công" theo từng loại sản phẩm, có phiên bản VI và EN.
- **Template_Renderer**: Thành phần render tin nhắn bán hàng (header cố định + body từ Success_Template).
- **USDT**: Stablecoin được chấp nhận qua CryptoPay_Provider.

## Requirements

### Requirement 1: Onboarding chọn vùng trên Bot

**User Story:** Là một User mới trên Bot, tôi muốn được hỏi chọn vùng ngay lần đầu, để hệ thống hiển thị đúng ngôn ngữ và phương thức nạp phù hợp.

#### Acceptance Criteria

1. WHEN một User gửi lệnh `/start` và Region của User đó chưa được xác định, THE Bot SHALL hiển thị bước Onboarding với inline keyboard gồm hai lựa chọn vùng: "Việt Nam" và "Quốc tế".
2. WHILE Onboarding của một User chưa hoàn tất, THE Bot SHALL hiển thị nội dung Onboarding bằng Default_Language.
3. WHEN một User chọn một vùng trong Onboarding, THE Bot SHALL lưu Region tương ứng cho User đó ngay tại thời điểm chọn, trước khi hiển thị menu chính.
4. WHEN một User hoàn tất chọn vùng trong Onboarding, THE Bot SHALL hiển thị menu chính ngay sau khi lưu Region.
5. WHEN một User gửi lệnh `/start` và Region của User đó đã được xác định, THE Bot SHALL hiển thị menu chính mà không hiển thị bước Onboarding.
6. IF một User gửi nội dung không phải lựa chọn vùng hợp lệ trong khi Onboarding chưa hoàn tất, THEN THE Bot SHALL hiển thị lại bước Onboarding chọn vùng.

### Requirement 2: Onboarding chọn vùng trên Mini App

**User Story:** Là một User mở Mini App lần đầu, tôi muốn chọn vùng, để Mini App hiển thị đúng ngôn ngữ và phương thức nạp.

#### Acceptance Criteria

1. WHEN một User mở Mini_App và Region của User đó chưa được xác định, THE Mini_App SHALL hiển thị màn hình Onboarding chọn vùng với hai lựa chọn: "Việt Nam" và "Quốc tế".
2. WHILE Region của User chưa được xác định, THE Mini_App SHALL hiển thị giao diện Onboarding bằng Default_Language.
3. WHEN một User chọn một vùng trong Mini_App Onboarding, THE Mini_App SHALL gửi yêu cầu lưu Region tương ứng cho User đó tới System.
4. WHEN System lưu Region thành công cho một User, THE Mini_App SHALL chuyển sang màn hình chính.
5. WHEN một User mở Mini_App và Region của User đó đã được xác định, THE Mini_App SHALL hiển thị màn hình chính mà không hiển thị Onboarding.

### Requirement 3: Lưu trữ Region và Language của User

**User Story:** Là System, tôi cần lưu Region và Language của từng User, để áp dụng nhất quán trên Bot và Mini App.

#### Acceptance Criteria

1. THE System SHALL lưu Region của mỗi User với tập giá trị hợp lệ là `vietnam` hoặc `international`.
2. THE System SHALL lưu Language của mỗi User với tập giá trị hợp lệ là `vi` hoặc `en`.
3. WHEN một User chọn vùng `vietnam` trong Onboarding, THE System SHALL đặt Language của User đó là `vi`.
4. WHEN một User chọn vùng `international` trong Onboarding, THE System SHALL đặt Language của User đó là `en`.
5. IF một bản ghi User chưa có giá trị Language, THEN THE System SHALL áp dụng Default_Language cho User đó khi hiển thị.
6. WHEN một User mới được tạo trước khi hoàn tất Onboarding, THE System SHALL đánh dấu Region của User đó là chưa xác định.
7. WHERE một bản ghi User đã tồn tại từ trước khi tính năng này triển khai và chưa có giá trị Region, THE System SHALL coi User đó là chưa hoàn tất Onboarding và hiển thị bước Onboarding ở lần tương tác kế tiếp qua Bot hoặc Mini_App.

### Requirement 4: Xác định ngôn ngữ hiển thị

**User Story:** Là một User, tôi muốn thấy giao diện đúng ngôn ngữ của mình, để dễ sử dụng.

#### Acceptance Criteria

1. WHILE Language của một User đã được xác định, THE Bot SHALL hiển thị mọi nội dung do System sinh ra cho User đó bằng Language đã xác định.
2. WHILE Language của một User đã được xác định, THE Mini_App SHALL hiển thị giao diện cho User đó bằng Language đã xác định.
3. IF Language của một User chưa được xác định, THEN THE System SHALL hiển thị nội dung bằng Default_Language.
4. WHERE Default_Language chưa được cấu hình trong `system_config`, THE System SHALL dùng `en` làm Default_Language.
5. THE System SHALL hỗ trợ đúng hai Language: `vi` và `en`.
6. WHEN hiển thị số tiền, số lượng hoặc ngày giờ cho một User, THE System SHALL định dạng theo Language của User đó (gồm cả nhãn tiền tệ VND), và áp dụng nhất quán cho Bot, Mini_App và CMS.

### Requirement 5: Đổi vùng sau Onboarding

**User Story:** Là một User, tôi muốn đổi lại vùng sau khi đã chọn, để cập nhật khi nhu cầu thay đổi.

#### Acceptance Criteria

1. THE Bot SHALL cung cấp một chức năng cho phép User đổi Region sau khi Onboarding đã hoàn tất.
2. THE Mini_App SHALL cung cấp một màn hình thiết lập cho phép User đổi Region sau khi Onboarding đã hoàn tất.
3. WHEN một User đổi Region, THE System SHALL cập nhật tập phương thức nạp khả dụng cho User đó theo Region mới.
4. THE CMS SHALL cho phép Admin xem và cập nhật Region của một User.
5. WHEN một User đổi Region, THE System SHALL giữ nguyên số dư VND hiện có của User đó.

### Requirement 6: Đổi ngôn ngữ độc lập với vùng

**User Story:** Là một User, tôi muốn đổi ngôn ngữ độc lập với vùng, để chọn ngôn ngữ tôi đọc thoải mái nhất.

#### Acceptance Criteria

1. THE Bot SHALL cung cấp một chức năng cho phép User đổi Language sang `vi` hoặc `en`.
2. THE Mini_App SHALL cung cấp một chức năng cho phép User đổi Language sang `vi` hoặc `en`.
3. WHEN một User đổi Language, THE System SHALL lưu Language mới cho User đó mà không thay đổi Region của User đó.
4. WHEN một User đã đổi Language thủ công, THE System SHALL giữ Language do User chọn kể cả khi Region được đổi sau đó.

### Requirement 7: Trừu tượng hoá phương thức nạp tiền

**User Story:** Là đội phát triển, tôi muốn luồng nạp tiền được trừu tượng hoá theo Payment_Provider, để bổ sung phương thức nạp mới mà không sửa lõi nghiệp vụ.

#### Acceptance Criteria

1. THE Deposit_Service SHALL biểu diễn mỗi yêu cầu nạp kèm một định danh Payment_Provider.
2. THE System SHALL hỗ trợ các Payment_Provider hiện có gồm `sepay` và `cryptobot` qua một giao diện chung.
3. WHEN một yêu cầu nạp được xác nhận thanh toán thành công, THE Deposit_Service SHALL cộng số dư bằng cùng một quy trình giao dịch nguyên tử (atomic) cho mọi Payment_Provider.
4. THE System SHALL cho phép thêm một Payment_Provider mới mà không sửa logic cộng số dư dùng chung.
5. THE System SHALL ghi nhận Payment_Provider của mỗi giao dịch nạp để phục vụ tra cứu và đối soát.
6. WHERE một Payment_Provider mới được bổ sung, THE System SHALL chỉ mở phương thức đó cho User sau khi có ít nhất một giao dịch nạp thử nghiệm thành công qua Payment_Provider đó.
7. WHERE một yêu cầu nạp thuộc Payment_Provider không phải SePay_Provider, THE System SHALL không yêu cầu yêu cầu nạp đó phải có mã chuyển khoản (transfer code) của SePay.

### Requirement 8: Phương thức nạp khả dụng theo vùng

**User Story:** Là một User, tôi muốn chỉ thấy các phương thức nạp phù hợp với vùng của mình, để tránh chọn nhầm.

#### Acceptance Criteria

1. WHILE Region của một User là `vietnam`, THE System SHALL cung cấp cả hai phương thức nạp: SePay_Provider và CryptoPay_Provider.
2. WHILE Region của một User là `international`, THE System SHALL chỉ cung cấp CryptoPay_Provider.
3. WHEN một User mở chức năng nạp tiền, THE System SHALL hiển thị danh sách phương thức nạp đúng theo Region hiện tại của User đó.
4. IF một User khởi tạo nạp tiền qua một Payment_Provider không khả dụng cho Region của mình, THEN THE System SHALL từ chối yêu cầu và hiển thị thông báo phương thức không khả dụng.

### Requirement 9: Nạp tiền qua SePay (giữ hành vi hiện tại)

**User Story:** Là một User ở vùng Việt Nam, tôi muốn tiếp tục nạp qua VietQR/SePay như trước, để trải nghiệm không gián đoạn.

#### Acceptance Criteria

1. WHEN một User vùng `vietnam` chọn nạp qua SePay_Provider, THE System SHALL tạo một yêu cầu nạp ở trạng thái `pending` kèm mã chuyển khoản và mã QR VietQR.
2. WHEN Webhook_Handler nhận một giao dịch SePay tiền vào khớp một yêu cầu nạp `pending` còn hiệu lực, THE System SHALL cộng đúng số tiền VND vào số dư của User tương ứng.
3. IF Webhook_Handler nhận một giao dịch SePay có `sepay_transaction_id` đã xử lý trước đó, THEN THE System SHALL bỏ qua giao dịch đó và giữ nguyên số dư của User.
4. THE System SHALL áp dụng Deposit_Limits cho yêu cầu nạp qua SePay_Provider.
5. WHEN một thanh toán SePay_Provider được cộng tiền thành công, THE System SHALL gửi cho User một thông báo xác nhận nạp thành công bằng Language của User đó.

### Requirement 10: Tạo invoice nạp tiền qua @CryptoBot

**User Story:** Là một User, tôi muốn nạp bằng USDT qua @CryptoBot, để thanh toán bằng tiền mã hoá.

#### Acceptance Criteria

1. WHEN một User chọn nạp qua CryptoPay_Provider với một số tiền hợp lệ, THE System SHALL gọi Crypto Pay API `createInvoice` để tạo một Crypto_Invoice tính bằng USDT.
2. WHEN Crypto Pay API trả về một Crypto_Invoice thành công, THE System SHALL lưu yêu cầu nạp ở trạng thái `pending` gắn với định danh Crypto_Invoice và Payment_Provider `cryptobot`.
3. WHEN một Crypto_Invoice được tạo thành công, THE System SHALL cung cấp cho User liên kết `pay_url` của Crypto_Invoice đó để thanh toán.
4. IF lời gọi `createInvoice` thất bại, THEN THE System SHALL hiển thị thông báo lỗi tạo hoá đơn cho User và không tạo yêu cầu nạp ở trạng thái `pending`.
5. THE CryptoPay_Provider SHALL chỉ chấp nhận tài sản USDT.
6. WHEN một User khởi tạo nạp qua CryptoPay_Provider, THE System SHALL nhận số tiền nạp do User nhập theo đơn vị USDT.

### Requirement 11: Xác nhận thanh toán @CryptoBot qua webhook

**User Story:** Là System, tôi cần nhận callback từ @CryptoBot để xác nhận thanh toán và cộng tiền, để tự động hoá việc nạp.

#### Acceptance Criteria

1. WHEN Webhook_Handler nhận một callback từ Crypto Pay API báo một Crypto_Invoice đã được thanh toán và khớp một yêu cầu nạp `pending`, THE System SHALL cộng số dư VND đã quy đổi cho User tương ứng.
2. IF Webhook_Handler nhận một callback cho một Crypto_Invoice có định danh đã được xử lý trước đó, THEN THE System SHALL bỏ qua callback đó mà không cộng số dư lần nữa.
3. WHEN một thanh toán CryptoPay_Provider được cộng tiền thành công, THE System SHALL gửi cho User một thông báo xác nhận nạp thành công bằng Language của User đó.
4. IF Webhook_Handler nhận một callback hợp lệ báo đã thanh toán cho một Crypto_Invoice mà yêu cầu nạp tương ứng đã chuyển trạng thái `expired`, THEN THE System SHALL vẫn cộng số dư VND đã quy đổi cho User đúng một lần (idempotent) và đánh dấu yêu cầu nạp là đã hoàn tất.
5. WHEN Webhook_Handler xử lý xong một callback hợp lệ, THE System SHALL trả về phản hồi báo đã tiếp nhận cho Crypto Pay API.

### Requirement 12: Quy đổi USDT sang VND và cấu hình tỷ giá

**User Story:** Là Admin, tôi muốn cấu hình tỷ giá USDT→VND, để kiểm soát số dư VND mà User nhận khi nạp USDT.

#### Acceptance Criteria

1. THE System SHALL đọc Exchange_Rate (số VND cho 1 USDT) từ `system_config`.
2. WHEN một thanh toán USDT được xác nhận, THE System SHALL tính số dư cộng thêm theo công thức: số VND = số USDT × Exchange_Rate, làm tròn xuống đơn vị VND nguyên.
3. THE CMS SHALL cho phép Admin xem và cập nhật Exchange_Rate.
4. IF Exchange_Rate trong `system_config` thiếu hoặc không phải số dương hợp lệ tại thời điểm xác nhận một thanh toán USDT, THEN THE System SHALL không cộng số dư ngay, giữ yêu cầu nạp ở trạng thái chờ-cộng (không huỷ, không đánh dấu hoàn tất) và ghi log lỗi cấu hình tỷ giá.
5. THE System SHALL lưu cùng giao dịch nạp USDT các giá trị: số USDT, Exchange_Rate áp dụng và số VND đã cộng.
6. THE System SHALL dùng số USDT thực nhận từ Crypto Pay API làm cơ sở tính số VND cộng vào số dư, và chấp nhận sai số làm tròn xuống tới đơn vị VND nguyên giữa số tiền hiển thị khi tạo invoice và số VND thực cộng.
7. WHEN Exchange_Rate trở lại hợp lệ, THE System SHALL cộng số dư VND quy đổi cho các thanh toán USDT đang ở trạng thái chờ-cộng, đúng một lần cho mỗi thanh toán (idempotent).

### Requirement 13: Hạn mức và chính sách nạp dùng chung

**User Story:** Là System, tôi muốn áp dụng cùng một chính sách chống lạm dụng cho mọi phương thức nạp, để hành vi nhất quán.

#### Acceptance Criteria

1. THE System SHALL áp dụng hạn mức VND tối thiểu/tối đa (Deposit_Limits) cho yêu cầu nạp qua SePay_Provider.
2. WHERE phương thức nạp là CryptoPay_Provider, THE System SHALL kiểm tra số USDT nạp theo Crypto_Min_USDT và kiểm tra giá trị VND quy đổi theo hạn mức VND tối đa của Deposit_Limits.
3. IF một yêu cầu nạp qua SePay_Provider có số tiền VND nằm ngoài khoảng Deposit_Limits, THEN THE System SHALL từ chối tạo yêu cầu nạp và hiển thị thông báo hạn mức cho User.
4. IF một yêu cầu nạp qua CryptoPay_Provider có số USDT nhỏ hơn Crypto_Min_USDT hoặc có giá trị VND quy đổi vượt hạn mức VND tối đa, THEN THE System SHALL từ chối tạo yêu cầu nạp và hiển thị thông báo hạn mức cho User.
5. WHERE Crypto_Min_USDT chưa được cấu hình trong `system_config`, THE System SHALL dùng 5 USDT làm giá trị mặc định.
6. THE System SHALL áp dụng cùng chính sách cooldown và trần số yêu cầu `pending` cho mọi Payment_Provider.

### Requirement 14: Cộng tiền nguyên tử và chống trùng

**User Story:** Là System, tôi muốn việc cộng tiền nạp luôn nguyên tử và không bị cộng trùng, để số dư luôn chính xác.

#### Acceptance Criteria

1. WHEN xác nhận một yêu cầu nạp thành công, THE System SHALL cập nhật số dư, trạng thái yêu cầu nạp và bản ghi giao dịch trong một thao tác nguyên tử.
2. IF một yêu cầu nạp đã ở trạng thái `completed` tại thời điểm xác nhận, THEN THE System SHALL bỏ qua việc cộng số dư cho yêu cầu đó để chống cộng trùng; việc xử lý yêu cầu nạp ở trạng thái `expired` tuân theo Requirement 11 và Requirement 15 tuỳ Payment_Provider.
3. THE System SHALL bảo đảm số dư VND của mỗi User luôn lớn hơn hoặc bằng 0 sau mọi giao dịch nạp.
4. WHEN hai callback xác nhận trùng nhau được xử lý đồng thời cho cùng một yêu cầu nạp, THE System SHALL cộng số dư đúng một lần.
5. IF thao tác cộng số dư nguyên tử thất bại sau khi một thanh toán đã được xác nhận, THEN THE System SHALL giữ trạng thái thanh toán là đã xác nhận và thử lại thao tác cộng số dư cho tới khi thành công.

### Requirement 15: Hết hạn yêu cầu nạp đang chờ

**User Story:** Là System, tôi muốn các yêu cầu nạp chờ quá lâu tự hết hạn để giải phóng slot chờ, đồng thời không làm mất khoản USDT hợp lệ thanh toán đến trễ.

#### Acceptance Criteria

1. WHEN một yêu cầu nạp ở trạng thái `pending` vượt quá thời gian sống cho phép, THE System SHALL chuyển yêu cầu đó sang trạng thái `expired` trong lượt chạy định kỳ.
2. THE System SHALL áp dụng quy tắc hết hạn yêu cầu nạp cho mọi Payment_Provider, gồm SePay_Provider và CryptoPay_Provider.
3. IF một thanh toán SePay_Provider được xác nhận cho một yêu cầu nạp đã `expired`, THEN THE System SHALL bỏ qua việc cộng số dư cho thanh toán đó.
4. WHERE thanh toán thuộc CryptoPay_Provider, THE System SHALL áp dụng quy tắc cộng tiền cho yêu cầu nạp đã `expired` theo Requirement 11 (vẫn cộng idempotent), thay cho việc bỏ qua.

### Requirement 16: Template tin nhắn bán hàng song ngữ

**User Story:** Là Admin, tôi muốn soạn template tin nhắn bán hàng cho cả tiếng Việt và tiếng Anh, để User nhận tin nhắn đúng ngôn ngữ của mình.

#### Acceptance Criteria

1. THE System SHALL lưu cho mỗi loại sản phẩm hai Success_Template: một bản tiếng Việt và một bản tiếng Anh.
2. THE CMS SHALL cho phép Admin xem và chỉnh sửa cả hai bản Success_Template (VI và EN) của mỗi loại sản phẩm.
3. WHEN Template_Renderer dựng tin nhắn mua hàng thành công cho một User, THE Template_Renderer SHALL chọn Success_Template theo Language của User đó.
4. THE Template_Renderer SHALL cung cấp phần header cố định ở cả hai phiên bản tiếng Việt và tiếng Anh.
5. IF Success_Template tương ứng với Language của User trống, THEN THE Template_Renderer SHALL dùng body mặc định theo Language của User đó.
6. THE Template_Renderer SHALL thay các placeholder `[content]`, `[name]`, `[emoji]`, `[quantity]`, `[total]`, `[balance]` bằng giá trị thực và escape HTML cho các giá trị động.

### Requirement 17: Đa ngôn ngữ cho Mini App

**User Story:** Là một User, tôi muốn Mini App hiển thị bằng ngôn ngữ của mình, để thao tác dễ dàng.

#### Acceptance Criteria

1. THE Mini_App SHALL cung cấp đầy đủ chuỗi giao diện ở hai Language: `vi` và `en`.
2. WHEN Mini_App tải cho một User đã xác định Language, THE Mini_App SHALL hiển thị bằng Language của User đó.
3. IF Language của User chưa được xác định khi Mini_App tải, THEN THE Mini_App SHALL hiển thị bằng Default_Language.
4. WHEN một User đổi Language trong Mini_App, THE Mini_App SHALL cập nhật ngôn ngữ hiển thị mà không cần tải lại trang.
5. IF một chuỗi giao diện thiếu bản dịch cho Language đang dùng, THEN THE Mini_App SHALL vẫn tải và hiển thị phần văn bản chưa dịch tại vị trí thiếu.

### Requirement 18: Đa ngôn ngữ cho CMS

**User Story:** Là Admin, tôi muốn CMS hỗ trợ tiếng Việt và tiếng Anh, để dùng ngôn ngữ phù hợp.

#### Acceptance Criteria

1. THE CMS SHALL cung cấp đầy đủ chuỗi giao diện ở hai Language: `vi` và `en`.
2. THE CMS SHALL cung cấp chức năng cho phép Admin chuyển đổi giữa `vi` và `en`.
3. WHERE Admin chưa chọn ngôn ngữ CMS, THE CMS SHALL hiển thị bằng `en`.
4. WHEN Admin chuyển ngôn ngữ CMS, THE CMS SHALL cập nhật ngôn ngữ hiển thị mà không tải lại trang, kể cả khi một phần giao diện không cập nhật được.

### Requirement 19: Bảo mật cấu hình và xác thực webhook @CryptoBot

**User Story:** Là System, tôi muốn bảo mật token và xác thực callback @CryptoBot, để chống giả mạo thanh toán.

#### Acceptance Criteria

1. THE System SHALL đọc token Crypto Pay API từ secret `CRYPTO_PAY_API_TOKEN`.
2. WHEN Webhook_Handler nhận một callback từ Crypto Pay API, THE System SHALL xác thực tính hợp lệ của callback trước khi cộng số dư.
3. IF một callback Crypto Pay API không xác thực được tính hợp lệ, THEN THE System SHALL từ chối callback đó và không cộng số dư.
4. THE System SHALL ghi nhật ký các callback Crypto Pay API bị từ chối kèm lý do.
5. THE System SHALL loại trừ giá trị secret `CRYPTO_PAY_API_TOKEN` khỏi mọi phản hồi và nhật ký.

### Requirement 20: Quản trị cấu hình thanh toán trong CMS

**User Story:** Là Admin, tôi muốn quản lý cấu hình liên quan thanh toán đa vùng trong CMS, để vận hành không cần sửa code.

#### Acceptance Criteria

1. THE CMS SHALL cho phép Admin xem và cập nhật Exchange_Rate dùng cho quy đổi USDT sang VND.
2. THE CMS SHALL cho phép Admin xem và cập nhật Deposit_Limits (tối thiểu/tối đa theo VND).
3. THE CMS SHALL cho phép Admin xem và cập nhật Crypto_Min_USDT (số USDT tối thiểu cho nạp qua CryptoPay_Provider).
4. THE CMS SHALL cho phép Admin xem và cập nhật Default_Language.
5. WHEN Admin cập nhật một cấu hình thanh toán, THE System SHALL áp dụng giá trị mới cho các yêu cầu nạp tạo sau thời điểm cập nhật.
6. THE CMS SHALL hiển thị Payment_Provider và (với nạp USDT) số USDT cùng Exchange_Rate đã áp dụng cho mỗi giao dịch nạp trong phần tra cứu giao dịch.
7. IF Admin lưu Deposit_Limits với giá trị tối đa nhỏ hơn giá trị tối thiểu, THEN THE CMS SHALL từ chối lưu và hiển thị thông báo hạn mức không hợp lệ.
