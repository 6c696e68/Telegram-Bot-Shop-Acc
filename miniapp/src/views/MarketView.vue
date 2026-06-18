<script setup lang="ts">
/**
 * MarketView - "Market" storefront, tab cấp 1.
 *
 *  - TopAppBar + bộ lọc danh mục + ô tìm kiếm + lưới sản phẩm 2 cột.
 *  - Banner ảnh (`GET /api/app/banners`) hiển thị dạng cuộn ngang nếu admin đã cấu hình.
 *  - `GET /api/app/categories`, sau đó `GET /api/app/categories/:id/products`.
 */
import { computed, onMounted, ref, watch } from 'vue'
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
import type { ProductListItemDto, CategoryListItemDto, BannerDto } from '@/types'

const router = useRouter()
const ui = useUiStore()
const user = useUserStore()
const { t } = useI18n()

const categories = ref<CategoryListItemDto[]>([])
const products = ref<ProductListItemDto[]>([])
const banners = ref<BannerDto[]>([])
const categoriesLoaded = ref(false)
const productsLoaded = ref(false)
const selectedCategoryId = ref<number | null>(null)
const query = ref('')
let productLoadSeq = 0

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return products.value
  return products.value.filter((p) =>
    [p.name, p.description, p.content]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .some((value) => value.toLowerCase().includes(q))
  )
})

const selectedCategory = computed(() =>
  categories.value.find((category) => category.id === selectedCategoryId.value) ?? null
)

function openDetail(item: ProductListItemDto): void {
  router.push({ name: 'product-detail', params: { id: String(item.id) } })
}

function openBanner(banner: BannerDto): void {
  if (banner.link_url) openLink(banner.link_url)
}

function selectCategory(categoryId: number): void {
  selectedCategoryId.value = categoryId
}

async function loadCategories(): Promise<void> {
  try {
    categories.value = await get<CategoryListItemDto[]>('/categories')
    selectedCategoryId.value = categories.value[0]?.id ?? null
    if (categories.value.length === 0) {
      products.value = []
      productsLoaded.value = true
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return
    products.value = []
    productsLoaded.value = true
    ui.toast(t('shop.category_load_error'), 'error')
  } finally {
    categoriesLoaded.value = true
  }
}

async function loadProducts(categoryId: number): Promise<void> {
  const seq = ++productLoadSeq
  productsLoaded.value = false
  try {
    const data = await get<ProductListItemDto[]>(`/categories/${categoryId}/products`)
    if (seq === productLoadSeq) {
      products.value = data
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return
    if (seq === productLoadSeq) {
      products.value = []
      ui.toast(t('shop.load_error'), 'error')
    }
  } finally {
    if (seq === productLoadSeq) {
      productsLoaded.value = true
    }
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
  void loadCategories()
  void loadBanners()
})

watch(selectedCategoryId, (categoryId) => {
  query.value = ''
  if (categoryId === null) {
    products.value = []
    productsLoaded.value = true
    return
  }
  void loadProducts(categoryId)
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

      <!-- Bộ lọc danh mục -->
      <div v-if="!categoriesLoaded" class="flex gap-2 overflow-x-hidden py-3">
        <div
          v-for="n in 4"
          :key="n"
          class="h-10 w-28 shrink-0 animate-shimmer rounded-full bg-surface-container-high"
        ></div>
      </div>
      <div v-else-if="categories.length" class="py-3">
        <div
          class="flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1 scrollbar-hide"
          role="tablist"
          :aria-label="$t('shop.category_filter')"
        >
          <button
            v-for="category in categories"
            :key="category.id"
            type="button"
            role="tab"
            :aria-selected="selectedCategoryId === category.id"
            class="flex h-10 shrink-0 snap-start items-center gap-2 rounded-full border px-3 text-[14px] font-medium transition-colors"
            :class="
              selectedCategoryId === category.id
                ? 'border-primary bg-primary text-on-primary'
                : 'border-outline-variant bg-surface-container-lowest text-on-surface'
            "
            @click="selectCategory(category.id)"
          >
            <span
              v-if="category.image_url"
              class="h-6 w-6 overflow-hidden rounded-full bg-surface-container"
              aria-hidden="true"
            >
              <img :src="category.image_url" alt="" class="h-full w-full object-cover" />
            </span>
            <span v-else-if="category.emoji" class="text-[16px] leading-none" aria-hidden="true">
              {{ category.emoji }}
            </span>
            <span class="max-w-[160px] truncate">{{ category.name }}</span>
          </button>
        </div>
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
          {{ selectedCategory?.name || $t('shop.featured') }}
        </h3>
      </div>

      <!-- Skeleton khi đang tải lần đầu -->
      <div v-if="!categoriesLoaded || !productsLoaded" class="grid grid-cols-2 gap-3">
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
        :title="
          query
            ? $t('shop.search_empty_title')
            : categories.length
              ? $t('shop.category_empty_title')
              : $t('shop.empty_title')
        "
        :description="
          query
            ? $t('shop.search_empty_desc')
            : categories.length
              ? $t('shop.category_empty_desc')
              : $t('shop.empty_desc')
        "
      />
    </main>
  </div>
</template>
