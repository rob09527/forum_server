import type { FastifyInstance } from 'fastify'
import { sendSuccess } from '../utils/response.js'
import { listActiveAdverts } from '../services/advert/advert.service.js'

/**
 * 广告路由。
 * 广告的增删改由 Cool Admin 后台直接管理（共用 forum 库），
 * 业务侧只提供前台各广告位的只读接口。
 */
export async function advertRoutes(fastify: FastifyInstance): Promise<void> {
  /** GET /api/adverts — 获取上线广告列表（公开，无鉴权） */
  fastify.get('/api/adverts', async (_request, reply) => {
    sendSuccess(reply, await listActiveAdverts())
  })
}
