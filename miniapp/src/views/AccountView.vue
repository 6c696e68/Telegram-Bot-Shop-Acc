<script setup lang="ts">
/**
 * AccountView — "Cá nhân", tab cấp 1 (Req 12, R5.2, R6.2).
 *
 *  - Thông tin định danh (ID Telegram / Username / Tên) — chỉ đọc, KHÔNG admin (Req 12.3).
 *  - Cài đặt vùng (R5.2) + ngôn ngữ (R6.2) inline: chọn → lưu qua store, cập nhật locale
 *    reactive không reload (R17.4). Region và language độc lập.
 *  - Là route cấp 1 (tab) nên KHÔNG dùng Telegram BackButton. Màu phẳng, không gradient.
 */
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check } from '@lucide/vue'
import ListSection from '@/components/ListSection.vue'
import ListRow from '@/components/ListRow.vue'
import BalanceHero from '@/components/BalanceHero.vue'
import { useUserStore } from '@/stores/user'
import { useUiStore } from '@/stores/ui'
import { ApiError } from '@/api/client'
import { AVAILABLE_LOCALES } from '@/i18n'

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
  <main class="flex flex-col gap-6 px-4 pb-2 pt-6">
    <header class="px-1">
      <h1 class="text-ios-large-title text-text">{{ $t('account.title') }}</h1>
    </header>

    <!-- Số dư -->
    <BalanceHero :balance="state.balance" :display="state.balanceDisplay" />

    <!-- Thông tin định danh (Req 12.2) -->
    <ListSection :title="$t('account.identity')">
      <ListRow
        v-for="row in identityRows"
        :key="row.key"
        :title="row.label"
      >
        <template #trailing>
          <span class="text-right text-ios-body text-hint" :class="row.mono ? 'tabular-nums' : ''">
            {{ row.value }}
          </span>
        </template>
      </ListRow>
    </ListSection>

    <!-- Khu vực (R5.2) -->
    <ListSection :title="$t('settings.region')">
      <ListRow
        v-for="r in regions"
        :key="r"
        clickable
        :chevron="false"
        :title="$t(`settings.region_${r}`)"
        @click="chooseRegion(r)"
      >
        <template #trailing>
          <Check
            v-if="state.region === r"
            :size="20"
            :stroke-width="2.25"
            class="shrink-0 text-accent"
            aria-hidden="true"
          />
        </template>
      </ListRow>
    </ListSection>

    <!-- Ngôn ngữ (R6.2) -->
    <ListSection :title="$t('settings.language')">
      <ListRow
        v-for="l in AVAILABLE_LOCALES"
        :key="l"
        clickable
        :chevron="false"
        :title="$t(`settings.language_${l}`)"
        @click="chooseLanguage(l)"
      >
        <template #trailing>
          <Check
            v-if="state.language === l"
            :size="20"
            :stroke-width="2.25"
            class="shrink-0 text-accent"
            aria-hidden="true"
          />
        </template>
      </ListRow>
    </ListSection>
  </main>
</template>
