import { randomUUID } from 'node:crypto'
import { prisma } from '../../lib/prisma.js'
import { redis } from '../../lib/redis.js'
import { RedisKey } from '../../constants/redis-keys.js'
import { PointType } from '../../constants/business.js'
import { fetchNodelocJson } from './nodeloc-client.js'
import {
  IMPORT_SOURCE,
  SYNC_POLL_INTERVAL_MS,
  SYNC_TOPIC_MATURITY_HOURS,
  SYNC_CANDIDATE_TTL_HOURS,
  SYNC_CANDIDATE_BATCH,
  SYNC_GATE_MIN_VIEWS,
  SYNC_GATE_MIN_LIKES,
  SYNC_GATE_MIN_POSTS_COUNT,
  SYNC_DAILY_TOPIC_QUOTA,
} from './import-config.js'
import { resolveCategory } from './category-map.js'
import { resolveTopicImages } from './import-images.js'
import { cleanMarkdown } from './clean-markdown.js'
import { resolvePostAuthor, getPlaceholderUser } from './shadow-users.js'
import { importTopic, buildTags, type ImportTopicResult } from './import-topic.js'
import { importEarn } from './import-points.js'
import { ImportLockLostError } from '../../utils/errors.js'
import { formatDateKey } from '../points/points.service.js'
import { indexPost, removePost } from '../search/search.service.js'
import type {
  DiscoursePost,
  DiscourseLatestPostsResponse,
  DiscourseTopicDetail,
} from './nodeloc-types.js'

/**
 * NodeLoc 增量同步 worker(计划阶段 3):轮询 /posts.json(全站最新 50 条楼层,含 raw),
 * 以对方全局递增 post id 为游标增量消费。决策 5/15:全量持续同步、持续运营。
 *
 * 事件分派:
 * - 未知主题的任何新楼层 → 整主题全量导入(importTopic)+ 发帖/评论积分重放
 * - 已知主题的新评论 → 单条落库(楼层分配对齐 comment.service 的 FOR UPDATE 口径)+ 评论积分
 * - 已知楼层 version 升高 → 编辑同步(正文 + 一楼的标题/标签);locked=true(本地管理动作)不覆盖(决策 9)
 * - deleted_at/user_deleted → 删除同步(评论删行减计数;一楼删则整帖下架)
 *
 * 分派判定与副作用刻意分离:判定全在 planOnePost/planCursor(**纯只读**,导出给
 * scripts/import-nodeloc/sync-dryrun.ts 做单轮干跑),写库只在 syncOnePost 之后的
 * append/update/remove 三个函数里。干跑因此走的是生产同一套判定代码,不是平行实现。
 *
 * ⚠️ hidden 的口径(D1):hidden 在 Discourse 多是被 flag 自动折叠的**可逆临时态**,
 * 而本地删除不可逆,所以 hidden **不进删除判据**。但新内容路径与回填严格对齐 ——
 * import-topic.ts:94/118 对 hidden 一楼返回 empty、hidden 回复直接过滤,即回填从不导入
 * 折叠内容,故这里未导入过的 hidden 楼层同样跳过,避免同一楼层「命运取决于被哪条路径抓到」。
 *
 * ⚠️ 新主题准入三层(用户拍板方案 2「每日配额 + 质量门槛」,20260903):
 * 成熟观察期 → 质量门槛 → 每日配额。阈值全在 import-config.ts,含实测依据。
 *
 * 1. **成熟观察期**:worker 在一楼发出后约 2 分钟就看到主题,那一刻 views/likes/posts_count
 *    **全是 0**(实测分桶见 import-config.ts),首见即判定会让门槛拒绝 100% 的主题。
 *    所以首见只把 topicId 登记进 Redis 候选池(HASH),满 SYNC_TOPIC_MATURITY_HOURS 后再评估。
 * 2. **质量门槛**:成熟后取 /t/{id}.json 的三项信号,同时达标才准入。
 * 3. **每日配额**:达标主题按本地日期计数,用满即当日不再导入新主题。
 *
 * ⚠️ 候选池为什么必须存在(这是「游标跳过即永久丢弃」那个陷阱的正解):
 * 游标是对方全局递增 post id,推进过去就回不来。调度者给的两个口径都有硬伤 ——
 * (a)「配额满就 skip 并推进游标」= 主题永久丢弃,而在有成熟期的前提下**首见时压根还没有
 * 判定依据**,等于随机丢;(b)「停轮不推进游标」= 源站约 104 新主题/天,配额 10 会无限积压
 * 且把评论/编辑/删除一起堵死(它们和新主题共用同一条游标)。
 * 候选池把「主题准入」从游标上**解耦**出来:游标照常推进(评论/编辑/删除永不受影响),
 * 待评估主题活在自己的 HASH 里,可以被反复重评;只有滞留超过 SYNC_CANDIDATE_TTL_HOURS
 * 才**显式丢弃并打日志**。既不丢有价值内容,也不会积压到追不上。
 *
 * ⚠️ 配额只管**新主题**(post_number===1 的未知主题)。两类不受限,都是刻意的:
 * - 已导入主题的新评论/编辑/删除:限了会让本地内容残缺
 * - 未知**旧**主题被顶(post_number>1 的未知主题):importTopic 用对方原始时间落库,
 *   帖子直接落在过去,冲不到首页「最新」,故无需配额。残留风险是它带着对方真实计数
 *   影响 sort=hot,这条与回填产物同源、已在 §2.5.6 记录,不在本次方案范围内。
 *
 * ⚠️ 时序约定:worker 必须在「全量回填 + 阶段 2.5 造数」完成后再启用,
 * 否则造数会与实时积分重放重复计账(见 docs/NodeLoc数据迁移手册.md)。
 *
 * ⚠️ 游标语义(排障必读):游标是**对方全局递增 post id**,存 Redis(无 TTL)。
 * 游标丢失(Redis 被清/换实例)的后果是「跳到最新、丢掉这段增量」,**不是重复计账**——
 * 方向上刻意选了漏而不是重,因为重复计账会污染积分账本且无法回滚。
 */

