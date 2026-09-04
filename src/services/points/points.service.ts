import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { redis } from '../../lib/redis.js'
import { RedisKey } from '../../constants/redis-keys.js'
import { PointType } from '../../constants/business.js'
import type { IncomePointType, SpendPointType, CreditPointType } from '../../constants/business.js'
import { ErrorCode } from '../../constants/error-codes.js'
import { ValidationError, InsufficientPointsError } from '../../utils/errors.js'
import { getLevels } from '../config/config.service.js'
import type { LevelConfig } from '../config/config.service.js'

/**
 * 积分服务。
 * 规则来源：docs/积分签到等级体系.md（唯一规则来源，改规则先改文档，再同步这里）。
 *
 * 核心：earnPoints —— 一次调用完成「当日上限检查 → 加分 → 累计 → 升级 → 写流水」。
 * 两条线：
 * - points（余额）：可花费的鸡腿，MVP 暂无消费场景
 * - totalPointsEarned（累计）：只增不减，决定等级 [R20]
 */

/**
 * 全量积分类型（含消费/转入），spendPoints/creditPoints 的入参口径 [R45]。
 * 单通道的细分类型 IncomePointType/SpendPointType/CreditPointType 见 constants/business.ts。
 */
export type PointTypeValue = (typeof PointType)[keyof typeof PointType]

/** 可通过行为获取的积分类型（transfer 仅用于未来转账，不参与自动发放） */
export type EarnablePointType = Exclude<IncomePointType, typeof PointType.TRANSFER>

/**
 * 各行为积分定价与当日次数上限。
 * [R1] 发帖 +10，当日最多 3 次有分（上限 30）
 * [R2] 评论 +3，当日最多 10 次有分（上限 30）
 * [R3] 被赞 +1，被动收入天然受限，不设次数上限
 */
export const POINT_RULES: Record<EarnablePointType, { delta: number; dailyTimes?: number }> = {
  [PointType.CHECKIN]: { delta: 0 }, // 签到得分由 checkin.service 按连续规则实时计算，不走固定值
  [PointType.POST]: { delta: 10, dailyTimes: 3 },
  [PointType.COMMENT]: { delta: 3, dailyTimes: 10 },
  [PointType.LIKED]: { delta: 1 },
}

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
  type: EarnablePointType,
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

  // 等级配置从 Redis 读（后台可控），在事务外取一次：
  // - 放在当日上限拦截之后，被拦截的路径（上面已 return）不会多一次 GET
  // - 不放进 apply 事务回调，避免在持有数据库事务连接期间做 Redis 往返
  const levels = await getLevels()

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
    const newLevel = levelForTotal(updated.totalPointsEarned, levels)
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

/**
 * 按累计鸡腿判定等级 [R21]，等级门槛来自后台配置（config.service.getLevels）。
 * 兜底：所有门槛都不满足（理论不出现，配置已保证有 minTotal=0 的起始等级）时返回最低等级 key。
 */
