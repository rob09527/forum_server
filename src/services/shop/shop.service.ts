import { prisma } from '../../lib/prisma.js'
import { PointType, ShopItemType } from '../../constants/business.js'
import type { ShopItemTypeType } from '../../constants/business.js'
import { ErrorCode } from '../../constants/error-codes.js'
import { NotFoundError, ForbiddenError } from '../../utils/errors.js'
import { spendPoints, getBalance } from '../points/points.service.js'
import { getShopConfig } from '../config/config.service.js'

/**
 * 装饰商城服务（docs/积分消费体系.md 2.2）。
 *
 * 产品核心（1.3）：
 * - 装饰一律时效制，不做永久；同类可持有多个（各自按到期时间自然失效），
 *   佩戴槽（用户表 decorTitle/decorColor）任意时刻只指向其中一个，可在「我的」切换 [产品调整]
 * - 购买即快照渲染值，之后商品改价/下架/改渲染值均不影响已持有者 [1.3.3]
 * - 过期不删记录，失效仅靠到期时间判定 [R46]，置灰展示 + 一键续费
 * - [R44] 消费只扣余额不动累计；[R45] 余额变动必写流水
 */

/** shop_items 行（$queryRaw FOR UPDATE 锁行读价，返回形状） */
type ShopItemRow = {
  id: number
  type: string
  renderValue: string
  renderStyle: string | null
  price: number
  durationDays: number
  isActive: boolean
}

/** 商城商品项（前台展示） */
export interface ShopItemDTO {
  id: number
  type: ShopItemTypeType
  name: string
  renderValue: string
  renderStyle: string | null
  price: number
  durationDays: number
}

/** 临近到期的装饰（顶栏 chip 小黄点 + 商城页横幅 [1.3.4]） */
export interface ExpiringDecoration {
  /** 持有记录 ID */
  id: number
  /** 装饰类型 */
  type: ShopItemTypeType
  /** 渲染值（商品名语义），如「幻紫」 */
  renderValue: string
  /** 到期时间 */
  expireAt: Date
  /** 距到期天数（向上取整） */
  daysLeft: number
}

/** 商城列表结果 */
export interface ShopListResult {
  /** 上架商品，按类型分组 + sortOrder 排序 */
  items: ShopItemDTO[]
  /** 当前用户余额（顶栏 chip）；未登录为 null */
  balance: number | null
  /** 当前用户临近到期的装饰（到期前 remindDays 天）；未登录为空数组 */
  expiringSoon: ExpiringDecoration[]
}

/** 我的装饰项 */
export interface MyDecorationItem {
  /** 持有记录 ID */
  id: number
  /** 商品 ID（续费需要） */
  itemId: number
  /** 装饰类型 */
  type: ShopItemTypeType
  /** 商品名（shop_items.name，seed 写入：称号中文名 / 颜色中文名 / 头像「风格-NN」；
   *  供「我的」直接展示，前端不再从 renderValue 反推；已删商品回退 renderValue） */
  name: string
  /** 购买时快照的渲染值 */
  renderValue: string
  /** 快照的样式 key（称号徽章配色），颜色类为 null */
  renderStyle: string | null
  /** 实付价格快照 */
  price: number
  /** 本次生效起始时间 */
  startAt: Date
  /** 到期时间；已过期不删记录，置灰展示 + 一键续费 [R46] */
  expireAt: Date
  /** 当前是否生效（expireAt > now） */
  active: boolean
  /** 是否为当前佩戴的装饰（与用户生效槽一致）；仅 active 时才有意义 */
  worn: boolean
}

/** 我的装饰：按类型分组 */
export interface MyDecorationGroup {
  type: ShopItemTypeType
  items: MyDecorationItem[]
}

/**
 * 购买 / 续费装饰。单事务：
 * 锁商品行读价 → 校验上架 → 条件扣款 [R44] → 佩戴（更新单槽）→ 写/续 UserDecoration。
 * 购买即佩戴新装饰，但不置旧同类失效（旧装饰按自身到期时间自然失效，可在「我的」切换）。
 * 返回扣款后余额 + 新的到期时间，前端同步顶栏 chip [3.1]。
 */
