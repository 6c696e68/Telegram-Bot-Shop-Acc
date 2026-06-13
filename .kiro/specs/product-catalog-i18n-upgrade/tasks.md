# Implementation Plan: Product Catalog i18n Upgrade

## Overview

Kế hoạch hiện thực mô hình sản phẩm ba tầng (Product_Type / Product / Product_Item) có đa ngôn ngữ và fallback theo từng trường cho Telegram Shop Bot (Cloudflare Worker + D1 + Hono + Vue CMS + Mini App). Ngôn ngữ hiện thực: **TypeScript** (đúng stack hiện có). Test thuộc tính dùng **vitest + fast-check** (mỗi property test tối thiểu 100 vòng, gắn tag `Feature: product-catalog-i18n-upgrade, Property {số}: {nội dung}`).

Thứ tự xây dựng tăng dần, an toàn từ dưới lên: (1) migration 0015 + types DB, (2) ánh xạ migration thuần + PBT, (3) i18n resolver thuần + PBT, (4) catalog-service tồn kho động + PBT, (5) transaction atomic mô hình mới + PBT, (6) CMS API ba tầng + bản dịch + PBT, (7) Mini App API + storefront, (8) Bot duyệt 2 cấp + success_template, (9) CMS UI editor bản dịch, (10) tích hợp + verify.

Tuân thủ AGENTS.md: migration chỉ thêm file mới `0015_*`; cập nhật `src/types/db.ts` ngay sau khi đổi cột; giữ tính atomic giao dịch; không tự thêm emoji; lệnh chạy lâu (build/test/migrate) chạy bằng background process và đọc log dần.

## Tasks

- [x] 1. Migration 0015 và cập nhật types DB nền tảng
  - [x] 1.1 Viết file migration `migrations/0015_product_three_tier_i18n.sql`
    - Thực hiện đúng 11 bước trong Migration Plan của design: `PRAGMA foreign_keys=OFF`; chụp số đếm `_pre`; đổi `products` (cũ) → `product_items_old` và `type_id` → `product_id`; đổi `product_types` → `product_types_old`; tạo `product_types` mới (danh mục, không giá); chỉ tạo danh mục mặc định id=1 khi thật sự có category null/rỗng; tạo `_category_map` tạm cho mỗi `category` DISTINCT khác rỗng sau trim và dùng map này để gán `products.product_type_id` (không lookup bằng tên hiển thị); tạo `products` mới (giá, GIỮ NGUYÊN id cũ) gắn `product_type_id`; rebuild `product_items` final từ `product_items_old` để FK `product_id` trỏ đúng `products(id)`; rebuild `product_type_templates` (copy 1:1, retarget FK→products, giữ tên cột `product_type_id`); rebuild `orders` (`product_type_id`→`product_id`); rebuild `order_items` (`product_id`→`product_item_id`); tạo `product_type_translations` + `product_translations`; tạo các index; bước đối soát số đếm và FK mới bằng `CHECK(ok = 1)` để ép lỗi khi sai lệch; `DROP product_items_old`; `DROP product_types_old`; `PRAGMA foreign_keys=ON`
    - Thêm CHECK `price >= 1 AND price <= 999999999` cho `products`, giữ CHECK `status IN ('available','sold','reserved')` cho `product_items`, `UNIQUE(entity_id, lang)` cho hai bảng dịch; không tự thêm emoji mặc định mới, `emoji` nullable/rỗng là trạng thái không có emoji
    - DỌN INDEX CŨ TRÙNG LẶP: sau khi `ALTER TABLE products RENAME TO product_items_old` + `RENAME COLUMN type_id TO product_id`, SQLite tự mang theo các index cũ từ `0001_initial_schema.sql` trên `product_items_old`. Vì `product_items` final được rebuild mới, các index cũ sẽ biến mất khi drop `product_items_old`; tạo index mới với tên `idx_product_items_*` trên bảng final và đảm bảo không còn hai index trùng cột trên `product_items`
    - KHÔNG sửa bất kỳ file migration đã tồn tại (0001..0014)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.4, 2.5, 2.6, 2.7, 2.8, 2.10, 2.11, 2.12, 2.13, 3.4, 11.1_

  - [x] 1.2 Cập nhật `src/types/db.ts` theo schema ba tầng mới
    - Định nghĩa/cập nhật `DbProductType` (không có `price`), `DbProduct` (có `product_type_id`, `price`), `DbProductItem` (đổi tên từ DbProduct cũ, có `product_id`), `DbProductTranslation`, `DbProductTypeTranslation`; cập nhật `DbOrder` (`product_id`), `DbOrderItem` (`product_item_id`); giữ `DbProductTypeTemplate`
    - Mỗi field nhận `null` khi và chỉ khi cột tương ứng cho phép NULL; kiểu cơ sở khớp cột (number ↔ INTEGER, string ↔ TEXT)
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [x] 2. Hàm ánh xạ migration thuần và property test
  - [x] 2.1 Viết hàm thuần `mapLegacyToThreeTier` trong `src/services/catalog-migration-map.ts`
    - Nhận mô hình "DB cũ" in-memory (product_types cũ với `category` kể cả null/rỗng, products cũ, orders, order_items, product_type_templates), trả mô hình mới (product_types danh mục, products, product_items, orders, order_items, templates)
    - Bảo toàn id (id products mới = id product_types cũ); mỗi `category` DISTINCT khác null/rỗng sau trim → 1 danh mục; mọi bản ghi thiếu category → danh mục mặc định id=1; không tạo danh mục mặc định nếu không có bản ghi thiếu category; category hợp lệ trùng tên hiển thị mặc định vẫn là danh mục riêng; giữ nguyên product_type_templates
    - _Requirements: 2.2, 2.4, 2.5, 2.6, 2.7, 2.8, 2.10, 2.11, 2.12, 2.13, 9.6, 11.1_

  - [x] 2.2 Viết property test cho ánh xạ migration trong `test/catalog-migration-map.property.test.ts`
    - **Property 5: Migration bảo toàn số lượng và ánh xạ**
    - **Validates: Requirements 2.2, 2.4, 2.5, 2.6, 2.7, 2.8, 2.10, 2.11, 2.12, 2.13, 9.6**

  - [x] 2.3 Viết property test bảo toàn nguyên vẹn templates trong cùng file test
    - **Property 6: Migration bảo toàn nguyên vẹn product_type_templates**
    - **Validates: Requirements 11.1**

