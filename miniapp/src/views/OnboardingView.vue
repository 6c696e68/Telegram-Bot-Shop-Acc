<script setup lang="ts">
/**
 * OnboardingView — chọn vùng lần đầu (R2.1–2.5).
 *
 * Hiển thị khi `region` của user chưa xác định. Chọn vùng → `POST /api/app/region`
 * (qua store `setRegion`) → điều hướng về trang chủ. Giao diện bằng Default_Language
 * cho tới khi region/language được xác định (R2.2); chuỗi qua vue-i18n.
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import GlassCard from '@/components/GlassCard.vue'
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
    router.replace({ name: 'home' })
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
  <main class="flex min-h-[80vh] flex-col justify-center gap-6 px-4 py-6">
    <header class="flex flex-col gap-2 text-center">
      <h1 class="text-ios-title text-text">{{ $t('onboarding.title') }}</h1>
      <p class="text-ios-footnote text-hint">{{ $t('onboarding.subtitle') }}</p>
    </header>

    <GlassCard>
      <div class="flex flex-col gap-3">
        <GlassButton block :disabled="submitting" @click="choose('vietnam')">
          {{ $t('onboarding.region_vietnam') }}
        </GlassButton>
        <GlassButton block variant="secondary" :disabled="submitting" @click="choose('international')">
          {{ $t('onboarding.region_international') }}
        </GlassButton>
      </div>
    </GlassCard>
  </main>
</template>
