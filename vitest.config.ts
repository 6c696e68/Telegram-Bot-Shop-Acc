import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Đọc artifact build Mini App (host-side, lúc load config bằng Node) rồi nội suy vào test
// qua Vite `define`. Test chạy trong workerd (@cloudflare/vitest-pool-workers) KHÔNG có
// filesystem thật, nên không thể readFileSync/`?raw` trong test. `define` thay thế token
// `__MINIAPP_INDEX_HTML_B64__` bằng chuỗi literal tại transform-time → smoke test build:miniapp
// (Req 14.2) deterministic, độc lập KV. File chưa build → chuỗi rỗng → test fail có ý nghĩa.
//
// Bắt buộc BASE64: vitest-pool-workers truyền `define` sang worker qua HTTP header (ByteString
// chỉ nhận 0..255). index.html chứa comment tiếng Việt (ký tự > 255, vd U+1EA3) → nhúng thô sẽ
// crash setup. Base64 là ASCII thuần nên truyền an toàn; test decode lại bằng atob + TextDecoder.
const miniappIndexPath = resolve(process.cwd(), 'dist/miniapp/index.html')
const miniappIndexHtml = existsSync(miniappIndexPath) ? readFileSync(miniappIndexPath, 'utf8') : ''
const miniappIndexHtmlB64 = Buffer.from(miniappIndexHtml, 'utf8').toString('base64')

export default defineWorkersConfig({
  define: {
    __MINIAPP_INDEX_HTML_B64__: JSON.stringify(miniappIndexHtmlB64),
  },
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: './wrangler.toml' },
        miniflare: {
          d1Databases: ['DB'],
        },
      },
    },
    include: ['test/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
  },
})
