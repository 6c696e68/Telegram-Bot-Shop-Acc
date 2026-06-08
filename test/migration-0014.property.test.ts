import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import fc from 'fast-check'

/**
 * Migration smoke + property tests cho `migrations/0014_payments_provider_agnostic.sql`.
 *
 * Target: migration 0014 rebuild bảng `deposits` sang mô hình provider-agnostic
 * (3 cột chung `correlation_ref`/`provider_txn_id`/`metadata`, bỏ cột riêng, provider
 * TEXT không CHECK). Dùng D1 thật qua @cloudflare/vitest-pool-workers (miniflare) —
 * khớp convention setup schema + env.DB như các property test khác.
 *
 * Cách test:
 *  1. Dựng bảng `deposits` THEO SCHEMA CŨ (đúng trạng thái sau migration 0008:
 *     transfer_code/sepay_transaction_id/bank_ref + crypto_invoice_id/asset/usdt_amount/exchange_rate).
 *  2. Seed dữ liệu sepay (có/không bank_ref, gồm sepay_transaction_id = 'manual-approve')
 *     và cryptobot (có/không invoice id).
 *  3. Áp đúng các câu lệnh của migration 0014 (inline, sao chép nguyên văn từ file SQL).
 *  4. Assert cấu trúc bảng + index + dữ liệu migrate.
 *
 *  - Property 1: Migration preserves common columns — **Validates: Requirements 2.1**
 *  - Property 2: SePay column mapping is faithful — **Validates: Requirements 2.2, 2.6**
 *  - Property 3: SePay bank_ref preserved in metadata — **Validates: Requirements 2.3**
 *  - Property 4: CryptoBot column mapping is faithful — **Validates: Requirements 2.4, 2.5, 2.6**
 */

// --- Schema CŨ của deposits (đúng như sau migration 0008) -------------------

const OLD_DEPOSITS_DDL = `CREATE TABLE deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL DEFAULT 'sepay' CHECK(provider IN ('sepay','cryptobot')),
  amount INTEGER NOT NULL CHECK(amount > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','completed','expired','cancelled','awaiting_credit')),
  transfer_code TEXT,
  sepay_transaction_id TEXT,
  bank_ref TEXT,
  crypto_invoice_id TEXT,
  asset TEXT,
  usdt_amount TEXT,
  exchange_rate INTEGER,
  completed_at TEXT,
  expired_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`

const USERS_DDL = `CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id INTEGER UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance >= 0),
  is_active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`

