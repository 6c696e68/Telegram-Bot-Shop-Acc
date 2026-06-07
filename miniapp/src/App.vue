<script setup lang="ts">
// Layout gốc Mini App: tôn trọng safe-area + RouterView + thanh tab dưới (CryptoBot-style).
// Theme/màu/surface do design-system CSS (style.css) cung cấp qua biến CSS.
//
// TabBar chỉ hiện ở các route cấp 1 (`meta.tab = true`): Trang chủ / Cửa hàng / Lịch sử /
// Tài khoản. Màn cấp 2 (chi tiết, nạp tiền, cài đặt, onboarding) ẩn tab và dùng Telegram Back.
//
// Mount các lớp phản hồi UI toàn cục (đọc trạng thái từ @/stores/ui):
//  - ToastHost / LoadingOverlay / UnauthorizedScreen.
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import TabBar from '@/components/TabBar.vue'
import ToastHost from '@/components/ToastHost.vue'
import LoadingOverlay from '@/components/LoadingOverlay.vue'
import UnauthorizedScreen from '@/components/UnauthorizedScreen.vue'

const route = useRoute()

/** Hiện thanh tab dưới khi route hiện tại đánh dấu `meta.tab`. */
const showTab = computed(() => route.meta.tab === true)
</script>

<template>
  <div class="app-shell">
    <!-- Nội dung; chừa đệm đáy bằng `.pb-tabbar` khi có thanh tab để không bị che. -->
    <div :class="showTab ? 'pb-tabbar' : ''">
      <RouterView />
    </div>

    <!-- Thanh điều hướng dưới (chỉ ở route cấp 1). -->
    <TabBar v-if="showTab" />

    <!-- Lớp phản hồi UI toàn cục (overlay; không ảnh hưởng bố cục nội dung) -->
    <LoadingOverlay />
    <ToastHost />
    <UnauthorizedScreen />
  </div>
</template>

<style>
.app-shell {
  /* dvh để khớp viewport WebView Telegram (kể cả khi thanh công cụ ẩn/hiện) */
  min-height: 100vh;
  min-height: 100dvh;
  /* Safe-area insets (yêu cầu viewport-fit=cover ở index.html) */
  padding-top: env(safe-area-inset-top);
  padding-right: env(safe-area-inset-right);
  padding-left: env(safe-area-inset-left);
  box-sizing: border-box;
}
</style>
