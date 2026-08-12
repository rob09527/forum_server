import type { FastifyInstance, FastifyRequest } from 'fastify'
import { sendSuccess } from '../utils/response.js'
import { authenticate, optionalAuth } from '../middleware/auth.middleware.js'
import { ValidationError } from '../utils/errors.js'
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
      Number(postId),
      query.page ? Number(query.page) : 1,
      query.pageSize ? Number(query.pageSize) : 20,
    )
    sendSuccess(reply, result)
  })

  /** POST /api/posts/:postId/comments — 发评论/楼中楼回复 */
  fastify.post('/api/posts/:postId/comments', { preHandler: [authenticate] }, async (request, reply) => {
    const user = requireUser(request)
    const { postId } = request.params as { postId: string }
    const body = request.body as { content: string; parentId?: number | null }

    const comment = await createComment(
      Number(postId),
      { content: body.content, parentId: body.parentId ?? null },
      user.id,
    )
    sendSuccess(reply, comment, 201)
  })

  /** PATCH /api/comments/:id — 编辑评论（仅作者） */
  fastify.patch('/api/comments/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = request.body as { content: string }

    const comment = await updateComment(Number(id), body.content, user.id)
    sendSuccess(reply, comment)
  })

  /** DELETE /api/comments/:id — 删除评论（作者或 admin，级联删楼中楼） */
  fastify.delete('/api/comments/:id', { preHandler: [authenticate] }, async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }

    await deleteComment(Number(id), user)
    sendSuccess(reply, null)
  })

  /** POST /api/comments/:id/like — 点赞评论 */
  fastify.post('/api/comments/:id/like', { preHandler: [authenticate] }, async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }

    const likeCount = await likeComment(Number(id), user.id)
    sendSuccess(reply, { likeCount })
  })

  /** DELETE /api/comments/:id/like — 取消点赞评论 */
  fastify.delete('/api/comments/:id/like', { preHandler: [authenticate] }, async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }

    const likeCount = await unlikeComment(Number(id), user.id)
    sendSuccess(reply, { likeCount })
  })
}
