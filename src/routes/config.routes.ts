import type { FastifyInstance } from 'fastify'
import {
  getCheckinConfig,
  getLevels,
  getShopConfig,
  getTipConfig,
  getBountyConfig,
  getPropsConfig,
} from '../services/config/config.service.js'
import { sendSuccess } from '../utils/response.js'

/**
 * 游戏化配置路由。
 * GET /api/config/game → 签到/等级 + 积分消费体系四组配置（商城/打赏/悬赏/道具），
 * 前端据此动态渲染：打赏档位按钮 [1.5.3]、补签/改名/扩容价格文案、悬赏规则提示。
 * 公开数据，无需登录。数据来自共享 Redis，admin 后端直写；未配置时返回默认值。
 * 注意：quotaPerPurchase / quotaTotalLimit 单位为字节（前端换算 MB 展示）。
 */
export async function configRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/config/game', async (_request, reply) => {
    const [checkin, levels, shop, tip, bounty, props] = await Promise.all([
      getCheckinConfig(),
      getLevels(),
      getShopConfig(),
      getTipConfig(),
      getBountyConfig(),
      getPropsConfig(),
    ])
    sendSuccess(reply, { checkin, levels, shop, tip, bounty, props })
  })
}
