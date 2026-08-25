import type { FastifyInstance } from 'fastify'
import { authenticate } from '../middleware/auth.middleware.js'
import { sendSuccess } from '../utils/response.js'
import { parseId } from '../utils/parse.js'
import { acceptAnswer, cancelBounty } from '../services/bounty/bounty.service.js'

/**
 * 悬赏问答路由（docs/积分消费体系.md 2.4）。
 * 悬赏的发起在 POST /api/posts 内通过 bountyAmount 入参完成（发帖即托管），见 post.routes。
 * 路由只做三件事：校验参数 → 调用 service → 返回响应。
 */
export async function bountyRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /api/bounties/:id/accept
   * 发起人采纳答案。Body: { commentId }（必须是该帖的有效回答：顶层评论且非发起人自答）。
   */
  fastify.post('/api/bounties/:id/accept', {
    preHandler: [authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['commentId'],
        properties: {
          commentId: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const { commentId } = request.body as { commentId: number }
    const result = await acceptAnswer(parseId(id), commentId, request.user!.id)
    sendSuccess(reply, result)
  })

  /**
   * POST /api/bounties/:id/cancel
   * 发起人取消悬赏。仅无有效回答时可取消（全额退款）；有有效回答返回 409。
   */
  fastify.post('/api/bounties/:id/cancel', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = await cancelBounty(parseId(id), request.user!.id)
    sendSuccess(reply, result)
  })
}
