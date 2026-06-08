/**
 * Đăng ký các payment provider tích hợp sẵn vào registry (side-effect khởi tạo).
 *
 * Vì sao cần module riêng (OCP):
 *  - `registry.ts` chỉ cung cấp cơ chế đăng ký/tra cứu, không tự biết provider nào tồn tại.
 *  - Module này là điểm tập trung khai báo provider khả dụng. Thêm provider mới chỉ cần
 *    import instance và thêm vào danh sách dưới đây, không sửa registry lõi.
 *
 * Vì sao `ensureProvidersRegistered()` thay vì side-effect import thuần:
 *  - `registerProvider` throw nếu trùng id. Test (vitest pool workers) có thể reload module
 *    nhiều lần trong khi `registry` Map vẫn giữ state giữa các lần import trong cùng worker.
 *  - Hàm idempotent: chỉ đăng ký provider khi chưa có id trong registry → an toàn khi gọi
 *    nhiều lần ở runtime Worker lẫn test re-import.
 */

import { getProvider, registerProvider } from './registry'
import { sePayProvider } from './sepay-provider'
import { cryptoPayProvider } from './cryptopay-provider'
import { payOsProvider } from './payos-provider'
import type { PaymentProvider } from './types'

/** Danh sách provider tích hợp sẵn. Thêm provider mới → thêm instance vào đây. */
const builtInProviders: readonly PaymentProvider[] = [sePayProvider, cryptoPayProvider, payOsProvider]

/**
 * Đảm bảo toàn bộ provider tích hợp sẵn đã được đăng ký vào registry.
 *
 * Idempotent: bỏ qua provider đã có id trong registry nên gọi nhiều lần vẫn an toàn
 * (không throw). Gọi tại entry point trước khi route/handler dùng `getProvider`.
 */
export function ensureProvidersRegistered(): void {
  for (const provider of builtInProviders) {
    if (getProvider(provider.id) === undefined) {
      registerProvider(provider)
    }
  }
}
