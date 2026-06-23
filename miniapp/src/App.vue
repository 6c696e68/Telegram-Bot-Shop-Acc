<script setup lang="ts">
// Layout gốc Mini App "Obsidian Glass": RouterView + BottomNav (chỉ ở route cấp 1) + overlay.
//
// BottomNav hiện ở các route có `meta.tab = true`: Market / Orders / Support / Profile.
// Màn cấp 2 (chi tiết, checkout, nạp tiền, onboarding) ẩn nav và dùng Telegram BackButton /
// TopAppBar back. Mount các lớp phản hồi UI toàn cục (ToastHost / LoadingOverlay /
// UnauthorizedScreen) đọc trạng thái từ @/stores/ui.
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import BottomNav from '@/components/BottomNav.vue'
import ToastHost from '@/components/ToastHost.vue'
import LoadingOverlay from '@/components/LoadingOverlay.vue'
import UnauthorizedScreen from '@/components/UnauthorizedScreen.vue'

const route = useRoute()

/** Hiện thanh tab dưới khi route hiện tại đánh dấu `meta.tab`. */
const showTab = computed(() => route.meta.tab === true)
</script>

<template>
  <div class="app-shell bg-background text-on-background">
    <!-- Nội dung; chừa đệm đáy bằng `.pb-tabbar` khi có thanh tab để không bị che. -->
    <div :class="showTab ? 'pb-tabbar' : ''">
      <RouterView />
    </div>

    <BottomNav v-if="showTab" />

    <LoadingOverlay />
    <ToastHost />
    <UnauthorizedScreen />
  </div>
</template>

<style>
.app-shell {
  min-height: 100vh;
  min-height: 100dvh;
  box-sizing: border-box;
}

/* Đệm đáy để nội dung không bị thanh nav nổi che (nav cao 56px + cách mép 12px + safe). */
.pb-tabbar {
  padding-bottom: calc(56px + 12px + 12px + var(--safe-bottom));
}
</style>