/** Redis 锁租约时长(秒)，任务可通过续租跨越单轮网络/数据库耗时。 */
const SYNC_LOCK_TTL_SEC = 180
const SYNC_LOCK_RENEW_MS = Math.floor((SYNC_LOCK_TTL_SEC * 1000) / 3)
const RELEASE_LOCK_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"
const RENEW_LOCK_SCRIPT =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end"
const ADVANCE_CURSOR_SCRIPT =
  "if redis.call('get', KEYS[1]) ~= ARGV[1] then return -1 end; " +
  "local current=redis.call('get', KEYS[2]); " +
  "if current and tonumber(current) and tonumber(current) >= tonumber(ARGV[2]) then return 0 end; " +
  "redis.call('set', KEYS[2], ARGV[2]); return 1"
const BUMP_QUOTA_SCRIPT =
  "if redis.call('get', KEYS[1]) ~= ARGV[1] then return -1 end; " +
  "local current=redis.call('get', KEYS[2]); " +
  "if current and tonumber(current) and tonumber(current) >= tonumber(ARGV[3]) then return 0 end; " +
  "local used=redis.call('incr', KEYS[2]); " +
  "if used == 1 then redis.call('expire', KEYS[2], ARGV[2]) end; " +
  "return used"

/** Prisma 唯一约束冲突：并发 worker/重试已完成同一来源事件时按幂等成功处理。 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  )
}

/**
 * 同一条 post 连续处理失败多少次后放弃并推进游标。
 * 防毒丸:某条 post 若因对方数据畸形而必然抛错,不加这个阈值会把游标永久钉住,
 * 之后所有增量都同步不进来(比丢一条严重得多)。
 */
const MAX_POST_RETRIES = 3

/** 进程内失败计数:sourcePostId → 连续失败次数(单实例 worker,无需持久化) */
const failureCount = new Map<number, number>()

/** 抓取全站最新楼层页(/posts.json,含 raw)。空页/请求失败归一为 null */
export async function fetchLatestPosts(): Promise<DiscoursePost[] | null> {
  const res = await fetchNodelocJson<DiscourseLatestPostsResponse>('/posts.json')
  if (!res?.latest_posts?.length) return null
  return res.latest_posts
}

/** 一轮的游标决策(只读,不写 Redis) */
export interface CursorPlan {
  /** cold-start = 游标缺失/损坏,只初始化不消费;consume = 正常增量消费 */
  mode: 'cold-start' | 'consume'
  /** 生效游标(cold-start 时为 null) */
  cursor: number | null
  /** cold-start 时应写入的游标值 = 本页最大 id */
  initTo?: number
  /** 待处理楼层,已按 id 升序 */
  pending: DiscoursePost[]
  /** 本页全为新增 → 可能已溢出 /posts.json 窗口而丢楼 */
  overflow: boolean
}

/**
 * 计算本轮游标与待处理楼层(**纯只读**:读 Redis 游标但不回写,由调用方决定是否落地)。
 *
 * 冷启动/游标损坏时**不回灌整页历史**(会与全量回填重复导入、重复计账),
 * 只把游标推到本页最大 id,此后才开始消费增量。
 * `override` 用于干跑手工指定起点复现问题,给了就不读 Redis。
 */
export async function planCursor(
  latest: DiscoursePost[],
  override?: number,
): Promise<CursorPlan> {
  let cursor: number
  if (override !== undefined) {
    cursor = override
  } else {
    const raw = await redis.get(RedisKey.importCursor(IMPORT_SOURCE))
    const parsed = Number(raw)
    // 除了「没有值」,还要防被写成非数字:Number(null)=NaN 时 `p.id > NaN` 恒为 false,
    // 会退化成静默永不同步(比冷启动更难发现)
    if (!raw || !Number.isFinite(parsed) || parsed <= 0) {
      return {
        mode: 'cold-start',
        cursor: null,
        initTo: latest.length > 0 ? Math.max(...latest.map((p) => p.id)) : undefined,
        pending: [],
        overflow: false,
      }
    }
    cursor = parsed
  }

  // 对方接口按新→旧返回,翻转成旧→新顺序消费,游标逐条推进
  const pending = latest.filter((p) => p.id > cursor).sort((a, b) => a.id - b.id)
  return {
    mode: 'consume',
    cursor,
    pending,
    overflow: pending.length > 0 && pending.length === latest.length,
  }
}

/**
 * 一次轮询处理的执行入口,由 index.ts 60s 调度器调用。
 * Redis SETNX 锁一石二鸟:多实例单飞 + 节拍降频(见 SYNC_LOCK_TTL_SEC)。
 * 进程崩溃时锁靠 TTL 自动过期,不会永久残留。
 */
export async function runImportSync(): Promise<void> {
  const lockKey = RedisKey.importSyncLock
  const owner = randomUUID()
  const locked = await redis.set(lockKey, owner, 'EX', SYNC_LOCK_TTL_SEC, 'NX')
  if (!locked) return

  let lost = false
  const assertLock = (): void => {
    if (lost) throw new ImportLockLostError()
  }
  const renewTimer = setInterval(() => {
    redis
      .eval(RENEW_LOCK_SCRIPT, 1, lockKey, owner, String(SYNC_LOCK_TTL_SEC))
      .then((result) => {
        if (Number(result) !== 1) {
          lost = true
          console.error('[import-sync] Redis 锁续租失败，停止本轮后续副作用')
        }
      })
      .catch((err: unknown) => {
        lost = true
        console.error('[import-sync] Redis 锁续租异常:', err)
      })
  }, SYNC_LOCK_RENEW_MS)

  try {
    await consumePendingPosts(assertLock, lockKey, owner)
    assertLock()
    await processTopicCandidates(assertLock, lockKey, owner)
  } finally {
    clearInterval(renewTimer)
    await redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, owner).catch((err: unknown) => {
      console.error('[import-sync] Redis 锁释放失败:', err)
    })
  }
}

