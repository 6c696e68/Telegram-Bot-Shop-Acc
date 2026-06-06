import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import i18n from './i18n'
import { initTelegram } from './telegram/sdk'
import './style.css'

// Khởi tạo Telegram WebApp SDK trước khi mount (ready/expand/theme/safe-area).
// Bọc try/catch để app vẫn render khi chạy ngoài Telegram (trình duyệt thường, dev).
try {
  initTelegram()
} catch (err) {
  console.error('[MiniApp] Telegram SDK init failed:', err)
}

const app = createApp(App)
app.use(router)
app.use(i18n)

router.isReady().then(() => {
  app.mount('#app')
})
