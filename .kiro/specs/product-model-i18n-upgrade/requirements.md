# Requirements Document

## Introduction

Tài liệu này mô tả yêu cầu cho việc **nâng cấp mô hình dữ liệu phần sản phẩm và đa ngôn ngữ hoá** của Telegram Shop Bot.

Mục tiêu nghiệp vụ:

1. **Đặt lại tên mô hình cho đúng ngữ nghĩa**:
   - Bảng `product_types` hiện tại (loại sản phẩm bán ra, có giá) đổi tên thành `products`.
   - Bảng `products` hiện tại (kho tài khoản cụ thể) đổi tên thành `product_items`.
2. **Bổ sung tầng danh mục (Category)**: gom nhiều `products` vào một danh mục. Ví dụ: danh mục "ChatGPT" chứa các sản phẩm "ChatGPT bảo hành 7 ngày", "ChatGPT bảo hành 30 ngày"; mỗi sản phẩm lại sở hữu nhiều `product_items` (tài khoản cụ thể).
3. **Đa ngôn ngữ hoá mọi thông tin hiển thị cho người dùng** ở cả `products` (name, description, success_template) và `categories` (name, description).
4. **Thiết kế dễ mở rộng ngôn ngữ**: thêm một ngôn ngữ mới về sau chỉ cần thêm dữ liệu/catalog, KHÔNG đổi schema DB và KHÔNG sửa lõi xử lý; tránh trùng lặp dữ liệu (DRY) và tránh cấu trúc cồng kềnh (không thêm cột cứng cho từng ngôn ngữ).

Phạm vi kỹ thuật bị ảnh hưởng: schema D1 (`migrations/`), `src/types/db.ts`, handler bot (`src/bot`), API admin và Mini App (`src/routes`), service giao dịch (`src/services`), CMS (`cms/`), Mini App (`miniapp/`).

Ràng buộc dự án quan trọng (theo `AGENTS.md`):
- Migration chỉ THÊM file mới (`000N_*.sql`), KHÔNG sửa migration đã chạy.
- Sau khi đổi schema phải cập nhật `src/types/db.ts`.
- KHÔNG chèn emoji do agent tự thêm (emoji là dữ liệu admin nhập thì giữ nguyên).
- Tập ngôn ngữ là **tập mở**, kiểm tra ở tầng ứng dụng theo registry `SUPPORTED_LANGUAGES`, KHÔNG dùng CHECK constraint cứng cho `lang`.

## Glossary

- **System**: Toàn bộ hệ thống Telegram Shop Bot (Worker backend, Bot, Mini App, CMS).
- **Migration_System**: Thành phần áp các file migration SQL theo thứ tự vào D1.
- **Backend_API**: REST API phục vụ Bot (webhook), Mini App (`/api/app/*`) và CMS (`/api/admin/*`).
- **Bot**: Trình xử lý webhook Telegram trong `src/bot`.
- **Mini_App**: SPA Vue trong `miniapp/` (storefront cho người mua).
- **CMS**: SPA Vue quản trị trong `cms/`.
- **Category**: Danh mục gom nhóm sản phẩm (ví dụ "ChatGPT"). Sau nâng cấp là một thực thể có khoá riêng và dữ liệu đa ngôn ngữ.
- **Product**: Loại sản phẩm bán ra có giá (ví dụ "ChatGPT bảo hành 7 ngày"). Tương ứng bảng `products` sau khi đổi tên từ `product_types`.
- **Product_Item**: Tài khoản cụ thể (content) thuộc một Product. Tương ứng bảng `product_items` sau khi đổi tên từ `products`.
- **Translatable_Field**: Trường thông tin hiển thị cho người dùng cần đa ngôn ngữ (name, description, success_template, ...).
- **Translation_Record**: Bản ghi chứa giá trị một hoặc nhiều Translatable_Field của một thực thể theo một mã ngôn ngữ (`lang`).
- **Lang**: Mã locale dạng BCP-47 rút gọn (`vi`, `en`, `th`, ...).
- **SUPPORTED_LANGUAGES**: Registry mã ngôn ngữ hợp lệ (single source of truth tại `src/i18n/locales.ts`).
- **Default_Language**: Mã locale mặc định lưu ở `system_config.default_language`, dùng khi người dùng chưa xác định ngôn ngữ.
- **Base_Fallback_Lang**: Mắt xích cuối của chuỗi fallback ngôn ngữ (hiện là `en`).
- **Resolved_Text**: Chuỗi văn bản cuối cùng hiển thị cho người dùng sau khi áp quy tắc chọn ngôn ngữ và fallback.

