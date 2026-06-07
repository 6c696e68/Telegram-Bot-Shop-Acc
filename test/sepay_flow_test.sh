#!/usr/bin/env bash
# Test tập trung flow nạp tiền qua webhook SePay (mô phỏng đúng payload production).
# Yêu cầu: Worker local đang chạy ở http://127.0.0.1:8787 (npm run dev) + D1 local đã migrate.
# Mỗi case in [PASS]/[FAIL] ngay khi xong (realtime), flush từng dòng.

set -u
set -o pipefail

BASE="http://127.0.0.1:8787"
# Khớp SEPAY_API_KEY trong .dev.vars
SEPAY_KEY="set-later"

# telegram_id riêng cho test, tránh đụng dữ liệu thật
TG_ID=9911001

PASS=0
FAIL=0

ok()   { echo "[PASS] $1 :: $2"; PASS=$((PASS+1)); }
bad()  { echo "[FAIL] $1 :: $2"; FAIL=$((FAIL+1)); }

d1() { npx wrangler d1 execute DB --local --command "$1" --json 2>/dev/null; }

d1_val() {
  # d1_val "<sql>" "<col>"  -> in giá trị cột đầu tiên (rỗng nếu không có)
  d1 "$1" | python3 -c "import sys,json;d=json.load(sys.stdin);r=d[0]['results'];print(r[0]['$2'] if r else '')"
}

