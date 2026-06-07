<script setup lang="ts">
/**
 * EmptyState — trạng thái trống tái sử dụng (Obsidian Glass).
 *  - icon SVG (lucide) trong ô tròn mờ + tiêu đề + mô tả; slot `action` (tùy chọn).
 */
import { Inbox } from '@lucide/vue'
import type { Component } from 'vue'

withDefaults(
  defineProps<{ icon?: Component; title: string; description?: string }>(),
  { icon: () => Inbox, description: '' }
)
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
    <span
      class="flex h-16 w-16 items-center justify-center rounded-full bg-surface-container text-on-surface-variant"
      aria-hidden="true"
    >
      <component :is="icon" :size="32" :stroke-width="1.5" />
    </span>
    <h2 class="text-[18px] font-semibold text-on-surface">{{ title }}</h2>
    <p v-if="description" class="max-w-xs text-[15px] text-on-surface-variant">{{ description }}</p>
    <div v-if="$slots.action" class="mt-2">
      <slot name="action" />
    </div>
  </div>
</template>