export async function buyDecoration(userId: number, itemId: number): Promise<{ balance: number; expireAt: Date }> {
  return prisma.$transaction(async (tx) => {
    // 1. 锁商品行读价 —— 扣款前先校验商品有效性与价格，避免「支付瞬间下架/改价」竞态 [1.10]
    const item = await tx.$queryRaw<ShopItemRow[]>`
      SELECT "id", "type", "renderValue", "renderStyle", "price", "durationDays", "isActive"
      FROM "shop_items" WHERE "id" = ${itemId} FOR UPDATE`
    const it = item[0]
    if (!it) throw new NotFoundError('商品', ErrorCode.ITEM_NOT_FOUND)
    if (!it.isActive) throw new ForbiddenError('商品已下架', ErrorCode.ITEM_NOT_ACTIVE)
    // 免费池头像禁止购买：永久有效不过期、不在商城售卖（个人资料直接选用）。
    // 防御直接调 API 绕过前端筛选（商城列表虽过滤 price>0，但商品行仍在库）。
    if (it.type === ShopItemType.AVATAR && it.price === 0) {
      throw new ForbiddenError('免费头像无需购买，永久有效，请在个人资料直接选择', ErrorCode.AVATAR_FREE_PURCHASE)
    }

    const now = new Date()
    const expireAt = new Date(now.getTime() + it.durationDays * 86400_000)

    // 2. 条件扣款 [R44]；refId 指向商品，商城流水可关联到具体商品
    await spendPoints(userId, PointType.SHOP, it.price, { refId: itemId }, tx)

    // 3. 单槽覆盖语义（1.3.3）：颜色/称号/头像各只保留一个生效槽
    // 头像写入 decorAvatarValue/ExpireAt（覆盖层），渲染时折叠覆盖 User.avatar（基础头像）
    const slotFields =
      it.type === ShopItemType.USERNAME_COLOR
        ? { decorColorValue: it.renderValue, decorColorExpireAt: expireAt }
        : it.type === ShopItemType.AVATAR
          ? { decorAvatarValue: it.renderValue, decorAvatarExpireAt: expireAt }
          : { decorTitleValue: it.renderValue, decorTitleStyle: it.renderStyle ?? null, decorTitleExpireAt: expireAt }
    await tx.user.update({ where: { id: userId }, data: slotFields })

    // 4. UserDecoration：一商品一行；续费延长 expireAt；购买新同类装饰不置旧行失效（多持有 [产品调整]）
    const prev = await tx.userDecoration.findUnique({ where: { userId_itemId: { userId, itemId } } })
    const realExpire = prev && prev.expireAt > now
      ? new Date(prev.expireAt.getTime() + it.durationDays * 86400_000) // 续费：从旧到期日叠加
      : expireAt // 首次购买：从购买时刻起算
    await tx.userDecoration.upsert({
      where: { userId_itemId: { userId, itemId } },
      update: {
        expireAt: realExpire,
        renderValue: it.renderValue,
        renderStyle: it.renderStyle ?? null,
        price: it.price,
      },
      create: {
        userId,
        itemId,
        type: it.type,
        renderValue: it.renderValue,
        renderStyle: it.renderStyle ?? null,
        price: it.price,
        startAt: now,
        expireAt: realExpire,
      },
    })
    // 多持有模型 [产品调整]：购买新装饰不再让同类旧装饰失效 —— 旧装饰按自身到期时间自然失效，
    // 用户可在「我的」里随时切换回仍有效的旧装饰（activateDecoration）。
    return { balance: await getBalance(tx, userId), expireAt: realExpire }
  })
}

/**
 * 商城商品列表（GET /api/shop/items，optionalAuth）。
 * viewerId 存在时额外返回余额 + 临近到期装饰（到期前 remindDays 天，[1.3.4] 顶栏小黄点）。
 */
export async function listShopItems(viewerId?: number): Promise<ShopListResult> {
  const items: ShopItemDTO[] = (await prisma.shopItem.findMany({
    where: { isActive: true },
    orderBy: [{ type: 'asc' }, { sortOrder: 'asc' }],
    select: {
      id: true,
      type: true,
      name: true,
      renderValue: true,
      renderStyle: true,
      price: true,
      durationDays: true,
    },
  })).map((r) => ({ ...r, type: r.type as ShopItemTypeType }))

  if (!viewerId) {
    return { items, balance: null, expiringSoon: [] }
  }

  const cfg = await getShopConfig()
  const now = new Date()
  const remindUntil = new Date(now.getTime() + cfg.remindDays * 86400_000)
  const [user, expiringRows] = await Promise.all([
    prisma.user.findUnique({ where: { id: viewerId }, select: { points: true } }),
    prisma.userDecoration.findMany({
      where: { userId: viewerId, expireAt: { gt: now, lte: remindUntil } },
      select: { id: true, type: true, renderValue: true, expireAt: true },
      orderBy: { expireAt: 'asc' },
    }),
  ])

  return {
    items,
    balance: user?.points ?? null,
    expiringSoon: expiringRows.map((d) => ({
      id: d.id,
      type: d.type as ShopItemTypeType,
      renderValue: d.renderValue,
      expireAt: d.expireAt,
      daysLeft: Math.max(1, Math.ceil((d.expireAt.getTime() - now.getTime()) / 86400_000)),
    })),
  }
}

