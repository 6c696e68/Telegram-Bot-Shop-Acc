/**
 * stores/user.ts — trạng thái người mua (singleton reactive, không cần Pinia).
 *
 * Giữ thông tin định danh + số dư của Buyer, nạp từ `GET /api/app/me`. Số dư được
 * cập nhật ngay sau khi mua (`PurchaseResultDto.new_balance`) hoặc khi poll nạp tiền
 * chuyển sang `completed` (`DepositStatusDto.new_balance`).
 *
 * Stateless theo Req 1.7: KHÔNG persist gì ra localStorage — state chỉ sống trong phiên
 * WebApp; mỗi lần mở lại app sẽ `fetchMe()` mới.
 */

import { reactive, readonly, type DeepReadonly } from 'vue'
import { get, post, request } from '@/api/client'
import { formatCurrency } from '@/utils/format'
import { setLocale } from '@/i18n'
import type { MeDto } from '@/types'

export interface UserState {
  telegramId: number | null
  username: string | null
  firstName: string | null
  balance: number
  balanceDisplay: string
  region: 'vietnam' | 'international' | null
  language: string | null
  /** `true` sau khi `fetchMe()` thành công lần đầu (để view phân biệt với trạng thái chưa nạp). */
  loaded: boolean
}

const state = reactive<UserState>({
  telegramId: null,
  username: null,
  firstName: null,
  balance: 0,
  balanceDisplay: '',
  region: null,
  language: null,
  loaded: false,
})

/** Nạp thông tin người mua từ `GET /api/app/me` (Req 4.1, 12.1, 12.2). */
async function fetchMe(): Promise<void> {
  const me = await get<MeDto>('/me')
  state.telegramId = me.telegram_id
  state.username = me.username
  state.firstName = me.first_name
  state.balance = me.balance
  state.balanceDisplay = me.balance_display
  state.region = me.region
  state.language = me.language
  state.loaded = true
  // Đồng bộ ngôn ngữ hiển thị theo user (R17.2). Chưa xác định → giữ fallback en (R17.3).
  setLocale(me.language)
}

/** Lưu vùng (R2.3, R2.4, R5.2) — set region + đồng bộ language/locale từ phản hồi server. */
async function setRegion(region: 'vietnam' | 'international'): Promise<void> {
  const me = await post<MeDto>('/region', { region })
  state.region = me.region
  state.language = me.language
  setLocale(me.language)
}

/** Đổi ngôn ngữ hiển thị (R6.2) — lưu server + cập nhật locale reactive (R17.4). */
async function setLanguage(language: string): Promise<void> {
  await request<{ language: string }>('/language', { method: 'PUT', body: { language } })
  state.language = language
  setLocale(language)
}

/**
 * Cập nhật số dư sau giao dịch (mua/nạp).
 * @param balance Số dư mới (INTEGER VNĐ).
 * @param display Chuỗi hiển thị từ server nếu có; thiếu thì format cục bộ cho khớp định dạng.
 */
function setBalance(balance: number, display?: string): void {
  state.balance = balance
  state.balanceDisplay = display ?? formatCurrency(balance)
}

/** Reset state khi cần (vd unauthorized) — không bắt buộc dùng. */
function reset(): void {
  state.telegramId = null
  state.username = null
  state.firstName = null
  state.balance = 0
  state.balanceDisplay = ''
  state.region = null
  state.language = null
  state.loaded = false
}

/**
 * Composable truy cập user store.
 * `state` là read-only đối với view — chỉ được đổi qua các action bên dưới.
 */
export function useUserStore(): {
  state: DeepReadonly<UserState>
  fetchMe: () => Promise<void>
  setBalance: (balance: number, display?: string) => void
  setRegion: (region: 'vietnam' | 'international') => Promise<void>
  setLanguage: (language: string) => Promise<void>
  reset: () => void
} {
  return {
    state: readonly(state),
    fetchMe,
    setBalance,
    setRegion,
    setLanguage,
    reset,
  }
}
