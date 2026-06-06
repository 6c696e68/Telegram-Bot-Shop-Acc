<script setup lang="ts">
/**
 * UnauthorizedScreen — màn "Mở lại từ Telegram" khi xác thực initData thất bại (Req 1.7).
 *
 * Mount một lần ở App.vue, phủ TRÊN nội dung khi `ui.unauthorized = true` (API client bật
 * cờ này khi gặp HTTP 401: thiếu/sai initData hoặc hết TTL). Vì Mini App stateless (không
 * lưu token), cách khôi phục đúng là mở lại app từ trong Telegram để nhận initData mới.
 *
 * Hành động:
 *  - "Tải lại": reset cờ + `location.reload()` để lấy lại `window.Telegram.WebApp.initData`
 *    mới (đủ để khôi phục nếu chỉ hết TTL trong phiên còn mở).
 *
 * Màu phẳng + lớp kính, không gradient (Req 13.3).
 */
import GlassButton from '@/components/GlassButton.vue'
import { Lock } from '@lucide/vue'
import { useUiStore } from '@/stores/ui'
import { useI18n } from 'vue-i18n'

const ui = useUiStore()
const { t } = useI18n()

/** Tải lại app để lấy initData mới; gỡ cờ trước khi reload phòng trường hợp reload bị chặn. */
function reload(): void {
  ui.setUnauthorized(false)
  if (typeof location !== 'undefined') location.reload()
}
</script>

<template>
  <Transition name="auth">
    <div
      v-if="ui.unauthorized.value"
      class="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-5 bg-bg px-8 text-center"
      :style="{
        paddingTop: 'var(--safe-top)',
        paddingBottom: 'var(--safe-bottom)',
      }"
      role="alertdialog"
      aria-modal="true"
      :aria-label="t('unauthorized.aria')"
    >
      <Lock :size="56" :stroke-width="1.5" class="text-hint" aria-hidden="true" />
      <h1 class="text-ios-title text-text">{{ t('unauthorized.title') }}</h1>
      <p class="max-w-sm text-ios-body text-hint">
        {{ t('unauthorized.desc') }}
      </p>
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
