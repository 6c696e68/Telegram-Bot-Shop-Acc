<script setup lang="ts">
/**
 * HomeView — "Cửa hàng" (storefront), tab cấp 1 (Req 4, 5).
 *
 *  - Banner ảnh giới thiệu (carousel) lấy từ `GET /api/app/banners` (admin cấu hình ở CMS).
 *  - Danh sách loại sản phẩm (`GET /api/app/product-types`) trong `ListSection`, có ô
 *    tìm kiếm theo tên (client-side). Gồm cả loại hết hàng → disable + nhãn đỏ (Req 5.4).
 *  - Là route cấp 1 (tab) nên KHÔNG dùng Telegram BackButton. Màu phẳng, không gradient.
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ShoppingCart, Search } from '@lucide/vue'
import ProductCard from '@/components/ProductCard.vue'
import ListSection from '@/components/ListSection.vue'
import BannerCarousel from '@/components/BannerCarousel.vue'
import EmptyState from '@/components/EmptyState.vue'
import { get, ApiError } from '@/api/client'
import { useUiStore } from '@/stores/ui'
import type { ProductTypeListItemDto, BannerDto } from '@/types'

const router = useRouter()
const ui = useUiStore()
const { t } = useI18n()

const products = ref<ProductTypeListItemDto[]>([])
const banners = ref<BannerDto[]>([])
const loaded = ref(false)
const query = ref('')

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return products.value
  return products.value.filter((p) => p.name.toLowerCase().includes(q))
})

function openDetail(item: ProductTypeListItemDto): void {
  router.push({ name: 'product-detail', params: { id: String(item.id) } })
}

async function load(): Promise<void> {
  try {
    products.value = await ui.withLoading(get<ProductTypeListItemDto[]>('/product-types'))
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return
    ui.toast(t('shop.load_error'), 'error')
  } finally {
    loaded.value = true
  }
}

async function loadBanners(): Promise<void> {
  try {
    banners.value = await get<BannerDto[]>('/banners')
  } catch {
    // Banner lỗi tải → bỏ qua, storefront vẫn dùng được.
  }
}

onMounted(() => {
  void load()
  void loadBanners()
})
</script>

<template>
  <main class="flex flex-col gap-5 px-4 pb-2 pt-6">
    <!-- Banner ảnh giới thiệu (chỉ hiện khi admin đã cấu hình) -->
    <BannerCarousel v-if="banners.length" :banners="banners" />

    <!-- Tiêu đề + ô tìm kiếm -->
    <header class="flex flex-col gap-3">
      <h1 class="px-1 text-ios-large-title text-text">{{ $t('home.intro_title') }}</h1>
      <div v-if="products.length" class="surface-card flex items-center gap-2 px-4">
        <Search :size="18" :stroke-width="2" class="shrink-0 text-hint" aria-hidden="true" />
        <input
          v-model="query"
          type="text"
          :placeholder="$t('shop.search_placeholder')"
          class="w-full bg-transparent py-3 text-ios-body text-text outline-none placeholder:text-hint"
          :aria-label="$t('shop.search_placeholder')"
        />
      </div>
    </header>

    <!-- Danh sách sản phẩm -->
    <ListSection v-if="filtered.length" :title="$t('shop.list_label')">
      <ProductCard
        v-for="item in filtered"
        :key="item.id"
        :name="item.name"
        :emoji="item.emoji"
        :price="item.price"
        :price-display="item.price_display"
        :stock="item.stock"
        :in-stock="item.in_stock"
        @click="openDetail(item)"
      />
    </ListSection>

    <EmptyState
      v-else-if="loaded"
      :icon="ShoppingCart"
      :title="query ? $t('shop.search_empty_title') : $t('shop.empty_title')"
      :description="query ? $t('shop.search_empty_desc') : $t('shop.empty_desc')"
    />
  </main>
</template>
