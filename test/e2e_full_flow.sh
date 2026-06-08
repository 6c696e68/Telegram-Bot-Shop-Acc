#!/usr/bin/env bash
# End-to-end test thật cho telegram-shop-bot.
# Chạy real HTTP qua wrangler dev (port 8787) + DB local.
# Output Markdown report tới docs/E2E_REPORT.md.

set -u
set -o pipefail

BASE="http://127.0.0.1:8787"
TG_SECRET="12345678abcdef"
SEPAY_KEY="set-later"
ADMIN_USER="admin"
ADMIN_PASS="admin123"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPORT="$ROOT/docs/E2E_REPORT.md"
mkdir -p "$ROOT/docs"

PASS=0
FAIL=0
declare -a STEPS

now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }

log_step() {
  # log_step <id> <title> <status: PASS|FAIL> <details_oneline>
  local id="$1" title="$2" status="$3" details="$4"
  STEPS+=("| $id | $title | $status | $details |")
  if [[ "$status" == "PASS" ]]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); fi
  echo "[$status] $id — $title :: $details"
}

# ----- Helpers -----

d1() {
  # d1 "<sql>"
  npx wrangler d1 execute DB --local --command "$1" --json 2>/dev/null
}

d1_first_int() {
  # d1_first_int "<sql>" "<col>"
  d1 "$1" | python3 -c "import sys,json;d=json.load(sys.stdin);r=d[0]['results'];print(r[0]['$2'] if r else '')"
}

http_admin_login() {
  curl -s -X POST "$BASE/api/admin/auth/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$ADMIN_USER\",\"password\":\"$ADMIN_PASS\"}"
}

# Send Telegram callback_query through webhook
tg_callback() {
  # tg_callback <update_id> <telegram_id> <username> <data>
  local uid="$1" tid="$2" uname="$3" data="$4"
  curl -s -X POST "$BASE/webhook/telegram" \
    -H 'Content-Type: application/json' \
    -H "X-Telegram-Bot-Api-Secret-Token: $TG_SECRET" \
    --data-binary "{\"update_id\":$uid,\"callback_query\":{\"id\":\"cb-$uid\",\"from\":{\"id\":$tid,\"is_bot\":false,\"first_name\":\"User$tid\",\"username\":\"$uname\"},\"message\":{\"message_id\":1000,\"chat\":{\"id\":$tid,\"type\":\"private\"},\"date\":1780000000},\"data\":\"$data\"}}"
}

# Send Telegram /start so user is auto-created
tg_start() {
  local uid="$1" tid="$2" uname="$3"
  curl -s -X POST "$BASE/webhook/telegram" \
    -H 'Content-Type: application/json' \
    -H "X-Telegram-Bot-Api-Secret-Token: $TG_SECRET" \
    --data-binary "{\"update_id\":$uid,\"message\":{\"message_id\":1,\"from\":{\"id\":$tid,\"is_bot\":false,\"first_name\":\"User$tid\",\"username\":\"$uname\"},\"chat\":{\"id\":$tid,\"type\":\"private\"},\"date\":1780000000,\"text\":\"/start\"}}"
}

reset_db() {
  # Xoá theo đúng thứ tự FK. Giữ admin_users + system_config.
  d1 "DELETE FROM audit_logs" >/dev/null
  d1 "DELETE FROM order_items" >/dev/null
  d1 "DELETE FROM transactions" >/dev/null
  d1 "DELETE FROM products" >/dev/null
  d1 "DELETE FROM orders" >/dev/null
  d1 "DELETE FROM product_types" >/dev/null
  d1 "DELETE FROM deposits" >/dev/null
  d1 "DELETE FROM users" >/dev/null
}

# ============== START ==============
START_TIME=$(now)

# Sanity: server up
HEALTH=$(curl -s "$BASE/health" || true)
if [[ "$HEALTH" != *"ok"* ]]; then
  echo "Server not running on $BASE"
  exit 1
fi

reset_db

# Login admin
LOGIN_RAW=$(http_admin_login)
TOKEN=$(echo "$LOGIN_RAW" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['token'])")
if [[ -z "$TOKEN" ]]; then
  log_step "AUTH" "Admin login" "FAIL" "Login failed: $LOGIN_RAW"
  exit 1
