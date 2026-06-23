<script setup lang="ts">
/**
 * GlassCard — thẻ container (Obsidian Glass).
 *  - Mặc định: nền surface-container-lowest + viền outline-variant, bo `rounded-xl`.
 *  - `glass`  : dùng lớp `.glass-card` (kính mờ) cho panel nổi.
 *  - `padded` : bật/tắt padding mặc định. `as`: thẻ HTML gốc.
 */
withDefaults(
  defineProps<{
    padded?: boolean
    glass?: boolean
    as?: string
  }>(),
  { padded: true, glass: false, as: 'div' }
)
</script>

<template>
  <component
    :is="as"
    class="rounded-xl"
    :class="[
      glass ? 'glass-card' : 'bg-surface-container-lowest border border-outline-variant/20',
      padded ? 'p-3' : '',
    ]"
  >
    <slot />
  </component>
</template>
