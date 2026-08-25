import { prisma } from '../../lib/prisma.js'
import { redis } from '../../lib/redis.js'
import { RedisKey } from '../../constants/redis-keys.js'
import { BountyStatus, BountySettleType } from '../../constants/business.js'
import { settleBounty } from './bounty.service.js'

/**
 * 悬赏超时自动结算（docs/积分消费体系.md 2.4 T3 的调度器实现）。
 *
 * - Redis 抢锁（SET NX EX 60）：多实例只有一个会真正扫描，避免重复结算
 * - 每轮最多 20 条，避免一次事务过多；剩余等下一轮（60s 周期）
 * - 到期悬赏最多滞后 60s 结算——不依赖任何访问，没有"冷门帖永不结算"的破洞 [1.6.3]
 * - 扫描与请求处理是不同职责，放 service 内、由调度器驱动，不挂任何读路径
 */

/** 每轮扫描上限（与调度周期匹配，避免一次执行过重） */
const SWEEP_BATCH_SIZE = 20

/** 扫描并结算所有已到期（status=escrow 且 expireAt < now）的悬赏，返回本次结算条数 */
export async function sweepExpiredBounties(): Promise<number> {
  const locked = await redis.set(RedisKey.bountySweepLock, '1', 'EX', 60, 'NX')
  if (!locked) return 0 // 其他实例已在扫，本实例跳过

  const expired = await prisma.bounty.findMany({
    where: { status: BountyStatus.ESCROW, expireAt: { lt: new Date() } },
    select: { id: true },
    take: SWEEP_BATCH_SIZE,
  })

  // settleBounty 内部条件更新幂等：并发下重复扫描也只结算一次
  for (const b of expired) {
    await settleBounty(b.id, { settleType: BountySettleType.AUTO })
  }
  return expired.length
}