/** 消费 /posts.json 增量楼层并推进游标(新主题准入不在这里,见 processTopicCandidates) */
async function consumePendingPosts(
  assertLock: () => void,
  lockKey: string,
  owner: string,
): Promise<void> {
  assertLock()
  const latest = await fetchLatestPosts()
  assertLock()
  if (!latest) return

  const cursorKey = RedisKey.importCursor(IMPORT_SOURCE)
  const plan = await planCursor(latest)
  assertLock()

  if (plan.mode === 'cold-start') {
    await advanceCursor(cursorKey, lockKey, owner, plan.initTo!)
    console.log(`[import-sync] 冷启动:游标初始化为 ${plan.initTo}(不回灌历史,历史由 backfill 负责)`)
    return
  }
  if (plan.pending.length === 0) return

  if (plan.overflow) {
    console.warn(
      `[import-sync] ⚠️ 本页 ${plan.pending.length} 条全为新增(游标 ${plan.cursor}),` +
        `可能已溢出 /posts.json 窗口而丢失中间楼层,建议缩短轮询间隔`,
    )
  }

  let done = 0
  for (const post of plan.pending) {
    assertLock()
    try {
      await syncOnePost(post, assertLock)
      failureCount.delete(post.id)
    } catch (err) {
      if (err instanceof ImportLockLostError) throw err
      const fails = (failureCount.get(post.id) ?? 0) + 1
      failureCount.set(post.id, fails)
      console.error(`[import-sync] post#${post.id} 处理失败(第 ${fails} 次):`, err)
      if (fails < MAX_POST_RETRIES) return
      console.error(`[import-sync] post#${post.id} 连续失败 ${fails} 次,跳过并推进游标`)
      failureCount.delete(post.id)
    }
    await advanceCursor(cursorKey, lockKey, owner, post.id)
    done++
  }
  console.log(
    `[import-sync] 本轮处理 ${done}/${plan.pending.length} 条,游标推进至 ${plan.pending[done - 1]?.id}`,
  )
}

/** 仅当租约仍属于当前 worker 且游标未倒退时推进游标。 */
async function advanceCursor(cursorKey: string, lockKey: string, owner: string, postId: number): Promise<void> {
  const result = Number(await redis.eval(ADVANCE_CURSOR_SCRIPT, 2, lockKey, cursorKey, owner, String(postId)))
  if (result !== 1) throw new ImportLockLostError()
}

/**
 * 单条楼层的分派决策(**纯只读**,不写库不写 Redis)。
 * 导出给干跑脚本用,生产路径 syncOnePost 也走它 —— 判定只有这一份实现,不会与干跑漂移。
 */
export type SyncAction =
  /** 无需动作,reason 是人类可读的原因(干跑输出用) */
  | { kind: 'skip'; reason: string }
  /** 删除同步:对方已删,本地要移除 */
  | { kind: 'delete'; mappingId: number; target: 'post' | 'comment'; localId: number }
  /** 编辑同步:对方 version 升高;target=gone 表示本地内容已不在(只推进版本号) */
  | {
      kind: 'edit'
      mappingId: number
      target: 'post' | 'comment' | 'gone'
      localId?: number
      fromVersion: number
      toVersion: number
    }
  /** 未知**旧**主题被顶:整主题导入 + 积分重放,不受门槛/配额约束(见文件头) */
  | { kind: 'import-topic'; topicId: number }
  /** 未知**新**主题(一楼首见):只登记进候选池,等成熟期后再评估门槛与配额 */
  | { kind: 'defer-topic'; topicId: number }
  /** 已知主题的新评论:parentId=null 为顶层楼层,否则挂在顶层祖先下 */
  | { kind: 'append-comment'; localPostId: number; parentId: number | null }

export async function planOnePost(post: DiscoursePost): Promise<SyncAction> {
  // 私信/站内信等非常规主题跳过
  if (post.topic_archetype && post.topic_archetype !== 'regular') {
    return { kind: 'skip', reason: `非普通主题(archetype=${post.topic_archetype})` }
  }

  const mapping = await prisma.importMapping.findUnique({
    where: { source_sourcePostId: { source: IMPORT_SOURCE, sourcePostId: post.id } },
    select: { id: true, locked: true, sourceVersion: true, localPostId: true, localCommentId: true },
  })

  // hidden 不在删除判据里(见文件头 D1 说明)
  const isDeleted = Boolean(post.deleted_at || post.user_deleted)
  const isHidden = Boolean(post.hidden)
  const version = post.version ?? 1

  if (mapping) {
    if (mapping.locked) {
      return { kind: 'skip', reason: '映射 locked:本地管理动作后不再覆盖(决策 9)' }
    }
    if (isDeleted) {
      const localId = mapping.localPostId ?? mapping.localCommentId
      if (!localId) {
        return { kind: 'skip', reason: '对方已删,本地内容此前已移除(映射两侧皆空)' }
      }
      return {
        kind: 'delete',
        mappingId: mapping.id,
        target: mapping.localPostId ? 'post' : 'comment',
        localId,
      }
    }
    // 折叠是可逆临时态:保留本地内容,不删也不覆盖(等对方取消折叠后按 version 正常同步)
    if (isHidden) return { kind: 'skip', reason: 'hidden 折叠态:保留本地内容,不删不覆盖' }
    if (version > mapping.sourceVersion && post.raw) {
      return {
        kind: 'edit',
        mappingId: mapping.id,
        target: mapping.localPostId ? 'post' : mapping.localCommentId ? 'comment' : 'gone',
        localId: mapping.localPostId ?? mapping.localCommentId ?? undefined,
        fromVersion: mapping.sourceVersion,
        toVersion: version,
      }
    }
    return { kind: 'skip', reason: `无变化(version ${version} ≤ 已记录 ${mapping.sourceVersion})` }
  }

  if (isDeleted) return { kind: 'skip', reason: '未导入过的删除事件,无事可做' }
  // 与 backfill 对齐:import-topic 从不导入 hidden 内容,增量侧同样不导入
  if (isHidden) return { kind: 'skip', reason: 'hidden 折叠态:与回填对齐,不导入' }

  // 排除分类预筛(post.category_id 由 /posts.json 提供;缺失时交给 importTopic 再判)
  if (post.category_id) {
    const category = await resolveCategory(post.category_id)
    if (category.excluded) {
      return { kind: 'skip', reason: `排除分类(对方 category_id=${post.category_id})` }
    }
  }

  const topicMapping = await prisma.importMapping.findFirst({
    where: { source: IMPORT_SOURCE, sourceTopicId: post.topic_id, localPostId: { not: null } },
    select: { localPostId: true, locked: true },
  })

  if (!topicMapping) {
    // 主题已在候选池:它的其它楼层此刻也一律不处理 —— 等成熟期评估通过后由
    // importTopic 把整主题(含这些楼层)一次性导入。漏了这条守卫,一楼被延迟的
    // 同时它的回复会从下面的「旧主题被顶」分支把整主题无门槛导进来,延迟形同虚设。
    if (await isPooledTopic(post.topic_id)) {
      return { kind: 'skip', reason: `主题 ${post.topic_id} 在候选池待评估,本楼层随主题一起导入` }
    }
    // 一楼首见 = 真正的新主题 → 走三层准入;post_number>1 的未知主题 = 旧主题被顶,
    // 用对方原始时间落库、冲不到首页,直接导入(见文件头)
    if (post.post_number === 1) return { kind: 'defer-topic', topicId: post.topic_id }
    return { kind: 'import-topic', topicId: post.topic_id }
  }

  if (topicMapping.locked) return { kind: 'skip', reason: '主题映射 locked' }
  if (!topicMapping.localPostId) return { kind: 'skip', reason: '主题映射无 localPostId' }
  // 一楼已导入却查不到自身映射属异常,防御跳过
  if (post.post_number === 1) return { kind: 'skip', reason: '一楼已导入却无自身映射(异常)' }
  if (!post.raw) return { kind: 'skip', reason: '楼层无 raw 正文' }

  return {
    kind: 'append-comment',
    localPostId: topicMapping.localPostId,
    parentId: await resolveParentComment(post),
  }
}

