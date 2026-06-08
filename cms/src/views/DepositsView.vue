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

interface Deposit {
  id: number
  user_id: number
  provider: 'sepay' | 'cryptobot' | 'payos'
  amount: number
  status: 'pending' | 'completed' | 'expired' | 'cancelled' | 'awaiting_credit'
  correlation_ref: string | null
  provider_txn_id: string | null
  metadata: string | null
  completed_at: string | null
  expired_at: string | null
  created_at: string
  telegram_id: number | null
  username: string | null
}

/** Dữ liệu đặc thù provider lấy từ cột chung `metadata` (JSON). */
interface DepositMeta {
  asset: string | null
  usdt_amount: string | null
  exchange_rate: number | null
  bank_ref: string | null
}

/** Parse cột `metadata` (JSON) sang các trường hiển thị; lỗi/null → tất cả null. */
function depositMeta(d: Deposit): DepositMeta {
  if (!d.metadata) return { asset: null, usdt_amount: null, exchange_rate: null, bank_ref: null }
  try {
    const m = JSON.parse(d.metadata) as Record<string, unknown>
    const asset = typeof m.asset === 'string' ? m.asset : null
    const usdt = m.usdt_amount
    const usdt_amount = usdt === null || usdt === undefined ? null : String(usdt)
    const rate = Number(m.exchange_rate)
    const exchange_rate = Number.isFinite(rate) && rate > 0 ? rate : null
    const bank_ref = typeof m.bank_ref === 'string' ? m.bank_ref : null
    return { asset, usdt_amount, exchange_rate, bank_ref }
  } catch {
    return { asset: null, usdt_amount: null, exchange_rate: null, bank_ref: null }
  }
}

const deposits = ref<Deposit[]>([])
const loading = ref(false)
const error = ref('')
const statusFilter = ref('')
const page = ref(1)
const limit = ref(20)
const total = ref(0)

const approvingId = ref<number | null>(null)
const approveError = ref('')
const approveSuccess = ref('')

const selectedDeposit = ref<Deposit | null>(null)

const statusOptions = [
  { value: '', label: 'common.all' },
  { value: 'pending', label: 'deposits.status_pending' },
  { value: 'completed', label: 'deposits.status_completed' },
  { value: 'awaiting_credit', label: 'deposits.status_awaiting_credit' },
  { value: 'expired', label: 'deposits.status_expired' },
  { value: 'cancelled', label: 'deposits.status_cancelled' },
]

const totalPages = () => Math.ceil(total.value / limit.value)


function formatDate(dateStr: string): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function statusBadge(status: string): string {
  switch (status) {
    case 'pending': return 'badge-yellow'
    case 'completed': return 'badge-green'
    case 'awaiting_credit': return 'badge-blue'
    case 'expired': return 'badge-gray'
    case 'cancelled': return 'badge-red'
    default: return 'badge-gray'
  }
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: 'deposits.status_pending',
    completed: 'deposits.status_completed',
    awaiting_credit: 'deposits.status_awaiting_credit',
    expired: 'deposits.status_expired',
    cancelled: 'deposits.status_cancelled',
  }
  return map[status] ? t(map[status]) : status
}

/** Nhãn provider hiển thị cho cột Phương thức (R20.6). */
function providerLabel(provider: string): string {
  switch (provider) {
    case 'cryptobot': return t('deposits.method_cryptobot')
    case 'payos': return t('deposits.method_payos')
    default: return t('deposits.method_sepay')
  }
}

/** Màu badge cho từng provider. */
function providerBadge(provider: string): string {
  switch (provider) {
    case 'cryptobot': return 'badge-blue'
    case 'payos': return 'badge-green'
    default: return 'badge-gray'
  }
}

/** Nhãn cho cột định danh giao dịch phía provider (`provider_txn_id`). */
function providerTxnLabel(provider: string): string {
  switch (provider) {
    case 'payos': return t('deposits.payos_link_id')
    case 'sepay': return t('deposits.sepay_tx')
    default: return t('deposits.txn_id')
  }
}

