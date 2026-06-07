<script setup lang="ts">
import { ref, onMounted, watch, nextTick, onUnmounted } from 'vue'
import { api } from '@/api/client'
import { Chart, registerables } from 'chart.js'
import Icon from '@/components/Icon.vue'
import { AVAILABLE_LOCALES } from '@/i18n'
import { formatMoney } from '@/utils/format'
import { useExchangeRate } from '@/composables/useExchangeRate'
import { useI18n } from 'vue-i18n'

Chart.register(...registerables)
const { t } = useI18n()
// Tỷ giá dùng chung cho hiển thị kép VND/USD (R4.3). ConfigView nạp một lần,
// các view khác đọc lại cùng ref. rate=null → formatMoney hiển thị VND-only (R4.4).
const { rate, load: loadRate } = useExchangeRate()

const activeTab = ref<'config' | 'reports'>('config')

// --- Config state ---
const configLoading = ref(false)
const configSaving = ref(false)
const configError = ref('')
const configSuccess = ref('')

const form = ref({
  shop_name: '',
  bank_name: '',
  bank_account: '',
  bank_owner: '',
  bot_token: '',
  telegram_secret_token: '',
  sepay_api_key: '',
  crypto_pay_api_token: '',
  min_deposit: '20000',
  max_deposit: '100000000',
  exchange_rate_usdt_vnd: '25000',
  crypto_min_usdt: '5',
  default_language: 'en',
  payment_cryptobot_enabled: '0',
  admin_ids: '',
})

// Ẩn/hiện các giá trị bí mật (mặc định ẩn)
const showBotToken = ref(false)
const showTgSecret = ref(false)
const showSepayKey = ref(false)
const showCryptoToken = ref(false)

async function loadConfig() {
  configLoading.value = true
  configError.value = ''
  try {
    const res = await api.get<{ configs: Record<string, string> }>('/config')
    if (res.success && res.data) {
      const c = res.data.configs
      form.value.shop_name = c.shop_name ?? ''
      form.value.bank_name = c.bank_name ?? ''
      form.value.bank_account = c.bank_account ?? ''
      form.value.bank_owner = c.bank_owner ?? ''
      form.value.bot_token = c.bot_token ?? ''
      form.value.telegram_secret_token = c.telegram_secret_token ?? ''
      form.value.sepay_api_key = c.sepay_api_key ?? ''
      form.value.crypto_pay_api_token = c.crypto_pay_api_token ?? ''
      form.value.min_deposit = c.min_deposit ?? '20000'
      form.value.max_deposit = c.max_deposit ?? '100000000'
      form.value.exchange_rate_usdt_vnd = c.exchange_rate_usdt_vnd ?? '25000'
      form.value.crypto_min_usdt = c.crypto_min_usdt ?? '5'
      form.value.default_language = c.default_language ?? 'en'
      form.value.payment_cryptobot_enabled = c.payment_cryptobot_enabled ?? '0'
      form.value.admin_ids = c.admin_ids ?? ''
    } else {
      configError.value = res.error || t('config.save_failed')
    }
  } catch {
    configError.value = t('common.error')
  } finally {
    configLoading.value = false
  }
}

async function saveConfig() {
  configSaving.value = true
  configError.value = ''
  configSuccess.value = ''
  // R20.7: từ chối lưu khi nạp tối đa nhỏ hơn nạp tối thiểu.
  const minD = Number(form.value.min_deposit)
  const maxD = Number(form.value.max_deposit)
  if (Number.isFinite(minD) && Number.isFinite(maxD) && maxD < minD) {
    configError.value = t('config.max_lt_min')
    configSaving.value = false
    return
  }
  try {
    const res = await api.put<{ updated: number }>('/config', { configs: { ...form.value } })
    if (res.success) {
      configSuccess.value = t('config.saved_count', { count: res.data?.updated ?? 0 })
      setTimeout(() => { configSuccess.value = '' }, 3000)
    } else {
      configError.value = res.error || t('config.save_failed')
    }
  } catch {
    configError.value = t('common.error')
  } finally {
    configSaving.value = false
  }
}

// --- Reports ---
const reportsLoading = ref(false)
const reportsError = ref('')
const dateFrom = ref('')
const dateTo = ref('')

