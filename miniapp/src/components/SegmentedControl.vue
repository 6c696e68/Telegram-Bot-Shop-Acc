<script setup lang="ts">
/**
 * SegmentedControl — control phân đoạn kiểu iOS (chọn phương thức nạp...).
 *  - v-model:modelValue (string). `options`: [{ value, label }].
 *  - track nền alpha phẳng; segment active = surface + bóng nhẹ. haptic khi đổi.
 *  - Màu phẳng, không gradient.
 */
import { haptic } from '@/telegram/sdk'

defineProps<{
  /** Giá trị đang chọn. */
  modelValue: string
  /** Danh sách lựa chọn. */
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
    class="inline-flex w-full items-stretch gap-1 rounded-ios bg-black/5 p-1 dark:bg-white/10"
    role="tablist"
  >
    <button
      v-for="opt in options"
      :key="opt.value"
      type="button"
      role="tab"
      :aria-selected="modelValue === opt.value"
      class="flex-1 rounded-ios px-3 py-2 text-ios-footnote font-medium transition-colors tap-target"
      :class="modelValue === opt.value ? 'bg-surface text-text shadow-ios' : 'text-hint'"
      @click="select(opt.value, modelValue)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>
