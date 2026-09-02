import type { FastifyInstance } from 'fastify'
import { getUserProfile, getUserPointsLog, getLatestUsers, searchUsers, updateAvatar, checkUsernameAvailable } from '../services/user/user.service.js'
import type { PointsLogFilter } from '../services/user/user.service.js'
import { authenticate } from '../middleware/auth.middleware.js'
import { parseId } from '../utils/parse.js'
import { sendSuccess } from '../utils/response.js'
import { ValidationError } from '../utils/errors.js'
import { ErrorCode } from '../constants/error-codes.js'
import { ALLOWED_AVATAR_STYLES, AVATARS_PER_STYLE } from '../constants/business.js'

/**
 * 用户公开资料相关路由。
 * 路由只做三件事：校验参数 → 调用 service → 返回响应。
 */
export async function userRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/user/:id/profile
   * 用户公开资料（需登录）：等级/星辰/统计公开，鸡腿余额仅本人可见。
   */
  fastify.get('/api/user/:id/profile', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const userId = parseId(id)

    const profile = await getUserProfile(userId, request.user!.id)
    sendSuccess(reply, profile)
  })

  /**
   * GET /api/user/:id/points-log?page=1&pageSize=20&type=income|expense
   * 积分流水（需登录，仅本人可见），按时间倒序分页。
   * type 可选：income=仅收入 / expense=仅支出 / 不传=全部；返回附带全量收支合计。
   */
  fastify.get('/api/user/:id/points-log', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const userId = parseId(id)

    const query = request.query as { page?: string; pageSize?: string; type?: string }
    const page = Number(query.page ?? 1)
    const pageSize = Number(query.pageSize ?? 20)
    const type = query.type
    if (type !== undefined && type !== 'income' && type !== 'expense') {
      throw new ValidationError('type 必须是 income 或 expense', ErrorCode.VALIDATION_ERROR)
    }

    const log = await getUserPointsLog(userId, request.user!.id, page, pageSize, type as PointsLogFilter)
    sendSuccess(reply, log)
  })

  /**
   * GET /api/users/latest?limit=N
   * 最新注册用户（侧边栏「欢迎新用户」，公开），默认 8 条。
   */
  fastify.get('/api/users/latest', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
    },
  }, async (request, reply) => {
    const query = request.query as { limit?: number }
    const users = await getLatestUsers(query.limit ? Number(query.limit) : 8)
    sendSuccess(reply, users)
  })

  /**
   * GET /api/users/search?q=前缀
   * 按用户名前缀搜索 active 用户（@提及候选，需登录）。返回 { id, username, avatar, level }。
   */
  fastify.get('/api/users/search', {
    preHandler: [authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          q: { type: 'string', minLength: 1, maxLength: 40 },
        },
      },
    },
  }, async (request, reply) => {
    const query = request.query as { q?: string }
    const users = await searchUsers(query.q ?? '')
    sendSuccess(reply, users)
  })

  /**
   * GET /api/users/username-available?username=xxx
   * 改名用户名可用性（需登录，排除当前用户自己）。返回 { available: boolean }。
   * 与 POST /api/me/rename 查重同口径，改名弹窗「实时唯一性提示」用 [3.6]。
   */
  fastify.get('/api/users/username-available', {
    preHandler: [authenticate],
    schema: {
      querystring: {
        type: 'object',
        required: ['username'],
        properties: {
          username: { type: 'string', minLength: 1, maxLength: 20 },
        },
      },
    },
  }, async (request, reply) => {
    const { username } = request.query as { username: string }
    const available = await checkUsernameAvailable(username, request.user!.id)
    sendSuccess(reply, { available })
  })

  /**
   * GET /api/avatar-styles
   * 权威头像风格清单（公开）。前端 avatar.ts 据此派生展示列表，避免双端手抄漂移。
   */
  fastify.get('/api/avatar-styles', async (_request, reply) => {
    sendSuccess(reply, {
      styles: ALLOWED_AVATAR_STYLES,
      perStyle: AVATARS_PER_STYLE,
    })
  })

  /**
   * PUT /api/user/me/avatar
   * 更新当前用户的头像为本地预置头像（需登录）。
   * Body: { avatar: string }，如 /avatars/bottts-neutral/avatar-03.svg
   */
  fastify.put('/api/user/me/avatar', {
    preHandler: [authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['avatar'],
        properties: {
          avatar: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { avatar } = request.body as { avatar: string }

    const updated = await updateAvatar(request.user!.id, avatar)
    sendSuccess(reply, { avatar: updated.avatar })
  })
}
