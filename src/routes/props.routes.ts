import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth.middleware.js'
import { sendSuccess } from '../utils/response.js'
import { makeupCheckin, rename, buyQuota } from '../services/props/props.service.js'

/**
 * 功能道具路由（docs/积分消费体系.md 2.5）。
 * 即用即走，场景内直接消费：补签/改名/扩容，不做「买卡→用卡」两步 [1.4]。
 * 路由只做三件事：校验参数 → 调用 service → 返回响应。
 */
export async function propsRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/checkin/makeup
   * 补签昨天（[R54] 前天已签才可补）。返回扣款后余额，前端同步顶栏 chip。
   */
  fastify.post('/api/checkin/makeup', { preHandler: [authenticate] }, async (request, reply) => {
    const result = await makeupCheckin(request.user!.id)
    sendSuccess(reply, result)
  })

  /**
   * POST /api/me/rename
   * 改名（冷却由 config:props 控制）。Body: { username: string }（3-20 字符，全局唯一）。
   */
  fastify.post('/api/me/rename', {
    preHandler: [authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['username'],
        properties: {
          username: { type: 'string', minLength: 3, maxLength: 20 },
        },
      },
    },
  }, async (request, reply) => {
    const { username } = request.body as { username: string }
    const result = await rename(request.user!.id, username)
    sendSuccess(reply, result)
  })

  /**
   * POST /api/me/quota
   * 上传容量扩容（永久 [1.4.2]）。返回扣款后余额，前端同步顶栏 chip。
   */
  fastify.post('/api/me/quota', { preHandler: [authenticate] }, async (request, reply) => {
    const result = await buyQuota(request.user!.id)
    sendSuccess(reply, result)
  })
}
