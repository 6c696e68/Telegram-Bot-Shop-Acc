<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'
import { Chart, registerables } from 'chart.js'
import { useI18n } from 'vue-i18n'
import { api } from '@/api/client'
import Icon from '@/components/Icon.vue'
import { formatMoney, formatNumber } from '@/utils/format'
import { useExchangeRate } from '@/composables/useExchangeRate'

Chart.register(...registerables)
const { t } = useI18n()
// Tỷ giá dùng chung VND/USD (R4.3). rate=null → VND-only (R4.4).
const { rate, load: loadRate } = useExchangeRate()

interface DashboardData {
  revenue: {
    today: number
    last7days: number
    last30days: number
    allTime: number
  }
  totalUsers: number
  totalOrders: number
  productsPerCategory: Array<{
    id: number
    name: string
    emoji: string
    available_count: number
  }>
}

interface RevenuePoint {
  date: string
  revenue: number
  order_count: number
}

const dashboard = ref<DashboardData | null>(null)
const revenueData = ref<RevenuePoint[]>([])
const loading = ref(true)
const error = ref('')

let chartInstance: Chart | null = null
const chartCanvas = ref<HTMLCanvasElement | null>(null)


function formatDate(dateStr: string): string {
  const [, m, d] = dateStr.split('-')
  return `${d}/${m}`
}

async function fetchDashboard() {
  try {
    const res = await api.get<DashboardData>('/stats/dashboard')
    if (res.success && res.data) {
      dashboard.value = res.data
    } else {
      error.value = res.error || t('dashboard.load_error')
    }
  } catch {
    error.value = t('common.error')
  }
}

async function fetchRevenue() {
  try {
    const to = new Date()
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000)
    const fromStr = from.toISOString().slice(0, 10)
    const toStr = to.toISOString().slice(0, 10)

    const res = await api.get<RevenuePoint[]>(`/stats/revenue?from=${fromStr}&to=${toStr}`)
    if (res.success && res.data) {
      revenueData.value = res.data
    }
  } catch {
    // Revenue chart is non-critical, fail silently
  }
}

function renderChart() {
  if (!chartCanvas.value || revenueData.value.length === 0) return

  if (chartInstance) {
    chartInstance.destroy()
    chartInstance = null
  }

  const labels = revenueData.value.map((p) => formatDate(p.date))
  const data = revenueData.value.map((p) => p.revenue)

  chartInstance = new Chart(chartCanvas.value, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: t('dashboard.revenue_label'),
          data,          borderColor: '#1a1a18',
          backgroundColor: 'rgba(17, 17, 17, 0.04)',
          fill: true,
          tension: 0.3,
          pointRadius: 2,
          pointHoverRadius: 5,
          pointBackgroundColor: '#1a1a18',
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => formatMoney(ctx.parsed.y ?? 0, rate.value),
          },
        },
      },
      scales: {
        x: {
          grid: { color: '#eaeaea' },
          ticks: { color: '#787774' },
        },
        y: {
          beginAtZero: true,
          grid: { color: '#eaeaea' },
          ticks: {
            color: '#787774',
            callback: (value) => {
              const num = Number(value)
              if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M'
              if (num >= 1_000) return (num / 1_000).toFixed(0) + 'k'
              return String(num)
            },
          },
        },
      },
    },
  })
}

watch(revenueData, () => {
  renderChart()
})

onMounted(async () => {
  await Promise.all([fetchDashboard(), fetchRevenue(), loadRate()])
  loading.value = false
  // Render chart after DOM update
  setTimeout(renderChart, 50)
})

onUnmounted(() => {
  if (chartInstance) {
    chartInstance.destroy()
    chartInstance = null
  }
})
</script>

