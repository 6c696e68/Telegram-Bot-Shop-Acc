<script setup lang="ts">
/**
 * GlassButton — nút bấm kiểu iOS (Req 13.1, 13.2, 13.3, 13.5).
 *  - variant 'primary'   : nền màu accent phẳng (màu nút Telegram).
 *  - variant 'secondary' : lớp kính `.glass` (màu phẳng + blur), không chuyển-màu-nền.
 *  - target chạm ≥ 44px qua `.tap-target`.
 *  - phát haptic('light') khi bấm; bỏ qua khi disabled/loading.
 */
import { computed } from 'vue'
import { haptic } from '@/telegram/sdk'

const props = withDefaults(
  defineProps<{
    /** Kiểu nút: nền accent (primary) hoặc kính (secondary). */
    variant?: 'primary' | 'secondary'
    /** Vô hiệu hoá nút. */
    disabled?: boolean
    /** Trạng thái đang xử lý: hiện spinner + chặn click. */
    loading?: boolean
    /** Chiếm trọn chiều ngang (full-width). */
    block?: boolean
    /** type của thẻ button gốc. */
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

/** Cho phép tương tác khi KHÔNG disabled và KHÔNG loading. */
const isInteractive = computed(() => !props.disabled && !props.loading)

function onClick(ev: MouseEvent): void {
  if (!isInteractive.value) return
  haptic('light') // Req 13.5 — phản hồi haptic cho thao tác chính
  emit('click', ev)
}
</script>

<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    class="tap-target inline-flex items-center justify-center gap-2 rounded-ios px-5 py-3 font-ios text-ios-headline transition-[transform,opacity] duration-ios ease-ios active:scale-[0.97] disabled:opacity-40"
    :class="[
      block ? 'w-full' : '',
      variant === 'primary' ? 'bg-accent text-accent-text' : 'bg-surface text-text shadow-ios',
    ]"
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
