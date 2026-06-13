<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { api } from '@/api/client'
import Icon from '@/components/Icon.vue'
import { AVAILABLE_LOCALES } from '@/i18n'
import { formatMoney } from '@/utils/format'

interface Category {
  id: number
  name: string
  emoji: string | null
}

interface Product {
  id: number
  product_type_id: number
  name: string
  description: string | null
  content: string | null
  price: number
  emoji: string | null
  image_data: string | null
  sort_order: number
  is_visible: number
  product_type_name: string | null
  product_type_emoji: string | null
  available_count: number
  total_count: number
  created_at: string
  updated_at: string
}

interface ProductItem {
  id: number
  product_id: number
  content: string
  status: 'available' | 'sold' | 'reserved'
  buyer_id: number | null
  order_id: number | null
  created_at: string
  sold_at: string | null
}

interface ProductForm {
  product_type_id: number | null
  name: string
  description: string
  content: string
  price: number | null
  emoji: string
  image_data: string
  sort_order: number
  is_visible: number
}

interface TranslationForm {
  name: string
  description: string
  content: string
}

interface ImportResult {
  imported: number
  duplicates: string[]
  errors: string[]
}

const products = ref<Product[]>([])
const categories = ref<Category[]>([])
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const success = ref('')
const page = ref(1)
const limit = ref(20)
const total = ref(0)
const filterCategory = ref('')

const showProductModal = ref(false)
const editingId = ref<number | null>(null)
const form = ref<ProductForm>(emptyForm())
const translations = ref<Record<string, TranslationForm>>(emptyTranslations())
const templates = ref<Record<string, string>>(emptyTemplates())
const activeLang = ref(AVAILABLE_LOCALES[0] ?? 'vi')

const showStockModal = ref(false)
const stockProduct = ref<Product | null>(null)
const stockItems = ref<ProductItem[]>([])
const stockLoading = ref(false)
const importText = ref('')
const importResult = ref<ImportResult | null>(null)

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / limit.value)))
const modalTitle = computed(() => (editingId.value ? 'Sửa sản phẩm' : 'Thêm sản phẩm'))
const importCount = computed(() => importText.value.split('\n').map((x) => x.trim()).filter(Boolean).length)

function emptyForm(): ProductForm {
  return {
    product_type_id: null,
    name: '',
    description: '',
    content: '',
    price: null,
    emoji: '',
    image_data: '',
    sort_order: 0,
    is_visible: 1,
  }
}

function emptyTranslations(): Record<string, TranslationForm> {
  const out: Record<string, TranslationForm> = {}
  for (const lang of AVAILABLE_LOCALES) out[lang] = { name: '', description: '', content: '' }
  return out
}

function emptyTemplates(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const lang of AVAILABLE_LOCALES) out[lang] = ''
  return out
}

async function fetchCategories(): Promise<void> {
  const res = await api.get<Category[]>('/product-types?limit=100&sort=sort_order&order=asc')
  if (res.success && res.data) categories.value = res.data
}

async function fetchProducts(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    let path = `/products?page=${page.value}&limit=${limit.value}&sort=sort_order&order=asc`
    if (filterCategory.value) path += `&product_type_id=${filterCategory.value}`
    const res = await api.get<Product[]>(path)
    if (res.success && res.data) {
      products.value = res.data
      total.value = res.meta?.total ?? res.data.length
    } else {
      error.value = res.error || 'Không tải được sản phẩm'
    }
  } catch {
    error.value = 'Không tải được sản phẩm'
  } finally {
    loading.value = false
  }
}

async function fetchTranslations(id: number): Promise<void> {
  translations.value = emptyTranslations()
  const res = await api.get<Array<{ lang: string; name: string | null; description: string | null; content: string | null }>>(
    `/products/${id}/translations`
  )
  if (!res.success || !res.data) return
  for (const row of res.data) {
    if (row.lang in translations.value) {
      translations.value[row.lang] = {
        name: row.name ?? '',
        description: row.description ?? '',
        content: row.content ?? '',
      }
    }
  }
}

async function fetchTemplates(id: number): Promise<void> {
  templates.value = emptyTemplates()
  const res = await api.get<Array<{ lang: string; success_template: string | null }>>(`/products/${id}/templates`)
  if (!res.success || !res.data) return
  for (const row of res.data) {
    if (row.lang in templates.value) templates.value[row.lang] = row.success_template ?? ''
  }
}

