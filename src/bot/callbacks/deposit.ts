/**
 * Deposit flow handlers — nạp tiền đa phương thức theo vùng.
 *
 * Vùng quyết định tập phương thức nạp (`methodsForRegion`):
 *  - vietnam → SePay (VietQR, VND) + CryptoBot (USDT).
 *  - international → chỉ CryptoBot (USDT).
 * Nhiều phương thức → hiện bước chọn (`dep:method:<id>`); một phương thức → vào thẳng.
 * SePay giữ flow VND (mệnh giá/nhập tuỳ ý); CryptoBot dùng session step `crypto_amount`
 * (nhập USDT) → `CryptoPayProvider.createDeposit` → gửi nút `pay_url`.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 10.1, 10.3
 */

import type { DbDeposit, DbUser } from '../../types/db'
import type { Bindings } from '../../types/bindings'
import {
  sendMessage,
  sendPhoto,
  editOrSendMessage,
  editMessageText,
  buildInlineKeyboard,
} from '../telegram-api'
import { formatMoney, parseRate } from '../../utils/format'
import { getSession, setSession, clearSession } from '../session'
import { shouldSendNotice } from '../rate-limit'
import { depositPolicyMessage } from '../../services/deposit-policy'
import { readDepositLimits } from '../../services/deposit-limits'
import { readSystemConfigValue } from '../../utils/system-config'
import { sePayProvider, buildDepositCaption } from '../../services/payments/sepay-provider'
import { cryptoPayProvider } from '../../services/payments/cryptopay-provider'
import { payOsProvider } from '../../services/payments/payos-provider'
import {
  isMethodAllowedForRegion,
  enabledMethodsForRegion,
  isProviderEnabled,
  getProvider,
} from '../../services/payments/registry'
import type { ProviderId } from '../../services/payments/types'
import { resolveLang } from '../../services/user-locale'
import { t, type Lang } from '../i18n'

/** Mệnh giá nạp nhanh (grid 2×3) */
const PRESET_AMOUNTS = [30_000, 50_000, 100_000, 200_000, 500_000, 1_000_000]

/** Số USDT tối thiểu mặc định khi `crypto_min_usdt` chưa cấu hình (R13.5). */
const DEFAULT_CRYPTO_MIN_USDT = 5

/** Bản ghi user tối thiểu cần cho luồng nạp. */
type DepositUser = Pick<DbUser, 'id' | 'region' | 'language'>

