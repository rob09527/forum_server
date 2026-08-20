import type { FastifyInstance } from 'fastify'
import { getCheckinConfig, getLevels } from '../services/config/config.service.js'
import { sendSuccess } from '../utils/response.js'

/**
 * 游戏化配置路由。
 * GET /api/config/game → 签到奖励配置 + 等级列表（key/中文名/门槛），
 * 前端据此动态渲染等级中文名与签到规则文案。公开数据，无需登录。
 * 数据来自共享 Redis，admin 后端直写；未配置时返回默认值。
 */
export async function configRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/config/game', async (_request, reply) => {
    const [checkin, levels] = await Promise.all([getCheckinConfig(), getLevels()])
    sendSuccess(reply, { checkin, levels })
  })
}