// --- Migration 0014: sao chép NGUYÊN VĂN các câu lệnh từ file SQL -----------
// (PRAGMA foreign_keys là no-op trong D1/miniflare nhưng vẫn chạy được; giữ để bám sát file.)
const MIGRATION_0014_STATEMENTS: readonly string[] = [
  `PRAGMA foreign_keys=OFF`,
  `CREATE TABLE deposits_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    provider TEXT NOT NULL DEFAULT 'sepay',
    amount INTEGER NOT NULL CHECK(amount > 0),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','completed','expired','cancelled','awaiting_credit')),
    correlation_ref TEXT,
    provider_txn_id TEXT,
    metadata TEXT,
    completed_at TEXT,
    expired_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `INSERT INTO deposits_new
    (id, user_id, provider, amount, status, correlation_ref, provider_txn_id, metadata, completed_at, expired_at, created_at)
  SELECT
    id, user_id, 'sepay', amount, status,
    transfer_code,
    CASE WHEN sepay_transaction_id = 'manual-approve' THEN 'manual-' || id ELSE sepay_transaction_id END,
    CASE WHEN bank_ref IS NOT NULL THEN json_object('bank_ref', bank_ref) ELSE NULL END,
    completed_at, expired_at, created_at
  FROM deposits WHERE provider = 'sepay'`,
  `INSERT INTO deposits_new
    (id, user_id, provider, amount, status, correlation_ref, provider_txn_id, metadata, completed_at, expired_at, created_at)
  SELECT
    id, user_id, 'cryptobot', amount, status,
    crypto_invoice_id,
    crypto_invoice_id,
    json_object('asset', asset, 'usdt_amount', usdt_amount, 'exchange_rate', exchange_rate),
    completed_at, expired_at, created_at
  FROM deposits WHERE provider = 'cryptobot'`,
  `DROP TABLE deposits`,
  `ALTER TABLE deposits_new RENAME TO deposits`,
  `CREATE UNIQUE INDEX idx_deposits_provider_correlation
    ON deposits(provider, correlation_ref) WHERE correlation_ref IS NOT NULL`,
  `CREATE UNIQUE INDEX idx_deposits_provider_txn
    ON deposits(provider, provider_txn_id) WHERE provider_txn_id IS NOT NULL`,
  `CREATE INDEX idx_deposits_user_status ON deposits(user_id, status)`,
  `CREATE INDEX idx_deposits_status_created ON deposits(status, created_at)`,
  `PRAGMA foreign_keys=ON`,
]

async function applyMigration0014(): Promise<void> {
  for (const stmt of MIGRATION_0014_STATEMENTS) {
    await env.DB.prepare(stmt).run()
  }
}

/** Dựng lại bảng deposits theo schema CŨ (drop bảng đã migrate của lần chạy trước nếu có). */
async function resetToOldDeposits(): Promise<void> {
  await env.DB.prepare('DROP TABLE IF EXISTS deposits_new').run()
  await env.DB.prepare('DROP TABLE IF EXISTS deposits').run()
  await env.DB.prepare(OLD_DEPOSITS_DDL).run()
}

async function ensureUser(): Promise<number> {
  await env.DB.prepare('DELETE FROM users').run()
  const telegramId = Math.floor(Math.random() * 2_000_000_000)
  const row = await env.DB
    .prepare(
      "INSERT INTO users (telegram_id, username, first_name, balance) VALUES (?, 'tester', 'Test', 0) RETURNING id"
    )
    .bind(telegramId)
    .first<{ id: number }>()
  return row!.id
}

// --- Generators -------------------------------------------------------------

const arbStatus = fc.constantFrom(
  'pending',
  'completed',
  'expired',
  'cancelled',
  'awaiting_credit'
)
const arbTimestamp = fc.option(fc.constantFrom('2024-01-01 00:00:00', '2024-06-15 12:30:00'), {
  nil: null,
})

interface SepaySpec {
  amount: number
  status: string
  hasTransferCode: boolean
  txnKind: 'none' | 'manual' | 'normal'
  bankRef: string | null
  completedAt: string | null
  expiredAt: string | null
}

interface CryptoSpec {
  amount: number
  status: string
  hasInvoice: boolean
  asset: string
  usdtAmount: string
  exchangeRate: number
  completedAt: string | null
  expiredAt: string | null
}

const arbSepaySpec: fc.Arbitrary<SepaySpec> = fc.record({
  amount: fc.integer({ min: 1, max: 100_000_000 }),
  status: arbStatus,
  hasTransferCode: fc.boolean(),
  txnKind: fc.constantFrom('none', 'manual', 'normal'),
  // bank_ref bất kỳ (gồm ký tự đặc biệt/unicode/empty) để kiểm độ trung thực JSON round-trip;
  // null để kiểm nhánh metadata = NULL.
  bankRef: fc.option(fc.string({ minLength: 0, maxLength: 16 }), { nil: null }),
  completedAt: arbTimestamp,
  expiredAt: arbTimestamp,
})

const arbUsdtAmount = fc
  .tuple(fc.integer({ min: 0, max: 99_999 }), fc.integer({ min: 0, max: 99 }))
  .map(([w, f]) => `${w}.${f.toString().padStart(2, '0')}`)

const arbCryptoSpec: fc.Arbitrary<CryptoSpec> = fc.record({
  amount: fc.integer({ min: 1, max: 100_000_000 }),
  status: arbStatus,
  hasInvoice: fc.boolean(),
  asset: fc.constantFrom('USDT', 'TON', 'BTC'),
  usdtAmount: arbUsdtAmount,
  exchangeRate: fc.integer({ min: 1, max: 50_000 }),
  completedAt: arbTimestamp,
  expiredAt: arbTimestamp,
})

// --- Seed helpers (gán mã duy nhất theo index để không vỡ unique index mới) --

interface SeededSepay extends SepaySpec {
  id: number
  transferCode: string | null
  sepayTxnId: string | null
  expectedCorrelation: string | null
  expectedProviderTxn: string | null
}

interface SeededCrypto extends CryptoSpec {
  id: number
  invoiceId: string | null
}

async function seedSepayRows(userId: number, specs: SepaySpec[]): Promise<SeededSepay[]> {
  const out: SeededSepay[] = []
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]
    const transferCode = s.hasTransferCode ? `NAP${i}` : null
    const sepayTxnId =
      s.txnKind === 'none' ? null : s.txnKind === 'manual' ? 'manual-approve' : `SEP${i}`
    const row = await env.DB.prepare(
      `INSERT INTO deposits
        (user_id, provider, amount, status, transfer_code, sepay_transaction_id, bank_ref, completed_at, expired_at, created_at)
       VALUES (?, 'sepay', ?, ?, ?, ?, ?, ?, ?, datetime('now')) RETURNING id`
    )
      .bind(
        userId,
        s.amount,
        s.status,
        transferCode,
        sepayTxnId,
        s.bankRef,
        s.completedAt,
        s.expiredAt
      )
      .first<{ id: number }>()
    const id = row!.id
    out.push({
      ...s,
      id,
      transferCode,
      sepayTxnId,
      expectedCorrelation: transferCode,
      expectedProviderTxn:
        s.txnKind === 'none' ? null : s.txnKind === 'manual' ? `manual-${id}` : `SEP${i}`,
    })
  }
  return out
}

async function seedCryptoRows(userId: number, specs: CryptoSpec[]): Promise<SeededCrypto[]> {
  const out: SeededCrypto[] = []
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i]
    const invoiceId = s.hasInvoice ? `INV${i}` : null
    const row = await env.DB.prepare(
      `INSERT INTO deposits
        (user_id, provider, amount, status, crypto_invoice_id, asset, usdt_amount, exchange_rate, completed_at, expired_at, created_at)
       VALUES (?, 'cryptobot', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')) RETURNING id`
    )
      .bind(
        userId,
        s.amount,
        s.status,
        invoiceId,
        s.asset,
        s.usdtAmount,
        s.exchangeRate,
        s.completedAt,
        s.expiredAt
      )
      .first<{ id: number }>()
    out.push({ ...s, id: row!.id, invoiceId })
  }
  return out
}

