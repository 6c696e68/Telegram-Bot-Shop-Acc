# Requirements Document

## Introduction

Tài liệu này mô tả yêu cầu cho việc nâng cấp phần sản phẩm của Telegram Shop Bot (Cloudflare Worker + D1 + Hono + Vue CMS + Mini App) từ mô hình hai tầng hiện tại sang mô hình ba tầng có hỗ trợ đa ngôn ngữ.

Mô hình hiện tại trộn hai khái niệm vào một bảng: bảng `product_types` vừa đóng vai trò danh mục, vừa là sản phẩm có giá; còn bảng `products` là kho tài khoản cụ thể. Mô hình mới tách thành ba tầng rõ ràng:

1. **Danh mục (Product_Type)** — nhóm phân loại lớn (ví dụ "Tài khoản ChatGPT"), không có giá.
2. **Sản phẩm (Product)** — đơn vị có giá, mô tả, ảnh, thuộc về một danh mục (ví dụ "ChatGPT bảo hành 7 ngày", "ChatGPT bảo hành 30 ngày").
3. **Kho hàng (Product_Item)** — tài khoản số cụ thể (stock) thuộc về một sản phẩm; đây chính là bảng `products` hiện tại được đổi tên thành `product_items`.

Đồng thời, tên (name), mô tả (description) và nội dung mô tả (content) — cùng các text hiển thị cho khách — của danh mục và sản phẩm phải hỗ trợ đa ngôn ngữ, mở rộng được sang ngôn ngữ mới mà không cần đổi schema, và có cơ chế fallback khi thiếu bản dịch. Việc nâng cấp phải migrate dữ liệu cũ an toàn (không mất dữ liệu), không sửa migration cũ, giữ tính atomic của giao dịch mua hàng, ràng buộc số dư không âm, và tương thích vận hành (không để schema nửa vời được ghi nhận là đã migrate, không cần thao tác thủ công sau khi migration commit).

**Phân biệt quan trọng về trường `content`:** Trong tài liệu này, "content" của Product_Type/Product là nội dung mô tả hiển thị đa ngôn ngữ cho khách (cùng nhóm với name và description), được dịch theo từng ngôn ngữ và áp dụng chuỗi fallback. Trường này HOÀN TOÀN KHÁC với cột `content` của Product_Item (kho tài khoản) — vốn là dữ liệu tài khoản cụ thể (thông tin đăng nhập/giao cho khách sau khi mua), KHÔNG đa ngôn ngữ và KHÔNG được dịch. Mọi yêu cầu về đa ngôn ngữ cho "content" trong tài liệu này chỉ áp dụng cho trường content hiển thị của Product_Type/Product, không áp dụng cho cột `content` của Product_Item.

Hệ thống đã có sẵn nền tảng đa ngôn ngữ để tái sử dụng: registry `SUPPORTED_LANGUAGES` trong `src/i18n/locales.ts` (single source of truth, thêm ngôn ngữ không sửa lõi), bảng con `product_type_templates` khoá theo `(product_type_id, lang)` cho template bán hàng, và chuỗi fallback `user.language → default_language → BASE_FALLBACK_LANG`. Mô hình đa ngôn ngữ cho name/description phải tuân theo cùng cách tiếp cận này.

## Glossary

