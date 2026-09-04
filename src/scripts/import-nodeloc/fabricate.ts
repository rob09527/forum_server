/**
 * 阶段 2.5 造数:给已导入的 NodeLoc 影子内容补齐「社区运营痕迹」。
 *
 * 运行(必须在回填全部完成、增量 worker 尚未启动时执行一次):
 *   pnpm tsx src/scripts/import-nodeloc/fabricate.ts
 *   pnpm tsx src/scripts/import-nodeloc/fabricate.ts --reset   # 先清掉上次造的数再重造
 *
 * 只读写本地库,不联网、不碰导入器/增量 worker 的模块。
 *
 * 执行顺序是硬约束(计划文件「阶段 2.5」),不能调换:
 *   ① 全员积分重放  → 有余额才谈得上花钱
 *   ② 造关注        → 关注不花钱,但拓扑来自同帖互动,要在积分之后统计才不重复扫表
 *   ③ 造打赏        → 花的是 ① 挣的余额
 *   ④ 消费买装扮    → 花的是 ①+③ 之后的余额,买不起就不买
 *
 * [合理例外] 三点偏离线上真实路径,均为「重放历史」的必然结果:
 * 1. 不走 points.service 的 earnPoints/spendPoints/creditPoints,改为批量直写 PointLog:
 *    真实路径每笔都要一次 Redis getLevels() + 一次 user.update,几十万笔重放不可接受。
 *    本脚本一次性载入等级表,在内存里连 balanceAfter 链,最后每人一次聚合更新,
 *    产物与真实路径同构 —— pnpm points:audit 三条不变量成立(见文末自检)。
 * 2. 不写 Redis 当日计数 point_daily:*(决策 11:重放不设上限;历史日期写计数键
 *    只会污染真实用户的当日限额)。
 * 3. 全程零通知:重放会一次性生成几十万条历史互动,发通知等于给影子用户刷屏,
 *    且影子账号没人登录,通知没有消费方。
 *
 * 幂等性:检测到影子用户已有积分流水就拒绝执行,避免二次重放把余额翻倍;
 * 需要重来时用 --reset(只删影子用户自己的流水/打赏/关注/装饰,不动真实用户)。
 */

import { prisma } from '../../lib/prisma.js'
import { PointType } from '../../constants/business.js'
import { getLevels, getTipConfig } from '../../services/config/config.service.js'
import { levelForTotal, POINT_RULES } from '../../services/points/points.service.js'
import { IMPORT_SOURCE } from '../../services/import/import-config.js'

// ── 造数参数(集中在此,禁止散落到函数体内)──────────────────────────

/** 随机种子:固定值保证同一份内容多次重跑造出同一批数据(便于对账与复现) */
const SEED = 20260902

/** 被赞积分聚合流水的时间偏移(ms):发言时刻 +1h,避免与发言流水同秒难以排序 */
const LIKED_LOG_OFFSET_MS = 60 * 60 * 1000

/** 单用户最多关注多少人(防止高频互动者关注列表爆到几百) */
const MAX_FOLLOWING_PER_USER = 40

/** 同帖互动 n 次时的关注概率:基础 + 每次递增,上限 0.75 */
const FOLLOW_PROB_BASE = 0.22
const FOLLOW_PROB_PER_INTERACTION = 0.14
const FOLLOW_PROB_CAP = 0.75

/** 关注行为发生在「最后一次互动之后」的随机窗口(天) */
const FOLLOW_DELAY_MAX_DAYS = 30

/** 打赏候选门槛:帖子点赞数 / 评论点赞数(低于此不认为「值得打赏」) */
const TIP_POST_MIN_LIKES = 3
const TIP_COMMENT_MIN_LIKES = 2

/** 达到门槛后实际产生打赏的概率(帖子 / 评论) */
const TIP_POST_PROB = 0.06
const TIP_COMMENT_PROB = 0.03

/** 打赏金额权重(金额取自 config:tip 的 amounts,小额为主) */
const TIP_AMOUNT_WEIGHTS = [0.65, 0.28, 0.07]

/** 打赏发生在「双方最后一笔流水之后」的随机窗口(小时) */
const TIP_DELAY_MAX_HOURS = 72

/** 余额达到「价格 × 此倍数」才舍得买装扮(留够日常余量) */
const SHOP_AFFORD_MULTIPLIER = 2