- [x] 3. i18n resolver thuần và property test
  - [x] 3.1 Viết `src/services/i18n-catalog.ts` với hàm thuần fallback
    - `isValidText` (khác null và khác rỗng sau trim); `resolveDisplayText` áp dụng độc lập từng trường chuỗi `Display_Language → Default_Language → BASE_FALLBACK_LANG → Base_Value → placeholder`; hằng `DISPLAY_PLACEHOLDER` khác rỗng sinh theo id
    - `loadProductTranslations` / `loadProductTypeTranslations` nạp từ D1 và lọc chỉ giữ lang thuộc `SUPPORTED_LANGUAGES` (dùng `isSupportedLang` từ `src/i18n/locales.ts`); `loadDisplayLang` đọc `default_language` từ `system_config`, sai → `BASE_FALLBACK_LANG`
    - _Requirements: 3.5, 3.6, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 11.4, 11.5, 11.7_

  - [x] 3.2 Viết property test fallback hiển thị trong `test/i18n-catalog.property.test.ts`
    - **Property 11: Fallback hiển thị theo từng trường luôn cho chuỗi khác rỗng**
    - **Validates: Requirements 3.6, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 11.4, 11.5, 11.7**

  - [x] 3.3 Viết property test lọc ngôn ngữ khi đọc trong cùng file test
    - **Property 8: Đọc chỉ trả ngôn ngữ thuộc registry**
    - **Validates: Requirements 3.5**

- [x] 4. Catalog-service tồn kho động và property test
  - [x] 4.1 Viết `src/services/catalog-service.ts`
    - `getProductStock` (COUNT product_items `available` theo product_id), `isInStock` (stock > 0), `listVisibleCategories`, `listVisibleProducts`, `listProductsWithStock` (LEFT JOIN COUNT để vẫn liệt kê sản phẩm hết hàng); tách logic đếm tồn kho thành hàm thuần `computeStock(items)` để PBT
    - `pickThumbnail` (ưu tiên `product.image_data` → `product.emoji` → `productType.emoji` → không có) làm hàm thuần dùng chung
    - _Requirements: 1.7, 6.2, 7.2, 7.6, 7.7, 7.8_

  - [x] 4.2 Viết property test tồn kho động trong `test/catalog-service.property.test.ts`
    - **Property 2: Tồn kho động bằng số Product_Item available**
    - **Validates: Requirements 1.7**

  - [x] 4.3 Viết property test ưu tiên ảnh thay thế trong cùng file test
    - **Property 12: Ưu tiên ảnh thay thế của Product**
    - **Validates: Requirements 7.6, 7.7**

