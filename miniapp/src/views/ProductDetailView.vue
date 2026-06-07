<script setup lang="ts">
/**
 * ProductDetailView — chi tiết loại sản phẩm + mua hàng (Req 5.3, 5.4, 6.1, 6.6, 6.7).
 *
 *  - Nhận prop `id` (chuỗi, route `product-detail`).
 *  - `GET /api/app/product-types/:id` lấy mô tả/giá/tồn kho/`max_quantity` (Req 5.3).
 *  - `QtyStepper` chọn số lượng [1, min(max_quantity, stock)]; tổng = giá × số lượng,
 *    format region-aware (Req 6.1).
 *  - Telegram MainButton "Xác nhận mua" → `POST /api/app/purchase`. Thành công:
 *    haptic('success'), cập nhật số dư, hiện contents + số dư mới, ẩn MainButton (Req 6.6/6.7).
 *  - Lỗi nghiệp vụ → toast + haptic('error'). Hết hàng → KHÔNG hiện MainButton (Req 5.4).
 *  - Telegram BackButton để quay lại danh mục. Màu phẳng, không gradient.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import GlassCard from '@/components/GlassCard.vue'
import QtyStepper from '@/components/QtyStepper.vue'
import BalanceBadge from '@/components/BalanceBadge.vue'
import { CircleCheck } from '@lucide/vue'
import { get, post, ApiError } from '@/api/client'
import { useUiStore } from '@/stores/ui'
import { useUserStore } from '@/stores/user'
import { showMainButton, showBackButton, type Cleanup } from '@/telegram/sdk'
import { formatMoneyFor } from '@/utils/format'
import type { ProductTypeDetailDto, PurchaseResultDto } from '@/types'

const props = defineProps<{ id: string }>()

const router = useRouter()
const ui = useUiStore()
const user = useUserStore()
const { t } = useI18n()

const detail = ref<ProductTypeDetailDto | null>(null)
const quantity = ref(1)
const result = ref<PurchaseResultDto | null>(null)
const submitting = ref(false)

let cleanupBack: Cleanup = () => {}
let cleanupMain: Cleanup = () => {}

/** Trần số lượng = min(max_quantity, stock), tối thiểu 1 (Req 6.4). */
const maxQty = computed(() => {
  if (!detail.value) return 1
  return Math.max(1, Math.min(detail.value.max_quantity, detail.value.stock))
})

const total = computed(() => (detail.value ? detail.value.price * quantity.value : 0))
const totalDisplay = computed(() =>
  formatMoneyFor(total.value, { region: user.state.region, rate: user.state.rate })
)

function purchaseErrorMessage(code: string): string {
  switch (code) {
    case 'insufficient_balance':
      return t('product.err_insufficient_balance')
    case 'insufficient_stock':
      return t('product.err_insufficient_stock')
    case 'validation_error':
      return t('product.err_validation')
    case 'not_found':
      return t('product.not_found')
    case 'rate_limited':
      return t('product.err_rate_limited')
    default:
      return t('product.err_generic')
  }
}

async function submitPurchase(): Promise<void> {
  if (!detail.value || submitting.value || result.value) return
  submitting.value = true
  try {
    const res = await ui.withLoading(
      post<PurchaseResultDto>('/purchase', {
        productTypeId: detail.value.id,
        quantity: quantity.value,
      })
    )
    result.value = res
    user.setBalance(res.new_balance, res.new_balance_display) // Req 6.7
    ui.haptic('success')
    ui.toast(t('product.bought_ok'), 'success')
    cleanupMain()
    cleanupMain = () => {}
  } catch (err) {
    ui.haptic('error')
    if (err instanceof ApiError) {
      if (err.status === 401) return
      ui.toast(purchaseErrorMessage(err.error), 'error')
    } else {
      ui.toast(t('product.err_generic'), 'error')
    }
  } finally {
    submitting.value = false
  }
}

