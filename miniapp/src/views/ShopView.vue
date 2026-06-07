<script setup lang="ts">
/**
 * ShopView — màn hình mua hàng / danh mục sản phẩm (Req 5.1, 5.2, 5.4).
 *
 *  - Khi mở: gọi `GET /api/app/product-types` (bọc `ui.withLoading`) lấy danh sách loại
 *    sản phẩm có `is_visible = 1`, đã sắp theo `sort_order` và kèm tồn kho (Req 5.1, 5.2).
 *    Danh sách BAO GỒM cả loại hết hàng để hiển thị trạng thái + chặn mua (Req 5.4).
 *  - Mỗi loại render bằng `ProductCard` (tên, emoji, giá đã format, tồn kho). `ProductCard`
 *    tự vô hiệu hoá + chỉ emit `click` khi còn hàng, nên chỉ loại còn hàng mới điều hướng
 *    sang màn chi tiết (`product-detail` với `id`) (Req 5.4).
 *  - Danh sách rỗng → `EmptyState`. Lỗi tải (khác 401) → toast lỗi.
 *  - BackButton của Telegram để quay lại trang chủ (Req 13 — điều hướng kiểu iOS); gỡ khi
 *    rời màn hình qua hàm cleanup.
 *
 * Bố cục mobile-first iOS HIG, chỉ dùng màu phẳng + lớp `.glass` — KHÔNG gradient (Req 13).
 */

import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import ProductCard from '@/components/ProductCard.vue'
import EmptyState from '@/components/EmptyState.vue'
import { ShoppingCart } from '@lucide/vue'
import { get, ApiError } from '@/api/client'
import { useUiStore } from '@/stores/ui'
import { showBackButton, type Cleanup } from '@/telegram/sdk'
import type { ProductTypeListItemDto } from '@/types'

const router = useRouter()
const ui = useUiStore()
const { t } = useI18n()

/** Danh sách loại sản phẩm (gồm cả loại hết hàng để hiển thị trạng thái — Req 5.4). */
const products = ref<ProductTypeListItemDto[]>([])
/** `true` sau khi request đầu tiên hoàn tất — tránh nháy EmptyState trong lúc đang tải. */
const loaded = ref(false)

/** Dọn dẹp BackButton (gỡ handler + ẩn) khi rời màn hình. */
let cleanupBack: Cleanup = () => {}

/**
 * Mở màn chi tiết của một loại sản phẩm (Req 5.3). Chỉ được gọi cho loại còn hàng vì
 * `ProductCard` không emit `click` khi hết hàng (Req 5.4). `id` truyền dạng chuỗi để
 * khớp prop route (`props: true`).
 */
function openDetail(item: ProductTypeListItemDto): void {
  router.push({ name: 'product-detail', params: { id: String(item.id) } })
}

/** Nạp danh mục từ server; 401 do client tự xử lý (bỏ qua toast), lỗi khác → toast. */
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

onMounted(() => {
  cleanupBack = showBackButton(() => router.back())
  void load()
})

onUnmounted(() => {
  cleanupBack()
})
</script>

<template>
  <main class="flex flex-col gap-4 px-4 py-6">
    <header class="px-1">
      <h1 class="text-ios-title text-text">{{ $t('shop.title') }}</h1>
    </header>

    <!-- Danh sách loại sản phẩm (Req 5.1, 5.2); loại hết hàng hiển thị trạng thái + disable (Req 5.4) -->
    <section
      v-if="products.length"
      class="flex flex-col gap-3"
      :aria-label="$t('shop.list_label')"
    >
      <ProductCard
        v-for="item in products"
        :key="item.id"
        :name="item.name"
        :emoji="item.emoji"
        :price="item.price"
        :price-display="item.price_display"
        :stock="item.stock"
        :in-stock="item.in_stock"
        @click="openDetail(item)"
      />
    </section>

    <!-- Trạng thái trống khi không có loại sản phẩm nào -->
    <EmptyState
      v-else-if="loaded"
      :icon="ShoppingCart"
      :title="$t('shop.empty_title')"
      :description="$t('shop.empty_desc')"
    />
  </main>
</template>
