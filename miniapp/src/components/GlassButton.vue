<script setup lang="ts">
/**
 * GlassButton — nút bấm (Obsidian Glass).
 *  - variant 'primary'   : gradient xanh (`.btn-gradient`), chữ on-primary.
 *  - variant 'secondary' : nền surface-container-high, chữ on-surface.
 *  - variant 'ghost'     : viền outline, nền trong suốt.
 *  - target chạm >= 44px; haptic('light') khi bấm; bỏ qua khi disabled/loading.
 */
import { computed } from 'vue'
import { haptic } from '@/telegram/sdk'

const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost'
    disabled?: boolean
    loading?: boolean
    block?: boolean
    type?: 'button' | 'submit' | 'reset'
  }>(),
  {
    variant: 'primary',
    disabled: false,
    loading: false,
    block: false,
    type: 'button',
  }
)

const emit = defineEmits<{ (e: 'click', ev: MouseEvent): void }>()

const isInteractive = computed(() => !props.disabled && !props.loading)

const variantClass = computed(() => {
  switch (props.variant) {
    case 'secondary':
      return 'bg-surface-container-high text-on-surface hover:bg-surface-container-highest'
    case 'ghost':
      return 'border border-outline-variant/40 bg-transparent text-on-surface hover:bg-surface-container-low'
    default:
      return 'btn-gradient text-on-primary shadow-md'
  }
})

function onClick(ev: MouseEvent): void {
  if (!isInteractive.value) return
  haptic('light')
  emit('click', ev)
}
</script>

<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    class="tap-target btn-press inline-flex items-center justify-center gap-2 rounded-full px-5 py-3.5 text-[16px] font-semibold transition-[transform,opacity,background-color] duration-200 disabled:opacity-40"
    :class="[block ? 'w-full' : '', variantClass]"
    @click="onClick"
  >
    <span
      v-if="loading"
      class="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
      aria-hidden="true"
    />
    <slot />
  </button>
</template>
