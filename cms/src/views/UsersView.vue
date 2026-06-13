<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/api/client'
import Icon from '@/components/Icon.vue'
import { formatMoney } from '@/utils/format'
import { useExchangeRate } from '@/composables/useExchangeRate'

const { t } = useI18n()
// Tỷ giá dùng chung VND/USD (R4.3). rate=null → VND-only (R4.4).
const { rate, load: loadRate } = useExchangeRate()

// Types
interface User {
  id: number
  telegram_id: number
  username: string | null
  first_name: string | null
  balance: number
  is_active: number
  banned_at: string | null
  region: 'vietnam' | 'international' | null
  language: string | null
  last_interaction_at: string | null
  created_at: string
  updated_at: string
}

interface Transaction {
  id: number
  user_id: number
  type: string
  amount: number
  balance_before: number
  balance_after: number
  reference_type: string | null
  reference_id: number | null
  description: string | null
  status: string
  created_at: string
}

interface Order {
  id: number
  user_id: number
  product_id: number
  quantity: number
  total_amount: number
  status: string
  created_at: string
  product_name: string | null
  category_name: string | null
}

interface UserDetail {
  user: User
  transactions: Transaction[]
  orders: Order[]
}

// State
const users = ref<User[]>([])
const loading = ref(false)
const search = ref('')
const page = ref(1)
const limit = ref(20)
const total = ref(0)

// Detail state
const selectedUser = ref<UserDetail | null>(null)
const detailLoading = ref(false)
const showDetail = ref(false)

// Adjust balance modal
const showAdjustModal = ref(false)
const adjustAmount = ref<number | null>(null)
const adjustReason = ref('')
const adjustLoading = ref(false)
const adjustError = ref('')

// Ban / unban
const banLoading = ref(false)

// Đổi vùng (R5.4)
const regionLoading = ref(false)
async function setUserRegion(region: 'vietnam' | 'international') {
  if (!selectedUser.value) return
  if (selectedUser.value.user.region === region) return
  regionLoading.value = true
  try {
    const res = await api.put(`/users/${selectedUser.value.user.id}/region`, { region })
    if (res.success) {
      await fetchUserDetail(selectedUser.value.user.id)
      await fetchUsers()
    }
  } catch {
    // handled by api client
  } finally {
    regionLoading.value = false
  }
}

// Computed
const totalPages = () => Math.ceil(total.value / limit.value)

// Fetch users
async function fetchUsers() {
  loading.value = true
  try {
    const params = new URLSearchParams({
      page: String(page.value),
      limit: String(limit.value),
    })
    if (search.value) {
      params.set('search', search.value)
    }
    const res = await api.get<User[]>(`/users?${params.toString()}`)
    if (res.success && res.data) {
      users.value = res.data
      total.value = res.meta?.total ?? 0
    }
  } catch {
    // handled by api client
  } finally {
    loading.value = false
  }
}

// Fetch user detail
async function fetchUserDetail(userId: number) {
  detailLoading.value = true
  showDetail.value = true
  try {
    const res = await api.get<UserDetail>(`/users/${userId}`)
    if (res.success && res.data) {
      selectedUser.value = res.data
    }
  } catch {
    // handled by api client
  } finally {
    detailLoading.value = false
  }
}

// Close detail
function closeDetail() {
  showDetail.value = false
  selectedUser.value = null
}

// Open adjust modal
function openAdjustModal() {
  adjustAmount.value = null
  adjustReason.value = ''
  adjustError.value = ''
  showAdjustModal.value = true
}

// Submit balance adjustment
async function submitAdjust() {
  if (!selectedUser.value || adjustAmount.value === null) return

  if (!adjustReason.value.trim()) {
    adjustError.value = t('users.reason_required')
    return
  }

  adjustLoading.value = true
  adjustError.value = ''

  try {
    const res = await api.post(`/users/${selectedUser.value.user.id}/adjust-balance`, {
      amount: adjustAmount.value,
      reason: adjustReason.value.trim(),
    })

    if (res.success) {
      showAdjustModal.value = false
      // Refresh detail and list
      await fetchUserDetail(selectedUser.value.user.id)
      await fetchUsers()
    } else {
      adjustError.value = res.error || t('common.error')
    }
  } catch {
    adjustError.value = t('common.error')
  } finally {
    adjustLoading.value = false
  }
}

