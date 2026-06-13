<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/api/client'
import Icon from '@/components/Icon.vue'
import { formatMoney } from '@/utils/format'
import { useExchangeRate } from '@/composables/useExchangeRate'

const { t } = useI18n()
// Tỷ giá dùng chung VND/USD (R4.3). rate=null → VND-only (R4.4).
const { rate, load: loadRate } = useExchangeRate()

interface Order {
  id: number
  user_id: number
  product_id: number
  quantity: number
  total_amount: number
  transaction_id: number | null
  status: string
  created_at: string
  product_name: string
  product_emoji: string | null
  product_type_name: string
  unit_price: number
  telegram_id: number
  username: string | null
  first_name: string | null
}

interface OrderDetail extends Order {
  user_balance: number
  items: OrderItem[]
}

interface OrderItem {
  id: number
  product_item_id: number
  created_at: string
  content: string
  product_status: string
  sold_at: string
}

const orders = ref<Order[]>([])
const selectedOrder = ref<OrderDetail | null>(null)
const showDetail = ref(false)
const loading = ref(false)
const detailLoading = ref(false)

// Pagination
const page = ref(1)
const limit = ref(20)
const total = ref(0)

// Filters
const filterStatus = ref('')
const filterProductId = ref('')
const filterDateFrom = ref('')
const filterDateTo = ref('')

// Products for order filter dropdown. Orders reference products, not categories.
const products = ref<{ id: number; name: string; product_type_name: string | null }[]>([])

const totalPages = () => Math.ceil(total.value / limit.value) || 1

async function loadProducts() {
  const res = await api.get<any[]>('/products?limit=100&sort=name&order=asc')
  if (res.success && res.data) {
    products.value = res.data.map((p: any) => ({
      id: p.id,
      name: p.name,
      product_type_name: p.product_type_name ?? null,
    }))
  }
}

async function loadOrders() {
  loading.value = true
  try {
    const params = new URLSearchParams()
    params.set('page', String(page.value))
    params.set('limit', String(limit.value))
    params.set('order', 'desc')
    params.set('sort', 'created_at')

    if (filterStatus.value) params.set('status', filterStatus.value)
    if (filterProductId.value) params.set('product_id', filterProductId.value)
    if (filterDateFrom.value) params.set('from', filterDateFrom.value)
    if (filterDateTo.value) params.set('to', filterDateTo.value)

    const res = await api.get<Order[]>(`/orders?${params.toString()}`)
    if (res.success && res.data) {
      orders.value = res.data
      total.value = res.meta?.total || 0
    }
  } finally {
    loading.value = false
  }
}

async function viewDetail(orderId: number) {
  detailLoading.value = true
  showDetail.value = true
  try {
    const res = await api.get<OrderDetail>(`/orders/${orderId}`)
    if (res.success && res.data) {
      selectedOrder.value = res.data
    }
  } finally {
    detailLoading.value = false
  }
}

function closeDetail() {
  showDetail.value = false
  selectedOrder.value = null
}

function applyFilters() {
  page.value = 1
  loadOrders()
}

function clearFilters() {
  filterStatus.value = ''
  filterProductId.value = ''
  filterDateFrom.value = ''
  filterDateTo.value = ''
  page.value = 1
  loadOrders()
}

function goToPage(p: number) {
  page.value = p
  loadOrders()
}


function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const day = String(d.getDate()).padStart(2, '0')
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const year = d.getFullYear()
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return `${day}/${month}/${year} ${hours}:${minutes}`
}

function statusBadge(status: string) {
  switch (status) {
    case 'completed':
      return 'badge-green'
    case 'refunded':
      return 'badge-red'
    default:
      return 'badge-gray'
  }
}

function statusLabel(status: string) {
  return status === 'completed' ? t('orders.status_completed') : t('orders.status_refunded')
}

function productOptionLabel(product: { name: string; product_type_name: string | null }): string {
  return product.product_type_name ? `${product.name} - ${product.product_type_name}` : product.name
}

onMounted(() => {
  loadRate()
  loadProducts()
  loadOrders()
})
</script>

