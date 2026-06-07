<script setup lang="ts">
/**
 * OrderDetailView — chi tiết một đơn hàng + nội dung tài khoản (Req 11.3, 15.3).
 *
 *  - Nhận prop `id` (chuỗi, từ route `order-detail` với `props: true`).
 *  - Khi mở: gọi `GET /api/app/orders/:id` (bọc `ui.withLoading`). Server chỉ trả đơn
 *    thuộc người mua hiện tại (guard owner — Req 15.3); nếu không thuộc/không tồn tại sẽ
 *    trả 404 → toast "Không tìm thấy đơn hàng".
 *  - Hiển thị tóm tắt đơn (emoji, tên loại, số lượng, tổng tiền, trạng thái, thời gian tạo)
 *    rồi tới danh sách `contents[]` — mỗi tài khoản trong một khối kính cho phép bôi chọn
 *    (`select-all`) để người mua copy nhanh, giống màn kết quả mua hàng (Req 11.3).
 *  - BackButton của Telegram để quay lại lịch sử; gỡ khi rời màn hình qua cleanup.
 *
 * Bố cục mobile-first iOS HIG, chỉ dùng màu phẳng + lớp `.glass` — KHÔNG gradient (Req 13).
 */

import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import GlassCard from '@/components/GlassCard.vue'
import { get, ApiError } from '@/api/client'
import { useUiStore } from '@/stores/ui'
import { showBackButton, type Cleanup } from '@/telegram/sdk'
import type { OrderDetailDto } from '@/types'

const props = defineProps<{
  /** Id đơn hàng (chuỗi từ route param). */
  id: string
}>()

const router = useRouter()
const ui = useUiStore()
const { t } = useI18n()

/** Chi tiết đơn hàng; `null` cho tới khi tải xong (hoặc khi không tìm thấy). */
const order = ref<OrderDetailDto | null>(null)

/** Dọn dẹp BackButton (gỡ handler + ẩn) khi rời màn hình. */
let cleanupBack: Cleanup = () => {}

/** Map trạng thái đơn của server sang key i18n nhãn hiển thị (Req 11.2). */
function statusKey(status: OrderDetailDto['status']): string {
  return status === 'completed' || status === 'refunded' ? `status.${status}` : status
}

/**
 * Nạp chi tiết đơn từ server (Req 11.3). 404 (đơn không tồn tại hoặc không thuộc người
 * mua — Req 15.3) → toast riêng; 401 do client xử lý; lỗi khác → toast chung.
 */
async function load(): Promise<void> {
  try {
    order.value = await ui.withLoading(get<OrderDetailDto>(`/orders/${props.id}`))
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 401) return
      if (err.status === 404) {
        ui.toast(t('order.not_found'), 'error')
        return
      }
    }
    ui.toast(t('order.load_error'), 'error')
  }
}

onMounted(() => {
  cleanupBack = showBackButton(() => router.back())
  void load()
})

onUnmounted(() => {
  cleanupBack()
})
</script>

<template>
  <main class="flex flex-col gap-5 px-4 py-6">
    <template v-if="order">
      <!-- Tóm tắt đơn (Req 11.2, 11.3) -->
      <header class="flex flex-col items-center gap-3 text-center">
        <span
          class="flex h-20 w-20 items-center justify-center rounded-full bg-accent-soft text-5xl leading-none"
          aria-hidden="true"
        >
          {{ order.emoji }}
        </span>
        <h1 class="text-ios-title text-text">{{ order.product_name }}</h1>
        <p class="text-ios-large-title tabular-nums text-accent">{{ order.total_display }}</p>
      </header>

      <GlassCard>
        <dl class="flex flex-col gap-2 text-ios-body">
          <div class="flex items-center justify-between gap-2">
            <dt class="text-hint">{{ $t('order.quantity') }}</dt>
            <dd class="tabular-nums text-text">{{ order.quantity }}</dd>
          </div>
          <div class="flex items-center justify-between gap-2">
            <dt class="text-hint">{{ $t('order.status') }}</dt>
            <dd class="text-text">{{ $t(statusKey(order.status)) }}</dd>
          </div>
          <div class="flex items-center justify-between gap-2">
            <dt class="text-hint">{{ $t('order.time') }}</dt>
            <dd class="tabular-nums text-text">{{ $d(new Date(order.created_at), 'short') }}</dd>
          </div>
        </dl>
      </GlassCard>

      <!-- Nội dung tài khoản thuộc đơn (Req 11.3) -->
      <section class="flex flex-col gap-2" :aria-label="$t('order.your_account')">
        <h2 class="px-1 text-ios-footnote text-hint">{{ $t('order.your_account') }}</h2>
        <p
          v-for="(content, idx) in order.contents"
          :key="idx"
          class="surface-card select-all whitespace-pre-wrap break-all p-4 text-ios-body text-text"
        >
          {{ content }}
        </p>
      </section>
    </template>
  </main>
</template>