// ──────────────────────────────────────────────────────────────────────
// 候选池:新主题的成熟观察期 + 质量门槛 + 每日配额
// ──────────────────────────────────────────────────────────────────────

/** 候选池条目(存成 JSON 字符串) */
interface CandidateEntry {
  /** 首见时间(epoch ms),用于算滞留时长 → TTL 丢弃 */
  f: number
  /** 下次评估时间(epoch ms)。首见时 = f + 成熟期;门槛未过则顺延一个成熟期后重评 */
  n: number
}

/** 主题是否已在候选池(只读) */
async function isPooledTopic(topicId: number): Promise<boolean> {
  const raw = await redis.hget(RedisKey.importSyncCandidates(IMPORT_SOURCE), String(topicId))
  return raw !== null
}

/** 当日已用配额(只读)。计数器不存在视为 0 */
export async function readQuotaUsed(): Promise<number> {
  const raw = await redis.get(RedisKey.importSyncQuota(IMPORT_SOURCE, formatDateKey(new Date())))
  const used = Number(raw)
  // 被写脏时按「已用满」处理:宁可当天不导,也不要因 NaN 比较恒 false 而无限导入
  if (raw !== null && !Number.isFinite(used)) return SYNC_DAILY_TOPIC_QUOTA
  return Number.isFinite(used) ? used : 0
}

/** 单个成熟候选的评估结果 */
export interface CandidateDecision {
  topicId: number
  /** 首见至今的滞留小时数 */
  ageHours: number
  /** 门槛信号(fetch 失败时为 null) */
  signals: { views: number; likes: number; postsCount: number } | null
  verdict:
    | { kind: 'import' } // 门槛+配额都过 → 导入
    | { kind: 'reject-gate'; reason: string } // 门槛未过 → 顺延重评(或到期丢弃)
    | { kind: 'drop-expired'; reason: string } // 滞留超上限 → 永久丢弃
    | { kind: 'drop-missing' } // 主题在对方站已不可见(404/403)→ 丢弃
    | { kind: 'drop-excluded' } // 成熟后发现属排除分类 → 丢弃
}

/** 本轮候选池的整体决策(只读) */
export interface CandidatePlan {
  /** 池内总条目数 */
  poolSize: number
  /** 当日已用配额 / 上限 */
  quotaUsed: number
  quotaLimit: number
  /** 配额已用满 → 本轮完全不评估(省掉源站请求),池子原样保留到明天 */
  quotaExhausted: boolean
  /** 已到评估时间的候选数(未受 batch 截断前) */
  matured: number
  /** 本轮实际评估的决策,按首见时间升序(先到先得) */
  decisions: CandidateDecision[]
}

/** 干跑用的替身输入(与 planCursor 的 override 同一用意:复现/演练而不写状态) */
export interface CandidatePlanOverride {
  /** 替代 Redis 候选池内容,field=topicId、value=CandidateEntry 的 JSON */
  pool?: Record<string, string>
  /** 替代当日已用配额 */
  quotaUsed?: number
}

/**
 * 候选池评估(**纯只读**:读 Redis 池与配额、抓 /t/{id}.json,不写任何一处)。
 * 导出给 sync-dryrun.ts;生产路径 processTopicCandidates 也走它,判定只有这一份实现。
 *
 * 配额检查刻意放在抓取**之前**:用满就直接返回,一次源站请求都不发。
 * `override` 只给干跑用 —— 池子空的时候(worker 从未跑过)否则无从演示门槛与配额的判定。
 */