- **Catalog_System**: Toàn bộ hệ thống quản lý danh mục, sản phẩm và kho hàng (backend Worker + DB), gồm cả lớp dịch vụ truy vấn dữ liệu sản phẩm đa ngôn ngữ.
- **Product_Type**: Tầng danh mục lớn (loại danh mục), không có giá. Bảng `product_types`.
- **Product**: Tầng sản phẩm có giá, mô tả, ảnh; thuộc về đúng một Product_Type. Bảng mới `products` (theo nghĩa mới).
- **Product_Item**: Tầng kho hàng — một tài khoản số cụ thể (stock) thuộc về đúng một Product. Bảng `product_items` (đổi tên từ bảng `products` cũ).
- **Translation_Store**: Cơ chế lưu bản dịch các trường hiển thị (name, description, content) của Product_Type và Product theo từng mã ngôn ngữ, mở rộng được không đổi schema. Lưu ý: content ở đây là nội dung mô tả hiển thị đa ngôn ngữ của Product_Type/Product, KHÔNG phải cột `content` (dữ liệu tài khoản) của Product_Item.
- **Base_Value (Giá trị gốc)**: Giá trị name/description/content gốc lưu trực tiếp trên bản ghi Product_Type/Product (không gắn với một mã ngôn ngữ cụ thể), dùng làm nguồn hiển thị cuối cùng trước placeholder khi không có bản dịch hợp lệ theo chuỗi ngôn ngữ. Đối với dữ liệu cũ, Base_Value chính là giá trị tên/mô tả đã có trước migration; nó được lưu ở cột name/description/content gốc trên bản ghi thực thể, KHÔNG nằm trong Translation_Store.
- **Display_Language**: Mã locale dùng để hiển thị cho một người dùng, xác định theo chuỗi fallback `user.language → default_language → BASE_FALLBACK_LANG`.
- **Default_Language**: Mã locale mặc định toàn hệ thống, đọc runtime từ `system_config` key `default_language`.
- **Base_Fallback_Language**: Mắt xích fallback cuối cùng (`BASE_FALLBACK_LANG`) khi không xác định được ngôn ngữ hợp lệ nào khác.
- **Supported_Languages**: Registry mã ngôn ngữ hợp lệ trong `src/i18n/locales.ts` (hiện là `vi`, `en`); là single source of truth.
- **Migration**: Một file SQL mới trong thư mục `migrations/` theo định dạng `000N_*.sql`, chạy theo thứ tự, không sửa file đã chạy.
- **CMS**: Giao diện quản trị Vue 3 tại `/cms/*` và REST API `/api/admin/*`.
- **Mini_App**: Storefront Telegram Mini App (Vue 3) hiển thị danh mục và sản phẩm cho khách.
- **Bot_Handler**: Các handler webhook Telegram xử lý flow duyệt và mua sản phẩm trong `src/bot`.
- **Purchase_Transaction**: Giao dịch mua hàng atomic (D1 `batch()` + concurrency guard `WHERE balance >= total`) trong `src/services/transaction.ts`.
- **Success_Template**: Mẫu tin nhắn "Mua hàng thành công", render qua `src/utils/telegram-template.ts`, lấy theo ngôn ngữ từ bảng template đa ngôn ngữ.

## Requirements

### Requirement 1: Mô hình dữ liệu ba tầng

**User Story:** Là quản trị viên shop, tôi muốn dữ liệu sản phẩm được tách thành ba tầng danh mục / sản phẩm / kho hàng, để có thể bán nhiều biến thể giá khác nhau (ví dụ bảo hành 7 ngày, 30 ngày) trong cùng một danh mục.

#### Acceptance Criteria

1. THE Catalog_System SHALL lưu Product_Type là tầng danh mục không có cột giá.
2. THE Catalog_System SHALL lưu mỗi Product với đúng một tham chiếu tới Product_Type cha qua khoá ngoại.
3. THE Catalog_System SHALL lưu giá, mô tả và ảnh ở tầng Product.
4. THE Catalog_System SHALL lưu mỗi Product_Item với đúng một tham chiếu tới Product cha qua khoá ngoại.
5. THE Catalog_System SHALL ràng buộc giá của mỗi Product là số nguyên (đơn vị VNĐ, không thập phân) nằm trong khoảng từ 1 đến 999.999.999.
6. IF một thao tác lưu một Product có giá nằm ngoài khoảng từ 1 đến 999.999.999 hoặc không phải số nguyên, THEN THE Catalog_System SHALL từ chối toàn bộ thao tác lưu, không lưu một phần bất kỳ trường nào khác của bản ghi, giữ nguyên toàn bộ bản ghi hiện có và trả về thông báo lỗi cho biết giá không hợp lệ; và WHEN giá của Product hợp lệ và thao tác lưu thành công, THE Catalog_System SHALL hoàn tất việc lưu và SHALL không trả về thông báo lỗi giá.
7. WHEN Catalog_System cần xác định số lượng tồn của một Product, THE Catalog_System SHALL tính số lượng tồn bằng số Product_Item của Product đó đang ở trạng thái `available`, và SHALL coi một Product là hết hàng khi và chỉ khi số lượng tồn tính động đó bằng 0.
8. IF một thao tác cố tạo Product tham chiếu tới Product_Type không tồn tại, THEN THE Catalog_System SHALL từ chối thao tác, không tạo bản ghi Product nào và trả về thông báo lỗi mô tả nguyên nhân.
9. IF một thao tác cố tạo Product_Item tham chiếu tới Product không tồn tại, THEN THE Catalog_System SHALL từ chối thao tác, không tạo bản ghi Product_Item nào và trả về thông báo lỗi mô tả nguyên nhân.
10. IF một thao tác cố xoá một Product_Type còn chứa ít nhất một Product con hoặc xoá một Product còn chứa ít nhất một Product_Item con, THEN THE Catalog_System SHALL chặn thao tác xoá, giữ nguyên các bản ghi liên quan và trả về thông báo lỗi cho biết ràng buộc toàn vẹn tham chiếu.
11. THE Catalog_System SHALL lưu trên mỗi Product_Type và mỗi Product một Base_Value cho ba trường văn bản: name (bắt buộc khác chuỗi rỗng sau khi trim), description (tuỳ chọn, cho phép rỗng hoặc null) và content (tuỳ chọn, cho phép rỗng hoặc null).