/** 买得起的人里实际下单的比例(不是人人都爱装扮) */
const SHOP_BUY_PROB = 0.7

/** 装扮购买时间回溯窗口(天):必须够近,否则 expireAt 已过期、装扮不可见 */
const SHOP_PURCHASE_WINDOW_DAYS = 7

/** 批量写库分片大小 */
const CHUNK = 2000

// ── 工具 ────────────────────────────────────────────────────────────

/** mulberry32:小而稳的确定性 PRNG,保证造数可复现 */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = makeRandom(SEED)

/** 按权重挑一个下标 */
function weightedPick(weights: number[]): number {
  const total = weights.reduce((s, w) => s + w, 0)
  let r = rand() * total
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!
    if (r <= 0) return i
  }
  return weights.length - 1
}

function chunked<T>(rows: T[], size = CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

/** 影子用户运行时状态:内存里连账,最后一次性落库 */
interface UserState {
  /** 本地 users.id */
  id: number
  /** 鸡腿余额(= SUM(point_logs.delta),审计不变量 1) */
  balance: number
  /** 累计获得(= SUM(收入侧 delta),审计不变量 2,等级依据) */
  totalEarned: number
  /** 已产生的最后一笔流水时间,新流水必须晚于它(审计不变量 3 的排序口径) */
  lastLogAt: Date
  /** 已关注人数,用于 MAX_FOLLOWING_PER_USER 限流 */
  followingCount: number
}

/** 待写入的积分流水(balanceAfter 已在内存连好链) */
interface PendingLog {
  userId: number
  type: string
  delta: number
  balanceAfter: number
  refId: number | null
  createdAt: Date
}

/** 每个用户一条数组,数组内严格按 createdAt 升序;落库时按此顺序 insert 保证 id 同序递增 */
const logsByUser = new Map<number, PendingLog[]>()

const states = new Map<number, UserState>()

/**
 * 记一笔流水并同步内存账。
 * 调用方必须保证同一用户的调用顺序 = 时间升序(审计不变量 3 按 (userId, createdAt, id) 排序,
 * 落库时 id 按数组顺序递增,两者必须一致)。
 */
function pushLog(
  userId: number,
  type: string,
  delta: number,
  refId: number | null,
  createdAt: Date,
): void {
  const st = states.get(userId)
  if (!st) throw new Error(`pushLog: 未知用户 #${userId}`)
  st.balance += delta
  if (INCOME_TYPES.has(type)) st.totalEarned += delta
  if (createdAt > st.lastLogAt) st.lastLogAt = createdAt

  let list = logsByUser.get(userId)
  if (!list) {
    list = []
    logsByUser.set(userId, list)
  }
  list.push({ userId, type, delta, balanceAfter: st.balance, refId, createdAt })
}

/** 收入侧类型(与 scripts/audit-points.ts 的 INCOME_TYPES 同一口径) */
const INCOME_TYPES = new Set<string>([
  PointType.CHECKIN,
  PointType.POST,
  PointType.COMMENT,
  PointType.LIKED,
  PointType.TRANSFER,
])

// ── 步骤 0:载入影子用户 ────────────────────────────────────────────

/** 载入结果:参与造数的影子用户 + 全额豁免的占位账号 */
interface ShadowSet {
  /** 参与造数的影子用户 id(sourceUserId >= 0) */
  active: number[]
  /** 占位账号「已注销用户」的 id(sourceUserId < 0),全程豁免,余额必须保持 0 */
  placeholders: Set<number>
}

async function loadShadowUsers(): Promise<ShadowSet> {
  const mappings = await prisma.importUserMapping.findMany({
    where: { source: IMPORT_SOURCE },
    select: { localUserId: true, sourceUserId: true },
  })
  const active: number[] = []
  const placeholders = new Set<number>()
  for (const m of mappings) {
    // 占位账号权威判据是 sourceUserId < 0(PLACEHOLDER_SOURCE_ID = -1),不靠 email 前缀猜
    if (m.sourceUserId < 0) placeholders.add(m.localUserId)
    else active.push(m.localUserId)
  }
  return { active, placeholders }
}

/** --reset:只清影子用户自己造出来的数据,真实用户与 admin 表一律不动 */
async function resetFabricated(shadow: ShadowSet): Promise<void> {
  const all = [...shadow.active, ...shadow.placeholders]
  const decorations = await prisma.userDecoration.findMany({
    where: { userId: { in: all } },
    select: { userId: true },
  })
  await prisma.$transaction([
    prisma.pointLog.deleteMany({ where: { userId: { in: all } } }),
    prisma.tip.deleteMany({ where: { fromUserId: { in: all } } }),
    prisma.follow.deleteMany({ where: { followerId: { in: all } } }),
    prisma.userDecoration.deleteMany({ where: { userId: { in: all } } }),
    prisma.user.updateMany({
      where: { id: { in: all } },
      data: {
        points: 0,
        totalPointsEarned: 0,
        level: 'claw',
        followerCount: 0,
        followingCount: 0,
        decorColorValue: null,
        decorColorExpireAt: null,
        decorTitleValue: null,
        decorTitleStyle: null,
        decorTitleExpireAt: null,
        decorAvatarValue: null,
        decorAvatarExpireAt: null,
      },
    }),
  ])
  console.log(
    `[fabricate] --reset 已清理 ${all.length} 位影子用户的流水/打赏/关注/装饰(${decorations.length} 条装饰)`,
  )
  // 打赏冗余列跟着回零(仅影子内容会被造数打赏,真实内容不受影响)
  await recomputeTipAggregates()
}

// ── 步骤 ①:全员积分重放 ────────────────────────────────────────────

/** 重放事件:一条待生成的收入侧流水 */
interface EarnEvent {
  type: string
  delta: number
  refId: number
  at: Date
}

/**
 * 按发言时间序重放收入侧积分:
 * - 每篇帖子 +10(POINT_RULES.post)
 * - 每条评论 +3(POINT_RULES.comment)
 * - 被赞按内容聚合成一条 LIKED 流水(delta = likeCount × 1),时间取发言时刻 +1h
 *
 * 被赞为什么聚合:Discourse 只给出点赞总数、给不出「谁在什么时候赞的」,
 * 逐条造假 like 流水既无依据也会把流水表撑到百万级;聚合一条既保住
 * SUM(delta) 口径,也让用户积分明细页可读(「你的帖子共获 12 次点赞 +12」)。
 */
async function replayPoints(shadow: ShadowSet): Promise<void> {
  const eventsByUser = new Map<number, EarnEvent[]>()
  const add = (userId: number, ev: EarnEvent): void => {
    if (shadow.placeholders.has(userId)) return // 占位账号全额豁免
    if (!states.has(userId)) return // 非影子用户(真实用户)不重放
    let list = eventsByUser.get(userId)
    if (!list) {
      list = []
      eventsByUser.set(userId, list)
    }
    list.push(ev)
  }

  const posts = await prisma.post.findMany({
    where: { authorId: { in: [...states.keys()] } },
    select: { id: true, authorId: true, createdAt: true, likeCount: true },
  })
  for (const p of posts) {
    add(p.authorId, { type: PointType.POST, delta: POINT_RULES[PointType.POST].delta, refId: p.id, at: p.createdAt })
    if (p.likeCount > 0) {
      add(p.authorId, {
        type: PointType.LIKED,
        delta: p.likeCount * POINT_RULES[PointType.LIKED].delta,
        refId: p.id,
        at: new Date(p.createdAt.getTime() + LIKED_LOG_OFFSET_MS),
      })
    }
  }

  const comments = await prisma.comment.findMany({
    where: { authorId: { in: [...states.keys()] } },
    select: { id: true, authorId: true, createdAt: true, likeCount: true },
  })
  for (const c of comments) {
    add(c.authorId, {
      type: PointType.COMMENT,
      delta: POINT_RULES[PointType.COMMENT].delta,
      refId: c.id,
      at: c.createdAt,
    })
    if (c.likeCount > 0) {
      add(c.authorId, {
        type: PointType.LIKED,
        delta: c.likeCount * POINT_RULES[PointType.LIKED].delta,
        refId: c.id,
        at: new Date(c.createdAt.getTime() + LIKED_LOG_OFFSET_MS),
      })
    }
  }

  for (const [userId, events] of eventsByUser) {
    // 排序口径必须与 audit-points.ts 一致:createdAt 升序,同秒按插入序(落库后即 id 序)
    events.sort((a, b) => a.at.getTime() - b.at.getTime())
    for (const ev of events) pushLog(userId, ev.type, ev.delta, ev.refId, ev.at)
  }

  console.log(
    `[fabricate] ① 积分重放:${posts.length} 帖 + ${comments.length} 评论 → ${[...logsByUser.values()].reduce((s, l) => s + l.length, 0)} 条流水`,
  )
}

// ── 步骤 ②:同帖互动拓扑造关注 ──────────────────────────────────────

/**
 * 关注关系来自真实互动拓扑,不随机连边:
 * - 评论者 → 帖子作者(读到内容、有回应,最自然的关注动机)
 * - 楼中楼回复者 → 被回复的评论作者
 * 同一对互动越多次,关注概率越高;关注时间落在最后一次互动之后。
 */
async function fabricateFollows(shadow: ShadowSet): Promise<number> {
  const posts = await prisma.post.findMany({ select: { id: true, authorId: true } })
  const authorByPost = new Map(posts.map((p) => [p.id, p.authorId]))

  const comments = await prisma.comment.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, postId: true, authorId: true, parentId: true, createdAt: true },
  })
  const commentAuthor = new Map(comments.map((c) => [c.id, c.authorId]))

  /** key = `${follower}:${followee}` → 互动次数与最后互动时间 */
  const pairs = new Map<string, { follower: number; followee: number; count: number; lastAt: Date }>()
  const bump = (follower: number, followee: number, at: Date): void => {
    if (follower === followee) return
    // 关注方必须是影子用户(我们不替真实用户造行为);被关注方可以是任何人
    if (!states.has(follower)) return
    if (shadow.placeholders.has(follower) || shadow.placeholders.has(followee)) return
    const key = `${follower}:${followee}`
    const prev = pairs.get(key)
    if (prev) {
      prev.count++
      if (at > prev.lastAt) prev.lastAt = at
    } else {
      pairs.set(key, { follower, followee, count: 1, lastAt: at })
    }
  }

  for (const c of comments) {
    const postAuthor = authorByPost.get(c.postId)
    if (postAuthor !== undefined) bump(c.authorId, postAuthor, c.createdAt)
    if (c.parentId !== null) {
      const parentAuthor = commentAuthor.get(c.parentId)
      if (parentAuthor !== undefined) bump(c.authorId, parentAuthor, c.createdAt)
    }
  }

  // 互动次数多的优先成边,避免额度被偶然的一次互动占满
  const candidates = [...pairs.values()].sort((a, b) => b.count - a.count)
  const now = Date.now()
  const rows: { followerId: number; followeeId: number; createdAt: Date }[] = []
  const seen = new Set<string>()

  for (const cand of candidates) {
    const st = states.get(cand.follower)!
    if (st.followingCount >= MAX_FOLLOWING_PER_USER) continue
    const prob = Math.min(
      FOLLOW_PROB_CAP,
      FOLLOW_PROB_BASE + FOLLOW_PROB_PER_INTERACTION * (cand.count - 1),
    )
    if (rand() >= prob) continue

    const key = `${cand.follower}:${cand.followee}`
    if (seen.has(key)) continue // Follow @@unique([followerId, followeeId])
    seen.add(key)

    const delay = rand() * FOLLOW_DELAY_MAX_DAYS * 86400_000
    const at = new Date(Math.min(now, cand.lastAt.getTime() + delay))
    rows.push({ followerId: cand.follower, followeeId: cand.followee, createdAt: at })
    st.followingCount++
  }

  for (const batch of chunked(rows)) {
    await prisma.follow.createMany({ data: batch, skipDuplicates: true })
  }
  console.log(`[fabricate] ② 关注:${candidates.length} 组互动 → ${rows.length} 条关注`)
  return rows.length
}