// Toggle ban / unban (no reason needed)
async function setBan(ban: boolean) {
  if (!selectedUser.value) return

  banLoading.value = true
  try {
    const action = ban ? 'ban' : 'unban'
    const res = await api.post(`/users/${selectedUser.value.user.id}/${action}`)
    if (res.success) {
      await fetchUserDetail(selectedUser.value.user.id)
      await fetchUsers()
    }
  } catch {
    // handled by api client
  } finally {
    banLoading.value = false
  }
}

// Search debounce
let searchTimeout: ReturnType<typeof setTimeout> | null = null
function onSearch() {
  if (searchTimeout) clearTimeout(searchTimeout)
  searchTimeout = setTimeout(() => {
    page.value = 1
    fetchUsers()
  }, 300)
}

// Pagination
function goToPage(p: number) {
  if (p < 1 || p > totalPages()) return
  page.value = p
  fetchUsers()
}

// Format helpers

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  const day = String(d.getDate()).padStart(2, '0')
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const year = d.getFullYear()
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  return `${day}/${month}/${year} ${hours}:${minutes}`
}

function transactionTypeLabel(type: string): string {
  const map: Record<string, string> = {
    deposit: t('transaction.type_deposit'),
    purchase: t('transaction.type_purchase'),
    refund: t('transaction.type_refund'),
    adjustment: t('transaction.type_adjustment'),
  }
  return map[type] || type
}

// Badge variant per transaction type — deposit=green, purchase=blue, refund=yellow, adjustment=gray
function transactionBadgeClass(type: string): string {
  const map: Record<string, string> = {
    deposit: 'badge-green',
    purchase: 'badge-blue',
    refund: 'badge-yellow',
    adjustment: 'badge-gray',
  }
  return map[type] || 'badge-gray'
}

// User display name for headings
function userDisplayName(user: User): string {
  return user.username || user.first_name || String(user.telegram_id)
}

watch(search, onSearch)
onMounted(() => {
  fetchUsers()
  loadRate()
})
</script>

