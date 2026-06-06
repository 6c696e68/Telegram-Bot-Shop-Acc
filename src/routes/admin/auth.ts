import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { verifyPassword } from '../../utils/auth'
import { jwtAuth, type AdminVariables } from '../../middleware/jwt-auth'
import type { Bindings } from '../../types'
import type { DbAdminUser } from '../../types/db'

type AuthEnv = {
  Bindings: Bindings
  Variables: AdminVariables
}

const authRoutes = new Hono<AuthEnv>()

/**
 * POST /auth/login
 * Validate credentials, check lockout, create JWT (24h).
 * Requirements: 12.1, 12.2, 12.3, 12.8
 */
authRoutes.post('/login', async (c) => {
  const body = await c.req.json<{ username?: string; password?: string }>()

  if (!body.username || !body.password) {
    return c.json(
      { success: false, data: null, error: 'username_password_required' },
      400
    )
  }

  const { username, password } = body

  // Find admin user by username
  const admin = await c.env.DB.prepare(
    'SELECT * FROM admin_users WHERE username = ?'
  ).bind(username).first<DbAdminUser>()

  if (!admin) {
    return c.json(
      { success: false, data: null, error: 'invalid_credentials' },
      401
    )
  }

  const now = new Date()

  // Check lockout: if locked_until is set and in the future → 403
  if (admin.locked_until) {
    const lockedUntil = new Date(admin.locked_until)
    if (now < lockedUntil) {
      return c.json(
        { success: false, data: null, error: 'account_locked' },
        403
      )
    }
    // Lock period expired, reset lockout state
    await c.env.DB.prepare(
      'UPDATE admin_users SET locked_until = NULL, failed_login_count = 0 WHERE id = ?'
    ).bind(admin.id).run()
    admin.failed_login_count = 0
    admin.locked_until = null
  }

  // Verify password
  const passwordValid = await verifyPassword(password, admin.password_hash)

  if (!passwordValid) {
    const newFailCount = admin.failed_login_count + 1

    // If 5 or more failures → lock for 30 minutes
    if (newFailCount >= 5) {
      const lockedUntil = new Date(now.getTime() + 30 * 60 * 1000).toISOString()
      await c.env.DB.prepare(
        'UPDATE admin_users SET failed_login_count = ?, locked_until = ? WHERE id = ?'
      ).bind(newFailCount, lockedUntil, admin.id).run()

      return c.json(
        { success: false, data: null, error: 'account_locked' },
        403
      )
    }

    await c.env.DB.prepare(
      'UPDATE admin_users SET failed_login_count = ? WHERE id = ?'
    ).bind(newFailCount, admin.id).run()

    return c.json(
      { success: false, data: null, error: 'invalid_credentials' },
      401
    )
  }

  // Success: reset failed_login_count, update last_login_at
  const nowIso = now.toISOString()
  await c.env.DB.prepare(
    'UPDATE admin_users SET failed_login_count = 0, locked_until = NULL, last_login_at = ? WHERE id = ?'
  ).bind(nowIso, admin.id).run()

  // Create JWT (24h expiry)
  const secret = new TextEncoder().encode(c.env.JWT_SECRET)
  const token = await new SignJWT({ sub: String(admin.id), username: admin.username })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secret)

  return c.json({
    success: true,
    data: {
      token,
      admin: {
        id: admin.id,
        username: admin.username,
        display_name: admin.display_name,
        last_login_at: nowIso,
      },
    },
    error: null,
  })
})

/**
 * POST /auth/refresh
 * Requires valid JWT. Issues new JWT with fresh 24h expiry.
 * Requirements: 12.3, 12.5
 */
authRoutes.post('/refresh', jwtAuth, async (c) => {
  const adminId = c.get('adminId')
  const adminUsername = c.get('adminUsername')

  const secret = new TextEncoder().encode(c.env.JWT_SECRET)
  const token = await new SignJWT({ sub: String(adminId), username: adminUsername })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secret)

  return c.json({
    success: true,
    data: { token },
    error: null,
  })
})

/**
 * GET /auth/me
 * Requires valid JWT. Returns admin info.
 * Requirements: 12.4, 12.5
 */
authRoutes.get('/me', jwtAuth, async (c) => {
  const adminId = c.get('adminId')

  const admin = await c.env.DB.prepare(
    'SELECT id, username, display_name, last_login_at FROM admin_users WHERE id = ?'
  ).bind(adminId).first<Pick<DbAdminUser, 'id' | 'username' | 'display_name' | 'last_login_at'>>()

  if (!admin) {
    return c.json(
      { success: false, data: null, error: 'admin_not_found' },
      404
    )
  }

  return c.json({
    success: true,
    data: {
      id: admin.id,
      username: admin.username,
      display_name: admin.display_name,
      last_login_at: admin.last_login_at,
    },
    error: null,
  })
})

export { authRoutes }