- [x] 5. Checkpoint - nền tảng dữ liệu và logic thuần
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Cập nhật giao dịch mua atomic theo mô hình mới và property test
  - [x] 6.1 Cập nhật `src/services/transaction.ts` cho mô hình 3 tầng
    - Đổi chữ ký `executePurchase(db, userId, productId, quantity, unitPrice)`; Phase 1 tạo `orders` với `product_id`; Phase 2 giành kho `UPDATE product_items SET status='sold' WHERE status='available' AND id IN (...)` (rows đổi < quantity → hoàn nguyên, báo hết hàng); Phase 3 trừ số dư guard `WHERE balance >= total` + chống lost update, thêm guard `total <= 0` → từ chối; Phase 4 ghi `order_items` với `product_item_id` + `transactions`
    - Đổi query nguồn hàng từ `WHERE type_id = ?` sang `WHERE product_id = ?`; mọi bước lỗi → compensating rollback; giữ thứ tự tạo order trước rồi batch các bước phụ thuộc
    - Tách logic điều kiện mua + cập nhật trạng thái thành hàm thuần / store in-memory mô phỏng để PBT atomicity và concurrency
    - _Requirements: 6.3, 6.4, 6.5, 9.1, 9.2, 9.3, 9.4, 9.7, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6_

  - [x] 6.2 Viết property test điều kiện mua và bất biến khi thất bại trong `test/transaction-purchase.property.test.ts`
    - **Property 13: Điều kiện mua và bất biến trạng thái khi thất bại**
    - **Validates: Requirements 6.3, 6.4, 6.5, 10.4, 10.6**

  - [x] 6.3 Viết property test all-or-nothing trong cùng file test
    - **Property 14: Giao dịch mua là all-or-nothing**
    - **Validates: Requirements 9.3, 9.7, 10.5**

  - [x] 6.4 Viết property test bất biến cấu trúc đơn hàng trong cùng file test
    - **Property 15: Bất biến cấu trúc đơn hàng sau khi mua**
    - **Validates: Requirements 9.1, 9.2, 9.4**

  - [x] 6.5 Viết property test không bán trùng dưới đồng thời trong cùng file test
    - **Property 16: Không bán trùng Product_Item dưới đồng thời**
    - **Validates: Requirements 9.5, 10.1, 10.2**

  - [x] 6.6 Viết property test số dư không bao giờ âm trong cùng file test
    - **Property 17: Số dư không bao giờ âm**
    - **Validates: Requirements 10.3**

