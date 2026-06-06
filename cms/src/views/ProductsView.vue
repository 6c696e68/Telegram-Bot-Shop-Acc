<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/api/client'
import Icon from '@/components/Icon.vue'

const { t } = useI18n()

interface Product {
  id: number
  type_id: number
  content: string
  status: 'available' | 'sold' | 'reserved'
  buyer_id: number | null
  order_id: number | null
  created_at: string
  sold_at: string | null
  type_name: string | null
}

interface Category {
  id: number
  name: string
}

interface ImportResult {
  imported: number
  duplicates: string[]
  errors: string[]
}

// State
const products = ref<Product[]>([])
const categories = ref<Category[]>([])
const loading = ref(false)
const total = ref(0)
const page = ref(1)
const limit = ref(20)

// Filters
const filterCategory = ref('')
const filterStatus = ref('')

// Import modal
const showImportModal = ref(false)
const importCategoryId = ref<number | null>(null)
const importText = ref('')
const importLoading = ref(false)
const importResult = ref<ImportResult | null>(null)
const importError = ref('')

// Delete
const deleteLoading = ref<number | null>(null)

// Computed
const totalPages = computed(() => Math.ceil(total.value / limit.value))

const importPreviewCount = computed(() => {
  if (!importText.value.trim()) return 0
  return importText.value.trim().split('\n').filter((l) => l.trim().length > 0).length
})

// Methods
async function fetchProducts() {
  loading.value = true
  try {
    let path = `/products?page=${page.value}&limit=${limit.value}`
    if (filterCategory.value) path += `&filter[type_id]=${filterCategory.value}`
    if (filterStatus.value) path += `&filter[status]=${filterStatus.value}`

    const res = await api.get<Product[]>(path)
    if (res.success && res.data) {
      products.value = res.data
      total.value = res.meta?.total ?? 0
    }
  } catch {
    // silent
  } finally {
    loading.value = false
  }
}

async function fetchCategories() {
  try {
    const res = await api.get<Category[]>('/product-types?limit=100')
    if (res.success && res.data) {
      categories.value = res.data
    }
  } catch {
    // silent
  }
}

async function deleteProduct(id: number) {
  if (!confirm(t('products.delete_confirm'))) return
  deleteLoading.value = id
  try {
    const res = await api.delete<{ id: number }>(`/products/${id}`)
    if (res.success) {
      await fetchProducts()
    } else {
      alert(res.error || t('products.delete_failed'))
    }
  } catch {
    alert(t('common.error'))
  } finally {
    deleteLoading.value = null
  }
}

function openImportModal() {
  importText.value = ''
  importCategoryId.value = categories.value.length > 0 ? categories.value[0].id : null
  importResult.value = null
  importError.value = ''
  showImportModal.value = true
}

function handleFileUpload(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  if (!file) return

  const reader = new FileReader()
  reader.onload = (e) => {
    importText.value = (e.target?.result as string) || ''
  }
  reader.readAsText(file)
  target.value = ''
}

