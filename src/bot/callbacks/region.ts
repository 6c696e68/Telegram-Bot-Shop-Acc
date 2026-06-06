/**
 * Callback onboarding chọn vùng — `reg:vietnam` / `reg:international`.
 *
 * Luồng: user bấm nút onboarding → set region cho user (kèm ngôn ngữ khởi tạo của
 * vùng nếu chưa khoá) → hiển thị menu chính theo ngôn ngữ đã resolve.
 * Requirements: 1.3, 1.4
 */

import type { DbUser } from '../../types/db'
import type { Region, Lang } from '../../i18n/locales'
import { sendMessage, buildMainMenu, buildInlineKeyboard } from '../telegram-api'
import { setRegion, resolveLang } from '../../services/user-locale'
import { t } from '../i18n'

/**
 * Gửi inline keyboard onboarding chọn vùng [Việt Nam][Quốc tế].
 * Dùng cho `/start` (region NULL) và guard onboarding khi user chưa chọn vùng.
 * Requirements: 1.1, 1.2, 1.6, 3.7
 */
export async function sendRegionOnboarding(
  botToken: string,
  chatId: number,
  lang: Lang
): Promise<void> {
  await sendMessage(botToken, chatId, t(lang, 'onboarding.region.prompt'), {
    parse_mode: 'HTML',
    reply_markup: buildInlineKeyboard([
      [
        { text: t(lang, 'onboarding.region.vietnam'), callback_data: 'reg:vietnam' },
        { text: t(lang, 'onboarding.region.international'), callback_data: 'reg:international' },
      ],
    ]),
  })
}

/**
 * Gửi bộ chọn vùng cho lệnh `/region` (đổi vùng sau onboarding — R5.1).
 * Cùng inline keyboard `reg:*` nhưng dùng prompt `region.prompt` (không phải onboarding).
 */
export async function sendRegionPicker(
  botToken: string,
  chatId: number,
  lang: Lang
): Promise<void> {
  await sendMessage(botToken, chatId, t(lang, 'region.prompt'), {
    parse_mode: 'HTML',
    reply_markup: buildInlineKeyboard([
      [
        { text: t(lang, 'region.name.vietnam'), callback_data: 'reg:vietnam' },
        { text: t(lang, 'region.name.international'), callback_data: 'reg:international' },
      ],
    ]),
  })
}

/** Tập vùng hợp lệ nhận từ callback (validate trước khi ghi DB). */
const VALID_REGIONS: readonly Region[] = ['vietnam', 'international']

function isRegion(value: string | undefined): value is Region {
  return !!value && (VALID_REGIONS as readonly string[]).includes(value)
}

/**
 * Xử lý callback `reg:<region>`:
 *  - Validate region.
 *  - Lấy `users.id` từ `telegram_id` (handler bot chỉ có telegram_id).
 *  - `setRegion` (set ngôn ngữ khởi tạo nếu user chưa tự đổi).
 *  - Resolve lại ngôn ngữ rồi hiển thị menu chính (R1.3, R1.4).
 */
export async function handleRegionCallback(
  db: D1Database,
  botToken: string,
  chatId: number,
  params: string[],
  telegramId: number
): Promise<void> {
  const region = params[0]
  if (!isRegion(region)) {
    // Vùng không hợp lệ → bỏ qua, không thay đổi trạng thái.
    return
  }

  const user = await db
    .prepare('SELECT id FROM users WHERE telegram_id = ?')
    .bind(telegramId)
    .first<Pick<DbUser, 'id'>>()

  if (!user) {
    // Chưa có user (chưa /start) → không xử lý; user cần /start trước.
    return
  }

  await setRegion(db, user.id, region)

  // Resolve ngôn ngữ sau khi setRegion (có thể vừa set ngôn ngữ khởi tạo theo vùng).
  const updated = await db
    .prepare('SELECT language FROM users WHERE id = ?')
    .bind(user.id)
    .first<Pick<DbUser, 'language'>>()
  const lang = await resolveLang(db, { language: updated?.language ?? null })

  const regionLabel =
    region === 'vietnam' ? t(lang, 'region.name.vietnam') : t(lang, 'region.name.international')

  await sendMessage(botToken, chatId, t(lang, 'region.changed', { region: regionLabel }), {
    parse_mode: 'HTML',
    reply_markup: buildMainMenu(lang),
  })

  // Truy cập nhanh bằng inline shortcuts (callback_data cố định, nhãn theo lang).
  await sendMessage(botToken, chatId, t(lang, 'menu.quick_access'), {
    parse_mode: 'HTML',
    reply_markup: buildInlineKeyboard([
      [
        { text: t(lang, 'menu.shop'), callback_data: 'cat:list' },
        { text: t(lang, 'menu.deposit'), callback_data: 'dep:menu' },
      ],
      [
        { text: t(lang, 'menu.history'), callback_data: 'hist' },
        { text: t(lang, 'menu.account'), callback_data: 'acc' },
      ],
    ]),
  })
}
