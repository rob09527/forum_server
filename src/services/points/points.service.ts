import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { redis } from '../../lib/redis.js'
import { RedisKey } from '../../constants/redis-keys.js'
import { PointType, UserLevel } from '../../constants/business.js'

/**
 * 积分服务。
 * 规则来源：docs/积分签到等级体系.md（唯一规则来源，改规则先改文档，再同步这里）。
 *
 * 核心：earnPoints —— 一次调用完成「当日上限检查 → 加分 → 累计 → 升级 → 写流水」。
 * 两条线：
 * - points（余额）：可花费的鸡腿，MVP 暂无消费场景
 * - totalPointsEarned（累计）：只增不减，决定等级 [R20]
 */

/** 可通过行为获取的积分类型（transfer 仅用于未来转账，不参与自动发放） */
export type PointTypeValue = Exclude<(typeof PointType)[keyof typeof PointType], typeof PointType.TRANSFER>

/**
 * 各行为积分定价与当日次数上限。
 * [R1] 发帖 +10，当日最多 3 次有分（上限 30）
 * [R2] 评论 +3，当日最多 10 次有分（上限 30）
 * [R3] 被赞 +1，被动收入天然受限，不设次数上限
 */
const POINT_RULES: Record<PointTypeValue, { delta: number; dailyTimes?: number }> = {
  [PointType.CHECKIN]: { delta: 0 }, // 签到得分由 checkin.service 按连续规则实时计算，不走固定值
  [PointType.POST]: { delta: 10, dailyTimes: 3 },
  [PointType.COMMENT]: { delta: 3, dailyTimes: 10 },
  [PointType.LIKED]: { delta: 1 },
}

/** 等级门槛 [R21]：按累计鸡腿升档，从上到下匹配（越靠前门槛越高） */
const LEVEL_THRESHOLDS: { level: string; minTotal: number }[] = [
  { level: UserLevel.MEAT, minTotal: 500 },
  { level: UserLevel.LEG, minTotal: 100 },
  { level: UserLevel.CLAW, minTotal: 0 },
]

/** 积分发放结果 */
export interface EarnResult {
  /** 实际加分，0 表示被当日上限拦截 */
  earned: number
  /** 发放后的用户等级（可能已升级）[R22]，被上限拦截时为 null */
  level: string | null
}

/** 发放选项 */
export interface EarnPointsOptions {
  /** 自定义积分值，默认取 POINT_RULES[type].delta（签到需按连续规则实时计算，故单独传入） */
  delta?: number
  /** 关联帖子/评论 ID，用于流水溯源 */
  refId?: number
}

/**
 * 发放积分。
 * - [R1][R2] 发帖/评论先查当日次数上限（Redis 计数器），超限静默返回 0，不打断用户操作
 * - [R40] points 与 totalPointsEarned 同步增加
 * - [R22] 按累计值即时升级，只升不降
 * - [R41] 写 PointLog 流水，[R42] 记录加分后的余额
 *
 * 幂等保证：被点赞由点赞表 UNIQUE 约束保证只调一次；发帖/评论由调用方保证不重复调用。
 */
export async function earnPoints(
  userId: number,
  type: PointTypeValue,
  options: EarnPointsOptions = {},
  tx?: Prisma.TransactionClient,
): Promise<EarnResult> {
  const rule = POINT_RULES[type]
  const delta = options.delta ?? rule.delta

  // [R1][R2] 当日次数上限拦截：只对可主动刷的行为设限（发帖/评论）。
  // Redis 计数独立于 DB 事务（无法跨存储原子），若后续 DB 事务回滚会多占一个当日名额，
  // 属可接受的软限流误差，不引入额外复杂度。
  if (rule.dailyTimes) {
    const key = RedisKey.pointDaily(type, userId, formatDateKey(new Date()))
    const times = await redis.incr(key)
    if (times === 1) await redis.expire(key, 86400) // 自然日过期，无需对齐零点
    if (times > rule.dailyTimes) {
      return { earned: 0, level: null }
    }
  }

  // 「加分 → 升级 → 写流水」三段写必须原子：要么全成功，要么全回滚，
  // 避免出现「鸡腿加了但没流水」或「流水写了但等级没升」的对账缺口。
  // 传入 tx 时复用调用方事务；否则自建一个事务。
  const apply = async (db: Prisma.TransactionClient): Promise<EarnResult> => {
    // [R40] 同步增加余额与累计
    const updated = await db.user.update({
      where: { id: userId },
      data: {
        points: { increment: delta },
        totalPointsEarned: { increment: delta },
      },
      select: { points: true, totalPointsEarned: true, level: true },
    })

    // [R22] 升级：按累计值判定，只升不降（永不降级）
    const newLevel = levelForTotal(updated.totalPointsEarned)
    if (newLevel !== updated.level) {
      await db.user.update({ where: { id: userId }, data: { level: newLevel } })
    }

    // [R41] 写流水，[R42] 记录加分后的余额用于对账
    await db.pointLog.create({
      data: { userId, type, delta, balanceAfter: updated.points, refId: options.refId },
    })

    return { earned: delta, level: newLevel }
  }

  return tx ? apply(tx) : prisma.$transaction(apply)
}

/** 按累计鸡腿判定等级 [R21]，levelForTotal 独立导出供注册等场景直接算等级 */
export function levelForTotal(total: number): string {
  for (const t of LEVEL_THRESHOLDS) {
    if (total >= t.minTotal) return t.level
  }
  return UserLevel.CLAW
}

/** 等级进度（用户资料页进度条用）：当前等级 + 下一门槛 + 还差多少 */
export interface LevelProgress {
  /** 当前等级 */
  level: string
  /** 下一等级所需累计鸡腿；已是最高等级为 null */
  nextLevelAt: number | null
  /** 距下一等级还差多少；最高等级为 0 */
  remaining: number
}

/** 按累计鸡腿算等级进度 [R21]，门槛规则只此一处（LEVEL_THRESHOLDS） */
export function levelProgress(total: number): LevelProgress {
  const ascending = [...LEVEL_THRESHOLDS].reverse() // claw → leg → meat
  let level = ascending[0].level
  let nextLevelAt: number | null = null
  for (const t of ascending) {
    if (total >= t.minTotal) {
      level = t.level
    } else {
      nextLevelAt = t.minTotal
      break
    }
  }
  return {
    level,
    nextLevelAt,
    remaining: nextLevelAt === null ? 0 : nextLevelAt - total,
  }
}

/** 日期 key：YYYY-MM-DD（积分上限计数 / 签到共用） */
export function formatDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
