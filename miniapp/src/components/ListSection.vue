<script setup lang="ts">
/**
 * ListSection — nhóm grouped-list kiểu CryptoBot.
 *  - (tuỳ chọn) header: tiêu đề mảnh + slot `header-action` (vd "Xem tất cả >").
 *  - thân: thẻ surface bo góc lớn, tự kẻ separator giữa các row con (`divide-y`).
 *  - Màu phẳng, không gradient. Row con do caller cung cấp (ListRow / ProductCard...).
 */
withDefaults(
  defineProps<{
    /** Tiêu đề nhóm (đặt phía trên thẻ). Bỏ trống → không render header. */
    title?: string
  }>(),
  { title: '' }
)
</script>

<template>
  <section class="flex flex-col gap-2">
    <div
      v-if="title || $slots['header-action']"
      class="flex items-center justify-between gap-2 px-4"
    >
      <h2 v-if="title" class="text-ios-footnote uppercase tracking-wide text-hint">{{ title }}</h2>
      <slot name="header-action" />
    </div>
    <div class="surface-card divide-y divide-separator overflow-hidden">
      <slot />
    </div>
  </section>
</template>
