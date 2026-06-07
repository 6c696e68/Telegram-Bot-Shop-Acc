import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

// Cấu hình test tối thiểu cho CMS (Vitest + fast-check). Dùng lại alias '@' của vite.config
// để import `@/utils/format` và `@/i18n` như khi build. Môi trường 'node' đủ cho format
// (chỉ dùng toLocaleString + vue-i18n locale), không cần DOM.
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
  },
})
