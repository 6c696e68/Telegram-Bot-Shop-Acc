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
  <div class="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
    <span
      class="flex h-14 w-14 items-center justify-center rounded-full bg-surface-container text-on-surface-variant"
      aria-hidden="true"
    >
      <component :is="icon" :size="26" :stroke-width="1.5" />
    </span>
    <h2 class="text-[16px] font-semibold text-on-surface">{{ title }}</h2>
    <p v-if="description" class="max-w-xs text-[14px] text-on-surface-variant">{{ description }}</p>
    <div v-if="$slots.action" class="mt-1">
      <slot name="action" />
    </div>
  </div>
</template>
