<script setup lang="ts">
/**
 * CheckoutView — xác nhận thanh toán (Obsidian Glass, Req 6.x).
 *
 * Thích ứng màn "Xác nhận thanh toán" của design cho nghiệp vụ thật: thanh toán bằng
 * SỐ DƯ VÍ (không phải MoMo/thẻ). Luồng:
 *  - Nhận `id` (param) + `qty` (query). `GET /product-types/:id` để dựng tóm tắt đơn.
 *  - Hiển thị tóm tắt (tên, emoji, số lượng, đơn giá, tổng) + phương thức "Số dư ví".
 *  - Số dư < tổng → chặn nút + gợi ý "Nạp tiền" (sang DepositView).
 *  - Xác nhận → `POST /api/app/purchase` → cập nhật số dư (Req 6.7) + màn thành công
 *    kèm CredentialBlock (nội dung tài khoản) để copy nhanh.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Wallet, Lock, CircleCheck, TriangleAlert } from '@lucide/vue'
import TopAppBar from '@/components/TopAppBar.vue'
import GlassButton from '@/components/GlassButton.vue'
import CredentialBlock from '@/components/CredentialBlock.vue'
import { get, post, ApiError } from '@/api/client'
import { useUiStore } from '@/stores/ui'
import { useUserStore } from '@/stores/user'
import { showBackButton, type Cleanup } from '@/telegram/sdk'
import { formatMoneyFor } from '@/utils/format'
import { tileGradient } from '@/utils/avatar'
import type { ProductTypeDetailDto, PurchaseResultDto } from '@/types'

const props = defineProps<{ id: string }>()

const router = useRouter()
const ui = useUiStore()
const user = useUserStore()
const { t } = useI18n()

const detail = ref<ProductTypeDetailDto | null>(null)
const result = ref<PurchaseResultDto | null>(null)
const submitting = ref(false)
const imgError = ref(false)

let cleanupBack: Cleanup = () => {}

/** Số lượng từ query (kẹp >= 1, không vượt max). */
const quantity = computed(() => {
  const raw = Number(router.currentRoute.value.query.qty)
  const q = Number.isFinite(raw) && raw >= 1 ? Math.trunc(raw) : 1
  if (!detail.value) return q
  const cap = Math.max(1, Math.min(detail.value.max_quantity, detail.value.stock))
  return Math.min(q, cap)
})

const glyph = computed(() =>
  detail.value ? detail.value.emoji?.trim() || detail.value.name.charAt(0).toUpperCase() : ''
)
const showImage = computed(() => !!detail.value?.image_url && !imgError.value)

const total = computed(() => (detail.value ? detail.value.price * quantity.value : 0))
const totalDisplay = computed(() =>
  formatMoneyFor(total.value, { region: user.state.region, rate: user.state.rate })
)
const insufficient = computed(() => user.state.balance < total.value)

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

