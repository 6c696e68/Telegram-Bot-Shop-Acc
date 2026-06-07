<script setup lang="ts">
/**
 * TabBar — thanh điều hướng dưới kiểu CryptoBot (4 tab cấp 1).
 *  - Cố định đáy màn hình, nền surface + đường separator trên, tôn trọng `--safe-bottom`.
 *  - Tab active tô `--tg-accent`, inactive `--tg-hint`; icon (@lucide/vue) + nhãn caption.
 *  - Đổi tab → haptic('light') rồi `router.push`. Không dùng emoji (chỉ icon SVG).
 *
 * Chỉ hiển thị ở các route có `meta.tab = true` (do App.vue quyết định mount).
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Store, Wallet, User } from '@lucide/vue'
import type { Component } from 'vue'
import { haptic } from '@/telegram/sdk'

interface Tab {
  /** Tên route đích (khớp router). */
  name: 'home' | 'wallet' | 'account'
  /** Key i18n nhãn tab. */
  labelKey: string
  /** Icon SVG (lucide). */
  icon: Component
}

const tabs: readonly Tab[] = [
  { name: 'home', labelKey: 'nav.home', icon: Store },
  { name: 'wallet', labelKey: 'nav.wallet', icon: Wallet },
  { name: 'account', labelKey: 'nav.account', icon: User },
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
    class="fixed inset-x-0 bottom-0 z-30 border-t border-separator bg-surface"
    :style="{
      paddingBottom: 'var(--safe-bottom)',
      paddingLeft: 'var(--safe-left)',
      paddingRight: 'var(--safe-right)',
    }"
    :aria-label="$t('nav.label')"
  >
    <ul class="mx-auto flex max-w-xl items-stretch" :style="{ height: 'var(--tab-height)' }">
      <li v-for="tab in tabs" :key="tab.name" class="flex-1">
        <button
          type="button"
          class="flex h-full w-full flex-col items-center justify-center gap-1 transition-transform duration-ios ease-ios active:scale-95"
          :class="activeName === tab.name ? 'text-accent' : 'text-hint'"
          :aria-current="activeName === tab.name ? 'page' : undefined"
          :aria-label="$t(tab.labelKey)"
          @click="go(tab.name)"
        >
          <component :is="tab.icon" :size="24" :stroke-width="activeName === tab.name ? 2.25 : 1.9" aria-hidden="true" />
          <span class="text-ios-caption">{{ $t(tab.labelKey) }}</span>
        </button>
      </li>
    </ul>
  </nav>
</template>
