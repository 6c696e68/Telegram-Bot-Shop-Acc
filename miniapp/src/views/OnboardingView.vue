<script setup lang="ts">
/**
 * OnboardingView — chọn vùng lần đầu (Obsidian Glass, R2.1–2.5).
 *
 * Hiển thị khi `region` chưa xác định. Chọn vùng → `POST /api/app/region` (qua store) →
 * điều hướng về Market. Giao diện Default_Language tới khi region/language xác định.
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Store } from '@lucide/vue'
import GlassButton from '@/components/GlassButton.vue'
import { useUserStore } from '@/stores/user'
import { useUiStore } from '@/stores/ui'
import { ApiError } from '@/api/client'

const router = useRouter()
const user = useUserStore()
const ui = useUiStore()
const { t } = useI18n()

const submitting = ref(false)

async function choose(region: 'vietnam' | 'international'): Promise<void> {
  if (submitting.value) return
  submitting.value = true
  ui.haptic('light')
  try {
    await ui.withLoading(user.setRegion(region))
    ui.haptic('success')
    router.replace({ name: 'market' })
  } catch (err) {
    ui.haptic('error')
    if (err instanceof ApiError && err.status === 401) return
    ui.toast(t('common.error'), 'error')
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <main
    class="flex min-h-screen flex-col justify-center gap-6 px-container-margin py-10"
    :style="{ paddingTop: 'calc(32px + var(--safe-top))', paddingBottom: 'calc(32px + var(--safe-bottom))' }"
  >
    <header class="flex flex-col items-center gap-3 text-center">
      <span
        class="flex h-16 w-16 items-center justify-center rounded-[20px] bg-primary-container/20 text-primary"
        aria-hidden="true"
      >
        <Store :size="32" :stroke-width="2" />
      </span>
      <h1 class="text-[24px] font-bold text-on-surface">{{ $t('onboarding.title') }}</h1>
      <p class="max-w-xs text-[15px] text-on-surface-variant">{{ $t('onboarding.subtitle') }}</p>
    </header>

    <div class="glass-card flex flex-col gap-3 rounded-2xl p-4">
      <GlassButton block :disabled="submitting" @click="choose('vietnam')">
        {{ $t('onboarding.region_vietnam') }}
      </GlassButton>
      <GlassButton block variant="secondary" :disabled="submitting" @click="choose('international')">
        {{ $t('onboarding.region_international') }}
      </GlassButton>
    </div>
  </main>
</template>
