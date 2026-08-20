import { prisma } from '../../lib/prisma.js'
import { redis } from '../../lib/redis.js'
import { RedisKey } from '../../constants/redis-keys.js'
import { PointType } from '../../constants/business.js'
import { ConflictError } from '../../utils/errors.js'
import { ErrorCode } from '../../constants/error-codes.js'
import { earnPoints, formatDateKey } from '../points/points.service.js'
import { getCheckinConfig } from '../config/config.service.js'
import type { CheckinConfig } from '../config/config.service.js'

/**
 * 签到服务。
 * 规则来源：docs/积分签到等级体系.md 第 2 节。
 *
 * - [R10] 每日签到 +5 基础分
 * - [R11] 连续第 N 天额外 +min(N, 5)，连续 5 天及以上每天可签得 10
 * - [R12] 连续每满 7 天（第 7 / 14 / 21 … 天）额外 +30
 * - [R13] 断签（间隔 > 1 天）连续归零，累计签到天数保留
 * - [R14] 每人每天最多签 1 次
 *
 * 数据存储：
 * - 连续天数 / 累计天数 / 上次签到时间 落 DB（Redis 重启不丢，[R13] 判定依据）
 * - 当日签到用户集合 Redis SET（`checkin:YYYY-MM-DD:users`），供日历查询
 */

/** 签到状态（GET /api/checkin/status） */
export interface CheckinStatus {
  /** 连续签到天数（当前，包含今天如果已签） */
  streak: number
  /** 累计签到天数，永不归零 [R13] */
  totalDays: number
  /** 今天是否已签到 [R14] */
  checkedToday: boolean
  /** 今天签到可获得的鸡腿数（已签则为今天实际所得）[R10][R11][R12] */
  todayDelta: number
  /** 指定月份内已签到的日期列表，格式 YYYY-MM-DD */
  calendar: string[]
}

/** 签到结果（POST /api/checkin） */
export interface CheckinResult {
  /** 本次签到获得的鸡腿 [R10][R11][R12] */
  delta: number
  /** 连续签到天数（含本次） */
  streak: number
  /** 累计签到天数 */
  totalDays: number
}

/**
 * 计算第 streak 天签到应得的鸡腿，参数来自后台配置（config.service.getCheckinConfig）。
 * [R10] base + [R11] min(streak × streakBonusPerDay, streakBonusCap) + [R12] 连续每满 milestoneEvery 天再 +milestoneBonus
 * 默认值下第 7 天 = 5 + min(7×1, 5) + 30 = 5 + 5 + 30 = 40
 */
function computeCheckinPoints(streak: number, cfg: CheckinConfig): number {
  const streakBonus = Math.min(streak * cfg.streakBonusPerDay, cfg.streakBonusCap)
  const milestoneBonus = streak > 0 && streak % cfg.milestoneEvery === 0 ? cfg.milestoneBonus : 0
  return cfg.base + streakBonus + milestoneBonus
}

/**
 * 执行签到。
 * 幂等/并发：以 Redis 当日 SET 的 SADD 返回值作原子闸门（Redis 单线程，重复/并发请求
 * 只有一个能 SADD 成功返回 1）；DB 的 lastCheckinAt 作二次防线（覆盖 Redis 被清空的场景）。
 */
export async function checkin(userId: number): Promise<CheckinResult> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { checkinStreak: true, checkinTotalDays: true, lastCheckinAt: true },
  })
  if (!user) {
    throw new ConflictError('用户不存在', ErrorCode.NOT_FOUND)
  }

  const today = formatDateKey(new Date())

  // [R14] 原子闸门：SADD 返回 0 → 今天已在集合里（重复/并发），直接拒绝
  const added = await redis.sadd(RedisKey.checkinDate(today), String(userId))
  if (added === 0) {
    throw new ConflictError('今天已经签到过了', ErrorCode.ALREADY_CHECKED_IN)
  }

  // [R14] 二次防线：DB 已记今天（Redis 被清空后 SADD 会误判为新人）
  if (user.lastCheckinAt && formatDateKey(user.lastCheckinAt) === today) {
    throw new ConflictError('今天已经签到过了', ErrorCode.ALREADY_CHECKED_IN)
  }

  // [R13] 连续判定：昨天签过 → streak+1；否则断签重计为 1
  const yesterday = formatDateKey(new Date(Date.now() - 24 * 3600 * 1000))
  const streak =
    user.lastCheckinAt && formatDateKey(user.lastCheckinAt) === yesterday
      ? user.checkinStreak + 1
      : 1

  const cfg = await getCheckinConfig()
  const delta = computeCheckinPoints(streak, cfg)

  // 发分（points + totalPointsEarned + 升级 + 写流水），[R4] 走统一积分通道
  await earnPoints(userId, PointType.CHECKIN, { delta })

  // 落库连续天数（[R13] 持久化，Redis 重启不丢）+ 累计 +1（永不归零）
  await prisma.user.update({
    where: { id: userId },
    data: {
      checkinStreak: streak,
      checkinTotalDays: { increment: 1 },
      lastCheckinAt: new Date(),
    },
  })

  return {
    delta,
    streak,
    totalDays: user.checkinTotalDays + 1,
  }
}

/**
 * 查询签到状态。
 * month 格式 YYYY-MM，缺省为当前月。calendar 逐日查 Redis SET，
 * 31 次往返在 MVP 规模可接受（后续可换 Bitmap + BITCOUNT）。
 */
export async function checkinStatus(userId: number, month?: string): Promise<CheckinStatus> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { checkinStreak: true, checkinTotalDays: true, lastCheckinAt: true },
  })
  if (!user) {
    throw new ConflictError('用户不存在', ErrorCode.NOT_FOUND)
  }

  const now = new Date()
  const today = formatDateKey(now)

  const checkedToday = !!user.lastCheckinAt && formatDateKey(user.lastCheckinAt) === today

  const cfg = await getCheckinConfig()

  // 今天预计可得：已签 → 用当前 streak 算今天所得；未签 → 算下一次签到后的 streak
  let todayDelta: number
  if (checkedToday) {
    todayDelta = computeCheckinPoints(user.checkinStreak, cfg)
  } else {
    const yesterday = formatDateKey(new Date(now.getTime() - 24 * 3600 * 1000))
    const nextStreak =
      user.lastCheckinAt && formatDateKey(user.lastCheckinAt) === yesterday
        ? user.checkinStreak + 1
        : 1
    todayDelta = computeCheckinPoints(nextStreak, cfg)
  }

  // 月份解析：缺省当前月；非法则抛参数错误（路由层已做格式校验，这里只兜底）
  const parts = (month ?? today.slice(0, 7)).split('-').map(Number)
  const year = parts[0]
  const mon = parts[1]

  // [日历] 本月每天查一次集合，存在即已签
  const daysInMonth = new Date(year, mon, 0).getDate() // mon 为 1 基，new Date(y, m, 0) = 当月最后一天
  const dayChecks = await Promise.all(
    Array.from({ length: daysInMonth }, (_, i) => i + 1).map(async (d) => {
      const dateStr = `${year}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      const checked = await redis.sismember(RedisKey.checkinDate(dateStr), String(userId))
      return checked ? dateStr : null
    }),
  )
  const calendar = dayChecks.filter((d): d is string => d !== null)

  return {
    streak: user.checkinStreak,
    totalDays: user.checkinTotalDays,
    checkedToday,
    todayDelta,
    calendar,
  }
}
