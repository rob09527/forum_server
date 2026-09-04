import type { Prisma } from '@prisma/client'
import { getLevels } from '../config/config.service.js'
import { levelForTotal, POINT_RULES, type EarnablePointType } from '../points/points.service.js'

/**
 * 导入侧积分入账:earnPoints 的重放镜像,供增量 worker 给影子用户实时发积分(决策 11/15)。
 *
 * [合理例外] 不复用 points.service.earnPoints,差异三点:
 * 1. 不写 Redis 当日计数 point_daily:*(决策 11:重放不设上限不截断;
 *    且历史/同步时间与自然日错位,写计数键只会污染真实用户限额)
 * 2. PointLog.createdAt 显式传入(用原始发言时间,保持审计链时间线自然)
 * 3. 必须在调用方事务内执行(与内容行同生共死),不自建事务
 * 余额/累计/升级/流水四写与 earnPoints 完全同构,points:audit 三不变量成立。
 */
export async function importEarn(
  tx: Prisma.TransactionClient,
  userId: number,
  type: EarnablePointType,
  refId: number,
  createdAt: Date,
): Promise<void> {
  const delta = POINT_RULES[type].delta

  // 先锁用户行再查流水：同一用户的并发导入会串行化，避免「同时查不到 → 重复加余额」。
  // 不依赖进程内缓存；即使多个 worker 共享数据库，也保持积分与流水同生共死。
  await tx.$queryRaw`SELECT id FROM "users" WHERE id = ${userId} FOR UPDATE`
  const existing = await tx.pointLog.findFirst({
    where: { userId, type, refId },
    select: { id: true },
  })
  if (existing) return

  const updated = await tx.user.update({
    where: { id: userId },
    data: {
      points: { increment: delta },
      totalPointsEarned: { increment: delta },
    },
    select: { points: true, totalPointsEarned: true, level: true },
  })

  // 升级判定与真实路径同一函数、同一 Redis 配置(只升不降)
  const levels = await getLevels()
  const newLevel = levelForTotal(updated.totalPointsEarned, levels)
  if (newLevel !== updated.level) {
    await tx.user.update({ where: { id: userId }, data: { level: newLevel } })
  }

  await tx.pointLog.create({
    data: { userId, type, delta, balanceAfter: updated.points, refId, createdAt },
  })
}
