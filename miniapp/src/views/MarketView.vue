<script setup lang="ts">
/**
 * MarketView — "Market" (storefront), tab cấp 1 (Req 4, 5) — Obsidian Glass.
 *
 *  - TopAppBar + ô tìm kiếm + lưới sản phẩm 2 cột (ProductCard).
 *  - Banner ảnh (`GET /api/app/banners`) hiển thị dạng cuộn ngang nếu admin đã cấu hình.
 *  - `GET /api/app/product-types` (gồm cả loại hết hàng). Skeleton khi đang tải, EmptyState
 *    khi rỗng. Backend không có trường "category" nên không render chips danh mục.
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ShoppingBag, Search, Wallet } from '@lucide/vue'
import TopAppBar from '@/components/TopAppBar.vue'
import ProductCard from '@/components/ProductCard.vue'
import EmptyState from '@/components/EmptyState.vue'
import { get, ApiError } from '@/api/client'
import { useUiStore } from '@/stores/ui'
import { useUserStore } from '@/stores/user'
import { openLink } from '@/telegram/sdk'
import type { ProductTypeListItemDto, BannerDto } from '@/types'

const router = useRouter()
const ui = useUiStore()
const user = useUserStore()
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

function openBanner(banner: BannerDto): void {
  if (banner.link_url) openLink(banner.link_url)
}

async function load(): Promise<void> {
  try {
    products.value = await get<ProductTypeListItemDto[]>('/product-types')
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
  <div>
    <TopAppBar :title="$t('app.store_name')">
      <template #right>
        <button
          type="button"
          class="flex h-10 w-10 items-center justify-center rounded-full text-primary transition-transform active:scale-95"
          :aria-label="$t('nav.profile')"
          @click="router.push({ name: 'profile' })"
        >
          <Wallet :size="22" :stroke-width="2" aria-hidden="true" />
        </button>
      </template>
    </TopAppBar>

    <main class="px-gutter pt-[calc(56px+var(--safe-top))]">
      <!-- Số dư nhanh -->
      <div class="flex items-center justify-between pb-1 pt-4">
        <span class="text-[13px] uppercase tracking-wider text-on-surface-variant">
          {{ $t('account.balance') }}
        </span>
        <span class="text-[15px] font-semibold tabular-nums text-primary">
          {{ user.state.balanceDisplay || '—' }}
        </span>
      </div>

      <!-- Ô tìm kiếm -->
      <div class="pb-2 pt-2">
        <div
          class="flex items-center rounded-[10px] border border-transparent bg-surface-container-high px-3 py-2 transition-colors focus-within:border-primary"
        >
          <Search :size="20" :stroke-width="2" class="shrink-0 text-outline" aria-hidden="true" />
          <input
            v-model="query"
            type="text"
            :placeholder="$t('shop.search_placeholder')"
            :aria-label="$t('shop.search_placeholder')"
            class="ml-2 w-full bg-transparent text-[16px] text-on-surface outline-none placeholder:text-outline"
          />
        </div>
      </div>

      <!-- Banner ảnh (bo tròn, trong lề) -->
      <div v-if="banners.length" class="py-3">
        <div class="flex snap-x snap-mandatory gap-3 overflow-x-auto scrollbar-hide">
          <button
            v-for="banner in banners"
            :key="banner.id"
            type="button"
            class="w-full shrink-0 snap-center overflow-hidden rounded-xl ring-1 ring-outline-variant/20 transition-transform active:scale-[0.99]"
            :class="banner.link_url ? '' : 'cursor-default'"
            @click="openBanner(banner)"
          >
            <img :src="banner.image_url" alt="" class="aspect-[2/1] w-full object-cover" />
          </button>
        </div>
      </div>

      <!-- Tiêu đề khu sản phẩm -->
      <div class="mb-4 mt-2 flex items-end justify-between">
        <h3 class="text-[20px] font-bold tracking-tight text-on-surface">
          {{ $t('shop.featured') }}
        </h3>
      </div>

      <!-- Skeleton khi đang tải lần đầu -->
      <div v-if="!loaded" class="grid grid-cols-2 gap-3">
        <div
          v-for="n in 4"
          :key="n"
          class="flex flex-col overflow-hidden rounded-xl bg-surface-container-lowest ring-1 ring-outline-variant/20"
        >
          <div class="h-28 animate-shimmer bg-surface-container-high"></div>
          <div class="flex flex-col gap-3 p-3">
            <div class="space-y-2">
              <div class="h-4 w-3/4 animate-shimmer rounded bg-surface-container-high"></div>
              <div class="h-4 w-1/2 animate-shimmer rounded bg-surface-container-high"></div>
            </div>
            <div class="h-6 w-1/3 animate-shimmer rounded bg-surface-container-high"></div>
          </div>
        </div>
      </div>

      <!-- Lưới sản phẩm -->
      <div v-else-if="filtered.length" class="grid grid-cols-2 gap-3">
        <ProductCard
          v-for="item in filtered"
          :key="item.id"
          :id="item.id"
          :name="item.name"
          :emoji="item.emoji"
          :image-url="item.image_url"
          :price-display="item.price_display"
          :stock="item.stock"
          :in-stock="item.in_stock"
          @click="openDetail(item)"
        />
      </div>

      <EmptyState
        v-else
        :icon="ShoppingBag"
        :title="query ? $t('shop.search_empty_title') : $t('shop.empty_title')"
        :description="query ? $t('shop.search_empty_desc') : $t('shop.empty_desc')"
      />
    </main>
  </div>
</template>