### Requirement 2: Migration dữ liệu cũ sang mô hình mới

**User Story:** Là quản trị viên shop, tôi muốn dữ liệu danh mục, sản phẩm và đơn hàng hiện có được chuyển sang mô hình ba tầng mà không mất mát, để không phải nhập lại dữ liệu và lịch sử đơn hàng vẫn nguyên vẹn.

#### Acceptance Criteria

1. THE Migration SHALL được cung cấp dưới dạng một hoặc nhiều file mới có tên theo định dạng `000N_*.sql` (N là số thứ tự lớn hơn số thứ tự của mọi file migration đã tồn tại) và SHALL không sửa đổi, xóa hoặc ghi đè nội dung của bất kỳ file migration đã tồn tại nào.
2. WHEN Migration chạy, THE Catalog_System SHALL tạo đúng một Product cho mỗi bản ghi `product_types` cũ, giữ nguyên không đổi giá trị giá, mô tả, ảnh và emoji của bản ghi cũ tương ứng.
3. WHEN Migration chạy, THE Catalog_System SHALL chuyển đúng một Product_Item cho mỗi bản ghi `products` cũ (kho tài khoản), giữ nguyên không đổi các giá trị `content`, `status`, `buyer_id`, `order_id`, `created_at` và `sold_at`.
4. WHEN Migration chạy, THE Catalog_System SHALL gán mỗi Product_Item chuyển đổi tham chiếu tới đúng Product được sinh ra từ bản ghi `product_types` cũ có giá trị khớp với `type_id` ban đầu của Product_Item đó.
5. WHEN Migration chạy, THE Catalog_System SHALL sinh đúng một Product_Type danh mục cho mỗi giá trị `category` phân biệt (khác rỗng và khác null) của các bản ghi `product_types` cũ, và gán mỗi Product mới tới Product_Type danh mục tương ứng với giá trị `category` của bản ghi gốc.
6. WHEN Migration chạy và một bản ghi `product_types` cũ có `category` rỗng hoặc null, THE Catalog_System SHALL gán Product tương ứng vào một Product_Type danh mục mặc định cố định và duy nhất (dùng chung cho mọi bản ghi thiếu `category`), sao cho không có Product nào không có Product_Type danh mục cha.
7. WHEN Migration chạy, THE Catalog_System SHALL bảo toàn mọi tham chiếu trong `orders` và `order_items` sao cho mỗi đơn hàng đã hoàn tất vẫn trỏ tới đúng Product và Product_Item tương ứng với dữ liệu trước migration.
8. WHEN Migration hoàn tất, THE Catalog_System SHALL bảo đảm tổng số Product_Item bằng tổng số bản ghi `products` cũ và tổng số đơn hàng (`orders`) bằng tổng số đơn hàng có trước khi chạy Migration.
9. IF Migration gặp lỗi tại bất kỳ bước nào trước khi hoàn tất, THEN THE Catalog_System SHALL khôi phục toàn bộ dữ liệu về trạng thái trước khi chạy Migration, không để lại bản ghi mô hình mới nào được tạo dở dang, và trả về thông báo lỗi cho biết bước đã thất bại.
10. IF sau khi Migration hoàn tất, tổng số Product_Item không bằng tổng số bản ghi `products` cũ hoặc tổng số đơn hàng khác với trước migration, THEN THE Catalog_System SHALL coi Migration là thất bại, khôi phục dữ liệu về trạng thái trước migration và trả về thông báo lỗi cho biết sai lệch số lượng.
11. WHEN Migration chạy trên một cơ sở dữ liệu có ít nhất một bản ghi `product_types` cũ hoặc ít nhất một bản ghi `products` cũ, THE Catalog_System SHALL sau khi hoàn tất tồn tại số Product và Product_Item tương ứng lớn hơn 0 đúng với số bản ghi cũ, và SHALL ghi nhận bằng chứng Migration đã thực thi bằng cách đánh dấu file Migration là đã áp dụng trong bảng theo dõi migration.
12. WHEN Migration chạy trên dữ liệu cũ không có bất kỳ bản ghi `product_types` nào có `category` rỗng hoặc null, THE Catalog_System SHALL không tạo thêm Product_Type danh mục mặc định chỉ để đại diện cho nhóm thiếu `category`.
13. IF dữ liệu cũ vừa có bản ghi thiếu `category`, vừa có một giá trị `category` hợp lệ trùng với tên hiển thị của danh mục mặc định, THEN THE Catalog_System SHALL giữ hai nhóm này là hai Product_Type riêng biệt và SHALL gán Product theo nguồn `category` gốc, không ánh xạ bằng cách lookup tên hiển thị.

