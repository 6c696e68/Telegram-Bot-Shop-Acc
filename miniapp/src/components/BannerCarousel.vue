<script setup lang="ts">
/**
 * BannerCarousel — băng ảnh banner giới thiệu (storefront), cuộn ngang snap kiểu iOS.
 *  - Một ảnh → hiển thị tĩnh; nhiều ảnh → cuộn ngang + chấm chỉ vị trí + tự chuyển slide.
 *  - Chạm banner có `link_url` → mở qua Telegram openLink. Màu phẳng, không gradient.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { openLink, haptic } from '@/telegram/sdk'
import type { BannerDto } from '@/types'

const props = defineProps<{ banners: BannerDto[] }>()

const scroller = ref<HTMLElement | null>(null)
const active = ref(0)
let timer: ReturnType<typeof setInterval> | null = null

const hasMany = computed(() => props.banners.length > 1)

/** Cập nhật chấm active theo vị trí cuộn. */
function onScroll(): void {
  const el = scroller.value
  if (!el) return
  const idx = Math.round(el.scrollLeft / el.clientWidth)
  active.value = Math.max(0, Math.min(props.banners.length - 1, idx))
}

function scrollTo(idx: number): void {
  const el = scroller.value
  if (!el) return
  el.scrollTo({ left: idx * el.clientWidth, behavior: 'smooth' })
}

function onBannerClick(b: BannerDto): void {
  if (!b.link_url) return
  haptic('light')
  openLink(b.link_url)
}

/** Tự chuyển slide mỗi 5s khi có nhiều ảnh (tôn trọng reduce-motion qua behavior smooth). */
function startAuto(): void {
  if (!hasMany.value) return
  timer = setInterval(() => {
    const next = (active.value + 1) % props.banners.length
    scrollTo(next)
  }, 5000)
}

onMounted(startAuto)
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="flex flex-col gap-2">
    <div
      ref="scroller"
      class="flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-smooth"
      style="scrollbar-width: none"
      @scroll="onScroll"
    >
      <button
        v-for="b in banners"
        :key="b.id"
        type="button"
        class="relative w-full shrink-0 snap-center overflow-hidden rounded-glass"
        :class="b.link_url ? '' : 'cursor-default'"
        @click="onBannerClick(b)"
      >
        <img
          :src="b.image_url"
          alt=""
          class="aspect-[16/9] w-full object-cover"
          loading="lazy"
        />
      </button>
    </div>

    <!-- Chấm chỉ vị trí (chỉ khi nhiều ảnh) -->
    <div v-if="hasMany" class="flex items-center justify-center gap-1.5">
      <button
        v-for="(b, i) in banners"
        :key="b.id"
        type="button"
        class="h-1.5 rounded-full transition-all duration-ios"
        :class="i === active ? 'w-4 bg-accent' : 'w-1.5 bg-hint/40'"
        :aria-label="String(i + 1)"
        @click="scrollTo(i)"
      />
    </div>
  </div>
</template>

<style scoped>
/* Ẩn thanh cuộn ngang (WebKit) — giữ trải nghiệm vuốt sạch như CryptoBot. */
div::-webkit-scrollbar {
  display: none;
}
</style>