function openCreate(): void {
  editingId.value = null
  form.value = emptyForm()
  form.value.product_type_id = categories.value[0]?.id ?? null
  translations.value = emptyTranslations()
  templates.value = emptyTemplates()
  activeLang.value = AVAILABLE_LOCALES[0] ?? 'vi'
  error.value = ''
  success.value = ''
  showProductModal.value = true
}

async function openEdit(product: Product): Promise<void> {
  editingId.value = product.id
  form.value = {
    product_type_id: product.product_type_id,
    name: product.name,
    description: product.description ?? '',
    content: product.content ?? '',
    price: product.price,
    emoji: product.emoji ?? '',
    image_data: product.image_data ?? '',
    sort_order: product.sort_order,
    is_visible: product.is_visible,
  }
  activeLang.value = AVAILABLE_LOCALES[0] ?? 'vi'
  error.value = ''
  success.value = ''
  showProductModal.value = true
  await Promise.all([fetchTranslations(product.id), fetchTemplates(product.id)])
}

function validateProduct(): string | null {
  if (!form.value.product_type_id) return 'Chọn danh mục'
  const name = form.value.name.trim()
  if (!name) return 'Tên sản phẩm là bắt buộc'
  if (name.length > 200) return 'Tên tối đa 200 ký tự'
  if (!Number.isInteger(form.value.price) || (form.value.price ?? 0) < 1 || (form.value.price ?? 0) > 999999999) {
    return 'Giá phải là số nguyên từ 1 đến 999999999'
  }
  if (form.value.description.length > 2000) return 'Mô tả tối đa 2000 ký tự'
  if (form.value.content.length > 5000) return 'Nội dung tối đa 5000 ký tự'
  for (const lang of AVAILABLE_LOCALES) {
    const tr = translations.value[lang]
    if (!tr) continue
    const hasAny = tr.name.trim() || tr.description.trim() || tr.content.trim()
    if (!hasAny) continue
    if (!tr.name.trim()) return `Bản dịch ${lang.toUpperCase()} cần tên`
    if (tr.name.trim().length > 200) return `Tên dịch ${lang.toUpperCase()} tối đa 200 ký tự`
    if (tr.description.length > 2000) return `Mô tả dịch ${lang.toUpperCase()} tối đa 2000 ký tự`
    if (tr.content.length > 5000) return `Nội dung dịch ${lang.toUpperCase()} tối đa 5000 ký tự`
  }
  for (const lang of AVAILABLE_LOCALES) {
    if ((templates.value[lang] ?? '').length > 5000) return `Template ${lang.toUpperCase()} tối đa 5000 ký tự`
  }
  return null
}

async function saveTranslations(id: number): Promise<void> {
  for (const lang of AVAILABLE_LOCALES) {
    const tr = translations.value[lang]
    if (!tr) continue
    const hasAny = tr.name.trim() || tr.description.trim() || tr.content.trim()
    if (!hasAny) continue
    await api.put(`/products/${id}/translations`, {
      lang,
      name: tr.name.trim(),
      description: tr.description.trim() || null,
      content: tr.content.trim() || null,
    })
  }
}

async function saveTemplates(id: number): Promise<void> {
  for (const lang of AVAILABLE_LOCALES) {
    await api.put(`/products/${id}/templates`, {
      lang,
      success_template: templates.value[lang]?.trim() || null,
    })
  }
}

async function saveProduct(): Promise<void> {
  const validation = validateProduct()
  if (validation) {
    error.value = validation
    return
  }
  saving.value = true
  error.value = ''
  try {
    const payload = {
      product_type_id: form.value.product_type_id,
      name: form.value.name.trim(),
      description: form.value.description.trim() || null,
      content: form.value.content.trim() || null,
      price: form.value.price,
      emoji: form.value.emoji.trim() || null,
      image_data: form.value.image_data.trim() || null,
      sort_order: Number.isInteger(form.value.sort_order) ? form.value.sort_order : 0,
      is_visible: form.value.is_visible ? 1 : 0,
    }
    const res = editingId.value
      ? await api.put<Product>(`/products/${editingId.value}`, payload)
      : await api.post<Product>('/products', payload)
    if (!res.success || !res.data) {
      error.value = res.error || 'Không lưu được sản phẩm'
      return
    }
    await saveTranslations(res.data.id)
    await saveTemplates(res.data.id)
    success.value = 'Đã lưu sản phẩm'
    showProductModal.value = false
    await fetchProducts()
  } catch {
    error.value = 'Không lưu được sản phẩm'
  } finally {
    saving.value = false
  }
}

