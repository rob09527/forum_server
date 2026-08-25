import { prisma } from '../../lib/prisma.js'
import { redis } from '../../lib/redis.js'
import { RedisKey } from '../../constants/redis-keys.js'
import { PointType } from '../../constants/business.js'
import { ErrorCode } from '../../constants/error-codes.js'
import { NotFoundError, ValidationError, ConflictError } from '../../utils/errors.js'
import { spendPoints, getBalance, formatDateKey } from '../points/points.service.js'
import { getPropsConfig } from '../config/config.service.js'

/**
 * 功能道具服务（docs/积分消费体系.md 2.5）。
 *
 * 产品定位（1.4）：低价、高频、即用即走的功能性消费。不做库存模型——都是用到才买，
 * 场景内直接消费（补签/改名/扩容），从「买卡 → 用卡」六步压到两步。
 * [R51] 消费行为本身不产生积分。
 */

/**
 * 补签（POST /api/checkin/makeup）。
 * [R54] 仅可补昨天，且要求前天已签（断签 ≥2 天不可补）。
 * [R52] 只恢复连续签到标记，不补发该日签到积分（基础分/连签加成/里程碑均不补发）。
 * 月次数上限从流水派生（type=makeup 当月条数），与账本同一份数据 [1.6]。
 */
export async function makeupCheckin(userId: number): Promise<{ balance: number }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { lastCheckinAt: true, checkinStreak: true, checkinTotalDays: true },
  })
  if (!user) throw new NotFoundError('用户', ErrorCode.NOT_FOUND)

  const today = formatDateKey(new Date())
  const yesterday = formatDateKey(new Date(Date.now() - 86400_000))
  const dayBefore = formatDateKey(new Date(Date.now() - 2 * 86400_000))

  // [R54] 四象限逐条对应产品场景表 —— 今天已签 / 昨天已签 / 可补（昨天漏签且前天已签）/ 断签≥2 天
  if (user.lastCheckinAt && formatDateKey(user.lastCheckinAt) === today) {
    // 今天已签：昨天的连续已在本次签到判定时完成，补签无意义
    throw new ConflictError('今天已签到，无需补签昨天', ErrorCode.MAKEUP_UNAVAILABLE)
  }
  if (user.lastCheckinAt && formatDateKey(user.lastCheckinAt) === yesterday) {
    throw new ConflictError('昨天已签到，无需补签', ErrorCode.MAKEUP_UNAVAILABLE)
  }
  if (!user.lastCheckinAt || formatDateKey(user.lastCheckinAt) !== dayBefore) {
    throw new ConflictError('断签超过 1 天，无法补签', ErrorCode.MAKEUP_UNAVAILABLE)
  }

  // 月次数上限：从流水派生（type=makeup 当月条数），与账本同一份数据 [1.6]
  const cfg = await getPropsConfig()
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  const used = await prisma.pointLog.count({
    where: { userId, type: PointType.MAKEUP, createdAt: { gte: monthStart } },
  })
  if (used >= cfg.makeupMonthlyLimit) {
    throw new ConflictError('本月补签次数已用完', ErrorCode.MAKEUP_LIMIT_EXCEEDED)
  }

  // 事务内返回扣款后余额，供前端同步顶栏 chip [3.1]
  const balance = await prisma.$transaction(async (tx) => {
    await spendPoints(userId, PointType.MAKEUP, cfg.makeupPrice, {}, tx)
    // [R52] 只恢复连续标记、不补发积分；[R54] streak 不重算、直接保住
    await tx.user.update({
      where: { id: userId },
      data: { lastCheckinAt: new Date(Date.now() - 86400_000), checkinTotalDays: { increment: 1 } },
    })
    return await getBalance(tx, userId)
  })
  // Redis 不参与事务回滚：事务提交后再写签到日历。
  // 失败不阻塞主流程（日历是软状态，不影响账本，可由后续签到/对账兜底）
  try {
    await redis.sadd(RedisKey.checkinDate(yesterday), String(userId)) // 日历显示已签
  } catch (err) {
    console.warn('[checkin] 写签到日历失败:', (err as Error).message)
  }
  return { balance }
}

/**
 * 改名（POST /api/me/rename）。
 * 用户名格式校验（3-20 字符）→ 全局唯一（复用 USERNAME_TAKEN）→
 * 冷却检查（最近一条 type=rename 流水距 now >= renameCooldownDays）→
 * 事务内 spendPoints(RENAME) + update username。无会话/搜索/提及联动（T8）。
 */
export async function rename(userId: number, newUsername: string): Promise<{ balance: number }> {
  const username = newUsername?.trim() ?? ''
  if (username.length < 3 || username.length > 20) {
    throw new ValidationError('用户名需为 3-20 个字符', ErrorCode.VALIDATION_ERROR)
  }

  // 全局唯一：非本人占用才冲突（改回自己当前名不拦截）
  const exists = await prisma.user.findUnique({ where: { username }, select: { id: true } })
  if (exists && exists.id !== userId) {
    throw new ConflictError('该用户名已被占用', ErrorCode.USERNAME_TAKEN)
  }

  // 冷却：最近一次改名距今 >= renameCooldownDays
  const cfg = await getPropsConfig()
  const lastRename = await prisma.pointLog.findFirst({
    where: { userId, type: PointType.RENAME },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  const cooldownMs = cfg.renameCooldownDays * 86400_000
  if (lastRename && Date.now() - lastRename.createdAt.getTime() < cooldownMs) {
    throw new ConflictError(`改名需间隔 ${cfg.renameCooldownDays} 天`, ErrorCode.RENAME_COOLDOWN)
  }

  const balance = await prisma.$transaction(async (tx) => {
    await spendPoints(userId, PointType.RENAME, cfg.renamePrice, {}, tx)
    await tx.user.update({ where: { id: userId }, data: { username } })
    return await getBalance(tx, userId)
  })
  return { balance }
}

/**
 * 上传扩容（POST /api/me/quota）。
 * 单事务：锁用户行 → 校验上限 → 条件扣款 → uploadQuotaBonus += quotaPerPurchase。
 * 剩余额度不足单次购买量时直接拒绝（扩容按固定块出售、价格恒为 quotaPrice），
 * 不再按剩余封顶——否则会出现「扣全款只买到一小份」的计量错位 [产品决策]。
 * 扩容为永久额度 [1.4.2]。
 */
export async function buyQuota(userId: number): Promise<{ balance: number }> {
  const cfg = await getPropsConfig()

  const balance = await prisma.$transaction(async (tx) => {
    // FOR UPDATE 锁用户行：串行化并发扩容，杜绝两笔同时读到「剩余够买」的超购
    const rows = await tx.$queryRaw<{ id: number; uploadQuotaBonus: number }[]>`
      SELECT "id", "uploadQuotaBonus" FROM "users" WHERE "id" = ${userId} FOR UPDATE`
    const user = rows[0]
    if (!user) throw new NotFoundError('用户', ErrorCode.NOT_FOUND)

    const remaining = cfg.quotaTotalLimit - user.uploadQuotaBonus
    if (remaining < cfg.quotaPerPurchase) {
      throw new ConflictError(
        `扩容已达上限（共 ${Math.round(cfg.quotaTotalLimit / 1024 / 1024)}MB）`,
        ErrorCode.QUOTA_LIMIT_EXCEEDED,
      )
    }

    await spendPoints(userId, PointType.QUOTA, cfg.quotaPrice, {}, tx)
    await tx.user.update({ where: { id: userId }, data: { uploadQuotaBonus: { increment: cfg.quotaPerPurchase } } })
    return await getBalance(tx, userId)
  })
  return { balance }
}
