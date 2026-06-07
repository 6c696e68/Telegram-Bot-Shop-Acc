import { ref } from 'vue'
import { api } from '@/api/client'
import { parseRate } from '@/utils/format'

/**
 * Tỷ giá USDT→VND dùng chung cho toàn bộ CMS (R4.3).
 * Khai báo ở phạm vi module nên mọi view chia sẻ cùng một ref reactive:
 * ConfigView nạp một lần là các view khác đọc được ngay, không refetch.
 * null = chưa có/không hợp lệ → các formatter hiển thị VND-only (fail-safe).
 */
const rate = ref<number | null>(null)

export function useExchangeRate() {
  /** Nạp `GET /api/admin/config` và parse `exchange_rate_usdt_vnd` vào ref dùng chung. */
  async function load(): Promise<void> {
    const res = await api.get<{ configs: Record<string, string> }>('/config')
    if (res.success && res.data) {
      rate.value = parseRate(res.data.configs?.exchange_rate_usdt_vnd)
    }
  }

  return { rate, load }
}
