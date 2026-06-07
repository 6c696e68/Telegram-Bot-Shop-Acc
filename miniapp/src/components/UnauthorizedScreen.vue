<script setup lang="ts">
/**
 * UnauthorizedScreen — màn "Mở lại từ Telegram" khi xác thực initData thất bại (Req 1.7).
 *  - Phủ TRÊN nội dung khi `ui.unauthorized = true` (API client bật khi HTTP 401).
 *  - "Tải lại" reset cờ + reload để lấy initData mới. Obsidian Glass, dark-only.
 */
import GlassButton from '@/components/GlassButton.vue'
import { Lock } from '@lucide/vue'
import { useUiStore } from '@/stores/ui'
import { useI18n } from 'vue-i18n'

const ui = useUiStore()
const { t } = useI18n()

function reload(): void {
  ui.setUnauthorized(false)
  if (typeof location !== 'undefined') location.reload()
}
</script>

<template>
  <Transition name="auth">
    <div
      v-if="ui.unauthorized.value"
      class="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-5 bg-background px-8 text-center"
      :style="{ paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }"
      role="alertdialog"
      aria-modal="true"
      :aria-label="t('unauthorized.aria')"
    >
      <span
        class="flex h-20 w-20 items-center justify-center rounded-full bg-surface-container text-on-surface-variant"
        aria-hidden="true"
      >
        <Lock :size="40" :stroke-width="1.5" />
      </span>
      <h1 class="text-[22px] font-semibold text-on-surface">{{ t('unauthorized.title') }}</h1>
      <p class="max-w-sm text-[15px] text-on-surface-variant">{{ t('unauthorized.desc') }}</p>
      <GlassButton variant="primary" @click="reload">{{ t('unauthorized.reload') }}</GlassButton>
    </div>
  </Transition>
</template>

<style scoped>
.auth-enter-active,
.auth-leave-active {
  transition: opacity var(--duration-ios) var(--ease-ios);
}
.auth-enter-from,
.auth-leave-to {
  opacity: 0;
}
</style>