async function fetchDeposits() {
  loading.value = true
  error.value = ''
  try {
    let path = `/deposits?page=${page.value}&limit=${limit.value}`
    if (statusFilter.value) path += `&status=${statusFilter.value}`
    const res = await api.get<Deposit[]>(path)
    if (res.success && res.data) {
      deposits.value = res.data
      total.value = res.meta?.total ?? 0
    } else {
      error.value = res.error || t('common.error')
    }
  } catch {
    error.value = t('common.error')
  } finally {
    loading.value = false
  }
}

async function approveDeposit(deposit: Deposit) {
  if (approvingId.value) return
  approvingId.value = deposit.id
  approveError.value = ''
  approveSuccess.value = ''
  try {
    const res = await api.post<{ deposit_id: number; new_balance: number; approved_at: string }>(
      `/deposits/${deposit.id}/approve`
    )
    if (res.success && res.data) {
      approveSuccess.value = t('deposits.approve_ok', { balance: formatMoney(res.data.new_balance, rate.value) })
      selectedDeposit.value = null
      await fetchDeposits()
    } else {
      approveError.value = res.error || t('deposits.approve_failed')
    }
  } catch {
    approveError.value = t('common.error')
  } finally {
    approvingId.value = null
  }
}

function goToPage(p: number) {
  if (p < 1 || p > totalPages()) return
  page.value = p
}

function openDetail(deposit: Deposit) {
  selectedDeposit.value = deposit
}
function closeDetail() {
  selectedDeposit.value = null
}

watch(statusFilter, () => {
  page.value = 1
  fetchDeposits()
})
watch(page, () => {
  fetchDeposits()
})
onMounted(() => {
  fetchDeposits()
  loadRate()
})
</script>