- [x] 7. Checkpoint - giao dịch atomic
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. CMS API ba tầng, validate giá và bản dịch
  - [x] 8.1 Tách hàm thuần validate giá và validate trường dịch trong `src/services/catalog-validation.ts`
    - `validatePrice(value)` đúng khi và chỉ khi `Number.isInteger && 1..999999999`; `validateTranslationFields({name, description, content})` đúng khi `1<=len(name)<=200`, `len(description)<=2000`, `len(content)<=5000`; `isSupportedLang` cho lang dịch
    - _Requirements: 1.5, 1.6, 8.4, 8.5, 8.6, 8.9_

  - [x] 8.2 Viết property test validate giá all-or-nothing trong `test/catalog-validation.property.test.ts`
    - **Property 1: Validate giá là all-or-nothing**
    - **Validates: Requirements 1.5, 1.6, 8.6**

  - [x] 8.3 Viết property test validate độ dài trường dịch trong cùng file test
    - **Property 10: Validate độ dài trường dịch**
    - **Validates: Requirements 8.4, 8.5, 8.9**

  - [x] 8.4 Cập nhật `src/routes/admin/product-types.ts` cho tầng danh mục (chuyển giá + template RA KHỎI danh mục)
    - CRUD danh mục bỏ HẲN cột `price` và `success_template` khỏi tầng danh mục: hai khái niệm này nay thuộc tầng SẢN PHẨM (`products`). Gỡ mọi validate/đọc/ghi `price` trong product-types.ts; chặn xoá khi còn `products` con (trả lỗi `product_type_has_children`)
    - Sửa subquery đếm tồn kho đang dùng `GROUP BY type_id` / `WHERE type_id = ?`: tồn kho giờ đếm `product_items` theo `product_id` (qua tầng products), KHÔNG đếm trực tiếp theo danh mục; nếu cần tổng tồn theo danh mục thì JOIN `products` → `product_items`
    - Chuyển endpoint `/product-types/:id/templates` (success_template đa ngôn ngữ): bảng `product_type_templates` sau migration retarget FK sang `products.id` (giữ tên cột `product_type_id`), nên success_template là thuộc tính tầng SẢN PHẨM. Di chuyển endpoint quản lý template sang route products (`/products/:id/templates`) HOẶC giữ path cũ nhưng keyed theo `product_id`; thống nhất với task 11.3 và 8.5
    - _Requirements: 8.1, 8.7, 1.10, 6.6_

  - [x] 8.5 Viết lại `src/routes/admin/products.ts` cho tầng sản phẩm có giá
    - CRUD sản phẩm gắn `product_type_id`; gọi `validatePrice`, giá không hợp lệ → từ chối toàn bộ thao tác lưu, không lưu trường nào khác, giữ nguyên bản ghi (R1.6/R8.6); chặn tạo khi `product_type_id` không tồn tại; chặn xoá khi còn `product_items` con
    - `success_template` đa ngôn ngữ thuộc tầng sản phẩm: cung cấp đọc/ghi template keyed theo `product_id` (phối hợp với endpoint `/products/:id/templates` ở task 8.4 và service ở 11.3); KHÔNG còn lưu giá/template ở tầng danh mục
    - _Requirements: 1.6, 1.8, 1.10, 8.2, 8.6, 6.6_

  - [x] 8.6 Tạo `src/routes/admin/product-items.ts` cho tầng kho (tách từ products cũ) + import kho hàng loạt
    - Thêm/xoá kho gắn `product_id`; chặn tạo khi `product_id` không tồn tại; chỉ cho xoá item `available`; đăng ký route trong `src/routes/admin/index.ts`
    - IMPORT KHO HÀNG LOẠT: chuyển logic bulk import (nhiều dòng `content` cho một sản phẩm, chống trùng content trong cùng sản phẩm) từ chỗ cũ (gắn `type_id` trên bảng products cũ) sang đây, gắn `product_id`, ghi vào `product_items` với `status='available'`; tận dụng index `idx_product_items_content`
    - _Requirements: 1.9, 8.3_

  - [x] 8.7 Viết property test cha-con (tạo/xoá) trong `test/catalog-hierarchy.property.test.ts`
    - **Property 3: Tạo bản ghi con cần cha tồn tại**
    - **Property 4: Chặn xoá cha còn con**
    - **Validates: Requirements 1.8, 1.9, 1.10, 8.7**

  - [x] 8.8 Thêm endpoint bản dịch cho Product_Type và Product
    - `GET/PUT /product-types/:id/translations` và `/products/:id/translations` trong các route admin tương ứng; upsert `(entity, lang)`; validate lang ∈ SUPPORTED_LANGUAGES (từ chối lang ngoài registry), gọi `validateTranslationFields`; tạo mới trùng `(entity,lang)` → lỗi `translation_exists` giữ bản cũ
    - _Requirements: 3.4, 3.7, 3.8, 8.4, 8.5, 8.8, 8.9_

  - [x] 8.9 Viết property test tính duy nhất và từ chối lang trong `test/translation-store.property.test.ts`
    - **Property 7: Tính duy nhất của (thực thể, ngôn ngữ)**
    - **Property 9: Ghi bản dịch từ chối ngôn ngữ ngoài registry**
    - **Validates: Requirements 3.4, 3.7, 3.8, 8.8**

