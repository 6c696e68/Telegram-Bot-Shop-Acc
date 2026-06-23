<script setup lang="ts">
/**
 * OrderDetailView — chi tiết một đơn + nội dung tài khoản (Obsidian Glass, Req 11.3, 15.3).
 *
 *  - Nhận prop `id`. `GET /api/app/orders/:id` (server guard owner — 404 nếu không thuộc).
 *  - Tóm tắt đơn (glyph, tên, tổng, trạng thái, thời gian) + CredentialBlock để copy nhanh.
 *  - Telegram BackButton + TopAppBar back để quay lại danh sách.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { CircleCheck, Undo2 } from '@lucide/vue'
import TopAppBar from '@/components/TopAppBar.vue'
import CredentialBlock from '@/components/CredentialBlock.vue'
import { avatarColor } from '@/utils/avatar'
import { get, ApiError } from '@/api/client'
import { useUiStore } from '@/stores/ui'
import { showBackButton, type Cleanup } from '@/telegram/sdk'
import type { OrderDetailDto } from '@/types'

const props = defineProps<{ id: string }>()

const router = useRouter()
const ui = useUiStore()
const { t } = useI18n()

const order = ref<OrderDetailDto | null>(null)
let cleanupBack: Cleanup = () => {}

const tileColor = computed(() => (order.value ? avatarColor(order.value.id) : '#adc6ff'))
const glyph = computed(() =>
  order.value ? order.value.emoji?.trim() || order.value.product_name.charAt(0).toUpperCase() : ''
)
const completed = computed(() => order.value?.status === 'completed')

async function load(): Promise<void> {
  try {
    order.value = await ui.withLoading(get<OrderDetailDto>(`/orders/${props.id}`))
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 401) return
      if (err.status === 404) {
        ui.toast(t('order.not_found'), 'error')
        return
      }
    }
    ui.toast(t('order.load_error'), 'error')
  }
}

onMounted(() => {
  cleanupBack = showBackButton(() => router.back())
  void load()
})

onUnmounted(() => {
  cleanupBack()
})
</script>

<template>
  <div>
    <TopAppBar :title="$t('order.title')" back />

    <main
      v-if="order"
      class="mx-auto flex w-full max-w-md flex-col gap-stack-lg px-gutter pb-10 pt-[calc(48px+var(--safe-top))]"
    >
      <!-- Tóm tắt -->
      <header class="mt-3 flex flex-col items-center gap-3 text-center">
        <span
          class="flex h-16 w-16 items-center justify-center rounded-2xl text-3xl leading-none"
          :style="{ backgroundColor: `${tileColor}1a`, color: tileColor }"
          aria-hidden="true"
        >
          {{ glyph }}
        </span>
        <h1 class="text-[20px] font-semibold text-on-surface">{{ order.product_name }}</h1>
        <p class="text-[28px] font-bold tabular-nums text-primary">{{ order.total_display }}</p>
        <div
          class="flex items-center gap-1 rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-wider"
          :class="completed ? 'bg-tertiary-container/30 text-tertiary' : 'bg-surface-container-highest text-on-surface-variant'"
        >
          <component :is="completed ? CircleCheck : Undo2" :size="12" :stroke-width="2.5" aria-hidden="true" />
          {{ $t(`status.${order.status}`) }}
        </div>
      </header>

      <!-- Meta -->
      <section class="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-3">
        <dl class="flex flex-col gap-2.5 text-[14px]">
          <div class="flex items-center justify-between">
            <dt class="text-on-surface-variant">{{ $t('order.quantity') }}</dt>
            <dd class="tabular-nums text-on-surface">{{ order.quantity }}</dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-on-surface-variant">{{ $t('order.order_id') }}</dt>
            <dd class="font-mono tabular-nums text-on-surface">#{{ order.id }}</dd>
          </div>
          <div class="flex items-center justify-between">
            <dt class="text-on-surface-variant">{{ $t('order.time') }}</dt>
            <dd class="tabular-nums text-on-surface">{{ $d(new Date(order.created_at), 'short') }}</dd>
          </div>
        </dl>
      </section>

      <!-- Nội dung tài khoản -->
      <section v-if="order.contents.length">
        <CredentialBlock :contents="order.contents" />
      </section>
    </main>
  </div>
</template>
