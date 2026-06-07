<script setup lang="ts">
/**
 * CircleAction — nút hành động tròn kiểu CryptoBot (Nạp tiền / Mua hàng / Lịch sử).
 *  - avatar tròn nền accent-soft + icon accent, nhãn caption bên dưới.
 *  - target chạm ≥ 44px; haptic('light') khi bấm. Màu phẳng, không gradient, không emoji.
 */
import type { Component } from 'vue'
import { haptic } from '@/telegram/sdk'

defineProps<{
  /** Icon SVG (lucide). */
  icon: Component
  /** Nhãn hiển thị dưới nút. */
  label: string
}>()

const emit = defineEmits<{ (e: 'click'): void }>()

function onClick(): void {
  haptic('light')
  emit('click')
}
</script>

<template>
  <button
    type="button"
    class="flex flex-col items-center gap-2 transition-transform duration-ios ease-ios active:scale-95"
    :aria-label="label"
    @click="onClick"
  >
    <span class="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent">
      <component :is="icon" :size="24" :stroke-width="2" aria-hidden="true" />
    </span>
    <span class="text-ios-caption text-text">{{ label }}</span>
  </button>
</template>
