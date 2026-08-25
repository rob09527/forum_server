import type { FastifyInstance } from 'fastify'
import { authenticate, optionalAuth } from '../middleware/auth.middleware.js'
import { sendSuccess } from '../utils/response.js'
import { parseId } from '../utils/parse.js'
import { tipTarget, listTips, TIP_MESSAGE_MAX_LENGTH } from '../services/tip/tip.service.js'

/**
 * 打赏路由（docs/积分消费体系.md 2.3）。
 * 路由只做三件事：校验参数 → 调用 service → 返回响应。
 */
export async function tipRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /api/posts/:id/tips — 帖子打赏列表（公开） */
  fastify.get('/api/posts/:id/tips', { preHandler: [optionalAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const query = request.query as { limit?: number }
    const result = await listTips('post', parseId(id), query.limit ? Number(query.limit) : 50)
    sendSuccess(reply, result)
  })

  /** GET /api/comments/:id/tips — 评论打赏列表（公开） */
  fastify.get('/api/comments/:id/tips', { preHandler: [optionalAuth] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const query = request.query as { limit?: number }
    const result = await listTips('comment', parseId(id), query.limit ? Number(query.limit) : 50)
    sendSuccess(reply, result)
  })

  /**
   * POST /api/tips — 打赏帖子/评论
   * Body: { targetType: 'post'|'comment', targetId, amount, message? }
   * 金额区间校验在 service 内走 config:tip（避免路由与配置两处定义），
   * 这里用范围 schema 做第一道粗校验防异常大单。
   */
  fastify.post('/api/tips', {
    preHandler: [authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['targetType', 'targetId', 'amount'],
        properties: {
          targetType: { type: 'string', enum: ['post', 'comment'] },
          targetId: { type: 'integer', minimum: 1 },
          amount: { type: 'integer', minimum: 1, maximum: 1_000_000 },
          message: { type: 'string', maxLength: TIP_MESSAGE_MAX_LENGTH },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      targetType: 'post' | 'comment'
      targetId: number
      amount: number
      message?: string
    }
    const result = await tipTarget({
      targetType: body.targetType,
      targetId: body.targetId,
      fromUserId: request.user!.id,
      amount: body.amount,
      message: body.message,
    })
    sendSuccess(reply, result)
  })
}