/** Lấy user (id, region, language) theo telegram_id. */
async function loadDepositUser(db: D1Database, telegramId: number): Promise<DepositUser | null> {
  return db
    .prepare('SELECT id, region, language FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<DepositUser>()
}

/**
 * Entry nạp tiền (`dep:menu`): liệt kê phương thức theo vùng của user.
 *  - Nhiều phương thức → hiện bước chọn (`dep:method:<id>`).
 *  - Một phương thức → vào thẳng flow tương ứng.
 */
export async function handleDepositMenu(
  db: D1Database,
  botToken: string,
  chatId: number,
  telegramId: number,
  env: Bindings,
  messageId?: number
): Promise<void> {
  const user = await loadDepositUser(db, telegramId)
  const lang = await resolveLang(db, { language: user?.language ?? null })

  if (!user) {
    await sendMessage(botToken, chatId, t(lang, 'deposit.account_not_found'))
    return
  }

  // Router đã gate onboarding; region null ở đây là bất thường → yêu cầu chọn vùng lại.
  if (user.region === null) {
    await sendMessage(botToken, chatId, t(lang, 'onboarding.required'))
    return
  }

  const methods = await enabledMethodsForRegion(db, user.region)

  // Không phương thức nào được bật cho vùng (vd provider mới chưa được admin mở) — R7.6.
  if (methods.length === 0) {
    await sendMessage(botToken, chatId, t(lang, 'deposit.method.unavailable'))
    return
  }

  // Một phương thức → vào thẳng (không bắt user chọn thừa).
  if (methods.length === 1) {
    await startDepositMethod(db, botToken, chatId, telegramId, methods[0], env, lang, user, messageId)
    return
  }

  // Nhiều phương thức → hiện bước chọn (R8.3).
  const rows = methods.map((id) => [
    { text: t(lang, `deposit.method.${id}` as const), callback_data: `dep:method:${id}` },
  ])
  rows.push([{ text: t(lang, 'deposit.cancel'), callback_data: 'dep:cancel' }])

  await editOrSendMessage(botToken, chatId, messageId, t(lang, 'deposit.method.prompt'), {
    parse_mode: 'HTML',
    reply_markup: buildInlineKeyboard(rows),
  })
}

/**
 * Xử lý chọn phương thức (`dep:method:<id>`): enforce phương thức theo vùng rồi vào flow.
 */
export async function handleDepositMethod(
  db: D1Database,
  botToken: string,
  chatId: number,
  telegramId: number,
  method: string,
  env: Bindings,
  messageId?: number
): Promise<void> {
  const user = await loadDepositUser(db, telegramId)
  const lang = await resolveLang(db, { language: user?.language ?? null })

  if (!user) {
    await sendMessage(botToken, chatId, t(lang, 'deposit.account_not_found'))
    return
  }
  if (user.region === null) {
    await sendMessage(botToken, chatId, t(lang, 'onboarding.required'))
    return
  }

  // Validate phương thức theo registry (provider-agnostic): chấp nhận mọi ProviderId đã
  // đăng ký + thuộc vùng, KHÔNG còn allowlist cứng sepay/cryptobot (R20.1, R20.2, R20.3).
  const provider = getProvider(method as ProviderId)
  if (!provider || !isMethodAllowedForRegion(user.region, provider.id)) {
    await sendMessage(botToken, chatId, t(lang, 'deposit.method.unavailable'))
    return
  }

  // Enforce cờ bật provider (R10.5): provider chưa được admin mở → không khả dụng, không tạo deposit.
  if (!(await isProviderEnabled(db, provider.id))) {
    await sendMessage(botToken, chatId, t(lang, 'deposit.method.unavailable'))
    return
  }

  await startDepositMethod(db, botToken, chatId, telegramId, provider.id, env, lang, user, messageId)
}

/** Điều phối vào flow của phương thức cụ thể. */
async function startDepositMethod(
  db: D1Database,
  botToken: string,
  chatId: number,
  telegramId: number,
  method: ProviderId,
  env: Bindings,
  lang: Lang,
  user: DepositUser,
  messageId?: number
): Promise<void> {
  if (method === 'cryptobot') {
    await startCryptoDeposit(db, botToken, chatId, telegramId, lang, messageId)
    return
  }
  if (method === 'payos') {
    await startPayOsDeposit(db, botToken, chatId, telegramId, lang, messageId)
    return
  }
  await startSepayDeposit(db, botToken, chatId, telegramId, lang, messageId)
}

/**
 * SePay flow: hiển thị grid mệnh giá VND + cho phép nhập số tiền tuỳ ý.
 * Session: flow='deposit', step='amount'.
 */
async function startSepayDeposit(
  db: D1Database,
  botToken: string,
  chatId: number,
  telegramId: number,
  lang: Lang,
  messageId?: number
): Promise<void> {
  setSession(telegramId, 'deposit', 'amount')

  // Hạn mức lấy từ system_config (admin chỉnh qua CMS) — đồng bộ với Mini App + webhook SePay.
  const { min: minAmount } = await readDepositLimits(db)

  const text = [
    t(lang, 'deposit.title'),
    '',
    t(lang, 'deposit.amount.choose'),
    '',
    t(lang, 'deposit.amount.hint_min', { min: formatMoney(minAmount, lang) }),
    t(lang, 'deposit.amount.hint_cancel'),
  ].join('\n')

  // Build grid 2×3 inline keyboard
  const rows: { text: string; callback_data: string }[][] = []
  for (let i = 0; i < PRESET_AMOUNTS.length; i += 2) {
    const row = PRESET_AMOUNTS.slice(i, i + 2).map((amount) => ({
      text: formatMoney(amount, lang),
      callback_data: `dep:${amount}`,
    }))
    rows.push(row)
  }
  rows.push([{ text: t(lang, 'deposit.cancel'), callback_data: 'dep:cancel' }])

  const res = await editOrSendMessage(botToken, chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: buildInlineKeyboard(rows),
  })

  // Lưu messageId của menu mệnh giá vào session để ẩn (gỡ nút) khi đã tạo QR,
  // tránh user bấm lại spam tạo deposit + QR. Áp dụng cho cả nhập số tiền tùy ý.
  const menuMessageId = (res.result as { message_id?: number } | undefined)?.message_id
  if (menuMessageId) {
    setSession(telegramId, 'deposit', 'amount', { menuMessageId })
  }
}

