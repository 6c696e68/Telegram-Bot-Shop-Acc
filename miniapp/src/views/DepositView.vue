<script setup lang="ts">
/**
 * DepositView — nạp tiền đa phương thức theo vùng (Obsidian Glass, R8.3, R10.1, R10.3).
 *
 *  - `GET /api/app/deposit-methods` theo vùng. Nhiều phương thức → SegmentedControl; một → vào thẳng.
 *  - SePay (VND): grid mệnh giá + nhập số → `POST /deposits { method:'sepay', amount }` → VietQR + poll.
 *  - CryptoBot (USDT): nhập USDT → `POST /deposits { method:'cryptobot', amount }` → mở pay_url + poll.
 *  - Cộng tiền thực do webhook xử lý; view chỉ đọc trạng thái. Telegram BackButton + TopAppBar back.
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { CircleCheck, Wallet, CircleDollarSign, Landmark } from '@lucide/vue'
import TopAppBar from '@/components/TopAppBar.vue'
import GlassButton from '@/components/GlassButton.vue'
import QrPanel from '@/components/QrPanel.vue'
import SegmentedControl from '@/components/SegmentedControl.vue'
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
const cancelling = ref(false)

const isCrypto = computed(() => selectedMethod.value === 'cryptobot')

const methodOptions = computed(() =>
  methods.value.map((m) => ({
    value: m.id,
    label: m.id === 'sepay' ? t('deposit.method_sepay_short') : t('deposit.method_cryptobot_short'),
  }))
)
const created = computed(() => createdSepay.value !== null || createdCrypto.value !== null)

const amount = computed<number | null>(() => {
  if (!amountInput.value) return null
  const n = Number(amountInput.value)
  if (!Number.isFinite(n) || n <= 0) return null
  if (!isCrypto.value && !Number.isInteger(n)) return null
  return n
})

const estimatedVnd = computed<number | null>(() => {
  if (!isCrypto.value || amount.value === null) return null
  const rate = user.state.rate
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) return null
  return Math.floor(amount.value * rate)
})

const estimatedVndDisplay = computed(() =>
  estimatedVnd.value === null ? '' : formatCurrency(estimatedVnd.value)
)

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
      if (typeof res.new_balance === 'number') user.setBalance(res.new_balance, res.new_balance_display)
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

async function cancelDeposit(): Promise<void> {
  if (depositId.value === null || cancelling.value) return
  cancelling.value = true
  try {
    await ui.withLoading(post<DepositStatusDto>(`/deposits/${depositId.value}/cancel`))
    stopPolling()
    status.value = 'cancelled'
    ui.haptic('light')
    ui.toast(t('deposit.cancelled'), 'success')
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return
    ui.toast(t('deposit.cancel_error'), 'error')
  } finally {
    cancelling.value = false
  }
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
  <div>
    <TopAppBar :title="$t('deposit.title')" back />

    <main class="mx-auto flex max-w-md flex-col gap-5 px-gutter pb-10 pt-[calc(56px+var(--safe-top))]">
      <template v-if="!created">
        <!-- Có phương thức khả dụng cho vùng → form nạp; không có → empty-state (R8.3). -->
        <template v-if="methods.length">
        <!-- Phương thức nạp: chọn khi >1, hiển thị cố định khi chỉ có 1 -->
        <section class="mt-4 flex flex-col gap-2">
          <h2 class="px-1 font-mono text-[12px] uppercase tracking-wider text-on-surface-variant">
            {{ $t('deposit.method_label') }}
          </h2>
          <SegmentedControl
            v-if="methods.length > 1"
            :model-value="selectedMethod"
            :options="methodOptions"
            @update:model-value="selectMethod($event as 'sepay' | 'cryptobot')"
          />
          <div
            v-else
            class="glass-card flex items-center gap-4 rounded-xl border border-primary/50 p-4"
          >
            <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-container/20 text-primary">
              <component :is="isCrypto ? CircleDollarSign : Landmark" :size="22" :stroke-width="2" aria-hidden="true" />
            </div>
            <div class="flex-1">
              <h4 class="text-[16px] text-on-surface">
                {{ isCrypto ? $t('deposit.method_cryptobot') : $t('deposit.method_sepay') }}
              </h4>
              <p class="font-mono text-[12px] text-on-surface-variant">
                {{ isCrypto ? $t('deposit.method_cryptobot_desc') : $t('deposit.method_sepay_desc') }}
              </p>
            </div>
          </div>
        </section>

        <!-- SePay: grid mệnh giá -->
        <section v-if="!isCrypto" class="flex flex-col gap-3">
          <div class="grid grid-cols-2 gap-3">
            <button
              v-for="preset in PRESET_AMOUNTS"
              :key="preset"
              type="button"
              class="rounded-xl px-4 py-3 text-[16px] font-semibold tabular-nums transition-transform active:scale-[0.97]"
              :class="amount === preset ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface'"
              :aria-pressed="amount === preset"
              @click="selectPreset(preset)"
            >
              {{ formatCurrency(preset) }}
            </button>
          </div>
        </section>

        <!-- Ô nhập số tiền -->
        <section class="flex flex-col gap-2">
          <h2 class="px-1 font-mono text-[12px] uppercase tracking-wider text-on-surface-variant">
            {{ isCrypto ? $t('deposit.amount_usdt') : $t('deposit.amount_vnd') }}
          </h2>
          <div class="flex items-center gap-2 rounded-xl border border-outline-variant/30 bg-surface-container-high px-4 py-3">
            <input
              :value="amountInput"
              type="text"
              :inputmode="isCrypto ? 'decimal' : 'numeric'"
              :placeholder="$t('deposit.amount_placeholder')"
              class="w-full bg-transparent text-[22px] font-semibold tabular-nums text-on-surface outline-none placeholder:text-outline"
              @input="onAmountInput"
            />
            <span class="text-[22px] text-on-surface-variant" aria-hidden="true">{{ isCrypto ? 'USDT' : 'đ' }}</span>
          </div>
          <p v-if="isCrypto && estimatedVndDisplay" class="px-1 text-[13px] tabular-nums text-on-surface-variant">
            {{ $t('deposit.approx_vnd', { vnd: estimatedVndDisplay }) }}
          </p>
        </section>

        <GlassButton block :disabled="submitting || amount === null" @click="submitDeposit">
          {{ $t('deposit.create') }}
        </GlassButton>
        </template>

        <!-- Không phương thức nào khả dụng cho vùng → thông báo thay vì form SePay vỡ -->
        <div v-else class="mt-10 flex flex-col items-center gap-3 text-center">
          <span
            class="flex h-16 w-16 items-center justify-center rounded-full bg-surface-container text-on-surface-variant"
            aria-hidden="true"
          >
            <Wallet :size="30" :stroke-width="1.75" />
          </span>
          <h2 class="text-[18px] font-semibold text-on-surface">{{ $t('deposit.no_methods_title') }}</h2>
          <p class="max-w-xs text-[15px] text-on-surface-variant">{{ $t('deposit.no_methods_desc') }}</p>
        </div>
      </template>

      <!-- Sau khi tạo -->
      <template v-else>
        <div class="mt-4">
          <div
            v-if="status === 'pending'"
            class="flex flex-col gap-2 rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-4"
          >
            <div class="flex items-center gap-3">
              <span class="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent" aria-hidden="true" />
              <span class="text-[16px] font-semibold text-on-surface">{{ $t('deposit.waiting') }}</span>
            </div>
            <p v-if="createdCrypto" class="text-[13px] tabular-nums text-on-surface-variant">
              {{ $t('deposit.approx_vnd', { vnd: createdCrypto.credit_vnd_display }) }}
            </p>
          </div>

          <div
            v-else-if="status === 'completed'"
            class="flex flex-col items-center gap-2 rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-6 text-center"
          >
            <CircleCheck :size="40" :stroke-width="1.75" class="text-tertiary" aria-hidden="true" />
            <h2 class="text-[18px] font-semibold text-on-surface">{{ $t('deposit.success') }}</h2>
          </div>

          <div
            v-else-if="status === 'cancelled' || status === 'expired'"
            class="flex flex-col items-center gap-2 rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-6 text-center"
          >
            <h2 class="text-[18px] font-semibold text-on-surface">
              {{ status === 'cancelled' ? $t('deposit.cancelled') : $t('deposit.expired') }}
            </h2>
          </div>
        </div>

        <!-- CryptoBot: mở lại liên kết -->
        <GlassButton v-if="createdCrypto && status === 'pending'" block @click="openLink(createdCrypto.pay_url)">
          {{ $t('deposit.pay_crypto') }}
        </GlassButton>

        <!-- SePay: VietQR -->
        <QrPanel
          v-if="createdSepay && status === 'pending'"
          :qr-url="createdSepay.qr_url"
          :bank-name="createdSepay.bank_name"
          :bank-account="createdSepay.bank_account"
          :bank-owner="createdSepay.bank_owner"
          :amount-display="createdSepay.amount_display"
          :transfer-code="createdSepay.transfer_code"
        />

        <GlassButton v-if="status === 'pending'" variant="secondary" block :disabled="cancelling" @click="cancelDeposit">
          {{ $t('deposit.cancel') }}
        </GlassButton>

        <GlassButton v-else variant="ghost" block @click="resetDeposit">
          {{ $t('common.back') }}
        </GlassButton>
      </template>
    </main>
  </div>
</template>
