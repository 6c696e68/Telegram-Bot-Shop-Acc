import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import i18n from './i18n'
import './style.css'

const app = createApp(App)
app.use(router)
app.use(i18n)

// Mount only after the router resolves the initial route.
// This prevents the brief flash of the protected layout before
// the auth guard redirects an unauthenticated user to /login.
router.isReady().then(() => {
  app.mount('#app')
})
