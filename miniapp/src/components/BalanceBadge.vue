<script setup lang="ts">
/**
 * BalanceBadge — hiển thị số dư nổi bật trong lớp kính (Req 4.1, 4.2, 12.1).
 *  - Khi có prop `display` (chuỗi `*_display` đã format region-aware từ server) thì render
 *    VERBATIM để USD/VNĐ khớp đúng vùng người dùng (R1.1, design §6).
 *  - Khi KHÔNG có `display`: fallback format CLIENT-SIDE từ `balance` qua `formatCurrency`
 *    (VNĐ theo locale hiện tại).
 *  - màu phẳng + `.glass`, không chuyển-màu-nền.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatCurrency } from '@/utils/format'

const props = withDefaults(
  defineProps<{
    /** Số dư dạng số (đơn vị đồng) — dùng cho fallback khi không có `display`. */
    balance?: number
    /** Chuỗi hiển thị region-aware từ server; có giá trị → render verbatim (R1.1). */
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
 * Ưu tiên chuỗi `display` từ server (đã format region-aware) để hiển thị verbatim;
 * thiếu thì fallback `formatCurrency(balance)` (VNĐ theo locale hiện tại).
 */
const text = computed(() =>
  props.display && props.display.length > 0 ? props.display : formatCurrency(props.balance)
)
</script>

<template>
  <div class="glass flex flex-col gap-1 p-5">
    <span class="text-ios-footnote text-hint">{{ labelText }}</span>
    <span class="text-ios-large-title tabular-nums text-text">{{ text }}</span>
  </div>
</template>
