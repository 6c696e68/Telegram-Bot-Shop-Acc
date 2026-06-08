import { Hono } from 'hono'
import type { Bindings } from '../../types'
import type { AdminVariables } from '../../middleware/jwt-auth'
import { jwtAuth } from '../../middleware/jwt-auth'
import { authRoutes } from './auth'
import { usersRoutes } from './users'
import { productTypesRoutes } from './product-types'
import { productRoutes } from './products'
import { orderRoutes } from './orders'
import { transactionRoutes } from './transactions'
import { configRoutes } from './config'
import { depositsRoutes } from './deposits'
import { statsRoutes } from './stats'
import { bannerRoutes } from './banners'
import { payosAdminRoutes } from './payos'

type AdminEnv = {
  Bindings: Bindings
  Variables: AdminVariables
}

// CMS Admin API
const adminApi = new Hono<AdminEnv>()

// Auth routes — login is unprotected, refresh/me are protected via their own middleware
adminApi.route('/auth', authRoutes)

// Protected resource routes (JWT applied within each sub-app)
adminApi.route('/users', usersRoutes)
adminApi.route('/product-types', productTypesRoutes)
adminApi.route('/products', productRoutes)
adminApi.route('/orders', orderRoutes)
adminApi.route('/transactions', transactionRoutes)
adminApi.route('/config', configRoutes)
adminApi.route('/deposits', depositsRoutes)
adminApi.route('/stats', statsRoutes)
adminApi.route('/banners', bannerRoutes)
adminApi.route('/payos', payosAdminRoutes)

// Root endpoint (protected)
adminApi.get('/', jwtAuth, (c) => {
  return c.json({ success: true, data: { message: 'Admin API' }, error: null })
})

export { adminApi }
