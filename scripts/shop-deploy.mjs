#!/usr/bin/env node
// =============================================================================
//  Telegram Shop Bot - Full Deploy CLI
//  Chay: npm run shop:deploy
//  Co the dung cac co:
//    --yes / -y        Tu dong dong y moi confirm (non-interactive cho CI)
//    --skip-webhook    Bo qua buoc set Telegram webhook
//    --skip-admin      Bo qua buoc tao admin CMS
//    --skip-migrate    Bo qua migration remote
//  Quy tac: KHONG echo gia tri secret ra log. Khong bia gia tri. Khong emoji.
// =============================================================================

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import readline from 'node:readline'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const WRANGLER_TOML = join(ROOT, 'wrangler.toml')
const DB_NAME = 'telegram-shop-bot-db'

const argv = process.argv.slice(2)
const FLAG = {
  yes: argv.includes('--yes') || argv.includes('-y'),
  skipWebhook: argv.includes('--skip-webhook'),
  skipAdmin: argv.includes('--skip-admin'),
  skipMigrate: argv.includes('--skip-migrate'),
}

// ----------------------------------------------------------------------------
//  Mau sac terminal (tu tat neu khong phai TTY)
// ----------------------------------------------------------------------------
const useColor = process.stdout.isTTY
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)
const C = {
  bold: c('1'), dim: c('2'), red: c('31'), green: c('32'),
  yellow: c('33'), blue: c('34'), cyan: c('36'), gray: c('90'),
}

const TOTAL_STEPS = 8
let stepNo = 0

function banner() {
  const line = '='.repeat(60)
  console.log(C.cyan(line))
  console.log(C.cyan(C.bold('  TELEGRAM SHOP BOT  -  FULL DEPLOY CLI')))
  console.log(C.cyan('  Cloudflare Workers + D1 + Vue CMS + Mini App'))
  console.log(C.cyan(line))
}
function step(title) {
  stepNo += 1
  console.log('')
  console.log(C.blue(C.bold(`[${stepNo}/${TOTAL_STEPS}] ${title}`)))
  console.log(C.gray('-'.repeat(60)))
}
const info = (m) => console.log(`  ${m}`)
const ok = (m) => console.log(`  ${C.green('OK')}  ${m}`)
const skip = (m) => console.log(`  ${C.gray('--')}  ${m}`)
const warn = (m) => console.log(`  ${C.yellow('!')}   ${m}`)
function fail(m) {
  console.log('')
  console.log(C.red(C.bold(`  Loi: ${m}`)))
  rl.close()
  process.exit(1)
}

// ----------------------------------------------------------------------------
//  Readline + prompt helpers (co masked input cho secret)
// ----------------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

function ask(q) {
  return new Promise((res) => rl.question(C.cyan('  ? ') + q, (a) => res(a.trim())))
}

// Nhap an (masked) - khong hien ky tu ra terminal.
function askSecret(q) {
  return new Promise((res) => {
    const prompt = C.cyan('  ? ') + q
    let muted = false
    rl._writeToOutput = function (str) {
      if (!muted) { rl.output.write(str) } // chi ghi luc in cau hoi
    }
    rl.question(prompt, (a) => {
      rl._writeToOutput = (str) => rl.output.write(str) // khoi phuc
      rl.output.write('\n')
      res(a.trim())
    })
    muted = true
  })
}

async function confirm(q, def = false) {
  if (FLAG.yes) return true
  const hint = def ? '[Y/n]' : '[y/N]'
  const a = await ask(`${q} ${C.gray(hint)}: `)
  if (!a) return def
  return /^y(es)?$/i.test(a)
}

// ----------------------------------------------------------------------------
//  Chay lenh
// ----------------------------------------------------------------------------
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    console.log(C.gray(`  $ ${cmd} ${args.join(' ')}`))
    const child = spawn(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false, ...opts })
    child.on('close', (code) => resolve(code ?? 0))
  })
}
function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts })
  return { code: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' }
}