/** 从 follows 实际行数重算 users 上的冗余计数,不做增量推导 */
async function recomputeFollowCounts(): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "users" u SET
      "followingCount" = COALESCE((SELECT COUNT(*) FROM "follows" f WHERE f."followerId" = u."id"), 0),
      "followerCount"  = COALESCE((SELECT COUNT(*) FROM "follows" f WHERE f."followeeId" = u."id"), 0)
  `
}

// ── 步骤 ③:造打赏 ──────────────────────────────────────────────────

/** 打赏候选:一条「值得打赏」的内容 + 它的潜在打赏人池 */
interface TipCandidate {
  targetType: 'post' | 'comment'
  targetId: number
  authorId: number
  /** 内容发布时间,打赏不能早于它 */
  contentAt: Date
  /** 潜在打赏人(同帖互动过的人),按互动先后排列 */
  pool: number[]
  prob: number
}

/**
 * 打赏只发生在「同帖出现过的人」之间(读过内容才会打赏),金额取 config:tip 的档位。
 * 扣款走 tip_out(只减余额)、到账走 tip_in(只加余额、不计累计),与 tip.service 同构;
 * 帖子打赏还要按 heatBase + min(金额, heatCap) 增热度,与真实路径完全一致。
 */
async function fabricateTips(shadow: ShadowSet): Promise<number> {
  const cfg = await getTipConfig()
  const amounts = cfg.amounts

  const posts = await prisma.post.findMany({
    select: { id: true, authorId: true, createdAt: true, likeCount: true },
  })
  const comments = await prisma.comment.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, postId: true, authorId: true, createdAt: true, likeCount: true },
  })

  /** 每帖参与者(作者 + 全部评论者),作为打赏人池 */
  const participants = new Map<number, number[]>()
  const pushParticipant = (postId: number, userId: number): void => {
    let list = participants.get(postId)
    if (!list) {
      list = []
      participants.set(postId, list)
    }
    if (!list.includes(userId)) list.push(userId)
  }
  for (const p of posts) pushParticipant(p.id, p.authorId)
  for (const c of comments) pushParticipant(c.postId, c.authorId)

  const candidates: TipCandidate[] = []
  for (const p of posts) {
    if (p.likeCount < TIP_POST_MIN_LIKES) continue
    candidates.push({
      targetType: 'post',
      targetId: p.id,
      authorId: p.authorId,
      contentAt: p.createdAt,
      pool: participants.get(p.id) ?? [],
      prob: TIP_POST_PROB,
    })
  }
  for (const c of comments) {
    if (c.likeCount < TIP_COMMENT_MIN_LIKES) continue
    candidates.push({
      targetType: 'comment',
      targetId: c.id,
      authorId: c.authorId,
      contentAt: c.createdAt,
      pool: participants.get(c.postId) ?? [],
      prob: TIP_COMMENT_PROB,
    })
  }
  // 按内容时间升序处理:同一用户的 tip_out/tip_in 流水才能自然递增
  candidates.sort((a, b) => a.contentAt.getTime() - b.contentAt.getTime())

  const now = Date.now()
  const tipRows: {
    fromUserId: number
    toUserId: number
    targetType: string
    targetId: number
    amount: number
    createdAt: Date
  }[] = []
  /** 打赏带来的热度增量:postId → 累加值 */
  const heatDelta = new Map<number, number>()
  const used = new Set<string>() // Tip @@unique([fromUserId, targetType, targetId])

  for (const cand of candidates) {
    if (shadow.placeholders.has(cand.authorId)) continue
    if (rand() >= cand.prob) continue

    const pool = cand.pool.filter(
      (u) => u !== cand.authorId && states.has(u) && !shadow.placeholders.has(u),
    )
    if (pool.length === 0) continue
    const from = pool[Math.floor(rand() * pool.length)]!
    const key = `${from}:${cand.targetType}:${cand.targetId}`
    if (used.has(key)) continue

    const amount = amounts[weightedPick(TIP_AMOUNT_WEIGHTS.slice(0, amounts.length))] ?? amounts[0]!
    const fromState = states.get(from)!
    if (fromState.balance < amount) continue // 余额不足就不打赏,绝不造负余额

    const toState = states.get(cand.authorId)
    if (!toState) continue

    // 时间必须晚于双方最后一笔流水(否则 balanceAfter 链断),也不能早于内容本身
    const floor = Math.max(
      cand.contentAt.getTime(),
      fromState.lastLogAt.getTime(),
      toState.lastLogAt.getTime(),
    )
    const at = new Date(Math.min(now, floor + 1000 + rand() * TIP_DELAY_MAX_HOURS * 3600_000))

    used.add(key)
    pushLog(from, PointType.TIP_OUT, -amount, cand.targetId, at)
    pushLog(cand.authorId, PointType.TIP_IN, amount, cand.targetId, at)
    tipRows.push({
      fromUserId: from,
      toUserId: cand.authorId,
      targetType: cand.targetType,
      targetId: cand.targetId,
      amount,
      createdAt: at,
    })
    if (cand.targetType === 'post') {
      // 与 tip.service 一致:线性可增量的热度贡献
      const inc = cfg.heatBase + Math.min(amount, cfg.heatCap)
      heatDelta.set(cand.targetId, (heatDelta.get(cand.targetId) ?? 0) + inc)
    }
  }

  for (const batch of chunked(tipRows)) {
    await prisma.tip.createMany({ data: batch, skipDuplicates: true })
  }
  for (const [postId, inc] of heatDelta) {
    await prisma.post.update({ where: { id: postId }, data: { heatScore: { increment: inc } } })
  }
  console.log(
    `[fabricate] ③ 打赏:${candidates.length} 个候选内容 → ${tipRows.length} 笔打赏,${heatDelta.size} 篇帖子加热度`,
  )
  return tipRows.length
}

/** 从 tips 实际行重算帖子/评论的打赏冗余列,不做增量推导 */
async function recomputeTipAggregates(): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "posts" p SET
      "tipCount"  = COALESCE(t.cnt, 0),
      "tipAmount" = COALESCE(t.sum, 0)
    FROM (SELECT "targetId", COUNT(*) AS cnt, SUM("amount") AS sum
          FROM "tips" WHERE "targetType" = 'post' GROUP BY "targetId") t
    WHERE p."id" = t."targetId"
  `
  await prisma.$executeRaw`
    UPDATE "comments" c SET
      "tipCount"  = COALESCE(t.cnt, 0),
      "tipAmount" = COALESCE(t.sum, 0)
    FROM (SELECT "targetId", COUNT(*) AS cnt, SUM("amount") AS sum
          FROM "tips" WHERE "targetType" = 'comment' GROUP BY "targetId") t
    WHERE c."id" = t."targetId"
  `
}