/**
 * 我的装饰（GET /api/shop/mine，authenticate）。
 * 持有 + 过期全量返回（过期不删 [R46]），按类型分组、组内到期时间倒序；
 * active 标记供前端置灰 + 一键续费。
 */
export async function listMyDecorations(userId: number): Promise<MyDecorationGroup[]> {
  const [rows, user] = await Promise.all([
    prisma.userDecoration.findMany({
      where: { userId },
      orderBy: [{ type: 'asc' }, { expireAt: 'desc' }],
      select: {
        id: true,
        itemId: true,
        type: true,
        renderValue: true,
        renderStyle: true,
        price: true,
        startAt: true,
        expireAt: true,
      },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: { decorTitleValue: true, decorColorValue: true, decorAvatarValue: true },
    }),
  ])

  // 商品名批量取（称号中文名 / 颜色中文名 / 头像「风格-NN」）；itemId → name
  const itemIds = [...new Set(rows.map((r) => r.itemId))]
  const shopItems = itemIds.length
    ? await prisma.shopItem.findMany({ where: { id: { in: itemIds } }, select: { id: true, name: true } })
    : []
  const nameMap = new Map(shopItems.map((s) => [s.id, s.name]))

  const wornTitle = user?.decorTitleValue ?? null
  const wornColor = user?.decorColorValue ?? null
  const wornAvatar = user?.decorAvatarValue ?? null

  const now = Date.now()
  const groups = new Map<ShopItemTypeType, MyDecorationItem[]>()
  for (const r of rows) {
    const type = r.type as ShopItemTypeType
    const item: MyDecorationItem = {
      id: r.id,
      itemId: r.itemId,
      type,
      name: nameMap.get(r.itemId) ?? r.renderValue,
      renderValue: r.renderValue,
      renderStyle: r.renderStyle,
      price: r.price,
      startAt: r.startAt,
      expireAt: r.expireAt,
      active: r.expireAt.getTime() > now,
      worn: type === ShopItemType.TITLE
        ? wornTitle != null && wornTitle === r.renderValue
        : type === ShopItemType.AVATAR
          ? wornAvatar != null && wornAvatar === r.renderValue
          : wornColor != null && wornColor === r.renderValue,
    }
    const list = groups.get(type) ?? []
    list.push(item)
    groups.set(type, list)
  }

  return [...groups.entries()].map(([type, items]) => ({ type, items }))
}

/**
 * 切换佩戴已持有的装饰（多持有模型）。
 * 把用户佩戴槽（decorTitle / decorColor）指向指定持有记录的快照；到期时间沿用该记录自身，
 * 不改动任何 UserDecoration 行。已过期的装饰不可切换（需先续费）。
 */
export async function activateDecoration(userId: number, decorationId: number): Promise<{ expireAt: Date }> {
  const dec = await prisma.userDecoration.findUnique({ where: { id: decorationId } })
  if (!dec || dec.userId !== userId) throw new NotFoundError('装饰', ErrorCode.ITEM_NOT_FOUND)
  if (dec.expireAt.getTime() <= Date.now()) throw new ForbiddenError('该装饰已过期，请先续费', ErrorCode.ITEM_NOT_ACTIVE)

  await prisma.user.update({
    where: { id: userId },
    data: dec.type === ShopItemType.USERNAME_COLOR
      ? { decorColorValue: dec.renderValue, decorColorExpireAt: dec.expireAt }
      : dec.type === ShopItemType.AVATAR
        ? { decorAvatarValue: dec.renderValue, decorAvatarExpireAt: dec.expireAt }
        : { decorTitleValue: dec.renderValue, decorTitleStyle: dec.renderStyle ?? null, decorTitleExpireAt: dec.expireAt },
  })

  return { expireAt: dec.expireAt }
}

/**
 * 从免费头像池随机取一个（注册默认头像用）。
 * 免费 = type='avatar' 且 price=0 且上架。池为空（尚未播种/全设成付费）返回 null，调用方兜底。
 */
export async function pickRandomFreeAvatar(): Promise<string | null> {
  const rows = await prisma.shopItem.findMany({
    where: { type: ShopItemType.AVATAR, price: 0, isActive: true },
    select: { renderValue: true },
  })
  if (rows.length === 0) return null
  return rows[Math.floor(Math.random() * rows.length)].renderValue
}

/**
 * 判断某头像路径是否免费可自选。
 * - 无商品行（尚未播种）→ 视为免费（向后兼容，不锁改头像）；
 * - 有行 → 免费 = price=0 且上架（下架视为不可用，即便价格为 0）。
 */
export async function isAvatarFree(path: string): Promise<boolean> {
  const row = await prisma.shopItem.findFirst({
    where: { type: ShopItemType.AVATAR, renderValue: path },
    select: { price: true, isActive: true },
  })
  if (!row) return true
  return row.price === 0 && row.isActive
}
