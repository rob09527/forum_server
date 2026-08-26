import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { sendSuccess } from '../utils/response.js'
import { authenticate } from '../middleware/auth.middleware.js'
import { parseId } from '../utils/parse.js'
import {
  listNotifications,
  unreadCount,
  markRead,
  markAllRead,
} from '../services/notification/notification.service.js'

/**
 * 站内通知路由。
 * 路由只做三件事：校验参数 → 调用 service → 返回响应。
 * 实时推送（SSE）已统一收敛到 realtime.routes.ts 的 /api/me/stream。
 */

/** 通知查询参数（分页） */
interface NotificationQuery {
  page?: number
  pageSize?: number
}

/**
 * 通知列表（需登录）。
 * GET /api/me/notifications?page=1&pageSize=20，按时间倒序。
 */
export async function notificationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/me/notifications', { preHandler: [authenticate] }, async (request, reply) => {
    const query = request.query as NotificationQuery
    const page = query.page ? Number(query.page) : 1
    const pageSize = query.pageSize ? Number(query.pageSize) : 20

    const result = await listNotifications(request.user!.id, page, pageSize)
    sendSuccess(reply, result)
  })

  /** 未读通知数（顶栏红点，轮询/SSE 共用） */
  fastify.get('/api/me/notifications/unread-count', { preHandler: [authenticate] }, async (request, reply) => {
    const count = await unreadCount(request.user!.id)
    sendSuccess(reply, { count })
  })

  /** 单条已读 */
  fastify.post('/api/me/notifications/:id/read', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    await markRead(parseId(id), request.user!.id)
    sendSuccess(reply, null)
  })

  /** 全部已读 */
  fastify.post('/api/me/notifications/read-all', { preHandler: [authenticate] }, async (request, reply) => {
    const result = await markAllRead(request.user!.id)
    sendSuccess(reply, result)
  })
}