// ----------------------------------------------------------------------------
//  Dinh nghia secrets + validate
// ----------------------------------------------------------------------------
const SECRETS = [
  { name: 'BOT_TOKEN', desc: 'Telegram bot token (@BotFather)', validate: (v) => /^\d+:[\w-]+$/.test(v) || 'Sai dinh dang token (so:chuoi)' },
  { name: 'TELEGRAM_SECRET_TOKEN', desc: 'Secret xac thuc webhook Telegram (1-256 ky tu A-Z a-z 0-9 _ -)' },
  { name: 'JWT_SECRET', desc: 'JWT secret cho CMS', validate: (v) => v.length >= 32 || 'Can it nhat 32 ky tu' },
  { name: 'ADMIN_IDS', desc: 'Telegram_id admin, cach nhau dau phay', validate: (v) => /^\d+(,\d+)*$/.test(v) || 'Chi gom so, cach nhau dau phay' },
  { name: 'SEPAY_API_KEY', desc: 'API key webhook SePay' },
  { name: 'BANK_NAME', desc: 'Ten ngan hang (vd Vietcombank)' },
  { name: 'BANK_ACCOUNT', desc: 'So tai khoan nhan tien', validate: (v) => /^\d{6,20}$/.test(v) || 'STK chi gom so (6-20 chu so)' },
  { name: 'BANK_OWNER', desc: 'Ten chu tai khoan' },
  { name: 'CRYPTO_PAY_API_TOKEN', desc: 'Token Crypto Pay (tuy chon)' },
]

// Luu tam BOT_TOKEN / TELEGRAM_SECRET_TOKEN nguoi dung vua nhap de tai su dung o buoc webhook.
const session = {}

// ----------------------------------------------------------------------------
//  Buoc 1: dependencies
// ----------------------------------------------------------------------------
async function ensureDeps() {
  step('Kiem tra & cai dependencies')
  const targets = [
    { label: 'root', dir: ROOT, args: ['install'] },
    { label: 'cms', dir: join(ROOT, 'cms'), args: ['install', '--prefix', 'cms'] },
  ]
  if (existsSync(join(ROOT, 'miniapp', 'package.json'))) {
    targets.push({ label: 'miniapp', dir: join(ROOT, 'miniapp'), args: ['install', '--prefix', 'miniapp'] })
  }
  for (const t of targets) {
    if (existsSync(join(t.dir, 'node_modules'))) { ok(`${t.label}: node_modules da co`); continue }
    info(`${t.label}: dang cai...`)
    if (await run('npm', t.args) !== 0) fail(`npm install (${t.label}) that bai`)
    ok(`${t.label}: cai xong`)
  }
}

// ----------------------------------------------------------------------------
//  Buoc 2: D1 database
// ----------------------------------------------------------------------------
async function ensureDatabase() {
  step('Kiem tra D1 database')
  let toml = readFileSync(WRANGLER_TOML, 'utf8')
  const m = toml.match(/database_id\s*=\s*"([^"]*)"/)
  const current = m ? m[1] : ''
  const isPlaceholder = !current || /placeholder|your[-_]?id|xxxx/i.test(current)
  if (!isPlaceholder) { ok(`database_id da cau hinh: ${current}`); return }
  warn(`database_id con trong/placeholder ("${current}")`)
  if (!(await confirm(`Tao moi D1 "${DB_NAME}"?`, true))) {
    fail('Can database_id hop le trong wrangler.toml truoc khi deploy.')
  }
  const r = capture('npx', ['wrangler', 'd1', 'create', DB_NAME])
  process.stdout.write(r.stdout); if (r.stderr) process.stderr.write(r.stderr)
  const found = (r.stdout + r.stderr).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
  if (!found) fail('Khong lay duoc database_id moi. Dan thu cong vao wrangler.toml roi chay lai.')
  toml = toml.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${found[0]}"`)
  writeFileSync(WRANGLER_TOML, toml)
  ok(`Da ghi database_id = "${found[0]}" vao wrangler.toml`)
}