### Requirement 3: Đa ngôn ngữ cho danh mục và sản phẩm

**User Story:** Là quản trị viên shop phục vụ khách nhiều ngôn ngữ, tôi muốn tên và mô tả của danh mục và sản phẩm có nhiều bản dịch, để khách thấy nội dung theo ngôn ngữ của mình.

#### Acceptance Criteria

1. THE Translation_Store SHALL lưu được bản dịch các trường hiển thị name (tối đa 200 ký tự), description (tối đa 2000 ký tự) và content (tối đa 5000 ký tự) của mỗi Product_Type theo từng mã ngôn ngữ.
2. THE Translation_Store SHALL lưu được bản dịch các trường hiển thị name (tối đa 200 ký tự), description (tối đa 2000 ký tự) và content (tối đa 5000 ký tự) của mỗi Product theo từng mã ngôn ngữ.
3. THE Translation_Store SHALL cho phép thêm một mã ngôn ngữ mới vào Supported_Languages, với tối đa 50 mã ngôn ngữ, mà không cần thêm cột hay sửa cấu trúc bảng.
4. THE Translation_Store SHALL ràng buộc mỗi tổ hợp (thực thể, mã ngôn ngữ) là duy nhất để không tồn tại hai bản dịch trùng ngôn ngữ cho cùng một thực thể.
5. WHEN Catalog_System đọc dữ liệu hiển thị của một Product_Type hoặc Product, THE Catalog_System SHALL chỉ trả về các bản dịch có mã ngôn ngữ thuộc Supported_Languages và bỏ qua các bản dịch có mã ngôn ngữ ngoài Supported_Languages.
6. WHEN Catalog_System đọc dữ liệu hiển thị của một thực thể theo một mã ngôn ngữ thuộc Supported_Languages nhưng thực thể đó chưa có bản dịch cho mã ngôn ngữ này, THE Catalog_System SHALL trả về bản dịch theo Default_Language; và WHEN Catalog_System nhận yêu cầu hiển thị theo một mã ngôn ngữ hoàn toàn không thuộc Supported_Languages, THE Catalog_System SHALL không từ chối yêu cầu và SHALL trả về bản dịch theo Default_Language.
7. IF một thao tác cố lưu một bản dịch có mã ngôn ngữ không thuộc Supported_Languages, THEN THE Translation_Store SHALL từ chối thao tác và giữ nguyên dữ liệu hiện có, kể cả khi không thể tạo hoặc trả về được thông báo lỗi (việc từ chối không phụ thuộc vào khả năng trả thông báo lỗi cho biết mã ngôn ngữ không được hỗ trợ).
8. IF một thao tác cố tạo một bản dịch cho tổ hợp (thực thể, mã ngôn ngữ) đã tồn tại, THEN THE Translation_Store SHALL từ chối thao tác, giữ nguyên bản dịch hiện có và trả về thông báo lỗi cho biết bản dịch cho ngôn ngữ này đã tồn tại.

### Requirement 4: Fallback ngôn ngữ khi hiển thị

**User Story:** Là khách hàng dùng một ngôn ngữ chưa được dịch đầy đủ, tôi muốn vẫn thấy nội dung sản phẩm đọc được thay vì khoảng trống, để có thể mua hàng bình thường.

#### Acceptance Criteria

