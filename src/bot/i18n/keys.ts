/**
 * MessageKey — tap khoa hop le cua catalog Bot, suy ra tu locale goc `en`.
 *
 * Tach rieng khoi index.ts de tranh import vong: catalog tung locale (vd vi.ts)
 * import type tu day de duoc rang buoc "phai phu du tap key" (Record<MessageKey,string>),
 * con index.ts gom cac catalog lai. en la single source of truth cho tap key.
 */

import type { en } from './catalogs/en'

/** Tap key phang, dung namespace (vd `onboarding.region.prompt`). */
export type MessageKey = keyof typeof en
