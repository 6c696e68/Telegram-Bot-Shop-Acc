<script setup lang="ts">
/**
 * ProductCard — một loại sản phẩm dạng row CryptoBot (Req 5.1, 5.2, 5.4).
 *  - avatar tròn (emoji) trái | tên + giá (accent) | tồn kho/`Hết hàng` phải + chevron.
 *  - hết hàng (!inStock) → nhãn đỏ + disable bấm (Req 5.4).
 *  - haptic('light') + emit('click') khi còn hàng. Màu phẳng, không gradient.
 *  - Giữ nguyên props/emit để không vỡ ShopView/HomeView. Dùng trong ListSection (tự kẻ
 *    separator giữa các row).
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight } from '@lucide/vue'
import { haptic } from '@/telegram/sdk'
import { formatCurrency } from '@/utils/format'

const props = withDefaults(
  defineProps<{
    /** Tên loại sản phẩm. */
    name: string
    /** Emoji minh hoạ (dữ liệu admin). */
    emoji?: string
    /** Giá dạng số (đồng) — fallback khi không có `priceDisplay`. */
    price: number
    /** Chuỗi giá region-aware từ server; có giá trị → render verbatim (R1.1). */
    priceDisplay?: string
    /** Số lượng còn lại. */
    stock?: number
    /** Còn hàng hay không. */
    inStock?: boolean
  }>(),
  { emoji: '', stock: 0, inStock: true }
)

const emit = defineEmits<{ (e: 'click'): void }>()

const { t } = useI18n()

const priceText = computed(() =>
  props.priceDisplay && props.priceDisplay.length > 0 ? props.priceDisplay : formatCurrency(props.price)
)

const stockText = computed(() =>
  props.inStock ? t('product.in_stock', { count: props.stock }) : t('product.out_of_stock')
)

function onClick(): void {
  if (!props.inStock) return // Req 5.4 — chặn mua khi hết hàng
  haptic('light')
  emit('click')
}
</script>

<template>
  <button
    type="button"
    :disabled="!inStock"
    class="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors active:bg-app disabled:opacity-50 tap-target"
    @click="onClick"
  >
    <span
      class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-2xl leading-none"
      aria-hidden="true"
    >
      {{ emoji }}
    </span>

    <span class="flex min-w-0 flex-1 flex-col">
      <span class="truncate text-ios-headline text-text">{{ name }}</span>
      <span class="text-ios-footnote tabular-nums text-accent">{{ priceText }}</span>
    </span>

    <span
      class="shrink-0 text-ios-footnote"
      :class="inStock ? 'text-hint' : 'text-ios-red'"
    >
      {{ stockText }}
    </span>
    <ChevronRight
      v-if="inStock"
      :size="18"
      :stroke-width="2"
      class="shrink-0 text-hint"
      aria-hidden="true"
    />
  </button>
</template>
