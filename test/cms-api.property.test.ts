import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'
import { SignJWT } from 'jose'
import { app } from '../src/index'
import {
  cleanThreeTierTables,
  resetThreeTierSchema,
  seedCategory,
} from './helpers/three-tier-schema'

/**
 * Property-based tests cho CMS API.
 * **Validates: Requirements 13.4, 12.7**
 *
 * Property 17: API response format chuẩn
 *   — mọi response có success, data, error
 *   — success=true → error=null
 *   — success=false → data=null
 *
 * Property 19: Audit log cho mọi admin action
 *   — mỗi CMS write operation tạo audit_log record đúng
 */

const JWT_SECRET = 'test-jwt-secret'

async function cleanTables(db: D1Database) {
  await cleanThreeTierTables(db)
}

async function seedAdminUser(db: D1Database): Promise<number> {
  // bcrypt hash of "testpassword123"
  const hash = '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012'
  await db
    .prepare(
      "INSERT INTO admin_users (username, password_hash, display_name, created_at) VALUES ('testadmin', ?, 'Test Admin', datetime('now'))"
    )
    .bind(hash)
    .run()
  const admin = await db
    .prepare("SELECT id FROM admin_users WHERE username = 'testadmin'")
    .first<{ id: number }>()
  return admin!.id
}

async function seedUser(db: D1Database, balance: number): Promise<number> {
  const telegramId = Math.floor(Math.random() * 2_000_000_000)
  await db
    .prepare(
      "INSERT INTO users (telegram_id, username, first_name, balance, created_at, updated_at) VALUES (?, 'user1', 'User', ?, datetime('now'), datetime('now'))"
    )
    .bind(telegramId, balance)
    .run()
  const user = await db
    .prepare('SELECT id FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<{ id: number }>()
  return user!.id
}

async function generateJwt(adminId: number, username = 'testadmin'): Promise<string> {
  const secret = new TextEncoder().encode(JWT_SECRET)
  return new SignJWT({ sub: String(adminId), username })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(secret)
}

function getEnvBindings() {
  return {
    DB: env.DB,
    SEPAY_API_KEY: 'test-sepay-key',
    BOT_TOKEN: 'test-bot-token',
    TELEGRAM_SECRET_TOKEN: 'test-telegram-secret',
    ADMIN_IDS: '123456789',
    JWT_SECRET,
    BANK_NAME: 'Vietcombank',
    BANK_ACCOUNT: '1017588888',
    BANK_OWNER: 'NGUYEN VAN TEST',
  }
}

async function apiRequest(
  method: string,
  path: string,
  token: string,
  body?: unknown
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  }
  const init: RequestInit = { method, headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  return app.request(path, init, getEnvBindings() as any)
}

// --- Arbitraries ---

// Valid product type names (1-100 chars, non-empty)
const arbValidName = fc
  .string({ minLength: 1, maxLength: 100 })
  .filter((s) => s.trim().length > 0)

// Valid descriptions (0-500 chars)
const arbValidDescription = fc.string({ minLength: 0, maxLength: 500 })

// Valid prices (integer 1-999999999)
const arbValidPrice = fc.integer({ min: 1, max: 999_999_999 })

// Invalid names: empty or too long
const arbInvalidName = fc.oneof(
  fc.constant(''),
  fc.constant('   '),
  fc.string({ minLength: 101, maxLength: 150 })
)

// Invalid prices
const arbInvalidPrice = fc.oneof(
  fc.integer({ min: -1_000_000, max: 0 }),
  fc.integer({ min: 1_000_000_000, max: 2_000_000_000 })
)

// System config keys
const arbConfigKey = fc.constantFrom('shop_name', 'bank_name', 'min_deposit', 'max_deposit')
const arbConfigValue = fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0)

// Balance adjustment amounts
const arbAdjustAmount = fc.integer({ min: -500_000, max: 5_000_000 })
const arbAdjustReason = fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0)

