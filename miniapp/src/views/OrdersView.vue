<script setup lang="ts">
/**
 * OrdersView — "Orders", tab cấp 1 (Obsidian Glass, Req 11.1, 11.2, 11.4).
 *
 *  - `GET /api/app/orders` (server lọc theo telegram_id, sắp giảm dần thời gian).
 *  - SegmentedControl lọc: Tất cả / Hoàn thành / Hoàn tiền.
 *  - OrderCard → "Chi tiết" mở order-detail (xem nội dung tài khoản), "Hỗ trợ" sang Support.
 *  - Trống → EmptyState. Là tab cấp 1 nên KHÔNG dùng Telegram BackButton.
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ReceiptText } from '@lucide/vue'
import TopAppBar from '@/components/TopAppBar.vue'
import SegmentedControl from '@/components/SegmentedControl.vue'
import OrderCard from '@/components/OrderCard.vue'
import EmptyState from '@/components/EmptyState.vue'
import { get, ApiError } from '@/api/client'
import { useUiStore } from '@/stores/ui'
import type { OrderListItemDto } from '@/types'

const router = useRouter()
const ui = useUiStore()
const { t } = useI18n()

const orders = ref<OrderListItemDto[]>([])
const loaded = ref(false)
const loadingMore = ref(false)
const hasMore = ref(false)
const page = ref(1)
const filter = ref<'all' | 'completed' | 'refunded'>('all')

/** Số đơn mỗi trang — khớp DEFAULT_ORDERS_LIMIT của API. */
const PAGE_SIZE = 20

const filterOptions = computed(() => [
  { value: 'all', label: t('orders.filter_all') },
  { value: 'completed', label: t('status.completed') },
  { value: 'refunded', label: t('status.refunded') },
])

const filtered = computed(() => {
  if (filter.value === 'all') return orders.value
  return orders.value.filter((o) => o.status === filter.value)
})

function openDetail(order: OrderListItemDto): void {
  router.push({ name: 'order-detail', params: { id: String(order.id) } })
}

function fetchPage(p: number): Promise<OrderListItemDto[]> {
  return get<OrderListItemDto[]>(`/orders?page=${p}&limit=${PAGE_SIZE}`)
}

/** Tải trang đầu (mới nhất trước). hasMore suy ra từ số lượng trả về = đầy trang. */
async function load(): Promise<void> {
  try {
    const batch = await ui.withLoading(fetchPage(1))
    orders.value = batch
    page.value = 1
    hasMore.value = batch.length === PAGE_SIZE
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return
    ui.toast(t('history.load_error'), 'error')
  } finally {
    loaded.value = true
  }
}

/** Tải thêm trang kế và nối vào danh sách để xem hết lịch sử mua hàng. */
async function loadMore(): Promise<void> {
  if (loadingMore.value || !hasMore.value) return
  loadingMore.value = true
  try {
    const next = page.value + 1
    const batch = await fetchPage(next)
    orders.value = [...orders.value, ...batch]
    page.value = next
    hasMore.value = batch.length === PAGE_SIZE
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return
    ui.toast(t('history.load_error'), 'error')
  } finally {
    loadingMore.value = false
  }
}

onMounted(() => {
  void load()
})
</script>

<template>
  <div>
    <TopAppBar :title="$t('app.store_name')" />

    <main
      class="mx-auto max-w-2xl space-y-container-margin px-gutter pt-[calc(48px+var(--safe-top))]"
    >
      <section class="space-y-3 pt-3">
        <h2 class="text-[24px] font-bold text-on-background">{{ $t('history.title') }}</h2>
        <SegmentedControl
          :model-value="filter"
          :options="filterOptions"
          @update:model-value="filter = $event as 'all' | 'completed' | 'refunded'"
        />
      </section>

      <section v-if="filtered.length" class="space-y-3">
        <OrderCard
          v-for="order in filtered"
          :key="order.id"
          :order="order"
          @detail="openDetail(order)"
          @support="router.push({ name: 'support' })"
        />
      </section>

      <div v-if="hasMore" class="flex justify-center pt-2">
        <button
          type="button"
          class="rounded-xl border border-outline-variant/30 bg-surface-container-high px-5 py-2 text-[13px] font-semibold text-on-surface transition-colors hover:bg-surface-container-highest disabled:opacity-50"
          :disabled="loadingMore"
          @click="loadMore"
        >
          {{ $t('history.load_more') }}
        </button>
      </div>

      <EmptyState
        v-else-if="loaded && !filtered.length"
        :icon="ReceiptText"
        :title="filter === 'all' ? $t('history.empty_title') : $t('orders.filter_empty_title')"
        :description="filter === 'all' ? $t('history.empty_desc') : $t('orders.filter_empty_desc')"
      />
    </main>
  </div>
</template>
