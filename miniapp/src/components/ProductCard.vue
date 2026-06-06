<script setup lang="ts">
/**
 * ProductCard — một loại sản phẩm trong danh mục (Req 5.1, 5.2, 5.4).
 *  - hiển thị emoji, tên, giá (đã format) và tồn kho.
 *  - khi hết hàng (!inStock): hiển thị nhãn "Hết hàng" + vô hiệu hoá bấm (Req 5.4).
 *  - phát haptic('light') + emit('click') khi còn hàng; màu phẳng, không chuyển-màu-nền.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { haptic } from '@/telegram/sdk'
import { formatCurrency } from '@/utils/format'

const props = withDefaults(
  defineProps<{
    /** Tên loại sản phẩm. */
    name: string
    /** Emoji minh hoạ. */
    emoji?: string
    /** Giá dạng số (đồng) — format CLIENT-SIDE theo locale user (R4.6). */
    price: number
    /** Số lượng còn lại (products status='available'). */
    stock?: number
    /** Còn hàng hay không (stock > 0). */
    inStock?: boolean
  }>(),
  { emoji: '', stock: 0, inStock: true }
)

const emit = defineEmits<{ (e: 'click'): void }>()

const { t } = useI18n()

/** Giá hiển thị, format theo LOCALE hiện tại của user (R4.6). */
const priceText = computed(() => formatCurrency(props.price))

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
    class="glass tap-target flex w-full items-center gap-3 p-4 text-left transition-transform duration-ios ease-ios active:scale-[0.98] disabled:opacity-50"
    @click="onClick"
  >
    <span class="text-3xl leading-none" aria-hidden="true">{{ emoji }}</span>
    <span class="flex min-w-0 flex-1 flex-col">
      <span class="truncate text-ios-headline text-text">{{ name }}</span>
      <span class="text-ios-body tabular-nums text-accent">{{ priceText }}</span>
    </span>
    <span
      class="shrink-0 text-ios-footnote"
      :class="inStock ? 'text-hint' : 'text-ios-red'"
    >
      {{ stockText }}
    </span>
  </button>
</template>
