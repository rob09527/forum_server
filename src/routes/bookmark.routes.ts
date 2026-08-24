import type { FastifyInstance } from 'fastify'
import { sendSuccess } from '../utils/response.js'
import { authenticate } from '../middleware/auth.middleware.js'
import { parseId } from '../utils/parse.js'
import {
  bookmarkPost,
  unbookmarkPost,
  listBookmarks,
} from '../services/bookmark/bookmark.service.js'

/**
 * 收藏相关路由（私密，仅本人可见，需登录）。
 * 路由只做三件事：校验参数 → 调用 service → 返回响应。
 */
export async function bookmarkRoutes(fastify: FastifyInstance): Promise<void> {
  /** 收藏帖子 */
  fastify.post('/api/posts/:id/bookmark', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    const result = await bookmarkPost(parseId(id), request.user!.id)
    sendSuccess(reply, result, 201)
  })

  /** 取消收藏 */
  fastify.delete('/api/posts/:id/bookmark', { preHandler: [authenticate] }, async (request, reply) => {
    const { id } = request.params as { id: string }
    await unbookmarkPost(parseId(id), request.user!.id)
    sendSuccess(reply, null)
  })

  /** 我的收藏列表（分页，按收藏时间倒序） */
  fastify.get('/api/me/bookmarks', { preHandler: [authenticate] }, async (request, reply) => {
    const query = request.query as { page?: number; pageSize?: number }
    const page = query.page ? Number(query.page) : 1
    const pageSize = query.pageSize ? Number(query.pageSize) : 20

    const result = await listBookmarks(request.user!.id, page, pageSize)
    sendSuccess(reply, result)
  })
}
