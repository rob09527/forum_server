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
import {
  registerUserConnection,
  unregisterUserConnection,
} from '../services/notification/sse.js'

/**
 * 站内通知路由。
 * 路由只做三件事：校验参数 → 调用 service → 返回响应。
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

  /**
   * 通知实时推送（SSE，需登录）。
   * EventSource 同源自动携带 cookie，authenticate 可复用鉴权。
   * 连接保持期间每 30s 发一次心跳注释，避免代理/浏览器判定超时断开。
   */
  fastify.get('/api/me/notifications/stream', { preHandler: [authenticate] }, async (request, reply) => {
    const userId = request.user!.id

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // 禁用 nginx 缓冲，SSE 实时性需要
    })

    // 初始注释行：EventSource 需收到首帧才触发 open 事件
    reply.raw.write(': connected\n\n')

    registerUserConnection(userId, reply)

    // 心跳：每 30s 写注释行保活（SSE 注释行客户端会自动忽略）
    const heartbeat = setInterval(() => {
      if (!reply.raw.writableEnded) {
        reply.raw.write(': ping\n\n')
      }
    }, 30000)

    // 连接关闭时清理注册 + 心跳，避免连接/定时器泄漏
    request.raw.on('close', () => {
      clearInterval(heartbeat)
      unregisterUserConnection(userId, reply)
    })
  })
}