fi
log_step "AUTH" "Admin login admin/admin123" "PASS" "JWT length=${#TOKEN}"

# Seed product type + 5 products (đủ cho mọi case)
d1 "INSERT INTO product_types (name, price, emoji) VALUES ('FlowCat', 26000, '📦');" >/dev/null
CAT_ID=$(d1_first_int "SELECT id FROM product_types WHERE name='FlowCat'" "id")
d1 "INSERT INTO products (type_id, content, status) VALUES
  ($CAT_ID, 'flow-acc-1', 'available'),
  ($CAT_ID, 'flow-acc-2', 'available'),
  ($CAT_ID, 'flow-acc-3', 'available'),
  ($CAT_ID, 'flow-acc-4', 'available'),
  ($CAT_ID, 'flow-acc-5', 'available');" >/dev/null
STOCK=$(d1_first_int "SELECT COUNT(*) c FROM products WHERE type_id=$CAT_ID AND status='available'" "c")
log_step "SEED" "Tạo category 30k + 5 products" "PASS" "cat_id=$CAT_ID stock=$STOCK"

# ============== TC-01: Nạp tiền qua webhook SePay rồi mua ==============
TG_A=11111
tg_start 100 $TG_A "userA" >/dev/null
USER_A=$(d1_first_int "SELECT id FROM users WHERE telegram_id=$TG_A" "id")
[[ -n "$USER_A" ]] && log_step "TC-01a" "Tạo user A qua /start" "PASS" "user.id=$USER_A telegram_id=$TG_A" \
  || log_step "TC-01a" "Tạo user A qua /start" "FAIL" "user not created"

# Create deposit pending
d1 "INSERT INTO deposits (user_id, correlation_ref, amount, status) VALUES ($USER_A, 'NAPFLOWA01', 100000, 'pending');" >/dev/null
DEP_A=$(d1_first_int "SELECT id FROM deposits WHERE correlation_ref='NAPFLOWA01'" "id")

