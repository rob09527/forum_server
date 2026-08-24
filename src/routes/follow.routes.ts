import type { FastifyInstance } from 'fastify'
import { sendSuccess } from '../utils/response.js'
import { authenticate } from '../middleware/auth.middleware.js'
import { parseId } from '../utils/parse.js'
import {
  followUser,
  unfollowUser,
  listFollowing,
  listFollowers,
  getFollowingFeed,
} from '../services/follow/follow.service.js'

/**
 * 关注相关路由（单向 follow，需登录）。
 * 路由只做三件事：校验参数 → 调用 service → 返回响应。
 */
export async function followRoutes(fastify: FastifyInstance): Promise<void> {
  /** 关注用户 */
  fastify.post('/api/users/:id/follow', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    await followUser(parseId(id), request.user!.id)
    sendSuccess(reply, null, 201)
  })

  /** 取消关注 */
  fastify.delete('/api/users/:id/follow', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    await unfollowUser(parseId(id), request.user!.id)
    sendSuccess(reply, null)
  })

  /** 我的关注列表（分页） */
  fastify.get('/api/me/following', { preHandler: [authenticate] }, async (request, reply) => {
    const query = request.query as { page?: number; pageSize?: number }
    const page = query.page ? Number(query.page) : 1
    const pageSize = query.pageSize ? Number(query.pageSize) : 20

    const result = await listFollowing(request.user!.id, page, pageSize)
    sendSuccess(reply, result)
  })

  /** 我的粉丝列表（分页） */
  fastify.get('/api/me/followers', { preHandler: [authenticate] }, async (request, reply) => {
    const query = request.query as { page?: number; pageSize?: number }
    const page = query.page ? Number(query.page) : 1
    const pageSize = query.pageSize ? Number(query.pageSize) : 20

    const result = await listFollowers(request.user!.id, page, pageSize)
    sendSuccess(reply, result)
  })

  /** 关注动态流：被关注者的新帖（分页） */
  fastify.get('/api/me/following/posts', { preHandler: [authenticate] }, async (request, reply) => {
    const query = request.query as { page?: number; pageSize?: number }
    const page = query.page ? Number(query.page) : 1
    const pageSize = query.pageSize ? Number(query.pageSize) : 20

    const result = await getFollowingFeed(request.user!.id, page, pageSize)
    sendSuccess(reply, result)
  })
}