export async function planTopicCandidates(
  override?: CandidatePlanOverride,
): Promise<CandidatePlan> {
  const pool = override?.pool ?? (await redis.hgetall(RedisKey.importSyncCandidates(IMPORT_SOURCE)))
  const quotaUsed = override?.quotaUsed ?? (await readQuotaUsed())
  const base: CandidatePlan = {
    poolSize: Object.keys(pool).length,
    quotaUsed,
    quotaLimit: SYNC_DAILY_TOPIC_QUOTA,
    quotaExhausted: quotaUsed >= SYNC_DAILY_TOPIC_QUOTA,
    matured: 0,
    decisions: [],
  }
  if (base.quotaExhausted || base.poolSize === 0) return base

  const now = Date.now()
  const entries: { topicId: number; entry: CandidateEntry }[] = []
  for (const [field, raw] of Object.entries(pool)) {
    const topicId = Number(field)
    let entry: CandidateEntry | null = null
    try {
      entry = JSON.parse(raw) as CandidateEntry
    } catch {
      entry = null
    }
    // 条目损坏(手工改过/旧格式)按「刚首见」重置,而不是当场丢弃主题
    if (!entry || !Number.isFinite(entry.f) || !Number.isFinite(entry.n)) {
      entry = { f: now, n: now + SYNC_TOPIC_MATURITY_HOURS * 3600_000 }
    }
    if (!Number.isFinite(topicId)) continue
    if (entry.n > now) continue // 还没到评估时间
    entries.push({ topicId, entry })
  }
  entries.sort((a, b) => a.entry.f - b.entry.f) // 先到先得
  base.matured = entries.length

  const ttlMs = SYNC_CANDIDATE_TTL_HOURS * 3600_000
  let remaining = SYNC_DAILY_TOPIC_QUOTA - quotaUsed

  for (const { topicId, entry } of entries.slice(0, SYNC_CANDIDATE_BATCH)) {
    const ageHours = (now - entry.f) / 3600_000
    const expired = now - entry.f >= ttlMs

    const topic = await fetchNodelocJson<DiscourseTopicDetail>(`/t/${topicId}.json`)
    if (!topic) {
      base.decisions.push({ topicId, ageHours, signals: null, verdict: { kind: 'drop-missing' } })
      continue
    }
    const category = await resolveCategory(topic.category_id)
    if (category.excluded) {
      base.decisions.push({ topicId, ageHours, signals: null, verdict: { kind: 'drop-excluded' } })
      continue
    }

    const signals = {
      views: topic.views ?? 0,
      likes: topic.like_count ?? 0,
      postsCount: topic.posts_count ?? 0,
    }
    const misses: string[] = []
    if (signals.views < SYNC_GATE_MIN_VIEWS) misses.push(`views ${signals.views}<${SYNC_GATE_MIN_VIEWS}`)
    if (signals.likes < SYNC_GATE_MIN_LIKES) misses.push(`likes ${signals.likes}<${SYNC_GATE_MIN_LIKES}`)
    if (signals.postsCount < SYNC_GATE_MIN_POSTS_COUNT) {
      misses.push(`posts_count ${signals.postsCount}<${SYNC_GATE_MIN_POSTS_COUNT}`)
    }

    if (misses.length > 0) {
      base.decisions.push({
        topicId,
        ageHours,
        signals,
        verdict: expired
          ? { kind: 'drop-expired', reason: `滞留 ${ageHours.toFixed(1)}h 仍未达标(${misses.join('、')})` }
          : { kind: 'reject-gate', reason: misses.join('、') },
      })
      continue
    }

    // 门槛过了但配额已被本轮前面的候选吃完 → 留在池里等下一个评估窗口;
    // 除非已到滞留上限,那才丢弃(否则池子会因「达标量>配额」无限增长)
    if (remaining <= 0) {
      base.decisions.push({
        topicId,
        ageHours,
        signals,
        verdict: expired
          ? { kind: 'drop-expired', reason: `滞留 ${ageHours.toFixed(1)}h 且始终未抢到配额` }
          : { kind: 'reject-gate', reason: '达标但当日配额已用满,顺延重评' },
      })
      continue
    }

    remaining--
    base.decisions.push({ topicId, ageHours, signals, verdict: { kind: 'import' } })
  }
  return base
}

/**
 * 候选池执行:判定交给 planTopicCandidates,这里只落副作用
 * (导入主题 / 递增配额 / 增删候选池条目)。
 */
async function processTopicCandidates(
  assertLock: () => void,
  lockKey: string,
  owner: string,
): Promise<void> {
  assertLock()
  const plan = await planTopicCandidates()
  assertLock()
  if (plan.quotaExhausted) {
    if (plan.poolSize > 0) {
      console.log(
        `[import-sync] 当日新主题配额已用满(${plan.quotaUsed}/${plan.quotaLimit}),` +
          `候选池 ${plan.poolSize} 条留待明日`,
      )
    }
    return
  }
  if (plan.decisions.length === 0) return

  const poolKey = RedisKey.importSyncCandidates(IMPORT_SOURCE)
  const now = Date.now()

  for (const d of plan.decisions) {
    assertLock()
    switch (d.verdict.kind) {
      case 'import': {
        let result: ImportTopicResult
        try {
          result = await importTopic(d.topicId)
        } catch (err) {
          if (!isUniqueViolation(err)) throw err
          // 另一轮已先完成同一主题：重新读取映射，继续幂等的积分/索引/候选收尾。
          const existing = await prisma.importMapping.findFirst({
            where: { source: IMPORT_SOURCE, sourceTopicId: d.topicId, localPostId: { not: null } },
            select: { localPostId: true },
          })
          if (!existing?.localPostId) throw err
          result = { status: 'skipped', localPostId: existing.localPostId }
        }
        assertLock()
        if (!result.localPostId || (result.status !== 'imported' && result.status !== 'skipped')) {
          break
        }
        await replayTopicPoints(result.localPostId, assertLock)
        assertLock()
        if (result.status === 'imported') await reindexPost(result.localPostId)
        assertLock()
        await bumpQuota(RedisKey.importSyncLock, owner)
        assertLock()
        await redis.hdel(poolKey, String(d.topicId))
        console.log(
          `[import-sync] 新主题 ${d.topicId} 准入(观察 ${d.ageHours.toFixed(1)}h,` +
            `views=${d.signals?.views} likes=${d.signals?.likes} posts=${d.signals?.postsCount}),` +
            `配额 ${(await readQuotaUsed())}/${plan.quotaLimit}`,
        )
        break
      }
      case 'reject-gate':
        assertLock()
        // 顺延一个成熟期后重评:信号只会随时间增长,现在不达标不代表明天不达标
        await redis.hset(
          poolKey,
          String(d.topicId),
          JSON.stringify({
            f: now - d.ageHours * 3600_000,
            n: now + SYNC_TOPIC_MATURITY_HOURS * 3600_000,
          } satisfies CandidateEntry),
        )
        break
      case 'drop-expired':
        assertLock()
        await redis.hdel(poolKey, String(d.topicId))
        console.log(`[import-sync] 新主题 ${d.topicId} **永久丢弃**:${d.verdict.reason}`)
        break
      case 'drop-missing':
        assertLock()
        await redis.hdel(poolKey, String(d.topicId))
        console.log(`[import-sync] 新主题 ${d.topicId} 丢弃:对方站已不可见(404/403)`)
        break
      case 'drop-excluded':
        assertLock()
        await redis.hdel(poolKey, String(d.topicId))
        console.log(`[import-sync] 新主题 ${d.topicId} 丢弃:成熟后判定属排除分类`)
        break
    }
  }
}