// ── 步骤 ④:消费买装扮 ──────────────────────────────────────────────

/**
 * 攒够钱的人买装扮:买得起(余额 ≥ 价 × 2)的人里按概率下单,买最贵的那件。
 * 购买时间必须落在最近 SHOP_PURCHASE_WINDOW_DAYS 天内 —— 装饰有 durationDays 有效期,
 * 时间放到一年前的话 expireAt 早已过期,装扮不会显示,造数等于白造。
 */
async function fabricateShopPurchases(shadow: ShadowSet): Promise<number> {
  const items = await prisma.shopItem.findMany({
    where: { isActive: true, price: { gt: 0 } },
    orderBy: { price: 'desc' },
    select: { id: true, type: true, renderValue: true, renderStyle: true, price: true, durationDays: true },
  })
  if (items.length === 0) {
    console.log('[fabricate] ④ 消费:shop_items 无可售商品,跳过')
    return 0
  }

  const now = Date.now()
  const windowMs = SHOP_PURCHASE_WINDOW_DAYS * 86400_000
  const decorRows: {
    userId: number
    itemId: number
    type: string
    renderValue: string
    renderStyle: string | null
    price: number
    startAt: Date
    expireAt: Date
  }[] = []
  /** 佩戴槽更新:userId → user.update 的 data */
  const decorUpdates = new Map<number, Record<string, unknown>>()

  // 按 id 升序遍历,保证同一份数据多次重跑挑中同一批人
  for (const userId of [...states.keys()].sort((a, b) => a - b)) {
    if (shadow.placeholders.has(userId)) continue
    const st = states.get(userId)!
    const item = items.find((it) => st.balance >= it.price * SHOP_AFFORD_MULTIPLIER)
    if (!item) continue
    if (rand() >= SHOP_BUY_PROB) continue

    // 购买时间:最近 7 天内,且必须晚于该用户最后一笔流水
    const floor = Math.max(now - windowMs, st.lastLogAt.getTime() + 1000)
    if (floor >= now) continue // 该用户最后一笔流水就在此刻之后(极端情况),跳过
    const at = new Date(floor + rand() * (now - floor))
    const expireAt = new Date(at.getTime() + item.durationDays * 86400_000)

    pushLog(userId, PointType.SHOP, -item.price, item.id, at)
    decorRows.push({
      userId,
      itemId: item.id,
      type: item.type,
      renderValue: item.renderValue,
      renderStyle: item.renderStyle,
      price: item.price,
      startAt: at,
      expireAt,
    })
    // 购买即佩戴,字段映射与 shop.service.buyDecoration 保持一致
    decorUpdates.set(
      userId,
      item.type === 'username_color'
        ? { decorColorValue: item.renderValue, decorColorExpireAt: expireAt }
        : item.type === 'avatar'
          ? { decorAvatarValue: item.renderValue, decorAvatarExpireAt: expireAt }
          : {
              decorTitleValue: item.renderValue,
              decorTitleStyle: item.renderStyle ?? null,
              decorTitleExpireAt: expireAt,
            },
    )
  }

  for (const batch of chunked(decorRows)) {
    await prisma.userDecoration.createMany({ data: batch, skipDuplicates: true })
  }
  for (const [userId, data] of decorUpdates) {
    await prisma.user.update({ where: { id: userId }, data })
  }
  console.log(`[fabricate] ④ 消费:${decorRows.length} 位用户买入并佩戴装扮`)
  return decorRows.length
}

