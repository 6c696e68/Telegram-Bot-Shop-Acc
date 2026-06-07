<script setup lang="ts">
/**
 * CredentialBlock — khối "Thông tin đăng nhập" cho đơn đã hoàn tất (Obsidian Glass).
 *  - Mỗi dòng nội dung tài khoản (products.content) có thể bấm để sao chép toàn bộ.
 *  - haptic('success') + toast khi chép. Icon Copy/Check. Không emoji.
 *  - `contents` là mảng chuỗi thô từ server (đã escape ở tầng hiển thị mặc định của Vue).
 */
import { ref } from 'vue'
import { Copy, Check } from '@lucide/vue'
import { haptic } from '@/telegram/sdk'
import { useUiStore } from '@/stores/ui'
import { useI18n } from 'vue-i18n'

defineProps<{ contents: string[] }>()

const ui = useUiStore()
const { t } = useI18n()
const copiedIdx = ref<number | null>(null)

async function copy(idx: number, value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    haptic('success')
    ui.toast(t('order.copied'), 'success')
    copiedIdx.value = idx
    setTimeout(() => {
      if (copiedIdx.value === idx) copiedIdx.value = null
    }, 1500)
  } catch {
    haptic('error')
  }
}
</script>

<template>
  <div class="overflow-hidden rounded-xl border border-outline-variant/30 bg-surface-container-low">
    <div class="border-b border-outline-variant/20 bg-surface-container-high/50 px-3 py-2">
      <span class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
        {{ $t('order.credentials') }}
      </span>
    </div>
    <div class="space-y-1 p-2">
      <button
        v-for="(content, idx) in contents"
        :key="idx"
        type="button"
        class="group flex w-full items-center justify-between gap-2 rounded-lg p-2 text-left transition-colors hover:bg-surface-container"
        @click="copy(idx, content)"
      >
        <span class="min-w-0 flex-1 break-all font-mono text-[13px] text-on-surface">
          {{ content }}
        </span>
        <span
          class="shrink-0 rounded-md p-1.5 text-on-surface-variant transition-colors group-hover:text-primary"
        >
          <component :is="copiedIdx === idx ? Check : Copy" :size="18" :stroke-width="2" aria-hidden="true" />
        </span>
      </button>
    </div>
  </div>
</template>