<template>
  <div class="animate-in">
    <!-- Header -->
    <div class="page-head">
      <div>
        <h1 class="page-title">{{ $t('orders.title') }}</h1>
        <p class="page-subtitle">{{ $t('orders.subtitle', { count: total }) }}</p>
      </div>
    </div>

    <!-- Filters -->
    <div class="filters">
      <div class="field-wrap">
        <select v-model="filterStatus" class="field">
          <option value="">{{ $t('orders.filter_all_status') }}</option>
          <option value="completed">{{ $t('orders.status_completed') }}</option>
          <option value="refunded">{{ $t('orders.status_refunded') }}</option>
        </select>
      </div>

      <div class="field-wrap">
        <select v-model="filterProductId" class="field">
          <option value="">{{ $t('orders.filter_all_product') }}</option>
          <option v-for="product in products" :key="product.id" :value="String(product.id)">
            {{ productOptionLabel(product) }}
          </option>
        </select>
      </div>

      <div class="field-wrap">
        <input v-model="filterDateFrom" type="date" class="field" />
      </div>

      <div class="field-wrap">
        <input v-model="filterDateTo" type="date" class="field" />
      </div>

      <div class="filter-actions">
        <button class="btn btn-primary" @click="applyFilters">
          <Icon name="search" :size="16" />
          {{ $t('common.filter') }}
        </button>
        <button class="btn btn-secondary" @click="clearFilters">{{ $t('common.clear') }}</button>
      </div>
    </div>

    <!-- Table -->
    <div class="card overflow-hidden">
      <!-- Loading -->
      <div v-if="loading" class="state-block">
        <div class="spinner"></div>
        <span>{{ $t('common.loading') }}</span>
      </div>

      <!-- Empty -->
      <div v-else-if="orders.length === 0" class="state-block state-empty">
        <Icon name="receipt" :size="32" />
        <p>{{ $t('orders.empty') }}</p>
      </div>

      <!-- Data -->
      <table v-else class="data-table">
        <thead>
          <tr>
            <th style="width: 64px">ID</th>
            <th>{{ $t('orders.col_buyer') }}</th>
            <th>{{ $t('orders.col_product') }}</th>
            <th style="width: 56px">{{ $t('orders.col_qty') }}</th>
            <th>{{ $t('orders.col_total') }}</th>
            <th>{{ $t('common.status') }}</th>
            <th>{{ $t('common.time') }}</th>
            <th style="width: 40px"></th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="order in orders"
            :key="order.id"
            class="row-hover"
            @click="viewDetail(order.id)"
          >
            <td class="mono faint">#{{ order.id }}</td>
            <td>
              <div class="ink">{{ order.first_name || order.username || '—' }}</div>
              <div class="muted">ID: {{ order.telegram_id }}</div>
            </td>
            <td>
              <div class="ink">{{ order.product_name }}</div>
              <div class="muted">{{ order.product_type_name }}</div>
            </td>
            <td>{{ order.quantity }}</td>
            <td class="ink amount-cell">{{ formatMoney(order.total_amount, rate) }}</td>
            <td>
              <span class="badge" :class="statusBadge(order.status)">
                {{ statusLabel(order.status) }}
              </span>
            </td>
            <td class="muted nowrap">{{ formatDate(order.created_at) }}</td>
            <td class="chevron-cell">
              <Icon name="chevronRight" :size="16" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Pagination -->
    <div v-if="total > limit" class="pagination">
      <p class="page-info">
        {{ $t('orders.page_info', { page, total: totalPages(), count: total }) }}
      </p>
      <div class="page-actions">
        <button
          class="btn btn-secondary btn-sm"
          :disabled="page <= 1"
          @click="goToPage(page - 1)"
        >
          <Icon name="arrowLeft" :size="15" />
          {{ $t('common.prev') }}
        </button>
        <button
          class="btn btn-secondary btn-sm"
          :disabled="page >= totalPages()"
          @click="goToPage(page + 1)"
        >
          {{ $t('common.next') }}
          <Icon name="arrowRight" :size="15" />
        </button>
      </div>
    </div>

    <!-- Order Detail Modal -->
    <div v-if="showDetail" class="modal-overlay" @click.self="closeDetail">
      <div class="card modal-panel">
        <!-- Header -->
        <div class="modal-head">
          <h2 class="modal-title">{{ $t('orders.detail', { id: selectedOrder?.id }) }}</h2>
          <button class="btn btn-ghost btn-icon" @click="closeDetail">
            <Icon name="close" :size="18" />
          </button>
        </div>

        <!-- Loading -->
        <div v-if="detailLoading" class="state-block">
          <div class="spinner"></div>
          <span>{{ $t('common.loading') }}</span>
        </div>

        <!-- Detail -->
        <div v-else-if="selectedOrder" class="modal-body">
          <!-- Order Info -->
          <div class="info-grid">
            <div class="info-item">
              <span class="label">{{ $t('common.status') }}</span>
              <span class="badge" :class="statusBadge(selectedOrder.status)">
                {{ statusLabel(selectedOrder.status) }}
              </span>
            </div>
            <div class="info-item">
              <span class="label">{{ $t('common.time') }}</span>
              <span class="info-value">{{ formatDate(selectedOrder.created_at) }}</span>
            </div>
            <div class="info-item">
              <span class="label">{{ $t('orders.col_product') }}</span>
              <span class="info-value">{{ selectedOrder.product_name }}</span>
            </div>
            <div class="info-item">
              <span class="label">{{ $t('orders.col_unit_price') }}</span>
              <span class="info-value">{{ formatMoney(selectedOrder.unit_price, rate) }}</span>
            </div>
            <div class="info-item">
              <span class="label">{{ $t('orders.col_qty') }}</span>
              <span class="info-value">{{ selectedOrder.quantity }}</span>
            </div>
            <div class="info-item">
              <span class="label">{{ $t('orders.col_total') }}</span>
              <span class="info-value strong">{{ formatMoney(selectedOrder.total_amount, rate) }}</span>
            </div>
          </div>

          <!-- User Info -->
          <div class="modal-section">
            <h3 class="section-title">
              <Icon name="user" :size="16" />
              {{ $t('orders.buyer_info') }}
            </h3>
            <div class="user-grid">
              <div class="user-row">
                <span class="muted">{{ $t('common.name') }}:</span>
                <span class="ink">{{ selectedOrder.first_name || '—' }}</span>
              </div>
              <div class="user-row">
                <span class="muted">Username:</span>
                <span class="ink">{{ selectedOrder.username ? '@' + selectedOrder.username : '—' }}</span>
              </div>
              <div class="user-row">
                <span class="muted">Telegram ID:</span>
                <span class="ink">{{ selectedOrder.telegram_id }}</span>
              </div>
              <div class="user-row">
                <span class="muted">{{ $t('orders.current_balance') }}:</span>
                <span class="ink">{{ formatMoney(selectedOrder.user_balance, rate) }}</span>
              </div>
            </div>
          </div>

          <!-- Order Items -->
          <div class="modal-section">
            <h3 class="section-title">
              <Icon name="package" :size="16" />
              {{ $t('orders.delivered_items', { count: selectedOrder.items.length }) }}
            </h3>
            <div class="items-list">
              <div
                v-for="(item, idx) in selectedOrder.items"
                :key="item.id"
                class="item-row"
              >
                <div class="item-left">
                  <span class="faint">{{ idx + 1 }}.</span>
                  <span class="mono item-content" :title="item.content">{{ item.content }}</span>
                </div>
                <span class="muted nowrap">
                  {{ item.sold_at ? formatDate(item.sold_at) : '' }}
                </span>
              </div>
              <div v-if="selectedOrder.items.length === 0" class="items-empty">
                {{ $t('orders.no_items') }}
              </div>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="modal-foot">
          <button class="btn btn-secondary" @click="closeDetail">{{ $t('common.close') }}</button>
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
  min-width: 180px;
}
.filter-actions {
  display: flex;
  gap: 0.5rem;
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
.amount-cell {
  font-weight: 500;
}
.chevron-cell {
  color: var(--faint);
  text-align: right;
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

/* ---- CSS border spinner ---- */
.spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--ink);
  border-radius: 9999px;
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spinner {
    animation: none;
  }
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
  max-width: 42rem;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid var(--border);
}
.modal-title {
  font-size: 1.0625rem;
  font-weight: 600;
  color: var(--ink);
}
.modal-body {
  padding: 1.5rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.modal-foot {
  display: flex;
  justify-content: flex-end;
  padding: 1rem 1.5rem;
  border-top: 1px solid var(--border);
}

/* ---- Info grid ---- */
.info-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1rem;
}
.info-item {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.info-value {
  font-size: 0.875rem;
  color: var(--ink);
}
.info-value.strong {
  font-weight: 600;
}

/* ---- Sections ---- */
.modal-section {
  border-top: 1px solid var(--border);
  padding-top: 1.25rem;
}
.section-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--ink-soft);
  margin-bottom: 0.75rem;
}
.user-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.625rem;
  font-size: 0.875rem;
}
.user-row {
  display: flex;
  gap: 0.375rem;
}
.user-row .muted {
  font-size: 0.875rem;
}

/* ---- Items list ---- */
.items-list {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  max-height: 15rem;
  overflow-y: auto;
}
.item-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  background: var(--surface-alt);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.5rem 0.75rem;
}
.item-left {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
}
.item-content {
  font-size: 0.75rem;
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.items-empty {
  text-align: center;
  padding: 0.75rem;
  font-size: 0.875rem;
  color: var(--faint);
}
</style>
