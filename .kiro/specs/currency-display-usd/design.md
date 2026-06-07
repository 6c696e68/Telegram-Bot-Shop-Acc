# Design Document — Currency Display (USD) — Quick Plan

## Overview

Display-only feature: international users see USD, everyone else sees VND. Storage,
payments (SePay/VietQR in VND, CryptoBot in USDT), deposit crediting, and limits remain
unchanged and VND/USDT-native (R5). The change lives entirely in the Display_Layer.

Conversion is the inverse of crediting: crediting does `creditVnd = floor(usdt × rate)`;
display does `usd = vnd / rate` rounded to 2 decimals. The rate is the existing
`system_config` key `exchange_rate_usdt_vnd`, read DB-first with no caching via
`src/utils/system-config.ts`.

Region selection rule (single, centralized):
- `international` + Valid_Rate → USD_String (`$5.00`)
- `vietnam` / `null` / unknown / no-context → VND_String (`150.000đ`) — fail-safe
- missing / invalid rate → VND_String for everyone — fail-safe (never `NaN`/`Infinity`)

CMS shows both: `150.000đ (~$5.00)` (VND primary), VND-only when rate invalid.

## Architecture

```
                         system_config.exchange_rate_usdt_vnd  (DB, no cache)
                                          |
        ┌─────────────────────────────────┼──────────────────────────────────┐
        |                                  |                                   |
   Bot (router/handlers)          Mini App backend                         CMS (Vue)
   loadUserLocale() reads          (miniapp-api.ts) reads                  GET /api/admin/config
   region+lang+rate once  ───►     region+rate per request  ───►          → reactive rate store
        |                                  |                                   |
   buildCurrencyContext()          buildCurrencyContext()                 cms formatMoney(vnd, rate)
        |                                  |                                   |
   formatMoneyFor(vnd, ctx)        *_display = formatMoneyFor(vnd, ctx)    dual string / VND-only
        |
   telegram-template / notify-deposit accept the ctx
```

Choke point: every user-facing money string flows through one of two functions in
`src/utils/format.ts` (backend) or `cms/src/utils/format.ts` (CMS). The rate is read
per request at the place that already loads the user (region), never cached.

## Components and Interfaces

### 1. Core formatter — `src/utils/format.ts` (backend)

Backward-compatible additions; existing `formatMoney(amountVnd, lang)`,
`formatCurrency(amount)`, `formatNumber`, `formatDateTime` are unchanged (VND callers keep working).

```typescript
import { type Lang, type Region } from '../i18n/locales'

/**
 * Per-request currency context. Built once where the user (region) is loaded.
 * `rate` is the parsed Valid_Rate (VND-per-USD divisor) or null when missing/invalid.
 */
export interface CurrencyContext {
  lang: Lang
  region: Region | null
  rate: number | null
}

/**
 * Valid_Rate guard (R2/R3). Parses a system_config string to a finite number > 0,
 * else null. Mirrors parsePositiveNumber used in the payment path so display and
 * crediting agree on what "valid" means.
 */
export function parseRate(value: string | undefined | null): number | null {
  if (value == null) return null
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * Rounding/precision helper (R2.1–R2.3). Caller MUST pass a Valid_Rate (> 0, finite).
 * usd = amountVnd / rate, fixed to exactly 2 decimals, '$' prefix, trailing zeros kept.
 * Stored VND amount is never mutated (R2.4).
 */
export function vndToUsdString(amountVnd: number, rate: number): string {
  return '$' + (amountVnd / rate).toFixed(2)
}

/**
 * Currency-aware formatter (R1, R3). The single display choke point.
 *   international + Valid_Rate  → USD_String
 *   otherwise (vietnam/null/unknown/invalid rate) → VND_String (fail-safe)
 */
export function formatMoneyFor(amountVnd: number, ctx: CurrencyContext): string {
  if (ctx.region === 'international' && ctx.rate !== null) {
    return vndToUsdString(amountVnd, ctx.rate)
  }
  return formatMoney(amountVnd, ctx.lang) // existing VND formatter
}
```

USD formatting decision: **manual `'$' + (vnd/rate).toFixed(2)`** rather than
`Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })`. Reasons: exact `$`
prefix and exactly two decimals with trailing zeros are guaranteed deterministically, no
locale/grouping surprises, and it matches the `$5.00` glossary form. `toFixed(2)` on a
finite quotient never yields `NaN`/`Infinity` because `rate > 0` and `amountVnd` is a
finite integer.

Context builder (reads the rate once per request, DB-first, no cache):

```typescript
import { readSystemConfigValue } from './system-config'

export async function buildCurrencyContext(
  db: D1Database,
  opts: { lang: Lang; region: Region | null }
): Promise<CurrencyContext> {
  const rate = parseRate(await readSystemConfigValue(db, 'exchange_rate_usdt_vnd'))
  return { lang: opts.lang, region: opts.region, rate }
}
```

### 2. Bot handlers — region + rate threading

The bot router already loads region + lang in `loadUserLocale` (`src/bot/router.ts`) and
`start.ts` does the same. Extend that one read to also build a `CurrencyContext`:

