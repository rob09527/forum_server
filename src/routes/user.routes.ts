import type { FastifyInstance } from 'fastify'
import { getUserProfile, getUserPointsLog, updateAvatar } from '../services/user/user.service.js'
import { authenticate } from '../middleware/auth.middleware.js'
import { parseId } from '../utils/parse.js'
import { sendSuccess } from '../utils/response.js'
import { ALLOWED_AVATAR_STYLES } from '../constants/business.js'

/**
 * 用户公开资料相关路由。
 * 路由只做三件事：校验参数 → 调用 service → 返回响应。
 */
export async function userRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/user/:id/profile
   * 公开用户资料（无需登录）：等级/鸡腿/星辰/统计 + 等级进度。
   */
  fastify.get('/api/user/:id/profile', async (request, reply) => {
    const { id } = request.params as { id: string }
    const userId = parseId(id)

    const profile = await getUserProfile(userId)
    sendSuccess(reply, profile)
  })

  /**
   * GET /api/user/:id/points-log?page=1&pageSize=20
   * 公开积分流水（无需登录），按时间倒序分页。
   */
  fastify.get('/api/user/:id/points-log', async (request, reply) => {
    const { id } = request.params as { id: string }
    const userId = parseId(id)

    const query = request.query as { page?: string; pageSize?: string }
    const page = Number(query.page ?? 1)
    const pageSize = Number(query.pageSize ?? 20)

    const log = await getUserPointsLog(userId, page, pageSize)
    sendSuccess(reply, log)
  })

  /**
   * PUT /api/user/me/avatar
   * 更新当前用户的 DiceBear 头像风格（需登录）。
   * Body: { style: string }
   */
  fastify.put('/api/user/me/avatar', {
    preHandler: [authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['style'],
        properties: {
          style: { type: 'string', enum: [...ALLOWED_AVATAR_STYLES] },
          seed: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { style, seed } = request.body as { style: string; seed?: string }

    const updated = await updateAvatar(request.user!.id, style, seed)
    sendSuccess(reply, { avatar: updated.avatar })
  })
}