- [x] 9. Checkpoint - CMS API
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Mini App API và storefront theo danh mục, ngôn ngữ
  - [x] 10.1 Cập nhật `src/routes/miniapp-api.ts` cho mô hình ba tầng
    - `GET /api/app/categories` → product_types hiển thị; `GET /api/app/categories/:id/products` → products hiển thị thuộc danh mục kèm `stock`/`in_stock`, danh mục rỗng → mảng rỗng; DTO `name`/`description`/`content` resolve theo `resolveLang(user)` qua `resolveDisplayText`, `price` lấy từ tầng products; thêm trường thumbnail (image_data/emoji/type emoji) qua `pickThumbnail`
    - Cập nhật DTO trong `src/types/miniapp.ts` cho phù hợp
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.8_

  - [x] 10.2 Cập nhật storefront Mini App hiển thị danh mục + fallback ảnh
    - `miniapp/src/views/MarketView.vue` bộ lọc danh mục + trạng thái trống; `ProductCard.vue`/`ProductDetailView.vue` hiển thị thumbnail theo thứ tự image_data → emoji product → emoji type; emoji render lỗi (`onerror`/try-catch) thì bỏ qua, không vỡ UI; cập nhật `miniapp/src/types/index.ts` + `miniapp/src/api/client.ts`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.9_

  - [x] 10.3 Viết unit test DTO Mini App trong `test/miniapp-catalog.test.ts`
    - Kiểm giá lấy từ tầng Product, danh mục rỗng trả mảng rỗng, text resolve đúng ngôn ngữ
    - _Requirements: 7.3, 7.8_

- [x] 11. Bot duyệt 2 cấp và success_template đa ngôn ngữ
  - [x] 11.1 Cập nhật `src/bot/callbacks/purchase.ts` duyệt danh mục → sản phẩm
    - `handleCategoryList` liệt kê product_types `is_visible=1`, tên qua `resolveDisplayText`, rỗng → thông báo danh mục trống; `handleProductList(categoryId)` liệt kê products `is_visible=1` kèm giá + tồn kho động, không có sản phẩm → danh sách trống + thông báo tuỳ chọn; cập nhật router/callback data nếu cần
    - _Requirements: 6.1, 6.2, 6.7, 6.8_

  - [x] 11.2 Cập nhật flow mua và success_template trong `purchase.ts`
    - `handleQuantitySelect`/`handlePurchaseConfirm` gọi `executePurchase` với `productId`; số dư < giá → "số dư không đủ" không trừ tiền; hết `available` → "hết hàng"; thành công render success_template theo Display_Language, thiếu → Default_Language; escape HTML text động qua `escapeHtml`
    - _Requirements: 6.3, 6.4, 6.5, 6.6_

  - [x] 11.3 Cập nhật `src/services/product-template.ts` keyed theo product_id
    - `loadProductTypeTemplates` truy vấn theo `product_id` (cột `product_type_id` của bảng template sau migration giờ trỏ `products.id`); giữ tương thích `src/utils/telegram-template.ts`; success_template render trong bot (task 11.2) phải keyed theo product đã mua
    - Đồng bộ với endpoint quản lý template admin ở task 8.4/8.5 (`/products/:id/templates` hoặc path cũ keyed theo product): cùng một mô hình keyed theo `product_id` cho cả đọc (bot render) lẫn ghi (CMS quản lý)
    - _Requirements: 6.6_

  - [x] 11.4 Viết unit test handler bot trong `test/bot-purchase.test.ts`
    - Danh mục trống (R6.7), danh mục không có sản phẩm hiển thị (R6.8), render success_template thiếu lang dùng Default_Language (R6.6)
    - _Requirements: 6.6, 6.7, 6.8_

