import type { FastifyInstance } from 'fastify'
import { checkin, checkinStatus } from '../services/checkin/checkin.service.js'
import { authenticate } from '../middleware/auth.middleware.js'
import { ValidationError } from '../utils/errors.js'
import { sendSuccess } from '../utils/response.js'

/**
 * 签到相关路由。
 * 路由只做三件事：校验参数 → 调用 service → 返回响应。
 */
export async function checkinRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/checkin/status?month=YYYY-MM
   * 签到状态：连续/累计天数、今日是否已签、今日可得鸡腿、指定月签到日历。
   * 需登录。
   */
  fastify.get('/api/checkin/status', { preHandler: [authenticate] }, async (request, reply) => {
    const month = request.query as { month?: string }

    // month 可选，格式 YYYY-MM（1-12 月）
    if (month.month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month.month)) {
      throw new ValidationError('月份格式应为 YYYY-MM')
    }

    const status = await checkinStatus(request.user!.id, month.month)
    sendSuccess(reply, status)
  })

  /**
   * POST /api/checkin
   * 执行签到，返回本次所得鸡腿和连续天数。已签到返回 ALREADY_CHECKED_IN。
   * 需登录。
   */
  fastify.post('/api/checkin', { preHandler: [authenticate] }, async (request, reply) => {
    const result = await checkin(request.user!.id)
    sendSuccess(reply, result)
  })
}
