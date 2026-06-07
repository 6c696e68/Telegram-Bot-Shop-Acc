<script setup lang="ts">
/**
 * WalletView — "Ví", tab cấp 1 (Req 4, 11).
 *
 *  - `BalanceHero`: số dư lớn + hàng nút tròn (Nạp tiền → deposit, Lịch sử → history).
 *  - Khu "Đơn gần đây": vài đơn mới nhất (`GET /api/app/orders`), "Xem tất cả" → history.
 *  - Là route cấp 1 (tab) nên KHÔNG dùng Telegram BackButton. Màu phẳng, không gradient.
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { CreditCard, ReceiptText } from '@lucide/vue'
import BalanceHero from '@/components/BalanceHero.vue'
import CircleAction from '@/components/CircleAction.vue'
import ListSection from '@/components/ListSection.vue'
import ListRow from '@/components/ListRow.vue'
import { useUserStore } from '@/stores/user'
import { useUiStore } from '@/stores/ui'
import { get, ApiError } from '@/api/client'
import type { OrderListItemDto } from '@/types'

const router = useRouter()
const user = useUserStore()
const ui = useUiStore()
const { t } = useI18n()

const state = user.state
const orders = ref<OrderListItemDto[]>([])

/** Tối đa 4 đơn gần nhất (server đã sắp giảm dần theo thời gian). */
const recent = computed(() => orders.value.slice(0, 4))

function goDeposit(): void {
  router.push({ name: 'deposit' })
}
function goHistory(): void {
  router.push({ name: 'history' })
}
function openOrder(order: OrderListItemDto): void {
  router.push({ name: 'order-detail', params: { id: String(order.id) } })
}

onMounted(async () => {
  try {
    await ui.withLoading(user.fetchMe())
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 401)) ui.toast(t('common.error'), 'error')
  }
  try {
    orders.value = await get<OrderListItemDto[]>('/orders')
  } catch {
    // Ví vẫn dùng được khi danh sách đơn lỗi tải.
  }
})
</script>

<template>
  <main class="flex flex-col gap-7 px-4 pb-2 pt-6">
    <!-- Số dư + nút tròn -->
    <BalanceHero :balance="state.balance" :display="state.balanceDisplay">
      <CircleAction :icon="CreditCard" :label="$t('home.deposit')" @click="goDeposit" />
      <CircleAction :icon="ReceiptText" :label="$t('home.history')" @click="goHistory" />
    </BalanceHero>

    <!-- Đơn gần đây -->
    <ListSection v-if="recent.length" :title="$t('wallet.recent_orders')">
      <template #header-action>
        <button type="button" class="text-ios-footnote text-accent" @click="goHistory">
          {{ $t('home.view_all') }}
        </button>
      </template>
      <ListRow
        v-for="order in recent"
        :key="order.id"
        clickable
        :title="order.product_name"
        :subtitle="t('history.qty', { count: order.quantity }) + ' · ' + $d(new Date(order.created_at), 'short')"
        @click="openOrder(order)"
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
          <span class="shrink-0 text-ios-footnote tabular-nums text-accent">{{ order.total_display }}</span>
        </template>
      </ListRow>
    </ListSection>
  </main>
</template>