1. THE Catalog_System SHALL coi một bản dịch của một trường văn bản là hợp lệ khi và chỉ khi giá trị của trường đó khác null và khác chuỗi rỗng sau khi loại bỏ khoảng trắng đầu cuối (trim).
2. WHEN Catalog_System hiển thị một trường văn bản của một Product_Type hoặc Product cho người dùng, THE Catalog_System SHALL chọn bản dịch hợp lệ theo Display_Language của người dùng đó cho riêng trường văn bản đó.
3. IF không tồn tại bản dịch hợp lệ theo Display_Language cho một trường văn bản, THEN THE Catalog_System SHALL dùng bản dịch hợp lệ theo Default_Language cho riêng trường văn bản đó, bất cứ khi nào không có bản dịch hợp lệ theo Display_Language (không giới hạn ở thời điểm đang hiển thị cho người dùng).
4. IF không tồn tại bản dịch hợp lệ theo cả Display_Language và Default_Language cho một trường văn bản, THEN THE Catalog_System SHALL dùng bản dịch hợp lệ theo Base_Fallback_Language cho riêng trường văn bản đó.
5. THE Catalog_System SHALL áp dụng chuỗi fallback Display_Language → Default_Language → Base_Fallback_Language → Base_Value → placeholder một cách độc lập cho từng trường văn bản (name, description, content), giống nhau cho cả Product_Type và Product.
6. IF không tồn tại bản dịch hợp lệ ở cả ba mức ngôn ngữ Display_Language, Default_Language và Base_Fallback_Language cho một trường văn bản, THEN THE Catalog_System SHALL dùng Base_Value hợp lệ của chính trường văn bản đó; và chỉ khi Base_Value của trường đó cũng không hợp lệ (rỗng hoặc null sau khi trim) thì THE Catalog_System SHALL hiển thị một giá trị placeholder khác chuỗi rỗng cho trường văn bản đó thay vì để trống.

### Requirement 5: Cập nhật kiểu dữ liệu trong mã nguồn

**User Story:** Là lập trình viên bảo trì dự án, tôi muốn các type trong `src/types/db.ts` phản ánh đúng mô hình ba tầng mới, để biên dịch TypeScript bắt lỗi sai lệch schema và mã nguồn nhất quán với DB.

#### Acceptance Criteria

1. THE Catalog_System SHALL định nghĩa trong `src/types/db.ts` một type riêng cho mỗi Product_Type, Product và Product_Item, sao cho mỗi cột của bảng tương ứng sau migration có đúng một field, kiểu cơ sở khớp (cột số nguyên ↔ number, cột văn bản ↔ string), và field chỉ nhận giá trị null khi và chỉ khi cột tương ứng cho phép NULL.
2. THE Catalog_System SHALL định nghĩa trong `src/types/db.ts` một type cho bản ghi của Translation_Store gồm field định danh thực thể được dịch, field mã ngôn ngữ, và field cho từng trường hiển thị được dịch (name, description và content), khớp 1:1 với schema bảng dịch sau migration.
3. THE Catalog_System SHALL định nghĩa type cho Product chứa field khoá ngoại tham chiếu tới Product_Type cha, và type cho Product_Item chứa field khoá ngoại tham chiếu tới Product cha, phản ánh đúng quan hệ ba tầng.
4. WHEN mã nguồn được biên dịch bằng `vue-tsc`/`tsc` và mỗi type đã được định nghĩa trong `src/types/db.ts` khớp đúng cột, kiểu cơ sở và tính cho phép null của bảng tương ứng, THE Catalog_System SHALL kết thúc tiến trình biên dịch không phát sinh lỗi kiểu do các type đã định nghĩa gây ra, kể cả khi định nghĩa của một số type chưa được bổ sung.

### Requirement 6: Duyệt và mua sản phẩm qua Bot

**User Story:** Là khách hàng dùng bot Telegram, tôi muốn duyệt danh mục rồi chọn sản phẩm cụ thể để mua, với nội dung theo ngôn ngữ của tôi, để mua đúng biến thể giá mình cần.

#### Acceptance Criteria

1. WHEN người dùng duyệt danh sách danh mục trong bot, THE Bot_Handler SHALL hiển thị các Product_Type đang ở trạng thái hiển thị, dùng tên theo Display_Language của người dùng, và khi thiếu bản dịch theo Display_Language thì dùng tên theo Default_Language.
2. WHEN người dùng chọn một Product_Type, THE Bot_Handler SHALL hiển thị các Product thuộc danh mục đó kèm giá kèm đơn vị tiền tệ, dùng tên theo Display_Language của người dùng, và khi thiếu bản dịch theo Display_Language thì dùng tên theo Default_Language.
3. WHEN người dùng chọn một Product để mua và số dư của người dùng lớn hơn hoặc bằng giá của Product đó, THE Bot_Handler SHALL khởi tạo Purchase_Transaction cho Product đó.
4. IF người dùng chọn một Product để mua nhưng số dư của người dùng nhỏ hơn giá của Product đó, THEN THE Bot_Handler SHALL thông báo số dư không đủ, không trừ số dư và không khởi tạo Purchase_Transaction.
5. IF Product được chọn không còn Product_Item nào ở trạng thái `available`, THEN THE Bot_Handler SHALL thông báo hết hàng, giữ nguyên số dư và không khởi tạo Purchase_Transaction.
6. WHEN một Purchase_Transaction hoàn tất, THE Bot_Handler SHALL gửi Success_Template theo Display_Language của người dùng, và khi thiếu bản dịch Success_Template theo Display_Language thì dùng Success_Template theo Default_Language.
7. IF không có Product_Type nào ở trạng thái hiển thị, THEN THE Bot_Handler SHALL thông báo cho người dùng rằng danh mục đang trống.
8. IF một Product_Type được chọn không có Product nào ở trạng thái hiển thị, THEN THE Bot_Handler SHALL hiển thị danh sách sản phẩm trống cho danh mục đó, kèm theo một thông báo trống tuỳ chọn cho biết danh mục chưa có sản phẩm.

