/**
 * Deposit Policy — luật nghiệp vụ chống lạm dụng khi tạo yêu cầu nạp tiền.
 *
 * Dùng CHUNG cho cả bot (`handleDepositAmount`) lẫn Mini App API (`POST /deposits`)
 * để hành vi đồng nhất giữa hai kênh.
 *
 * Luật:
 *  1. TTL: deposit `pending` quá {@link DEPOSIT_TTL_MS} (15 phút) coi như hết hạn —
 *     không chiếm slot pending và (ở webhook SePay) không còn được cộng tiền.
 *  2. Trần pending: tối đa {@link MAX_PENDING_DEPOSITS} (3) deposit `pending` còn hiệu
 *     lực cùng lúc cho mỗi user. Đủ 3 → phải chờ cái cũ nhất hết hạn mới tạo tiếp.
 *  3. Cooldown: tối thiểu {@link DEPOSIT_COOLDOWN_MS} (5 phút) giữa 2 lần tạo deposit.
 *
 * Nguồn sự thật là D1 (cột `created_at`), KHÔNG dùng rate-limit in-memory: đây là luật
 * nghiệp vụ kéo dài nhiều phút nên phải đúng kể cả khi Worker isolate bị recycle hoặc
 * chạy song song nhiều isolate.
 *
 * So sánh thời gian dùng `strftime('%s', …)` để chuẩn hoá mọi định dạng timestamp
 * (ISO `…T…Z` ở production lẫn `datetime('now')` dạng có dấu cách) về epoch giây UTC,
 * tránh lỗi so sánh chuỗi lẫn lộn định dạng.
 */

import { t, type Lang } from '../bot/i18n'

/** Thời gian sống của một deposit `pending` trước khi hết hạn (ms). */
export const DEPOSIT_TTL_MS = 15 * 60 * 1000

/** Số deposit `pending` còn hiệu lực tối đa cho mỗi user tại một thời điểm. */
export const MAX_PENDING_DEPOSITS = 3

/** Khoảng cách tối thiểu giữa 2 lần tạo deposit của cùng một user (ms). */
export const DEPOSIT_COOLDOWN_MS = 5 * 60 * 1000

/** Lý do một yêu cầu tạo deposit bị chặn. */
export type DepositPolicyReason = 'cooldown' | 'too_many_pending'

/** Kết quả kiểm tra luật tạo deposit. */
export interface DepositPolicyVerdict {
  /** Cho phép tạo deposit hay không. */
  allowed: boolean
  /** Lý do bị chặn (chỉ có khi `allowed = false`). */
  reason?: DepositPolicyReason
  /** Thời gian (ms) cần chờ tới khi được phép tạo lại (chỉ có khi `allowed = false`). */
  retryAfterMs?: number
}

/**
 * Kiểm tra một user có được phép tạo deposit mới không, dựa trên dữ liệu D1.
 *
 * @param db - D1Database instance.
 * @param userId - `users.id` nội bộ (KHÔNG phải `telegram_id`).
 * @returns Verdict cho phép/chặn kèm `reason` + `retryAfterMs` khi bị chặn.
 */
export async function checkDepositPolicy(
  db: D1Database,
  userId: number
): Promise<DepositPolicyVerdict> {
  const ttlSec = DEPOSIT_TTL_MS / 1000

  // Một truy vấn gộp 3 chỉ số cần thiết, mọi mốc thời gian quy về epoch giây UTC:
  //  - active_pending: số deposit pending còn trong cửa sổ TTL.
  //  - oldest_pending_age_sec: tuổi (giây) của deposit pending CÒN HIỆU LỰC cũ nhất.
  //  - last_deposit_age_sec: tuổi (giây) của deposit GẦN NHẤT (mọi trạng thái) — cho cooldown.
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM deposits
            WHERE user_id = ? AND status = 'pending'
              AND strftime('%s','now') - strftime('%s', created_at) < ?) AS active_pending,
         (SELECT MAX(strftime('%s','now') - strftime('%s', created_at)) FROM deposits
            WHERE user_id = ? AND status = 'pending'
              AND strftime('%s','now') - strftime('%s', created_at) < ?) AS oldest_pending_age_sec,
         (SELECT strftime('%s','now') - strftime('%s', MAX(created_at)) FROM deposits
            WHERE user_id = ?) AS last_deposit_age_sec`
    )
    .bind(userId, ttlSec, userId, ttlSec, userId)
    .first<{
      active_pending: number
      oldest_pending_age_sec: number | null
      last_deposit_age_sec: number | null
    }>()

  const activePending = row?.active_pending ?? 0

  // 1) Trần số deposit pending — chặn cho tới khi cái cũ nhất hết hạn (giải phóng 1 slot).
  if (activePending >= MAX_PENDING_DEPOSITS) {
    const oldestAgeMs = (row?.oldest_pending_age_sec ?? 0) * 1000
    return {
      allowed: false,
      reason: 'too_many_pending',
      retryAfterMs: Math.max(0, DEPOSIT_TTL_MS - oldestAgeMs),
    }
  }

  // 2) Cooldown 5 phút kể từ lần tạo deposit gần nhất.
  const lastAgeSec = row?.last_deposit_age_sec
  if (lastAgeSec !== null && lastAgeSec !== undefined) {
    const lastAgeMs = lastAgeSec * 1000
    if (lastAgeMs < DEPOSIT_COOLDOWN_MS) {
      return {
        allowed: false,
        reason: 'cooldown',
        retryAfterMs: DEPOSIT_COOLDOWN_MS - lastAgeMs,
      }
    }
  }

  return { allowed: true }
}

/**
 * Dựng thông báo cho người dùng khi yêu cầu tạo deposit bị chặn, theo `lang` (R4.1/R4.2).
 * Dùng chung cho bot (gửi tin nhắn) và Mini App (trả `error` trong response 429).
 */
export function depositPolicyMessage(verdict: DepositPolicyVerdict, lang: Lang): string {
  const wait = formatWait(verdict.retryAfterMs ?? 0, lang)
  if (verdict.reason === 'too_many_pending') {
    return t(lang, 'deposit.policy.too_many_pending', { max: MAX_PENDING_DEPOSITS, wait })
  }
  // Mặc định: cooldown.
  return t(lang, 'deposit.policy.cooldown', { wait })
}

/** Quy đổi ms → chuỗi chờ đã bản địa hoá ("X phút Y giây" / "X minutes Y seconds"...). */
function formatWait(ms: number, lang: Lang): string {
  const totalSec = Math.max(1, Math.ceil(ms / 1000))
  if (totalSec < 60) return t(lang, 'deposit.wait.seconds', { sec: totalSec })
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return sec === 0
    ? t(lang, 'deposit.wait.minutes', { min })
    : t(lang, 'deposit.wait.minutes_seconds', { min, sec })
}
