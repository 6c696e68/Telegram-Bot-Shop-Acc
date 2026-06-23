<script setup lang="ts">
/**
 * SupportView — "Support", tab cấp 1 (Obsidian Glass).
 *
 *  - Thẻ trạng thái đội ngũ hỗ trợ + hành động liên hệ.
 *  - FAQ accordion (nội dung tĩnh qua i18n: support.faq.q1..q4 / a1..a4).
 *  Backend không cấu hình handle hỗ trợ ở frontend nên nút liên hệ hướng người dùng nhắn
 *  trực tiếp cho bot (toast gợi ý) thay vì mở link cứng.
 */
import { useI18n } from 'vue-i18n'
import { Headset, MessageCircle } from '@lucide/vue'
import TopAppBar from '@/components/TopAppBar.vue'
import FaqItem from '@/components/FaqItem.vue'
import { useUiStore } from '@/stores/ui'

const ui = useUiStore()
const { t } = useI18n()

const faqs = [1, 2, 3, 4].map((n) => ({
  q: t(`support.faq.q${n}`),
  a: t(`support.faq.a${n}`),
}))

function contact(): void {
  ui.haptic('light')
  ui.toast(t('support.contact_hint'), 'info', 4000)
}
</script>

<template>
  <div>
    <TopAppBar :title="$t('app.store_name')" />

    <main
      class="mx-auto flex max-w-2xl flex-col gap-stack-lg px-container-margin pt-[calc(48px+var(--safe-top))]"
    >
      <!-- Tiêu đề -->
      <section class="py-3 text-center">
        <h2 class="mb-1.5 text-[24px] font-bold text-primary">{{ $t('support.title') }}</h2>
        <p class="text-[15px] text-on-surface-variant">{{ $t('support.subtitle') }}</p>
      </section>

      <!-- Thẻ trạng thái -->
      <section>
        <div class="glass-card flex flex-col items-center rounded-xl p-4 text-center shadow-sm">
          <div class="relative mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-tertiary-container/10">
            <Headset :size="26" :stroke-width="2" class="text-tertiary" aria-hidden="true" />
            <span class="absolute bottom-1 right-1 h-3.5 w-3.5 rounded-full border-2 border-surface bg-tertiary" aria-hidden="true" />
          </div>
          <h3 class="mb-1 text-[18px] font-semibold text-on-surface">{{ $t('support.online_title') }}</h3>
          <p class="mb-4 text-[15px] text-on-surface-variant">{{ $t('support.online_desc') }}</p>
          <button
            type="button"
            class="btn-press flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 text-on-primary transition-opacity hover:opacity-90"
            @click="contact"
          >
            <MessageCircle :size="18" :stroke-width="2" aria-hidden="true" />
            <span class="font-mono text-[11px] uppercase tracking-wider">{{ $t('support.contact') }}</span>
          </button>
        </div>
      </section>

      <!-- FAQ -->
      <section class="flex flex-col gap-stack-md">
        <h3 class="mb-1 px-2 text-[18px] font-semibold text-on-surface">{{ $t('support.faq_title') }}</h3>
        <div class="glass-card divide-y divide-outline-variant/20 overflow-hidden rounded-xl shadow-sm">
          <FaqItem v-for="(faq, idx) in faqs" :key="idx" :question="faq.q" :answer="faq.a" />
        </div>
      </section>
    </main>
  </div>
</template>