### Requirement 7: Storefront Mini App theo danh mục và ngôn ngữ

**User Story:** Là khách hàng dùng Mini App, tôi muốn lọc sản phẩm theo danh mục và xem nội dung theo ngôn ngữ của tôi, để tìm sản phẩm nhanh hơn.

#### Acceptance Criteria

1. WHEN Mini_App khởi tạo, THE Mini_App SHALL hiển thị danh sách các Product_Type đang ở trạng thái hiển thị làm bộ lọc danh mục.
2. WHEN người dùng chọn một danh mục trong Mini_App, THE Mini_App SHALL hiển thị các Product thuộc Product_Type đó đang ở trạng thái hiển thị.
3. IF một danh mục được chọn không có Product nào ở trạng thái hiển thị, THEN THE Mini_App SHALL hiển thị trạng thái trống cho danh mục đó.
4. WHEN Mini_App hiển thị một trường văn bản của Product_Type hoặc Product, THE Mini_App SHALL dùng bản dịch hợp lệ theo Display_Language của người dùng.
5. IF không tồn tại bản dịch hợp lệ theo Display_Language cho một trường văn bản, THEN THE Mini_App SHALL duyệt chuỗi fallback Display_Language → Default_Language → Base_Fallback_Language → Base_Value và dùng giá trị hợp lệ đầu tiên tìm được cho trường văn bản đó; và chỉ khi không có giá trị hợp lệ nào trong toàn bộ chuỗi (kể cả Base_Value) thì THE Mini_App SHALL hiển thị một giá trị placeholder khác chuỗi rỗng cho trường văn bản đó.
6. WHERE một Product không có ảnh nhưng có emoji, THE Mini_App SHALL hiển thị emoji của Product đó làm ảnh thay thế.
7. WHERE một Product không có ảnh và không có emoji nhưng Product_Type cha có emoji, THE Mini_App SHALL hiển thị emoji của Product_Type cha làm ảnh thay thế.
8. THE Mini_App SHALL hiển thị giá lấy từ tầng Product.
9. IF việc hiển thị emoji thay thế thất bại hoặc emoji không được hỗ trợ trên thiết bị người dùng, THEN THE Mini_App SHALL bỏ qua hiển thị emoji và SHALL có thể không hiển thị ảnh nào, không gây lỗi giao diện.

### Requirement 8: Quản lý ba tầng và bản dịch trong CMS

**User Story:** Là quản trị viên shop, tôi muốn quản lý danh mục, sản phẩm, kho hàng và soạn bản dịch trong CMS, để vận hành cửa hàng đa ngôn ngữ mà không cần can thiệp DB.

#### Acceptance Criteria

