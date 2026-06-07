<script setup lang="ts">
/**
 * HistoryView — lịch sử đơn hàng của Buyer (Req 11.1, 11.2, 11.4).
 *
 *  - `GET /api/app/orders` (bọc `ui.withLoading`) — server đã lọc theo `telegram_id` và
 *    sắp giảm dần theo thời gian. Render trong `ListSection` (row `ListRow`).
 *  - Chạm vào đơn → màn chi tiết (`order-detail`). Trống → `EmptyState` (Req 11.4).
 *  - Màn cấp 2 (mở từ Ví) → dùng Telegram BackButton. Màu phẳng, không gradient.
 */
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import ListSection from '@/components/ListSection.vue'
import ListRow from '@/components/ListRow.vue'
import EmptyState from '@/components/EmptyState.vue'
import { ReceiptText } from '@lucide/vue'
import { get, ApiError } from '@/api/client'
import { useUiStore } from '@/stores/ui'
import { showBackButton, type Cleanup } from '@/telegram/sdk'
import type { OrderListItemDto } from '@/types'

const router = useRouter()
const ui = useUiStore()
const { t } = useI18n()

const orders = ref<OrderListItemDto[]>([])
const loaded = ref(false)

let cleanupBack: Cleanup = () => {}

function statusKey(status: OrderListItemDto['status']): string {
  return status === 'completed' || status === 'refunded' ? `status.${status}` : status
}

function openDetail(order: OrderListItemDto): void {
  router.push({ name: 'order-detail', params: { id: String(order.id) } })
}

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
      <h1 class="text-ios-large-title text-text">{{ $t('history.title') }}</h1>
    </header>

    <ListSection v-if="orders.length" :title="$t('history.list_label')">
      <ListRow
        v-for="order in orders"
        :key="order.id"
        clickable
        :title="order.product_name"
        :subtitle="t('history.qty', { count: order.quantity }) + ' · ' + $t(statusKey(order.status))"
        @click="openDetail(order)"
      >
        <template #leading>
          <span
            class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-2xl leading-none"
            aria-hidden="true"
          >
            {{ order.emoji }}
          </span>
        </template>
        <template #trailing>
          <span class="flex flex-col items-end">
            <span class="shrink-0 text-ios-headline tabular-nums text-accent">{{ order.total_display }}</span>
            <span class="text-ios-caption text-hint">{{ $d(new Date(order.created_at), 'short') }}</span>
          </span>
        </template>
      </ListRow>
    </ListSection>

    <EmptyState
      v-else-if="loaded"
      :icon="ReceiptText"
      :title="$t('history.empty_title')"
      :description="$t('history.empty_desc')"
    />
  </main>
</template>
