# Requirements Document

## Introduction

This feature adds USD display for international users while keeping VND for Vietnam users. It is a presentation-layer change only: all monetary values stay stored as VND integers, and all payment, deposit-crediting, and limit logic remains VND-native and unchanged. The system selects the displayed currency per user based on the existing `region` field, converts VND to USD using the existing admin-configured `exchange_rate_usdt_vnd` rate, and fails safe to VND display whenever the rate is missing or invalid. The CMS shows both currencies side by side (VND primary).

This is a focused Quick Plan scoped to the user-facing display choke points listed in the design notes.

## Glossary

- **Display_Layer**: The set of formatting helpers and message/string builders that turn a stored VND amount into a user-facing currency string. Includes backend `src/utils/format.ts`, Mini App backend `*_display` builders in `src/routes/miniapp-api.ts`, bot handlers, payment-provider display messages, `src/utils/telegram-template.ts` placeholders, CMS `cms/src/utils/format.ts` and views.
- **Region**: The stored user attribute with value `vietnam` or `international` (type `Region` in `src/i18n/locales.ts`). May be `null`/unset for a user who has not selected a region.
- **International_User**: A user whose `region` equals `international`.
- **Vietnam_User**: A user whose `region` equals `vietnam`.
- **Exchange_Rate**: The numeric VND-per-USDT value stored in `system_config` under key `exchange_rate_usdt_vnd`, used as the VND-to-USD divisor. Treated as VND-per-USD for display conversion.
- **Valid_Rate**: An Exchange_Rate that parses to a finite number strictly greater than zero.
- **USD_String**: A formatted string with a `$` prefix and exactly 2 decimal places, e.g. `$5.00`.
- **VND_String**: A formatted string of the stored VND integer grouped by locale with the `đ` suffix, e.g. `150.000đ`.
- **CMS_Dual_String**: A combined string showing VND as primary and USD in parentheses, e.g. `150.000đ (~$5.00)`.
- **Stored_Amount**: A monetary value persisted in the database, always a VND integer.
- **Payment_Path**: Deposit creation, deposit crediting, deposit limits, and provider transaction logic (SePay/VietQR in VND, CryptoBot in USDT).

## Requirements

### Requirement 1: Per-region currency selection

**User Story:** As an international buyer, I want to see prices and balances in USD, so that I can understand amounts in a familiar currency.

#### Acceptance Criteria

1. WHERE the Region of a user equals `international` AND a Valid_Rate exists, THE Display_Layer SHALL format that user's monetary values as a USD_String.
2. WHERE the Region of a user equals `vietnam`, THE Display_Layer SHALL format that user's monetary values as a VND_String.
3. IF the Region of a user is unset or is any value other than `international`, THEN THE Display_Layer SHALL format that user's monetary values as a VND_String.
4. WHERE a monetary value is displayed without an associated user Region context, THE Display_Layer SHALL format the value as a VND_String.

### Requirement 2: Conversion correctness and rounding

**User Story:** As an international buyer, I want USD amounts to match the configured rate, so that displayed prices are accurate.

#### Acceptance Criteria

1. WHEN the Display_Layer converts a Stored_Amount to USD using a Valid_Rate, THE Display_Layer SHALL compute the USD value as the Stored_Amount divided by the Exchange_Rate.
2. WHEN the Display_Layer produces a USD_String, THE Display_Layer SHALL round the USD value to exactly 2 decimal places.
3. WHEN the Display_Layer produces a USD_String, THE Display_Layer SHALL prefix the value with `$` and render exactly 2 decimal digits, including trailing zeros.
4. THE Display_Layer SHALL leave the Stored_Amount in VND unchanged when producing any USD_String.

### Requirement 3: Fail-safe when rate is missing or invalid

**User Story:** As any buyer, I want amounts to always render as a valid currency string, so that I never see broken or misleading values.

#### Acceptance Criteria

1. IF the Exchange_Rate is missing, THEN THE Display_Layer SHALL format the value as a VND_String for all users including International_Users.
2. IF the Exchange_Rate does not parse to a finite number greater than zero, THEN THE Display_Layer SHALL format the value as a VND_String for all users including International_Users.
3. THE Display_Layer SHALL produce a currency string that contains no `NaN`, `Infinity`, or empty-numeric output for any Stored_Amount and any Region.

### Requirement 4: CMS dual display

**User Story:** As an admin, I want to see both VND and USD for monetary values, so that I can reconcile amounts across regions.

#### Acceptance Criteria

1. WHERE a Valid_Rate is available to the CMS, THE Display_Layer SHALL render monetary values in CMS views as a CMS_Dual_String with VND as the primary value and USD in parentheses.
2. THE Display_Layer SHALL display the VND value as the primary value in every CMS_Dual_String.
3. WHEN the CMS renders monetary values, THE Display_Layer SHALL obtain the Exchange_Rate from the system configuration.
4. IF no Valid_Rate is available to the CMS, THEN THE Display_Layer SHALL render monetary values in CMS views as a VND_String only.
5. THE Display_Layer SHALL apply CMS_Dual_String rendering in the Config, Transactions, Categories, and Orders views.

### Requirement 5: VND-native storage, payments, and limits unchanged

**User Story:** As an operator, I want storage, payments, and limits to stay in VND, so that this display change introduces no financial-logic risk.

#### Acceptance Criteria

1. THE System SHALL persist every Stored_Amount as a VND integer regardless of the displaying user's Region.
2. WHEN a deposit is created or credited, THE Payment_Path SHALL compute amounts in VND for SePay and in USDT for CryptoBot exactly as before this feature.
3. THE Payment_Path SHALL evaluate deposit limits against VND values regardless of the displaying user's Region.
4. THE System SHALL apply currency conversion only to user-facing display strings and SHALL NOT apply conversion to any Stored_Amount, deposit-creation value, crediting value, or limit value.
5. WHERE the SePay/VietQR provider produces payment instructions, THE Payment_Path SHALL express the payable amount in VND.
