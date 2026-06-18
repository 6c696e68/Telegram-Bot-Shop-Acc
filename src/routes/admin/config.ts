import { Hono } from 'hono'
import type { Bindings } from '../../types'
import type { AdminVariables } from '../../middleware/jwt-auth'
import { jwtAuth } from '../../middleware/jwt-auth'

type ConfigEnv = {
  Bindings: Bindings
  Variables: AdminVariables
}

interface SystemConfigRow {
  key: string
  value: string
  description: string | null
  updated_at: string
  updated_by: number | null
}

const configRoutes = new Hono<ConfigEnv>()

/**
 * Các key cấu hình mang giá trị nhạy cảm (secret/token). KHÔNG bao giờ trả giá trị
 * thật ra response (kể cả cho admin đã đăng nhập) để tránh lộ secret ra client; chỉ
 * báo "đã đặt hay chưa" qua `secrets_set`. PUT bỏ qua giá trị rỗng cho các key này
 * (rỗng = giữ nguyên — vì GET luôn mask thành rỗng, lưu form sẽ không vô tình xoá secret).
 */
const SECRET_CONFIG_KEYS = new Set([
  'sepay_api_key',
  'payos_api_key',
  'payos_checksum_key',
])

// All config routes require JWT auth
configRoutes.use('/*', jwtAuth)

/**
 * GET /config
 * Return all system_config rows as key-value object.
 * Secret keys được mask (trả rỗng) + cờ `secrets_set` cho biết đã có giá trị hiệu lực.
 * Requirements: 11.10, 13.1, 19.5 (không lộ secret ra response)
 */
configRoutes.get('/', async (c) => {
  const rows = await c.env.DB.prepare(
    'SELECT key, value, description, updated_at, updated_by FROM system_config'
  ).all<SystemConfigRow>()

  // Build key-value map. Secret keys → mask thành '' (không lộ giá trị thật).
  const configs: Record<string, string> = {}
  const secretsSet: Record<string, boolean> = {}
  for (const row of rows.results) {
    if (SECRET_CONFIG_KEYS.has(row.key)) {
      secretsSet[row.key] = row.value.trim() !== ''
      configs[row.key] = ''
    } else {
      configs[row.key] = row.value
    }
  }

  // Env fallback CHỈ cho key KHÔNG nhạy cảm (để CMS hiển thị giá trị hiệu lực, promote env→DB).
  // `crypto_pay_api_token` cố ý hiển thị giá trị thật (admin yêu cầu xem token trên CMS):
  // không mask, và nếu chỉ đặt qua secret env thì vẫn hiện để đối chiếu.
  const envFallback: Record<string, string | undefined> = {
    bank_name: c.env.BANK_NAME,
    bank_account: c.env.BANK_ACCOUNT,
    bank_owner: c.env.BANK_OWNER,
    admin_ids: c.env.ADMIN_IDS,
    crypto_pay_api_token: c.env.CRYPTO_PAY_API_TOKEN,
    payos_client_id: c.env.PAYOS_CLIENT_ID,
    bot_token: c.env.BOT_TOKEN,
    telegram_secret_token: c.env.TELEGRAM_SECRET_TOKEN,
  }
  for (const [key, envValue] of Object.entries(envFallback)) {
    const current = configs[key]
    if ((current === undefined || current.trim() === '') && envValue && envValue.trim() !== '') {
      configs[key] = envValue
    }
  }

  // Secret coi như "đã đặt" nếu có ở DB hoặc env (không lộ giá trị, chỉ cờ boolean).
  const secretEnv: Record<string, string | undefined> = {
    sepay_api_key: c.env.SEPAY_API_KEY,
    payos_api_key: c.env.PAYOS_API_KEY,
    payos_checksum_key: c.env.PAYOS_CHECKSUM_KEY,
  }
  for (const key of SECRET_CONFIG_KEYS) {
    if (!secretsSet[key] && (secretEnv[key]?.trim() ?? '') !== '') {
      secretsSet[key] = true
    }
  }

  return c.json({
    success: true,
    data: { configs, secrets_set: secretsSet },
    error: null,
  })
})

/**
 * PUT /config
 * Body: { configs: { key: value, ... } }
 * Update each config key's value and updated_at.
 * Write audit_log for each changed key (old_value → new_value).
 * Requirements: 11.10, 13.1
 */
