<script setup lang="ts">
/**
 * DepositView — nạp tiền đa phương thức theo vùng (R8.3, R10.1, R10.3).
 *
 *  - Lấy `GET /api/app/deposit-methods` theo vùng. Nhiều phương thức → hiện tab chọn;
 *    một phương thức → vào thẳng.
 *  - SePay (VND): grid mệnh giá + nhập số → `POST /deposits { method:'sepay', amount }`
 *    → hiển thị VietQR + poll trạng thái (giữ hành vi cũ).
 *  - CryptoBot (USDT): nhập USDT → `POST /deposits { method:'cryptobot', amount }` →
 *    mở `pay_url` (openLink) → poll `GET /deposits/:id` tới khi completed.
 *  - Cộng tiền thực do webhook xử lý; view chỉ đọc trạng thái.
 */

import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import GlassCard from '@/components/GlassCard.vue'
import GlassButton from '@/components/GlassButton.vue'
import QrPanel from '@/components/QrPanel.vue'
import { CircleCheck } from '@lucide/vue'
import { get, post, ApiError } from '@/api/client'
import { useUiStore } from '@/stores/ui'
import { useUserStore } from '@/stores/user'
import { showBackButton, openLink, type Cleanup } from '@/telegram/sdk'
import { formatCurrency } from '@/utils/format'
import type {
  DepositCreatedDto,
  CryptoDepositCreatedDto,
  DepositMethodDto,
  DepositStatusDto,
} from '@/types'

const PRESET_AMOUNTS = [30_000, 50_000, 100_000, 200_000, 500_000, 1_000_000] as const
const POLL_START_MS = 3_000
const POLL_MAX_MS = 15_000
const POLL_FACTOR = 1.5

const router = useRouter()
const ui = useUiStore()
const user = useUserStore()
const { t } = useI18n()

type Method = 'sepay' | 'cryptobot'

const methods = ref<DepositMethodDto[]>([])
const selectedMethod = ref<Method>('sepay')
const amountInput = ref('')
const createdSepay = ref<DepositCreatedDto | null>(null)
const createdCrypto = ref<CryptoDepositCreatedDto | null>(null)
const depositId = ref<number | null>(null)
const status = ref<DepositStatusDto['status']>('pending')
const submitting = ref(false)

const isCrypto = computed(() => selectedMethod.value === 'cryptobot')
const created = computed(() => createdSepay.value !== null || createdCrypto.value !== null)

/** Số tiền hợp lệ: sepay = số nguyên VND; crypto = số dương (cho phép thập phân USDT). */
const amount = computed<number | null>(() => {
  if (!amountInput.value) return null
  const n = Number(amountInput.value)
  if (!Number.isFinite(n) || n <= 0) return null
  if (!isCrypto.value && !Number.isInteger(n)) return null
  return n
})

let cleanupBack: Cleanup = () => {}
let polling = false
let pollTimer: ReturnType<typeof setTimeout> | null = null
let pollDelay = POLL_START_MS

function selectMethod(m: Method): void {
  if (selectedMethod.value === m) return
  ui.haptic('light')
  selectedMethod.value = m
  amountInput.value = ''
}

function selectPreset(value: number): void {
  ui.haptic('light')
  amountInput.value = String(value)
}

function onAmountInput(event: Event): void {
  const el = event.target as HTMLInputElement
  // sepay: chỉ chữ số; crypto: cho phép một dấu chấm thập phân.
  const cleaned = isCrypto.value
    ? el.value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1')
    : el.value.replace(/\D/g, '')
  amountInput.value = cleaned
  if (el.value !== cleaned) el.value = cleaned
}

function stopPolling(): void {
  polling = false
  if (pollTimer !== null) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
}

function scheduleNextPoll(): void {
  if (!polling) return
  pollTimer = setTimeout(() => void pollOnce(), pollDelay)
  pollDelay = Math.min(Math.round(pollDelay * POLL_FACTOR), POLL_MAX_MS)
}

async function pollOnce(): Promise<void> {
  if (!polling || depositId.value === null) return
  try {
    const res = await get<DepositStatusDto>(`/deposits/${depositId.value}`)
    if (!polling) return

    if (res.status === 'completed') {
      stopPolling()
      status.value = 'completed'
      if (typeof res.new_balance === 'number') user.setBalance(res.new_balance)
      ui.haptic('success')
      ui.toast(t('deposit.success'), 'success')
      return
    }
    if (res.status === 'expired' || res.status === 'cancelled') {
      stopPolling()
      status.value = res.status
      return
    }
    status.value = res.status
    scheduleNextPoll()
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 404)) {
      stopPolling()
      return
    }
    scheduleNextPoll()
  }
}

function startPolling(): void {
  stopPolling()
  polling = true
  pollDelay = POLL_START_MS
  scheduleNextPoll()
}

/**
 * Map lỗi tạo nạp sang thông báo cho user (theo locale). Backend trả message hạn mức/
 * chính sách đã bản địa hoá sẵn (hiển thị nguyên văn); riêng các mã code thuần như
 * `method_unavailable` thì dịch qua i18n để không lộ code thô.
 */
function depositErrorMessage(code: string): string {
  switch (code) {
    case 'method_unavailable':
      return t('deposit.method_unavailable')
    default:
      return code
  }
}

