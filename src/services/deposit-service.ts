/**
 * DepositService — cộng tiền nạp atomic dùng chung cho mọi Payment_Provider.
 *
 * Thay cho `TransactionService.executeDeposit` (gắn cứng SePay). Logic cộng tiền
 * (balance + deposit status + transaction) dùng chung; phần đặc thù provider
 * (mã giao dịch SePay, hoặc invoice/USDT/rate của CryptoBot) truyền qua tham số.
 *
 * Giữ nguyên pattern D1 `batch()` + concurrency guard như executeDeposit cũ.
 * Requirements: 7.3, 11.1, 11.4, 12.4, 12.5, 14.1, 14.2, 14.4, 14.5, 15.4
 */
import type { DbUser } from '../types/db'
import type { ProviderId } from './payments/types'
import { formatMoney } from '../utils/format'

export interface CompleteDepositInput {
  db: D1Database
  depositId: number
  userId: number
  creditVnd: number // số VND thực cộng
  provider: ProviderId
  sepayTransactionId?: string // chỉ sepay
  cryptoInvoiceId?: string // chỉ cryptobot
  usdtAmount?: string // chỉ cryptobot (R12.5)
  exchangeRate?: number // chỉ cryptobot (R12.5)
}

export type CompleteDepositResult =
  | { success: true; newBalance: number }
  | { success: false; error: 'already_processed' | 'not_found' | 'db_error' }

/**
 * Hoàn tất một yêu cầu nạp: cộng `users.balance`, cập nhật `deposits` (status +
 * provider fields + set `amount = creditVnd`), insert `transactions`. Tất cả trong
 * một D1 `batch()` nguyên tử (R14.1).
 *
 * Guard hoàn tất: `WHERE id=? AND status IN ('pending','expired','awaiting_credit')`.
 * Cho phép hoàn tất từ `expired` để phục vụ CryptoBot trả trễ (R11.4, R15.4);
 * SePay tự bỏ qua khi `expired` ở tầng route (R15.3).
 *
 * - `changes === 0` (sau khi batch chạy xong) → deposit đã `completed`/`cancelled`
 *   hoặc không tồn tại → `already_processed` (chống cộng trùng — R14.2, R14.4).
 * - Batch ném lỗi → `db_error` RIÊNG BIỆT để caller retry (R14.5), KHÔNG coi là
 *   đã xử lý (không đánh dấu hoàn tất → lần retry còn cộng được).
 */
