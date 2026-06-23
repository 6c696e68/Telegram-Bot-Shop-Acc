<script setup lang="ts">
/**
 * ProductDetailView — chi tiết loại sản phẩm (Obsidian Glass, Req 5.3, 5.4, 6.1).
 *
 *  - `GET /api/app/product-types/:id` lấy mô tả/giá/tồn kho/`max_quantity`.
 *  - Hero: ô gradient + glyph (backend không có ảnh) + badge "Giao ngay" + giá.
 *  - Bento features từ dữ liệu thật: giao tự động, tồn kho, thanh toán bằng số dư.
 *  - Bottom action bar kính: QtyStepper + nút "Mua ngay" → màn Checkout (truyền quantity).
 *  - Hết hàng → ẩn action bar (Req 5.4). Telegram BackButton + TopAppBar back để quay lại.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { BadgeCheck, Zap, Boxes, Wallet, Info } from '@lucide/vue'
import TopAppBar from '@/components/TopAppBar.vue'
import QtyStepper from '@/components/QtyStepper.vue'
import { get, ApiError } from '@/api/client'
import { useUiStore } from '@/stores/ui'
import { useUserStore } from '@/stores/user'
import { showBackButton, type Cleanup } from '@/telegram/sdk'
import { formatMoneyFor } from '@/utils/format'
import { tileGradient, tileTint } from '@/utils/avatar'
import type { ProductDetailDto } from '@/types'

const props = defineProps<{ id: string }>()

const router = useRouter()
const ui = useUiStore()
const user = useUserStore()
const { t } = useI18n()

const detail = ref<ProductDetailDto | null>(null)
const quantity = ref(1)
const imgError = ref(false)

let cleanupBack: Cleanup = () => {}

const showImage = computed(() => !!detail.value?.image_url && !imgError.value)
const glyph = computed(() =>
  detail.value ? detail.value.emoji?.trim() || detail.value.name.charAt(0).toUpperCase() : ''
)

/** Trần số lượng = min(max_quantity, stock), tối thiểu 1 (Req 6.4). */
const maxQty = computed(() => {
  if (!detail.value) return 1
  return Math.max(1, Math.min(detail.value.max_quantity, detail.value.stock))
})

const total = computed(() => (detail.value ? detail.value.price * quantity.value : 0))
const totalDisplay = computed(() =>
  formatMoneyFor(total.value, { region: user.state.region, rate: user.state.rate })
)

function goCheckout(): void {
  if (!detail.value || !detail.value.in_stock) return
  router.push({ name: 'checkout', params: { id: String(detail.value.id) }, query: { qty: String(quantity.value) } })
}

