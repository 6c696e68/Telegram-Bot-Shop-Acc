<script setup lang="ts">
/**
 * LoadingOverlay — lớp phủ loading toàn cục khi `ui.loading` (Obsidian Glass).
 *  - Phủ mờ + spinner kính ở giữa. `withLoading` luôn tắt khi xong nên không kẹt.
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
      class="fixed inset-0 z-[55] flex items-center justify-center"
      style="background-color: rgba(0, 0, 0, 0.45)"
      role="status"
      aria-live="polite"
      :aria-label="t('a11y.loading')"
    >
      <div class="glass-panel flex h-16 w-16 items-center justify-center rounded-2xl">
        <span
          class="h-7 w-7 animate-spin rounded-full border-2 border-primary border-t-transparent"
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