async function deleteProduct(product: Product): Promise<void> {
  if (product.total_count > 0) {
    error.value = 'Không thể xoá sản phẩm còn kho'
    return
  }
  if (!confirm(`Xoá sản phẩm "${product.name}"?`)) return
  const res = await api.delete<{ id: number }>(`/products/${product.id}`)
  if (res.success) await fetchProducts()
  else error.value = res.error || 'Không xoá được sản phẩm'
}

async function toggleVisible(product: Product): Promise<void> {
  const next = product.is_visible ? 0 : 1
  const res = await api.put<Product>(`/products/${product.id}`, { is_visible: next })
  if (res.success) product.is_visible = next
  else error.value = res.error || 'Không cập nhật được trạng thái'
}

async function openStock(product: Product): Promise<void> {
  stockProduct.value = product
  importText.value = ''
  importResult.value = null
  showStockModal.value = true
  await fetchStockItems()
}

async function fetchStockItems(): Promise<void> {
  if (!stockProduct.value) return
  stockLoading.value = true
  const res = await api.get<ProductItem[]>(`/product-items?product_id=${stockProduct.value.id}&limit=100`)
  if (res.success && res.data) stockItems.value = res.data
  stockLoading.value = false
}

async function submitImport(): Promise<void> {
  if (!stockProduct.value) return
  const contents = importText.value.split('\n').map((x) => x.trim()).filter(Boolean)
  if (contents.length === 0) {
    error.value = 'Nhập ít nhất một dòng kho'
    return
  }
  const res = await api.post<ImportResult>('/product-items/import', {
    product_id: stockProduct.value.id,
    contents,
  })
  if (res.success && res.data) {
    importResult.value = res.data
    importText.value = ''
    await Promise.all([fetchStockItems(), fetchProducts()])
  } else {
    error.value = res.error || 'Không import được kho'
  }
}

async function deleteItem(item: ProductItem): Promise<void> {
  if (item.status !== 'available') return
  const res = await api.delete<{ id: number }>(`/product-items/${item.id}`)
  if (res.success) {
    await Promise.all([fetchStockItems(), fetchProducts()])
  } else {
    error.value = res.error || 'Không xoá được item'
  }
}

function maskContent(content: string): string {
  if (content.length <= 16) return content
  return `${content.slice(0, 10)}...${content.slice(-4)}`
}

function formatDate(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString('vi-VN')
}

watch([filterCategory], () => {
  page.value = 1
  void fetchProducts()
})

watch(page, () => {
  void fetchProducts()
})

onMounted(async () => {
  await fetchCategories()
  await fetchProducts()
})
</script>

