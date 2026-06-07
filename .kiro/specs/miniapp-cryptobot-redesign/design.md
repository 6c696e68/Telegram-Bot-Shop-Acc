# Design — Thiết kế lại Mini App theo phong cách CryptoBot (shop bán tài khoản)

## Overview

Code lại **toàn bộ giao diện** Mini App (`miniapp/`) để đạt chất lượng thị giác như
CryptoBot Mini App, nhưng **biến thể cho mô hình shop bán tài khoản số** thay vì ví crypto.

Mục tiêu:
- Giữ nguyên: API (`/api/app/*`), DTO trong `@/types`, store (`user`, `ui`), router cơ
  bản, i18n (vi/en), Telegram SDK (MainButton/BackButton/haptic/theme/safe-area), ràng
  buộc "không gradient nền — chỉ màu phẳng + kính" và "không emoji do agent thêm" (emoji
  sản phẩm là dữ liệu admin nên vẫn hiển thị).
- Thay mới: hệ thống layout, điều hướng (thêm **bottom tab bar**), bộ component thị giác,
  bố cục từng màn hình.

Không đổi backend, không đổi logic nghiệp vụ. Đây là refactor tầng trình bày.

### Nguồn tham khảo (CryptoBot)

Phân tích từ `video/ScreenRecording_06-07-2026 16-47-20_1.MP4` (36 frame trích bằng ffmpeg,
OCR bằng Apple Vision). Đặc trưng thị giác chính:

| Thành phần CryptoBot | Mô tả | Ánh xạ sang shop |
|---|---|---|
| Header gọn | Tên app + Close/Back | Tiêu đề mỗi tab + Telegram Back |
| Balance hero | Số dư cực lớn căn giữa + nhãn phụ | Số dư VND/USD |
| Hàng nút tròn | Deposit / Withdraw / History | Nạp tiền / Mua hàng / Lịch sử |
| Banner promo | Card bo góc lớn, nền accent nhạt | Banner hướng dẫn nạp/mua |
| Section list | "My Assets >" + danh sách row icon tròn | "Sản phẩm" + danh sách loại tài khoản |
| Row item | icon tròn \| tên + phụ đề \| giá trị phải | tên loại + giá \| tồn kho |
| Bottom tab bar | 4 tab icon + nhãn | Trang chủ / Cửa hàng / Lịch sử / Tài khoản |
| Settings list | row "nhãn — giá trị + chevron" | Vùng / Ngôn ngữ |

### Ánh xạ tính năng shop ↔ CryptoBot

- "Assets list" (coin) → **Danh sách loại sản phẩm** (`product-types`): avatar tròn chứa
  emoji, tên, phụ đề (giá), bên phải tồn kho/`Hết hàng`.
- "Total balance" → **Số dư người mua** (`balance_display`), hero đầu Trang chủ.
- "Deposit / Withdraw / History" → **Nạp tiền / Mua hàng / Lịch sử** (shop không rút tiền
  nên thay "Withdraw" bằng "Mua hàng").
- "Swap / Trade / More" tabs → rút gọn còn 4 tab phù hợp shop.

## Architecture

### Điều hướng — thêm Bottom Tab Bar

Hiện điều hướng bằng grid lối tắt + Telegram BackButton. Thêm **thanh tab dưới** cố định
cho màn cấp 1; màn cấp 2 (chi tiết) ẩn tab bar và dùng Back.

- Tabs (4): **Trang chủ** (`home`), **Cửa hàng** (`shop`), **Lịch sử** (`history`),
  **Tài khoản** (`account`).
- Hiển thị tab bar ở `home/shop/history/account`. Ẩn ở `onboarding/product-detail/
  deposit/order-detail/settings`.
- Cơ chế: thêm `meta: { tab: true }` trên route cấp 1; `App.vue` đọc `route.meta.tab` để
  render `TabBar.vue` và áp `padding-bottom` động (chiều cao tab bar + `--safe-bottom`).

### Tầng layout & nền

- Chuyển từ "kính mờ ở mọi nơi" sang mô hình **card trên nền** như CryptoBot:
  `--tg-bg` cho app, `--surface` (= `--tg-secondary-bg`) cho thẻ nhóm, `--separator` cho
  đường kẻ giữa row. Giữ `.glass` cho overlay thật sự (toast/loading/unauthorized).
- Tuân thủ Req 13.2/13.3: KHÔNG gradient — `accent-soft` chỉ là accent + alpha (màu phẳng).

### Design tokens