## Requirements

### Requirement 1: Đổi tên bảng product_types thành products

**User Story:** Là người phát triển, tôi muốn bảng loại sản phẩm có tên `products` đúng ngữ nghĩa, để mô hình dữ liệu phản ánh đúng khái niệm nghiệp vụ.

#### Acceptance Criteria

1. THE Migration_System SHALL tạo bảng `products` mang toàn bộ trường nghiệp vụ phi-văn-bản của `product_types` hiện tại (id, price, emoji, image_data, sort_order, is_visible, created_at, updated_at).
2. THE Migration_System SHALL di trú toàn bộ dữ liệu hàng từ `product_types` sang `products` giữ nguyên giá trị `id`.
3. WHERE một file migration mới được thêm cho việc đổi tên, THE Migration_System SHALL chỉ thêm file `000N_*.sql` mới và giữ nguyên các file migration đã tồn tại.
4. THE Backend_API SHALL truy vấn loại sản phẩm từ cấu trúc bảng `products` mới sau khi migration được áp.

### Requirement 2: Đổi tên bảng products thành product_items

**User Story:** Là người phát triển, tôi muốn kho tài khoản cụ thể có tên `product_items`, để phân biệt rõ với loại sản phẩm bán ra.

#### Acceptance Criteria

1. THE Migration_System SHALL tạo bảng `product_items` mang toàn bộ trường của bảng `products` (kho) hiện tại (id, content, status, buyer_id, order_id, created_at, sold_at).
2. THE Migration_System SHALL thay khoá ngoại trỏ tới loại sản phẩm bằng cột `product_id` tham chiếu `products(id)`.
3. THE Migration_System SHALL di trú toàn bộ dữ liệu hàng từ bảng kho cũ sang `product_items` giữ nguyên giá trị `id` và ánh xạ `type_id` cũ thành `product_id`.
4. THE Migration_System SHALL giữ ràng buộc duy nhất (content không trùng trong cùng một Product) tương đương ràng buộc `idx_products_content_type` hiện tại.
5. THE Backend_API SHALL truy vấn kho tài khoản từ cấu trúc bảng `product_items` mới sau khi migration được áp.

### Requirement 3: Cập nhật tham chiếu khoá ngoại ở bảng orders và order_items

**User Story:** Là người phát triển, tôi muốn các bảng liên quan tham chiếu đúng tên mới, để đảm bảo toàn vẹn dữ liệu sau khi đổi tên.

#### Acceptance Criteria

1. THE Migration_System SHALL cung cấp cột `orders.product_id` tham chiếu `products(id)` thay cho `orders.product_type_id`.
2. THE Migration_System SHALL di trú giá trị `orders.product_type_id` hiện có sang `orders.product_id` cho mọi đơn hàng.
3. THE Migration_System SHALL cung cấp cột tham chiếu kho ở `order_items` trỏ tới `product_items(id)`.
4. THE Migration_System SHALL di trú giá trị tham chiếu kho hiện có ở `order_items` sang cột mới cho mọi dòng.
5. IF một dòng `orders` hoặc `order_items` không ánh xạ được sang khoá mới, THEN THE Migration_System SHALL dừng migration với lỗi và không để dữ liệu ở trạng thái nửa vời.

### Requirement 4: Tầng danh mục (Category) là thực thể có khoá riêng

**User Story:** Là quản trị viên, tôi muốn gom nhiều sản phẩm vào một danh mục có định danh riêng, để tổ chức gian hàng theo nhóm (ví dụ "ChatGPT") và hiển thị danh mục đa ngôn ngữ.

#### Acceptance Criteria

1. THE Migration_System SHALL cung cấp bảng `categories` với khoá chính riêng và các trường nghiệp vụ phi-văn-bản (id, emoji, sort_order, is_visible, created_at, updated_at).
2. THE Migration_System SHALL cung cấp cột `products.category_id` tham chiếu `categories(id)`.
3. THE Migration_System SHALL tạo các bản ghi `categories` từ tập giá trị `category` (text) phân biệt hiện có trong `product_types`, và gán `products.category_id` tương ứng cho từng Product.
4. IF một Product hiện không có giá trị `category` (null hoặc rỗng), THEN THE Migration_System SHALL để `products.category_id` của Product đó ở trạng thái chưa phân nhóm (null).
5. WHEN người mua mở danh sách gian hàng, THE Mini_App SHALL hiển thị các danh mục dựa trên thực thể `categories`.

