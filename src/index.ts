import { Hono } from 'hono'
import type { AppEnv } from './types'
import type { Bindings } from './types/bindings'
import { telegramWebhook } from './routes/telegram'
import { sepayWebhook } from './routes/sepay'
import { cryptoPayWebhook } from './routes/cryptopay'
import { payOsWebhook } from './routes/payos'
import { adminApi } from './routes/admin'
import { miniAppApi } from './routes/miniapp-api'
import { staticAssets } from './routes/static'
import { miniAppStatic } from './routes/miniapp-static'
import { expirePendingDeposits } from './services/deposit-expiry'
import { creditAwaitingDeposits } from './services/credit-awaiting'
import { sweepOrphanOrders } from './services/order-cleanup'
import { ensureProvidersRegistered } from './services/payments/register'

// Đăng ký payment provider khi Worker khởi động (idempotent) — populate registry
// trước khi bất kỳ route/handler nào gọi getProvider/methodsForRegion.
ensureProvidersRegistered()

const app = new Hono<AppEnv>()

/**
 * Security headers (defense-in-depth — VUE-HEADERS-001 / EXPRESS-HEADERS-001).
 * - `nosniff` + `Referrer-Policy`: an toàn cho MỌI response (API + SPA + webhook).
 * - Clickjacking: `X-Frame-Options: DENY` CHỈ cho CMS admin (`/cms`). KHÔNG áp cho
 *   Mini App (`/app`) vì Telegram nhúng Mini App qua iframe — DENY sẽ vỡ trên Telegram Web.
 * (CSP không set ở đây: SPA + SDK Telegram dễ vỡ; nên cấu hình/kiểm ở tầng edge.)
 */
app.use('*', async (c, next) => {
  await next()
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
})
app.use('/cms/*', async (c, next) => {
  await next()
  c.header('X-Frame-Options', 'DENY')
})

// Health check
app.get('/health', (c) => c.json({ status: 'ok' }))

// Webhook routes
app.route('/webhook', telegramWebhook)
app.route('/webhook', sepayWebhook)
// Crypto Pay webhook (POST /webhook/cryptopay) — xác thực chữ ký qua cryptoPayAuth.
app.route('/webhook', cryptoPayWebhook)
// PayOS webhook (POST /webhook/payos) — verify chữ ký HMAC trên data đã sort key (R12.1).
app.route('/webhook', payOsWebhook)

// CMS API (JWT protected)
app.route('/api/admin', adminApi)

// Mini App business API (verify initData per-request)
app.route('/api/app', miniAppApi)

// Static assets for Mini App SPA (history mode)
app.route('/app', miniAppStatic)

// Static assets for CMS SPA
app.route('/cms', staticAssets)

// 404 fallback
app.all('*', (c) => c.json({ error: 'Not Found' }, 404))

// Export Hono app instance for testing (app.request())
export { app }

export default {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledEvent, env: Bindings, ctx: ExecutionContext) => {
    // Cron 15 phút: hết hạn deposit pending + dọn orphan order (giao dịch mua dở dang).
    // expirePendingDeposits provider-agnostic: UPDATE WHERE status='pending' (không lọc
    // provider) → áp cho mọi cổng thanh toán theo trạng thái/tuổi.
    // Mỗi job bọc .catch riêng: lỗi một job KHÔNG chặn job khác, không unhandled rejection.
    ctx.waitUntil(
      expirePendingDeposits(env.DB).catch((err) =>
        console.error('[cron] expirePendingDeposits lỗi:', err)
      )
    )
    // Lưới an toàn cộng tiền cho deposit CryptoBot đang `awaiting_credit` khi tỷ giá đã
    // hợp lệ (R12.7). Gọi SAU expirePendingDeposits: expiry chỉ chuyển pending→expired,
    // còn credit-awaiting xử lý trạng thái awaiting_credit độc lập nên không xung đột.
    ctx.waitUntil(
      creditAwaitingDeposits(env, ctx).catch((err) =>
        console.error('[cron] creditAwaitingDeposits lỗi:', err)
      )
    )
    ctx.waitUntil(
      sweepOrphanOrders(env.DB).catch((err) =>
        console.error('[cron] sweepOrphanOrders lỗi:', err)
      )
    )
  },
}
