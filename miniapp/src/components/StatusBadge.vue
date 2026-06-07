<script setup lang="ts">
/**
 * StatusBadge — chip trạng thái tồn kho (Obsidian Glass).
 *  - inStock=true  → chấm + nhãn tertiary ("Còn hàng").
 *  - inStock=false → chấm + nhãn error ("Hết hàng").
 *  - Nền kính mờ, chữ uppercase nhỏ. Không emoji.
 */
defineProps<{ inStock: boolean }>()
</script>

<template>
  <div
    class="flex items-center gap-1 rounded-full border border-outline-variant/10 bg-surface/90 px-2 py-0.5 backdrop-blur-md"
  >
    <span
      class="h-1.5 w-1.5 rounded-full"
      :class="inStock ? 'bg-tertiary' : 'bg-error'"
      :style="
        inStock
          ? 'box-shadow: 0 0 8px rgba(255,181,149,0.8)'
          : 'box-shadow: 0 0 8px rgba(255,180,171,0.8)'
      "
      aria-hidden="true"
    />
    <span
      class="text-[10px] font-semibold uppercase tracking-wider"
      :class="inStock ? 'text-tertiary' : 'text-error'"
    >
      {{ inStock ? $t('product.badge_in_stock') : $t('product.badge_out_of_stock') }}
    </span>
  </div>
</template>