- `loadUserLocale` → also call `buildCurrencyContext(db, { lang, region })` and return
  `ctx` alongside `exists`/`region`/`lang`. Handlers that print money receive `ctx`.
- `src/bot/commands/start.ts`: after resolving region, build `ctx`, then
  `formatMoneyFor(balance, ctx)` for the balance line.
- `src/bot/commands/admin.ts`: admin views are operator-facing and VND-native — keep
  `formatMoney(price, lang)` (admin is not an International_User display target). No change
  required unless we want admin in USD (out of scope).
- `src/bot/notify-deposit.ts`: accept `ctx`; deposit amount/balance lines use
  `formatMoneyFor`. (The deposit was credited in VND; display only.)
- `src/utils/telegram-template.ts`: `renderSuccessMessage(templatesByLang, vars, ctx)` —
  replace the `lang` param with `ctx`. `[total]` / `[balance]` render via
  `formatMoneyFor(vars.totalAmount, ctx)` / `formatMoneyFor(vars.balanceAfter, ctx)`.
  Header text still uses `ctx.lang`. The success message is sent to the buyer, so it must
  respect the buyer's region.

Rule of thumb: a string shown to a **buyer** uses `formatMoneyFor(_, ctx)`; a string that
is a **payable instruction** (what to actually transfer) stays VND (see below).

### 3. Mini App backend — `src/routes/miniapp-api.ts` (single source of truth)

`c.get('user')` already carries `region` and `balance`. Build one `CurrencyContext` per
request and use it for all `*_display` strings; the client renders server strings verbatim.

- Build once near the top of each handler: `const ctx = await buildCurrencyContext(c.env.DB, { lang, region: user.region })`.
- Replace `formatCurrency(...)` with `formatMoneyFor(..., ctx)` for:
  `balance_display` (MeDto, /home, /region response), `price_display` (catalog/detail),
  `total_display` (orders list/detail), `new_balance_display` (purchase result),
  and onboarding balance string.
- **Exception — payable amount stays VND (R5.5):** the VietQR deposit `amount_display`
  (`vietqr.amountVnd`) is the exact sum the user must transfer to the bank. It is rendered
  with VND-only `formatMoney(amountVnd, lang)` regardless of region, because SePay/VietQR
  settles in VND. CryptoBot amounts are already USDT-native and produced by the provider.

### 4. Payment providers + deposit-service descriptions

`src/services/payments/sepay-provider.ts` (`buildDepositCaption`),
`cryptopay-provider.ts`, and the deposit-service description strings produce user-facing
text. Thread `region`/`rate` (or a `CurrencyContext`) where a **non-payable** descriptive
amount is shown. **Payable amounts remain VND for SePay (R5.5) and USDT for CryptoBot
(R5.2)** — do not convert those. In practice most provider strings are payable
instructions and stay as-is; only an informational balance/echo line (if any) uses
`formatMoneyFor`.

### 5. CMS dual display — `cms/src/utils/format.ts` + views

CMS build is separate from the Worker, so it carries its own small guard + formatter.

```typescript
// cms/src/utils/format.ts
function parseRate(v: string | null | undefined): number | null {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Dual display (R4). Valid rate → "150.000đ (~$5.00)"; invalid/missing → "150.000đ". */
export function formatMoney(amountVnd: number, rate?: number | null): string {
  const vnd = amountVnd.toLocaleString(bcp47()) + 'đ'
  const r = typeof rate === 'number' ? rate : null
  if (r !== null && Number.isFinite(r) && r > 0) {
    return `${vnd} (~$${(amountVnd / r).toFixed(2)})`
  }
  return vnd
}
```

Rate source (R4.3): the CMS already calls `GET /api/admin/config` (returns
`configs.exchange_rate_usdt_vnd`). Provide the rate to the formatter via a small reactive
composable/store so views don't each refetch:

```typescript
// cms/src/composables/useExchangeRate.ts
const rate = ref<number | null>(null)
export function useExchangeRate() {
  async function load() {
    const res = await api.get<{ configs: Record<string, string> }>('/config')
    rate.value = parseRate(res.data?.configs?.exchange_rate_usdt_vnd)
  }
  return { rate, load }
}
```

Views call `formatMoney(amount, rate.value)`. `ConfigView` already loads `/config`, so it
can set the shared `rate` on load; other views call `load()` on mount (or read the shared
ref if already loaded). Apply dual rendering in **Config, Transactions, Categories, and
Orders** views (R4.5). When `rate.value` is null → VND-only (R4.4).

### 6. Mini App frontend — `miniapp/src/i18n/index.ts`

Because the server is the single source of truth and ships ready-made `*_display`
strings, the client SHALL render those strings verbatim and SHALL NOT add a USD entry to
client `numberFormats` or re-convert amounts. This avoids double conversion and keeps the
region/rate logic in exactly one place. Keep any client-side numeric formatting minimal
and VND-only (e.g. input hints that are inherently VND).

## Data Models

No schema changes. Reused/added types only:

