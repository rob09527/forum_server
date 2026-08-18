import type { FastifyInstance } from 'fastify'
import { sendSuccess } from '../utils/response.js'
import { searchPosts } from '../services/search/search.service.js'

/**
 * 搜索相关路由。
 * 路由只做三件事：校验参数 → 调用 service → 返回响应。
 */
export async function searchRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /api/search — 帖子全文搜索（公开，无需登录） */
  fastify.get('/api/search', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          /** 搜索关键词，必填 */
          q: { type: 'string', minLength: 1 },
          /** 板块筛选 */
          category: { type: 'string' },
        },
        required: ['q'],
      },
    },
  }, async (request, reply) => {
    const query = request.query as {
      q: string
      category?: string
      page?: number
      pageSize?: number
    }

    const result = await searchPosts(query.q, {
      category: query.category,
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
    })

    sendSuccess(reply, result)
  })
}
