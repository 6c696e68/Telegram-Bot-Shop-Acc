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
const filter = ref<'all' | 'completed' | 'refunded'>('all')

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
  void load()
})
</script>

<template>
  <div>
    <TopAppBar :title="$t('app.store_name')" />

    <main
      class="mx-auto max-w-2xl space-y-container-margin px-gutter pt-[calc(56px+var(--safe-top))]"
    >
      <section class="space-y-4 pt-4">
        <h2 class="text-[28px] font-bold text-on-background">{{ $t('history.title') }}</h2>
        <SegmentedControl
          :model-value="filter"
          :options="filterOptions"
          @update:model-value="filter = $event as 'all' | 'completed' | 'refunded'"
        />
      </section>

      <section v-if="filtered.length" class="space-y-4">
        <OrderCard
          v-for="order in filtered"
          :key="order.id"
          :order="order"
          @detail="openDetail(order)"
          @support="router.push({ name: 'support' })"
        />
      </section>

      <EmptyState
        v-else-if="loaded"
        :icon="ReceiptText"
        :title="filter === 'all' ? $t('history.empty_title') : $t('orders.filter_empty_title')"
        :description="filter === 'all' ? $t('history.empty_desc') : $t('orders.filter_empty_desc')"
      />
    </main>
  </div>
</template>
