<script setup lang="ts">
/**
 * GlassCard — thẻ surface tái sử dụng (kiểu CryptoBot grouped-card).
 * Giữ tên + props (`padded`, `as`) để không vỡ import hiện tại; nội hàm đổi từ kính mờ
 * sang mặt surface phẳng + bo góc lớn + bóng nhẹ (`.surface-card`). Màu phẳng, không
 * gradient (Req 13.2/13.3).
 */
withDefaults(
  defineProps<{
    /** Có áp padding mặc định hay không (tắt khi cần bố cục sát mép). */
    padded?: boolean
    /** Thẻ HTML gốc để render (div/section/article...). */
    as?: string
  }>(),
  { padded: true, as: 'div' }
)
</script>

<template>
  <component :is="as" class="surface-card" :class="padded ? 'p-4' : ''">
    <slot />
  </component>
</template>