<template>
  <div class="animate-in">
    <!-- Header -->
    <div class="mb-5">
      <p class="text-[13px]" style="color: var(--muted)">{{ $t('deposits.subtitle', { count: total }) }}</p>
    </div>

    <!-- Alerts -->
    <div
      v-if="approveSuccess"
      class="mb-4 flex items-center gap-2 rounded-md px-3 py-2.5 text-[13px]"
      style="background: var(--green-bg); color: var(--green-fg)"
    >
      <Icon name="check" :size="16" />
      <span class="flex-1">{{ approveSuccess }}</span>
      <button class="opacity-70 hover:opacity-100" @click="approveSuccess = ''"><Icon name="close" :size="14" /></button>
    </div>
    <div
      v-if="approveError"
      class="mb-4 flex items-center gap-2 rounded-md px-3 py-2.5 text-[13px]"
      style="background: var(--red-bg); color: var(--red-fg)"
    >
      <Icon name="warning" :size="16" />
      <span class="flex-1">{{ approveError }}</span>
      <button class="opacity-70 hover:opacity-100" @click="approveError = ''"><Icon name="close" :size="14" /></button>
    </div>

    <!-- Filter -->
    <div class="mb-4 flex items-center gap-2.5">
      <span class="text-[13px]" style="color: var(--muted)">{{ $t('deposits.filter_status') }}</span>
      <select v-model="statusFilter" class="field" style="width: auto; min-width: 160px">
        <option v-for="opt in statusOptions" :key="opt.value" :value="opt.value">{{ $t(opt.label) }}</option>
      </select>
    </div>

    <div v-if="error" class="mb-4 rounded-md px-3 py-2.5 text-[13px]" style="background: var(--red-bg); color: var(--red-fg)">
      {{ error }}
    </div>

    <!-- Table -->
    <div class="card overflow-hidden">
      <div v-if="loading" class="flex flex-col items-center justify-center gap-3 py-12 text-[13px]" style="color: var(--muted)">
        <div class="spinner" />
        <span>{{ $t('common.loading') }}</span>
      </div>

      <div
        v-else-if="deposits.length === 0"
        class="flex flex-col items-center justify-center gap-3 py-12 text-[13px]"
        style="color: var(--faint)"
      >
        <Icon name="wallet" :size="32" />
        <p>{{ $t('deposits.empty') }}</p>
      </div>

      <table v-else class="data-table">
        <thead>
          <tr>
            <th style="width: 56px">{{ $t('deposits.col_id') }}</th>
            <th>{{ $t('deposits.col_user') }}</th>
            <th>{{ $t('deposits.col_method') }}</th>
            <th>{{ $t('deposits.col_code') }}</th>
            <th class="text-right">{{ $t('deposits.col_amount') }}</th>
            <th>{{ $t('deposits.col_status') }}</th>
            <th>{{ $t('deposits.col_time') }}</th>
            <th class="text-right">{{ $t('common.actions') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="deposit in deposits" :key="deposit.id">
            <td class="mono" style="color: var(--faint)">#{{ deposit.id }}</td>
            <td>
              <div style="color: var(--ink)">{{ deposit.username || '—' }}</div>
              <div class="text-xs" style="color: var(--muted)">ID: {{ deposit.telegram_id || deposit.user_id }}</div>
            </td>
            <td>
              <span class="badge" :class="providerBadge(deposit.provider)">
                {{ providerLabel(deposit.provider) }}
              </span>
              <div v-if="deposit.provider === 'cryptobot' && depositMeta(deposit).usdt_amount" class="text-xs" style="color: var(--muted)">
                {{ depositMeta(deposit).usdt_amount }} USDT
              </div>
            </td>
            <td><span class="chip-code">{{ deposit.correlation_ref || '—' }}</span></td>
            <td class="text-right" style="font-weight: 500; color: var(--ink)">{{ formatMoney(deposit.amount, rate) }}</td>
            <td><span class="badge" :class="statusBadge(deposit.status)">{{ statusLabel(deposit.status) }}</span></td>
            <td class="text-xs" style="color: var(--muted); white-space: nowrap">{{ formatDate(deposit.created_at) }}</td>
            <td class="text-right">
              <div class="flex items-center justify-end gap-1.5">
                <button class="btn btn-ghost btn-sm" @click="openDetail(deposit)">{{ $t('common.details') }}</button>
                <button
                  v-if="deposit.status === 'pending' && deposit.provider === 'sepay'"
                  class="btn btn-primary btn-sm"
                  :disabled="approvingId === deposit.id"
                  @click="approveDeposit(deposit)"
                >
                  <Icon name="check" :size="14" />
                  {{ approvingId === deposit.id ? '...' : $t('deposits.approve') }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- Pagination -->
      <div
        v-if="totalPages() > 1"
        class="flex items-center justify-between px-4 py-3"
        style="border-top: 1px solid var(--border)"
      >
        <span class="text-[13px]" style="color: var(--muted)">{{ $t('common.page_of', { page, total: totalPages() }) }}</span>
        <div class="flex gap-2">
          <button class="btn btn-secondary btn-sm" :disabled="page <= 1" @click="goToPage(page - 1)">
            <Icon name="arrowLeft" :size="14" /> {{ $t('common.prev') }}
          </button>
          <button class="btn btn-secondary btn-sm" :disabled="page >= totalPages()" @click="goToPage(page + 1)">
            {{ $t('common.next') }} <Icon name="arrowRight" :size="14" />
          </button>
        </div>
      </div>
    </div>

    <!-- Detail Modal -->
    <div
      v-if="selectedDeposit"
      class="fixed inset-0 z-50 flex items-center justify-center p-4"
      style="background: rgba(0, 0, 0, 0.4)"
      @click.self="closeDetail"
    >
      <div class="card w-full max-w-md p-6">
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-base font-semibold" style="color: var(--ink)">{{ $t('deposits.detail', { id: selectedDeposit.id }) }}</h2>
          <button class="btn btn-ghost btn-icon" @click="closeDetail"><Icon name="close" :size="18" /></button>
        </div>

        <dl class="space-y-2.5 text-[13px]">
          <div class="flex items-center justify-between">
            <dt style="color: var(--muted)">{{ $t('deposits.transfer_code') }}</dt>
            <dd><span class="chip-code">{{ selectedDeposit.correlation_ref }}</span></dd>
          </div>
          <div class="flex items-center justify-between">
            <dt style="color: var(--muted)">{{ $t('deposits.col_amount') }}</dt>
            <dd style="font-weight: 600; color: var(--ink)">{{ formatMoney(selectedDeposit.amount, rate) }}</dd>
          </div>
          <div class="flex items-center justify-between">
            <dt style="color: var(--muted)">{{ $t('deposits.col_method') }}</dt>
            <dd>
              <span class="badge" :class="providerBadge(selectedDeposit.provider)">
                {{ providerLabel(selectedDeposit.provider) }}
              </span>
            </dd>
          </div>
          <div v-if="selectedDeposit.provider === 'cryptobot'" class="flex items-center justify-between">
            <dt style="color: var(--muted)">{{ $t('deposits.usdt') }}</dt>
            <dd style="color: var(--ink-soft)">{{ depositMeta(selectedDeposit).usdt_amount || '—' }} USDT</dd>
          </div>
          <div v-if="selectedDeposit.provider === 'cryptobot'" class="flex items-center justify-between">
            <dt style="color: var(--muted)">{{ $t('deposits.exchange_rate') }}</dt>
            <dd style="color: var(--ink-soft)">{{ depositMeta(selectedDeposit).exchange_rate ? formatMoney(depositMeta(selectedDeposit).exchange_rate!) + '/USDT' : '—' }}</dd>
          </div>
          <div class="flex items-center justify-between">
            <dt style="color: var(--muted)">{{ $t('deposits.col_status') }}</dt>
            <dd><span class="badge" :class="statusBadge(selectedDeposit.status)">{{ statusLabel(selectedDeposit.status) }}</span></dd>
          </div>
          <div class="flex items-center justify-between">
            <dt style="color: var(--muted)">{{ $t('deposits.col_user') }}</dt>
            <dd style="color: var(--ink-soft)">{{ selectedDeposit.username || '—' }} ({{ selectedDeposit.telegram_id || selectedDeposit.user_id }})</dd>
          </div>
          <div class="flex items-center justify-between">
            <dt style="color: var(--muted)">{{ providerTxnLabel(selectedDeposit.provider) }}</dt>
            <dd class="mono text-xs" style="color: var(--ink-soft)">{{ selectedDeposit.provider_txn_id || '—' }}</dd>
          </div>
          <div class="flex items-center justify-between">
            <dt style="color: var(--muted)">{{ $t('deposits.bank_ref') }}</dt>
            <dd class="mono text-xs" style="color: var(--ink-soft)">{{ depositMeta(selectedDeposit).bank_ref || '—' }}</dd>
          </div>
          <div style="border-top: 1px solid var(--border); padding-top: 0.625rem">
            <div class="flex items-center justify-between">
              <dt style="color: var(--muted)">{{ $t('common.created_at') }}</dt>
              <dd style="color: var(--ink-soft)">{{ formatDate(selectedDeposit.created_at) }}</dd>
            </div>
          </div>
          <div v-if="selectedDeposit.completed_at" class="flex items-center justify-between">
            <dt style="color: var(--muted)">{{ $t('deposits.completed_at') }}</dt>
            <dd style="color: var(--ink-soft)">{{ formatDate(selectedDeposit.completed_at) }}</dd>
          </div>
          <div v-if="selectedDeposit.expired_at" class="flex items-center justify-between">
            <dt style="color: var(--muted)">{{ $t('deposits.expired_at') }}</dt>
            <dd style="color: var(--ink-soft)">{{ formatDate(selectedDeposit.expired_at) }}</dd>
          </div>
        </dl>

        <div v-if="selectedDeposit.status === 'pending' && selectedDeposit.provider === 'sepay'" class="mt-5 pt-4" style="border-top: 1px solid var(--border)">
          <button class="btn btn-primary w-full" :disabled="approvingId === selectedDeposit.id" @click="approveDeposit(selectedDeposit)">
            <Icon name="check" :size="16" />
            {{ approvingId === selectedDeposit.id ? $t('common.processing') : $t('deposits.approve_manual') }}
          </button>
          <p class="mt-2 text-center text-xs" style="color: var(--faint)">
            {{ $t('deposits.approve_note') }}
          </p>
        </div>

        <button class="btn btn-secondary mt-4 w-full" @click="closeDetail">{{ $t('common.close') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--ink);
  border-radius: 9999px;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
</style>