/**
 * CryptoBot flow: yêu cầu user nhập số USDT.
 * Session: flow='deposit', step='crypto_amount'.
 */
async function startCryptoDeposit(
  db: D1Database,
  botToken: string,
  chatId: number,
  telegramId: number,
  lang: Lang,
  messageId?: number
): Promise<void> {
  setSession(telegramId, 'deposit', 'crypto_amount')

  const minUsdtRaw = await readSystemConfigValue(db, 'crypto_min_usdt')
  const minUsdt = Number(minUsdtRaw)
  const minUsdtDisplay =
    Number.isFinite(minUsdt) && minUsdt > 0 ? minUsdt : DEFAULT_CRYPTO_MIN_USDT

  // Tỷ giá hiện tại để hiển thị gợi ý quy đổi (1 USDT ≈ ? VND). Thiếu/không hợp lệ → bỏ qua hint (không crash).
  const rate = parseRate(await readSystemConfigValue(db, 'exchange_rate_usdt_vnd'))
  const promptText =
    rate !== null
      ? t(lang, 'deposit.crypto.prompt', { min: minUsdtDisplay }) +
        '\n' +
        t(lang, 'deposit.crypto.rate_hint', { rate: formatMoney(rate, lang) })
      : t(lang, 'deposit.crypto.prompt', { min: minUsdtDisplay })

  await editOrSendMessage(
    botToken,
    chatId,
    messageId,
    promptText,
    {
      parse_mode: 'HTML',
      reply_markup: buildInlineKeyboard([
        [{ text: t(lang, 'deposit.cancel'), callback_data: 'dep:cancel' }],
      ]),
    }
  )
}

/**
 * PayOS flow: yêu cầu user nhập số tiền VND (nhập qua text, KHÔNG dùng grid preset
 * `dep:{amount}` vì callback đó route về SePay). Theo mẫu CryptoBot dùng session step
 * RIÊNG `'payos_amount'` (KHÔNG reuse `'amount'` vì `handleDepositAmount` gắn cứng
 * `sePayProvider`).
 * Session: flow='deposit', step='payos_amount'.
 */
async function startPayOsDeposit(
  db: D1Database,
  botToken: string,
  chatId: number,
  telegramId: number,
  lang: Lang,
  messageId?: number
): Promise<void> {
  setSession(telegramId, 'deposit', 'payos_amount')

  // Hạn mức VND lấy từ system_config (đồng bộ với SePay/Mini App/webhook).
  const { min: minAmount } = await readDepositLimits(db)

  const text = [
    t(lang, 'deposit.title'),
    '',
    t(lang, 'deposit.payos.prompt'),
    '',
    t(lang, 'deposit.amount.hint_min', { min: formatMoney(minAmount, lang) }),
    t(lang, 'deposit.amount.hint_cancel'),
  ].join('\n')

  await editOrSendMessage(botToken, chatId, messageId, text, {
    parse_mode: 'HTML',
    reply_markup: buildInlineKeyboard([
      [{ text: t(lang, 'deposit.cancel'), callback_data: 'dep:cancel' }],
    ]),
  })
}

