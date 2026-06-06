// Registry ngôn ngữ — single source of truth cho Bot/Mini App/CMS.
// Thêm 1 ngôn ngữ = thêm 1 mã vào SUPPORTED_LANGUAGES + catalog tương ứng;
// KHONG sua schema, KHONG sua loi xu ly (OCP).

/**
 * Vung dia ly quyet dinh tap phuong thuc nap + ngon ngu khoi tao.
 * Dinh nghia cuc bo o day vi src/services/payments/types.ts chua duoc tao
 * (task 3.1). Khi tao, payments/types.ts SHALL import lai Region tu file nay
 * de tranh khai bao trung (DRY).
 */
export type Region = 'vietnam' | 'international'

/**
 * Tap ngon ngu duoc bat. Tap MO: them ma o day la du de scale.
 * Hien tai: tieng Viet + tieng Anh.
 */
export const SUPPORTED_LANGUAGES = ['vi', 'en'] as const

/** Ma locale hop le (suy ra tu registry, khong hardcode roi rac). */
export type Lang = (typeof SUPPORTED_LANGUAGES)[number]

/** Mat xich cuoi cung cua chuoi fallback ngon ngu. */
export const BASE_FALLBACK_LANG: Lang = 'en'

/**
 * Type guard: kiem tra mot gia tri co thuoc registry ngon ngu hay khong.
 * Dung de validate user.language / default_language doc tu DB hoac config.
 */
export function isSupportedLang(value: string | null | undefined): value is Lang {
  return !!value && (SUPPORTED_LANGUAGES as readonly string[]).includes(value)
}

/**
 * Bang tra vung -> ngon ngu khoi tao (mo rong duoc, khong if/else cung).
 * Dung khi setRegion lan dau de chon ngon ngu mac dinh theo vung.
 */
export const REGION_DEFAULT_LANG: Record<Region, Lang> = {
  vietnam: 'vi',
  international: 'en',
}