configRoutes.put('/', async (c) => {
  const body = await c.req.json<{ configs?: Record<string, string> }>()

  if (!body.configs || typeof body.configs !== 'object') {
    return c.json(
      { success: false, data: null, error: 'configs_required' },
      400
    )
  }

  const adminId = c.get('adminId')
  const now = new Date().toISOString()
  const entries = Object.entries(body.configs)

  if (entries.length === 0) {
    return c.json({
      success: true,
      data: { updated: 0 },
      error: null,
    })
  }

  // Fetch current values for audit log comparison
  const keys = entries.map(([k]) => k)
  const placeholders = keys.map(() => '?').join(', ')
  const currentRows = await c.env.DB.prepare(
    `SELECT key, value FROM system_config WHERE key IN (${placeholders})`
  ).bind(...keys).all<{ key: string; value: string }>()

  const currentMap = new Map<string, string>()
  for (const row of currentRows.results) {
    currentMap.set(row.key, row.value)
  }

  // Build batch statements: update configs + insert audit logs
  const stmts: D1PreparedStatement[] = []
  let updatedCount = 0

  for (const [key, newValue] of entries) {
    // Secret key + giá trị rỗng → BỎ QUA (GET mask secret thành rỗng; lưu form không
    // được vô tình xoá secret đang có). Muốn đổi secret thì admin nhập giá trị mới.
    if (SECRET_CONFIG_KEYS.has(key) && String(newValue).trim() === '') {
      continue
    }

    const oldValue = currentMap.get(key)

    // Only update if key exists and value actually changed
    if (oldValue === undefined) {
      // Key doesn't exist — skip or insert (we'll do upsert)
      // Use INSERT OR REPLACE to support new keys as well
      stmts.push(
        c.env.DB.prepare(
          'INSERT OR REPLACE INTO system_config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)'
        ).bind(key, String(newValue), now, adminId)
      )
      // Audit log for new key
      stmts.push(
        c.env.DB.prepare(
          'INSERT INTO audit_logs (admin_id, action, resource_type, resource_id, old_value, new_value, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(adminId, 'update', 'system_config', null, null, String(newValue), null, now)
      )
      updatedCount++
    } else if (oldValue !== String(newValue)) {
      // Value changed — update
      stmts.push(
        c.env.DB.prepare(
          'UPDATE system_config SET value = ?, updated_at = ?, updated_by = ? WHERE key = ?'
        ).bind(String(newValue), now, adminId, key)
      )
      // Audit log for changed value
      stmts.push(
        c.env.DB.prepare(
          'INSERT INTO audit_logs (admin_id, action, resource_type, resource_id, old_value, new_value, ip_address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(adminId, 'update', 'system_config', null, oldValue, String(newValue), null, now)
      )
      updatedCount++
    }
    // If value unchanged — skip
  }

  if (stmts.length > 0) {
    await c.env.DB.batch(stmts)
  }

  return c.json({
    success: true,
    data: { updated: updatedCount },
    error: null,
  })
})

/**
 * POST /config/set-telegram-webhook
 * Gọi Telegram API setWebhook dùng bot_token + telegram_secret_token hiện tại (DB-first, fallback env).
 * URL webhook = origin hiện tại + /webhook/telegram.
 * Trả kết quả Telegram API (ok/description).
 */
configRoutes.post('/set-telegram-webhook', async (c) => {
  const { resolveBotToken, resolveTelegramSecretToken } = await import('../../services/telegram-config')
  const botToken = await resolveBotToken(c.env.DB, c.env)
  const secretToken = await resolveTelegramSecretToken(c.env.DB, c.env)

  if (!botToken) {
    return c.json({ success: false, data: null, error: 'bot_token_missing' }, 400)
  }

  // Derive webhook URL from the Worker's own URL (same origin).
  const workerUrl = new URL(c.req.url)
  const webhookUrl = `${workerUrl.origin}/webhook/telegram`

  // Call Telegram setWebhook
  const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      ...(secretToken ? { secret_token: secretToken } : {}),
    }),
  })
  const tgBody = await tgRes.json() as { ok: boolean; description?: string }

  if (!tgBody.ok) {
    return c.json({ success: false, data: null, error: tgBody.description || 'telegram_api_error' }, 502)
  }

  return c.json({ success: true, data: { webhook_url: webhookUrl }, error: null })
})

export { configRoutes }
