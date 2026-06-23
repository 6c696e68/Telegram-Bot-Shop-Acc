<script setup lang="ts">
/**
 * QrPanel — hiển thị VietQR + thông tin chuyển khoản (Obsidian Glass, Req 8.4).
 *  - Ảnh QR trên nền trắng cố định (tương phản cho máy quét).
 *  - Các dòng: ngân hàng, số TK, chủ TK, số tiền, nội dung CK.
 *  - Số TK + nội dung CK bấm để sao chép (target chạm >= 44px + haptic).
 */
import { ref } from 'vue'
import { Copy, Check } from '@lucide/vue'
import { haptic } from '@/telegram/sdk'

defineProps<{
  qrUrl: string
  bankName: string
  bankAccount: string
  bankOwner: string
  amountDisplay: string
  transferCode: string
}>()

const copied = ref<string | null>(null)

async function copy(field: string, value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
    haptic('success')
    copied.value = field
    setTimeout(() => {
      if (copied.value === field) copied.value = null
    }, 1500)
  } catch {
    haptic('error')
  }
}
</script>

<template>
  <div class="glass-card flex flex-col gap-3 rounded-xl p-4">
    <div class="mx-auto rounded-xl bg-white p-2.5">
      <img :src="qrUrl" :alt="$t('deposit.scan_qr')" class="block h-48 w-48 object-contain" />
    </div>

    <div class="flex flex-col gap-1 text-[14px]">
      <div class="flex items-center justify-between gap-3 py-1">
        <span class="text-on-surface-variant">{{ $t('qr.bank') }}</span>
        <span class="text-on-surface">{{ bankName }}</span>
      </div>

      <button
        type="button"
        class="tap-target flex items-center justify-between gap-3 rounded-lg px-1 text-left transition-colors hover:bg-surface-container"
        @click="copy('account', bankAccount)"
      >
        <span class="text-on-surface-variant">{{ $t('qr.account') }}</span>
        <span class="flex items-center gap-1 tabular-nums text-primary">
          {{ copied === 'account' ? $t('qr.copied') : bankAccount }}
          <component :is="copied === 'account' ? Check : Copy" :size="15" :stroke-width="2" aria-hidden="true" />
        </span>
      </button>

      <div class="flex items-center justify-between gap-3 py-1">
        <span class="text-on-surface-variant">{{ $t('qr.owner') }}</span>
        <span class="text-on-surface">{{ bankOwner }}</span>
      </div>

      <div class="flex items-center justify-between gap-3 py-1">
        <span class="text-on-surface-variant">{{ $t('qr.amount') }}</span>
        <span class="tabular-nums text-on-surface">{{ amountDisplay }}</span>
      </div>

      <button
        type="button"
        class="tap-target flex items-center justify-between gap-3 rounded-lg px-1 text-left transition-colors hover:bg-surface-container"
        @click="copy('code', transferCode)"
      >
        <span class="text-on-surface-variant">{{ $t('qr.note') }}</span>
        <span class="flex items-center gap-1 font-semibold text-primary">
          {{ copied === 'code' ? $t('qr.copied') : transferCode }}
          <component :is="copied === 'code' ? Check : Copy" :size="15" :stroke-width="2" aria-hidden="true" />
        </span>
      </button>
    </div>
  </div>
</template>