/**
 * Xử lý chọn mệnh giá / nhập số tiền VND → tạo deposit SePay pending + hiển thị QR.
 * Callback: `dep:{amount}` hoặc text input khi session step='amount'.
 */
export async function handleDepositAmount(
  db: D1Database,
  botToken: string,
  chatId: number,
  telegramId: number,
  amount: number,
  env: Bindings
): Promise<void> {
  const user = await loadDepositUser(db, telegramId)
  const lang = await resolveLang(db, { language: user?.language ?? null })

  if (!user) {
    await sendMessage(botToken, chatId, t(lang, 'deposit.account_not_found'))
    return
  }

  // Lấy messageId của menu mệnh giá (nếu có) để ẩn nút sau khi tạo QR.
  const menuMessageId = getSession(telegramId)?.data?.menuMessageId as number | undefined

  // Tạo yêu cầu nạp qua nguồn logic chung (validate hạn mức + luật nạp + transfer_code + VietQR).
  const result = await sePayProvider.createDeposit({
    db,
    env,
    userId: user.id,
    telegramId,
    rawAmount: amount,
    lang,
    channel: 'bot',
  })

  if (result.success === false) {
    const err = result.error
    if (err.type === 'limit') {
      await sendMessage(botToken, chatId, err.message, { parse_mode: 'HTML' })
      return
    }
    if (err.type === 'policy') {
      if (shouldSendNotice(`dep:${telegramId}`)) {
        const message = depositPolicyMessage(
          {
            allowed: false,
            reason: err.reason,
            retryAfterMs: err.retryAfterMs,
          },
          lang
        )
        await sendMessage(botToken, chatId, message, { parse_mode: 'HTML' })
      }
      return
    }
    await sendMessage(botToken, chatId, t(lang, 'deposit.generic_error'), { parse_mode: 'HTML' })
    return
  }

  const { vietqr } = result.output
  if (!vietqr) {
    await sendMessage(botToken, chatId, t(lang, 'deposit.generic_error'))
    return
  }

  // Ẩn lưới mệnh giá: gỡ toàn bộ nút trên menu để user không bấm lại spam tạo QR.
  if (menuMessageId) {
    await editMessageText(
      botToken,
      chatId,
      menuMessageId,
      [
        t(lang, 'deposit.title'),
        '',
        t(lang, 'deposit.created', { amount: formatMoney(vietqr.amountVnd, lang) }),
        t(lang, 'deposit.created.scan'),
      ].join('\n'),
      { parse_mode: 'HTML' }
    )
  }

  // Send QR code image
  await sendPhoto(botToken, chatId, vietqr.qrUrl, {
    caption: t(lang, 'deposit.qr.caption'),
    parse_mode: 'HTML',
  })

  // Send transfer details — caption dùng chung với Mini App (`buildDepositCaption`).
  const cancelKeyboard = buildInlineKeyboard([
    [{ text: t(lang, 'deposit.cancel.button'), callback_data: 'dep:cancel' }],
  ])

  await sendMessage(
    botToken,
    chatId,
    buildDepositCaption(vietqr.bank, vietqr.amountVnd, vietqr.transferCode, lang),
    {
      parse_mode: 'HTML',
      reply_markup: cancelKeyboard,
    }
  )

  // Clear session — user đã nhận QR, không cần giữ flow nữa
  clearSession(telegramId)
}

/**
 * Xử lý nhập số USDT (session step='crypto_amount') → tạo invoice Crypto Pay + gửi nút pay_url.
 */