/**
 * 递增当日配额计数器。TTL 取 48h(> 1 天),让计数器自然过期而不用手工清理;
 * 只在 key 首次创建时设 TTL,避免每次递增都把过期时间往后推。
 */
async function bumpQuota(lockKey: string, owner: string): Promise<void> {
  const key = RedisKey.importSyncQuota(IMPORT_SOURCE, formatDateKey(new Date()))
  const used = Number(
    await redis.eval(
      BUMP_QUOTA_SCRIPT,
      2,
      lockKey,
      key,
      owner,
      String(48 * 3600),
      String(SYNC_DAILY_TOPIC_QUOTA),
    ),
  )
  if (used < 0) throw new ImportLockLostError()
  // 0 means the quota was already full (normally a retry after a crash that
  // happened after the first bump); the candidate can still be finalized.
}

/** 把首见的新主题登记进候选池(幂等:已在池里则不覆盖,以免刷新首见时间导致永不到期) */
async function poolNewTopic(topicId: number, assertLock: () => void): Promise<void> {
  assertLock()
  const now = Date.now()
  const added = await redis.hsetnx(
    RedisKey.importSyncCandidates(IMPORT_SOURCE),
    String(topicId),
    JSON.stringify({ f: now, n: now + SYNC_TOPIC_MATURITY_HOURS * 3600_000 } satisfies CandidateEntry),
  )
  if (added) {
    console.log(
      `[import-sync] 新主题 ${topicId} 进入候选池,${SYNC_TOPIC_MATURITY_HOURS}h 后评估质量门槛`,
    )
  }
}

/** 单条楼层事件分派:判定交给 planOnePost,这里只负责执行副作用 */
async function syncOnePost(post: DiscoursePost, assertLock: () => void): Promise<void> {
  assertLock()
  const action = await planOnePost(post)
  assertLock()
  switch (action.kind) {
    case 'skip':
      return
    case 'delete':
      return removeSynced(action.mappingId, assertLock)
    case 'edit':
      return updateSyncedContent(action.mappingId, post, action.toVersion, assertLock)
    case 'append-comment':
      return appendComment(post, action.localPostId, action.parentId, assertLock)
    case 'defer-topic':
      return poolNewTopic(action.topicId, assertLock)
    case 'import-topic': {
      const result = await importTopic(action.topicId)
      assertLock()
      if (result.localPostId && (result.status === 'imported' || result.status === 'skipped')) {
        await replayTopicPoints(result.localPostId, assertLock)
        assertLock()
        if (result.status === 'imported') await reindexPost(result.localPostId)
      }
      return
    }
  }
}

/**
 * 解析回复对象并归一到**顶层祖先**(本站评论只有两层)。只读。
 * 返回 null 表示按顶层楼层处理(回复一楼、或父楼层未导入)。
 */
export async function resolveParentComment(post: DiscoursePost): Promise<number | null> {
  if (!post.reply_to_post_number || post.reply_to_post_number <= 1) return null

  const parentMapping = await prisma.importMapping.findFirst({
    where: {
      source: IMPORT_SOURCE,
      sourceTopicId: post.topic_id,
      sourcePostNumber: post.reply_to_post_number,
      localCommentId: { not: null },
    },
    select: { localCommentId: true },
  })
  if (!parentMapping?.localCommentId) return null

  const parent = await prisma.comment.findUnique({
    where: { id: parentMapping.localCommentId },
    select: { id: true, parentId: true },
  })
  return parent ? (parent.parentId ?? parent.id) : null
}

/**
 * 已知主题追加单条新评论(楼层/计数/积分口径对齐 comment.service)。
 *
 * ⚠️ 刻意**不复用** comment.service.createComment:那条路径会调 notifyMentions,
 * 而导入内容里的 @ 指向的是对方站用户名,本地大多不存在(或撞到同名的无关本地用户),
 * 16.8 万条导入评论会炸出海量死信/误投通知。回填侧同样直写 comment 行绕开它。
 * 将来若改成复用 createComment,必须先处理 @ 的归一或屏蔽。
 */