async function submitImport() {
  if (!importCategoryId.value) {
    importError.value = t('products.err_no_category')
    return
  }

  const contents = importText.value
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  if (contents.length === 0) {
    importError.value = t('products.err_empty')
    return
  }

  importLoading.value = true
  importError.value = ''
  importResult.value = null

  try {
    const res = await api.post<ImportResult>('/products/import', {
      category_id: importCategoryId.value,
      contents,
    })

    if (res.success && res.data) {
      importResult.value = res.data
      await fetchProducts()
    } else {
      importError.value = res.error || t('products.import_failed')
    }
  } catch {
    importError.value = t('common.error')
  } finally {
    importLoading.value = false
  }
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  return d.toLocaleDateString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function maskContent(content: string): string {
  if (content.length <= 8) return content.substring(0, 4) + '****'
  return content.substring(0, 6) + '...' + content.substring(content.length - 4)
}

const statusBadge: Record<Product['status'], string> = {
  available: 'badge-green',
  sold: 'badge-red',
  reserved: 'badge-yellow',
}

// Watchers
watch([filterCategory, filterStatus], () => {
  page.value = 1
  fetchProducts()
})

watch(page, () => {
  fetchProducts()
})

onMounted(() => {
  fetchCategories()
  fetchProducts()
})
</script>

<template>
  <div class="animate-in">
    <!-- Header -->
    <div class="page-head">
      <div>
        <h1 class="page-title">{{ $t('products.title') }}</h1>
        <p class="page-subtitle">{{ $t('products.subtitle', { count: total }) }}</p>
      </div>
      <button class="btn btn-primary" @click="openImportModal">
        <Icon name="upload" :size="16" />
        {{ $t('products.import_btn') }}
      </button>
    </div>

    <!-- Filters -->
    <div class="filters">
      <div class="field-wrap">
        <select v-model="filterCategory" class="field">
          <option value="">{{ $t('products.filter_all_categories') }}</option>
          <option v-for="cat in categories" :key="cat.id" :value="cat.id">
            {{ cat.name }}
          </option>
        </select>
      </div>
      <div class="field-wrap">
        <select v-model="filterStatus" class="field">
          <option value="">{{ $t('products.filter_all_status') }}</option>
          <option value="available">Available</option>
          <option value="sold">Sold</option>
          <option value="reserved">Reserved</option>
        </select>
      </div>
    </div>

    <!-- Table -->
    <div class="card overflow-hidden">
      <!-- Loading -->
      <div v-if="loading" class="state-block">
        <Icon name="refresh" :size="20" />
        <span>{{ $t('common.loading') }}</span>
      </div>

      <!-- Empty -->
      <div v-else-if="products.length === 0" class="state-block state-empty">
        <Icon name="package" :size="32" />
        <p>{{ $t('products.empty') }}</p>
      </div>

      <!-- Data -->
      <table v-else class="data-table">
        <thead>
          <tr>
            <th style="width: 56px">ID</th>
            <th>{{ $t('products.col_category') }}</th>
            <th>{{ $t('products.col_content') }}</th>
            <th>{{ $t('common.status') }}</th>
            <th>{{ $t('products.col_buyer') }}</th>
            <th>{{ $t('common.created_at') }}</th>
            <th>{{ $t('products.col_sold_at') }}</th>
            <th style="text-align: right">{{ $t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="product in products" :key="product.id" class="row-hover">
            <td class="mono faint">{{ product.id }}</td>
            <td class="ink">{{ product.type_name || '—' }}</td>
            <td>
              <span class="chip-code content-chip" :title="product.content">
                {{ maskContent(product.content) }}
              </span>
            </td>
            <td>
              <span class="badge" :class="statusBadge[product.status]">
                {{ product.status }}
              </span>
            </td>
            <td class="buyer-cell">
              <template v-if="product.status === 'sold' && product.buyer_id">
                {{ $t('products.buyer_user', { id: product.buyer_id }) }}
                <span v-if="product.order_id" class="faint">
                  {{ $t('products.buyer_order', { id: product.order_id }) }}
                </span>
              </template>
              <template v-else>—</template>
            </td>
            <td class="muted nowrap">{{ formatDate(product.created_at) }}</td>
            <td class="muted nowrap">{{ formatDate(product.sold_at) }}</td>
            <td style="text-align: right">
              <button
                v-if="product.status === 'available'"
                class="btn btn-ghost btn-sm"
                :style="{ color: 'var(--red-fg)' }"
                :disabled="deleteLoading === product.id"
                :title="$t('products.delete_title')"
                @click="deleteProduct(product.id)"
              >
                <Icon name="trash" :size="15" />
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    <div v-if="totalPages > 1" class="pagination">
      <p class="page-info">
        {{ $t('products.page_info', { page, total: totalPages, count: total }) }}
      </p>
      <div class="page-actions">
        <button
          class="btn btn-secondary btn-sm"
          :disabled="page <= 1"
          @click="page--"
        >
          <Icon name="arrowLeft" :size="15" />
          {{ $t('common.prev') }}
        </button>
        <button
          class="btn btn-secondary btn-sm"
          :disabled="page >= totalPages"
          @click="page++"
        >
          {{ $t('common.next') }}
          <Icon name="arrowRight" :size="15" />
        </button>
      </div>
    </div>

    <!-- Import Modal -->
    <div
      v-if="showImportModal"
      class="modal-overlay"
      @click.self="showImportModal = false"
    >
      <div class="card modal-panel">
        <h2 class="modal-title">{{ $t('products.import_title') }}</h2>

        <div class="modal-form">
          <!-- Category select -->
          <div>
            <label class="label">{{ $t('products.col_category') }}</label>
            <select v-model="importCategoryId" class="field">
              <option v-for="cat in categories" :key="cat.id" :value="cat.id">
                {{ cat.name }}
              </option>
            </select>
          </div>

          <!-- Textarea -->
          <div>
            <label class="label">{{ $t('products.import_content_label') }}</label>
            <textarea
              v-model="importText"
              rows="8"
              class="field mono"
              style="resize: vertical"
              placeholder="account1@mail.com|password1&#10;account2@mail.com|password2&#10;account3@mail.com|password3"
            ></textarea>
          </div>

          <!-- File upload -->
          <div>
            <label class="label">{{ $t('products.import_file_label') }}</label>
            <div class="upload-row">
              <label class="btn btn-secondary">
                <Icon name="upload" :size="16" />
                {{ $t('products.import_choose_file') }}
                <input type="file" accept=".txt" class="upload-input" @change="handleFileUpload" />
              </label>
              <span class="upload-hint">{{ $t('products.import_file_hint') }}</span>
            </div>
          </div>

          <!-- Preview count -->
          <div v-if="importPreviewCount > 0" class="info-box">
            <Icon name="package" :size="16" />
            <span>{{ $t('products.import_preview', { count: importPreviewCount }) }}</span>
          </div>

          <!-- Error -->
          <div v-if="importError" class="result-box result-error">
            <Icon name="warning" :size="16" :style="{ flexShrink: 0 }" />
            <span>{{ importError }}</span>
          </div>

          <!-- Result -->
          <div v-if="importResult" class="result-stack">
            <div class="result-box result-success">
              <Icon name="check" :size="16" :style="{ flexShrink: 0 }" />
              <span>{{ $t('products.import_success', { count: importResult.imported }) }}</span>
            </div>
            <div v-if="importResult.duplicates.length > 0" class="result-box result-warning">
              <Icon name="warning" :size="16" :style="{ flexShrink: 0 }" />
              <span>{{ $t('products.import_duplicates', { count: importResult.duplicates.length }) }}</span>
            </div>
            <div v-if="importResult.errors.length > 0" class="result-box result-error">
              <Icon name="close" :size="16" :style="{ flexShrink: 0 }" />
              <span>{{ $t('products.import_errors', { errors: importResult.errors.join(', ') }) }}</span>
            </div>
          </div>

          <!-- Actions -->
          <div class="modal-actions">
            <button class="btn btn-secondary" @click="showImportModal = false">
              {{ $t('common.cancel') }}
            </button>
            <button
              class="btn btn-primary"
              :disabled="importLoading || importPreviewCount === 0"
              @click="submitImport"
            >
              <Icon v-if="!importLoading" name="check" :size="16" />
              {{ importLoading ? $t('products.importing') : $t('products.import_confirm') }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;
}
.page-title {
  font-size: 1.5rem;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--ink);
}
.page-subtitle {
  margin-top: 0.25rem;
  font-size: 0.875rem;
  color: var(--muted);
}

/* ---- Filters ---- */
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.field-wrap {
  min-width: 200px;
}

/* ---- Table cells ---- */
.ink {
  color: var(--ink);
}
.muted {
  color: var(--muted);
  font-size: 0.75rem;
}
.faint {
  color: var(--faint);
}
.nowrap {
  white-space: nowrap;
}
.content-chip {
  display: inline-block;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: middle;
}
.buyer-cell {
  font-size: 0.75rem;
  color: var(--ink-soft);
  white-space: nowrap;
}

/* ---- State blocks ---- */
.state-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  padding: 3rem 1rem;
  color: var(--muted);
  font-size: 0.875rem;
}
.state-empty {
  color: var(--faint);
}

/* ---- Pagination ---- */
.pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 1rem;
}
.page-info {
  font-size: 0.8125rem;
  color: var(--muted);
}
.page-actions {
  display: flex;
  gap: 0.5rem;
}

/* ---- Modal ---- */
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(0, 0, 0, 0.4);
}
.modal-panel {
  width: 100%;
  max-width: 32rem;
  max-height: 90vh;
  overflow-y: auto;
  padding: 1.5rem;
}
.modal-title {
  font-size: 1.0625rem;
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 1rem;
}
.modal-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  padding-top: 0.5rem;
}

/* ---- File upload ---- */
.upload-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.upload-input {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.upload-hint {
  font-size: 0.75rem;
  color: var(--faint);
}

/* ---- Info / result boxes ---- */
.info-box {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
  color: var(--blue-fg);
  background: var(--blue-bg);
  border-radius: var(--radius);
  padding: 0.625rem 0.75rem;
}
.result-stack {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.result-box {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8125rem;
  border-radius: var(--radius);
  padding: 0.625rem 0.75rem;
}
.result-success {
  color: var(--green-fg);
  background: var(--green-bg);
}
.result-warning {
  color: var(--yellow-fg);
  background: var(--yellow-bg);
}
.result-error {
  color: var(--red-fg);
  background: var(--red-bg);
}
</style>
