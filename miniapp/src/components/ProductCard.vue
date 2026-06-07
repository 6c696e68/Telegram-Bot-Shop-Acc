<script setup lang="ts">
/**
 * ProductCard — thẻ sản phẩm trong lưới 2 cột (Obsidian Glass, Req 5.1/5.2/5.4).
 *  - Header: ảnh `imageUrl` (full-bleed) nếu có; nếu không → ô gradient + glyph fallback.
 *  - Body: tên (2 dòng), giá (primary). Hết hàng → mờ giá + chặn bấm (Req 5.4).
 *  - haptic('light') + emit('click') khi còn hàng.
 */
import { computed, ref } from 'vue'
import { haptic } from '@/telegram/sdk'
import { tileGradient, tileTint } from '@/utils/avatar'
import StatusBadge from '@/components/StatusBadge.vue'

const props = withDefaults(
  defineProps<{
    id: number | string
    name: string
    emoji?: string
    imageUrl?: string | null
    priceDisplay: string
    stock?: number
    inStock?: boolean
  }>(),
  { emoji: '', imageUrl: null, stock: 0, inStock: true }
)

const emit = defineEmits<{ (e: 'click'): void }>()

const imgError = ref(false)
const showImage = computed(() => !!props.imageUrl && !imgError.value)
const glyph = computed(() => props.emoji?.trim() || props.name.trim().charAt(0).toUpperCase())

function onClick(): void {
  if (!props.inStock) return
  haptic('light')
  emit('click')
}
</script>

<template>
  <button
    type="button"
    :disabled="!inStock"
    class="flex flex-col overflow-hidden rounded-xl bg-surface-container-lowest text-left ring-1 ring-outline-variant/20 transition-transform duration-200 active:scale-[0.97]"
    @click="onClick"
  >
    <!-- Header: ảnh thật hoặc fallback gradient + glyph -->
    <div class="relative h-28 w-full overflow-hidden bg-surface-container">
      <img
        v-if="showImage"
        :src="imageUrl as string"
        :alt="name"
        class="h-full w-full object-cover"
        :class="inStock ? '' : 'opacity-50 grayscale'"
        @error="imgError = true"
      />
      <div
        v-else
        class="flex h-full w-full items-center justify-center"
        :style="{ backgroundImage: tileGradient(id) }"
      >
        <span
          class="flex h-14 w-14 items-center justify-center rounded-2xl text-3xl leading-none"
          :style="{ backgroundColor: tileTint(id), color: '#e0e2ed' }"
          aria-hidden="true"
        >
          {{ glyph }}
        </span>
      </div>
      <div class="absolute left-2 top-2">
        <StatusBadge :in-stock="inStock" />
      </div>
    </div>

    <!-- Body: tên + giá -->
    <div class="flex flex-1 flex-col justify-between p-3">
      <h4 class="line-clamp-2 text-[15px] font-medium leading-snug text-on-surface">
        {{ name }}
      </h4>
      <div class="mt-3 flex items-baseline gap-1" :class="inStock ? '' : 'opacity-50'">
        <span
          class="text-[20px] font-bold tracking-tight tabular-nums"
          :class="inStock ? 'text-primary' : 'text-on-surface-variant'"
        >
          {{ priceDisplay }}
        </span>
      </div>
    </div>
  </button>
</template>