# Bắn webhook SePay. args: id transferType content amount [authKey]
sepay() {
  local id="$1" ttype="$2" content="$3" amount="$4" key="${5:-$SEPAY_KEY}"
  curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/webhook/sepay" \
    -H 'Content-Type: application/json' \
    -H "Authorization: Apikey $key" \
    --data-binary "{\"id\":$id,\"gateway\":\"VCB\",\"transactionDate\":\"2026-06-06 10:00:00\",\"accountNumber\":\"123456789\",\"subAccount\":null,\"code\":null,\"content\":\"$content\",\"transferType\":\"$ttype\",\"description\":\"$content\",\"transferAmount\":$amount,\"accumulated\":0,\"referenceCode\":\"FT-$id\"}"
}

# Seed 1 deposit pending, optional tuổi (phút) qua created_at. args: code amount [ageMinutes]
seed_deposit() {
  local code="$1" amount="$2" age="${3:-0}"
  if [[ "$age" -gt 0 ]]; then
    d1 "INSERT INTO deposits (user_id, transfer_code, amount, status, created_at) VALUES ($USER_ID, '$code', $amount, 'pending', datetime('now','-$age minutes'))" >/dev/null
  else
    d1 "INSERT INTO deposits (user_id, transfer_code, amount, status) VALUES ($USER_ID, '$code', $amount, 'pending')" >/dev/null
  fi
}

dep_status() { d1_val "SELECT status s FROM deposits WHERE transfer_code='$1'" "s"; }
balance()    { d1_val "SELECT balance b FROM users WHERE id=$USER_ID" "b"; }

echo "===== SePay flow test bắt đầu ====="

# Sanity: server up
HEALTH=$(curl -s "$BASE/health" || true)
if [[ "$HEALTH" != *"ok"* ]]; then
  echo "[FAIL] SETUP :: Worker chưa chạy ở $BASE (chạy 'npm run dev' trước)"
  exit 1
fi
echo "[PASS] SETUP :: Worker đang chạy ($BASE)"

# Dọn dữ liệu test cũ của telegram_id này (theo thứ tự FK)
OLD_ID=$(d1_val "SELECT id FROM users WHERE telegram_id=$TG_ID" "id")
if [[ -n "$OLD_ID" ]]; then
  d1 "DELETE FROM transactions WHERE user_id=$OLD_ID" >/dev/null
  d1 "DELETE FROM deposits WHERE user_id=$OLD_ID" >/dev/null
  d1 "DELETE FROM users WHERE id=$OLD_ID" >/dev/null
fi

# Tạo user test balance=0
d1 "INSERT INTO users (telegram_id, username, first_name, balance) VALUES ($TG_ID, 'sepaytest', 'SePayTest', 0)" >/dev/null
USER_ID=$(d1_val "SELECT id FROM users WHERE telegram_id=$TG_ID" "id")
if [[ -z "$USER_ID" ]]; then
  echo "[FAIL] SETUP :: Không tạo được user test"
  exit 1
fi
echo "[PASS] SETUP :: user test id=$USER_ID balance=0"

# ---- TC-S01: Happy path — tiền vào khớp mã -> cộng đúng + deposit completed ----
seed_deposit "NAPSEP01" 100000
B0=$(balance)
CODE=$(sepay 70001 in "Chuyen tien NAPSEP01 nap acc" 100000)
sleep 1
B1=$(balance); ST=$(dep_status "NAPSEP01")
TXN=$(d1_val "SELECT COUNT(*) c FROM transactions WHERE user_id=$USER_ID AND type='deposit'" "c")
if [[ "$CODE" == "200" && "$B1" == "100000" && "$ST" == "completed" && "$TXN" == "1" ]]; then
  ok "TC-S01 Nap khop ma -> cong tien" "http=$CODE balance $B0->$B1 deposit=$ST tx=$TXN"
else
  bad "TC-S01 Nap khop ma -> cong tien" "http=$CODE balance $B0->$B1 deposit=$ST tx=$TXN (expect 200/100000/completed/1)"
fi

# ---- TC-S02: Idempotency — replay cùng sepay id -> KHÔNG cộng đôi ----
CODE=$(sepay 70001 in "Chuyen tien NAPSEP01 nap acc" 100000)
sleep 1
B2=$(balance)
TXN2=$(d1_val "SELECT COUNT(*) c FROM transactions WHERE user_id=$USER_ID AND type='deposit'" "c")
if [[ "$CODE" == "200" && "$B2" == "100000" && "$TXN2" == "1" ]]; then
  ok "TC-S02 Idempotency replay id=70001" "http=$CODE balance van=$B2 tx=$TXN2"
else
  bad "TC-S02 Idempotency replay id=70001" "http=$CODE balance=$B2 tx=$TXN2 (expect 200/100000/1)"
fi

# ---- TC-S03: Nội dung không có mã NAP... -> bỏ qua, không cộng ----
B_BEFORE=$(balance)
CODE=$(sepay 70003 in "Khong co ma chuyen khoan hop le" 50000)
sleep 1
B_AFTER=$(balance)
if [[ "$CODE" == "200" && "$B_AFTER" == "$B_BEFORE" ]]; then
  ok "TC-S03 Content khong co ma NAP -> bo qua" "http=$CODE balance giu nguyen=$B_AFTER"
else
  bad "TC-S03 Content khong co ma NAP -> bo qua" "http=$CODE balance $B_BEFORE->$B_AFTER (expect khong doi)"
fi

# ---- TC-S04: transferType=out -> bỏ qua ----
seed_deposit "NAPSEP04" 80000
B_BEFORE=$(balance)
CODE=$(sepay 70004 out "NAPSEP04 tien ra" 80000)
sleep 1
B_AFTER=$(balance); ST=$(dep_status "NAPSEP04")
if [[ "$CODE" == "200" && "$B_AFTER" == "$B_BEFORE" && "$ST" == "pending" ]]; then
  ok "TC-S04 transferType=out -> bo qua" "http=$CODE balance=$B_AFTER deposit van=$ST"
else
  bad "TC-S04 transferType=out -> bo qua" "http=$CODE balance $B_BEFORE->$B_AFTER deposit=$ST (expect pending, khong cong)"
fi

# ---- TC-S05: Số tiền dưới ngưỡng tối thiểu (20k) -> không cộng ----
seed_deposit "NAPSEP05" 10000
B_BEFORE=$(balance)
CODE=$(sepay 70005 in "NAPSEP05 nap it" 10000)
sleep 1
B_AFTER=$(balance); ST=$(dep_status "NAPSEP05")
if [[ "$CODE" == "200" && "$B_AFTER" == "$B_BEFORE" && "$ST" == "pending" ]]; then
  ok "TC-S05 Amount < 20k -> tu choi cong" "http=$CODE balance=$B_AFTER deposit van=$ST"
else
  bad "TC-S05 Amount < 20k -> tu choi cong" "http=$CODE balance $B_BEFORE->$B_AFTER deposit=$ST (expect khong cong)"
fi

# ---- TC-S06: Số tiền vượt trần (>100tr) -> không cộng ----
seed_deposit "NAPSEP06" 100000
B_BEFORE=$(balance)
CODE=$(sepay 70006 in "NAPSEP06 nap qua nhieu" 200000000)
sleep 1
B_AFTER=$(balance); ST=$(dep_status "NAPSEP06")
if [[ "$CODE" == "200" && "$B_AFTER" == "$B_BEFORE" && "$ST" == "pending" ]]; then
  ok "TC-S06 Amount > 100tr -> tu choi cong" "http=$CODE balance=$B_AFTER deposit van=$ST"
else
  bad "TC-S06 Amount > 100tr -> tu choi cong" "http=$CODE balance $B_BEFORE->$B_AFTER deposit=$ST (expect khong cong)"
fi

# ---- TC-S07: Deposit hết hạn TTL (>15 phút) -> không cộng (cron se chuyen expired) ----
seed_deposit "NAPSEP07" 60000 20
B_BEFORE=$(balance)
CODE=$(sepay 70007 in "NAPSEP07 nap tre" 60000)
sleep 1
B_AFTER=$(balance); ST=$(dep_status "NAPSEP07")
if [[ "$CODE" == "200" && "$B_AFTER" == "$B_BEFORE" && "$ST" == "pending" ]]; then
  ok "TC-S07 Deposit qua 15p -> bo qua cong tien" "http=$CODE balance=$B_AFTER deposit=$ST (chua cong, cho cron expire)"
else
  bad "TC-S07 Deposit qua 15p -> bo qua cong tien" "http=$CODE balance $B_BEFORE->$B_AFTER deposit=$ST (expect khong cong)"
fi

# ---- TC-S08: Sai API key -> 401, không cộng ----
seed_deposit "NAPSEP08" 50000
B_BEFORE=$(balance)
CODE=$(sepay 70008 in "NAPSEP08 sai key" 50000 "WRONG_KEY")
sleep 1
B_AFTER=$(balance); ST=$(dep_status "NAPSEP08")
if [[ "$CODE" == "401" && "$B_AFTER" == "$B_BEFORE" && "$ST" == "pending" ]]; then
  ok "TC-S08 Sai API key -> 401" "http=$CODE balance=$B_AFTER deposit van=$ST"
else
  bad "TC-S08 Sai API key -> 401" "http=$CODE balance $B_BEFORE->$B_AFTER deposit=$ST (expect 401, khong cong)"
fi

# ---- TC-S09: Thiếu Authorization header -> 401 ----
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/webhook/sepay" \
  -H 'Content-Type: application/json' \
  --data-binary '{"id":70009,"transferType":"in","content":"x","transferAmount":50000,"gateway":"x","transactionDate":"x","accountNumber":"x","subAccount":null,"code":null,"description":"x","accumulated":0,"referenceCode":"x"}')
if [[ "$CODE" == "401" ]]; then
  ok "TC-S09 Thieu Authorization -> 401" "http=$CODE"
else
  bad "TC-S09 Thieu Authorization -> 401" "http=$CODE (expect 401)"
fi

# ---- TC-S12: Mã nằm ở field `code` (SePay tu nhan dien), content KHONG co ma ----
seed_deposit "NAPSEP12" 80000
B_BEFORE=$(balance)
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/webhook/sepay" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Apikey $SEPAY_KEY" \
  --data-binary "{\"id\":70012,\"gateway\":\"VCB\",\"transactionDate\":\"2026-06-06 10:00:00\",\"accountNumber\":\"123456789\",\"subAccount\":null,\"code\":\"NAPSEP12\",\"content\":\"thanh toan don hang khong co ma\",\"transferType\":\"in\",\"description\":\"x\",\"transferAmount\":80000,\"accumulated\":0,\"referenceCode\":\"FT-70012\"}")
