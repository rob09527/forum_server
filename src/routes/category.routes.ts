import type { FastifyInstance } from 'fastify'
import { sendSuccess } from '../utils/response.js'
import { listCategories, listTags } from '../services/category/category.service.js'

/**
 * 分类与标签路由。
 * 板块数据由后端 constants/business.ts 统一控制，帖子数实时统计；
 * 热门标签为静态列表（后续可接入标签云统计）。
 */
export async function categoryRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /api/categories — 获取所有分类（含真实帖子数） */
  fastify.get('/api/categories', async (_request, reply) => {
    const categories = await listCategories()
    sendSuccess(reply, categories)
  })

  /** GET /api/tags — 获取所有热门标签 */
  fastify.get('/api/tags', async (_request, reply) => {
    sendSuccess(reply, listTags())
  })
}
