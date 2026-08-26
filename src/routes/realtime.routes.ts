import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth.middleware.js'
import { registerUserConnection, unregisterUserConnection } from '../services/realtime/sse.js'

/**
 * 实时推送路由（SSE 统一单流）。
 *
 * 通知（event: notification）与私信（event: dm）共用一个连接，
 * 由 services/realtime/sse.ts 的单一连接注册表分发，前端在一条流上
 * 用 addEventListener('notification' / 'dm') 分别订阅，避免多流多连接。
 */
export async function realtimeRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * 实时推送（SSE，需登录）。
   * EventSource 同源自动携带 cookie，authenticate 可复用鉴权。
   * 连接保持期间每 30s 发一次心跳注释，避免代理/浏览器判定超时断开。
   */
  fastify.get('/api/me/stream', { preHandler: [authenticate] }, async (request, reply) => {
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
