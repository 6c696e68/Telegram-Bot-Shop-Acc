<script setup lang="ts">
/**
 * BalanceBadge — hiển thị số dư nổi bật trong lớp kính (Req 4.1, 4.2, 12.1).
 *  - Tiền luôn format CLIENT-SIDE từ `balance` (number) qua `formatCurrency` theo
 *    LOCALE hiện tại của user (R4.6). KHÔNG dùng chuỗi `*_display` của server nữa.
 *  - prop `display` giữ optional để không vỡ nơi truyền, nhưng KHÔNG còn được dùng.
 *  - màu phẳng + `.glass`, không chuyển-màu-nền.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatCurrency } from '@/utils/format'

const props = withDefaults(
  defineProps<{
    /** Số dư dạng số (đơn vị đồng). Nguồn duy nhất để format hiển thị. */
    balance?: number
    /** @deprecated KHÔNG dùng — giữ optional để không vỡ nơi truyền (R4.6). */
    display?: string
    /** Nhãn phụ phía trên số dư. Bỏ trống → dùng nhãn mặc định theo locale. */
    label?: string
  }>(),
  { balance: 0, display: '', label: '' }
)

const { t } = useI18n()

/** Nhãn hiển thị: ưu tiên prop `label`, fallback nhãn mặc định theo locale (R17). */
const labelText = computed(() => props.label || t('balance.default'))

/**
 * Tiền luôn format CLIENT-SIDE từ `balance` theo LOCALE hiện tại của user (R4.6).
 * `formatCurrency` đọc `i18n.global.locale.value` nên reactive khi đổi ngôn ngữ.
 */
const text = computed(() => formatCurrency(props.balance))
</script>

<template>
  <div class="glass flex flex-col gap-1 p-5">
    <span class="text-ios-footnote text-hint">{{ labelText }}</span>
    <span class="text-ios-large-title tabular-nums text-text">{{ text }}</span>
  </div>
</template>