function setupMainButton(): void {
  cleanupMain()
  cleanupMain = () => {}
  if (!detail.value || !detail.value.in_stock || result.value) return
  cleanupMain = showMainButton(t('product.confirm_buy'), () => {
    void submitPurchase()
  })
}

async function load(): Promise<void> {
  try {
    detail.value = await ui.withLoading(get<ProductTypeDetailDto>(`/product-types/${props.id}`))
    quantity.value = 1
    setupMainButton()
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
  cleanupMain()
})
</script>

<template>
  <main class="flex flex-col gap-5 px-4 py-6">
    <template v-if="detail">
      <!-- Header: avatar tròn (emoji) + tên + giá (Req 5.3) -->
      <header class="flex flex-col items-center gap-3 text-center">
        <span
          class="flex h-20 w-20 items-center justify-center rounded-full bg-accent-soft text-5xl leading-none"
          aria-hidden="true"
        >
          {{ detail.emoji }}
        </span>
        <h1 class="text-ios-title text-text">{{ detail.name }}</h1>
        <p class="text-ios-large-title tabular-nums text-accent">{{ detail.price_display }}</p>
      </header>

      <!-- Mô tả + tồn kho (Req 5.3, 5.4) -->
      <GlassCard>
        <p v-if="detail.description" class="text-ios-body text-text">
          {{ detail.description }}
        </p>
        <p
          class="text-ios-footnote"
          :class="[detail.description ? 'mt-2' : '', detail.in_stock ? 'text-hint' : 'text-ios-red']"
        >
          {{ detail.in_stock ? $t('product.in_stock', { count: detail.stock }) : $t('product.out_of_stock') }}
        </p>
      </GlassCard>

      <!-- Còn hàng & chưa mua: chọn số lượng + tổng tiền (Req 6.1) -->
      <section
        v-if="detail.in_stock && !result"
        class="flex flex-col gap-3"
        :aria-label="$t('product.quantity')"
      >
        <div class="surface-card flex items-center justify-between p-4">
          <span class="text-ios-headline text-text">{{ $t('product.quantity') }}</span>
          <QtyStepper v-model:quantity="quantity" :min="1" :max="maxQty" />
        </div>
        <div class="surface-card flex items-center justify-between p-4">
          <span class="text-ios-headline text-text">{{ $t('product.total') }}</span>
          <span class="text-ios-title tabular-nums text-accent">{{ totalDisplay }}</span>
        </div>
      </section>

      <!-- Hết hàng: chặn mua (Req 5.4) -->
      <GlassCard v-else-if="!detail.in_stock && !result">
        <p class="text-center text-ios-body text-ios-red">{{ $t('product.sold_out_block') }}</p>
      </GlassCard>

      <!-- Mua thành công: nội dung tài khoản + số dư mới (Req 6.6, 6.7) -->
      <section v-if="result" class="flex flex-col gap-4" :aria-label="$t('product.success_title')">
        <GlassCard>
          <div class="flex flex-col items-center gap-2 text-center">
            <CircleCheck :size="40" :stroke-width="1.75" class="text-ios-green" aria-hidden="true" />
            <h2 class="text-ios-headline text-text">{{ $t('product.success_title') }}</h2>
            <p class="text-ios-footnote text-hint">
              {{ $t('product.success_sub', { quantity: result.quantity, name: detail.name }) }}
            </p>
          </div>
        </GlassCard>

        <div class="flex flex-col gap-2">
          <h3 class="px-1 text-ios-footnote text-hint">{{ $t('product.your_account') }}</h3>
          <p
            v-for="(content, idx) in result.contents"
            :key="idx"
            class="surface-card select-all whitespace-pre-wrap break-all p-4 text-ios-body text-text"
          >
            {{ content }}
          </p>
        </div>

        <BalanceBadge
          :balance="result.new_balance"
          :display="result.new_balance_display"
          :label="$t('product.remaining_balance')"
        />
      </section>
    </template>
  </main>
</template>