export async function handleCryptoDepositAmount(
  db: D1Database,
  botToken: string,
  chatId: number,
  telegramId: number,
  usdt: number,
  env: Bindings
): Promise<void> {
  const user = await loadDepositUser(db, telegramId)
  const lang = await resolveLang(db, { language: user?.language ?? null })

  if (!user) {
    await sendMessage(botToken, chatId, t(lang, 'deposit.account_not_found'))
    return
  }

  const result = await cryptoPayProvider.createDeposit({
    db,
    env,
    userId: user.id,
    telegramId,
    rawAmount: usdt,
    lang,
    channel: 'bot',
  })

  if (result.success === false) {
    const err = result.error
    if (err.type === 'limit') {
      await sendMessage(botToken, chatId, err.message, { parse_mode: 'HTML' })
      return
    }
    if (err.type === 'policy') {
      if (shouldSendNotice(`dep:${telegramId}`)) {
        const message = depositPolicyMessage(
          {
            allowed: false,
            reason: err.reason,
            retryAfterMs: err.retryAfterMs,
          },
          lang
        )
        await sendMessage(botToken, chatId, message, { parse_mode: 'HTML' })
      }
      return
    }
    // provider_error (gồm createInvoice thất bại — R10.4): không tạo pending, báo lỗi.
    await sendMessage(botToken, chatId, err.message, { parse_mode: 'HTML' })
    return
  }

  const { crypto } = result.output
  if (!crypto) {
    await sendMessage(botToken, chatId, t(lang, 'deposit.generic_error'))
    return
  }

  // Gửi nút mở liên kết thanh toán Crypto Pay (R10.3).
  await sendMessage(
    botToken,
    chatId,
    t(lang, 'deposit.crypto.created', { usdt: crypto.usdtAmount, vnd: formatMoney(crypto.creditVnd, lang) }),
    {
      parse_mode: 'HTML',
      reply_markup: buildInlineKeyboard([
        [{ text: t(lang, 'deposit.crypto.pay_button'), url: crypto.payUrl }],
        [{ text: t(lang, 'deposit.cancel.button'), callback_data: 'dep:cancel' }],
      ]),
    }
  )

  // Clear session — user đã nhận liên kết thanh toán.
  clearSession(telegramId)
}

/**
 * Xử lý nhập số tiền VND (session step='payos_amount') → tạo Payment_Link PayOS qua
 * `payOsProvider.createDeposit` + gửi nút inline mở `checkout_url`.
 */
export async function handlePayOsDepositAmount(
  db: D1Database,
  botToken: string,
  chatId: number,
  telegramId: number,
  amount: number,
  env: Bindings
): Promise<void> {
  const user = await loadDepositUser(db, telegramId)
  const lang = await resolveLang(db, { language: user?.language ?? null })

  if (!user) {
    await sendMessage(botToken, chatId, t(lang, 'deposit.account_not_found'))
    return
  }

  const result = await payOsProvider.createDeposit({
    db,
    env,
    userId: user.id,
    telegramId,
    rawAmount: amount,
    lang,
    channel: 'bot',
  })

  if (result.success === false) {
    const err = result.error
    if (err.type === 'limit') {
      await sendMessage(botToken, chatId, err.message, { parse_mode: 'HTML' })
      return
    }
    if (err.type === 'policy') {
      if (shouldSendNotice(`dep:${telegramId}`)) {
        const message = depositPolicyMessage(
          {
            allowed: false,
            reason: err.reason,
            retryAfterMs: err.retryAfterMs,
          },
          lang
        )
        await sendMessage(botToken, chatId, message, { parse_mode: 'HTML' })
      }
      return
    }
    // provider_error (gồm tạo Payment_Link thất bại — R14.3): không tạo pending, báo lỗi chung.
    await sendMessage(botToken, chatId, err.message, { parse_mode: 'HTML' })
    return
  }

  const { payos } = result.output
  if (!payos) {
    await sendMessage(botToken, chatId, t(lang, 'deposit.generic_error'))
    return
  }

  // Gửi nút inline mở trang thanh toán PayOS (R20.4). KHÔNG kèm nút Huỷ:
  // PayOS không cho huỷ thủ công (R23.1) — giữ pending để TTL→expired vẫn cộng được
  // nếu thanh toán xác nhận tới sau.
  await sendMessage(
    botToken,
    chatId,
    t(lang, 'deposit.payos.created', { amount: formatMoney(payos.amountVnd, lang) }),
    {
      parse_mode: 'HTML',
      reply_markup: buildInlineKeyboard([
        [{ text: t(lang, 'deposit.payos.pay_button'), url: payos.checkoutUrl }],
      ]),
    }
  )

  // Clear session — user đã nhận liên kết thanh toán.
  clearSession(telegramId)
}