sleep 1
B_AFTER=$(balance); ST=$(dep_status "NAPSEP12")
EXPECTED=$((B_BEFORE + 80000))
if [[ "$CODE" == "200" && "$B_AFTER" == "$EXPECTED" && "$ST" == "completed" ]]; then
  ok "TC-S12 Ma o field code -> cong tien" "http=$CODE balance $B_BEFORE->$B_AFTER deposit=$ST"
else
  bad "TC-S12 Ma o field code -> cong tien" "http=$CODE balance $B_BEFORE->$B_AFTER deposit=$ST (expect 200/+80000/completed)"
fi

# ---- TC-S13: Han muc lay tu system_config (min/max), khong hardcode ----
# Set khoang tam 26000..40000 de kiem chung webhook ap dung config.
d1 "UPDATE system_config SET value='26000' WHERE key='min_deposit'" >/dev/null
d1 "UPDATE system_config SET value='40000' WHERE key='max_deposit'" >/dev/null

# 13a: 25000 < min(26000) -> tu choi
seed_deposit "NAPSEP13A" 25000
B_BEFORE=$(balance)
CODE=$(sepay 70013 in "NAPSEP13A duoi min config" 25000)
sleep 1
B_AFTER=$(balance); ST=$(dep_status "NAPSEP13A")
if [[ "$CODE" == "200" && "$B_AFTER" == "$B_BEFORE" && "$ST" == "pending" ]]; then
  ok "TC-S13a Config min=30k: 25k bi tu choi" "http=$CODE balance giu=$B_AFTER deposit van=$ST"