async function appendComment(
  post: DiscoursePost,
  localPostId: number,
  parentId: number | null,
  assertLock: () => void,
): Promise<void> {
  assertLock()
  const authorId = await resolvePostAuthor(post)
  const imageCtx = await resolveTopicImages([post])
  assertLock()
  const content = cleanMarkdown(post.raw!, imageCtx) || '……'
  const createdAt = new Date(post.created_at)
  // 占位账号判据与 shadow-users/verify 统一走同一真源,不再按 email 前缀猜
  const placeholderId = await getPlaceholderUser()
  assertLock()

  await prisma.$transaction(async (tx) => {
    assertLock()
    let floor: number | null = null
    if (!parentId) {
      // FOR UPDATE 锁帖子行,与真实用户并发评论共用同一楼层串行化机制
      await tx.$queryRaw`SELECT id FROM "posts" WHERE id = ${localPostId} FOR UPDATE`
      const last = await tx.comment.aggregate({ where: { postId: localPostId }, _max: { floor: true } })
      floor = (last._max.floor ?? 0) + 1
    }

    const comment = await tx.comment.create({
      data: {
        postId: localPostId,
        authorId,
        content,
        parentId,
        floor,
        likeCount: 0,
        createdAt,
      },
      select: { id: true },
    })

    // 顶层评论才计入帖子 commentCount/heatScore(+200)，用户 commentCount 也只统计顶层评论
    if (!parentId) {
      await tx.post.update({
        where: { id: localPostId },
        data: { commentCount: { increment: 1 }, heatScore: { increment: 200 } },
      })
      await tx.user.update({ where: { id: authorId }, data: { commentCount: { increment: 1 } } })
    }

    // 幂等兜底:@@unique([source, sourcePostId]) 撞车会 P2002 回滚整个事务
    // (评论行 + 计数 + 积分一起回滚),不会留下半截数据
    await tx.importMapping.create({
      data: {
        source: IMPORT_SOURCE,
        sourceTopicId: post.topic_id,
        sourcePostId: post.id,
        sourcePostNumber: post.post_number,
        sourceVersion: post.version ?? 1,
        localCommentId: comment.id,
        localUserId: authorId,
      },
    })

    // 决策 11/15:同步内容的积分随发言实时重放(占位账号不发)
    if (authorId !== placeholderId) {
      await importEarn(tx, authorId, PointType.COMMENT, comment.id, createdAt)
    }
  })
}


/**
 * 一楼编辑时额外要同步的主题级字段(决策 D2:同步标题与标签,**不同步分类**)。
 * 标题从 /posts.json 免费带的 topic_title 取;标签只在 /t/{id}.json 里,需多花一次限速请求。
 * 分类变更只告警不改:对方可能把主题移进 EXCLUDED_CATEGORY_IDS,自动改动本地分类
 * (甚至下架)风险远大于收益,交由人工判断。
 */
async function resolveTopicFields(
  post: DiscoursePost,
  localCategory: string,
): Promise<{ title?: string; tags?: string[] }> {
  const fields: { title?: string; tags?: string[] } = {}

  const title = post.topic_title?.trim().slice(0, 200)
  if (title) fields.title = title

  const topic = await fetchNodelocJson<DiscourseTopicDetail>(`/t/${post.topic_id}.json`)
  if (!topic) return fields

  const category = await resolveCategory(topic.category_id)
  if (category.slug !== localCategory) {
    console.warn(
      `[import-sync] ⚠️ 主题 ${post.topic_id} 分类已变更:本地 ${localCategory} → 对方 ` +
        `${category.slug}(category_id=${topic.category_id}${category.excluded ? ',属排除分类' : ''}),` +
        `按决策 D2 不自动改分类,请人工确认`,
    )
  }
  fields.tags = buildTags(category.subcategoryName, topic.tags)
  return fields
}

/**
 * 编辑同步:重清洗正文覆盖本地行,更新 sourceVersion。
 * 一楼额外同步标题/标签(见 resolveTopicFields);映射两侧皆空(本地已删)时只推进版本号。
 */
async function updateSyncedContent(
  mappingId: number,
  post: DiscoursePost,
  toVersion: number,
  assertLock: () => void,
): Promise<void> {
  assertLock()
  const target = await prisma.importMapping.findUnique({
    where: { id: mappingId },
    select: { localPostId: true, localCommentId: true, locked: true },
  })
  if (!target || target.locked) return

  // 本地内容已被删除:只把版本号推上去,避免每轮都重复判定为「有编辑」而反复抓取
  if (!target.localPostId && !target.localCommentId) {
    await prisma.importMapping.updateMany({
      where: { id: mappingId, sourceVersion: { lt: toVersion } },
      data: { sourceVersion: toVersion, syncedAt: new Date() },
    })
    return
  }

  const imageCtx = await resolveTopicImages([post])
  assertLock()
  const content = cleanMarkdown(post.raw!, imageCtx) || '……'

  // 主题级字段有网络 IO(多一次 /t/{id}.json),放在事务外
  let topicFields: { title?: string; tags?: string[] } = {}
  if (target.localPostId) {
    const local = await prisma.post.findUnique({
      where: { id: target.localPostId },
      select: { category: true },
    })
    assertLock()
    if (local) topicFields = await resolveTopicFields(post, local.category)
    assertLock()
  }

  await prisma.$transaction(async (tx) => {
    assertLock()
    const advanced = await tx.importMapping.updateMany({
      where: { id: mappingId, locked: false, sourceVersion: { lt: toVersion } },
      data: { sourceVersion: toVersion, syncedAt: new Date() },
    })
    if (advanced.count !== 1) return
    if (target.localPostId) {
      await tx.post.update({
        where: { id: target.localPostId },
        data: { content, ...topicFields },
      })
    } else {
      await tx.comment.update({ where: { id: target.localCommentId! }, data: { content } })
    }
  })

  // 搜索索引是派生数据,事务外补写(与 post.service.updatePost 同口径)
  if (target.localPostId) await reindexPost(target.localPostId)
}

/**
 * 删除同步:对方删楼/删帖 → 本地移除。
 * - 评论:删行(级联楼中楼)+ 回滚帖子/用户冗余计数;不回收已发积分(与真实用户删评论口径一致)
 * - 一楼:删除整帖(Post 级联评论/点赞),映射行保留作审计痕迹(localPostId/localCommentId 置空)
 *
 * 映射置空是**必须**的:被级联删掉的行若留在 import_mappings 里就是悬空引用,
 * verify 第 11 项会直接报错,而且下次同步会误认为「已导入」而不再补。
 */
