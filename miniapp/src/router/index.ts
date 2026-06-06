import { createRouter, createWebHistory } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { ApiError } from '@/api/client'

// History base '/app/' khớp route serve `/app` trong Worker (SPA fallback miniapp/index.html).
// Views nạp lazy (dynamic import).
const router = createRouter({
  history: createWebHistory('/app/'),
  routes: [
    {
      path: '/onboarding',
      name: 'onboarding',
      component: () => import('@/views/OnboardingView.vue'),
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/views/SettingsView.vue'),
    },
    {
      path: '/',
      name: 'home',
      component: () => import('@/views/HomeView.vue'),
    },
    {
      path: '/shop',
      name: 'shop',
      component: () => import('@/views/ShopView.vue'),
    },
    {
      path: '/shop/:id',
      name: 'product-detail',
      component: () => import('@/views/ProductDetailView.vue'),
      props: true,
    },
    {
      path: '/deposit',
      name: 'deposit',
      component: () => import('@/views/DepositView.vue'),
    },
    {
      path: '/history',
      name: 'history',
      component: () => import('@/views/HistoryView.vue'),
    },
    {
      path: '/history/:id',
      name: 'order-detail',
      component: () => import('@/views/OrderDetailView.vue'),
      props: true,
    },
    {
      path: '/account',
      name: 'account',
      component: () => import('@/views/AccountView.vue'),
    },
  ],
})

/**
 * Guard onboarding (R2.1, R2.5): đảm bảo user đã nạp + đã chọn vùng trước khi vào các
 * màn hình chính. Region chưa xác định → ép sang `/onboarding`. Lỗi 401 (initData) →
 * cho đi tiếp để UnauthorizedScreen xử lý; không chặn `onboarding` để tránh vòng lặp.
 */
router.beforeEach(async (to) => {
  const user = useUserStore()
  if (!user.state.loaded) {
    try {
      await user.fetchMe()
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return true
      return true
    }
  }
  if (user.state.region === null && to.name !== 'onboarding') {
    return { name: 'onboarding' }
  }
  if (user.state.region !== null && to.name === 'onboarding') {
    return { name: 'home' }
  }
  return true
})

export default router
