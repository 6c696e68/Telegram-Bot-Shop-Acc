# Báo cáo E2E Test — telegram-shop-bot

- Bắt đầu: 2026-06-05T01:59:34Z
- Kết thúc: 2026-06-05T02:00:35Z
- Endpoint: http://127.0.0.1:8787 (wrangler dev local, real HTTP)
- DB: D1 local (.wrangler/state/v3/d1)
- Tổng: 17 — PASS: 17 — FAIL: 0

## Kết quả

| ID | Test case | Status | Details |
|---|---|---|---|
| AUTH | Admin login admin/admin123 | PASS | JWT length=151 |
| SEED | Tạo category 30k + 5 products | PASS | cat_id=4 stock=5 |
| TC-01a | Tạo user A qua /start | PASS | user.id=7 telegram_id=11111 |
| TC-01b | SePay webhook → cộng balance + deposit completed | PASS | balance=100000 deposit=completed res={"success":true} |
| TC-01c | User A mua 1×30k với balance 100k | PASS | bal=70000 sold=1 orders=1 tx=1 |
| TC-01d | FK toàn vẹn: products.order_id = order_items.order_id = transactions.reference_id | PASS | all matched |
| TC-01e | Sổ cái: balance_before + amount == balance_after | PASS | [{'bb': 0, 'ba': 100000, 'a': 100000}, {'bb': 100000, 'ba': 70000, 'a': -26000}] |
| TC-02 | User B (balance=0) mua → bị từ chối, KHÔNG ghi gì | PASS | bal=0 ords=0 txs=0 sold=0 stock=4 |
| TC-03 | Race spam 5 buy đồng thời (balance đủ mua 1) | PASS | bal=0 orders=1 tx_purchase=1 sold=1 stock_delta=1 |
| TC-04 | SePay webhook idempotent: replay không cộng đôi | PASS | bal first=50000 replay=50000 |
| TC-05 | Admin manual approve → cộng balance + audit_log | PASS | bal=75000 dep=completed audit=1 |
| TC-05b | Admin approve replay deposit completed → reject | PASS | bal vẫn=75000 res={"success":false,"data":null,"error":"Cannot approve deposit with status 'completed'"} |
| TC-06 | Admin API yêu cầu JWT (no token=401, fake token=401) | PASS | no=401 bad=401 |
| TC-07 | SePay webhook chặn sai/thiếu API key | PASS | bad=401 no=401 |
| TC-08 | Telegram webhook chặn sai/thiếu secret token | PASS | bad=401 none=401 |
| TC-09 | History query bằng telegram_id (regression fix) | PASS | hist_A=1 hist_C=1 |
| TC-10 | Bảo toàn: sum(balance) == sum(deposit) + sum(purchase) + sum(adjust) | PASS | bal=195000 net=195000 (dep=225000 pur=-60000 adj=26000) |

## Snapshot DB cuối

| kind | key | value |
|---|---|---|
| users | 11111 | 70000 |
| users | 22222 | 0 |
| users | 33333 | 0 |
| users | 44444 | 50000 |
| users | 55555 | 75000 |
| deposit | 6 | 100000 |
| deposit | 7 | 50000 |
| deposit | 8 | 75000 |
| order | 6 | 26000 |
| order | 7 | 26000 |
| product | 8 | 7 |
| product | 9 | 9 |
| product | 10 | 0 |
| product | 11 | 0 |
| product | 12 | 0 |

## Quy trình test

1. **TC-01 Nạp + mua (full flow user A):** /start tạo user → tạo deposit pending → SePay webhook giả lập (real HTTP với Apikey) → verify balance/deposit.status → mua 1×30k → verify balance giảm, products marked sold, FK chains đúng (orders ↔ products.order_id ↔ order_items.order_id ↔ transactions.reference_id), sổ cái balance_before+amount=balance_after.
2. **TC-02 Mua không có tiền:** user mới balance=0 spam buy → phải reject, không ghi orders/transactions/products.
3. **TC-03 Race condition (spam 2 nơi cùng lúc):** user balance đủ mua 1 sản phẩm, fire 5 callback buy đồng thời (giả lập 2+ device hoặc spam) → CHỈ 1 đơn thành công, balance=0, đúng 1 product sold.
4. **TC-04 Webhook idempotency:** SePay gọi 2 lần cùng id → chỉ cộng balance 1 lần.
5. **TC-05 Manual approve:** admin login → POST /deposits/:id/approve → balance cộng, audit_log ghi. Replay phải bị reject.
6. **TC-06 Admin API auth:** GET /api/admin/deposits không token / sai token → 401.
7. **TC-07 SePay auth:** webhook không/sai Apikey → 401, không tạo deposit.
8. **TC-08 Telegram auth:** webhook không/sai X-Telegram-Bot-Api-Secret-Token → 401.
9. **TC-09 Regression bug 2:** xác nhận history/account đã JOIN qua telegram_id.
10. **TC-10 Bảo toàn sổ cái:** SUM(balance) == SUM(transactions.amount) (deposit+purchase+adjust).

## Đánh giá bảo mật

- Telegram webhook: bắt buộc `X-Telegram-Bot-Api-Secret-Token`.
- SePay webhook: bắt buộc `Authorization: Apikey <key>` + idempotency theo `sepay_transaction_id`.
- Admin API: JWT 24h, bcrypt password, lockout sau 5 lần sai.
- Race condition mua hàng: concurrency guard `UPDATE balance WHERE balance >= total` + FK `order_id`.
- Sổ cái cân: tổng balance khớp tổng transactions.
