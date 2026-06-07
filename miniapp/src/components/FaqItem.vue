<script setup lang="ts">
/**
 * FaqItem — một mục câu hỏi thường gặp dạng accordion (Obsidian Glass).
 *  - Bấm tiêu đề để mở/đóng; icon ChevronDown xoay 180deg khi mở.
 *  - Tự quản trạng thái mở; nội dung trượt mượt qua max-height.
 */
import { ref } from 'vue'
import { ChevronDown } from '@lucide/vue'
import { haptic } from '@/telegram/sdk'

defineProps<{ question: string; answer: string }>()

const open = ref(false)

function toggle(): void {
  haptic('light')
  open.value = !open.value
}
</script>

<template>
  <div>
    <button
      type="button"
      class="flex w-full items-center justify-between px-4 py-4 text-left transition-colors hover:bg-surface-container-lowest/50"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="pr-3 text-[16px] font-medium text-on-surface">{{ question }}</span>
      <ChevronDown
        :size="20"
        :stroke-width="2"
        class="shrink-0 text-outline transition-transform duration-300"
        :class="open ? 'rotate-180' : ''"
        aria-hidden="true"
      />
    </button>
    <div
      class="overflow-hidden px-4 transition-all duration-300 ease-ios"
      :style="{ maxHeight: open ? '320px' : '0px', opacity: open ? 1 : 0 }"
    >
      <p class="pb-4 text-[16px] leading-relaxed text-on-surface-variant">{{ answer }}</p>
    </div>
  </div>
</template>
