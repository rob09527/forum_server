import type { FastifyInstance } from 'fastify'
import { sendSuccess } from '../utils/response.js'
import { listActiveAnnouncements } from '../services/announcement/announcement.service.js'

/**
 * 公告路由。
 * 公告的增删改由 Cool Admin 后台直接管理（共用 forum 库），
 * 业务侧只提供前台公告栏的只读接口。
 */
export async function announcementRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /api/announcements — 获取上线公告列表（公开，无鉴权） */
  fastify.get('/api/announcements', async (_request, reply) => {
    sendSuccess(reply, await listActiveAnnouncements())
  })
}