1. THE CMS SHALL cho phép tạo, sửa, ẩn/hiện và xoá Product_Type.
2. THE CMS SHALL cho phép tạo, sửa, ẩn/hiện và xoá Product gắn với đúng một Product_Type.
3. THE CMS SHALL cho phép thêm và xoá Product_Item (kho) gắn với đúng một Product.
4. WHEN quản trị viên lưu bản dịch name, description và content cho một Product_Type theo một mã ngôn ngữ thuộc Supported_Languages với name dài từ 1 đến 200 ký tự, description dài tối đa 2000 ký tự và content dài tối đa 5000 ký tự, THE CMS SHALL lưu bản dịch đó.
5. WHEN quản trị viên lưu bản dịch name, description và content cho một Product theo một mã ngôn ngữ thuộc Supported_Languages với name dài từ 1 đến 200 ký tự, description dài tối đa 2000 ký tự và content dài tối đa 5000 ký tự, THE CMS SHALL lưu bản dịch đó.
6. IF điều kiện giá không hợp lệ của một Product được thỏa (giá nhỏ hơn hoặc bằng 0, không phải số nguyên, hoặc lớn hơn 999.999.999), THEN THE CMS SHALL từ chối thao tác, giữ nguyên giá hiện có và hiển thị thông báo lỗi cho biết giá không hợp lệ bất cứ khi nào điều kiện giá không hợp lệ được thỏa, không phụ thuộc vào việc có đang thực hiện thao tác lưu giá hay không; việc hiển thị thông báo lỗi giá SHALL không chặn các thao tác khác không liên quan tới việc lưu giá; và IF quản trị viên cố lưu một Product có giá không hợp lệ, THEN THE CMS SHALL từ chối toàn bộ thao tác lưu, không lưu một phần bất kỳ trường nào khác của bản ghi (nhất quán với Requirement 1 tiêu chí 6).
7. IF quản trị viên xoá một Product_Type còn chứa ít nhất một Product, THEN THE CMS SHALL chặn thao tác xoá, giữ nguyên Product_Type đó cùng các Product con và hiển thị thông báo yêu cầu xử lý các Product con trước khi xoá.
8. IF quản trị viên lưu một bản dịch có mã ngôn ngữ không thuộc Supported_Languages, THEN THE CMS SHALL từ chối thao tác và hiển thị thông báo lỗi cho biết mã ngôn ngữ không được hỗ trợ.
9. IF quản trị viên lưu một bản dịch có name rỗng, name dài quá 200 ký tự, description dài quá 2000 ký tự, hoặc content dài quá 5000 ký tự, THEN THE CMS SHALL từ chối thao tác và hiển thị thông báo lỗi cho biết giá trị không hợp lệ.

### Requirement 9: Đơn hàng tham chiếu mô hình mới

**User Story:** Là quản trị viên shop, tôi muốn đơn hàng ghi nhận đúng sản phẩm và tài khoản đã bán theo mô hình mới, để báo cáo doanh thu và tra cứu lịch sử chính xác.

#### Acceptance Criteria

1. WHEN một Purchase_Transaction được xác nhận thanh toán thành công, THE Catalog_System SHALL tạo bản ghi đơn hàng tham chiếu tới đúng Product được mua thông qua khóa tham chiếu Product.
2. WHEN một Purchase_Transaction được xác nhận thanh toán thành công, THE Catalog_System SHALL tạo một dòng chi tiết đơn hàng cho mỗi Product_Item đã bán, mỗi dòng tham chiếu tới đúng Product_Item đó.
3. WHEN một Product_Item được bán trong một Purchase_Transaction được xác nhận thanh toán thành công, THE Catalog_System SHALL chuyển trạng thái Product_Item đó sang `sold` như một phần không thể tách rời của Purchase_Transaction atomic; IF bước chuyển trạng thái này thất bại, THEN THE Catalog_System SHALL khôi phục toàn bộ Purchase_Transaction về trạng thái trước giao dịch và SHALL không hoàn tất đơn hàng với bất kỳ Product_Item nào chưa chuyển sang `sold`.
4. WHEN một Product_Item được chuyển sang trạng thái `sold`, THE Catalog_System SHALL gán `buyer_id` bằng định danh tài khoản người mua của Purchase_Transaction đó và `order_id` bằng định danh đơn hàng vừa tạo ở tiêu chí 1.
5. IF một Product_Item đang được gán cho đơn mới nhưng đã ở trạng thái `sold`, THEN THE Catalog_System SHALL từ chối ghi nhận Product_Item đó vào đơn mới, giữ nguyên trạng thái, `buyer_id` và `order_id` hiện có, và trả về thông báo lỗi cho biết Product_Item đã được bán.
6. THE Catalog_System SHALL cho phép truy vấn mọi đơn hàng được tạo trước migration sau khi áp dụng mô hình mới, trả về đầy đủ thông tin sản phẩm và người mua tương ứng mà không làm mất hoặc thay đổi dữ liệu lịch sử.
7. IF việc chuyển trạng thái một Product_Item sang `sold` thất bại do ràng buộc cơ sở dữ liệu hoặc thao tác đồng thời, THEN THE Catalog_System SHALL để toàn bộ Purchase_Transaction thất bại hoàn toàn và khôi phục về trạng thái trước giao dịch (rollback), không hoàn tất đơn hàng.

### Requirement 10: Tính atomic và ràng buộc số dư

