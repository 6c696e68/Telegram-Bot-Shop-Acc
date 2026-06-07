<script setup lang="ts">
/**
 * BalanceHero — khối số dư lớn căn giữa kiểu CryptoBot (Total balance).
 *  - Ưu tiên chuỗi `display` region-aware từ server (render verbatim — R1.1); thiếu thì
 *    fallback `formatCurrency(balance)` theo locale.
 *  - Nhãn phụ phía trên. Slot mặc định bên dưới cho hàng CircleAction.
 *  - Màu phẳng, không gradient.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatCurrency } from '@/utils/format'

const props = withDefaults(
  defineProps<{
    /** Số dư dạng số (đồng) — fallback khi không có `display`. */
    balance?: number
    /** Chuỗi hiển thị region-aware từ server (verbatim). */
    display?: string
    /** Nhãn phụ phía trên số dư; bỏ trống → nhãn mặc định theo locale. */
    label?: string
  }>(),
  { balance: 0, display: '', label: '' }
)

const { t } = useI18n()

const labelText = computed(() => props.label || t('balance.default'))
const text = computed(() =>
  props.display && props.display.length > 0 ? props.display : formatCurrency(props.balance)
)
</script>

<template>
  <div class="flex flex-col items-center gap-4 py-2">
    <div class="flex flex-col items-center gap-1">
      <span class="text-ios-footnote text-hint">{{ labelText }}</span>
      <span class="text-ios-hero tabular-nums text-text">{{ text }}</span>
    </div>
    <div v-if="$slots.default" class="flex items-start justify-center gap-7">
      <slot />
    </div>
  </div>
</template>