interface RevenueDataPoint { date: string; revenue: number; order_count: number }
interface TopProduct { id: number; name: string; emoji: string; price: number; total_sold: number; total_revenue: number }
interface TopUser { id: number; telegram_id: number; username: string | null; first_name: string | null; total_spent: number; order_count: number }

const revenueData = ref<RevenueDataPoint[]>([])
const topProducts = ref<TopProduct[]>([])
const topUsers = ref<TopUser[]>([])

let revenueChart: Chart | null = null
const revenueChartRef = ref<HTMLCanvasElement | null>(null)

function initDateRange() {
  const now = new Date()
  dateTo.value = now.toISOString().split('T')[0]
  dateFrom.value = new Date(now.getTime() - 30 * 86400000).toISOString().split('T')[0]
}

async function loadReports() {
  reportsLoading.value = true
  reportsError.value = ''
  try {
    const [revenueRes, productsRes, usersRes] = await Promise.all([
      api.get<RevenueDataPoint[]>(`/stats/revenue?from=${dateFrom.value}&to=${dateTo.value}`),
      api.get<TopProduct[]>('/stats/top-products'),
      api.get<TopUser[]>('/stats/top-users'),
    ])
    if (revenueRes.success && revenueRes.data) revenueData.value = revenueRes.data
    if (productsRes.success && productsRes.data) topProducts.value = productsRes.data
    if (usersRes.success && usersRes.data) topUsers.value = usersRes.data
    await nextTick()
    renderRevenueChart()
  } catch {
    reportsError.value = t('common.error')
  } finally {
    reportsLoading.value = false
  }
}

function renderRevenueChart() {
  if (!revenueChartRef.value) return
  if (revenueChart) { revenueChart.destroy(); revenueChart = null }
  revenueChart = new Chart(revenueChartRef.value, {
    type: 'line',
    data: {
      labels: revenueData.value.map(d => { const p = d.date.split('-'); return `${p[2]}/${p[1]}` }),
      datasets: [
        { label: t('config.chart_revenue'), data: revenueData.value.map(d => d.revenue), borderColor: '#1a1a18', backgroundColor: 'rgba(17,17,17,0.04)', fill: true, tension: 0.3, borderWidth: 2, pointRadius: 2 },
        { label: t('config.chart_orders'), data: revenueData.value.map(d => d.order_count), borderColor: '#9b9a97', fill: false, tension: 0.3, borderWidth: 1.5, pointRadius: 1, yAxisID: 'y1' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ctx.datasetIndex === 0 ? formatMoney(ctx.parsed.y ?? 0, rate.value) : t('config.orders_unit', { count: ctx.parsed.y }) } } },
      scales: {
        x: { grid: { color: '#eaeaea' }, ticks: { color: '#787774' } },
        y: { grid: { color: '#eaeaea' }, ticks: { color: '#787774', callback: v => { const n = Number(v); return n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(0)+'k' : String(n) } } },
        y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: '#9b9a97' } },
      },
    },
  })
}


watch(activeTab, tab => { if (tab === 'reports' && revenueData.value.length === 0) loadReports() })
onMounted(() => { loadConfig(); loadRate(); initDateRange() })
onUnmounted(() => { if (revenueChart) { revenueChart.destroy(); revenueChart = null } })
</script>

