<script setup lang="ts">
/**
 * ProfileView — "Profile", tab cấp 1 (Obsidian Glass, Req 12, R5.2, R6.2).
 *
 *  - Thẻ số dư + nút "Nạp tiền" (→ DepositView).
 *  - Thông tin định danh (ID Telegram / Username / Tên) — chỉ đọc, KHÔNG admin.
 *  - Chọn vùng (R5.2) + ngôn ngữ (R6.2) inline: lưu qua store, cập nhật locale reactive.
 *  - Là tab cấp 1 nên KHÔNG dùng Telegram BackButton.
 */
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Check, Plus, ChevronRight } from '@lucide/vue'
import TopAppBar from '@/components/TopAppBar.vue'
import { useUserStore } from '@/stores/user'
import { useUiStore } from '@/stores/ui'
import { ApiError } from '@/api/client'
import { AVAILABLE_LOCALES } from '@/i18n'

const router = useRouter()
const user = useUserStore()
const ui = useUiStore()
const { t } = useI18n()

const state = user.state
const regions = ['vietnam', 'international'] as const

interface IdentityRow {
  key: string
  label: string
  value: string
  mono?: boolean
}

const identityRows = computed<IdentityRow[]>(() => [
  {
    key: 'telegram_id',
    label: t('account.telegram_id'),
    value: state.telegramId !== null ? String(state.telegramId) : '—',
    mono: true,
  },
  { key: 'username', label: t('account.username'), value: state.username ?? t('account.username_unset') },
  { key: 'first_name', label: t('account.name'), value: state.firstName ?? '—' },
])

async function chooseRegion(region: 'vietnam' | 'international'): Promise<void> {
  if (state.region === region) return
  ui.haptic('light')
  try {
    await ui.withLoading(user.setRegion(region))
    ui.toast(t('settings.saved'), 'success')
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return
    ui.toast(t('common.error'), 'error')
  }
}

async function chooseLanguage(lang: string): Promise<void> {
  if (state.language === lang) return
  ui.haptic('light')
  try {
    await ui.withLoading(user.setLanguage(lang))
    ui.toast(t('settings.saved'), 'success')
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return
    ui.toast(t('common.error'), 'error')
  }
}

onMounted(async () => {
  if (state.loaded) return
  try {
    await ui.withLoading(user.fetchMe())
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return
    ui.toast(t('account.load_error'), 'error')
  }
})
</script>

<template>
  <div>
    <TopAppBar :title="$t('account.title')" />

    <main
      class="mx-auto flex max-w-2xl flex-col gap-stack-lg px-gutter pt-[calc(56px+var(--safe-top))]"
    >
      <!-- Thẻ số dư -->
      <section class="pt-4">
        <div class="glass-card flex flex-col gap-4 rounded-2xl p-5 shadow-lg">
          <div>
            <p class="font-mono text-[12px] uppercase tracking-wider text-on-surface-variant">
              {{ $t('account.balance') }}
            </p>
            <p class="mt-1 text-[34px] font-bold tabular-nums text-primary">
              {{ state.balanceDisplay || '—' }}
            </p>
          </div>
          <button
            type="button"
            class="btn-gradient btn-press flex w-full items-center justify-center gap-2 rounded-full py-3.5 text-[16px] font-semibold text-on-primary shadow-md"
            @click="router.push({ name: 'deposit' })"
          >
            <Plus :size="20" :stroke-width="2.4" aria-hidden="true" />
            {{ $t('home.deposit') }}
          </button>
        </div>
      </section>

      <!-- Định danh -->
      <section class="flex flex-col gap-2">
        <h3 class="px-2 font-mono text-[12px] uppercase tracking-wider text-on-surface-variant">
          {{ $t('account.identity') }}
        </h3>
        <div class="divide-y divide-outline-variant/20 overflow-hidden rounded-xl border border-outline-variant/20 bg-surface-container-lowest">
          <div
            v-for="row in identityRows"
            :key="row.key"
            class="flex items-center justify-between gap-3 px-4 py-3.5"
          >
            <span class="text-[16px] text-on-surface">{{ row.label }}</span>
            <span
              class="truncate text-right text-[15px] text-on-surface-variant"
              :class="row.mono ? 'font-mono tabular-nums' : ''"
            >
              {{ row.value }}
            </span>
          </div>
        </div>
      </section>

      <!-- Khu vực -->
      <section class="flex flex-col gap-2">
        <h3 class="px-2 font-mono text-[12px] uppercase tracking-wider text-on-surface-variant">
          {{ $t('settings.region') }}
        </h3>
        <div class="divide-y divide-outline-variant/20 overflow-hidden rounded-xl border border-outline-variant/20 bg-surface-container-lowest">
          <button
            v-for="r in regions"
            :key="r"
            type="button"
            class="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-container"
            @click="chooseRegion(r)"
          >
            <span class="text-[16px] text-on-surface">{{ $t(`settings.region_${r}`) }}</span>
            <Check
              v-if="state.region === r"
              :size="20"
              :stroke-width="2.4"
              class="shrink-0 text-primary"
              aria-hidden="true"
            />
          </button>
        </div>
      </section>

      <!-- Ngôn ngữ -->
      <section class="flex flex-col gap-2">
        <h3 class="px-2 font-mono text-[12px] uppercase tracking-wider text-on-surface-variant">
          {{ $t('settings.language') }}
        </h3>
        <div class="divide-y divide-outline-variant/20 overflow-hidden rounded-xl border border-outline-variant/20 bg-surface-container-lowest">
          <button
            v-for="l in AVAILABLE_LOCALES"
            :key="l"
            type="button"
            class="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left transition-colors hover:bg-surface-container"
            @click="chooseLanguage(l)"
          >
            <span class="text-[16px] text-on-surface">{{ $t(`settings.language_${l}`) }}</span>
            <Check
              v-if="state.language === l"
              :size="20"
              :stroke-width="2.4"
              class="shrink-0 text-primary"
              aria-hidden="true"
            />
          </button>
        </div>
      </section>

      <!-- Lịch sử đơn (lối tắt) -->
      <section class="flex flex-col gap-2 pb-2">
        <button
          type="button"
          class="flex w-full items-center justify-between gap-3 rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-4 py-3.5 text-left transition-colors hover:bg-surface-container"
          @click="router.push({ name: 'orders' })"
        >
          <span class="text-[16px] text-on-surface">{{ $t('history.title') }}</span>
          <ChevronRight :size="20" :stroke-width="2" class="shrink-0 text-outline" aria-hidden="true" />
        </button>
      </section>
    </main>
  </div>
</template>
