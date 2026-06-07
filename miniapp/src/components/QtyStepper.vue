<script setup lang="ts">
/**
 * QtyStepper — bộ tăng/giảm số lượng (Obsidian Glass, Req 6.1).
 *  - v-model:quantity (number) — luôn nguyên, kẹp trong [min, max].
 *  - Pill nền surface-container-high; nút +/- target chạm >= 44px; disable khi chạm biên.
 */
import { computed } from 'vue'
import { Minus, Plus } from '@lucide/vue'
import { haptic } from '@/telegram/sdk'

const props = withDefaults(
  defineProps<{ min?: number; max?: number }>(),
  { min: 1, max: 99 }
)

const quantity = defineModel<number>('quantity', { required: true })

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
  <div
    class="flex items-center rounded-full border border-surface-variant bg-surface-container-high p-1"
  >
    <button
      type="button"
      class="flex h-10 w-10 items-center justify-center rounded-full text-on-surface transition-transform active:scale-90 disabled:opacity-30"
      :disabled="!canDecrement"
      :aria-label="$t('product.qty_decrease')"
      @click="decrement"
    >
      <Minus :size="20" :stroke-width="2.25" aria-hidden="true" />
    </button>
    <span class="w-8 text-center text-[16px] font-semibold tabular-nums text-on-surface">
      {{ clamp(quantity) }}
    </span>
    <button
      type="button"
      class="flex h-10 w-10 items-center justify-center rounded-full text-on-surface transition-transform active:scale-90 disabled:opacity-30"
      :disabled="!canIncrement"
      :aria-label="$t('product.qty_increase')"
      @click="increment"
    >
      <Plus :size="20" :stroke-width="2.25" aria-hidden="true" />
    </button>
  </div>
</template>