export async function completeDeposit(
  input: CompleteDepositInput
): Promise<CompleteDepositResult> {
  const {
    db,
    depositId,
    userId,
    creditVnd,
    provider,
    sepayTransactionId,
    cryptoInvoiceId,
    usdtAmount,
    exchangeRate,
  } = input
  const now = new Date().toISOString()

  const user = await db
    .prepare('SELECT * FROM users WHERE id = ?')
    .bind(userId)
    .first<DbUser>()

  if (!user) {
    return { success: false, error: 'not_found' }
  }

  const balanceBefore = user.balance
  const balanceAfter = balanceBefore + creditVnd

  // UPDATE deposits: cột chung + cột đặc thù provider. Guard status IN (...) chống
  // cộng trùng (chỉ hoàn tất từ pending/expired/awaiting_credit).
  let depositUpdate: D1PreparedStatement
  if (provider === 'sepay') {
    depositUpdate = db
      .prepare(
        `UPDATE deposits
         SET status = 'completed', completed_at = ?, amount = ?, sepay_transaction_id = ?
         WHERE id = ? AND status IN ('pending','expired','awaiting_credit')`
      )
      .bind(now, creditVnd, sepayTransactionId ?? null, depositId)
  } else {
    depositUpdate = db
      .prepare(
        `UPDATE deposits
         SET status = 'completed', completed_at = ?, amount = ?,
             crypto_invoice_id = ?, asset = 'USDT', usdt_amount = ?, exchange_rate = ?
         WHERE id = ? AND status IN ('pending','expired','awaiting_credit')`
      )
      .bind(
        now,
        creditVnd,
        cryptoInvoiceId ?? null,
        usdtAmount ?? null,
        exchangeRate ?? null,
        depositId
      )
  }

  // Guard "deposit còn cộng được": cộng balance + ghi transaction CHỈ khi deposit vẫn
  // ở trạng thái cho phép hoàn tất. Tránh cộng trùng khi gọi lặp/đồng thời (R14.2, R14.4):
  // KHÔNG đặt absolute `balance = ?` từ giá trị đọc trước (lần gọi sau sẽ đọc số dư đã cộng
  // và cộng thêm lần nữa) — dùng increment `balance = balance + ?` có điều kiện EXISTS.
  const creditableGuard =
    "EXISTS (SELECT 1 FROM deposits WHERE id = ? AND status IN ('pending','expired','awaiting_credit'))"

  const stmts: D1PreparedStatement[] = [
    // 1. Cộng balance (increment, có guard EXISTS) — no-op nếu deposit đã hoàn tất.
    db
      .prepare(
        `UPDATE users SET balance = balance + ?, updated_at = ? WHERE id = ? AND ${creditableGuard}`
      )
      .bind(creditVnd, now, userId, depositId),

    // 2. Bản ghi giao dịch nạp (INSERT ... SELECT ... WHERE EXISTS) — chỉ ghi khi còn cộng được,
    //    không sinh transaction "ma" ở các lần gọi trùng.
    db
      .prepare(
        `INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, status, created_at)
         SELECT ?, 'deposit', ?, ?, ?, 'deposit', ?, ?, 'success', ? WHERE ${creditableGuard}`
      )
      .bind(
        userId,
        creditVnd,
        balanceBefore,
        balanceAfter,
        depositId,
        `Nạp ${formatMoney(creditVnd, 'vi')}`,
        now,
        depositId
      ),

    // 3. Cập nhật deposit (gate idempotency) — đặt CUỐI để hai guard EXISTS ở trên còn thấy
    //    trạng thái cũ (pending/expired/awaiting_credit) trong cùng batch nguyên tử.
    depositUpdate,
  ]

  let results: D1Result[]
  try {
    results = await db.batch(stmts)
  } catch {
    // Lỗi atomic tạm thời sau khi thanh toán đã xác nhận → để caller retry (R14.5).
    // KHÔNG coi là đã xử lý: deposit chưa bị đánh dấu completed nên retry còn cộng được.
    return { success: false, error: 'db_error' }
  }

  // Guard: deposit update (stmt cuối) phải ảnh hưởng 1 dòng (đúng trạng thái cho phép hoàn tất).
  // changes === 0 → đã completed/cancelled (đã cộng trước đó) → chống cộng trùng.
  if (results[2].meta.changes === 0) {
    return { success: false, error: 'already_processed' }
  }

  return { success: true, newBalance: balanceAfter }
}

/**
 * Đánh dấu một deposit USDT sang `awaiting_credit` khi tỷ giá lỗi lúc nhận thanh toán
 * (R12.4): lưu `usdt_amount` để cron `credit-awaiting` cộng lại sau khi rate hợp lệ.
 *
 * Guard `WHERE id=? AND status IN ('pending','expired')`: KHÔNG bao giờ ghi đè deposit
 * đã `completed` (giữ idempotency khi callback trùng tới đúng lúc rate tạm lỗi).
 * `changes === 0` → bỏ qua (đã hoàn tất hoặc đã ở awaiting_credit).
 */
export async function markAwaitingCredit(
  db: D1Database,
  depositId: number,
  usdtAmount: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE deposits
       SET status = 'awaiting_credit', usdt_amount = ?
       WHERE id = ? AND status IN ('pending','expired')`
    )
    .bind(usdtAmount, depositId)
    .run()
}
