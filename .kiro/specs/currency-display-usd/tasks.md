# Implementation Plan: Currency Display (USD) — Quick Plan

## Overview

Display-only feature: international users see USD, everyone else sees VND. All storage,
payments, crediting, and limits stay VND/USDT-native and unchanged. Work flows through the
design's choke points: the core formatter in `src/utils/format.ts` first, then bot
threading, Mini App backend, payment providers, and the CMS dual display. Property tests
target the single formatter choke point. Implemented in TypeScript.

## Tasks

- [x] 1. Core formatter additions in `src/utils/format.ts`
  - [x] 1.1 Add `CurrencyContext`, `parseRate`, `vndToUsdString`, `formatMoneyFor`, `buildCurrencyContext`
    - Add `CurrencyContext { lang; region; rate }` interface reusing `Lang`/`Region` from `src/i18n/locales`
    - Implement `parseRate` (finite and > 0 else null), `vndToUsdString(amountVnd, rate)` as `'$' + (amountVnd/rate).toFixed(2)`
    - Implement `formatMoneyFor` (USD only when region `international` AND valid rate, else existing `formatMoney` VND fallback)
    - Implement async `buildCurrencyContext(db, { lang, region })` reading `exchange_rate_usdt_vnd` via `readSystemConfigValue` (DB-first, no cache)
    - Keep existing `formatMoney`/`formatCurrency`/`formatNumber`/`formatDateTime` unchanged
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3_

  - [x] 1.2 Write property test for region-conditioned selection
    - **Property 1: Region-conditioned currency selection**
    - **Validates: Requirements 1.1, 1.2, 1.3, 1.4**

  - [x] 1.3 Write property test for USD conversion correctness and formatting
    - **Property 2: USD conversion correctness and formatting**
    - **Validates: Requirements 2.1, 2.2, 2.3**

  - [x] 1.4 Write property test for no-mutation of stored amount
    - **Property 3: Conversion never mutates the stored amount**
    - **Validates: Requirements 2.4, 5.4**

  - [x] 1.5 Write property test for fail-safe to VND on missing/invalid rate
    - **Property 4: Fail-safe to VND on missing or invalid rate**
    - **Validates: Requirements 3.1, 3.2**

  - [x] 1.6 Write property test for always-valid currency string
    - **Property 5: Output is always a valid currency string**
    - **Validates: Requirements 3.3**

  - [x] 1.7 Write unit tests for `parseRate` boundaries
    - Cover `"0"`, `"-1"`, `""`, `"abc"`, `"25000"`, null/undefined; representative `$5.00` trailing-zero case
    - _Requirements: 2.3, 3.2_

- [x] 2. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Bot handler threading
  - [x] 3.1 Extend `loadUserLocale` in `src/bot/router.ts` to build `CurrencyContext`
    - Call `buildCurrencyContext(db, { lang, region })` in the existing region+lang read and return `ctx` alongside `exists`/`region`/`lang`
    - _Requirements: 1.1, 1.2, 1.3_

  - [x] 3.2 Use `formatMoneyFor` in `src/bot/commands/start.ts` balance line
    - After resolving region, build/receive `ctx` and render the balance with `formatMoneyFor(balance, ctx)`
    - _Requirements: 1.1, 1.2, 1.4_

  - [x] 3.3 Thread `ctx` through `src/bot/notify-deposit.ts`
    - Accept `ctx`; render deposit amount/balance display lines with `formatMoneyFor` (display only; crediting stays VND)
    - _Requirements: 1.1, 2.1, 5.4_

  - [x] 3.4 Update `[total]`/`[balance]` in `src/utils/telegram-template.ts`
    - Replace the `lang` param of `renderSuccessMessage` with `ctx`; render `[total]`/`[balance]` via `formatMoneyFor`, header text via `ctx.lang`; keep HTML escaping of dynamic values
    - _Requirements: 1.1, 1.2, 2.1_

- [x] 4. Mini App backend `*_display` conversion in `src/routes/miniapp-api.ts`
  - [x] 4.1 Build `CurrencyContext` per request and convert descriptive `*_display` strings
    - Build `ctx = await buildCurrencyContext(c.env.DB, { lang, region: user.region })` near top of each handler
    - Replace `formatCurrency(...)` with `formatMoneyFor(..., ctx)` for `balance_display`, `price_display`, `total_display`, `new_balance_display`, and onboarding balance
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1_

  - [x] 4.2 Keep VietQR `amount_display` VND-only
    - Render `vietqr.amountVnd` with `formatMoney(amountVnd, lang)` regardless of region (payable transfer amount)
    - _Requirements: 5.5, 5.2_

  - [x] 4.3 Write integration check for VietQR payable amount staying VND
    - **Property 8: VietQR payable amount stays VND**
    - **Validates: Requirements 5.5**

- [x] 5. Payment providers + deposit-service descriptions
  - [x] 5.1 Thread `ctx` only for non-payable descriptive amounts
    - In `src/services/payments/sepay-provider.ts`, `cryptopay-provider.ts`, and deposit-service description strings, use `formatMoneyFor` only for informational/echo balance lines
    - Keep SePay/VietQR payable amounts in VND and CryptoBot amounts in USDT unchanged
    - _Requirements: 5.2, 5.5, 5.4_

- [x] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. CMS dual display
  - [x] 7.1 Add dual-string `formatMoney` + `parseRate` in `cms/src/utils/format.ts`
    - Implement CMS-local `parseRate`; `formatMoney(amountVnd, rate?)` returns `…đ (~$d.dd)` for valid rate, VND-only otherwise
    - _Requirements: 4.1, 4.2, 4.4_

  - [x] 7.2 Write property test for CMS dual string (VND primary)
    - **Property 6: CMS dual string with VND as primary**
    - **Validates: Requirements 4.1, 4.2**

  - [x] 7.3 Write property test for CMS VND-only fallback
    - **Property 7: CMS VND-only fallback when rate invalid**
    - **Validates: Requirements 4.4**

  - [x] 7.4 Add `useExchangeRate` composable reading `GET /api/admin/config`
    - Create `cms/src/composables/useExchangeRate.ts` with shared reactive `rate` ref; `load()` fetches `/config` and parses `exchange_rate_usdt_vnd`
    - _Requirements: 4.3_

  - [x] 7.5 Apply dual rendering in Config, Transactions, Categories, Orders views
    - Call `formatMoney(amount, rate.value)`; `ConfigView` sets shared `rate` on load, other views call `load()`/read shared ref on mount; null rate → VND-only
    - _Requirements: 4.5, 4.4_

- [x] 8. Verification checkpoint
  - Run `npm test` (Vitest + fast-check) and `npm run build:cms`; fix any failures
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (tests) and can be skipped for a faster MVP.
- Each task references specific requirements for traceability.
- Property tests target the `src/utils/format` and `cms/src/utils/format` choke points.
- Payment-path logic is unchanged and verified by existing tests continuing to pass.
- No schema changes; `system_config.exchange_rate_usdt_vnd` reused as-is (DB-first, no cache).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "7.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "3.1", "4.1", "5.1", "7.2", "7.3", "7.4"] },
    { "id": 2, "tasks": ["3.2", "3.3", "3.4", "4.2", "7.5"] },
    { "id": 3, "tasks": ["4.3"] }
  ]
}
```