- [x] 12. Đồng bộ truy vấn backend còn lại sang mô hình ba tầng
  - [x] 12.1 Cập nhật `src/routes/admin/orders.ts` (list + detail đơn) theo mô hình mới
    - List/detail đơn hiện dùng `o.product_type_id`, `JOIN product_types pt`, `pt.price as unit_price`, chi tiết item `order_items oi JOIN products p ON oi.product_id = p.id`. Sửa sang: `orders.product_id` JOIN `products` (lấy tên/giá `unit_price` ở tầng products), chi tiết item `order_items.product_item_id` JOIN `product_items`
    - Cập nhật bộ lọc query param `filter[product_type_id]`/`product_type_id` cho khớp ngữ nghĩa mới (lọc theo product); đảm bảo đơn TẠO TRƯỚC migration vẫn tra cứu được đầy đủ thông tin sản phẩm + người mua (R9.6) nhờ id được bảo toàn
    - _Requirements: 9.1, 9.2, 9.6_

  - [x] 12.2 Viết unit test tra cứu đơn cũ trong `test/admin-orders-legacy.test.ts`
    - Seed đơn theo id bảo toàn sau migration; xác nhận list + detail trả đủ tên sản phẩm, đơn giá, content `product_items`, thông tin người mua mà không mất dữ liệu lịch sử
    - _Requirements: 9.6_

  - [x] 12.3 Cập nhật `src/routes/admin/stats.ts` (doanh thu + tồn kho) giữ Dashboard hoạt động
    - Sửa truy vấn đếm tồn: `LEFT JOIN products p ON p.type_id = pt.id` → đếm `product_items` theo `product_id` (qua tầng products); sửa doanh thu `JOIN product_types pt ON pt.id = o.product_type_id` → `JOIN products p ON p.id = o.product_id`, gộp doanh thu theo Product (và/hoặc theo danh mục Product_Type qua `products.product_type_id`)
    - ĐÂY là nguồn dữ liệu biểu đồ Dashboard CMS (Chart.js) nên phải giữ shape kết quả tương thích để biểu đồ không vỡ; nếu đổi shape thì cập nhật phía CMS tương ứng
    - _Requirements: 9.6_

  - [x] 12.4 Cập nhật `src/routes/admin/users.ts` (lịch sử đơn của user)
    - Lịch sử đơn dùng `LEFT JOIN product_types pt ON o.product_type_id = pt.id`; sửa sang `orders.product_id` JOIN `products` (tên danh mục/sản phẩm lấy ở tầng phù hợp), giữ tra cứu đơn cũ đầy đủ
    - _Requirements: 9.6_

  - [x] 12.5 Cập nhật `src/bot/callbacks/history.ts` (lịch sử + chi tiết item trong bot)
    - Lịch sử mua dùng `JOIN product_types pt ON pt.id = o.product_type_id` và chi tiết item `order_items oi JOIN products p ON p.id = oi.product_id`. Sửa sang `orders.product_id` JOIN `products`, `order_items.product_item_id` JOIN `product_items`
    - Tên sản phẩm/danh mục hiển thị qua `resolveDisplayText` theo Display_Language của user (R6.6); giữ tra cứu đơn cũ (R9.6)
    - _Requirements: 6.6, 9.6_

  - [x] 12.6 Cập nhật `src/bot/commands/admin.ts` (quản trị qua bot theo 3 tầng)
    - Hiện admin bot trộn 2 tầng: tạo/sửa danh mục KÈM `price` (`INSERT/UPDATE product_types ... price`), liệt kê danh mục + tồn kho qua `products WHERE type_id`, import tài khoản `INSERT INTO products (type_id, ...)`, thống kê theo `product_types`/`products.type_id`
    - Tách rõ 3 tầng: (a) danh mục `product_types` KHÔNG giá; (b) sản phẩm `products` có giá + success_template; (c) import kho vào `product_items` theo `product_id`. Cập nhật MỌI truy vấn `type_id`/`product_type_id`/`product_types.price` sang mô hình mới; tồn kho đếm `product_items` theo `product_id`; flow `adm:addprod`/import gắn `product_id`
    - Giữ `validatePrice`/`parsePrice` (đã có) nhưng áp ở tầng sản phẩm; không còn lưu giá ở tầng danh mục
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 6, 8.1, 8.2, 8.3_

- [x] 13. CMS UI editor ba tầng và bản dịch
  - [x] 13.1 Cập nhật views CMS cho ba tầng và editor bản dịch
    - `cms/src/views/CategoriesView.vue` quản lý danh mục (không giá); `cms/src/views/ProductsView.vue` quản lý sản phẩm gắn danh mục + giá + kho; thêm editor bản dịch theo từng `lang` (lấy danh sách lang từ API/registry), gọi endpoint translations; hiển thị lỗi giá/độ dài/lang; dùng `Icon.vue`, KHÔNG dùng emoji do agent thêm; cập nhật `cms/src/api/client.ts` và chuỗi i18n trong `cms/src/i18n/messages/`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9_