/**
 * Huỷ deposit đang chờ.
 * Callback: `dep:cancel` hoặc lệnh /huy
 */
export async function handleDepositCancel(
  db: D1Database,
  botToken: string,
  chatId: number,
  telegramId: number,
  messageId?: number
): Promise<void> {
  const user = await loadDepositUser(db, telegramId)
  const lang = await resolveLang(db, { language: user?.language ?? null })

  if (!user) {
    await sendMessage(botToken, chatId, t(lang, 'deposit.account_not_found'))
    return
  }

  // Tìm deposit pending CÓ THỂ HUỶ (mọi provider TRỪ payos). PayOS không cho huỷ thủ công
  // (R23) — nếu chọn nhầm deposit payos mới nhất sẽ chặn oan việc huỷ một deposit
  // sepay/cryptobot cũ hơn. Vì vậy ưu tiên huỷ deposit non-payos mới nhất.
  const pendingDeposit = await db
    .prepare(
      `SELECT id, amount, correlation_ref, provider FROM deposits WHERE user_id = ? AND status = 'pending' AND provider != 'payos' ORDER BY created_at DESC LIMIT 1`
    )
    .bind(user.id)
    .first<Pick<DbDeposit, 'id' | 'amount' | 'correlation_ref' | 'provider'>>()

  // Clear session
  clearSession(telegramId)

  if (!pendingDeposit) {
    // Không có deposit huỷ được. Nếu user vẫn còn deposit payos pending → báo PayOS không
    // cho huỷ (R23); ngược lại báo không có deposit nào đang chờ.
    const payosPending = await db
      .prepare(
        `SELECT id FROM deposits WHERE user_id = ? AND status = 'pending' AND provider = 'payos' LIMIT 1`
      )
      .bind(user.id)
      .first<{ id: number }>()

    if (payosPending) {
      await editOrSendMessage(
        botToken,
        chatId,
        messageId,
        t(lang, 'deposit.cancel.payos_not_allowed'),
        { parse_mode: 'HTML' }
      )
      return
    }

    await editOrSendMessage(botToken, chatId, messageId, t(lang, 'deposit.cancel.none'), {
      parse_mode: 'HTML',
    })
    return
  }

  // Cancel deposit (non-payos) — guard provider != 'payos' để chắc chắn không bao giờ
  // huỷ một deposit payos (R23.2), kể cả khi có race thay đổi trạng thái.
  await db
    .prepare(`UPDATE deposits SET status = 'cancelled' WHERE id = ? AND provider != 'payos'`)
    .bind(pendingDeposit.id)
    .run()

  const text = [
    t(lang, 'deposit.cancel.done'),
    '',
    t(lang, 'deposit.cancel.amount', { amount: formatMoney(pendingDeposit.amount, lang) }),
    pendingDeposit.correlation_ref
      ? t(lang, 'deposit.cancel.code', { code: pendingDeposit.correlation_ref })
      : '',
    '',
    t(lang, 'deposit.cancel.back_hint'),
  ]
    .filter((line) => line !== '')
    .join('\n')

  await editOrSendMessage(botToken, chatId, messageId, text, {
    parse_mode: 'HTML',
  })
}