Tận dụng `tailwind.config.js` + biến CSS từ Telegram themeParams. Bổ sung trong `style.css`:
- `--surface: var(--tg-theme-section-bg-color, var(--tg-secondary-bg))`
- `--surface-elevated` cho row bên trong thẻ.
- `--separator: var(--tg-theme-section-separator-color, rgba(120,120,128,0.20))`
- `--accent-soft`: accent alpha ~12% (rgba fallback theo light/dark) cho avatar tròn/banner.

Bo góc: section `rounded-glass` (20px); row/nút `rounded-ios` (14px); avatar `rounded-full`
(40–44px). Typography giữ thang iOS; balance hero dùng `text-ios-large-title` (34px) hoặc
lớn hơn (40–44px qua util tuỳ biến). Padding ngang `px-4`, khoảng cách section `gap-6`.

## Components and Interfaces

### Component mới

1. **TabBar.vue** — props: none (đọc route). Cố định đáy, nền `--tg-bg` + separator trên,
   tôn trọng `--safe-bottom`. Tab active `--tg-accent`, inactive `--tg-hint`; icon
   (`@lucide/vue`) + nhãn `text-ios-caption`. `haptic('light')` khi đổi tab.
2. **BalanceHero.vue** — props: `balance:number`, `display?:string`, `label?:string`.
   Số dư lớn căn giữa + nhãn phụ. Slot mặc định cho hàng nút tròn bên dưới.
3. **CircleAction.vue** — props: `icon:Component`, `label:string`; emit `click`. Avatar
   tròn nền `accent-soft`, icon accent, nhãn dưới. Tap target ≥ 44px + haptic.
