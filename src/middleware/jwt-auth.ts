import { createMiddleware } from 'hono/factory'
import { jwtVerify } from 'jose'
import type { Bindings } from '../types'

/**
 * Context variables được set bởi JWT auth middleware.
 */
export type AdminVariables = {
  adminId: number
  adminUsername: string
}

type JwtEnv = {
  Bindings: Bindings
  Variables: AdminVariables
}

/**
 * Middleware xác thực JWT cho CMS API.
 * Parse Bearer token từ Authorization header, verify bằng jose jwtVerify.
 * Set adminId và adminUsername vào Hono context.
 * Trả về 401 nếu token thiếu, expired, hoặc invalid.
 */
export const jwtAuth = createMiddleware<JwtEnv>(async (c, next) => {
  const authHeader = c.req.header('Authorization')

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json(
      { success: false, data: null, error: 'Token expired or invalid' },
      401
    )
  }

  const token = authHeader.slice(7)

  try {
    const secret = new TextEncoder().encode(c.env.JWT_SECRET)
    // Pin thuật toán HS256 (khớp lúc ký) — chặn alg-confusion/`none` (defense-in-depth).
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] })

    const adminId = payload.sub ? Number(payload.sub) : null
    const adminUsername = payload.username as string | undefined

    if (!adminId || !adminUsername) {
      return c.json(
        { success: false, data: null, error: 'Token expired or invalid' },
        401
      )
    }

    c.set('adminId', adminId)
    c.set('adminUsername', adminUsername)

    await next()
  } catch {
    return c.json(
      { success: false, data: null, error: 'Token expired or invalid' },
      401
    )
  }
})