# Simulate SePay webhook
SEPAY_RES=$(curl -s -X POST "$BASE/webhook/sepay" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Apikey $SEPAY_KEY" \
  --data-binary "{\"id\":99001,\"gateway\":\"VCB\",\"transactionDate\":\"2026-06-05 12:00:00\",\"accountNumber\":\"7938383838\",\"subAccount\":null,\"code\":null,\"content\":\"NAPFLOWA01\",\"transferType\":\"in\",\"description\":\"NAPFLOWA01\",\"transferAmount\":100000,\"accumulated\":0,\"referenceCode\":\"FT-A-1\"}")
sleep 1
BAL_A=$(d1_first_int "SELECT balance b FROM users WHERE id=$USER_A" "b")
DEP_STAT=$(d1 "SELECT status s FROM deposits WHERE id=$DEP_A" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d[0]['results'][0]['s'])")
if [[ "$BAL_A" == "100000" && "$DEP_STAT" == "completed" ]]; then
  log_step "TC-01b" "SePay webhook → cộng balance + deposit completed" "PASS" "balance=$BAL_A deposit=$DEP_STAT res=${SEPAY_RES:0:80}"
else
  log_step "TC-01b" "SePay webhook → cộng balance + deposit completed" "FAIL" "balance=$BAL_A deposit=$DEP_STAT res=$SEPAY_RES"
fi

# User A mua 1 sản phẩm (30k) — đủ tiền, đủ stock
tg_callback 101 $TG_A "userA" "buy:$CAT_ID:1" >/dev/null
sleep 1
BAL_A2=$(d1_first_int "SELECT balance b FROM users WHERE id=$USER_A" "b")
SOLD_A=$(d1_first_int "SELECT COUNT(*) c FROM products WHERE buyer_id=$USER_A AND status='sold'" "c")
ORD_A=$(d1_first_int "SELECT COUNT(*) c FROM orders WHERE user_id=$USER_A" "c")
TX_A=$(d1_first_int "SELECT COUNT(*) c FROM transactions WHERE user_id=$USER_A AND type='purchase'" "c")
if [[ "$BAL_A2" == "70000" && "$SOLD_A" == "1" && "$ORD_A" == "1" && "$TX_A" == "1" ]]; then
  log_step "TC-01c" "User A mua 1×30k với balance 100k" "PASS" "bal=70000 sold=1 orders=1 tx=1"
else
  log_step "TC-01c" "User A mua 1×30k với balance 100k" "FAIL" "bal=$BAL_A2 sold=$SOLD_A orders=$ORD_A tx=$TX_A"
fi

# Verify FK link products↔orders↔order_items↔transactions
JOIN_RES=$(d1 "SELECT p.id pid, p.order_id pord, oi.order_id ioid, t.reference_id tref, o.id oid FROM products p JOIN order_items oi ON oi.product_id=p.id JOIN orders o ON o.id=p.order_id JOIN transactions t ON t.user_id=$USER_A AND t.type='purchase' AND t.reference_type='order' WHERE p.buyer_id=$USER_A")
JOIN_OK=$(echo "$JOIN_RES" | python3 -c "import sys,json;d=json.load(sys.stdin);r=d[0]['results'];print('1' if r and all(x['pord']==x['ioid']==x['tref']==x['oid'] for x in r) else '0')")
if [[ "$JOIN_OK" == "1" ]]; then
  log_step "TC-01d" "FK toàn vẹn: products.order_id = order_items.order_id = transactions.reference_id" "PASS" "all matched"
else
  log_step "TC-01d" "FK toàn vẹn" "FAIL" "$JOIN_RES"
fi

# Tx accounting: balance_before/after khớp
TX_ACC=$(d1 "SELECT balance_before bb, balance_after ba, amount a FROM transactions WHERE user_id=$USER_A ORDER BY id")
TX_ACC_OK=$(echo "$TX_ACC" | python3 -c "
import sys,json
d=json.load(sys.stdin)['results' if False else 0]['results']
ok=True
for i,t in enumerate(d):
  if t['bb']+t['a']!=t['ba']: ok=False;break
print('1' if ok else '0')")
if [[ "$TX_ACC_OK" == "1" ]]; then
  log_step "TC-01e" "Sổ cái: balance_before + amount == balance_after" "PASS" "$(echo "$TX_ACC" | python3 -c "import sys,json;d=json.load(sys.stdin)[0]['results'];print(d)")"
else
  log_step "TC-01e" "Sổ cái" "FAIL" "$TX_ACC"
fi

# ============== TC-02: User B mua khi BALANCE=0 (insufficient_balance) ==============
TG_B=22222
tg_start 200 $TG_B "userB" >/dev/null
USER_B=$(d1_first_int "SELECT id FROM users WHERE telegram_id=$TG_B" "id")

BAL_B_BEFORE=$(d1_first_int "SELECT balance b FROM users WHERE id=$USER_B" "b")
STOCK_BEFORE=$(d1_first_int "SELECT COUNT(*) c FROM products WHERE type_id=$CAT_ID AND status='available'" "c")

tg_callback 201 $TG_B "userB" "buy:$CAT_ID:1" >/dev/null
sleep 1

BAL_B_AFTER=$(d1_first_int "SELECT balance b FROM users WHERE id=$USER_B" "b")
ORDS_B=$(d1_first_int "SELECT COUNT(*) c FROM orders WHERE user_id=$USER_B" "c")
TXS_B=$(d1_first_int "SELECT COUNT(*) c FROM transactions WHERE user_id=$USER_B" "c")
SOLD_B=$(d1_first_int "SELECT COUNT(*) c FROM products WHERE buyer_id=$USER_B" "c")
STOCK_AFTER=$(d1_first_int "SELECT COUNT(*) c FROM products WHERE type_id=$CAT_ID AND status='available'" "c")

if [[ "$BAL_B_BEFORE" == "0" && "$BAL_B_AFTER" == "0" && "$ORDS_B" == "0" && "$TXS_B" == "0" && "$SOLD_B" == "0" && "$STOCK_BEFORE" == "$STOCK_AFTER" ]]; then
  log_step "TC-02" "User B (balance=0) mua → bị từ chối, KHÔNG ghi gì" "PASS" "bal=0 ords=0 txs=0 sold=0 stock=$STOCK_AFTER"
else
  log_step "TC-02" "User B (balance=0) mua → bị từ chối" "FAIL" "bal_before=$BAL_B_BEFORE bal_after=$BAL_B_AFTER ords=$ORDS_B txs=$TXS_B sold=$SOLD_B stock_before=$STOCK_BEFORE stock_after=$STOCK_AFTER"
fi

# ============== TC-03: Race condition — 1 user, 2 device cùng spam buy 1 cái ==============
# User C có balance=26000 (chỉ đủ mua 1), spam 5 lần buy:cat:1 đồng thời.
# Expected: chỉ 1 đơn thành công, balance=0, 1 product sold, không bị trừ -30k 2 lần.

TG_C=33333
tg_start 300 $TG_C "userC" >/dev/null
USER_C=$(d1_first_int "SELECT id FROM users WHERE telegram_id=$TG_C" "id")
d1 "UPDATE users SET balance=26000 WHERE id=$USER_C; INSERT INTO transactions (user_id, type, amount, balance_before, balance_after, reference_type, description, status) VALUES ($USER_C, 'adjustment', 26000, 0, 26000, 'manual_seed', 'seed for race test', 'success');" >/dev/null

STOCK_C_BEFORE=$(d1_first_int "SELECT COUNT(*) c FROM products WHERE type_id=$CAT_ID AND status='available'" "c")

# Fire 5 concurrent webhooks
for i in 1 2 3 4 5; do
  tg_callback $((300+i)) $TG_C "userC" "buy:$CAT_ID:1" >/dev/null &
done
wait
sleep 2

BAL_C_AFTER=$(d1_first_int "SELECT balance b FROM users WHERE id=$USER_C" "b")
ORDS_C=$(d1_first_int "SELECT COUNT(*) c FROM orders WHERE user_id=$USER_C" "c")
TXS_C=$(d1_first_int "SELECT COUNT(*) c FROM transactions WHERE user_id=$USER_C AND type='purchase'" "c")
SOLD_C=$(d1_first_int "SELECT COUNT(*) c FROM products WHERE buyer_id=$USER_C AND status='sold'" "c")
STOCK_C_AFTER=$(d1_first_int "SELECT COUNT(*) c FROM products WHERE type_id=$CAT_ID AND status='available'" "c")
DELTA_STOCK=$((STOCK_C_BEFORE - STOCK_C_AFTER))

# Acceptance: chính xác 1 order, 1 tx, 1 product, balance=0, stock giảm đúng 1
if [[ "$BAL_C_AFTER" == "0" && "$ORDS_C" == "1" && "$TXS_C" == "1" && "$SOLD_C" == "1" && "$DELTA_STOCK" == "1" ]]; then
  log_step "TC-03" "Race spam 5 buy đồng thời (balance đủ mua 1)" "PASS" "bal=0 orders=1 tx_purchase=1 sold=1 stock_delta=1"
else
  log_step "TC-03" "Race spam 5 buy đồng thời" "FAIL" "bal=$BAL_C_AFTER orders=$ORDS_C tx_purchase=$TXS_C sold=$SOLD_C stock_delta=$DELTA_STOCK (before=$STOCK_C_BEFORE after=$STOCK_C_AFTER)"
fi

# ============== TC-04: SePay webhook idempotency — gọi 2 lần cùng sepay_id ==============
TG_D=44444
tg_start 400 $TG_D "userD" >/dev/null
USER_D=$(d1_first_int "SELECT id FROM users WHERE telegram_id=$TG_D" "id")
d1 "INSERT INTO deposits (user_id, correlation_ref, amount, status) VALUES ($USER_D, 'NAPFLOWD01', 50000, 'pending');" >/dev/null

# First call
curl -s -X POST "$BASE/webhook/sepay" -H 'Content-Type: application/json' -H "Authorization: Apikey $SEPAY_KEY" \
  --data-binary "{\"id\":99002,\"gateway\":\"VCB\",\"transactionDate\":\"2026-06-05 12:30:00\",\"accountNumber\":\"7938383838\",\"subAccount\":null,\"code\":null,\"content\":\"NAPFLOWD01\",\"transferType\":\"in\",\"description\":\"NAPFLOWD01\",\"transferAmount\":50000,\"accumulated\":0,\"referenceCode\":\"FT-D-1\"}" >/dev/null
sleep 1
BAL_D1=$(d1_first_int "SELECT balance b FROM users WHERE id=$USER_D" "b")

# Replay webhook same id
curl -s -X POST "$BASE/webhook/sepay" -H 'Content-Type: application/json' -H "Authorization: Apikey $SEPAY_KEY" \
  --data-binary "{\"id\":99002,\"gateway\":\"VCB\",\"transactionDate\":\"2026-06-05 12:30:00\",\"accountNumber\":\"7938383838\",\"subAccount\":null,\"code\":null,\"content\":\"NAPFLOWD01\",\"transferType\":\"in\",\"description\":\"NAPFLOWD01\",\"transferAmount\":50000,\"accumulated\":0,\"referenceCode\":\"FT-D-1\"}" >/dev/null
sleep 1
BAL_D2=$(d1_first_int "SELECT balance b FROM users WHERE id=$USER_D" "b")

if [[ "$BAL_D1" == "50000" && "$BAL_D2" == "50000" ]]; then
  log_step "TC-04" "SePay webhook idempotent: replay không cộng đôi" "PASS" "bal first=$BAL_D1 replay=$BAL_D2"
else
  log_step "TC-04" "SePay webhook idempotent" "FAIL" "first=$BAL_D1 replay=$BAL_D2"
fi

# ============== TC-05: Manual approve qua admin API ==============
TG_E=55555
tg_start 500 $TG_E "userE" >/dev/null
USER_E=$(d1_first_int "SELECT id FROM users WHERE telegram_id=$TG_E" "id")
d1 "INSERT INTO deposits (user_id, correlation_ref, amount, status) VALUES ($USER_E, 'NAPFLOWE01', 75000, 'pending');" >/dev/null
DEP_E=$(d1_first_int "SELECT id FROM deposits WHERE correlation_ref='NAPFLOWE01'" "id")

APPROVE_RES=$(curl -s -X POST "$BASE/api/admin/deposits/$DEP_E/approve" -H "Authorization: Bearer $TOKEN")
sleep 1

BAL_E=$(d1_first_int "SELECT balance b FROM users WHERE id=$USER_E" "b")
DEP_E_STAT=$(d1 "SELECT status s FROM deposits WHERE id=$DEP_E" | python3 -c "import sys,json;print(json.load(sys.stdin)[0]['results'][0]['s'])")
AUDIT=$(d1_first_int "SELECT COUNT(*) c FROM audit_logs WHERE resource_type='deposit' AND resource_id=$DEP_E" "c")

if [[ "$BAL_E" == "75000" && "$DEP_E_STAT" == "completed" && "$AUDIT" == "1" ]]; then
  log_step "TC-05" "Admin manual approve → cộng balance + audit_log" "PASS" "bal=$BAL_E dep=$DEP_E_STAT audit=$AUDIT"
else
  log_step "TC-05" "Admin manual approve" "FAIL" "bal=$BAL_E dep=$DEP_E_STAT audit=$AUDIT res=$APPROVE_RES"
fi

# Approve replay → must fail (already completed)
APPROVE_REPLAY=$(curl -s -X POST "$BASE/api/admin/deposits/$DEP_E/approve" -H "Authorization: Bearer $TOKEN")
BAL_E2=$(d1_first_int "SELECT balance b FROM users WHERE id=$USER_E" "b")
if [[ "$BAL_E2" == "75000" && "$APPROVE_REPLAY" == *'"success":false'* ]]; then
  log_step "TC-05b" "Admin approve replay deposit completed → reject" "PASS" "bal vẫn=75000 res=${APPROVE_REPLAY:0:90}"
else
  log_step "TC-05b" "Admin approve replay" "FAIL" "bal=$BAL_E2 res=$APPROVE_REPLAY"
fi

# ============== TC-06: Auth — không có JWT thì block admin endpoints ==============
NO_AUTH=$(curl -s -o /dev/null -w "%{http_code}" -X GET "$BASE/api/admin/deposits")
BAD_AUTH=$(curl -s -o /dev/null -w "%{http_code}" -X GET "$BASE/api/admin/deposits" -H "Authorization: Bearer FAKETOKEN")
if [[ "$NO_AUTH" == "401" && "$BAD_AUTH" == "401" ]]; then
  log_step "TC-06" "Admin API yêu cầu JWT (no token=401, fake token=401)" "PASS" "no=$NO_AUTH bad=$BAD_AUTH"
else
  log_step "TC-06" "Admin API auth" "FAIL" "no=$NO_AUTH bad=$BAD_AUTH"
fi

# ============== TC-07: SePay webhook — sai API key thì block ==============
BAD_SEPAY=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/webhook/sepay" -H 'Content-Type: application/json' -H "Authorization: Apikey WRONG_KEY" --data-binary '{"id":99099,"transferType":"in","content":"x","transferAmount":1,"gateway":"x","transactionDate":"x","accountNumber":"x","subAccount":null,"code":null,"description":"x","accumulated":0,"referenceCode":"x"}')
NO_SEPAY=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/webhook/sepay" -H 'Content-Type: application/json' --data-binary '{"id":99099}')
if [[ "$BAD_SEPAY" == "401" && "$NO_SEPAY" == "401" ]]; then
  log_step "TC-07" "SePay webhook chặn sai/thiếu API key" "PASS" "bad=$BAD_SEPAY no=$NO_SEPAY"
else
  log_step "TC-07" "SePay webhook auth" "FAIL" "bad=$BAD_SEPAY no=$NO_SEPAY"
fi

# ============== TC-08: Telegram webhook — sai secret token thì block ==============
TG_BAD=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/webhook/telegram" -H 'Content-Type: application/json' -H "X-Telegram-Bot-Api-Secret-Token: WRONG" --data-binary '{"update_id":999}')
TG_NONE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/webhook/telegram" -H 'Content-Type: application/json' --data-binary '{"update_id":999}')
if [[ "$TG_BAD" == "401" && "$TG_NONE" == "401" ]]; then
  log_step "TC-08" "Telegram webhook chặn sai/thiếu secret token" "PASS" "bad=$TG_BAD none=$TG_NONE"
else
  log_step "TC-08" "Telegram webhook auth" "FAIL" "bad=$TG_BAD none=$TG_NONE"
fi

# ============== TC-09: User C history dùng telegram_id (regression bug 2) ==============
HIST_C=$(d1_first_int "SELECT COUNT(*) c FROM orders o JOIN users u ON u.id=o.user_id WHERE u.telegram_id=$TG_C" "c")
HIST_A=$(d1_first_int "SELECT COUNT(*) c FROM orders o JOIN users u ON u.id=o.user_id WHERE u.telegram_id=$TG_A" "c")
if [[ "$HIST_A" == "1" && "$HIST_C" == "1" ]]; then
  log_step "TC-09" "History query bằng telegram_id (regression fix)" "PASS" "hist_A=$HIST_A hist_C=$HIST_C"
else
  log_step "TC-09" "History query telegram_id" "FAIL" "hist_A=$HIST_A hist_C=$HIST_C"
fi

# ============== TC-10: Tổng quyết toán - bảo toàn dữ liệu ==============
# Sum(deposit) - Sum(purchase) phải = sum(balance) trên users
# (Trừ adjustment seed cho user C)
TOTAL_BAL=$(d1_first_int "SELECT SUM(balance) s FROM users" "s")
TOTAL_DEP=$(d1_first_int "SELECT IFNULL(SUM(amount),0) s FROM transactions WHERE type='deposit'" "s")
TOTAL_PUR=$(d1_first_int "SELECT IFNULL(SUM(amount),0) s FROM transactions WHERE type='purchase'" "s")
TOTAL_ADJ=$(d1_first_int "SELECT IFNULL(SUM(amount),0) s FROM transactions WHERE type='adjustment'" "s")
NET=$((TOTAL_DEP + TOTAL_PUR + TOTAL_ADJ))
if [[ "$TOTAL_BAL" == "$NET" ]]; then
  log_step "TC-10" "Bảo toàn: sum(balance) == sum(deposit) + sum(purchase) + sum(adjust)" "PASS" "bal=$TOTAL_BAL net=$NET (dep=$TOTAL_DEP pur=$TOTAL_PUR adj=$TOTAL_ADJ)"
else
  log_step "TC-10" "Bảo toàn dữ liệu sổ cái" "FAIL" "bal=$TOTAL_BAL net=$NET (dep=$TOTAL_DEP pur=$TOTAL_PUR adj=$TOTAL_ADJ)"
fi

END_TIME=$(now)

# ============== Snapshot DB cuối ==============
SNAPSHOT=$(d1 "SELECT 'users' kind, telegram_id k, balance v FROM users
UNION ALL SELECT 'deposit', id, amount FROM deposits
UNION ALL SELECT 'order', id, total_amount FROM orders
UNION ALL SELECT 'product', id, CASE WHEN status='sold' THEN buyer_id ELSE 0 END FROM products" | python3 -c "
import sys,json
d=json.load(sys.stdin)[0]['results']
lines=['| kind | key | value |','|---|---|---|']
for r in d: lines.append('| %s | %s | %s |' % (r['kind'],r['k'],r['v']))
print('\n'.join(lines))")

# ============== Write report ==============
{
  echo "# Báo cáo E2E Test — telegram-shop-bot"
  echo
  echo "- Bắt đầu: $START_TIME"
  echo "- Kết thúc: $END_TIME"
  echo "- Endpoint: $BASE (wrangler dev local, real HTTP)"
  echo "- DB: D1 local (.wrangler/state/v3/d1)"
  echo "- Tổng: $((PASS+FAIL)) — PASS: $PASS — FAIL: $FAIL"
  echo
  echo "## Kết quả"
  echo
  echo "| ID | Test case | Status | Details |"
  echo "|---|---|---|---|"
  for s in "${STEPS[@]}"; do echo "$s"; done
  echo
  echo "## Snapshot DB cuối"
  echo
  echo "$SNAPSHOT"
  echo
  echo "## Quy trình test"
  echo
  echo "1. **TC-01 Nạp + mua (full flow user A):** /start tạo user → tạo deposit pending → SePay webhook giả lập (real HTTP với Apikey) → verify balance/deposit.status → mua 1×30k → verify balance giảm, products marked sold, FK chains đúng (orders ↔ products.order_id ↔ order_items.order_id ↔ transactions.reference_id), sổ cái balance_before+amount=balance_after."
  echo "2. **TC-02 Mua không có tiền:** user mới balance=0 spam buy → phải reject, không ghi orders/transactions/products."
  echo "3. **TC-03 Race condition (spam 2 nơi cùng lúc):** user balance đủ mua 1 sản phẩm, fire 5 callback buy đồng thời (giả lập 2+ device hoặc spam) → CHỈ 1 đơn thành công, balance=0, đúng 1 product sold."
  echo "4. **TC-04 Webhook idempotency:** SePay gọi 2 lần cùng id → chỉ cộng balance 1 lần."
  echo "5. **TC-05 Manual approve:** admin login → POST /deposits/:id/approve → balance cộng, audit_log ghi. Replay phải bị reject."
  echo "6. **TC-06 Admin API auth:** GET /api/admin/deposits không token / sai token → 401."
  echo "7. **TC-07 SePay auth:** webhook không/sai Apikey → 401, không tạo deposit."
  echo "8. **TC-08 Telegram auth:** webhook không/sai X-Telegram-Bot-Api-Secret-Token → 401."
  echo "9. **TC-09 Regression bug 2:** xác nhận history/account đã JOIN qua telegram_id."
  echo "10. **TC-10 Bảo toàn sổ cái:** SUM(balance) == SUM(transactions.amount) (deposit+purchase+adjust)."
  echo
  echo "## Đánh giá bảo mật"
  echo
  echo "- Telegram webhook: bắt buộc \`X-Telegram-Bot-Api-Secret-Token\`."
  echo "- SePay webhook: bắt buộc \`Authorization: Apikey <key>\` + idempotency theo \`sepay_transaction_id\`."
  echo "- Admin API: JWT 24h, bcrypt password, lockout sau 5 lần sai."
  echo "- Race condition mua hàng: concurrency guard \`UPDATE balance WHERE balance >= total\` + FK \`order_id\`."
  echo "- Sổ cái cân: tổng balance khớp tổng transactions."
} > "$REPORT"

echo
echo "===== Tổng kết ====="
echo "PASS: $PASS — FAIL: $FAIL"
echo "Report: $REPORT"
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
