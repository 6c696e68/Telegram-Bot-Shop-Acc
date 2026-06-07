import { createRouter, createWebHistory } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { ApiError } from '@/api/client'

// Views import tĩnh (không lazy) — gộp hết vào một bundle.
import OnboardingView from '@/views/OnboardingView.vue'
import MarketView from '@/views/MarketView.vue'
import ProductDetailView from '@/views/ProductDetailView.vue'
import CheckoutView from '@/views/CheckoutView.vue'
import OrdersView from '@/views/OrdersView.vue'
import OrderDetailView from '@/views/OrderDetailView.vue'
import SupportView from '@/views/SupportView.vue'
import ProfileView from '@/views/ProfileView.vue'
import DepositView from '@/views/DepositView.vue'

// History base '/app/' khớp route serve `/app` trong Worker (SPA fallback miniapp/index.html).
// Tab cấp 1 (meta.tab): Market / Orders / Support / Profile.
const router = createRouter({
  history: createWebHistory('/app/'),
  routes: [
    {
      path: '/onboarding',
      name: 'onboarding',
      component: OnboardingView,
    },
    {
      path: '/',
      name: 'market',
      component: MarketView,
      meta: { tab: true },
    },
    {
      path: '/product/:id',
      name: 'product-detail',
      component: ProductDetailView,
      props: true,
    },
    {
      path: '/checkout/:id',
      name: 'checkout',
      component: CheckoutView,
      props: true,
    },
    {
      path: '/orders',
      name: 'orders',
      component: OrdersView,
      meta: { tab: true },
    },
    {
      path: '/orders/:id',
      name: 'order-detail',
      component: OrderDetailView,
      props: true,
    },
    {
      path: '/support',
      name: 'support',
      component: SupportView,
      meta: { tab: true },
    },
    {
      path: '/profile',
      name: 'profile',
      component: ProfileView,
      meta: { tab: true },
    },
    {
      path: '/deposit',
      name: 'deposit',
      component: DepositView,
    },
    // Bắt mọi path lạ → về Market (tránh trắng màn khi deep-link sai).
    { path: '/:pathMatch(.*)*', redirect: { name: 'market' } },
  ],
})

/**
 * Guard onboarding (R2.1, R2.5): đảm bảo user đã nạp + đã chọn vùng trước khi vào màn chính.
 * Region chưa xác định → ép sang `/onboarding`. Lỗi 401 → cho đi tiếp để UnauthorizedScreen xử lý.
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
    return { name: 'market' }
  }
  return true
})

export default router
