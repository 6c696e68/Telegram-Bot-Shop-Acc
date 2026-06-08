import { Hono } from 'hono'
import type { Bindings } from '../../types'
import type { AdminVariables } from '../../middleware/jwt-auth'
import { jwtAuth } from '../../middleware/jwt-auth'
import { resolvePayOsConfig } from '../../services/payos-config'
import { confirmWebhook, PayOsApiError } from '../../services/payments/payos-client'

type PayosAdminEnv = {
  Bindings: Bindings
  Variables: AdminVariables
}

const payosAdminRoutes = new Hono<PayosAdminEnv>()

// Mọi route admin PayOS yêu cầu JWT.
payosAdminRoutes.use('/*', jwtAuth)

/**
 * POST /confirm-webhook
 * Đăng ký webhook URL với PayOS để PayOS gửi callback xác nhận thanh toán.
 *
 * - `webhookUrl` được suy ra từ origin của request hiện tại: `${origin}/webhook/payos`
 *   (cùng host CMS/Worker đang phục vụ), nên admin không cần nhập tay.
 * - Đọc credentials qua `resolvePayOsConfig` (DB-first → env) rồi gọi
 *   `confirmWebhook`. PayOS ping thử URL; thành công → `code === '00'`.
 * - KHÔNG bao giờ log/echo `apiKey`/`checksumKey` ra response (R24.1, R24.3).
 *
 * Requirements: 24.1, 24.3
 */
payosAdminRoutes.post('/confirm-webhook', async (c) => {
  const { clientId, apiKey } = await resolvePayOsConfig(c.env.DB, c.env)

  if (!clientId || !apiKey) {
    return c.json(
      { success: false, data: null, error: 'payos_not_configured' },
      400
    )
  }

  const origin = new URL(c.req.url).origin
  const webhookUrl = `${origin}/webhook/payos`

  try {
    await confirmWebhook({ clientId, apiKey, webhookUrl })
  } catch (err) {
    // PayOsApiError đã được làm sạch (không chứa secret). Lỗi khác → thông báo chung.
    const message = err instanceof PayOsApiError ? err.message : 'payos_confirm_failed'
    return c.json(
      { success: false, data: null, error: message },
      502
    )
  }

  return c.json({
    success: true,
    data: { webhook_url: webhookUrl },
    error: null,
  })
})

export { payosAdminRoutes }