**User Story:** Là chủ shop, tôi muốn giao dịch mua hàng vẫn đảm bảo tính toàn vẹn và số dư không âm sau khi nâng cấp mô hình, để không xảy ra bán trùng tài khoản hay âm quỹ.

#### Acceptance Criteria

1. WHEN nhiều giao dịch mua đồng thời nhắm cùng một Product_Item, THE Purchase_Transaction SHALL chỉ cho đúng một giao dịch bán được Product_Item đó.
2. IF một giao dịch mua đồng thời thua trong tranh chấp cùng một Product_Item, THEN THE Purchase_Transaction SHALL từ chối giao dịch đó, giữ nguyên số dư người dùng và trạng thái kho, và trả về thông báo lỗi cho biết Product_Item đã được bán cho giao dịch khác.
3. THE Catalog_System SHALL duy trì tại tầng cơ sở dữ liệu một ràng buộc CHECK từ chối mọi thao tác làm số dư người dùng nhỏ hơn 0.
4. IF số dư người dùng không đủ cho tổng tiền đơn hàng, THEN THE Purchase_Transaction SHALL từ chối giao dịch, không thay đổi số dư cũng như trạng thái kho, và trả về thông báo lỗi cho biết số dư không đủ; và IF tổng tiền đơn hàng bằng 0, THEN THE Purchase_Transaction SHALL vẫn từ chối giao dịch mua, không thay đổi số dư cũng như trạng thái kho (không miễn trừ đơn có tổng tiền bằng 0), nhất quán với tiêu chí 6.
5. WHEN một bước trong Purchase_Transaction thất bại, THE Purchase_Transaction SHALL khôi phục toàn bộ giao dịch về trạng thái trước giao dịch (toàn bộ hoặc không gì cả) và trả về thông báo lỗi cho biết bước đã thất bại.
6. IF số dư người dùng bằng 0, THEN THE Purchase_Transaction SHALL từ chối giao dịch mua, không thay đổi số dư cũng như trạng thái kho, và trả về thông báo lỗi cho biết số dư không đủ (giao dịch mua yêu cầu số dư dương).

### Requirement 11: Tương thích ngược và an toàn vận hành khi migrate

**User Story:** Là chủ shop đang chạy production, tôi muốn việc nâng cấp giảm thiểu gián đoạn và không để hệ thống ở trạng thái nửa vời, để khách vẫn mua hàng được sau khi migration hoàn tất mà không cần thao tác thủ công bổ sung.

#### Acceptance Criteria

1. WHEN Migration chạy, THE Migration SHALL giữ nguyên đúng số lượng bản ghi của bảng `product_type_templates` hiện có và toàn bộ nội dung của từng trường trong mỗi bản ghi, không thêm, không xóa và không sửa đổi bản ghi nào.
2. WHEN Migration hoàn tất, THE Catalog_System SHALL phục vụ được trọn vẹn flow duyệt và mua sản phẩm mà không cần bất kỳ thao tác thủ công bổ sung nào từ quản trị viên.
3. WHILE Migration đang chạy, THE Migration SHALL không đánh dấu file migration là đã áp dụng cho tới khi toàn bộ bước đổi schema, copy dữ liệu và đối soát hoàn tất; và WHEN Migration đã commit thành công, THE Catalog_System SHALL xử lý mọi request hợp lệ của khách bằng schema mới mà không cần thao tác thủ công bổ sung, không để request quan sát trạng thái schema nửa cũ nửa mới đã được ghi nhận là hợp lệ.
4. WHEN Catalog_System hiển thị một Product_Type hoặc Product ngay sau migration kể cả khi chưa có bản dịch nào được soạn thêm, THE Catalog_System SHALL hiển thị Base_Value của thực thể đó (chính là tên đã có trước migration) với giá trị khác chuỗi rỗng.
5. WHERE một mã ngôn ngữ mới được thêm vào Supported_Languages, THE Catalog_System SHALL hoạt động mà không cần thay đổi schema cơ sở dữ liệu.
6. IF Migration thất bại tại bất kỳ bước nào, THEN THE Catalog_System SHALL khôi phục toàn bộ dữ liệu về trạng thái trước migration, giữ nguyên dữ liệu hiện có và trả về thông báo lỗi cho biết bước đã thất bại.
7. IF Base_Value của trường name của một Product_Type hoặc Product (chính là tên gốc trước migration) là rỗng hoặc null sau khi trim và không tồn tại bản dịch hợp lệ nào, THEN THE Catalog_System SHALL hiển thị một giá trị placeholder mặc định hoặc một định danh do hệ thống sinh ra, khác chuỗi rỗng.
