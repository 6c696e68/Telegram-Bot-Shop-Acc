<script setup lang="ts">
/**
 * BottomNav — thanh điều hướng dưới dạng "pill kính nổi" (Obsidian Glass).
 *  - Cố định đáy (cách mép 16px), nền `.glass-panel` bo tròn full, tôn trọng safe-bottom.
 *  - 4 tab cấp 1: Market / Orders / Support / Profile. Active tô primary + nền primary/10.
 *  - Icon @lucide/vue (không emoji). haptic('light') khi đổi tab.
 *
 * Chỉ hiển thị ở route có `meta.tab = true` (App.vue quyết định mount).
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Store, ReceiptText, LifeBuoy, User } from '@lucide/vue'
import type { Component } from 'vue'
import { haptic } from '@/telegram/sdk'

interface Tab {
  name: 'market' | 'orders' | 'support' | 'profile'
  labelKey: string
  icon: Component
}

const tabs: readonly Tab[] = [
  { name: 'market', labelKey: 'nav.market', icon: Store },
  { name: 'orders', labelKey: 'nav.orders', icon: ReceiptText },
  { name: 'support', labelKey: 'nav.support', icon: LifeBuoy },
  { name: 'profile', labelKey: 'nav.profile', icon: User },
] as const

const route = useRoute()
const router = useRouter()

const activeName = computed(() => route.name as string | undefined)

function go(name: Tab['name']): void {
  if (activeName.value === name) return
  haptic('light')
  void router.push({ name })
}
</script>

<template>
  <nav
    class="glass-panel fixed bottom-0 left-0 right-0 z-50 mx-4 flex h-16 items-center justify-around rounded-full px-2 shadow-lg"
    :style="{
      bottom: 'calc(16px + var(--safe-bottom))',
      marginLeft: 'calc(16px + var(--safe-left))',
      marginRight: 'calc(16px + var(--safe-right))',
    }"
    :aria-label="$t('nav.label')"
  >
    <button
      v-for="tab in tabs"
      :key="tab.name"
      type="button"
      class="flex h-12 flex-1 flex-col items-center justify-center gap-0.5 rounded-full transition-all duration-200 active:scale-95"
      :class="
        activeName === tab.name
          ? 'bg-primary/10 text-primary'
          : 'text-on-surface-variant hover:bg-surface-container-low'
      "
      :aria-current="activeName === tab.name ? 'page' : undefined"
      :aria-label="$t(tab.labelKey)"
      @click="go(tab.name)"
    >
      <component
        :is="tab.icon"
        :size="24"
        :stroke-width="activeName === tab.name ? 2.4 : 1.9"
        aria-hidden="true"
      />
      <span
        class="text-[10px] uppercase tracking-wider"
        :class="activeName === tab.name ? 'font-bold' : 'font-medium'"
      >
        {{ $t(tab.labelKey) }}
      </span>
    </button>
  </nav>
</template>