async function confirm(): Promise<void> {
  if (!detail.value || submitting.value || result.value || insufficient.value) return
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

async function load(): Promise<void> {
  try {
    detail.value = await ui.withLoading(get<ProductTypeDetailDto>(`/product-types/${props.id}`))
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
    <TopAppBar :title="result ? $t('checkout.success_title') : $t('checkout.title')" back />

    <main
      v-if="detail"
      class="mx-auto w-full max-w-md px-container-margin pb-32 pt-[calc(56px+var(--safe-top))]"
    >
      <!-- ===== Trạng thái thành công ===== -->
      <template v-if="result">
        <div class="mt-6 flex flex-col items-center gap-3 text-center">
          <span
            class="flex h-20 w-20 items-center justify-center rounded-full bg-tertiary-container/20 text-tertiary"
            aria-hidden="true"
          >
            <CircleCheck :size="44" :stroke-width="1.75" />
          </span>
          <h2 class="text-[22px] font-semibold text-on-surface">{{ $t('checkout.success_title') }}</h2>
          <p class="text-[15px] text-on-surface-variant">
            {{ $t('product.success_sub', { quantity: result.quantity, name: detail.name }) }}
          </p>
        </div>

        <div class="mt-6">
          <CredentialBlock :contents="result.contents" />
        </div>

        <div class="mt-4 flex items-center justify-between rounded-xl bg-surface-container-low p-4">
          <span class="text-[15px] text-on-surface-variant">{{ $t('product.remaining_balance') }}</span>
          <span class="text-[18px] font-semibold tabular-nums text-primary">
            {{ result.new_balance_display }}
          </span>
        </div>

        <div class="mt-6 flex flex-col gap-3">
          <GlassButton block @click="router.push({ name: 'orders' })">
            {{ $t('checkout.view_orders') }}
          </GlassButton>
          <GlassButton block variant="ghost" @click="router.push({ name: 'market' })">
            {{ $t('checkout.back_to_market') }}
          </GlassButton>
        </div>
      </template>

      <!-- ===== Trạng thái xác nhận ===== -->
      <template v-else>
        <!-- Tóm tắt đơn -->
        <section class="glass-card mb-stack-lg mt-6 rounded-xl p-stack-md shadow-lg">
          <div class="flex items-start gap-4">
            <div
              class="relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-outline-variant/30 bg-surface-container"
              :style="showImage ? {} : { backgroundImage: tileGradient(detail.id) }"
            >
              <img v-if="showImage" :src="detail.image_url as string" :alt="detail.name" class="h-full w-full object-cover" @error="imgError = true" />
              <span v-else class="text-3xl leading-none" :style="{ color: '#e0e2ed' }" aria-hidden="true">{{ glyph }}</span>
            </div>
            <div class="flex-1">
              <h2 class="mb-1 text-[16px] font-semibold text-on-surface">{{ detail.name }}</h2>
              <p class="mb-2 font-mono text-[12px] text-on-surface-variant">
                {{ $t('checkout.unit_price', { price: detail.price_display }) }}
              </p>
              <div class="mt-2 flex items-center justify-between">
                <span class="font-mono text-[12px] text-outline">
                  {{ $t('checkout.quantity', { count: quantity }) }}
                </span>
              </div>
            </div>
          </div>
          <div class="mt-4 flex items-center justify-between border-t border-outline-variant/20 pt-4">
            <span class="text-[16px] text-on-surface-variant">{{ $t('checkout.total') }}</span>
            <span class="text-[28px] font-semibold text-primary">{{ totalDisplay }}</span>
          </div>
        </section>

        <!-- Phương thức: số dư ví -->
        <section>
          <h3 class="mb-stack-sm ml-1 font-mono text-[12px] uppercase tracking-wider text-on-surface-variant">
            {{ $t('checkout.method_label') }}
          </h3>
          <div
            class="glass-card flex items-center gap-4 rounded-xl border p-4"
            :class="insufficient ? 'border-error/50' : 'border-primary/50'"
          >
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-container/20 text-primary">
              <Wallet :size="22" :stroke-width="2" aria-hidden="true" />
            </div>
            <div class="flex-1">
              <h4 class="text-[16px] text-on-surface">{{ $t('checkout.method_wallet') }}</h4>
              <p class="font-mono text-[12px]" :class="insufficient ? 'text-error' : 'text-on-surface-variant'">
                {{ $t('checkout.balance', { balance: user.state.balanceDisplay }) }}
              </p>
            </div>
          </div>

          <!-- Cảnh báo thiếu số dư + nạp tiền -->
          <div
            v-if="insufficient"
            class="mt-3 flex items-start gap-3 rounded-xl bg-error-container/20 p-4"
          >
            <TriangleAlert :size="20" :stroke-width="2" class="mt-0.5 shrink-0 text-error" aria-hidden="true" />
            <div class="flex-1">
              <p class="text-[15px] text-on-error-container">{{ $t('checkout.insufficient') }}</p>
              <button
                type="button"
                class="mt-2 text-[15px] font-semibold text-primary hover:underline"
                @click="router.push({ name: 'deposit' })"
              >
                {{ $t('checkout.go_deposit') }}
              </button>
            </div>
          </div>
        </section>

        <p class="mt-4 text-center font-mono text-[12px] text-outline">{{ $t('checkout.secure_note') }}</p>
      </template>
    </main>

    <!-- Bottom action: xác nhận thanh toán (đồng nhất style với BottomNav ở Market) -->
    <div
      v-if="detail && !result"
      class="glass-panel fixed bottom-0 left-0 right-0 z-[60] mx-4 rounded-full p-2 shadow-lg"
      :style="{
        bottom: 'calc(16px + var(--safe-bottom))',
        marginLeft: 'calc(16px + var(--safe-left))',
        marginRight: 'calc(16px + var(--safe-right))',
      }"
    >
      <button
        type="button"
        class="btn-gradient btn-press flex h-12 w-full items-center justify-center gap-2 rounded-full px-4 text-[16px] font-semibold text-on-primary shadow-md disabled:opacity-40"
        :disabled="submitting || insufficient"
        @click="confirm"
      >
        <span>{{ $t('checkout.confirm') }}</span>
        <Lock :size="20" :stroke-width="2" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>
