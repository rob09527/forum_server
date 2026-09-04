import type { FastifyInstance } from 'fastify'
import {
  getNodelocOverview,
  reimportTopic,
  reindexPosts,
} from '../services/admin/nodeloc-admin.service.js'
import { requireAdminKey } from '../middleware/admin-key.middleware.js'
import { parseId } from '../utils/parse.js'
import { sendSuccess } from '../utils/response.js'

/**
 * NodeLoc 数据导入管理接口（供 Cool Admin 后端调用，非浏览器直接访问）。
 * 统一 preHandler 校验 X-Admin-Key 服务间密钥；真正的后台权限控制由 admin 后端负责。
 */
export async function nodelocAdminRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/admin/nodeloc/overview
   * NodeLoc 导入概览：worker 三阶段状态 + 内容/影子/积分规模，供 admin 看板渲染。
   */
  fastify.get(
    '/api/admin/nodeloc/overview',
    { preHandler: [requireAdminKey] },
    async (_request, reply) => {
      sendSuccess(reply, await getNodelocOverview())
    },
  )

  /**
   * POST /api/admin/nodeloc/topics/:id/reimport
   * 单主题重灌：重新拉取该 NodeLoc 主题全量楼层（importTopic 幂等，已导主题返回 skipped）。
   */
  fastify.post(
    '/api/admin/nodeloc/topics/:id/reimport',
    { preHandler: [requireAdminKey] },
    async (request, reply) => {
      const { id } = request.params as { id: string }
      const topicId = parseId(id)
      sendSuccess(reply, await reimportTopic(topicId))
    },
  )

  /**
   * POST /api/admin/nodeloc/reindex
   * 重建帖子搜索索引：回填阶段不写 Meili（只写 DB），回填完成后调用本接口全量回填索引，
   * 否则回灌内容列表可见但搜索搜不到（见 services/admin/nodeloc-admin.service.ts 顶部注释）。
   */
  fastify.post(
    '/api/admin/nodeloc/reindex',
    { preHandler: [requireAdminKey] },
    async (_request, reply) => {
      sendSuccess(reply, await reindexPosts())
    },
  )
}