export function levelForTotal(total: number, levels: LevelConfig[]): string {
  for (const t of levels) {
    if (total >= t.minTotal) return t.key
  }
  return levels[levels.length - 1]?.key ?? ''
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

/** 按累计鸡腿算等级进度 [R21]，门槛规则来自后台配置（config.service.getLevels） */
export function levelProgress(total: number, levels: LevelConfig[]): LevelProgress {
  const ascending = [...levels].reverse() // 最低 → 最高（claw → leg → meat）
  let level = ascending[0]?.key ?? ''
  let nextLevelAt: number | null = null
  for (const t of ascending) {
    if (total >= t.minTotal) {
      level = t.key
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

/**
 * 保存等级配置后重算存量用户的 level（仅回写实际变化的行）。
 * 「删减档」的必需步骤：删掉最高档后，原该档用户按 totalPointsEarned 回落到新最高档。
 * 幂等、可重跑：按新等级分组，每组一条 updateMany；部分失败下次保存等级时自动补齐，故不额外包事务。
 */
export async function recomputeLevels(levels: LevelConfig[]): Promise<void> {
  const users = await prisma.user.findMany({
    select: { id: true, totalPointsEarned: true, level: true },
  })
  const byLevel = new Map<string, number[]>()
  for (const u of users) {
    const next = levelForTotal(u.totalPointsEarned, levels)
    if (next !== u.level) {
      const list = byLevel.get(next)
      if (list) list.push(u.id)
      else byLevel.set(next, [u.id])
    }
  }
  for (const [level, ids] of byLevel) {
    await prisma.user.updateMany({ where: { id: { in: ids } }, data: { level } })
  }
}

/** 日期 key：YYYY-MM-DD（积分上限计数 / 签到共用） */
export function formatDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * ── 积分三通道（消费侧，docs/积分消费体系.md 2.1）──
 * | 通道 | 动 points | 动 totalPointsEarned | 可能升级 | 用途 |
 * | earnPoints（存量） | + | + | 是 | 收入侧 |
 * | spendPoints（新增） | −（条件更新） | 不动 [R44] | 否 | 一切消费出口 |
 * | creditPoints（新增） | + | 不动 [R50] | 否 | 打赏收入 / 悬赏奖励 / 悬赏退款 |
 *
 * [R51] 消费与打赏行为本身不产生积分：三个通道里没有任何「消费回馈」出口。
 * 防套利的机制性保证就是「这条链路上没有 earnPoints 可调」。
 */

/** 消费/转入流水选项 */
export interface SpendPointsOptions {
  /** 关联业务 ID（商品/帖子/评论/悬赏），用于流水溯源 [R45] */
  refId?: number
}

/**
 * 消费扣款。并发守卫：余额充足写在 WHERE 条件里，而不是先查余额再更新 [1.8][R44]。
 * - 条件更新 `updateMany({ where: { id, points: { gte: amount } } })`：两个并发请求只有一个能命中 WHERE
 * - 命中 0 行 → 重读余额抛 InsufficientPointsError（「还差 N 🍗」，前端引导去签到）
 * - 同事务内重读余额写流水，balanceAfter 不会串线 [R42][R45]
 *
 * 必须在调用方事务内执行（传 tx），否则「扣款成功但业务表没写」会撕裂对账。
 */
export async function spendPoints(
  userId: number,
  type: SpendPointType,
  amount: number,
  options: SpendPointsOptions = {},
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const db = tx ?? prisma
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new ValidationError('消费金额必须是正整数')
  }

  // 条件更新：points >= amount 才减。并发双花在这里被数据库行锁天然拦截
  const res = await db.user.updateMany({
    where: { id: userId, points: { gte: amount } },
    data: { points: { decrement: amount } },
  })
  if (res.count === 0) {
    // 余额不足：再查一次当前余额，报「还差 N」供前端引导（产品 1.10）
    const u = await db.user.findUnique({ where: { id: userId }, select: { points: true } })
    const have = u?.points ?? 0
    throw new InsufficientPointsError(have, amount)
  }

  // 同事务内重读余额写流水。行锁已由上面的 updateMany 持有，
  // 这里读到的必然是本事务扣款后的值，balanceAfter 不会串线 [R42][R45]
  const u2 = await db.user.findUnique({ where: { id: userId }, select: { points: true } })
  await db.pointLog.create({
    data: { userId, type, delta: -amount, balanceAfter: u2!.points, refId: options.refId },
  })
}

/**
 * 转入积分（打赏/悬赏奖励/退款）。
 * [R50] 只加余额、不计入累计、不升级 —— 与 earnPoints 的根本区别：
 * 打赏收入搬的是「余额」这个口袋，等级仍需靠收入侧行为自己挣。
 */
export async function creditPoints(
  userId: number,
  type: CreditPointType,
  delta: number,
  options: SpendPointsOptions = {},
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const db = tx ?? prisma
  // 转入必须是正整数（防负/小数转入：负 delta 会像 earnPoints 一样被当成「扣款通道」，语义错乱）
  if (!Number.isInteger(delta) || delta <= 0) {
    throw new ValidationError('转入金额必须是正整数')
  }
  const updated = await db.user.update({
    where: { id: userId },
    data: { points: { increment: delta } },
    select: { points: true },
  })
  await db.pointLog.create({
    data: { userId, type, delta, balanceAfter: updated.points, refId: options.refId },
  })
}

/**
 * 事务内读用户当前余额的辅助（消费/转入后返回给前端的最新余额）。
 * 第一个参数传 tx（交易内）或全局 prisma，调用方按需给。
 */
export async function getBalance(
  db: Prisma.TransactionClient | typeof prisma,
  userId: number,
): Promise<number> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { points: true } })
  return u?.points ?? 0
}
