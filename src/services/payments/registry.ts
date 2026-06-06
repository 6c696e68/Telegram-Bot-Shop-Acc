/**
 * Payment Provider registry — điểm đăng ký + tra cứu provider (OCP).
 *
 * Thêm một provider mới:
 *  1. Implement `PaymentProvider` ở `src/services/payments/<provider>-provider.ts`.
 *  2. Gọi `registerProvider(instance)` (thường tại module đăng ký, vd task 5.3).
 *  3. Khai báo provider khả dụng cho vùng trong `METHODS_BY_REGION` nếu cần mở rộng.
 *
 * KHÔNG sửa logic cộng tiền dùng chung hay route lõi khi thêm provider (R7.4).
 */

import type { Region } from '../../i18n/locales'
import { readSystemConfigValue } from '../../utils/system-config'
import type { PaymentProvider, ProviderId } from './types'

/** Bản đồ provider đã đăng ký, khóa theo `ProviderId`. */
const registry: Map<ProviderId, PaymentProvider> = new Map()

/**
 * Tập phương thức nạp khả dụng theo vùng (bảng tra, mở rộng được).
 *  - `vietnam` → SePay + CryptoBot (R8.1).
 *  - `international` → chỉ CryptoBot (R8.2).
 *
 * Thứ tự phần tử quyết định thứ tự hiển thị cho user.
 */
const METHODS_BY_REGION: Record<Region, readonly ProviderId[]> = {
  vietnam: ['sepay', 'cryptobot'],
  international: ['cryptobot'],
}

/**
 * Đăng ký một provider vào registry.
 * @throws nếu `provider.id` không khớp `id` truyền vào hoặc đã đăng ký trùng id.
 */
export function registerProvider(provider: PaymentProvider): void {
  if (registry.has(provider.id)) {
    throw new Error(`Payment provider đã được đăng ký: ${provider.id}`)
  }
  registry.set(provider.id, provider)
}

/**
 * Lấy provider theo id.
 * @returns instance provider, hoặc `undefined` nếu chưa đăng ký.
 */
export function getProvider(id: ProviderId): PaymentProvider | undefined {
  return registry.get(id)
}

/**
 * Danh sách `ProviderId` khả dụng cho một vùng (theo đúng thứ tự hiển thị).
 * Không phụ thuộc việc provider đã được đăng ký hay chưa — phản ánh chính sách vùng.
 */
export function methodsForRegion(region: Region): readonly ProviderId[] {
  return METHODS_BY_REGION[region]
}

/** Kiểm tra một provider có khả dụng cho vùng hay không (enforce theo vùng — R8.4). */
export function isMethodAllowedForRegion(region: Region, id: ProviderId): boolean {
  return METHODS_BY_REGION[region].includes(id)
}

/**
 * Provider luôn bật (không cần "test transaction" vì đã chạy ổn định từ trước — R7.6).
 * SePay là provider hiện hữu; provider MỚI bổ sung sau phải được admin bật thủ công
 * sau khi có ≥1 giao dịch nạp thử nghiệm thành công.
 */
const ALWAYS_ENABLED_PROVIDERS: readonly ProviderId[] = ['sepay']

/** Key `system_config` cờ bật provider (admin bật trong CMS sau khi test — R7.6). */
export function providerEnabledConfigKey(id: ProviderId): string {
  return `payment_${id}_enabled`
}

/**
 * Một provider có được MỞ cho user hay không (R7.6).
 *  - Provider luôn-bật (sepay) → true.
 *  - Provider mới (cryptobot...) → chỉ true khi `system_config.payment_<id>_enabled`
 *    có giá trị truthy ('1'/'true'). Mặc định (chưa cấu hình) → false: chưa mở cho user
 *    tới khi admin xác nhận đã chạy thử thành công.
 */
export async function isProviderEnabled(db: D1Database, id: ProviderId): Promise<boolean> {
  if (ALWAYS_ENABLED_PROVIDERS.includes(id)) return true
  const raw = (await readSystemConfigValue(db, providerEnabledConfigKey(id)))?.trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

/**
 * Danh sách provider khả dụng cho vùng SAU khi lọc theo cờ bật (R7.6 + R8).
 * Một query gộp các key cờ; thứ tự giữ theo `methodsForRegion`.
 */
export async function enabledMethodsForRegion(
  db: D1Database,
  region: Region
): Promise<readonly ProviderId[]> {
  const candidates = methodsForRegion(region)
  const checks = await Promise.all(candidates.map((id) => isProviderEnabled(db, id)))
  return candidates.filter((_, i) => checks[i])
}