interface OldSnapshotRow {
  id: number
  user_id: number
  provider: string
  amount: number
  status: string
  completed_at: string | null
  expired_at: string | null
  created_at: string
}

async function snapshotCommonColumns(): Promise<Map<number, OldSnapshotRow>> {
  const res = await env.DB.prepare(
    'SELECT id, user_id, provider, amount, status, completed_at, expired_at, created_at FROM deposits'
  ).all<OldSnapshotRow>()
  const map = new Map<number, OldSnapshotRow>()
  for (const r of res.results) map.set(r.id, r)
  return map
}

interface NewRow {
  id: number
  user_id: number
  provider: string
  amount: number
  status: string
  correlation_ref: string | null
  provider_txn_id: string | null
  metadata: string | null
  md_bank_ref: string | null
  md_asset: string | null
  md_usdt: string | null
  md_rate: number | null
  completed_at: string | null
  expired_at: string | null
  created_at: string
}

async function readMigratedRows(): Promise<Map<number, NewRow>> {
  const res = await env.DB.prepare(
    `SELECT id, user_id, provider, amount, status, correlation_ref, provider_txn_id, metadata,
            json_extract(metadata,'$.bank_ref')    AS md_bank_ref,
            json_extract(metadata,'$.asset')       AS md_asset,
            json_extract(metadata,'$.usdt_amount') AS md_usdt,
            json_extract(metadata,'$.exchange_rate') AS md_rate,
            completed_at, expired_at, created_at
     FROM deposits`
  ).all<NewRow>()
  const map = new Map<number, NewRow>()
  for (const r of res.results) map.set(r.id, r)
  return map
}

beforeEach(async () => {
  await env.DB.prepare(USERS_DDL).run()
})

// --- Smoke test cấu trúc -----------------------------------------------------

