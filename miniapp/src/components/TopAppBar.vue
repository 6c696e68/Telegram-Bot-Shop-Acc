<script setup lang="ts">
/**
 * TopAppBar — thanh tiêu đề cố định trên cùng (Obsidian Glass).
 *  - Nền kính (`.glass-panel`), cao 48px, tôn trọng safe-area-top.
 *  - `back=true` → nút quay lại (ArrowLeft) gọi router.back(); ngược lại hiện icon brand.
 *  - Slot `right` cho hành động bên phải (vd chia sẻ, giỏ hàng). Không emoji — chỉ icon SVG.
 */
import { useRouter } from 'vue-router'
import { ArrowLeft, Store } from '@lucide/vue'
import { haptic } from '@/telegram/sdk'

withDefaults(
  defineProps<{
    title: string
    back?: boolean
  }>(),
  { back: false }
)

const router = useRouter()

function goBack(): void {
  haptic('light')
  router.back()
}
</script>

<template>
  <header
    class="glass-panel fixed left-0 top-0 z-50 flex w-full items-center justify-between px-4"
    :style="{
      height: 'calc(48px + var(--safe-top))',
      paddingTop: 'var(--safe-top)',
      paddingLeft: 'calc(12px + var(--safe-left))',
      paddingRight: 'calc(12px + var(--safe-right))',
    }"
  >
    <button
      v-if="back"
      type="button"
      class="flex h-9 w-9 items-center justify-center rounded-full text-primary transition-transform active:scale-95"
      :aria-label="$t('common.back')"
      @click="goBack"
    >
      <ArrowLeft :size="22" :stroke-width="2" aria-hidden="true" />
    </button>
    <span
      v-else
      class="flex h-9 w-9 items-center justify-center rounded-full text-primary"
      aria-hidden="true"
    >
      <Store :size="22" :stroke-width="2" />
    </span>

    <h1 class="truncate px-2 text-[17px] font-bold tracking-tight text-on-surface">{{ title }}</h1>

    <div class="flex h-9 w-9 items-center justify-center">
      <slot name="right" />
    </div>
  </header>
</template>