else
  bad "TC-S13a Config min=30k: 25k bi tu choi" "http=$CODE balance $B_BEFORE->$B_AFTER deposit=$ST (expect khong cong)"
fi

# 13b: 35000 trong [26000,40000] -> cong tien
seed_deposit "NAPSEP13B" 35000
B_BEFORE=$(balance)
CODE=$(sepay 70014 in "NAPSEP13B trong khoang config" 35000)
sleep 1
B_AFTER=$(balance); ST=$(dep_status "NAPSEP13B")
EXPECTED=$((B_BEFORE + 35000))
if [[ "$CODE" == "200" && "$B_AFTER" == "$EXPECTED" && "$ST" == "completed" ]]; then
  ok "TC-S13b Config [30k,40k]: 35k duoc cong" "http=$CODE balance $B_BEFORE->$B_AFTER deposit=$ST"
else
  bad "TC-S13b Config [30k,40k]: 35k duoc cong" "http=$CODE balance $B_BEFORE->$B_AFTER deposit=$ST (expect 200/+35000/completed)"
fi

# Khôi phục hạn mức mặc định
d1 "UPDATE system_config SET value='20000' WHERE key='min_deposit'" >/dev/null
d1 "UPDATE system_config SET value='100000000' WHERE key='max_deposit'" >/dev/null

# ---- TC-S10: Key lấy từ system_config (CMS) — set key DB rồi xác thực bằng key đó ----
CMS_KEY="cms-sepay-key-$RANDOM"
d1 "INSERT INTO system_config (key, value, updated_at) VALUES ('sepay_api_key', '$CMS_KEY', datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value" >/dev/null
seed_deposit "NAPSEP10" 90000
B_BEFORE=$(balance)
CODE=$(sepay 70010 in "NAPSEP10 nap qua key CMS" 90000 "$CMS_KEY")
sleep 1
B_AFTER=$(balance); ST=$(dep_status "NAPSEP10")
EXPECTED=$((B_BEFORE + 90000))
if [[ "$CODE" == "200" && "$B_AFTER" == "$EXPECTED" && "$ST" == "completed" ]]; then
  ok "TC-S10 Key tu system_config (CMS) -> xac thuc OK" "http=$CODE balance $B_BEFORE->$B_AFTER deposit=$ST"
else
  bad "TC-S10 Key tu system_config (CMS) -> xac thuc OK" "http=$CODE balance $B_BEFORE->$B_AFTER deposit=$ST (expect 200/+90000/completed)"
fi

# ---- TC-S11: DB-first — khi DB co key, key env cu ('set-later') bi tu choi ----
seed_deposit "NAPSEP11" 50000
B_BEFORE=$(balance)
CODE=$(sepay 70011 in "NAPSEP11 dung key env cu" 50000 "set-later")
sleep 1
B_AFTER=$(balance); ST=$(dep_status "NAPSEP11")
if [[ "$CODE" == "401" && "$B_AFTER" == "$B_BEFORE" && "$ST" == "pending" ]]; then
  ok "TC-S11 DB-first: key env cu bi tu choi khi DB da set" "http=$CODE balance giu=$B_AFTER deposit van=$ST"
else
  bad "TC-S11 DB-first: key env cu bi tu choi khi DB da set" "http=$CODE balance $B_BEFORE->$B_AFTER deposit=$ST (expect 401, khong cong)"
fi

# Khôi phục: trả sepay_api_key về rỗng (local quay lại fallback env)
d1 "UPDATE system_config SET value='' WHERE key='sepay_api_key'" >/dev/null

echo "===== Tong ket: PASS=$PASS FAIL=$FAIL ====="
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)