// ── 落库 ────────────────────────────────────────────────────────────

/**
 * 写流水与用户聚合。
 * 每个用户的流水按数组顺序(= createdAt 升序)插入,使自增 id 与时间同序 ——
 * audit-points.ts 不变量 3 按 (userId, createdAt asc, id asc) 验链,顺序错了就会报断裂。
 */
async function persist(): Promise<void> {
  const levels = await getLevels() // [合理例外] 只读一次,不像真实路径每笔都读 Redis
  let written = 0

  for (const [, logs] of logsByUser) {
    for (const batch of chunked(logs)) {
      await prisma.pointLog.createMany({ data: batch })
      written += batch.length
    }
  }

  for (const st of states.values()) {
    await prisma.user.update({
      where: { id: st.id },
      data: {
        points: st.balance,
        totalPointsEarned: st.totalEarned,
        level: levelForTotal(st.totalEarned, levels),
      },
    })
  }
  console.log(`[fabricate] 落库:${written} 条流水,${states.size} 位用户余额/累计/等级已更新`)
}

// ── 入口 ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const reset = process.argv.includes('--reset')

  const shadow = await loadShadowUsers()
  if (shadow.active.length === 0) {
    throw new Error('未找到影子用户(import_user_mappings 为空),请先完成阶段 2 回填')
  }
  console.log(
    `[fabricate] 影子用户 ${shadow.active.length} 位,占位账号 ${shadow.placeholders.size} 个(全额豁免)`,
  )

  if (reset) await resetFabricated(shadow)

  // 幂等守卫:已有流水说明造过数(或增量 worker 已发过分),再跑一次会把余额翻倍
  const existing = await prisma.pointLog.count({
    where: { userId: { in: [...shadow.active, ...shadow.placeholders] } },
  })
  if (existing > 0) {
    throw new Error(
      `影子用户已有 ${existing} 条积分流水,拒绝重复重放。确认要重造请加 --reset(只清影子用户数据)`,
    )
  }

  const users = await prisma.user.findMany({
    where: { id: { in: shadow.active } },
    select: { id: true },
  })
  const epoch = new Date(0)
  for (const u of users) {
    states.set(u.id, { id: u.id, balance: 0, totalEarned: 0, lastLogAt: epoch, followingCount: 0 })
  }

  await replayPoints(shadow)
  await fabricateFollows(shadow)
  await recomputeFollowCounts()
  await fabricateTips(shadow)
  await recomputeTipAggregates()
  await fabricateShopPurchases(shadow)
  await persist()

  // 占位账号必须一分钱没有:它是「已注销用户」的聚合体,给它发分等于给不存在的人发分
  const placeholderDirty = await prisma.user.count({
    where: { id: { in: [...shadow.placeholders] }, OR: [{ points: { not: 0 } }, { totalPointsEarned: { not: 0 } }] },
  })
  if (placeholderDirty > 0) {
    throw new Error(`占位账号被误发积分(${placeholderDirty} 个),请检查豁免逻辑`)
  }

  console.log('[fabricate] 完成。请接着跑:pnpm tsx src/scripts/import-nodeloc/verify.ts 与 pnpm points:audit')
}

await main()
  .catch((err) => {
    console.error('[fabricate] 执行失败:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