describe('Migration 0014 smoke: cấu trúc bảng + index', () => {
  it('rebuilds deposits with common columns, drops provider-specific columns, creates indexes', async () => {
    await resetToOldDeposits()
    const userId = await ensureUser()

    // Seed vài hàng đại diện (sepay có/không bank_ref + manual-approve, cryptobot có/không invoice).
    await seedSepayRows(userId, [
      {
        amount: 50_000,
        status: 'completed',
        hasTransferCode: true,
        txnKind: 'normal',
        bankRef: 'FT123',
        completedAt: '2024-01-01 00:00:00',
        expiredAt: null,
      },
      {
        amount: 30_000,
        status: 'completed',
        hasTransferCode: true,
        txnKind: 'manual',
        bankRef: null,
        completedAt: '2024-01-02 00:00:00',
        expiredAt: null,
      },
      {
        amount: 20_000,
        status: 'pending',
        hasTransferCode: false,
        txnKind: 'none',
        bankRef: null,
        completedAt: null,
        expiredAt: null,
      },
    ])
    await seedCryptoRows(userId, [
      {
        amount: 100_000,
        status: 'completed',
        hasInvoice: true,
        asset: 'USDT',
        usdtAmount: '10.50',
        exchangeRate: 26000,
        completedAt: '2024-01-03 00:00:00',
        expiredAt: null,
      },
    ])

    await applyMigration0014()

    // Cột bảng sau migration
    const info = await env.DB.prepare('PRAGMA table_info(deposits)').all<{ name: string }>()
    const cols = info.results.map((r) => r.name).sort()
    expect(cols).toEqual(
      [
        'amount',
        'completed_at',
        'correlation_ref',
        'created_at',
        'expired_at',
        'id',
        'metadata',
        'provider',
        'provider_txn_id',
        'status',
        'user_id',
      ].sort()
    )
    // Cột riêng theo provider phải biến mất (R1.6)
    for (const dropped of [
      'transfer_code',
      'sepay_transaction_id',
      'bank_ref',
      'crypto_invoice_id',
      'asset',
      'usdt_amount',
      'exchange_rate',
    ]) {
      expect(cols).not.toContain(dropped)
    }

    // provider TEXT không CHECK: chèn provider tuỳ ý phải được chấp nhận (R1.5)
    await env.DB.prepare(
      "INSERT INTO deposits (user_id, provider, amount, status, created_at) VALUES (?, 'payos', 1000, 'pending', datetime('now'))"
    )
      .bind(userId)
      .run()

    // Index tồn tại (R1.8, R1.9 + giữ index truy vấn)
    const idx = await env.DB
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='deposits'")
      .all<{ name: string }>()
    const idxNames = idx.results.map((r) => r.name)
    expect(idxNames).toContain('idx_deposits_provider_correlation')
    expect(idxNames).toContain('idx_deposits_provider_txn')
    expect(idxNames).toContain('idx_deposits_user_status')
    expect(idxNames).toContain('idx_deposits_status_created')

    // Index (provider, correlation_ref) phải UNIQUE từng phần (cho phép nhiều NULL).
    await env.DB.prepare(
      "INSERT INTO deposits (user_id, provider, amount, status, created_at) VALUES (?, 'sepay', 1, 'pending', datetime('now'))"
    )
      .bind(userId)
      .run()
    await env.DB.prepare(
      "INSERT INTO deposits (user_id, provider, amount, status, correlation_ref, created_at) VALUES (?, 'sepay', 1, 'pending', 'DUP', datetime('now'))"
    )
      .bind(userId)
      .run()
    await expect(
      env.DB.prepare(
        "INSERT INTO deposits (user_id, provider, amount, status, correlation_ref, created_at) VALUES (?, 'sepay', 1, 'pending', 'DUP', datetime('now'))"
      )
        .bind(userId)
        .run()
    ).rejects.toThrow()
  })
})

// --- Property 1 --------------------------------------------------------------

describe('Property 1: Migration preserves common columns', () => {
  /**
   * **Validates: Requirements 2.1**
   * Với mọi tập hàng Deposit, sau migration mỗi hàng giữ nguyên
   * id, user_id, provider, amount, status, completed_at, expired_at, created_at.
   */
  it('keeps id/user_id/provider/amount/status/timestamps unchanged for every row', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbSepaySpec, { minLength: 0, maxLength: 6 }),
        fc.array(arbCryptoSpec, { minLength: 0, maxLength: 6 }),
        async (sepaySpecs, cryptoSpecs) => {
          fc.pre(sepaySpecs.length + cryptoSpecs.length > 0)
          await resetToOldDeposits()
          const userId = await ensureUser()
          await seedSepayRows(userId, sepaySpecs)
          await seedCryptoRows(userId, cryptoSpecs)

          const before = await snapshotCommonColumns()
          await applyMigration0014()
          const after = await readMigratedRows()

          expect(after.size).toBe(before.size)
          for (const [id, b] of before) {
            const a = after.get(id)
            expect(a).toBeDefined()
            expect(a!.user_id).toBe(b.user_id)
            expect(a!.provider).toBe(b.provider)
            expect(a!.amount).toBe(b.amount)
            expect(a!.status).toBe(b.status)
            expect(a!.completed_at).toBe(b.completed_at)
            expect(a!.expired_at).toBe(b.expired_at)
            expect(a!.created_at).toBe(b.created_at)
          }
        }
      ),
      { numRuns: 30 }
    )
  })
})

