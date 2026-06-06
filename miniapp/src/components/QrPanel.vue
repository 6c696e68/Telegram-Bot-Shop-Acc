<script setup lang="ts">
/**
 * QrPanel — hiển thị VietQR + thông tin chuyển khoản trong lớp kính (Req 8.4).
 *  - ảnh QR (qrUrl) đặt trên nền trắng cố định để máy quét đọc tốt (màu phẳng).
 *  - các dòng thông tin: ngân hàng, số TK, chủ TK, số tiền, nội dung CK.
 *  - số TK + nội dung CK bấm để sao chép (target chạm ≥ 44px + haptic phản hồi).
 */
import { ref } from 'vue'
import { haptic } from '@/telegram/sdk'

defineProps<{
  /** URL ảnh VietQR (img.vietqr.io). */
  qrUrl: string
  /** Tên ngân hàng. */
  bankName: string
  /** Số tài khoản nhận. */
  bankAccount: string
  /** Chủ tài khoản. */
  bankOwner: string
  /** Số tiền đã định dạng (vd "100,000đ"). */
  amountDisplay: string
  /** Nội dung chuyển khoản duy nhất (transfer_code). */
  transferCode: string
}>()

/** Khoá field vừa được sao chép để hiển thị trạng thái "Đã chép". */
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
  <div class="glass flex flex-col gap-4 p-5">
    <!-- Ảnh VietQR trên nền trắng phẳng (tương phản cho máy quét). -->
    <div class="mx-auto rounded-ios bg-white p-3">
      <img
        :src="qrUrl"
        :alt="$t('deposit.scan_qr')"
        class="block h-56 w-56 object-contain"
      />
    </div>

    <div class="flex flex-col gap-1 text-ios-body">
      <div class="flex items-center justify-between gap-3 py-1">
        <span class="text-hint">{{ $t('qr.bank') }}</span>
        <span class="text-text">{{ bankName }}</span>
      </div>

      <button
        type="button"
        class="tap-target flex items-center justify-between gap-3 text-left"
        @click="copy('account', bankAccount)"
      >
        <span class="text-hint">{{ $t('qr.account') }}</span>
        <span class="tabular-nums text-accent">
          {{ copied === 'account' ? $t('qr.copied') : bankAccount }}
        </span>
      </button>

      <div class="flex items-center justify-between gap-3 py-1">
        <span class="text-hint">{{ $t('qr.owner') }}</span>
        <span class="text-text">{{ bankOwner }}</span>
      </div>

      <div class="flex items-center justify-between gap-3 py-1">
        <span class="text-hint">{{ $t('qr.amount') }}</span>
        <span class="tabular-nums text-text">{{ amountDisplay }}</span>
      </div>

      <button
        type="button"
        class="tap-target flex items-center justify-between gap-3 text-left"
        @click="copy('code', transferCode)"
      >
        <span class="text-hint">{{ $t('qr.note') }}</span>
        <span class="font-semibold text-accent">
          {{ copied === 'code' ? $t('qr.copied') : transferCode }}
        </span>
      </button>
    </div>
  </div>
</template>