// ----------------------------------------------------------------------------
//  Buoc 3: secrets
// ----------------------------------------------------------------------------
function listRemoteSecrets() {
  const r = capture('npx', ['wrangler', 'secret', 'list'])
  if (r.code !== 0) return null
  try { return new Set(JSON.parse(r.stdout.slice(r.stdout.indexOf('['))).map((s) => s.name)) }
  catch { return null }
}
function putSecret(name, value) {
  const r = spawnSync('npx', ['wrangler', 'secret', 'put', name], {
    cwd: ROOT, input: value, encoding: 'utf8', stdio: ['pipe', 'inherit', 'inherit'],
  })
  return (r.status ?? 1) === 0
}
async function promptSecretValue(s) {
  while (true) {
    const val = await askSecret(`${C.bold(s.name)} - ${s.desc}\n      (Enter de bo trong): `)
    if (!val) return ''
    if (s.validate) {
      const res = s.validate(val)
      if (res !== true) { warn(typeof res === 'string' ? res : 'Gia tri khong hop le'); continue }
    }
    return val
  }
}
async function ensureSecrets() {
  step('Config secrets production')
  const existing = listRemoteSecrets()
  if (existing === null) warn('Khong doc duoc danh sach secret remote (co the chua login wrangler). Se hoi tat ca.')
  else info(`Secret da co tren remote: ${existing.size ? [...existing].join(', ') : '(chua co)'}`)
  console.log('')
  for (const s of SECRETS) {
    const has = existing && existing.has(s.name)
    if (has) {
      if (!(await confirm(`${s.name} da co. Cap nhat lai?`, false))) { skip(`${s.name}: giu nguyen`); continue }
    }
    const val = await promptSecretValue(s)
    if (!val) { skip(`${s.name}: bo trong`); continue }
    if (s.name === 'BOT_TOKEN') session.botToken = val
    if (s.name === 'TELEGRAM_SECRET_TOKEN') session.tgSecret = val
    if (putSecret(s.name, val)) ok(`Da set secret ${s.name}`)
    else warn(`Set secret ${s.name} that bai`)
  }
}

// ----------------------------------------------------------------------------
//  Buoc 4: migration remote
// ----------------------------------------------------------------------------
async function migrateRemote() {
  step('Apply migration D1 PRODUCTION')
  if (FLAG.skipMigrate) { skip('--skip-migrate'); return }
  if (!(await confirm('Ap dung migration vao D1 production?', true))) { skip('Bo qua migration'); return }
  if (await run('npx', ['wrangler', 'd1', 'migrations', 'apply', DB_NAME, '--remote']) !== 0) {
    fail('Migration remote that bai')
  }
  ok('Migration xong')
}

// ----------------------------------------------------------------------------
//  Buoc 5: build
// ----------------------------------------------------------------------------
async function buildAll() {
  step('Build CMS + Mini App')
  if (await run('npm', ['run', 'build:all']) !== 0) fail('Build that bai')
  ok('Build xong')
}

// ----------------------------------------------------------------------------
//  Buoc 6: deploy
// ----------------------------------------------------------------------------
async function deploy() {
  step('Deploy Worker len Cloudflare')
  const r = capture('npx', ['wrangler', 'deploy'])
  process.stdout.write(r.stdout); if (r.stderr) process.stderr.write(r.stderr)
  if (r.code !== 0) fail('Deploy that bai')
  const out = r.stdout + r.stderr
  const url = (out.match(/https:\/\/[^\s]+\.workers\.dev/) || [])[0] || ''
  const version = (out.match(/Current Version ID:\s*([0-9a-f-]+)/i) || [])[1] || ''
  ok('Deploy thanh cong')
  return { url, version }
}

