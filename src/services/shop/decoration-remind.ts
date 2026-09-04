import { prisma } from '../../lib/prisma.js'
import { redis } from '../../lib/redis.js'
import { RedisKey } from '../../constants/redis-keys.js'
import { NotificationType } from '../../constants/business.js'
import { createAndPush } from '../notification/notification.service.js'

/**
 * 装饰到期当天通知（docs/积分消费体系.md 2.2 T2 的落地，1.3.4 三段式提醒的第二段）。
 *
 * 调度器（index.ts setInterval(60s)）驱动：扫描「今日到期」的装饰，给持有者写一条站内通知。
 * - 多实例并发由 Redis 抢锁兜底（SET NX EX 60，同 bounty-sweep），只留一个实例真正扫描；
 * - 幂等靠 UserDecoration.expiredNotifiedAt（持久化，不用 Redis）——丢了会重复轰炸用户，
 *   「只应发生一次」的标记必须落库 [T2]
 * - 只发到期当天（expireAt 落在今日区间），过期不补发
 */

/** 每次扫描的上限，分批推进（一次调度最多处理 100 条，其余等下一轮） */
const BATCH_SIZE = 100

/**
 * 到期通知的文案模板（name 为解析后的友好名：称号中文名 / 颜色中文名）。
 * 头像已于 §9.1 从商城下线（不再是付费商品），故 subject 不再按类型分叉，统一「装饰」。
 * type 保留在签名里：存量 user_decorations 行仍带类型，未来新增装饰类型时这里是唯一分叉点。
 */
function noticeContent(type: string, name: string): string {
  const subject = '装饰'
  return `你的${subject}「${name}」已到期，可前往商城续费`
}

/** 扫描并通知今日到期且未通知过的装饰，返回本次通知条数 */
export async function checkAndNotifyExpired(): Promise<number> {
  // Redis 抢锁：多实例只有一个执行扫描，避免重复写通知（DB 侧 expiredNotifiedAt 兜单实例内幂等）
  const locked = await redis.set(RedisKey.decorationRemindLock, '1', 'EX', 60, 'NX')
  if (!locked) return 0 // 其他实例已在扫，本实例跳过

  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart.getTime() + 86400_000)

  const expiring = await prisma.userDecoration.findMany({
    where: {
      type: { in: ['title', 'username_color'] },
      expireAt: { gte: dayStart, lt: dayEnd },
      expiredNotifiedAt: null,
    },
    select: { id: true, userId: true, type: true, renderValue: true },
    take: BATCH_SIZE,
  })

  // renderValue → 商品名（称号图片索引 key / 颜色 hex → 中文名）。
  // 历史遗留装饰或已删商品在 shop_items 查不到时回退原始 renderValue。
  const renderValues = [...new Set(expiring.map((d) => d.renderValue))]
  const shopItems = renderValues.length
    ? await prisma.shopItem.findMany({
        where: { renderValue: { in: renderValues } },
        select: { renderValue: true, name: true },
      })
    : []
  const nameMap = new Map(shopItems.map((s) => [s.renderValue, s.name]))

  for (const d of expiring) {
    const name = nameMap.get(d.renderValue) ?? d.renderValue
    // fire-and-forget 通知（复用 createAndPush，type=system）
    createAndPush({ userId: d.userId, type: NotificationType.SYSTEM, content: noticeContent(d.type, name) })
    // 幂等标记：无论通知成败都置位，避免失败项每轮重试轰炸（通知失败会记日志，见 createAndPush）
    await prisma.userDecoration.update({
      where: { id: d.id },
      data: { expiredNotifiedAt: new Date() },
    })
  }

  return expiring.length
}
