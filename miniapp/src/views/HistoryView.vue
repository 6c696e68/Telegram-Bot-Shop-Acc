<script setup lang="ts">
/**
 * HistoryView — lịch sử đơn hàng của Buyer (Req 11.1, 11.2, 11.4).
 *
 *  - Khi mở: gọi `GET /api/app/orders` (bọc `ui.withLoading`) lấy danh sách đơn của
 *    người mua hiện tại, đã được server lọc theo `telegram_id` và sắp xếp theo thời gian
 *    tạo giảm dần (Req 11.1) — frontend chỉ render theo đúng thứ tự nhận được.
 *  - Mỗi đơn render trong một `GlassCard`: emoji + tên loại sản phẩm, số lượng, tổng tiền
 *    (chuỗi `total_display` đã format từ server), trạng thái (map sang nhãn tiếng Việt) và
 *    thời gian tạo (format `DD/MM/YYYY HH:mm` qua `formatDate`) (Req 11.2).
 *  - Chạm vào một đơn → điều hướng sang màn chi tiết (`order-detail` với `id` dạng chuỗi
 *    để khớp prop route `props: true`); phát haptic('light') cho phản hồi kiểu iOS.
 *  - Chưa có đơn nào → `EmptyState` (Req 11.4). Lỗi tải (khác 401) → toast lỗi.
 *  - BackButton của Telegram để quay lại trang chủ; gỡ khi rời màn hình qua cleanup.
 *
 * Bố cục mobile-first iOS HIG, chỉ dùng màu phẳng + lớp `.glass` — KHÔNG gradient (Req 13).
 */

import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import GlassCard from '@/components/GlassCard.vue'
import EmptyState from '@/components/EmptyState.vue'
import { ReceiptText } from '@lucide/vue'
import { get, ApiError } from '@/api/client'
import { useUiStore } from '@/stores/ui'
import { showBackButton, type Cleanup } from '@/telegram/sdk'
import { formatCurrency } from '@/utils/format'
import type { OrderListItemDto } from '@/types'

const router = useRouter()
const ui = useUiStore()
const { t } = useI18n()

/** Danh sách đơn hàng (đã sắp xếp giảm dần theo thời gian từ server — Req 11.1). */
const orders = ref<OrderListItemDto[]>([])
/** `true` sau khi request đầu tiên hoàn tất — tránh nháy EmptyState trong lúc đang tải. */
const loaded = ref(false)

/** Dọn dẹp BackButton (gỡ handler + ẩn) khi rời màn hình. */
let cleanupBack: Cleanup = () => {}

/** Map trạng thái đơn của server sang key i18n nhãn hiển thị (Req 11.2). */
function statusKey(status: OrderListItemDto['status']): string {
  return status === 'completed' || status === 'refunded' ? `status.${status}` : status
}

/**
 * Mở màn chi tiết của một đơn hàng (Req 11.3). `id` truyền dạng chuỗi để khớp prop
 * route (`props: true`). Phát haptic('light') cho phản hồi chạm kiểu iOS (Req 13.5).
 */
function openDetail(order: OrderListItemDto): void {
  ui.haptic('light')
  router.push({ name: 'order-detail', params: { id: String(order.id) } })
}

/** Nạp lịch sử đơn từ server; 401 do client tự xử lý (bỏ qua toast), lỗi khác → toast. */
async function load(): Promise<void> {
  try {
    orders.value = await ui.withLoading(get<OrderListItemDto[]>('/orders'))
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return
    ui.toast(t('history.load_error'), 'error')
  } finally {
    loaded.value = true
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
  <main class="flex flex-col gap-4 px-4 py-6">
    <header class="px-1">
      <h1 class="text-ios-title text-text">{{ $t('history.title') }}</h1>
    </header>

    <!-- Danh sách đơn (Req 11.1, 11.2); sắp xếp giảm dần theo thời gian từ server -->
    <section
      v-if="orders.length"
      class="flex flex-col gap-3"
      :aria-label="$t('history.list_label')"
    >
      <GlassCard
        v-for="order in orders"
        :key="order.id"
        as="button"
        class="tap-target w-full text-left transition-transform duration-ios ease-ios active:scale-[0.98]"
        :aria-label="order.product_name"
        @click="openDetail(order)"
      >
        <div class="flex items-center gap-3">
          <span class="text-3xl leading-none" aria-hidden="true">{{ order.emoji }}</span>

          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <div class="flex items-baseline justify-between gap-2">
              <span class="truncate text-ios-headline text-text">{{ order.product_name }}</span>
              <span class="shrink-0 tabular-nums text-ios-headline text-accent">
                {{ formatCurrency(order.total_amount) }}
              </span>
            </div>

            <div class="flex items-center justify-between gap-2 text-ios-footnote text-hint">
              <span>{{ $t('history.qty', { count: order.quantity }) }}</span>
              <span>{{ $t(statusKey(order.status)) }}</span>
            </div>

            <span class="text-ios-caption text-hint">{{ $d(new Date(order.created_at), 'short') }}</span>
          </div>
        </div>
      </GlassCard>
    </section>

    <!-- Trạng thái trống khi chưa có đơn nào (Req 11.4) -->
    <EmptyState
      v-else-if="loaded"
      :icon="ReceiptText"
      :title="$t('history.empty_title')"
      :description="$t('history.empty_desc')"
    />
  </main>
</template>
