import type { FastifyInstance, FastifyRequest } from 'fastify'
import { sendSuccess } from '../utils/response.js'
import { authenticate, optionalAuth } from '../middleware/auth.middleware.js'
import { ValidationError, ForbiddenError } from '../utils/errors.js'
import { ErrorCode } from '../constants/error-codes.js'
import { UserStatus } from '../constants/business.js'
import { parseId } from '../utils/parse.js'
import {
  createComment,
  listPostComments,
  updateComment,
  deleteComment,
} from '../services/comment/comment.service.js'
import { likeComment, unlikeComment } from '../services/like/like.service.js'
import type { UserPublic } from '../services/auth/auth.service.js'

/** 当前登录用户（authenticate/optionalAuth 挂载后非空） */
function requireUser(request: FastifyRequest): UserPublic {
  if (!request.user) {
    throw new ValidationError('请先登录')
  }
  return request.user
}

/**
 * 评论相关路由。
 * 路由只做三件事：校验参数 → 调用 service → 返回响应。
 */
export async function commentRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /api/posts/:postId/comments — 帖子评论列表（楼层+楼中楼） */
  fastify.get('/api/posts/:postId/comments', { preHandler: [optionalAuth] }, async (request, reply) => {
    const { postId } = request.params as { postId: string }
    const query = request.query as { page?: number; pageSize?: number }

    const result = await listPostComments(
      parseId(postId),
      query.page ? Number(query.page) : 1,
      query.pageSize ? Number(query.pageSize) : 20,
    )
    sendSuccess(reply, result)
  })

  /** POST /api/posts/:postId/comments — 发评论/楼中楼回复 */
  fastify.post('/api/posts/:postId/comments', {
    preHandler: [authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', minLength: 1 },
          parentId: { type: ['integer', 'null'], minimum: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const user = requireUser(request)
    // 禁言用户禁止评论（可正常登录与浏览）
    if (user.status === UserStatus.MUTED) {
      throw new ForbiddenError('您已被禁言，无法评论', ErrorCode.ACCOUNT_MUTED)
    }
    const { postId } = request.params as { postId: string }
    const body = request.body as { content: string; parentId?: number | null }

    const comment = await createComment(
      parseId(postId),
      { content: body.content, parentId: body.parentId ?? null },
      user.id,
    )
    sendSuccess(reply, comment, 201)
  })

  /** PATCH /api/comments/:id — 编辑评论（仅作者） */
  fastify.patch('/api/comments/:id', {
    preHandler: [authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = request.body as { content: string }

    const comment = await updateComment(parseId(id), body.content, user.id)
    sendSuccess(reply, comment)
  })

  /** DELETE /api/comments/:id — 删除评论（作者或 admin，级联删楼中楼） */
  fastify.delete('/api/comments/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }

    await deleteComment(parseId(id), user)
    sendSuccess(reply, null)
  })

  /** POST /api/comments/:id/like — 点赞评论 */
  fastify.post('/api/comments/:id/like', { preHandler: [authenticate] }, async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }

    const likeCount = await likeComment(parseId(id), user.id)
    sendSuccess(reply, { likeCount })
  })

  /** DELETE /api/comments/:id/like — 取消点赞评论 */
  fastify.delete('/api/comments/:id/like', { preHandler: [authenticate] }, async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }

    const likeCount = await unlikeComment(parseId(id), user.id)
    sendSuccess(reply, { likeCount })
  })
}
