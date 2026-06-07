import { Hono } from 'hono'
import type { AppEnv } from '../types'
// @ts-ignore - Wrangler injects this module for Workers Sites
import manifestJSON from '__STATIC_CONTENT_MANIFEST'

const miniAppStatic = new Hono<AppEnv>()

// Parse manifest once at module level
let manifest: Record<string, string> = {}
try {
  manifest = JSON.parse(manifestJSON)
} catch {
  manifest = {}
}

// MIME types map
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
}

function getContentType(path: string): string {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

function isHashedAsset(path: string): boolean {
  return /[-.][\da-f]{8,}\./i.test(path)
}

/**
 * Serve Mini App static assets từ __STATIC_CONTENT KV namespace.
 * SPA fallback (history mode): mọi route không match asset → trả miniapp/index.html.
 */
miniAppStatic.get('/*', async (c) => {
  const kv = c.env.__STATIC_CONTENT
  if (!kv) {
    return c.text('Mini App not available', 404)
  }

  // c.req.path includes /app prefix (Hono .route() doesn't strip it).
  // Bucket = ./dist nên KV key có prefix miniapp/...
  // /app/ → miniapp/index.html, /app/shop → miniapp/shop, /app/assets/index.js → miniapp/assets/index.js
  let relativePath = c.req.path.replace(/^\/app\/?/, '')
  if (!relativePath) relativePath = 'index.html'
  const assetPath = `miniapp/${relativePath}`

  // Lookup in manifest (maps original filename → hashed filename in KV)
  const kvKey = manifest[assetPath] || assetPath

  // Try to get asset from KV
  let asset = await kv.get(kvKey, 'arrayBuffer')

  // If not found → SPA fallback: serve miniapp/index.html (history mode)
  if (!asset) {
    const indexKey = manifest['miniapp/index.html'] || 'miniapp/index.html'
    asset = await kv.get(indexKey, 'arrayBuffer')

    if (!asset) {
      return c.html(
        '<html><body><h1>Mini App Not Found</h1><p>Build Mini App first: <code>npm run build:miniapp</code></p></body></html>',
        404
      )
    }

    return new Response(asset, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // SPA entry: KHÔNG được cache để Telegram WebView luôn nạp HTML mới (trỏ tới
        // asset hash mới sau mỗi deploy). no-store mạnh hơn no-cache để tránh dùng lại bản cũ.
        'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
      },
    })
  }

  // Asset found → serve with cache headers.
  // QUAN TRỌNG: kiểm tra HTML TRƯỚC. Workers Sites băm tên cả index.html
  // (vd index.<hash>.html) nên isHashedAsset sẽ khớp — nếu xét hash trước thì index.html
  // bị cache `immutable` 1 năm → Telegram giữ bản cũ, phải reload mới thấy UI mới.
  const contentType = getContentType(assetPath)
  const isHtml = contentType.includes('text/html')
  const cacheControl = isHtml
    ? 'no-store, no-cache, must-revalidate, max-age=0'
    : isHashedAsset(kvKey)
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=3600'

  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
  }
  if (isHtml) {
    headers.Pragma = 'no-cache'
    headers.Expires = '0'
  }

  return new Response(asset, { headers })
})

export { miniAppStatic }
