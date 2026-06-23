<script setup lang="ts">
/**
 * SegmentedControl — control phân đoạn kiểu iOS 18 (Obsidian Glass).
 *  - v-model:modelValue (string). `options`: [{ value, label }].
 *  - Track nền surface-container-high; segment active = surface + viền nhẹ. haptic khi đổi.
 */
import { haptic } from '@/telegram/sdk'

defineProps<{
  modelValue: string
  options: ReadonlyArray<{ value: string; label: string }>
}>()

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

function select(value: string, current: string): void {
  if (value === current) return
  haptic('light')
  emit('update:modelValue', value)
}
</script>

<template>
  <div
    class="flex w-full items-stretch rounded-xl bg-surface-container-high p-1"
    role="tablist"
  >
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      role="tab"
      :aria-selected="modelValue === opt.value"
      class="flex min-h-[38px] flex-1 items-center justify-center rounded-lg px-2 py-1.5 text-center text-[13px] font-medium leading-tight transition-colors"
      :class="
        modelValue === opt.value
          ? 'border border-outline-variant/10 bg-surface font-semibold text-on-surface shadow-sm'
          : 'text-on-surface-variant hover:text-on-surface'
      "
      @click="select(opt.value, modelValue)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>