// --- Property 2 --------------------------------------------------------------

describe('Property 2: SePay column mapping is faithful', () => {
  /**
   * **Validates: Requirements 2.2, 2.6**
   * sepay: correlation_ref = transfer_code cũ; provider_txn_id = sepay_transaction_id cũ,
   * NGOẠI TRỪ 'manual-approve' -> 'manual-' || id. Nguồn NULL -> đích NULL.
   */
  it('maps transfer_code/sepay_transaction_id into common columns (manual-approve becomes manual-<id>)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbSepaySpec, { minLength: 1, maxLength: 8 }),
        async (sepaySpecs) => {
          await resetToOldDeposits()
          const userId = await ensureUser()
          const seeded = await seedSepayRows(userId, sepaySpecs)

          await applyMigration0014()
          const after = await readMigratedRows()

          for (const s of seeded) {
            const a = after.get(s.id)
            expect(a).toBeDefined()
            expect(a!.provider).toBe('sepay')
            // correlation_ref = transfer_code cũ (NULL -> NULL) (R2.2, R2.6)
            expect(a!.correlation_ref).toBe(s.expectedCorrelation)
            // provider_txn_id mapping với ngoại lệ manual-approve (R2.2)
            expect(a!.provider_txn_id).toBe(s.expectedProviderTxn)
          }
        }
      ),
      { numRuns: 40 }
    )
  })
})

// --- Property 3 --------------------------------------------------------------

describe('Property 3: SePay bank_ref preserved in metadata', () => {
  /**
   * **Validates: Requirements 2.3**
   * sepay có bank_ref != NULL -> metadata JSON khoá 'bank_ref' = giá trị cũ;
   * bank_ref NULL -> metadata NULL.
   */
  it('writes bank_ref into metadata json when present, leaves metadata null otherwise', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbSepaySpec, { minLength: 1, maxLength: 8 }),
        async (sepaySpecs) => {
          await resetToOldDeposits()
          const userId = await ensureUser()
          const seeded = await seedSepayRows(userId, sepaySpecs)

          await applyMigration0014()
          const after = await readMigratedRows()

          for (const s of seeded) {
            const a = after.get(s.id)
            expect(a).toBeDefined()
            if (s.bankRef === null) {
              expect(a!.metadata).toBeNull()
            } else {
              expect(a!.metadata).not.toBeNull()
              expect(a!.md_bank_ref).toBe(s.bankRef)
            }
          }
        }
      ),
      { numRuns: 40 }
    )
  })
})

// --- Property 4 --------------------------------------------------------------

describe('Property 4: CryptoBot column mapping is faithful', () => {
  /**
   * **Validates: Requirements 2.4, 2.5, 2.6**
   * cryptobot: correlation_ref = provider_txn_id = crypto_invoice_id cũ (NULL -> NULL);
   * metadata chứa asset/usdt_amount/exchange_rate từ cột cũ.
   */
  it('maps crypto_invoice_id to both correlation+txn and stores asset/usdt/rate in metadata', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbCryptoSpec, { minLength: 1, maxLength: 8 }),
        async (cryptoSpecs) => {
          await resetToOldDeposits()
          const userId = await ensureUser()
          const seeded = await seedCryptoRows(userId, cryptoSpecs)

          await applyMigration0014()
          const after = await readMigratedRows()

          for (const s of seeded) {
            const a = after.get(s.id)
            expect(a).toBeDefined()
            expect(a!.provider).toBe('cryptobot')
            // correlation_ref = provider_txn_id = crypto_invoice_id cũ (NULL -> NULL) (R2.4, R2.6)
            expect(a!.correlation_ref).toBe(s.invoiceId)
            expect(a!.provider_txn_id).toBe(s.invoiceId)
            // metadata asset/usdt_amount/exchange_rate (R2.5)
            expect(a!.md_asset).toBe(s.asset)
            expect(a!.md_usdt).toBe(s.usdtAmount)
            expect(a!.md_rate).toBe(s.exchangeRate)
          }
        }
      ),
      { numRuns: 40 }
    )
  })
})
