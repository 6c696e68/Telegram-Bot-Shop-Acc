<script setup lang="ts">
/**
 * SettingsView — đổi vùng + ngôn ngữ sau onboarding (R5.2, R6.2).
 *
 * Đổi vùng → `POST /api/app/region` (store.setRegion); đổi ngôn ngữ → `PUT /api/app/language`
 * (store.setLanguage) cập nhật locale reactive không reload (R17.4). Region và language
 * độc lập (R6): đổi ngôn ngữ KHÔNG đổi vùng.
 */
import { onMounted, onUnmounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import GlassCard from '@/components/GlassCard.vue'
import { useUserStore } from '@/stores/user'
import { useUiStore } from '@/stores/ui'
import { ApiError } from '@/api/client'
import { showBackButton, type Cleanup } from '@/telegram/sdk'
import { AVAILABLE_LOCALES } from '@/i18n'

const router = useRouter()
const user = useUserStore()
const ui = useUiStore()
const { t } = useI18n()

const state = user.state
const regions = ['vietnam', 'international'] as const

let cleanupBack: Cleanup = () => {}

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

onMounted(() => {
  cleanupBack = showBackButton(() => router.back())
})
onUnmounted(() => cleanupBack())
</script>

<template>
  <main class="flex flex-col gap-5 px-4 py-6">
    <header class="flex flex-col gap-1">
      <h1 class="text-ios-title text-text">{{ $t('settings.title') }}</h1>
    </header>

    <section class="flex flex-col gap-2" aria-label="region">
      <h2 class="px-1 text-ios-footnote text-hint">{{ $t('settings.region') }}</h2>
      <GlassCard>
        <div class="flex flex-col gap-2">
          <button
            v-for="r in regions"
            :key="r"
            type="button"
            class="tap-target flex items-center justify-between rounded-ios px-4 py-3 text-ios-body"
            :class="state.region === r ? 'bg-accent text-accent-text' : 'text-text'"
            :aria-pressed="state.region === r"
            @click="chooseRegion(r)"
          >
            <span>{{ $t(`settings.region_${r}`) }}</span>
          </button>
        </div>
      </GlassCard>
    </section>

    <section class="flex flex-col gap-2" aria-label="language">
      <h2 class="px-1 text-ios-footnote text-hint">{{ $t('settings.language') }}</h2>
      <GlassCard>
        <div class="flex flex-col gap-2">
          <button
            v-for="l in AVAILABLE_LOCALES"
            :key="l"
            type="button"
            class="tap-target flex items-center justify-between rounded-ios px-4 py-3 text-ios-body"
            :class="state.language === l ? 'bg-accent text-accent-text' : 'text-text'"
            :aria-pressed="state.language === l"
            @click="chooseLanguage(l)"
          >
            <span>{{ $t(`settings.language_${l}`) }}</span>
          </button>
        </div>
      </GlassCard>
    </section>
  </main>
</template>