async function submitDeposit(): Promise<void> {
  if (submitting.value || created.value) return
  const value = amount.value
  if (value === null) {
    ui.haptic('error')
    ui.toast(t('common.error'), 'error')
    return
  }

  submitting.value = true
  try {
    if (isCrypto.value) {
      const res = await ui.withLoading(
        post<CryptoDepositCreatedDto>('/deposits', { method: 'cryptobot', amount: value })
      )
      createdCrypto.value = res
      depositId.value = res.deposit_id
      status.value = 'pending'
      ui.haptic('success')
      openLink(res.pay_url)
      startPolling()
    } else {
      const res = await ui.withLoading(
        post<DepositCreatedDto>('/deposits', { method: 'sepay', amount: value })
      )
      createdSepay.value = res
      depositId.value = res.deposit_id
      status.value = 'pending'
      ui.haptic('success')
      startPolling()
    }
  } catch (err) {
    ui.haptic('error')
    if (err instanceof ApiError) {
      if (err.status === 401) return
      ui.toast(depositErrorMessage(err.error), 'error')
    } else {
      ui.toast(t('common.error'), 'error')
    }
  } finally {
    submitting.value = false
  }
}

function resetDeposit(): void {
  stopPolling()
  createdSepay.value = null
  createdCrypto.value = null
  depositId.value = null
  status.value = 'pending'
  amountInput.value = ''
}

onMounted(async () => {
  cleanupBack = showBackButton(() => router.back())
  try {
    const list = await get<DepositMethodDto[]>('/deposit-methods')
    methods.value = list
    if (list.length > 0) selectedMethod.value = list[0].id
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return
  }
})

onUnmounted(() => {
  cleanupBack()
  stopPolling()
})
</script>

<template>
  <main class="flex flex-col gap-5 px-4 py-6">
    <header class="flex flex-col gap-1">
      <h1 class="text-ios-title text-text">{{ $t('deposit.title') }}</h1>
    </header>

    <template v-if="!created">
      <!-- Chọn phương thức (chỉ hiện khi >1 phương thức) (R8.3) -->
      <section v-if="methods.length > 1" class="flex flex-col gap-2" aria-label="method">
        <h2 class="px-1 text-ios-footnote text-hint">{{ $t('deposit.choose_method') }}</h2>
        <div class="grid grid-cols-2 gap-3">
          <button
            v-for="m in methods"
            :key="m.id"
            type="button"
            class="tap-target rounded-ios px-4 py-3 text-ios-headline transition-transform active:scale-[0.97]"
            :class="selectedMethod === m.id ? 'bg-accent text-accent-text' : 'glass text-text'"
            :aria-pressed="selectedMethod === m.id"
            @click="selectMethod(m.id)"
          >
            {{ m.id === 'sepay' ? $t('deposit.method_sepay') : $t('deposit.method_cryptobot') }}
          </button>
        </div>
      </section>

      <!-- SePay: grid mệnh giá -->
      <section v-if="!isCrypto" class="flex flex-col gap-3" aria-label="presets">
        <div class="grid grid-cols-2 gap-3">
          <button
            v-for="preset in PRESET_AMOUNTS"
            :key="preset"
            type="button"
            class="tap-target rounded-ios px-4 py-3 text-ios-headline tabular-nums transition-transform active:scale-[0.97]"
            :class="amount === preset ? 'bg-accent text-accent-text' : 'glass text-text'"
            :aria-pressed="amount === preset"
            @click="selectPreset(preset)"
          >
            {{ formatCurrency(preset) }}
          </button>
        </div>
      </section>

      <!-- Ô nhập số tiền (VND hoặc USDT) -->
      <section class="flex flex-col gap-2" aria-label="amount">
        <h2 class="px-1 text-ios-footnote text-hint">
          {{ isCrypto ? $t('deposit.amount_usdt') : $t('deposit.amount_vnd') }}
        </h2>
        <div class="glass flex items-center gap-2 px-4 py-3">
          <input
            :value="amountInput"
            type="text"
            :inputmode="isCrypto ? 'decimal' : 'numeric'"
            :placeholder="$t('deposit.amount_placeholder')"
            class="w-full bg-transparent text-ios-title tabular-nums text-text outline-none placeholder:text-hint"
            @input="onAmountInput"
          />
          <span class="text-ios-title text-hint" aria-hidden="true">{{ isCrypto ? 'USDT' : 'đ' }}</span>
        </div>
      </section>

      <GlassButton block :disabled="submitting || amount === null" @click="submitDeposit">
        {{ $t('deposit.create') }}
      </GlassButton>
    </template>

    <!-- Sau khi tạo -->
    <template v-else>
      <GlassCard v-if="status === 'pending'">
        <div class="flex items-center gap-3">
          <span
            class="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-accent border-t-transparent"
            aria-hidden="true"
          />
          <span class="text-ios-headline text-text">{{ $t('deposit.waiting') }}</span>
        </div>
      </GlassCard>

      <GlassCard v-else-if="status === 'completed'">
        <div class="flex flex-col items-center gap-2 text-center">
          <CircleCheck :size="40" :stroke-width="1.75" class="text-ios-green" aria-hidden="true" />
          <h2 class="text-ios-headline text-text">{{ $t('deposit.success') }}</h2>
        </div>
      </GlassCard>

      <!-- CryptoBot: nút mở lại liên kết thanh toán -->
      <GlassButton
        v-if="createdCrypto && status === 'pending'"
        block
        @click="openLink(createdCrypto.pay_url)"
      >
        {{ $t('deposit.pay_crypto') }}
      </GlassButton>

      <!-- SePay: VietQR -->
      <QrPanel
        v-if="createdSepay && status === 'pending'"
        :qr-url="createdSepay.qr_url"
        :bank-name="createdSepay.bank_name"
        :bank-account="createdSepay.bank_account"
        :bank-owner="createdSepay.bank_owner"
        :amount-display="formatCurrency(createdSepay.amount)"
        :transfer-code="createdSepay.transfer_code"
      />

      <GlassButton variant="secondary" block @click="resetDeposit">
        {{ $t('common.back') }}
      </GlassButton>
    </template>
  </main>
</template>
