<script setup lang="ts">
/**
 * ProductDetailView — chi tiết loại sản phẩm + mua hàng (Req 5.3, 5.4, 6.1, 6.6, 6.7).
 *
 *  - Nhận prop `id` (chuỗi, từ route `product-detail` với `props: true`).
 *  - Khi mở: `GET /api/app/product-types/:id` lấy mô tả, giá, tồn kho, `max_quantity`;
 *    hiển thị emoji/tên/mô tả/giá/tồn kho (Req 5.3).
 *  - `QtyStepper` chọn số lượng trong `[1, min(max_quantity, stock)]`; tổng tiền =
 *    giá × số lượng, format qua `formatCurrency` (Req 6.1).
 *  - Dùng MainButton "Xác nhận mua" của Telegram để gửi `POST /api/app/purchase`. Khi
 *    thành công: haptic('success'), cập nhật số dư store (`setBalance`), hiển thị nội
 *    dung tài khoản đã mua + số dư mới ngay trong app (Req 6.6, 6.7) và ẩn MainButton để
 *    tránh mua lại.
 *  - Lỗi nghiệp vụ (409 `insufficient_balance`/`insufficient_stock`, 400 validate, 429
 *    rate limit) → toast + haptic('error'); giữ nguyên trạng thái để người dùng thử lại.
 *  - Hết hàng (`in_stock = false`) → KHÔNG hiển thị MainButton, chặn mua (Req 5.4).
 *  - BackButton của Telegram để quay lại danh mục; cả MainButton/BackButton đều được gỡ
 *    qua hàm cleanup trong `onUnmounted` (Req 13.5).
 *
 * Bố cục mobile-first iOS HIG, chỉ dùng màu phẳng + lớp `.glass` — KHÔNG gradient (Req 13).
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
import { formatCurrency } from '@/utils/format'
import type { ProductTypeDetailDto, PurchaseResultDto } from '@/types'

const props = defineProps<{
  /** Id loại sản phẩm (chuỗi từ route param). */
  id: string
}>()

const router = useRouter()
const ui = useUiStore()
const user = useUserStore()
const { t } = useI18n()

/** Chi tiết loại sản phẩm; `null` cho tới khi tải xong. */
const detail = ref<ProductTypeDetailDto | null>(null)
/** Số lượng người mua chọn (số nguyên, kẹp trong [1, maxQty] bởi QtyStepper). */
const quantity = ref(1)
/** Kết quả mua thành công — khi có giá trị, hiển thị contents + số dư mới (Req 6.6, 6.7). */
const result = ref<PurchaseResultDto | null>(null)
/** Cờ chống double-submit khi đang gửi yêu cầu mua. */
const submitting = ref(false)

/** Dọn dẹp các nút Telegram (gỡ handler + ẩn) khi rời màn hình / khi cần ẩn MainButton. */
let cleanupBack: Cleanup = () => {}
let cleanupMain: Cleanup = () => {}

/**
 * Trần số lượng cho mỗi lần mua = min(max_quantity, stock), tối thiểu 1.
 * Không vượt tồn kho thực tế để tránh chắc chắn thất bại phía server (Req 6.4).
 */
const maxQty = computed(() => {
  if (!detail.value) return 1
  return Math.max(1, Math.min(detail.value.max_quantity, detail.value.stock))
})

/** Tổng tiền = giá × số lượng (Req 6.1). */
const total = computed(() => (detail.value ? detail.value.price * quantity.value : 0))
/** Tổng tiền đã định dạng tiền tệ thống nhất với hệ thống. */
const totalDisplay = computed(() => formatCurrency(total.value))

/** Map mã lỗi nghiệp vụ của server sang thông báo cho người mua (theo locale). */
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

/**
 * Gửi yêu cầu mua hàng (Req 6). Tổng tiền do server tính lại từ `productTypeId`/`quantity`
 * (không tin client). Thành công → cập nhật số dư + hiển thị contents; thất bại → toast.
 */
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
    ui.haptic('success') // Req 13.5
    ui.toast(t('product.bought_ok'), 'success')
    // Ẩn MainButton sau khi mua để tránh mua lại trên màn kết quả.
    cleanupMain()
    cleanupMain = () => {}
  } catch (err) {
    ui.haptic('error')
    if (err instanceof ApiError) {
      if (err.status === 401) return // client đã xử lý màn "Mở lại từ Telegram"
      ui.toast(purchaseErrorMessage(err.error), 'error')
    } else {
      ui.toast(t('product.err_generic'), 'error')
    }
  } finally {
    submitting.value = false
  }
}

/**
 * Hiển thị MainButton "Xác nhận mua" khi còn hàng và chưa mua xong.
 * Handler đọc `detail`/`quantity` tại thời điểm bấm nên luôn dùng số lượng hiện tại.
 * Hết hàng (Req 5.4) hoặc đã mua → không hiển thị nút.
 */
function setupMainButton(): void {
  cleanupMain()
  cleanupMain = () => {}
  if (!detail.value || !detail.value.in_stock || result.value) return
  cleanupMain = showMainButton(t('product.confirm_buy'), () => {
    void submitPurchase()
  })
}

/** Nạp chi tiết loại sản phẩm; 404 → toast riêng, 401 do client xử lý, lỗi khác → toast. */
async function load(): Promise<void> {
  try {
    detail.value = await ui.withLoading(
      get<ProductTypeDetailDto>(`/product-types/${props.id}`)
    )
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
      <!-- Emoji + tên + giá (Req 5.3) -->
      <header class="flex flex-col items-center gap-2 text-center">
        <span class="text-6xl leading-none" aria-hidden="true">{{ detail.emoji }}</span>
        <h1 class="text-ios-title text-text">{{ detail.name }}</h1>
        <p class="text-ios-title tabular-nums text-accent">{{ formatCurrency(detail.price) }}</p>
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
        <div class="flex items-center justify-between px-1">
          <span class="text-ios-headline text-text">{{ $t('product.quantity') }}</span>
          <QtyStepper v-model:quantity="quantity" :min="1" :max="maxQty" />
        </div>
        <div class="glass flex items-center justify-between p-4">
          <span class="text-ios-headline text-text">{{ $t('product.total') }}</span>
          <span class="text-ios-title tabular-nums text-accent">{{ totalDisplay }}</span>
        </div>
      </section>

      <!-- Hết hàng: chặn mua (Req 5.4) -->
      <GlassCard v-else-if="!detail.in_stock && !result">
        <p class="text-center text-ios-body text-ios-red">
          {{ $t('product.sold_out_block') }}
        </p>
      </GlassCard>

      <!-- Sau khi mua thành công: nội dung tài khoản + số dư mới (Req 6.6, 6.7) -->
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
            class="glass select-all whitespace-pre-wrap break-all p-4 text-ios-body text-text"
          >
            {{ content }}
          </p>
        </div>

        <BalanceBadge
          :balance="result.new_balance"
          :label="$t('product.remaining_balance')"
        />
      </section>
    </template>
  </main>
</template>
