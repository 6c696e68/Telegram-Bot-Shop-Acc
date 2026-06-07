<script setup lang="ts">
/**
 * QtyStepper — bộ tăng/giảm số lượng (Req 6.1).
 *  - v-model:quantity (number) — luôn là số nguyên, được kẹp trong [min, max].
 *  - nút +/- đạt target chạm ≥ 44px (`.tap-target`); màu phẳng, không chuyển-màu-nền.
 *  - tự disable nút khi chạm biên min/max.
 */
import { computed } from 'vue'
import { Minus, Plus } from '@lucide/vue'
import { haptic } from '@/telegram/sdk'

const props = withDefaults(
  defineProps<{
    /** Giá trị nhỏ nhất cho phép. */
    min?: number
    /** Giá trị lớn nhất cho phép. */
    max?: number
  }>(),
  { min: 1, max: 99 }
)

/** v-model:quantity — số lượng hiện tại (number). */
const quantity = defineModel<number>('quantity', { required: true })

/** Ép về số nguyên và kẹp trong [min, max]. */
function clamp(value: number): number {
  const int = Math.trunc(Number.isFinite(value) ? value : props.min)
  return Math.min(props.max, Math.max(props.min, int))
}

const canDecrement = computed(() => clamp(quantity.value) > props.min)
const canIncrement = computed(() => clamp(quantity.value) < props.max)

function decrement(): void {
  if (!canDecrement.value) return
  haptic('light')
  quantity.value = clamp(quantity.value - 1)
}

function increment(): void {
  if (!canIncrement.value) return
  haptic('light')
  quantity.value = clamp(quantity.value + 1)
}
</script>

<template>
  <div class="inline-flex items-center gap-1 rounded-ios bg-surface p-1 shadow-ios">
    <button
      type="button"
      class="tap-target flex items-center justify-center rounded-ios text-accent transition-transform duration-ios ease-ios active:scale-90 disabled:opacity-30"
      :disabled="!canDecrement"
      aria-label="Giảm số lượng"
      @click="decrement"
    >
      <Minus :size="20" :stroke-width="2.25" aria-hidden="true" />
    </button>
    <span class="min-w-[2.5rem] text-center text-ios-headline tabular-nums text-text">
      {{ clamp(quantity) }}
    </span>
    <button
      type="button"
      class="tap-target flex items-center justify-center rounded-ios text-accent transition-transform duration-ios ease-ios active:scale-90 disabled:opacity-30"
      :disabled="!canIncrement"
      aria-label="Tăng số lượng"
      @click="increment"
    >
      <Plus :size="20" :stroke-width="2.25" aria-hidden="true" />
    </button>
  </div>
</template>
