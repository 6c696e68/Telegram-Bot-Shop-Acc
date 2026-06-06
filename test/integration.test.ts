import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { env } from 'cloudflare:test'
import { SignJWT } from 'jose'
import { app } from '../src/index'
import { transactionService } from '../src/services/transaction'
import { hashPassword } from '../src/utils/auth'

/**
 * Integration Tests — end-to-end flows qua D1 test environment.
 * **Validates: Requirements 4.3, 4.4, 2.6, 12.3**
 */

// ============================
// Schema & Helpers
// ============================

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id INTEGER UNIQUE NOT NULL,
    username TEXT,
    first_name TEXT,
    balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
    is_active INTEGER DEFAULT 1,
    last_interaction_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS product_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    price INTEGER NOT NULL CHECK(price > 0),
    emoji TEXT DEFAULT '📦',
    sort_order INTEGER DEFAULT 0,
    is_visible INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    product_type_id INTEGER NOT NULL REFERENCES product_types(id),
    quantity INTEGER NOT NULL CHECK(quantity > 0),
    total_amount INTEGER NOT NULL,
    transaction_id INTEGER,
    status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed','refunded')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    type TEXT NOT NULL CHECK(type IN ('deposit','purchase','refund','adjustment')),
    amount INTEGER NOT NULL,
    balance_before INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    reference_type TEXT,
    reference_id INTEGER,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'success' CHECK(status IN ('success','failed','pending')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type_id INTEGER NOT NULL REFERENCES product_types(id),
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','sold','reserved')),
    buyer_id INTEGER REFERENCES users(id),
    order_id INTEGER REFERENCES orders(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sold_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_products_content_type ON products(type_id, content)`,
  `CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    transfer_code TEXT UNIQUE NOT NULL,
    amount INTEGER NOT NULL CHECK(amount > 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','expired','cancelled')),
    sepay_transaction_id TEXT,
    bank_ref TEXT,
    completed_at TEXT,
    expired_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    last_login_at TEXT,
    failed_login_count INTEGER DEFAULT 0,
    locked_until TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by INTEGER REFERENCES admin_users(id)
  )`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL REFERENCES admin_users(id),
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id INTEGER,
    old_value TEXT,
    new_value TEXT,
    ip_address TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
]

const JWT_SECRET = 'test-jwt-secret'
const SEPAY_API_KEY = 'test-sepay-api-key-12345'

async function applySchema(db: D1Database) {
  for (const stmt of SCHEMA_STATEMENTS) {
    await db.prepare(stmt).run()
  }
}

async function cleanTables(db: D1Database) {
  await db.prepare('DELETE FROM audit_logs').run()
  await db.prepare('DELETE FROM order_items').run()
  await db.prepare('DELETE FROM products').run()
  await db.prepare('DELETE FROM orders').run()
  await db.prepare('DELETE FROM transactions').run()
  await db.prepare('DELETE FROM deposits').run()
  await db.prepare('DELETE FROM users').run()
  await db.prepare('DELETE FROM product_types').run()
  await db.prepare('DELETE FROM system_config').run()
  await db.prepare('DELETE FROM admin_users').run()
}

function getEnvBindings() {
  return {
    DB: env.DB,
    SEPAY_API_KEY,
    BOT_TOKEN: 'test-bot-token',
    TELEGRAM_SECRET_TOKEN: 'test-telegram-secret',
    ADMIN_IDS: '123456789',
    JWT_SECRET,
    BANK_NAME: 'Vietcombank',
    BANK_ACCOUNT: '1017588888',
    BANK_OWNER: 'NGUYEN VAN TEST',
  }
}

function getExecutionCtx() {
  return {
    waitUntil: (_promise: Promise<unknown>) => {},
    passThroughOnException: () => {},
  }
}

// ============================
// 1. Full Purchase Flow
// ============================

describe('Integration: Full Purchase Flow', () => {
  beforeEach(async () => {
    await applySchema(env.DB)
    await cleanTables(env.DB)
  })

  it('should complete purchase: deduct balance, mark products sold, create order & transaction', async () => {
    const db = env.DB

    // Setup: create user with sufficient balance
    const initialBalance = 500_000
    await db
      .prepare(
        "INSERT INTO users (telegram_id, username, first_name, balance, created_at, updated_at) VALUES (111222333, 'buyer1', 'Buyer', ?, datetime('now'), datetime('now'))"
      )
      .bind(initialBalance)
      .run()
    const user = await db.prepare("SELECT id FROM users WHERE telegram_id = 111222333").first<{ id: number }>()
    const userId = user!.id

    // Setup: create product_type
    await db
      .prepare(
        "INSERT INTO product_types (name, description, price, created_at, updated_at) VALUES ('Netflix Premium', 'Tài khoản Netflix 1 tháng', 50000, datetime('now'), datetime('now'))"
      )
      .run()
    const pt = await db.prepare("SELECT id FROM product_types WHERE name = 'Netflix Premium'").first<{ id: number }>()
    const categoryId = pt!.id

    // Setup: create 5 available products
    for (let i = 1; i <= 5; i++) {
      await db
        .prepare(
          "INSERT INTO products (type_id, content, status, created_at) VALUES (?, ?, 'available', datetime('now'))"
        )
        .bind(categoryId, `netflix_acc_${i}@mail.com:pass${i}`)
        .run()
    }

    // Execute: purchase 3 products
    const quantity = 3
    const unitPrice = 50000
    const result = await transactionService.executePurchase(db, userId, categoryId, quantity, unitPrice)

    // Verify: purchase succeeded
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.products).toHaveLength(3)

    // Verify: user balance decreased correctly
    const updatedUser = await db.prepare('SELECT balance FROM users WHERE id = ?').bind(userId).first<{ balance: number }>()
    expect(updatedUser!.balance).toBe(initialBalance - quantity * unitPrice) // 500000 - 150000 = 350000

    // Verify: products marked as sold
    const soldProducts = await db
      .prepare("SELECT * FROM products WHERE type_id = ? AND status = 'sold'")
      .bind(categoryId)
      .all<{ id: number; status: string; buyer_id: number; sold_at: string }>()
    expect(soldProducts.results).toHaveLength(3)
    for (const p of soldProducts.results) {
      expect(p.buyer_id).toBe(userId)
      expect(p.sold_at).not.toBeNull()
    }

    // Verify: remaining available products
    const availableProducts = await db
      .prepare("SELECT * FROM products WHERE type_id = ? AND status = 'available'")
      .bind(categoryId)
      .all()
    expect(availableProducts.results).toHaveLength(2)

    // Verify: order created
    const order = await db
      .prepare('SELECT * FROM orders WHERE user_id = ?')
      .bind(userId)
      .first<{ quantity: number; total_amount: number; status: string; product_type_id: number }>()
    expect(order).not.toBeNull()
    expect(order!.quantity).toBe(3)
    expect(order!.total_amount).toBe(150_000)
    expect(order!.status).toBe('completed')
    expect(order!.product_type_id).toBe(categoryId)

    // Verify: transaction record created
    const tx = await db
      .prepare("SELECT * FROM transactions WHERE user_id = ? AND type = 'purchase'")
      .bind(userId)
      .first<{ amount: number; balance_before: number; balance_after: number; status: string }>()
    expect(tx).not.toBeNull()
    expect(tx!.amount).toBe(-150_000)
    expect(tx!.balance_before).toBe(initialBalance)
    expect(tx!.balance_after).toBe(initialBalance - 150_000)
    expect(tx!.status).toBe('success')
  })

  it('should reject purchase when balance is insufficient', async () => {
    const db = env.DB

    // Setup: user with low balance
    await db
      .prepare(
        "INSERT INTO users (telegram_id, username, first_name, balance, created_at, updated_at) VALUES (222333444, 'pooruser', 'Poor', 10000, datetime('now'), datetime('now'))"
      )
      .run()
    const user = await db.prepare("SELECT id FROM users WHERE telegram_id = 222333444").first<{ id: number }>()

    // Setup: product type with price higher than balance
    await db
      .prepare(
        "INSERT INTO product_types (name, price, created_at, updated_at) VALUES ('Expensive', 100000, datetime('now'), datetime('now'))"
      )
      .run()
    const pt = await db.prepare("SELECT id FROM product_types WHERE name = 'Expensive'").first<{ id: number }>()

    // Setup: products
    await db
      .prepare(
        "INSERT INTO products (type_id, content, status, created_at) VALUES (?, 'content1', 'available', datetime('now'))"
      )
      .bind(pt!.id)
      .run()

    // Execute
    const result = await transactionService.executePurchase(db, user!.id, pt!.id, 1, 100000)

    // Verify: rejected
    expect(result.success).toBe(false)
    expect(result.error).toBe('insufficient_balance')

    // Verify: balance unchanged
    const updatedUser = await db.prepare('SELECT balance FROM users WHERE id = ?').bind(user!.id).first<{ balance: number }>()
    expect(updatedUser!.balance).toBe(10000)
  })

  it('should reject purchase when stock is insufficient', async () => {
    const db = env.DB

    // Setup: user with plenty of balance
    await db
      .prepare(
        "INSERT INTO users (telegram_id, username, first_name, balance, created_at, updated_at) VALUES (333444555, 'richuser', 'Rich', 1000000, datetime('now'), datetime('now'))"
      )
      .run()
    const user = await db.prepare("SELECT id FROM users WHERE telegram_id = 333444555").first<{ id: number }>()

    // Setup: product type with only 1 product
    await db
      .prepare(
        "INSERT INTO product_types (name, price, created_at, updated_at) VALUES ('Limited', 20000, datetime('now'), datetime('now'))"
      )
      .run()
    const pt = await db.prepare("SELECT id FROM product_types WHERE name = 'Limited'").first<{ id: number }>()

    await db
      .prepare(
        "INSERT INTO products (type_id, content, status, created_at) VALUES (?, 'only_one', 'available', datetime('now'))"
      )
      .bind(pt!.id)
      .run()

    // Execute: try to buy 3 but only 1 available
    const result = await transactionService.executePurchase(db, user!.id, pt!.id, 3, 20000)

    // Verify: rejected
    expect(result.success).toBe(false)
    expect(result.error).toBe('insufficient_stock')

    // Verify: balance unchanged
    const updatedUser = await db.prepare('SELECT balance FROM users WHERE id = ?').bind(user!.id).first<{ balance: number }>()
    expect(updatedUser!.balance).toBe(1_000_000)
  })
})

// ============================
// 2. Full Deposit Flow (SePay webhook → balance update)
// ============================

describe('Integration: Full Deposit Flow (SePay webhook → balance update)', () => {
  let mockFetch: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    await applySchema(env.DB)
    await cleanTables(env.DB)
    mockFetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should process SePay webhook: complete deposit, increase balance, create transaction', async () => {
    const db = env.DB
    const transferCode = 'NAP0042A3B7CF'
    const depositAmount = 100_000
    const initialBalance = 50_000

    // Setup: create user
    await db
      .prepare(
        "INSERT INTO users (telegram_id, username, first_name, balance, last_interaction_at, created_at, updated_at) VALUES (555666777, 'depositor', 'Depo', ?, datetime('now'), datetime('now'), datetime('now'))"
      )
      .bind(initialBalance)
      .run()
    const user = await db.prepare("SELECT id FROM users WHERE telegram_id = 555666777").first<{ id: number }>()

    // Setup: create pending deposit
    await db
      .prepare(
        "INSERT INTO deposits (user_id, transfer_code, amount, status, created_at) VALUES (?, ?, ?, 'pending', datetime('now'))"
      )
      .bind(user!.id, transferCode, depositAmount)
      .run()

    // Execute: POST webhook/sepay with valid payload containing the transfer_code
    const payload = {
      id: 9876543,
      gateway: 'Vietcombank',
      transactionDate: '2024-07-02 11:08:33',
      accountNumber: '1017588888',
      subAccount: null,
      code: 'SEVN63DC8E5C',
      content: `${transferCode} chuyen tien nap`,
      transferType: 'in',
      description: 'Transfer',
      transferAmount: depositAmount,
      accumulated: 10_000_000,
      referenceCode: 'FT24012345678',
    }

    const res = await app.request('/webhook/sepay', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Apikey ${SEPAY_API_KEY}`,
      },
      body: JSON.stringify(payload),
    }, getEnvBindings() as any, getExecutionCtx() as any)

    // Verify: HTTP 200 with { success: true }
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ success: true })

    // Verify: deposit status = 'completed'
    const deposit = await db
      .prepare('SELECT * FROM deposits WHERE transfer_code = ?')
      .bind(transferCode)
      .first<{ status: string; sepay_transaction_id: string; completed_at: string }>()
    expect(deposit!.status).toBe('completed')
    expect(deposit!.sepay_transaction_id).toBe('9876543')
    expect(deposit!.completed_at).not.toBeNull()

    // Verify: user balance increased
    const updatedUser = await db.prepare("SELECT balance FROM users WHERE telegram_id = 555666777").first<{ balance: number }>()
    expect(updatedUser!.balance).toBe(initialBalance + depositAmount) // 50000 + 100000 = 150000

    // Verify: transaction record created
    const tx = await db
      .prepare("SELECT * FROM transactions WHERE user_id = ? AND type = 'deposit'")
      .bind(user!.id)
      .first<{ amount: number; balance_before: number; balance_after: number; status: string }>()
    expect(tx).not.toBeNull()
    expect(tx!.amount).toBe(depositAmount)
    expect(tx!.balance_before).toBe(initialBalance)
    expect(tx!.balance_after).toBe(initialBalance + depositAmount)
    expect(tx!.status).toBe('success')

    // Verify: Telegram notification was sent
    expect(mockFetch).toHaveBeenCalled()
    const fetchCall = mockFetch.mock.calls.find(
      (call: any[]) => typeof call[0] === 'string' && call[0].includes('sendMessage')
    )
    expect(fetchCall).toBeDefined()
  })

  it('should return 401 for invalid API key', async () => {
    const res = await app.request('/webhook/sepay', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Apikey wrong-key',
      },
      body: JSON.stringify({ id: 1, transferType: 'in', content: 'NAP1234XY', transferAmount: 50000 }),
    }, getEnvBindings() as any, getExecutionCtx() as any)

    expect(res.status).toBe(401)
  })

  it('should ignore webhook with no matching transfer code', async () => {
    const db = env.DB

    // Setup: user (no pending deposit)
    await db
      .prepare(
        "INSERT INTO users (telegram_id, username, first_name, balance, created_at, updated_at) VALUES (888999000, 'nouser', 'No', 0, datetime('now'), datetime('now'))"
      )
      .run()

    const payload = {
      id: 111222,
      gateway: 'Vietcombank',
      transactionDate: '2024-07-02 11:08:33',
      accountNumber: '1017588888',
      subAccount: null,
      code: 'SEVNTEST',
      content: 'NAPUNKNOWN123 chuyen tien',
      transferType: 'in',
      description: 'Transfer',
      transferAmount: 50000,
      accumulated: 5_000_000,
      referenceCode: 'FT24099999999',
    }

    const res = await app.request('/webhook/sepay', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Apikey ${SEPAY_API_KEY}`,
      },
      body: JSON.stringify(payload),
    }, getEnvBindings() as any, getExecutionCtx() as any)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true })
  })
})

// ============================
// 3. JWT Auth Flow (login → protected route → expired token)
// ============================

describe('Integration: JWT Auth Flow', () => {
  const ADMIN_PASSWORD = 'SecurePass123!'

  beforeEach(async () => {
    await applySchema(env.DB)
    await cleanTables(env.DB)
  })

  it('should login with correct credentials, access protected route, and reject invalid token', async () => {
    const db = env.DB

    // Setup: create admin_user with hashed password
    const passwordHash = await hashPassword(ADMIN_PASSWORD)
    await db
      .prepare(
        "INSERT INTO admin_users (username, password_hash, display_name, created_at) VALUES ('admin_test', ?, 'Admin Test', datetime('now'))"
      )
      .bind(passwordHash)
      .run()

    // Step 1: Login with correct credentials → get token
    const loginRes = await app.request('/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin_test', password: ADMIN_PASSWORD }),
    }, getEnvBindings() as any)

    expect(loginRes.status).toBe(200)
    const loginBody = await loginRes.json() as { success: boolean; data: { token: string; admin: { username: string } }; error: null }
    expect(loginBody.success).toBe(true)
    expect(loginBody.data.token).toBeDefined()
    expect(loginBody.data.admin.username).toBe('admin_test')
    expect(loginBody.error).toBeNull()

    const token = loginBody.data.token

    // Step 2: Use token on protected route (GET /api/admin/users)
    const usersRes = await app.request('/api/admin/users', {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, getEnvBindings() as any)

    expect(usersRes.status).toBe(200)
    const usersBody = await usersRes.json() as { success: boolean; data: unknown; error: null }
    expect(usersBody.success).toBe(true)
    expect(usersBody.error).toBeNull()

    // Step 3: Invalid token returns 401
    const invalidRes = await app.request('/api/admin/users', {
      method: 'GET',
      headers: { Authorization: 'Bearer totally-invalid-jwt-token' },
    }, getEnvBindings() as any)

    expect(invalidRes.status).toBe(401)
    const invalidBody = await invalidRes.json() as { success: boolean; data: null; error: string }
    expect(invalidBody.success).toBe(false)
    expect(invalidBody.data).toBeNull()
    expect(invalidBody.error).toBeDefined()
  })

  it('should reject expired JWT token', async () => {
    const db = env.DB

    // Setup: create admin
    const passwordHash = await hashPassword(ADMIN_PASSWORD)
    await db
      .prepare(
        "INSERT INTO admin_users (username, password_hash, display_name, created_at) VALUES ('admin_exp', ?, 'Admin Exp', datetime('now'))"
      )
      .bind(passwordHash)
      .run()
    const admin = await db.prepare("SELECT id FROM admin_users WHERE username = 'admin_exp'").first<{ id: number }>()

    // Create an already-expired JWT token
    const secret = new TextEncoder().encode(JWT_SECRET)
    const expiredToken = await new SignJWT({ sub: String(admin!.id), username: 'admin_exp' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 86400 * 2) // issued 2 days ago
      .setExpirationTime(Math.floor(Date.now() / 1000) - 86400) // expired 1 day ago
      .sign(secret)

    // Attempt to access protected route with expired token
    const res = await app.request('/api/admin/users', {
      method: 'GET',
      headers: { Authorization: `Bearer ${expiredToken}` },
    }, getEnvBindings() as any)

    expect(res.status).toBe(401)
    const body = await res.json() as { success: boolean; data: null; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toContain('expired')
  })

  it('should reject login with wrong password', async () => {
    const db = env.DB

    const passwordHash = await hashPassword(ADMIN_PASSWORD)
    await db
      .prepare(
        "INSERT INTO admin_users (username, password_hash, display_name, created_at) VALUES ('admin_wrong', ?, 'Admin Wrong', datetime('now'))"
      )
      .bind(passwordHash)
      .run()

    // Attempt login with wrong password
    const res = await app.request('/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin_wrong', password: 'WrongPassword!' }),
    }, getEnvBindings() as any)

    expect(res.status).toBe(401)
    const body = await res.json() as { success: boolean; error: string }
    expect(body.success).toBe(false)
    // Backend trả error CODE ổn định (CMS dịch sang chuỗi bản địa hoá qua i18n) — R18.
    expect(body.error).toBe('invalid_credentials')
  })

  it('should lock account after 5 failed login attempts', async () => {
    const db = env.DB

    const passwordHash = await hashPassword(ADMIN_PASSWORD)
    await db
      .prepare(
        "INSERT INTO admin_users (username, password_hash, display_name, created_at) VALUES ('admin_lock', ?, 'Admin Lock', datetime('now'))"
      )
      .bind(passwordHash)
      .run()

    // 5 failed login attempts
    for (let i = 0; i < 5; i++) {
      await app.request('/api/admin/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin_lock', password: 'wrong' }),
      }, getEnvBindings() as any)
    }

    // 6th attempt should be locked (403)
    const res = await app.request('/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin_lock', password: ADMIN_PASSWORD }),
    }, getEnvBindings() as any)

    expect(res.status).toBe(403)
    const body = await res.json() as { success: boolean; error: string }
    expect(body.success).toBe(false)
    expect(body.error).toContain('locked')
  })
})