// ----------------------------------------------------------------------------
//  Buoc 7: tao admin CMS
// ----------------------------------------------------------------------------
async function ensureAdmin() {
  step('Tao admin CMS (admin_users)')
  if (FLAG.skipAdmin) { skip('--skip-admin'); return }
  if (!(await confirm('Tao tai khoan admin CMS tren D1 production?', false))) { skip('Bo qua tao admin'); return }
  const username = await ask('Username admin: ')
  if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) { warn('Username khong hop le (3-32, chu/so/_). Bo qua.'); return }
  const exists = capture('npx', ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--json',
    '--command', `SELECT COUNT(*) AS n FROM admin_users WHERE username='${username}'`])
  if (exists.code === 0 && /"n":\s*[1-9]/.test(exists.stdout)) {
    skip(`Admin "${username}" da ton tai`); return
  }
  const password = await askSecret('Password admin: ')
  if (!password || password.length < 6) { warn('Password qua ngan (>= 6). Bo qua.'); return }
  let hash
  try {
    const bcrypt = (await import('bcryptjs')).default
    hash = await bcrypt.hash(password, 10)
  } catch (e) { warn('Khong load duoc bcryptjs. Bo qua tao admin.'); return }
  const display = (await ask('Ten hien thi (Enter = Admin): ')) || 'Admin'
  const safeDisplay = display.replace(/'/g, "''")
  const sql = `INSERT INTO admin_users (username, password_hash, display_name) VALUES ('${username}', '${hash}', '${safeDisplay}')`
  const ins = capture('npx', ['wrangler', 'd1', 'execute', DB_NAME, '--remote', '--command', sql])
  process.stdout.write(ins.stdout); if (ins.stderr) process.stderr.write(ins.stderr)
  if (ins.code === 0) ok(`Da tao admin "${username}"`)
  else warn('Tao admin that bai (kiem tra log tren)')
}

// ----------------------------------------------------------------------------
//  Buoc 8: webhook
// ----------------------------------------------------------------------------
async function setupWebhook(workerUrl) {
  step('Cau hinh Telegram webhook')
  if (FLAG.skipWebhook) { skip('--skip-webhook'); return }
  if (!(await confirm('Set lai Telegram webhook bay gio?', true))) { skip('Bo qua webhook'); return }
  let url = workerUrl
  if (!url) url = await ask('Worker URL (vd https://telegram-shop-bot.xxx.workers.dev): ')
  if (!url) { warn('Khong co URL, bo qua webhook'); return }
  url = url.replace(/\/$/, '')

  const token = session.botToken || await askSecret('BOT_TOKEN (dung tam de goi setWebhook, khong luu): ')
  if (!token) { warn('Khong co BOT_TOKEN, bo qua webhook'); return }
  let secret = session.tgSecret
  if (secret === undefined) secret = await askSecret('TELEGRAM_SECRET_TOKEN (Enter neu khong dung): ')

  const body = { url: `${url}/webhook/telegram` }
  if (secret) body.secret_token = secret
  const code = await run('curl', [
    '-sS', '-X', 'POST', `https://api.telegram.org/bot${token}/setWebhook`,
    '-H', 'Content-Type: application/json', '-d', JSON.stringify(body),
  ])
  console.log('')
  if (code !== 0) warn('Goi setWebhook that bai')
  else ok('Da goi setWebhook')
  info(`SePay webhook (cau hinh thu cong tai my.sepay.vn): ${url}/webhook/sepay`)
}

// ----------------------------------------------------------------------------
//  Main
// ----------------------------------------------------------------------------
async function main() {
  banner()
  console.log('')
  console.log(C.yellow('  Day la thao tac PRODUCTION (deploy len Cloudflare).'))
  if (!(await confirm('Tiep tuc?', false))) { rl.close(); console.log(C.gray('\n  Da huy.')); return }

  await ensureDeps()
  await ensureDatabase()
  await ensureSecrets()
  await migrateRemote()
  await buildAll()
  const { url, version } = await deploy()
  await ensureAdmin()
  await setupWebhook(url)

  rl.close()
  const line = '='.repeat(60)
  console.log('')
  console.log(C.green(line))
  console.log(C.green(C.bold('  HOAN TAT DEPLOY')))
  console.log(C.green(line))
  info(`Worker URL : ${url || C.gray('(xem log deploy o tren)')}`)
  info(`Version ID : ${version || C.gray('(xem log deploy o tren)')}`)
  if (url) info(`CMS        : ${url.replace(/\/$/, '')}/cms/`)
  if (url) info(`Mini App   : ${url.replace(/\/$/, '')}/miniapp/`)
  console.log('')
}

main().catch((e) => fail(e?.stack || String(e)))