### Requirement 5: Lưu trữ đa ngôn ngữ cho Product

**User Story:** Là quản trị viên bán hàng quốc tế, tôi muốn nhập tên, mô tả và mẫu tin nhắn thành công của sản phẩm theo nhiều ngôn ngữ, để người mua thấy nội dung bằng ngôn ngữ của họ.

#### Acceptance Criteria

1. THE System SHALL lưu các Translatable_Field của Product (name, description, success_template) trong Translation_Record khoá theo cặp (định danh Product, `lang`).
2. THE System SHALL cho phép tồn tại nhiều Translation_Record cho một Product, mỗi `lang` tối đa một bản ghi.
3. WHEN một ngôn ngữ mới được thêm vào SUPPORTED_LANGUAGES, THE System SHALL hỗ trợ lưu Translation_Record cho ngôn ngữ đó mà không cần thêm hoặc đổi cột schema.
4. THE Migration_System SHALL di trú nội dung `name`, `description`, `success_template` hiện có của `product_types` thành Translation_Record gắn mã ngôn ngữ Default_Language.
5. THE Migration_System SHALL hợp nhất dữ liệu `product_type_templates` hiện có (đã khoá theo `lang`) vào cấu trúc Translation_Record của Product, không làm mất bản dịch đã có.

### Requirement 6: Lưu trữ đa ngôn ngữ cho Category

**User Story:** Là quản trị viên, tôi muốn nhập tên và mô tả danh mục theo nhiều ngôn ngữ, để nhãn danh mục trên gian hàng hiển thị đúng ngôn ngữ người dùng.

#### Acceptance Criteria

1. THE System SHALL lưu các Translatable_Field của Category (name, description) trong Translation_Record khoá theo cặp (định danh Category, `lang`).
2. THE System SHALL cho phép tồn tại nhiều Translation_Record cho một Category, mỗi `lang` tối đa một bản ghi.
3. WHEN một ngôn ngữ mới được thêm vào SUPPORTED_LANGUAGES, THE System SHALL hỗ trợ lưu Translation_Record cho Category bằng ngôn ngữ đó mà không cần thêm hoặc đổi cột schema.
4. THE Migration_System SHALL tạo Translation_Record gắn Default_Language cho mỗi Category sinh ra từ giá trị `category` text cũ, dùng chính giá trị text đó làm `name`.

### Requirement 7: Chọn ngôn ngữ hiển thị và fallback

**User Story:** Là người mua, tôi muốn luôn thấy được nội dung sản phẩm/danh mục ngay cả khi thiếu bản dịch cho ngôn ngữ của tôi, để không gặp ô trống.

#### Acceptance Criteria

1. WHEN Backend_API cần Resolved_Text của một Translatable_Field cho một `lang`, THE Backend_API SHALL trả về giá trị của Translation_Record khớp `lang` nếu tồn tại và không rỗng.
2. IF không có Translation_Record khớp `lang` hoặc giá trị rỗng, THEN THE Backend_API SHALL lùi về giá trị theo Default_Language.
3. IF không có giá trị theo `lang` lẫn Default_Language, THEN THE Backend_API SHALL lùi về giá trị theo Base_Fallback_Lang.
4. THE Backend_API SHALL bỏ qua mọi Translation_Record có `lang` không thuộc SUPPORTED_LANGUAGES khi phân giải Resolved_Text.
5. WHEN người mua xem sản phẩm hoặc danh mục, THE Mini_App SHALL hiển thị Resolved_Text theo ngôn ngữ hiện tại của người dùng.
6. WHEN Bot gửi tin nhắn mua hàng thành công, THE Bot SHALL render success_template theo ngôn ngữ của người dùng đặt hàng áp dụng cùng quy tắc fallback.

### Requirement 8: Quản trị đa ngôn ngữ qua CMS

**User Story:** Là quản trị viên, tôi muốn nhập và chỉnh sửa bản dịch của sản phẩm và danh mục theo từng tab ngôn ngữ trong CMS, để quản lý nội dung đa ngôn ngữ tại một nơi.

#### Acceptance Criteria