<template>
  <div class="animate-in">
    <!-- Page header -->
    <div class="mb-6">
      <h1 class="text-[15px] font-semibold" style="color: var(--ink)">{{ $t('dashboard.title') }}</h1>
      <p class="mt-1 text-[13px]" style="color: var(--muted)">{{ $t('dashboard.subtitle') }}</p>
    </div>

    <!-- Loading state -->
    <div v-if="loading" class="flex flex-col items-center justify-center py-20">
      <div
        class="h-8 w-8 rounded-full animate-spin"
        style="border: 2px solid var(--border); border-top-color: var(--ink)"
      ></div>
      <p class="mt-3 text-[13px]" style="color: var(--muted)">{{ $t('dashboard.loading') }}</p>
    </div>

    <!-- Error state -->
    <div
      v-else-if="error"
      class="card p-4 flex items-center gap-2 text-[13px]"
      style="background: var(--red-bg); color: var(--red-fg); border-color: var(--red-bg)"
    >
      <Icon name="warning" :size="18" />
      <span>{{ error }}</span>
    </div>

    <!-- Dashboard content -->
    <div v-else-if="dashboard">
      <!-- Revenue cards -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <div class="card p-5">
          <div class="flex items-start justify-between">
            <p class="text-[13px]" style="color: var(--muted)">{{ $t('dashboard.revenue_today') }}</p>
            <span
              class="inline-flex items-center justify-center h-9 w-9 rounded-full"
              style="background: var(--green-bg); color: var(--green-fg)"
            >
              <Icon name="coins" :size="18" />
            </span>
          </div>
          <p class="mt-3 text-2xl font-semibold" style="color: var(--ink)">
            {{ formatMoney(dashboard.revenue.today, rate) }}
          </p>
        </div>

        <div class="card p-5">
          <div class="flex items-start justify-between">
            <p class="text-[13px]" style="color: var(--muted)">{{ $t('dashboard.revenue_7d') }}</p>
            <span
              class="inline-flex items-center justify-center h-9 w-9 rounded-full"
              style="background: var(--blue-bg); color: var(--blue-fg)"
            >
              <Icon name="trend" :size="18" />
            </span>
          </div>
          <p class="mt-3 text-2xl font-semibold" style="color: var(--ink)">
            {{ formatMoney(dashboard.revenue.last7days, rate) }}
          </p>
        </div>

        <div class="card p-5">
          <div class="flex items-start justify-between">
            <p class="text-[13px]" style="color: var(--muted)">{{ $t('dashboard.revenue_30d') }}</p>
            <span
              class="inline-flex items-center justify-center h-9 w-9 rounded-full"
              style="background: var(--yellow-bg); color: var(--yellow-fg)"
            >
              <Icon name="trend" :size="18" />
            </span>
          </div>
          <p class="mt-3 text-2xl font-semibold" style="color: var(--ink)">
            {{ formatMoney(dashboard.revenue.last30days, rate) }}
          </p>
        </div>

        <div class="card p-5">
          <div class="flex items-start justify-between">
            <p class="text-[13px]" style="color: var(--muted)">{{ $t('dashboard.revenue_all') }}</p>
            <span
              class="inline-flex items-center justify-center h-9 w-9 rounded-full"
              style="background: var(--gray-bg); color: var(--gray-fg)"
            >
              <Icon name="coins" :size="18" />
            </span>
          </div>
          <p class="mt-3 text-2xl font-semibold" style="color: var(--ink)">
            {{ formatMoney(dashboard.revenue.allTime, rate) }}
          </p>
        </div>
      </div>

      <!-- Secondary stats cards -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        <div class="card p-5">
          <div class="flex items-center gap-3">
            <span
              class="inline-flex items-center justify-center h-10 w-10 rounded-full"
              style="background: var(--blue-bg); color: var(--blue-fg)"
            >
              <Icon name="users" :size="20" />
            </span>
            <div>
              <p class="text-[13px]" style="color: var(--muted)">{{ $t('dashboard.total_users') }}</p>
              <p class="text-2xl font-semibold" style="color: var(--ink)">
                {{ formatNumber(dashboard.totalUsers) }}
              </p>
            </div>
          </div>
        </div>

        <div class="card p-5">
          <div class="flex items-center gap-3">
            <span
              class="inline-flex items-center justify-center h-10 w-10 rounded-full"
              style="background: var(--green-bg); color: var(--green-fg)"
            >
              <Icon name="receipt" :size="20" />
            </span>
            <div>
              <p class="text-[13px]" style="color: var(--muted)">{{ $t('dashboard.total_orders') }}</p>
              <p class="text-2xl font-semibold" style="color: var(--ink)">
                {{ formatNumber(dashboard.totalOrders) }}
              </p>
            </div>
          </div>
        </div>

        <div class="card p-5">
          <div class="flex items-center gap-3">
            <span
              class="inline-flex items-center justify-center h-10 w-10 rounded-full"
              style="background: var(--gray-bg); color: var(--gray-fg)"
            >
              <Icon name="category" :size="20" />
            </span>
            <div>
              <p class="text-[13px]" style="color: var(--muted)">{{ $t('dashboard.total_categories') }}</p>
              <p class="text-2xl font-semibold" style="color: var(--ink)">
                {{ formatNumber(dashboard.productsPerCategory.length) }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <!-- Revenue chart -->
      <div class="card p-5 mb-6">
        <h2 class="text-[15px] font-semibold mb-4" style="color: var(--ink)">
          {{ $t('dashboard.revenue_chart') }}
        </h2>
        <div class="h-64">
          <canvas v-if="revenueData.length > 0" ref="chartCanvas"></canvas>
          <div
            v-else
            class="flex items-center justify-center h-full text-[13px]"
            style="color: var(--faint)"
          >
            {{ $t('dashboard.no_revenue') }}
          </div>
        </div>
      </div>

      <!-- Products per category -->
      <div class="card p-5">
        <h2 class="text-[15px] font-semibold mb-4" style="color: var(--ink)">
          {{ $t('dashboard.products_per_category') }}
        </h2>
        <div
          v-if="dashboard.productsPerCategory.length === 0"
          class="text-[13px]"
          style="color: var(--faint)"
        >
          {{ $t('dashboard.no_category') }}
        </div>
        <div v-else>
          <div
            v-for="cat in dashboard.productsPerCategory"
            :key="cat.id"
            class="cat-row flex items-center justify-between py-3"
          >
            <div class="flex items-center gap-2.5">
              <span style="color: var(--muted)">
                <Icon name="package" :size="18" />
              </span>
              <span class="text-[13px] font-medium" style="color: var(--ink-soft)">
                {{ cat.name }}
              </span>
            </div>
            <span
              class="badge"
              :class="cat.available_count > 0 ? 'badge-green' : 'badge-red'"
            >
              {{ $t('dashboard.remaining', { count: cat.available_count }) }}
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cat-row {
  border-bottom: 1px solid var(--border);
}
.cat-row:last-child {
  border-bottom: none;
}
</style>