async function removeSynced(mappingId: number, assertLock: () => void): Promise<void> {
  assertLock()
  const mapping = await prisma.importMapping.findUnique({ where: { id: mappingId } })
  assertLock()
  if (!mapping || mapping.locked) return

  if (mapping.localCommentId) {
    const comment = await prisma.comment.findUnique({
      where: { id: mapping.localCommentId },
      select: { id: true, postId: true, authorId: true, parentId: true },
    })
    if (!comment) {
      await prisma.importMapping.update({
        where: { id: mappingId },
        data: { localCommentId: null, syncedAt: new Date() },
      })
      return
    }

    // 级联要删掉的楼中楼:先拿到 id,事务里才能把它们的映射一并置空
    const replies = await prisma.comment.findMany({
      where: { parentId: comment.id },
      select: { id: true },
    })
    const removedIds = [comment.id, ...replies.map((r) => r.id)]

    await prisma.$transaction(async (tx) => {
      await tx.comment.deleteMany({ where: { parentId: comment.id } })
      await tx.comment.delete({ where: { id: comment.id } })
      if (!comment.parentId) {
        await tx.post.update({
          where: { id: comment.postId },
          data: { commentCount: { decrement: 1 }, heatScore: { decrement: 200 } },
        })
        // 顶层评论删除才减用户 commentCount（楼中楼从未计数，不需要回滚）
        await tx.user.update({
          where: { id: comment.authorId },
          data: { commentCount: { decrement: 1 } },
        })
      }
      await tx.importMapping.updateMany({
        where: { source: IMPORT_SOURCE, localCommentId: { in: removedIds } },
        data: { localCommentId: null, syncedAt: new Date() },
      })
    })
  } else if (mapping.localPostId) {
    const post = await prisma.post.findUnique({
      where: { id: mapping.localPostId },
      select: { id: true, authorId: true },
    })
    if (!post) {
      await prisma.importMapping.update({
        where: { id: mappingId },
        data: { localPostId: null, syncedAt: new Date() },
      })
      return
    }

    // 帖子级联删除会带走全部评论:先统计各作者的顶层评论数,事务里逐个回滚 commentCount。
    // [合理例外] 线上 post.service.performDelete 只回滚作者 postCount、不回滚评论者
    // commentCount(既有口径漂移)。导入侧刻意补齐,让 verify 第 7 项能当硬断言用。
    const comments = await prisma.comment.findMany({
      where: { postId: post.id },
      select: { id: true, authorId: true, parentId: true },
    })
    const commentIds = comments.map((c) => c.id)
    const topLevelByAuthor = new Map<number, number>()
    for (const c of comments) {
      if (c.parentId) continue
      topLevelByAuthor.set(c.authorId, (topLevelByAuthor.get(c.authorId) ?? 0) + 1)
    }

    await prisma.$transaction(async (tx) => {
      await tx.comment.deleteMany({ where: { postId: post.id } })
      await tx.post.delete({ where: { id: post.id } })
      await tx.user.update({ where: { id: post.authorId }, data: { postCount: { decrement: 1 } } })
      for (const [uid, n] of topLevelByAuthor) {
        await tx.user.update({ where: { id: uid }, data: { commentCount: { decrement: n } } })
      }
      // 一楼映射 + 该帖全部评论映射一起断开(只断开、不删行,保留审计痕迹)
      await tx.importMapping.updateMany({
        where: {
          source: IMPORT_SOURCE,
          OR: [{ localPostId: post.id }, { localCommentId: { in: commentIds } }],
        },
        data: { localPostId: null, localCommentId: null, syncedAt: new Date() },
      })
    })

    // 搜索索引清理(与 post.service.performDelete 同口径,失败只记日志)
    removePost(post.id).catch((err) => {
      console.error('[import-sync] 清理搜索索引失败:', err)
    })
  }
}

/**
 * 新导入主题的积分重放:一楼 post +10、每条评论 comment +3(占位账号豁免)。
 *
 * **幂等**:先查该帖/评论已有的 post/comment 类型流水,已发过的 refId 直接跳过。
 * 没有这层幂等的话,importTopic 成功后本函数抛错 → 帖子已落库、积分永久漏发,
 * 且下轮 importTopic 返回 skipped 再也补不回来。
 */
async function replayTopicPoints(
  localPostId: number,
  assertLock: () => void,
): Promise<void> {
  assertLock()
  const post = await prisma.post.findUnique({
    where: { id: localPostId },
    select: { id: true, authorId: true, createdAt: true },
  })
  if (!post) return

  const placeholderId = await getPlaceholderUser()
  assertLock()

  const comments = await prisma.comment.findMany({
    where: { postId: post.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, authorId: true, createdAt: true },
  })

  // 已发流水的 (type, userId, refId) 指纹,用于跳过重放
  const paid = new Set<string>()
  const logs = await prisma.pointLog.findMany({
    where: {
      OR: [
        { type: PointType.POST, refId: post.id },
        { type: PointType.COMMENT, refId: { in: comments.map((c) => c.id) } },
      ],
    },
    select: { type: true, userId: true, refId: true },
  })
  for (const l of logs) paid.add(`${l.type}:${l.userId}:${l.refId}`)
  assertLock()

  await prisma.$transaction(
    async (tx) => {
      assertLock()
      if (post.authorId !== placeholderId && !paid.has(`${PointType.POST}:${post.authorId}:${post.id}`)) {
        await importEarn(tx, post.authorId, PointType.POST, post.id, post.createdAt)
      }
      for (const c of comments) {
        if (c.authorId === placeholderId) continue
        if (paid.has(`${PointType.COMMENT}:${c.authorId}:${c.id}`)) continue
        await importEarn(tx, c.authorId, PointType.COMMENT, c.id, c.createdAt)
      }
    },
    { timeout: 60_000 }, // 千楼大帖逐条 importEarn,放宽默认 5s 事务超时(与 importTopic 一致)
  )
}

/** 写入/更新帖子搜索索引(派生数据,失败只记日志不影响同步) */
async function reindexPost(localPostId: number): Promise<void> {
  const post = await prisma.post.findUnique({
    where: { id: localPostId },
    select: {
      id: true,
      title: true,
      content: true,
      category: true,
      tags: true,
      authorId: true,
      createdAt: true,
    },
  })
  if (!post) return
  await indexPost(post).catch((err) => {
    console.error('[import-sync] 写入搜索索引失败:', err)
  })
}
