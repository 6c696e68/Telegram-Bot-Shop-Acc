<script setup lang="ts">
/**
 * HomeView — trang chủ Mini App (Req 4).
 *
 *  - Nạp số dư người mua qua `useUserStore().fetchMe()` (GET /api/app/me) khi mở
 *    màn hình, bọc trong `ui.withLoading` để đồng bộ cờ loading toàn cục (Req 4.1).
 *  - Hiển thị số dư qua `BalanceBadge` dùng chuỗi `balanceDisplay` đã format sẵn từ
 *    server để giữ định dạng tiền tệ thống nhất với hệ thống (Req 4.2).
 *  - Lưới 4 lối tắt nhanh (Mua hàng / Nạp tiền / Lịch sử / Tài khoản) là các thẻ kính
 *    có target chạm ≥ 44px; bấm sẽ phát haptic('light') rồi điều hướng tới route tương
 *    ứng (Req 4.3, 4.4).
 *
 * Bố cục mobile-first iOS HIG, chỉ dùng màu phẳng + lớp `.glass` — KHÔNG gradient (Req 13).
 */

import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ShoppingBag, CreditCard, ReceiptText, User } from '@lucide/vue'
import type { Component } from 'vue'
import BalanceBadge from '@/components/BalanceBadge.vue'
import { useUserStore } from '@/stores/user'
import { useUiStore } from '@/stores/ui'
import { ApiError } from '@/api/client'

const router = useRouter()
const user = useUserStore()
const ui = useUiStore()
const { t } = useI18n()

/** Read-only state người mua (telegramId/username/firstName/balance/balanceDisplay/loaded). */
const state = user.state

/**
 * Lối tắt nhanh trên trang chủ (Req 4.3) — mỗi mục trỏ tới một route đã đăng ký
 * trong `@/router` (shop/deposit/history/account).
 */
interface Shortcut {
  /** Tên route đích (khớp `name` trong router). */
  route: 'shop' | 'deposit' | 'history' | 'account'
  /** Key i18n nhãn hiển thị trên thẻ. */
  labelKey: string
  /** Icon SVG (lucide) — màu phẳng, không gradient/emoji. */
  icon: Component
}

const shortcuts: readonly Shortcut[] = [
  { route: 'shop', labelKey: 'home.shop', icon: ShoppingBag },
  { route: 'deposit', labelKey: 'home.deposit', icon: CreditCard },
  { route: 'history', labelKey: 'home.history', icon: ReceiptText },
  { route: 'account', labelKey: 'home.account', icon: User },
] as const

/**
 * Điều hướng tới màn hình tương ứng khi chọn một lối tắt (Req 4.4).
 * Phát haptic('light') cho phản hồi chạm kiểu iOS (Req 13.5).
 */
function goTo(route: Shortcut['route']): void {
  ui.haptic('light')
  router.push({ name: route })
}

/**
 * Khi mở trang chủ: nạp số dư hiện tại của Buyer (Req 4.1).
 * Lỗi 401 do API client tự bật cờ `unauthorized` → bỏ qua toast để tránh nhiễu;
 * các lỗi khác hiển thị toast lỗi để người dùng biết và thử lại (xử lý ApiError nhẹ nhàng).
 */
onMounted(async () => {
  try {
    await ui.withLoading(user.fetchMe())
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return
    ui.toast(t('common.error'), 'error')
  }
})
</script>

<template>
  <main class="flex flex-col gap-5 px-4 py-6">
    <!-- Lời chào + số dư (Req 4.1, 4.2) -->
    <header class="flex flex-col gap-3">
      <p v-if="state.firstName" class="text-ios-title text-text">
        {{ $t('home.hello', { name: state.firstName }) }}
      </p>
      <BalanceBadge :balance="state.balance" :display="state.balanceDisplay" />
    </header>

    <!-- Lối tắt nhanh (Req 4.3, 4.4) -->
    <section class="flex flex-col gap-3" :aria-label="$t('home.shortcuts')">
      <h2 class="px-1 text-ios-footnote text-hint">{{ $t('home.shortcuts') }}</h2>
      <div class="grid grid-cols-2 gap-3">
        <button
          v-for="s in shortcuts"
          :key="s.route"
          type="button"
          class="glass tap-target flex flex-col items-center justify-center gap-2 p-5 transition-transform duration-ios ease-ios active:scale-[0.97]"
          :aria-label="$t('home.open', { label: $t(s.labelKey) })"
          @click="goTo(s.route)"
        >
          <component :is="s.icon" :size="28" :stroke-width="1.75" class="text-accent" aria-hidden="true" />
          <span class="text-ios-headline text-text">{{ $t(s.labelKey) }}</span>
        </button>
      </div>
    </section>
  </main>
</template>