describe('Property 17: API response format chuẩn', () => {
  let adminId: number
  let token: string

  beforeEach(async () => {
    await resetThreeTierSchema(env.DB)
    await cleanTables(env.DB)
    adminId = await seedAdminUser(env.DB)
    token = await generateJwt(adminId)
  })

  /**
   * **Validates: Requirements 13.4**
   * Success responses must have: success=true, data!==null, error===null
   */
  it('successful responses have success=true, data!==null, error===null', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbValidName,
        arbValidDescription,
        async (name, description) => {
          // POST product-types (success case)
          const res = await apiRequest('POST', '/api/admin/product-types', token, {
            name,
            description,
          })

          const json = await res.json() as { success: boolean; data: unknown; error: unknown }

          // Verify standard format
          expect(json).toHaveProperty('success')
          expect(json).toHaveProperty('data')
          expect(json).toHaveProperty('error')

          // success=true → error must be null, data must not be null
          if (json.success) {
            expect(json.error).toBeNull()
            expect(json.data).not.toBeNull()
          }

          // Clean up created record for isolation
          if (json.success && json.data && typeof json.data === 'object' && 'id' in (json.data as object)) {
            await env.DB
              .prepare('DELETE FROM product_types WHERE id = ?')
              .bind((json.data as { id: number }).id)
              .run()
            await env.DB
              .prepare('DELETE FROM audit_logs WHERE resource_id = ?')
              .bind((json.data as { id: number }).id)
              .run()
          }
        }
      ),
      { numRuns: 15 }
    )
  })

  /**
   * **Validates: Requirements 13.4**
   * Error responses must have: success=false, data===null, error!==null (string)
   */
  it('error responses have success=false, data===null, error!==null', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbInvalidName,
        arbValidDescription,
        async (invalidName, description) => {
          // POST product-types with invalid name (error case)
          const res = await apiRequest('POST', '/api/admin/product-types', token, {
            name: invalidName,
            description,
          })

          const json = await res.json() as { success: boolean; data: unknown; error: unknown }

          // Verify standard format
          expect(json).toHaveProperty('success')
          expect(json).toHaveProperty('data')
          expect(json).toHaveProperty('error')

          // success=false → data must be null, error must be a string
          if (!json.success) {
            expect(json.data).toBeNull()
            expect(json.error).not.toBeNull()
            expect(typeof json.error).toBe('string')
          }
        }
      ),
      { numRuns: 15 }
    )
  })

  /**
   * **Validates: Requirements 13.4**
   * Invalid price produces error response with correct format
   */
  it('invalid price produces standard error format', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbValidName,
        arbInvalidPrice,
        async (name, invalidPrice) => {
          const categoryId = await seedCategory(env.DB, 'Products')
          const res = await apiRequest('POST', '/api/admin/products', token, {
            product_type_id: categoryId,
            name,
            price: invalidPrice,
          })

          const json = await res.json() as { success: boolean; data: unknown; error: unknown }

          expect(json).toHaveProperty('success')
          expect(json).toHaveProperty('data')
          expect(json).toHaveProperty('error')

          expect(json.success).toBe(false)
          expect(json.data).toBeNull()
          expect(json.error).not.toBeNull()
          expect(typeof json.error).toBe('string')
        }
      ),
      { numRuns: 15 }
    )
  })

  /**
   * **Validates: Requirements 13.4**
   * Unauthorized requests (no/invalid token) also follow the format
   */
  it('unauthorized requests follow standard error format', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbValidName,
        async (name) => {
          // Request without valid token
          const res = await app.request('/api/admin/product-types', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: 'Bearer invalid-token-xyz',
            },
            body: JSON.stringify({ name }),
          }, getEnvBindings() as any)

          const json = await res.json() as { success: boolean; data: unknown; error: unknown }

          expect(json).toHaveProperty('success')
          expect(json).toHaveProperty('data')
          expect(json).toHaveProperty('error')

          expect(json.success).toBe(false)
          expect(json.data).toBeNull()
          expect(json.error).not.toBeNull()
          expect(typeof json.error).toBe('string')
        }
      ),
      { numRuns: 10 }
    )
  })

  /**
   * **Validates: Requirements 13.4**
   * GET listing endpoints always return success format with meta
   */
  it('GET listing endpoints return standard success format', async () => {
    const listEndpoints = [
      '/api/admin/product-types',
      '/api/admin/products',
      '/api/admin/users',
      '/api/admin/orders',
      '/api/admin/config',
    ]

    for (const endpoint of listEndpoints) {
      const res = await apiRequest('GET', endpoint, token)
      const json = await res.json() as { success: boolean; data: unknown; error: unknown }

      expect(json).toHaveProperty('success')
      expect(json).toHaveProperty('data')
      expect(json).toHaveProperty('error')
      expect(json.success).toBe(true)
      expect(json.error).toBeNull()
      expect(json.data).not.toBeNull()
    }
  })
})