- `CurrencyContext { lang: Lang; region: Region | null; rate: number | null }` — transient,
  per request.
- `Region` and `Lang` reused from `src/i18n/locales.ts`.
- `system_config.exchange_rate_usdt_vnd` reused as-is (string, VND-per-USD divisor).

## Error Handling

- `parseRate` is the only place "valid rate" is decided: finite AND `> 0`, else `null`.
- `formatMoneyFor` only enters the USD branch when `region === 'international'` AND
  `rate !== null`; every other path returns a VND_String. This covers missing rate,
  non-numeric rate, zero/negative rate, null/unset region, and no-context callers (R1.3,
  R1.4, R3.1, R3.2).
- `vndToUsdString` is never called without a Valid_Rate, so output can never be `NaN`,
  `Infinity`, or empty (R3.3).
- CMS mirrors the same guard; a failed `/config` fetch leaves `rate = null` → VND-only.
- DB-first, no caching (existing `system-config.ts` behavior): an admin rate change in the
  CMS takes effect on the next request without redeploy.

## Testing Strategy

Backend uses Vitest + fast-check (existing `npm test`). Dual approach:

- **Property tests** (`src/utils/format` choke point), min 100 iterations each:
  - Conversion/rounding: for any VND integer and any Valid_Rate, `vndToUsdString` returns
    `$` + a value equal to `(vnd/rate)` to 2 decimals, always 2 decimal digits.
  - Region branching: for any amount, `formatMoneyFor` returns USD iff
    region is `international` and rate is valid, VND otherwise.
  - Fail-safe: for any amount, any region, and any invalid rate string (empty, non-numeric,
    `0`, negative, `NaN`/`Infinity` literals), output contains no `NaN`/`Infinity` and ends
    with `đ` (VND) — never an empty numeric.
- **Unit/example tests**: `parseRate` boundary cases (`"0"`, `"-1"`, `""`, `"abc"`,
  `"25000"`); CMS `formatMoney` dual string shape `150.000đ (~$5.00)` and VND-only
  fallback; representative `$5.00` trailing-zero case.
- **Out of scope for PBT** (per workflow guidance): CMS Vue view rendering (snapshot/manual),
  the `/config` HTTP fetch wiring (1 integration check), and any payment-path logic (already
  covered, must remain unchanged — verified by existing tests still passing).

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — a formal statement about what the system should do. Properties bridge human-readable specifications and machine-verifiable correctness guarantees.*

After reflection, the testable criteria consolidate into the properties below. Region
criteria 1.1–1.4 collapse into one branching property; conversion criteria 2.1–2.3 collapse
into one correctness/format property; mutation criteria 2.4/5.4 combine; fail-safe criteria
3.1/3.2 combine; CMS 4.1/4.2 combine. Criteria 4.3, 4.5, 5.1, 5.2, 5.3 are
integration/wiring concerns covered by integration checks and the unchanged payment-path
tests (not property tests).

### Property 1: Region-conditioned currency selection

*For any* VND amount, any region value, and any rate string, `formatMoneyFor` produces a
USD_String if and only if the region equals `international` and the rate is a Valid_Rate;
in every other case (vietnam, null, unknown, or no context) it produces a VND_String.

**Validates: Requirements 1.1, 1.2, 1.3, 1.4**

### Property 2: USD conversion correctness and formatting

*For any* VND amount and any Valid_Rate, `vndToUsdString` returns a string matching
`^\$\d+\.\d{2}$` whose numeric part equals the amount divided by the rate rounded to
exactly 2 decimal places (trailing zeros preserved).

**Validates: Requirements 2.1, 2.2, 2.3**

### Property 3: Conversion never mutates the stored amount

*For any* VND amount and any context, formatting (`formatMoneyFor` / `vndToUsdString`)
leaves the input amount unchanged and applies conversion only to the produced display
string.

**Validates: Requirements 2.4, 5.4**

### Property 4: Fail-safe to VND on missing or invalid rate

*For any* VND amount and any region (including `international`), if the rate is missing or
does not parse to a finite number strictly greater than zero, `formatMoneyFor` produces a
VND_String.

**Validates: Requirements 3.1, 3.2**

### Property 5: Output is always a valid currency string

*For any* VND amount, any region value, and any rate string, the output of `formatMoneyFor`
contains no `NaN`, no `Infinity`, and no empty-numeric segment.

**Validates: Requirements 3.3**

### Property 6: CMS dual string with VND as primary

*For any* VND amount and any Valid_Rate, the CMS `formatMoney` produces a CMS_Dual_String in
which the VND value appears first as the primary value and the USD value appears in
parentheses (form `…đ (~$d.dd)`).

**Validates: Requirements 4.1, 4.2**

### Property 7: CMS VND-only fallback when rate invalid

*For any* VND amount, if no Valid_Rate is available, the CMS `formatMoney` produces a
VND_String only (no `$` segment).

**Validates: Requirements 4.4**

### Property 8: VietQR payable amount stays VND

*For any* region (including `international`), the VietQR deposit `amount_display` (the
payable transfer amount) is rendered as a VND_String.

**Validates: Requirements 5.5**