- [x] 14. Tích hợp, migration local và verify
  - [x] 14.1 Áp migration 0015 lên D1 local và đối soát
    - Seed dữ liệu mẫu (category null/rỗng, không có category null/rỗng, category hợp lệ trùng tên hiển thị default, sản phẩm có/không kho, đơn cũ); chạy `npm run db:migrate:local` bằng background process; đối soát số product_items == số products cũ, số orders không đổi, product_type_templates không đổi, join được orders.product_id/order_items.product_item_id, `PRAGMA foreign_key_list(product_items)` xác nhận `product_id` tham chiếu `products(id)`, không tạo default giả khi không cần và không gộp nhầm category trùng tên default; kiểm hiển thị Base_Value khác rỗng khi chưa có bản dịch
    - _Requirements: 2.8, 2.9, 2.10, 2.11, 11.1, 11.2, 11.4_

  - [x] 14.2 Viết integration test migration + rollback trong `test/migration-0015.integration.test.ts`
    - Migration trên D1 local đối chiếu cùng bất biến của Property 5/6; seed sai lệch nhân tạo và xác nhận migration không đánh dấu applied (rollback đếm sai)
    - _Requirements: 2.9, 2.10, 11.6_

  - [x] 14.3 Wire toàn bộ và verify build/type/test toàn repo
    - Đảm bảo catalog-service/i18n-catalog/transaction/CMS API/Mini App/Bot + các route admin orders/stats/users + bot history/admin nối với nhau, không code mồ côi; chạy `npm test` (vitest + fast-check) và `npm run build:cms` (gồm vue-tsc/tsc) bằng background process, đọc log dần
    - PHẢI build/tsc TOÀN REPO (cả backend Worker) để bắt mọi tham chiếu cột/bảng cũ còn sót (`product_type_id`, `type_id`, `pt.price`, `order_items.product_id`, `JOIN product_types`...) sau khi đổi cột — không để lỗi kiểu runtime/tsc lọt (R5.4); sửa lỗi kiểu/lỗi build phát sinh
    - _Requirements: 5.4, 11.2, 11.3_

  - [x] 14.4 (Tuỳ chọn) Cập nhật phần schema trong `README.md` cho khớp mô hình ba tầng
    - Cập nhật mô tả schema/ERD trong README sang mô hình danh mục `product_types` (không giá) / sản phẩm `products` (có giá) / kho `product_items`, đổi nghĩa cột `orders.product_id` và `order_items.product_item_id`; chỉ chỉnh phần schema cho chính xác, không thêm emoji
    - _Requirements: 5.4_

## Notes

- Task gắn `*` là tùy chọn (test hoặc cập nhật README) và có thể bỏ qua khi cần MVP nhanh; task không gắn `*` là bắt buộc hiện thực.
- Mỗi task tham chiếu requirement cụ thể để truy vết; task viết test tham chiếu rõ số Property trong design.
- Checkpoint đảm bảo kiểm chứng tăng dần ở các mốc an toàn.
- Property test (vitest + fast-check) chạy tối thiểu 100 vòng, gắn tag `Feature: product-catalog-i18n-upgrade, Property {số}`.
- Tuân thủ AGENTS.md: migration chỉ thêm file mới `0015_*`, cập nhật `src/types/db.ts` ngay sau khi đổi cột, giữ atomic giao dịch, không tự thêm emoji, lệnh chạy lâu dùng background process.
- Task 12 đồng bộ các truy vấn backend còn lại (orders/stats/users + bot history/admin) sang mô hình ba tầng để sau migration không vỡ runtime/tsc và không hỏng tra cứu đơn cũ (R9.6) lẫn biểu đồ Dashboard; task 14.3 build/tsc toàn repo để bắt mọi tham chiếu cột/bảng cũ còn sót.
- KHÔNG bao gồm task deploy production hay `db:migrate:remote` — việc deploy do người dùng quyết định riêng.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1", "3.1", "8.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "3.2", "3.3", "8.2", "8.3"] },
    { "id": 4, "tasks": ["4.1"] },
    { "id": 5, "tasks": ["4.2", "4.3", "6.1"] },
    { "id": 6, "tasks": ["6.2", "6.3", "6.4", "6.5", "6.6"] },
    { "id": 7, "tasks": ["8.4", "8.5", "8.6", "8.8", "11.3"] },
    { "id": 8, "tasks": ["8.7", "8.9", "10.1", "11.1"] },
    { "id": 9, "tasks": ["10.2", "10.3", "11.2", "12.1", "12.3", "12.4", "12.5", "12.6"] },
    { "id": 10, "tasks": ["11.4", "12.2", "13.1", "14.1"] },
    { "id": 11, "tasks": ["14.2"] },
    { "id": 12, "tasks": ["14.3"] },
    { "id": 13, "tasks": ["14.4"] }
  ]
}
```