async function load(): Promise<void> {
  try {
    detail.value = await ui.withLoading(get<ProductDetailDto>(`/product-types/${props.id}`))
    quantity.value = 1
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 401) return
      if (err.status === 404) {
        ui.toast(t('product.not_found'), 'error')
        return
      }
    }
    ui.toast(t('product.load_error'), 'error')
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
    <TopAppBar :title="$t('product.title')" back />

    <main
      v-if="detail"
      class="flex flex-col gap-stack-lg px-gutter pb-28 pt-[calc(48px+var(--safe-top))]"
    >
      <!-- Hero: ảnh thật hoặc fallback gradient + glyph -->
      <section
        class="relative mt-3 aspect-square w-full overflow-hidden rounded-[20px] border border-surface-variant bg-surface-container-low"
      >
        <img
          v-if="showImage"
          :src="detail.image_url as string"
          :alt="detail.name"
          class="h-full w-full object-cover"
          @error="imgError = true"
        />
        <div
          v-else
          class="flex h-full w-full items-center justify-center"
          :style="{ backgroundImage: tileGradient(detail.id) }"
        >
          <span
            class="flex h-24 w-24 items-center justify-center rounded-[24px] text-[52px] leading-none"
            :style="{ backgroundColor: tileTint(detail.id), color: '#e0e2ed' }"
            aria-hidden="true"
          >
            {{ glyph }}
          </span>
        </div>

        <!-- Badge giao ngay -->
        <div
          class="glass-panel absolute right-3 top-3 flex items-center gap-1.5 rounded-full px-2.5 py-1"
        >
          <BadgeCheck :size="14" :stroke-width="2" class="text-tertiary" aria-hidden="true" />
          <span class="font-mono text-[11px] uppercase tracking-wider text-on-surface">
            {{ $t('product.instant_delivery') }}
          </span>
        </div>

        <!-- Giá -->
        <div class="glass-panel absolute bottom-3 left-3 rounded-xl px-3 py-1.5">
          <div class="font-mono text-[11px] uppercase tracking-wider text-on-surface-variant">
            {{ $t('product.price_label') }}
          </div>
          <div class="text-[24px] font-semibold text-primary">{{ detail.price_display }}</div>
        </div>
      </section>

      <!-- Tên + trạng thái + mô tả -->
      <section class="flex flex-col gap-2">
        <div class="flex items-start justify-between gap-3">
          <h2 class="text-[24px] font-bold leading-tight text-on-surface">{{ detail.name }}</h2>
          <div
            class="mt-1 flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 font-mono text-[11px] uppercase"
            :class="
              detail.in_stock
                ? 'bg-tertiary-container text-on-tertiary-container'
                : 'bg-error-container text-on-error-container'
            "
          >
            <span
              class="h-1.5 w-1.5 rounded-full"
              :class="detail.in_stock ? 'bg-tertiary-fixed-dim' : 'bg-error'"
              aria-hidden="true"
            />
            {{ detail.in_stock ? $t('product.ready') : $t('product.badge_out_of_stock') }}
          </div>
        </div>
        <p v-if="detail.description" class="text-[15px] leading-relaxed text-on-surface-variant">
          {{ detail.description }}
        </p>
      </section>

      <!-- Bento features (dữ liệu thật) -->
      <section class="grid grid-cols-2 gap-gutter">
        <div class="flex flex-col gap-2 rounded-xl border border-surface-variant bg-surface-container-lowest p-3">
          <div class="flex h-8 w-8 items-center justify-center rounded-full bg-primary-container/20 text-primary">
            <Zap :size="18" :stroke-width="2" aria-hidden="true" />
          </div>
          <div>
            <div class="font-mono text-[11px] uppercase tracking-wide text-on-surface-variant">
              {{ $t('product.feat_delivery') }}
            </div>
            <div class="text-[15px] font-semibold text-on-surface">{{ $t('product.feat_delivery_value') }}</div>
          </div>
        </div>

        <div class="flex flex-col gap-2 rounded-xl border border-surface-variant bg-surface-container-lowest p-3">
          <div class="flex h-8 w-8 items-center justify-center rounded-full bg-tertiary-container/20 text-tertiary">
            <Boxes :size="18" :stroke-width="2" aria-hidden="true" />
          </div>
          <div>
            <div class="font-mono text-[11px] uppercase tracking-wide text-on-surface-variant">
              {{ $t('product.feat_stock') }}
            </div>
            <div
              class="text-[15px] font-semibold"
              :class="detail.in_stock ? 'text-on-surface' : 'text-error'"
            >
              {{ detail.in_stock ? $t('product.in_stock', { count: detail.stock }) : $t('product.out_of_stock') }}
            </div>
          </div>
        </div>

        <div
          class="col-span-2 flex flex-col gap-2 rounded-xl border border-surface-variant bg-surface-container-lowest p-3"
        >
          <div class="flex h-8 w-8 items-center justify-center rounded-full bg-secondary-container/20 text-secondary">
            <Wallet :size="18" :stroke-width="2" aria-hidden="true" />
          </div>
          <div>
            <div class="font-mono text-[11px] uppercase tracking-wide text-on-surface-variant">
              {{ $t('product.feat_payment') }}
            </div>
            <div class="text-[15px] font-semibold text-on-surface">{{ $t('product.feat_payment_value') }}</div>
          </div>
        </div>
      </section>

      <!-- Lưu ý -->
      <section class="flex items-start gap-3 rounded-xl bg-surface-container-low p-3">
        <Info :size="20" :stroke-width="2" class="mt-0.5 shrink-0 text-outline" aria-hidden="true" />
        <p class="text-[15px] leading-relaxed text-on-surface-variant">{{ $t('product.notice') }}</p>
      </section>
    </main>

    <!-- Bottom action bar: số lượng + mua ngay (đồng nhất style với BottomNav ở Market) -->
    <div
      v-if="detail && detail.in_stock"
      class="glass-panel fixed bottom-0 left-0 right-0 z-[60] mx-3 flex items-center gap-2 rounded-full p-2 shadow-lg"
      :style="{
        bottom: 'calc(12px + var(--safe-bottom))',
        marginLeft: 'calc(12px + var(--safe-left))',
        marginRight: 'calc(12px + var(--safe-right))',
      }"
    >
      <QtyStepper v-model:quantity="quantity" :min="1" :max="maxQty" />
      <button
        type="button"
        class="btn-gradient btn-press flex h-11 flex-1 items-center justify-center gap-2 rounded-full px-4 text-[15px] font-semibold text-on-primary shadow-md"
        @click="goCheckout"
      >
        <Zap :size="18" :stroke-width="2.2" aria-hidden="true" />
        {{ $t('product.buy_now') }}
        <span class="ml-1 tabular-nums opacity-90">· {{ totalDisplay }}</span>
      </button>
    </div>
  </div>
</template>