<template>
  <div class="animate-in">
    <!-- Tab bar -->
    <div class="mb-6 flex gap-1" style="border-bottom: 1px solid var(--border)">
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'config' }"
        @click="activeTab = 'config'"
      >
        <Icon name="settings" :size="16" /> {{ $t('config.tab_config') }}
      </button>
      <button
        class="tab-btn"
        :class="{ active: activeTab === 'reports' }"
        @click="activeTab = 'reports'"
      >
        <Icon name="trend" :size="16" /> {{ $t('config.tab_reports') }}
      </button>
    </div>

    <!-- ========== CONFIG TAB ========== -->
    <div v-if="activeTab === 'config'">
      <div v-if="configLoading" class="flex flex-col items-center gap-3 py-16" style="color: var(--muted)">
        <div class="spinner" /><span class="text-[13px]">{{ $t('config.loading') }}</span>
      </div>

      <form v-else class="max-w-2xl space-y-5" @submit.prevent="saveConfig">
        <!-- Alerts -->
        <div v-if="configError" class="flex items-center gap-2 rounded-md px-3 py-2.5 text-[13px]" style="background: var(--red-bg); color: var(--red-fg)">
          <Icon name="warning" :size="16" /><span>{{ configError }}</span>
        </div>
        <div v-if="configSuccess" class="flex items-center gap-2 rounded-md px-3 py-2.5 text-[13px]" style="background: var(--green-bg); color: var(--green-fg)">
          <Icon name="check" :size="16" /><span>{{ configSuccess }}</span>
        </div>

        <!-- Shop -->
        <section class="card p-5 space-y-4">
          <h3 class="section-head"><Icon name="store" :size="18" /> {{ $t('config.shop_section') }}</h3>
          <div><label class="label">{{ $t('config.shop_name') }}</label><input v-model="form.shop_name" class="field" placeholder="Shop Acc VN" /></div>
        </section>

        <!-- Telegram Bot -->
        <section class="card p-5 space-y-4">
          <h3 class="section-head"><Icon name="settings" :size="18" /> {{ $t('config.telegram_section') }}</h3>
          <div>
            <label class="label">{{ $t('config.bot_token') }}</label>
            <div class="key-row">
              <input
                v-model="form.bot_token"
                :type="showBotToken ? 'text' : 'password'"
                class="field"
                placeholder="123456:ABC-DEF..."
                autocomplete="off"
                spellcheck="false"
              />
              <button type="button" class="key-toggle" :title="showBotToken ? $t('config.hide') : $t('config.show')" @click="showBotToken = !showBotToken">
                <Icon :name="showBotToken ? 'eyeOff' : 'eye'" :size="16" />
              </button>
            </div>
            <p class="hint">{{ $t('config.bot_token_hint') }}</p>
          </div>
          <div>
            <label class="label">{{ $t('config.tg_secret') }}</label>
            <div class="key-row">
              <input
                v-model="form.telegram_secret_token"
                :type="showTgSecret ? 'text' : 'password'"
                class="field"
                :placeholder="$t('config.ph_tg_secret')"
                autocomplete="off"
                spellcheck="false"
              />
              <button type="button" class="key-toggle" :title="showTgSecret ? $t('config.hide') : $t('config.show')" @click="showTgSecret = !showTgSecret">
                <Icon :name="showTgSecret ? 'eyeOff' : 'eye'" :size="16" />
              </button>
            </div>
            <p class="hint">{{ $t('config.tg_secret_hint') }}</p>
          </div>
          <div>
            <label class="label">{{ $t('config.admin_ids') }}</label>
            <input v-model="form.admin_ids" class="field" placeholder="123456789,987654321" />
            <p class="hint">{{ $t('config.admin_ids_hint') }}</p>
          </div>
        </section>

        <!-- Bank -->
        <section class="card p-5 space-y-4">
          <h3 class="section-head"><Icon name="bank" :size="18" /> {{ $t('config.bank_section') }}</h3>
          <div><label class="label">{{ $t('config.bank_name') }}</label><input v-model="form.bank_name" class="field" placeholder="Vietcombank" /></div>
          <div><label class="label">{{ $t('config.bank_account') }}</label><input v-model="form.bank_account" class="field" placeholder="1017588888" /></div>
          <div><label class="label">{{ $t('config.bank_owner') }}</label><input v-model="form.bank_owner" class="field" placeholder="NGUYEN VAN A" /></div>
        </section>

        <!-- SePay -->
        <section class="card p-5 space-y-4">
          <h3 class="section-head"><Icon name="key" :size="18" /> {{ $t('config.sepay_section') }}</h3>
          <div>
            <label class="label">{{ $t('config.sepay_key') }}</label>
            <div class="key-row">
              <input
                v-model="form.sepay_api_key"
                :type="showSepayKey ? 'text' : 'password'"
                class="field"
                :placeholder="$t('config.ph_sepay_key')"
                autocomplete="off"
                spellcheck="false"
              />
              <button
                type="button"
                class="key-toggle"
                :title="showSepayKey ? $t('config.hide_key') : $t('config.show_key')"
                @click="showSepayKey = !showSepayKey"
              >
                <Icon :name="showSepayKey ? 'eyeOff' : 'eye'" :size="16" />
              </button>
            </div>
            <p class="hint">{{ $t('config.sepay_key_hint') }}</p>
          </div>
        </section>

        <!-- System -->
        <section class="card p-5 space-y-4">
          <h3 class="section-head"><Icon name="settings" :size="18" /> {{ $t('config.system_section') }}</h3>
          <div class="grid grid-cols-2 gap-4">
            <div><label class="label">{{ $t('config.min_deposit') }}</label><input v-model="form.min_deposit" type="number" min="1000" class="field" /></div>
            <div><label class="label">{{ $t('config.max_deposit') }}</label><input v-model="form.max_deposit" type="number" min="1000" class="field" /></div>
          </div>
        </section>

        <!-- Multi-region payment (R20.1-20.4) -->
        <section class="card p-5 space-y-4">
          <h3 class="section-head"><Icon name="key" :size="18" /> {{ $t('config.payment_section') }}</h3>
          <div>
            <label class="label">{{ $t('config.crypto_token') }}</label>
            <div class="key-row">
              <input
                v-model="form.crypto_pay_api_token"
                :type="showCryptoToken ? 'text' : 'password'"
                class="field"
                :placeholder="$t('config.ph_crypto_token')"
                autocomplete="off"
                spellcheck="false"
              />
              <button
                type="button"
                class="key-toggle"
                :title="showCryptoToken ? $t('config.hide_key') : $t('config.show_key')"
                @click="showCryptoToken = !showCryptoToken"
              >
                <Icon :name="showCryptoToken ? 'eyeOff' : 'eye'" :size="16" />
              </button>
            </div>
            <p class="hint">{{ $t('config.crypto_token_hint') }}</p>
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="label">{{ $t('config.exchange_rate') }}</label>
              <input v-model="form.exchange_rate_usdt_vnd" type="number" min="1" class="field" />
            </div>
            <div>
              <label class="label">{{ $t('config.crypto_min_usdt') }}</label>
              <input v-model="form.crypto_min_usdt" type="number" min="1" step="0.01" class="field" />
            </div>
          </div>
          <div>
            <label class="label">{{ $t('config.default_language') }}</label>
            <select v-model="form.default_language" class="field">
              <option v-for="loc in AVAILABLE_LOCALES" :key="loc" :value="loc">{{ loc.toUpperCase() }}</option>
            </select>
          </div>
          <div class="flex items-center justify-between" style="padding-top: 0.25rem">
            <div>
              <span class="label" style="margin-bottom: 0">{{ $t('config.crypto_enable') }}</span>
              <p class="hint">{{ $t('config.crypto_enable_hint') }}</p>
            </div>
            <button
              type="button"
              class="toggle"
              :class="{ 'is-on': form.payment_cryptobot_enabled === '1' }"
              role="switch"
              :aria-checked="form.payment_cryptobot_enabled === '1'"
              @click="form.payment_cryptobot_enabled = form.payment_cryptobot_enabled === '1' ? '0' : '1'"
            >
              <span class="toggle-knob" />
            </button>
          </div>
        </section>

        <div class="flex justify-end"><button type="submit" class="btn btn-primary" :disabled="configSaving"><Icon name="check" :size="16" />{{ configSaving ? $t('common.saving') : $t('config.save_btn') }}</button></div>
      </form>
    </div>

    <!-- ========== REPORTS TAB ========== -->
    <div v-if="activeTab === 'reports'" class="space-y-5">
      <div v-if="reportsLoading" class="flex flex-col items-center gap-3 py-16" style="color: var(--muted)">
        <div class="spinner" /><span class="text-[13px]">{{ $t('config.loading') }}</span>
      </div>
      <div v-if="reportsError" class="rounded-md px-3 py-2.5 text-[13px]" style="background: var(--red-bg); color: var(--red-fg)">{{ reportsError }}</div>

      <!-- Date range -->
      <div class="card p-4 flex flex-wrap items-end gap-3">
        <div><label class="label">{{ $t('config.reports_from') }}</label><input v-model="dateFrom" type="date" class="field" /></div>
        <div><label class="label">{{ $t('config.reports_to') }}</label><input v-model="dateTo" type="date" class="field" /></div>
        <button class="btn btn-primary" :disabled="reportsLoading" @click="loadReports"><Icon name="refresh" :size="16" />{{ $t('config.reports_update') }}</button>
      </div>

      <!-- Revenue chart -->
      <div class="card p-5">
        <h3 class="text-[15px] font-semibold mb-4" style="color: var(--ink)">{{ $t('config.revenue_by_day') }}</h3>
        <div class="h-64">
          <canvas v-if="revenueData.length > 0" ref="revenueChartRef" />
          <div v-else class="flex items-center justify-center h-full text-[13px]" style="color: var(--faint)">{{ $t('config.no_data') }}</div>
        </div>
      </div>

      <!-- Top products -->
      <div class="card overflow-hidden">
        <div class="px-5 py-4" style="border-bottom: 1px solid var(--border)">
          <h3 class="text-[15px] font-semibold" style="color: var(--ink)">{{ $t('config.top_products') }}</h3>
        </div>
        <div v-if="topProducts.length === 0" class="p-6 text-center text-[13px]" style="color: var(--faint)">{{ $t('config.no_data') }}</div>
        <table v-else class="data-table">
          <thead><tr><th>#</th><th>{{ $t('config.col_product') }}</th><th class="text-right">{{ $t('config.col_price') }}</th><th class="text-right">{{ $t('config.col_sold') }}</th><th class="text-right">{{ $t('config.col_revenue') }}</th></tr></thead>
          <tbody>
            <tr v-for="(p, i) in topProducts" :key="p.id">
              <td style="color: var(--faint)">{{ i + 1 }}</td>
              <td style="font-weight: 500; color: var(--ink)">{{ p.name }}</td>
              <td class="text-right" style="color: var(--muted)">{{ formatMoney(p.price, rate) }}</td>
              <td class="text-right" style="font-weight: 500; color: var(--ink)">{{ p.total_sold }}</td>
              <td class="text-right" style="color: var(--green-fg); font-weight: 500">{{ formatMoney(p.total_revenue, rate) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Top users -->
      <div class="card overflow-hidden">
        <div class="px-5 py-4" style="border-bottom: 1px solid var(--border)">
          <h3 class="text-[15px] font-semibold" style="color: var(--ink)">{{ $t('config.top_users') }}</h3>
        </div>
        <div v-if="topUsers.length === 0" class="p-6 text-center text-[13px]" style="color: var(--faint)">{{ $t('config.no_data') }}</div>
        <table v-else class="data-table">
          <thead><tr><th>#</th><th>{{ $t('config.col_user') }}</th><th class="text-right">{{ $t('config.col_orders') }}</th><th class="text-right">{{ $t('config.col_spent') }}</th></tr></thead>
          <tbody>
            <tr v-for="(u, i) in topUsers" :key="u.id">
              <td style="color: var(--faint)">{{ i + 1 }}</td>
              <td>
                <span style="font-weight: 500; color: var(--ink)">{{ u.username || u.first_name || 'N/A' }}</span>
                <span class="ml-1.5 text-xs" style="color: var(--muted)">#{{ u.telegram_id }}</span>
              </td>
              <td class="text-right" style="color: var(--ink)">{{ u.order_count }}</td>
              <td class="text-right" style="color: var(--green-fg); font-weight: 500">{{ formatMoney(u.total_spent, rate) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.625rem 0.875rem;
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--muted);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: color 0.15s, border-color 0.15s;
  cursor: pointer;
  background: none;
  border-top: none;
  border-left: none;
  border-right: none;
}
.tab-btn:hover { color: var(--ink-soft); }
.tab-btn.active { color: var(--ink); border-bottom-color: var(--ink); }

.section-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 0.25rem;
}
.hint {
  margin-top: 0.25rem;
  font-size: 0.6875rem;
  color: var(--faint);
}

.key-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.key-row .field {
  flex: 1;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.key-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: var(--bg-soft, #fff);
  color: var(--muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.key-toggle:hover {
  color: var(--ink);
  border-color: var(--ink-soft);
}

.toggle {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  border-radius: 9999px;
  background: var(--border-strong);
  border: none;
  padding: 0;
  cursor: pointer;
  transition: background-color 0.15s ease;
  flex-shrink: 0;
}
.toggle.is-on { background: var(--accent); }
.toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 9999px;
  background: #fff;
  transition: transform 0.15s ease;
}
.toggle.is-on .toggle-knob { transform: translateX(16px); }

.spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--ink);
  border-radius: 9999px;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
