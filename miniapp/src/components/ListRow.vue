<script setup lang="ts">
/**
 * ListRow — một dòng trong ListSection kiểu CryptoBot.
 *  - slot `leading` (avatar/icon), `title`/`subtitle` (hoặc props), slot `trailing`.
 *  - `clickable` → render <button>, phát haptic('light') + emit('click'); có chevron.
 *  - `disabled` → mờ + chặn click. Màu phẳng, không gradient.
 */
import { computed } from 'vue'
import { ChevronRight } from '@lucide/vue'
import { haptic } from '@/telegram/sdk'

const props = withDefaults(
  defineProps<{
    /** Tiêu đề dòng (bỏ qua nếu dùng slot `title`). */
    title?: string
    /** Phụ đề (bỏ qua nếu dùng slot `subtitle`). */
    subtitle?: string
    /** Cho bấm được (render button + chevron + haptic). */
    clickable?: boolean
    /** Vô hiệu hoá (mờ + chặn click). */
    disabled?: boolean
    /** Hiện chevron phải (mặc định theo `clickable`). */
    chevron?: boolean
  }>(),
  { title: '', subtitle: '', clickable: false, disabled: false, chevron: undefined }
)

const emit = defineEmits<{ (e: 'click'): void }>()

const showChevron = computed(() => (props.chevron === undefined ? props.clickable : props.chevron))

function onClick(): void {
  if (!props.clickable || props.disabled) return
  haptic('light')
  emit('click')
}
</script>

<template>
  <component
    :is="clickable ? 'button' : 'div'"
    :type="clickable ? 'button' : undefined"
    :disabled="clickable && disabled ? true : undefined"
    class="flex w-full items-center gap-3 px-4 py-3 text-left tap-target"
    :class="[
      clickable ? 'transition-colors active:bg-app' : '',
      disabled ? 'opacity-50' : '',
    ]"
    @click="onClick"
  >
    <slot name="leading" />

    <span class="flex min-w-0 flex-1 flex-col">
      <slot name="title">
        <span class="truncate text-ios-headline text-text">{{ title }}</span>
      </slot>
      <slot name="subtitle">
        <span v-if="subtitle" class="truncate text-ios-footnote text-hint">{{ subtitle }}</span>
      </slot>
    </span>

    <slot name="trailing" />
    <ChevronRight
      v-if="showChevron"
      :size="18"
      :stroke-width="2"
      class="shrink-0 text-hint"
      aria-hidden="true"
    />
  </component>
</template>
