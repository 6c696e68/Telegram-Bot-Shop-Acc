<script setup lang="ts">
/**
 * AccountView — thông tin tài khoản người mua (Req 12).
 *
 *  - Nạp thông tin người mua qua `useUserStore().fetchMe()` (GET /api/app/me) khi mở
 *    màn hình NẾU store chưa có dữ liệu (`!state.loaded`) — tránh fetch thừa khi điều
 *    hướng từ trang chủ vốn đã nạp sẵn; bọc trong `ui.withLoading` để đồng bộ cờ loading
 *    toàn cục.
 *  - Hiển thị số dư qua `BalanceBadge` dùng chuỗi `balanceDisplay` đã format sẵn từ server
 *    để giữ định dạng tiền tệ thống nhất với hệ thống (Req 12.1).
 *  - Hiển thị thông tin định danh lấy từ `GET /api/app/me`: `telegram_id`, `username`,
 *    `first_name` dưới dạng các hàng nhãn–giá trị trong một thẻ kính (Req 12.2). Giá trị
 *    rỗng được thay bằng placeholder tiếng Việt ('Chưa đặt' cho username, '—' cho tên).
 *  - TUYỆT ĐỐI KHÔNG có bất kỳ chức năng/đường dẫn quản trị nào — màn hình chỉ đọc (Req 12.3).
 *  - BackButton của Telegram quay lại trang trước; handler được gỡ trong `onUnmounted`.
 *
 * Bố cục mobile-first iOS HIG, chỉ dùng màu phẳng + lớp `.glass` — KHÔNG gradient (Req 13).
 */

import { computed, onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import BalanceBadge from '@/components/BalanceBadge.vue'
import GlassCard from '@/components/GlassCard.vue'
import GlassButton from '@/components/GlassButton.vue'
import { useUserStore } from '@/stores/user'
import { useUiStore } from '@/stores/ui'
import { ApiError } from '@/api/client'
import { showBackButton, type Cleanup } from '@/telegram/sdk'

const router = useRouter()
const user = useUserStore()
const ui = useUiStore()
const { t } = useI18n()

/** Read-only state người mua (telegramId/username/firstName/balance/balanceDisplay/loaded). */
const state = user.state

/** Một hàng thông tin định danh (nhãn tiếng Việt + giá trị hiển thị). */
interface IdentityRow {
  /** Khoá ổn định cho v-for. */
  key: string
  /** Nhãn tiếng Việt (Req 12.2). */
  label: string
  /** Giá trị hiển thị (đã thay placeholder khi rỗng). */
  value: string
  /** Dùng chữ số bảng (canh cột) cho giá trị thuần số như `telegram_id`. */
  mono?: boolean
}

/**
 * Các hàng thông tin định danh từ `GET /me` (Req 12.2):
 *  - ID Telegram: `telegram_id` (số) — '—' khi chưa nạp.
 *  - Tên người dùng: `username` — 'Chưa đặt' khi người dùng không có username Telegram.
 *  - Tên: `first_name` — '—' khi rỗng.
 */
const identityRows = computed<IdentityRow[]>(() => [
  {
    key: 'telegram_id',
    label: t('account.telegram_id'),
    value: state.telegramId !== null ? String(state.telegramId) : '—',
    mono: true,
  },
  {
    key: 'username',
    label: t('account.username'),
    value: state.username ?? t('account.username_unset'),
  },
  {
    key: 'first_name',
    label: t('account.name'),
    value: state.firstName ?? '—',
  },
])

// ── Dọn dẹp nút Telegram ──────────────────────────────────────────────────────────────

let cleanupBack: Cleanup = () => {}

/**
 * Khi mở màn hình:
 *  - Hiển thị BackButton của Telegram (quay lại trang trước).
 *  - Nạp thông tin tài khoản nếu store chưa có (Req 12.1, 12.2). Lỗi 401 do API client
 *    tự bật cờ `unauthorized` → bỏ qua toast để tránh nhiễu; lỗi khác hiển thị toast.
 */
onMounted(async () => {
  cleanupBack = showBackButton(() => router.back())

  if (state.loaded) return
  try {
    await ui.withLoading(user.fetchMe())
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return
    ui.toast(t('account.load_error'), 'error')
  }
})

onUnmounted(() => {
  cleanupBack()
})
</script>

<template>
  <main class="flex flex-col gap-5 px-4 py-6">
    <header class="flex flex-col gap-1">
      <h1 class="text-ios-title text-text">{{ $t('account.title') }}</h1>
      <p class="text-ios-footnote text-hint">{{ $t('account.subtitle') }}</p>
    </header>

    <!-- Số dư hiện tại (Req 12.1) -->
    <BalanceBadge :balance="state.balance" :display="state.balanceDisplay" />

    <!-- Thông tin định danh (Req 12.2) — màn hình chỉ đọc, KHÔNG có chức năng quản trị (Req 12.3) -->
    <section class="flex flex-col gap-3" :aria-label="$t('account.identity')">
      <h2 class="px-1 text-ios-footnote text-hint">{{ $t('account.identity') }}</h2>
      <GlassCard>
        <dl class="flex flex-col">
          <template v-for="(row, index) in identityRows" :key="row.key">
            <div
              v-if="index > 0"
              class="h-px bg-[var(--glass-stroke)]"
              aria-hidden="true"
            />
            <div class="flex items-center justify-between gap-4 py-3">
              <dt class="text-ios-body text-hint">{{ row.label }}</dt>
              <dd
                class="break-all text-right text-ios-body text-text"
                :class="row.mono ? 'tabular-nums' : ''"
              >
                {{ row.value }}
              </dd>
            </div>
          </template>
        </dl>
      </GlassCard>
    </section>

    <!-- Thiết lập vùng + ngôn ngữ (R5.2, R6.2) -->
    <GlassButton variant="secondary" block @click="router.push({ name: 'settings' })">
      {{ $t('settings.title') }}
    </GlassButton>
  </main>
</template>