<template>
  <div class="animate-in">
    <!-- Subtitle + search -->
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-5">
      <p class="text-[13px]" style="color: var(--muted)">{{ $t('users.subtitle', { count: total }) }}</p>

      <div class="relative w-full sm:max-w-[320px]">
        <span class="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3" style="color: var(--faint)">
          <Icon name="search" :size="16" />
        </span>
        <input
          v-model="search"
          type="text"
          :placeholder="$t('users.search_placeholder')"
          class="field"
          style="padding-left: 2.25rem"
        />
      </div>
    </div>

    <!-- Table -->
    <div class="card overflow-hidden">
      <div class="overflow-x-auto">
        <table class="data-table">
          <thead>
            <tr>
              <th>{{ $t('users.col_id') }}</th>
              <th>{{ $t('users.col_telegram') }}</th>
              <th>{{ $t('users.col_username') }}</th>
              <th>{{ $t('users.col_name') }}</th>
              <th class="text-right">{{ $t('users.col_balance') }}</th>
              <th>{{ $t('common.status') }}</th>
              <th>{{ $t('users.col_last') }}</th>
              <th>{{ $t('users.col_created') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td colspan="8" class="text-center" style="padding-top: 2rem; padding-bottom: 2rem; color: var(--muted)">
                {{ $t('common.loading') }}
              </td>
            </tr>
            <tr v-else-if="users.length === 0">
              <td colspan="8" class="text-center" style="padding-top: 2rem; padding-bottom: 2rem; color: var(--muted)">
                {{ $t('users.empty') }}
              </td>
            </tr>
            <tr
              v-for="user in users"
              :key="user.id"
              class="row-hover"
              @click="fetchUserDetail(user.id)"
            >
              <td>{{ user.id }}</td>
              <td class="mono">{{ user.telegram_id }}</td>
              <td>{{ user.username || '—' }}</td>
              <td>{{ user.first_name || '—' }}</td>
              <td class="text-right" style="font-weight: 500; color: var(--ink)">
                {{ formatMoney(user.balance, rate) }}
              </td>
              <td>
                <span class="badge" :class="user.is_active === 0 ? 'badge-red' : 'badge-green'">
                  {{ user.is_active === 0 ? $t('users.status_banned') : $t('users.status_active') }}
                </span>
              </td>
              <td style="color: var(--muted)">
                {{ user.last_interaction_at ? formatDate(user.last_interaction_at) : '—' }}
              </td>
              <td style="color: var(--muted)">
                {{ formatDate(user.created_at) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Pagination -->
      <div
        v-if="totalPages() > 1"
        class="flex items-center justify-between px-4 py-3"
        style="border-top: 1px solid var(--border)"
      >
        <span class="text-[13px]" style="color: var(--muted)">
          {{ $t('common.page_of', { page, total: totalPages() }) }}
        </span>
        <div class="flex gap-2">
          <button
            class="btn btn-secondary btn-sm"
            :disabled="page <= 1"
            @click="goToPage(page - 1)"
          >
            <Icon name="arrowLeft" :size="14" />
            {{ $t('common.prev') }}
          </button>
          <button
            class="btn btn-secondary btn-sm"
            :disabled="page >= totalPages()"
            @click="goToPage(page + 1)"
          >
            {{ $t('common.next') }}
            <Icon name="arrowRight" :size="14" />
          </button>
        </div>
      </div>
    </div>

    <!-- User Detail Slide-over -->
    <div v-if="showDetail" class="fixed inset-0 z-50 flex justify-end">
      <!-- Backdrop -->
      <div class="fixed inset-0" style="background: rgba(26, 26, 24, 0.4)" @click="closeDetail" />

      <!-- Panel -->
      <div
        class="relative w-full max-w-lg overflow-y-auto"
        style="background: var(--surface); border-left: 1px solid var(--border)"
      >
        <!-- Loading -->
        <div v-if="detailLoading" class="flex items-center justify-center h-full">
          <span style="color: var(--muted)">{{ $t('common.loading') }}</span>
        </div>

        <!-- Content -->
        <div v-else-if="selectedUser" class="p-6">
          <!-- Header -->
          <div class="flex items-center justify-between mb-6">
            <div class="min-w-0">
              <h2 class="text-lg font-semibold truncate" style="color: var(--ink)">
                {{ userDisplayName(selectedUser.user) }}
              </h2>
              <p class="text-[13px]" style="color: var(--muted)">{{ $t('users.detail') }}</p>
            </div>
            <button class="btn btn-ghost btn-icon" @click="closeDetail">
              <Icon name="close" :size="18" />
            </button>
          </div>

          <!-- User Info -->
          <div class="card mb-6" style="background: var(--surface-alt)">
            <dl class="px-4 py-3">
              <div class="flex items-center justify-between py-1.5">
                <dt class="text-[13px]" style="color: var(--muted)">{{ $t('users.col_id') }}</dt>
                <dd class="text-[13px] font-medium" style="color: var(--ink)">{{ selectedUser.user.id }}</dd>
              </div>
              <div class="flex items-center justify-between py-1.5">
                <dt class="text-[13px]" style="color: var(--muted)">{{ $t('users.col_telegram') }}</dt>
                <dd class="mono" style="color: var(--ink)">{{ selectedUser.user.telegram_id }}</dd>
              </div>
              <div class="flex items-center justify-between py-1.5">
                <dt class="text-[13px]" style="color: var(--muted)">{{ $t('users.col_username') }}</dt>
                <dd class="text-[13px]" style="color: var(--ink-soft)">{{ selectedUser.user.username || '—' }}</dd>
              </div>
              <div class="flex items-center justify-between py-1.5">
                <dt class="text-[13px]" style="color: var(--muted)">{{ $t('users.col_name') }}</dt>
                <dd class="text-[13px]" style="color: var(--ink-soft)">{{ selectedUser.user.first_name || '—' }}</dd>
              </div>
              <div class="flex items-center justify-between py-1.5">
                <dt class="text-[13px]" style="color: var(--muted)">{{ $t('users.col_balance') }}</dt>
                <dd class="text-[13px] font-semibold" style="color: var(--ink)">{{ formatMoney(selectedUser.user.balance, rate) }}</dd>
              </div>
              <div class="flex items-center justify-between py-1.5">
                <dt class="text-[13px]" style="color: var(--muted)">{{ $t('common.status') }}</dt>
                <dd>
                  <span class="badge" :class="selectedUser.user.is_active === 0 ? 'badge-red' : 'badge-green'">
                    {{ selectedUser.user.is_active === 0 ? $t('users.status_banned') : $t('users.status_active') }}
                  </span>
                </dd>
              </div>
              <div class="flex items-center justify-between py-1.5">
                <dt class="text-[13px]" style="color: var(--muted)">{{ $t('users.region') }}</dt>
                <dd class="flex items-center gap-1.5">
                  <button
                    type="button"
                    class="badge"
                    :class="selectedUser.user.region === 'vietnam' ? 'badge-green' : 'badge-gray'"
                    :disabled="regionLoading"
                    @click="setUserRegion('vietnam')"
                  >
                    {{ $t('users.region_vietnam') }}
                  </button>
                  <button
                    type="button"
                    class="badge"
                    :class="selectedUser.user.region === 'international' ? 'badge-green' : 'badge-gray'"
                    :disabled="regionLoading"
                    @click="setUserRegion('international')"
                  >
                    {{ $t('users.region_international') }}
                  </button>
                </dd>
              </div>
              <div
                v-if="selectedUser.user.is_active === 0 && selectedUser.user.banned_at"
                class="flex items-center justify-between py-1.5"
              >
                <dt class="text-[13px]" style="color: var(--muted)">{{ $t('users.banned_at') }}</dt>
                <dd class="text-[13px]" style="color: var(--red-fg)">{{ formatDate(selectedUser.user.banned_at) }}</dd>
              </div>
              <div class="flex items-center justify-between py-1.5">
                <dt class="text-[13px]" style="color: var(--muted)">{{ $t('users.col_created') }}</dt>
                <dd class="text-[13px]" style="color: var(--ink-soft)">{{ formatDate(selectedUser.user.created_at) }}</dd>
              </div>
            </dl>
          </div>

          <!-- Action Buttons -->
          <div class="flex flex-col gap-3 mb-6">
            <button class="btn btn-primary w-full" @click="openAdjustModal">
              <Icon name="coins" :size="16" />
              {{ $t('users.adjust_balance') }}
            </button>
            <button
              v-if="selectedUser.user.is_active === 1"
              class="btn btn-secondary w-full"
              style="color: var(--red-fg)"
              :disabled="banLoading"
              @click="setBan(true)"
            >
              <Icon name="lock" :size="16" />
              {{ banLoading ? $t('common.processing') : $t('users.ban') }}
            </button>
            <button
              v-else
              class="btn btn-secondary w-full"
              style="color: var(--green-fg)"
              :disabled="banLoading"
              @click="setBan(false)"
            >
              <Icon name="check" :size="16" />
              {{ banLoading ? $t('common.processing') : $t('users.unban') }}
            </button>
          </div>

          <!-- Transactions -->
          <div class="mb-6">
            <h3 class="text-[13px] font-semibold mb-3" style="color: var(--ink-soft)">
              {{ $t('users.recent_tx', { count: selectedUser.transactions.length }) }}
            </h3>
            <div
              v-if="selectedUser.transactions.length === 0"
              class="text-[13px] text-center py-4"
              style="color: var(--muted)"
            >
              {{ $t('users.no_tx') }}
            </div>
            <div v-else class="max-h-60 overflow-y-auto">
              <div
                v-for="tx in selectedUser.transactions"
                :key="tx.id"
                class="flex items-center justify-between py-2.5"
                style="border-bottom: 1px solid var(--border)"
              >
                <div class="flex items-center gap-2">
                  <span class="badge" :class="transactionBadgeClass(tx.type)">
                    {{ transactionTypeLabel(tx.type) }}
                  </span>
                  <span class="text-xs" style="color: var(--muted)">{{ formatDate(tx.created_at) }}</span>
                </div>
                <span
                  class="text-[13px] font-medium"
                  :style="{ color: tx.amount >= 0 ? 'var(--green-fg)' : 'var(--red-fg)' }"
                >
                  {{ tx.amount >= 0 ? '+' : '' }}{{ formatMoney(tx.amount, rate) }}
                </span>
              </div>
            </div>
          </div>

          <!-- Orders -->
          <div>
            <h3 class="text-[13px] font-semibold mb-3" style="color: var(--ink-soft)">
              {{ $t('users.recent_orders', { count: selectedUser.orders.length }) }}
            </h3>
            <div
              v-if="selectedUser.orders.length === 0"
              class="text-[13px] text-center py-4"
              style="color: var(--muted)"
            >
              {{ $t('users.no_orders') }}
            </div>
            <div v-else class="max-h-60 overflow-y-auto">
              <div
                v-for="order in selectedUser.orders"
                :key="order.id"
                class="flex items-center justify-between py-2.5"
                style="border-bottom: 1px solid var(--border)"
              >
                <div class="flex items-center gap-2 min-w-0">
                  <span class="text-[13px] font-medium truncate" style="color: var(--ink-soft)">
                    {{ order.product_name || 'N/A' }}
                  </span>
                  <span v-if="order.category_name" class="text-xs truncate" style="color: var(--muted)">
                    {{ order.category_name }}
                  </span>
                  <span class="text-xs" style="color: var(--muted)">x{{ order.quantity }}</span>
                </div>
                <div class="text-right flex-shrink-0 ml-2">
                  <div class="text-[13px] font-medium" style="color: var(--ink)">
                    {{ formatMoney(order.total_amount, rate) }}
                  </div>
                  <div class="text-xs" style="color: var(--muted)">{{ formatDate(order.created_at) }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Adjust Balance Modal -->
    <div v-if="showAdjustModal" class="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <!-- Backdrop -->
      <div class="fixed inset-0" style="background: rgba(26, 26, 24, 0.5)" @click="showAdjustModal = false" />

      <!-- Modal -->
      <div class="card relative w-full max-w-sm p-6">
        <h3 class="text-base font-semibold mb-4" style="color: var(--ink)">{{ $t('users.adjust_title') }}</h3>

        <div v-if="selectedUser" class="mb-4 text-[13px]" style="color: var(--muted)">
          {{ $t('users.adjust_user') }}:
          <span class="font-medium" style="color: var(--ink-soft)">
            {{ userDisplayName(selectedUser.user) }}
          </span>
          <br />
          {{ $t('users.adjust_current') }}:
          <span class="font-medium" style="color: var(--ink)">{{ formatMoney(selectedUser.user.balance, rate) }}</span>
        </div>

        <div
          v-if="adjustError"
          class="mb-4 px-3 py-2 text-[13px] rounded-md"
          style="background: var(--red-bg); color: var(--red-fg)"
        >
          {{ adjustError }}
        </div>

        <div class="space-y-4">
          <div>
            <label class="label">{{ $t('users.adjust_amount') }}</label>
            <input
              v-model.number="adjustAmount"
              type="number"
              :placeholder="$t('users.adjust_amount_ph')"
              class="field"
            />
            <p class="mt-1 text-xs" style="color: var(--faint)">
              {{ $t('users.adjust_amount_hint') }}
            </p>
          </div>

          <div>
            <label class="label">
              {{ $t('users.adjust_reason') }} <span style="color: var(--red-fg)">*</span>
            </label>
            <textarea
              v-model="adjustReason"
              rows="3"
              :placeholder="$t('users.adjust_reason_ph')"
              class="field"
              style="resize: none"
            />
          </div>
        </div>

        <div class="flex gap-3 mt-6">
          <button class="btn btn-secondary flex-1" @click="showAdjustModal = false">
            {{ $t('common.cancel') }}
          </button>
          <button
            class="btn btn-primary flex-1"
            :disabled="adjustLoading || adjustAmount === null || adjustAmount === 0"
            @click="submitAdjust"
          >
            {{ adjustLoading ? $t('common.processing') : $t('common.confirm') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
