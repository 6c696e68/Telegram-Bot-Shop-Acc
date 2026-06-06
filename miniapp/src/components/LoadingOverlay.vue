<script setup lang="ts">
/**
 * LoadingOverlay — lớp phủ loading toàn cục, hiển thị khi `ui.loading` (Req 13 — phản hồi UI).
 *
 * Mount một lần ở App.vue. Khi có ≥ 1 tác vụ async đang chạy (counter trong ui store),
 * phủ mờ nhẹ + spinner kính ở giữa. Không chặn vĩnh viễn vì `withLoading` luôn tắt khi xong.
 * Màu phẳng, không gradient (Req 13.3).
 */
import { useUiStore } from '@/stores/ui'
import { useI18n } from 'vue-i18n'

const ui = useUiStore()
const { t } = useI18n()
</script>

<template>
  <Transition name="overlay">
    <div
      v-if="ui.loading.value"
      class="fixed inset-0 z-40 flex items-center justify-center"
      :style="{ backgroundColor: 'rgba(0, 0, 0, 0.25)' }"
      role="status"
      aria-live="polite"
      :aria-label="t('a11y.loading')"
    >
      <div class="glass flex h-14 w-14 items-center justify-center">
        <span
          class="h-7 w-7 animate-spin rounded-full border-2 border-accent border-t-transparent"
          aria-hidden="true"
        />
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.overlay-enter-active,
.overlay-leave-active {
  transition: opacity var(--duration-ios) var(--ease-ios);
}
.overlay-enter-from,
.overlay-leave-to {
  opacity: 0;
}
</style>