<template>
  <div class="animate-in">
    <div class="page-head">
      <div>
        <h1 class="page-title">Sản phẩm</h1>
        <p class="page-subtitle">Quản lý Product có giá, template bán hàng, bản dịch và kho Product_Item.</p>
      </div>
      <button class="btn btn-primary" type="button" @click="openCreate">
        <Icon name="plus" :size="16" />
        Thêm sản phẩm
      </button>
    </div>

    <div v-if="error" class="notice notice-error">{{ error }}</div>
    <div v-if="success" class="notice notice-success">{{ success }}</div>

    <div class="filters">
      <div class="field-wrap">
        <select v-model="filterCategory" class="field">
          <option value="">Tất cả danh mục</option>
          <option v-for="category in categories" :key="category.id" :value="category.id">
            {{ category.name }}
          </option>
        </select>
      </div>
    </div>

    <div class="card overflow-hidden">
      <div v-if="loading" class="state-block">
        <Icon name="refresh" :size="20" />
        <span>Đang tải</span>
      </div>
      <div v-else-if="products.length === 0" class="state-block state-empty">
        <Icon name="package" :size="32" />
        <p>Chưa có sản phẩm</p>
      </div>
      <table v-else class="data-table">
        <thead>
          <tr>
            <th style="width: 56px">ID</th>
            <th>Tên</th>
            <th>Danh mục</th>
            <th class="text-right">Giá</th>
            <th class="text-right">Kho</th>
            <th>Trạng thái</th>
            <th>Ngày tạo</th>
            <th class="text-right">Thao tác</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="product in products" :key="product.id" class="row-hover">
            <td class="mono faint">{{ product.id }}</td>
            <td class="ink">
              <span v-if="product.emoji" class="emoji-box">{{ product.emoji }}</span>
              {{ product.name }}
            </td>
            <td class="muted">{{ product.product_type_name || '—' }}</td>
            <td class="text-right tabular-nums">{{ formatMoney(product.price) }}</td>
            <td class="text-right tabular-nums">{{ product.available_count }} / {{ product.total_count }}</td>
            <td>
              <span class="badge" :class="product.is_visible ? 'badge-green' : 'badge-yellow'">
                {{ product.is_visible ? 'Hiển thị' : 'Ẩn' }}
              </span>
            </td>
            <td class="muted nowrap">{{ formatDate(product.created_at) }}</td>
            <td class="text-right">
              <button class="btn btn-ghost btn-sm" type="button" title="Kho" @click="openStock(product)">
                <Icon name="package" :size="15" />
              </button>
              <button class="btn btn-ghost btn-sm" type="button" title="Sửa" @click="openEdit(product)">
                <Icon name="edit" :size="15" />
              </button>
              <button class="btn btn-ghost btn-sm" type="button" title="Ẩn/hiện" @click="toggleVisible(product)">
                <Icon :name="product.is_visible ? 'eyeOff' : 'eye'" :size="15" />
              </button>
              <button class="btn btn-ghost btn-sm danger" type="button" title="Xoá" @click="deleteProduct(product)">
                <Icon name="trash" :size="15" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="totalPages > 1" class="pagination">
      <p class="page-info">Trang {{ page }} / {{ totalPages }} · Tổng {{ total }}</p>
      <div class="page-actions">
        <button class="btn btn-ghost btn-sm" :disabled="page <= 1" @click="page--">
          <Icon name="arrowLeft" :size="15" />
        </button>
        <button class="btn btn-ghost btn-sm" :disabled="page >= totalPages" @click="page++">
          <Icon name="arrowRight" :size="15" />
        </button>
      </div>
    </div>

    <div v-if="showProductModal" class="modal-backdrop" @click.self="showProductModal = false">
      <div class="modal-panel wide">
        <div class="modal-head">
          <h2 class="modal-title">{{ modalTitle }}</h2>
          <button class="icon-btn" type="button" @click="showProductModal = false">
            <Icon name="close" :size="18" />
          </button>
        </div>

        <div class="form-grid">
          <label class="field-block">
            <span class="label">Danh mục</span>
            <select v-model.number="form.product_type_id" class="field">
              <option v-for="category in categories" :key="category.id" :value="category.id">
                {{ category.name }}
              </option>
            </select>
          </label>
          <label class="field-block">
            <span class="label">Giá</span>
            <input v-model.number="form.price" class="field" type="number" min="1" max="999999999" />
          </label>
          <label class="field-block">
            <span class="label">Tên</span>
            <input v-model="form.name" class="field" maxlength="200" />
          </label>
          <label class="field-block">
            <span class="label">Emoji</span>
            <input v-model="form.emoji" class="field" maxlength="16" />
          </label>
          <label class="field-block span-2">
            <span class="label">Mô tả</span>
            <textarea v-model="form.description" class="field textarea" maxlength="2000" />
          </label>
          <label class="field-block span-2">
            <span class="label">Nội dung hiển thị</span>
            <textarea v-model="form.content" class="field textarea" maxlength="5000" />
          </label>
          <label class="field-block">
            <span class="label">Thứ tự</span>
            <input v-model.number="form.sort_order" class="field" type="number" />
          </label>
          <label class="check-row">
            <input v-model.number="form.is_visible" type="checkbox" :true-value="1" :false-value="0" />
            <span>Hiển thị</span>
          </label>
          <label class="field-block span-2">
            <span class="label">Ảnh hoặc data URL</span>
            <input v-model="form.image_data" class="field" />
          </label>
        </div>

        <section class="translation-box">
          <div class="tabs">
            <button
              v-for="lang in AVAILABLE_LOCALES"
              :key="lang"
              type="button"
              class="tab-btn"
              :class="{ active: activeLang === lang }"
              @click="activeLang = lang"
            >
              {{ lang.toUpperCase() }}
            </button>
          </div>

          <div v-if="translations[activeLang]" class="form-grid">
            <label class="field-block span-2">
              <span class="label">Tên dịch</span>
              <input v-model="translations[activeLang].name" class="field" maxlength="200" />
            </label>
            <label class="field-block span-2">
              <span class="label">Mô tả dịch</span>
              <textarea v-model="translations[activeLang].description" class="field textarea" maxlength="2000" />
            </label>
            <label class="field-block span-2">
              <span class="label">Nội dung dịch</span>
              <textarea v-model="translations[activeLang].content" class="field textarea" maxlength="5000" />
            </label>
            <label class="field-block span-2">
              <span class="label">Success template</span>
              <textarea v-model="templates[activeLang]" class="field textarea template-text" maxlength="5000" />
            </label>
          </div>
        </section>

        <div class="modal-actions">
          <button class="btn btn-ghost" type="button" @click="showProductModal = false">Huỷ</button>
          <button class="btn btn-primary" type="button" :disabled="saving" @click="saveProduct">
            <Icon name="check" :size="16" />
            {{ saving ? 'Đang lưu' : 'Lưu' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="showStockModal && stockProduct" class="modal-backdrop" @click.self="showStockModal = false">
      <div class="modal-panel wide">
        <div class="modal-head">
          <h2 class="modal-title">Kho: {{ stockProduct.name }}</h2>
          <button class="icon-btn" type="button" @click="showStockModal = false">
            <Icon name="close" :size="18" />
          </button>
        </div>

        <div class="stock-layout">
          <section>
            <label class="field-block">
              <span class="label">Import kho</span>
              <textarea v-model="importText" class="field textarea stock-input" placeholder="Mỗi dòng một tài khoản" />
            </label>
            <div class="modal-actions inline">
              <span class="muted">{{ importCount }} dòng</span>
              <button class="btn btn-primary" type="button" @click="submitImport">
                <Icon name="upload" :size="16" />
                Import
              </button>
            </div>
            <p v-if="importResult" class="muted">
              Đã nhập {{ importResult.imported }}, trùng {{ importResult.duplicates.length }}, lỗi {{ importResult.errors.length }}
            </p>
          </section>

          <section class="stock-list">
            <div v-if="stockLoading" class="state-block">Đang tải</div>
            <table v-else class="data-table compact">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Nội dung</th>
                  <th>Trạng thái</th>
                  <th class="text-right">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in stockItems" :key="item.id">
                  <td class="mono faint">{{ item.id }}</td>
                  <td><span class="chip-code" :title="item.content">{{ maskContent(item.content) }}</span></td>
                  <td>
                    <span class="badge" :class="item.status === 'available' ? 'badge-green' : 'badge-yellow'">
                      {{ item.status }}
                    </span>
                  </td>
                  <td class="text-right">
                    <button
                      v-if="item.status === 'available'"
                      class="btn btn-ghost btn-sm danger"
                      type="button"
                      @click="deleteItem(item)"
                    >
                      <Icon name="trash" :size="15" />
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.notice {
  margin-bottom: 14px;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 14px;
}
.notice-error {
  background: var(--red-bg);
  color: var(--red-fg);
}
.notice-success {
  background: var(--green-bg);
  color: var(--green-fg);
}
.text-right {
  text-align: right;
}
.tabular-nums {
  font-variant-numeric: tabular-nums;
}
.emoji-box {
  display: inline-flex;
  width: 28px;
}
.danger {
  color: var(--red-fg);
}
.wide {
  width: min(960px, calc(100vw - 32px));
}
.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.span-2 {
  grid-column: span 2;
}
.field-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.textarea {
  min-height: 90px;
  resize: vertical;
}
.template-text {
  min-height: 130px;
}
.check-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 28px;
}
.translation-box {
  margin-top: 18px;
  border-top: 1px solid var(--line);
  padding-top: 16px;
}
.tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}
.tab-btn {
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 7px 12px;
  background: var(--surface);
  color: var(--muted);
}
.tab-btn.active {
  border-color: var(--accent);
  color: var(--accent);
}
.stock-layout {
  display: grid;
  grid-template-columns: 0.9fr 1.1fr;
  gap: 18px;
}
.stock-input {
  min-height: 220px;
}
.inline {
  align-items: center;
  justify-content: space-between;
}
.stock-list {
  max-height: 520px;
  overflow: auto;
}
.compact th,
.compact td {
  padding: 8px 10px;
}
@media (max-width: 860px) {
  .form-grid,
  .stock-layout {
    grid-template-columns: 1fr;
  }
  .span-2 {
    grid-column: span 1;
  }
}
</style>
