import type { FastifyInstance } from 'fastify'
import { authenticate, optionalAuth } from '../middleware/auth.middleware.js'
import { sendSuccess } from '../utils/response.js'
import { parseId } from '../utils/parse.js'
import { buyDecoration, listShopItems, listMyDecorations, activateDecoration } from '../services/shop/shop.service.js'

/**
 * 装饰商城路由（docs/积分消费体系.md 2.2）。
 * 路由只做三件事：校验参数 → 调用 service → 返回响应。
 */
export async function shopRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/shop/items
   * 商城商品列表（可选登录）。登录时额外返回余额（顶栏 chip）+ 临近到期装饰（到期前小黄点）。
   */
  fastify.get('/api/shop/items', { preHandler: [optionalAuth] }, async (request, reply) => {
    const result = await listShopItems(request.user?.id)
    sendSuccess(reply, result)
  })

  /**
   * GET /api/shop/mine
   * 我的装饰（含已过期，置灰展示 + 一键续费）。
   */
  fastify.get('/api/shop/mine', { preHandler: [authenticate] }, async (request, reply) => {
    const result = await listMyDecorations(request.user!.id)
    sendSuccess(reply, result)
  })

  /**
   * POST /api/shop/items/:id/purchase
   * 购买 / 续费装饰。返回扣款后余额 + 新的到期时间，前端同步顶栏 chip。
   */
  fastify.post('/api/shop/items/:id/purchase', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = await buyDecoration(request.user!.id, parseId(id))
    sendSuccess(reply, result)
  })

  /**
   * POST /api/shop/mine/:id/activate
   * 切换佩戴已持有的装饰（多持有模型）。返回新的到期时间，前端同步 authUser 佩戴槽。
   */
  fastify.post('/api/shop/mine/:id/activate', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = await activateDecoration(request.user!.id, parseId(id))
    sendSuccess(reply, result)
  })
}
