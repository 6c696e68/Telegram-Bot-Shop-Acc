<script setup lang="ts">
import { useRoute } from 'vue-router'
import Icon from './Icon.vue'

defineProps<{ open: boolean }>()
defineEmits<{ close: [] }>()

const route = useRoute()

const navItems = [
  { key: 'nav.dashboard', path: '/', icon: 'dashboard' },
  { key: 'nav.users', path: '/users', icon: 'users' },
  { key: 'nav.categories', path: '/categories', icon: 'category' },
  { key: 'nav.products', path: '/products', icon: 'package' },
  { key: 'nav.orders', path: '/orders', icon: 'cart' },
  { key: 'nav.transactions', path: '/transactions', icon: 'receipt' },
  { key: 'nav.deposits', path: '/deposits', icon: 'wallet' },
  { key: 'nav.config', path: '/config', icon: 'settings' },
]

function isActive(path: string): boolean {
  return path === '/' ? route.path === '/' : route.path.startsWith(path)
}
</script>

<template>
  <!-- Mobile overlay -->
  <Transition
    enter-active-class="transition-opacity duration-200"
    enter-from-class="opacity-0"
    leave-active-class="transition-opacity duration-200"
    leave-to-class="opacity-0"
  >
    <div
      v-if="open"
      class="fixed inset-0 z-30 bg-black/30 lg:hidden"
      @click="$emit('close')"
    />
  </Transition>

  <aside
    :class="[
      'fixed inset-y-0 left-0 z-40 flex w-60 flex-col transition-transform duration-200 lg:static lg:translate-x-0',
      open ? 'translate-x-0' : '-translate-x-full',
    ]"
    style="background: var(--surface); border-right: 1px solid var(--border)"
  >
    <!-- Brand -->
    <div class="flex h-16 items-center gap-2.5 px-5" style="border-bottom: 1px solid var(--border)">
      <div
        class="flex h-8 w-8 items-center justify-center rounded-lg text-white"
        style="background: var(--accent)"
      >
        <Icon name="store" :size="18" />
      </div>
      <div class="leading-tight">
        <div class="text-[13px] font-semibold" style="color: var(--ink)">Shop Admin</div>
        <div class="text-[11px]" style="color: var(--faint)">{{ $t('brand.subtitle') }}</div>
      </div>
    </div>

    <!-- Nav -->
    <nav class="flex-1 overflow-y-auto px-3 py-4">
      <p class="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.08em]" style="color: var(--faint)">
        Menu
      </p>
      <RouterLink
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        class="group mb-0.5 flex items-center gap-3 rounded-md px-3 py-2 text-[13px] font-medium transition-colors"
        :style="isActive(item.path)
          ? 'background: var(--surface-alt); color: var(--ink)'
          : 'color: var(--muted)'"
        @click="$emit('close')"
      >
        <Icon :name="item.icon" :size="18" />
        <span>{{ $t(item.key) }}</span>
        <span
          v-if="isActive(item.path)"
          class="ml-auto h-1.5 w-1.5 rounded-full"
          style="background: var(--ink)"
        />
      </RouterLink>
    </nav>

    <div class="px-5 py-4" style="border-top: 1px solid var(--border)">
      <p class="text-[11px]" style="color: var(--faint)">v1.0 · Cloudflare Workers</p>
    </div>
  </aside>
</template>
