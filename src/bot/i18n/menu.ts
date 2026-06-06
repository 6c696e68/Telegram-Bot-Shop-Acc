/**
 * Routing nhãn menu chính (reply-keyboard) đa ngôn ngữ.
 *
 * Reply-keyboard dùng CHÍNH text của nút làm khóa routing. Khi `buildMainMenu(lang)`
 * render nhãn theo ngôn ngữ user, một user `en` sẽ thấy 'Shop' còn user `vi` thấy
 * '🛒 Mua hàng'. Để `handleTextMessage` route đúng bất kể ngôn ngữ, ta dựng sẵn
 * `MENU_ACTION_BY_LABEL` GỘP nhãn của MỌI locale trong SUPPORTED_LANGUAGES → action.
 *
 * Thêm ngôn ngữ mới = thêm catalog; map tự gộp nhãn mới, KHÔNG sửa lõi (OCP).
 * Bản `vi` giữ nhãn emoji cũ nên user `vi` không bị gián đoạn routing.
 */

import { SUPPORTED_LANGUAGES } from '../../i18n/locales'
import { catalogs } from './index'
import type { MessageKey } from './keys'

/** Hành động menu chính tương ứng từng nút. */
export type MenuAction = 'shop' | 'deposit' | 'history' | 'account'

/** Ánh xạ action → key catalog của nhãn nút. */
const MENU_LABEL_KEY_BY_ACTION: Record<MenuAction, MessageKey> = {
  shop: 'menu.shop',
  deposit: 'menu.deposit',
  history: 'menu.history',
  account: 'menu.account',
}

/**
 * Map nhãn (text nút) → action, gộp nhãn của MỌI locale.
 * Tra `MENU_ACTION_BY_LABEL.get(text)` thay cho switch chuỗi cứng.
 */
export const MENU_ACTION_BY_LABEL: Map<string, MenuAction> = (() => {
  const map = new Map<string, MenuAction>()
  const actions = Object.keys(MENU_LABEL_KEY_BY_ACTION) as MenuAction[]
  for (const lang of SUPPORTED_LANGUAGES) {
    for (const action of actions) {
      const label = catalogs[lang][MENU_LABEL_KEY_BY_ACTION[action]]
      if (label) map.set(label, action)
    }
  }
  return map
})()