1. THE CMS SHALL hiển thị các tab ngôn ngữ sinh động từ SUPPORTED_LANGUAGES khi tạo hoặc sửa Product và Category.
2. WHEN quản trị viên lưu một Product với nội dung của một `lang`, THE Backend_API SHALL ghi (tạo mới hoặc cập nhật) Translation_Record tương ứng theo cặp (định danh Product, `lang`).
3. WHEN quản trị viên lưu một Category với nội dung của một `lang`, THE Backend_API SHALL ghi (tạo mới hoặc cập nhật) Translation_Record tương ứng theo cặp (định danh Category, `lang`).
4. WHEN một ngôn ngữ mới được thêm vào SUPPORTED_LANGUAGES, THE CMS SHALL hiển thị tab ngôn ngữ mới đó mà không cần đổi mã nguồn lõi của form.
5. IF quản trị viên gửi nội dung kèm mã `lang` không thuộc SUPPORTED_LANGUAGES, THEN THE Backend_API SHALL từ chối yêu cầu và trả về lỗi mô tả.
6. WHILE quản trị viên gán danh mục cho một Product, THE CMS SHALL cho phép chọn Category từ danh sách thực thể `categories`.

### Requirement 9: Mở rộng ngôn ngữ không đổi schema và không sửa lõi

**User Story:** Là người phát triển, tôi muốn thêm một ngôn ngữ mới chỉ bằng cách thêm dữ liệu và catalog, để chi phí mở rộng thấp và cấu trúc không cồng kềnh.

#### Acceptance Criteria

1. THE System SHALL biểu diễn dữ liệu dịch của Product và Category bằng cấu trúc khoá theo `lang` (mỗi ngôn ngữ một bản ghi), KHÔNG dùng cột riêng cho từng ngôn ngữ.
2. THE Migration_System SHALL định nghĩa cột `lang` không kèm CHECK constraint liệt kê cứng các mã ngôn ngữ.
3. WHEN một mã ngôn ngữ được thêm vào SUPPORTED_LANGUAGES, THE System SHALL phục vụ nội dung ngôn ngữ đó qua Bot, Mini_App và CMS mà không cần file migration mới.
4. THE System SHALL lưu mỗi Translatable_Field cho mỗi (thực thể, `lang`) tại đúng một nơi để tránh trùng lặp nguồn dữ liệu.

### Requirement 10: Cập nhật kiểu dữ liệu và tham chiếu mã nguồn

**User Story:** Là người phát triển, tôi muốn toàn bộ mã nguồn và kiểu TypeScript phản ánh tên bảng/cột mới, để dự án biên dịch và chạy đúng sau nâng cấp.

#### Acceptance Criteria

1. THE System SHALL cập nhật `src/types/db.ts` để các interface khớp với schema `products`, `product_items`, `categories` và các bảng Translation_Record mới.
2. THE Backend_API SHALL cập nhật mọi truy vấn trong `src/bot`, `src/routes`, `src/services` để dùng tên bảng và cột mới.
3. THE Mini_App SHALL cập nhật các kiểu và lệnh gọi API để khớp dữ liệu sản phẩm/danh mục đa ngôn ngữ mới.
4. THE CMS SHALL cập nhật các kiểu và lệnh gọi API để khớp dữ liệu sản phẩm/danh mục đa ngôn ngữ mới.
5. WHEN bộ kiểm thử `npm test` chạy sau nâng cấp, THE System SHALL biên dịch và vượt qua các bài kiểm thử liên quan tới luồng sản phẩm, đơn hàng và template.

### Requirement 11: Bảo toàn dữ liệu và tính atomic của giao dịch

**User Story:** Là chủ shop, tôi muốn việc nâng cấp không làm mất dữ liệu hiện có và không phá vỡ luồng mua hàng atomic, để hoạt động kinh doanh liên tục.

#### Acceptance Criteria

1. THE Migration_System SHALL bảo toàn toàn bộ đơn hàng, kho tài khoản, bản dịch và liên kết người mua hiện có sau khi nâng cấp.
2. WHEN người mua thực hiện mua hàng sau nâng cấp, THE Backend_API SHALL giữ tính atomic (tạo order trước rồi batch các bước phụ thuộc) và guard số dư không âm như hiện tại.
3. IF migration thất bại giữa chừng, THEN THE Migration_System SHALL không để schema ở trạng thái hỗn hợp khiến Backend_API không truy vấn được dữ liệu sản phẩm.
4. THE Backend_API SHALL tiếp tục đảm bảo `product_items.content` là duy nhất trong phạm vi một Product sau nâng cấp.
