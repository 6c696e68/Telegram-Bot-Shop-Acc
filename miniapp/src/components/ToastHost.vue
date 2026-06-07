<script setup lang="ts">
/**
 * ToastHost — render hàng đợi toast toàn cục từ `ui` store (Obsidian Glass).
 *  - Pill kính (`.glass-panel`) màu theo loại; bấm để ẩn ngay. Icon SVG (lucide), không emoji.
 *  - Hiển thị phía trên, tôn trọng safe-area-top.
 */
import { CircleCheck, TriangleAlert, Info } from '@lucide/vue'
import type { Component } from 'vue'
import { useUiStore, type ToastType } from '@/stores/ui'

const ui = useUiStore()

function toneClass(type: ToastType): string {
  switch (type) {
    case 'success':
      return 'text-tertiary'
    case 'error':
      return 'text-error'
    default:
      return 'text-on-surface'
  }
}

function iconFor(type: ToastType): Component {
  switch (type) {
    case 'success':
      return CircleCheck
    case 'error':
      return TriangleAlert
    default:
      return Info
  }
}
</script>

<template>
  <div
    class="pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 px-4"
    :style="{ paddingTop: 'calc(var(--safe-top) + 0.75rem)' }"
    aria-live="polite"
    aria-atomic="true"
  >
    <TransitionGroup name="toast">
      <button
        v-for="t in ui.toasts.value"
        :key="t.id"
        type="button"
        class="glass-panel pointer-events-auto flex max-w-md items-center gap-2 rounded-full px-4 py-2.5 text-left text-[14px] shadow-lg"
        @click="ui.dismissToast(t.id)"
      >
        <component
          :is="iconFor(t.type)"
          :size="18"
          :stroke-width="2"
          class="shrink-0"
          :class="toneClass(t.type)"
          aria-hidden="true"
        />
        <span :class="toneClass(t.type)">{{ t.message }}</span>
      </button>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity var(--duration-ios) var(--ease-ios),
    transform var(--duration-ios) var(--ease-ios);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
</style>