describe('Property 19: Audit log cho mọi admin action', () => {
  let adminId: number
  let token: string

  beforeEach(async () => {
    await resetThreeTierSchema(env.DB)
    await cleanTables(env.DB)
    adminId = await seedAdminUser(env.DB)
    token = await generateJwt(adminId)
  })

  /**
   * **Validates: Requirements 12.7**
   * POST product-types creates audit_log with action='create', resource_type='product_type'
   */
  it('creating product type generates audit log with correct fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbValidName,
        arbValidDescription,
        async (name, description) => {
          // Clean audit logs for this test iteration
          await env.DB.prepare('DELETE FROM audit_logs').run()

          const res = await apiRequest('POST', '/api/admin/product-types', token, {
            name,
            description,
          })

          const json = await res.json() as { success: boolean; data: { id: number } | null }

          if (json.success && json.data) {
            // Verify audit_log record exists
            const log = await env.DB
              .prepare(
                "SELECT * FROM audit_logs WHERE resource_type = 'product_type' AND action = 'create' AND resource_id = ?"
              )
              .bind(json.data.id)
              .first<{
                admin_id: number
                action: string
                resource_type: string
                resource_id: number
                new_value: string | null
              }>()

            expect(log).not.toBeNull()
            expect(log!.admin_id).toBe(adminId)
            expect(log!.action).toBe('create')
            expect(log!.resource_type).toBe('product_type')
            expect(log!.resource_id).toBe(json.data.id)
            expect(log!.new_value).not.toBeNull()

            // Clean up for next iteration
            await env.DB.prepare('DELETE FROM product_types WHERE id = ?').bind(json.data.id).run()
          }
        }
      ),
      { numRuns: 15 }
    )
  })

  /**
   * **Validates: Requirements 12.7**
   * PUT product-types/:id creates audit_log with action='update'
   */
  it('updating product type generates audit log with action=update', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbValidName,
        arbValidName,
        async (origName, newName) => {
          await env.DB.prepare('DELETE FROM audit_logs').run()
          await env.DB.prepare('DELETE FROM product_types').run()

          // Create a product type first
          const now = new Date().toISOString()
          await env.DB
            .prepare(
              'INSERT INTO product_types (name, created_at, updated_at) VALUES (?, ?, ?)'
            )
            .bind(origName.trim() || 'OrigName', now, now)
            .run()
          const pt = await env.DB
            .prepare('SELECT id FROM product_types ORDER BY id DESC LIMIT 1')
            .first<{ id: number }>()

          // Update it via API
          const res = await apiRequest('PUT', `/api/admin/product-types/${pt!.id}`, token, {
            name: newName,
          })

          const json = await res.json() as { success: boolean }

          if (json.success) {
            // Verify audit_log record
            const log = await env.DB
              .prepare(
                "SELECT * FROM audit_logs WHERE resource_type = 'product_type' AND action = 'update' AND resource_id = ?"
              )
              .bind(pt!.id)
              .first<{
                admin_id: number
                action: string
                resource_type: string
                resource_id: number
                old_value: string | null
                new_value: string | null
              }>()

            expect(log).not.toBeNull()
            expect(log!.admin_id).toBe(adminId)
            expect(log!.action).toBe('update')
            expect(log!.resource_type).toBe('product_type')
            expect(log!.resource_id).toBe(pt!.id)
            expect(log!.old_value).not.toBeNull()
            expect(log!.new_value).not.toBeNull()
          }
        }
      ),
      { numRuns: 15 }
    )
  })

  /**
   * **Validates: Requirements 12.7**
   * DELETE product-types/:id creates audit_log with action='delete'
   */
  it('deleting product type generates audit log with action=delete', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbValidName,
        async (name) => {
          await env.DB.prepare('DELETE FROM audit_logs').run()
          await env.DB.prepare('DELETE FROM product_items').run()
          await env.DB.prepare('DELETE FROM products').run()
          await env.DB.prepare('DELETE FROM product_types').run()

          // Create product type (no available products → deletable)
          const now = new Date().toISOString()
          await env.DB
            .prepare(
              'INSERT INTO product_types (name, created_at, updated_at) VALUES (?, ?, ?)'
            )
            .bind(name.trim() || 'DeleteMe', now, now)
            .run()
          const pt = await env.DB
            .prepare('SELECT id FROM product_types ORDER BY id DESC LIMIT 1')
            .first<{ id: number }>()

          // Delete via API
          const res = await apiRequest('DELETE', `/api/admin/product-types/${pt!.id}`, token)
          const json = await res.json() as { success: boolean }

          if (json.success) {
            const log = await env.DB
              .prepare(
                "SELECT * FROM audit_logs WHERE resource_type = 'product_type' AND action = 'delete' AND resource_id = ?"
              )
              .bind(pt!.id)
              .first<{
                admin_id: number
                action: string
                resource_type: string
                resource_id: number
                old_value: string | null
              }>()

            expect(log).not.toBeNull()
            expect(log!.admin_id).toBe(adminId)
            expect(log!.action).toBe('delete')
            expect(log!.resource_type).toBe('product_type')
            expect(log!.resource_id).toBe(pt!.id)
            expect(log!.old_value).not.toBeNull()
          }
        }
      ),
      { numRuns: 15 }
    )
  })

  /**
   * **Validates: Requirements 12.7**
   * POST /users/:id/adjust-balance creates audit_log with action='adjust_balance'
   */
  it('adjusting user balance generates audit log', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbAdjustAmount,
        arbAdjustReason,
        async (amount, reason) => {
          await env.DB.prepare('DELETE FROM audit_logs').run()
          await env.DB.prepare('DELETE FROM transactions').run()
          await env.DB.prepare('DELETE FROM users').run()

          // Ensure amount won't cause negative balance
          const initialBalance = Math.max(0, -amount) + 100_000
          const userId = await seedUser(env.DB, initialBalance)

          const res = await apiRequest('POST', `/api/admin/users/${userId}/adjust-balance`, token, {
            amount,
            reason,
          })

          const json = await res.json() as { success: boolean }

          if (json.success) {
            const log = await env.DB
              .prepare(
                "SELECT * FROM audit_logs WHERE resource_type = 'user' AND action = 'adjust_balance' AND resource_id = ?"
              )
              .bind(userId)
              .first<{
                admin_id: number
                action: string
                resource_type: string
                resource_id: number
              }>()

            expect(log).not.toBeNull()
            expect(log!.admin_id).toBe(adminId)
            expect(log!.action).toBe('adjust_balance')
            expect(log!.resource_type).toBe('user')
            expect(log!.resource_id).toBe(userId)
          }
        }
      ),
      { numRuns: 15 }
    )
  })

  /**
   * **Validates: Requirements 12.7**
   * PUT /config creates audit_log entries for each changed config key
   */
  it('updating config generates audit log entries', async () => {
    await fc.assert(
      fc.asyncProperty(arbConfigKey, arbConfigValue, async (key, value) => {
        await env.DB.prepare('DELETE FROM audit_logs').run()
        await env.DB.prepare('DELETE FROM system_config').run()

        // Seed initial config
        await env.DB
          .prepare(
            "INSERT INTO system_config (key, value, updated_at) VALUES (?, 'old_value', datetime('now'))"
          )
          .bind(key)
          .run()

        const res = await apiRequest('PUT', '/api/admin/config', token, {
          configs: { [key]: value },
        })

        const json = await res.json() as { success: boolean; data: { updated: number } }

        if (json.success && json.data.updated > 0) {
          const log = await env.DB
            .prepare(
              "SELECT * FROM audit_logs WHERE resource_type = 'system_config' AND action = 'update'"
            )
            .first<{
              admin_id: number
              action: string
              resource_type: string
              old_value: string | null
              new_value: string | null
            }>()

          expect(log).not.toBeNull()
          expect(log!.admin_id).toBe(adminId)
          expect(log!.action).toBe('update')
          expect(log!.resource_type).toBe('system_config')
        }
      }),
      { numRuns: 15 }
    )
  })
})