4. **ListSection.vue** — props: `title?:string`, `as?:string`. Thẻ nhóm `rounded-glass`
   nền `--surface`, tự chèn separator giữa các `ListRow`. Slot `header-action` (vd "Xem
   tất cả >"), slot mặc định cho row.
5. **ListRow.vue** — slots: `leading`, `title`, `subtitle`, `trailing`; props:
   `clickable?:boolean`, `disabled?:boolean`; emit `click` (+ haptic). Hàng chuẩn cho
   sản phẩm/lịch sử/settings/account.
6. **PromoBanner.vue** — props: `icon:Component`, `title:string`, `subtitle?:string`;
   emit `click`. Nền `accent-soft`, bo `rounded-glass`.
7. **SegmentedControl.vue** — props: `modelValue:string`,
   `options:{value:string,label:string}[]`; emit `update:modelValue`. Control phân đoạn
   iOS cho chọn phương thức nạp.

### Component nâng cấp (giữ props/slot, đổi giao diện)

- **ProductCard.vue** → dựng trên `ListRow`: avatar tròn (emoji) trái, tên + giá (accent)
  phụ đề, tồn kho/`Hết hàng` phải, chevron. Giữ props hiện có (`name/emoji/price/
  priceDisplay/stock/inStock`) + emit `click`; vẫn chặn click khi hết hàng.
- **GlassButton.vue** → giữ tên/props; primary = nền accent đầy đặn `rounded-ios`,
  secondary = surface.
- **GlassCard.vue** → mặc định surface (`--surface`) bo `rounded-glass`; giữ props
  (`padded`, `as`) + slot. `.glass` vẫn dùng cho overlay.
- **QrPanel / QtyStepper / EmptyState / BalanceBadge / ToastHost / LoadingOverlay /
  UnauthorizedScreen** → tinh chỉnh bo góc/surface/spacing, giữ hành vi.

### Bố cục từng màn hình

- **HomeView ("Ví")**: lời chào → `BalanceHero` → hàng `CircleAction` (Nạp tiền/Mua
  hàng/Lịch sử) → `PromoBanner` (hướng dẫn) → `ListSection "Sản phẩm nổi bật >"` (vài loại
  đầu từ `product-types`, "Xem tất cả" → tab Cửa hàng).
- **ShopView**: tiêu đề; (tuỳ chọn) ô lọc theo tên client-side; `ListSection` toàn bộ loại
  (gồm hết hàng, disable + nhãn đỏ); trống → `EmptyState`.
- **ProductDetailView**: header avatar tròn lớn + tên + giá; card mô tả + tồn kho;
  `QtyStepper` + dòng Tổng tiền; mua qua Telegram MainButton; sau mua: card thành công +
  `contents` (select-all) + số dư mới.
- **DepositView**: `SegmentedControl` chọn phương thức (khi >1); SePay lưới mệnh giá + ô
  nhập "đ"; CryptoBot ô nhập USDT + quy đổi VND; nút "Tạo yêu cầu"; sau tạo: card trạng
  thái + QrPanel/nút pay_url + Huỷ/Quay lại (giữ polling).
- **HistoryView**: `ListSection` các đơn (avatar emoji + tên + (số lượng · thời gian) +
  tổng tiền accent + chevron, nhãn trạng thái); trống → `EmptyState`.
- **OrderDetailView**: header (emoji + tên + tổng tiền); card thông tin row nhãn–giá trị;
  `contents` select-all; Back.
- **AccountView ("More")**: `BalanceHero` thu gọn; `ListSection "Thông tin"` (ID/Username/
  Tên); `ListSection "Cài đặt"` (Vùng/Ngôn ngữ → settings, có chevron). KHÔNG có admin.
- **SettingsView**: `ListSection` kiểu CryptoBot — row Vùng + row Ngôn ngữ, mỗi lựa chọn
  có dấu check khi active; lưu qua store.
- **OnboardingView**: chọn vùng căn giữa (tiêu đề + phụ đề + 2 nút lớn), giữ logic.

### i18n

Thêm key cho: nhãn tab bar, nút tròn hành động, tiêu đề banner/promo, "Xem tất cả", "Sản
phẩm nổi bật", nhãn segmented... vào `messages/vi.json` + `messages/en.json`. Không
hard-code chuỗi trong template.

## Data Models

Không thêm/đổi DTO. Giao diện tiêu thụ các kiểu sẵn có trong `@/types`:
- `MeDto` (số dư + định danh + region/rate) cho BalanceHero/Account.
- `ProductTypeListItemDto`, `ProductTypeDetailDto` cho Shop/Home/Detail.
- `DepositMethodDto`, `DepositCreatedDto`, `CryptoDepositCreatedDto`, `DepositStatusDto`
  cho Deposit.
- `OrderListItemDto`, `OrderDetailDto` cho History/OrderDetail.
- `PurchaseResultDto` cho màn kết quả mua.

Trạng thái UI mới (không persist, theo Req 1.7): visibility tab bar suy ra từ
`route.meta.tab`. Trang chủ có thể cache nhẹ danh sách `product-types` trong store để
tránh gọi lại khi vào tab Cửa hàng (tuỳ chọn).

## Error Handling

Giữ nguyên mô hình hiện tại:
- API client ném `ApiError`; 401 bật cờ `unauthorized` → `UnauthorizedScreen`.
- Lỗi nghiệp vụ (409/400/404/429) → `ui.toast(...)` + `haptic('error')`; giữ trạng thái để
  thử lại. Các thông báo qua i18n.
- Danh sách rỗng → `EmptyState`. Tải lỗi (khác 401) → toast.
- Component thị giác mới không phát sinh luồng lỗi mới; chỉ trình bày dữ liệu.

## Testing Strategy

- `vue-tsc` (type-check) cho `miniapp` phải sạch sau refactor (giữ props/slot để không vỡ
  import).
- Build `miniapp` (vite) thành công.
- Kiểm thử thủ công bằng Playwright ở chế độ trình duyệt (ngoài Telegram, SDK no-op):
  - Điều hướng tab bar giữa 4 màn cấp 1; ẩn tab ở màn cấp 2.
  - Sáng/tối (toggle class `dark`) + safe-area (giả lập insets).
  - Luồng: xem sản phẩm → chi tiết → (mock) mua; nạp tiền (SePay form + segmented);
    lịch sử → chi tiết.
- Tôn trọng `prefers-reduced-motion`; tap target ≥ 44px; đổi ngôn ngữ không reload.

## Correctness Properties

### Property 1: i18n triệt để
Mọi chuỗi hiển thị đi qua i18n (không hard-code), reactive theo đổi ngôn ngữ không reload.

**Validates: Requirements 17.4, 17.5** (telegram-mini-app)

### Property 2: Không gradient
Không component nào dùng gradient nền; chỉ màu phẳng + alpha + kính cho overlay.

**Validates: Requirements 13.2, 13.3** (telegram-mini-app)

### Property 3: Không emoji do agent thêm
Không chèn emoji vào code/chuỗi/nhãn; chỉ emoji là dữ liệu sản phẩm (`product_types.emoji`).

**Validates: Requirements 13.1** (telegram-mini-app + AGENTS.md quy tắc 8)

### Property 4: Tab bar an toàn
Tab bar không che nội dung cuối trang (padding-bottom động) và tôn trọng `--safe-bottom`;
chỉ hiện ở màn cấp 1.

**Validates: Requirements 13.7** (telegram-mini-app)

### Property 5: Giữ hợp đồng component
Component nâng cấp giữ nguyên props/slot/emit với code gọi hiện tại để không vỡ import.

**Validates: Requirements 13.1** (telegram-mini-app)
