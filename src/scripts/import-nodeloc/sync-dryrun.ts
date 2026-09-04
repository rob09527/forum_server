import { prisma } from '../../lib/prisma.js'
import { redis } from '../../lib/redis.js'
import { RedisKey } from '../../constants/redis-keys.js'
import { PointType } from '../../constants/business.js'
import { POINT_RULES } from '../../services/points/points.service.js'
import { fetchNodelocJson } from '../../services/import/nodeloc-client.js'
import {
  IMPORT_SOURCE,
  EXCLUDED_CATEGORY_IDS,
  SYNC_POLL_INTERVAL_MS,
  SYNC_TOPIC_MATURITY_HOURS,
  SYNC_CANDIDATE_TTL_HOURS,
  SYNC_CANDIDATE_BATCH,
  SYNC_GATE_MIN_VIEWS,
  SYNC_GATE_MIN_LIKES,
  SYNC_GATE_MIN_POSTS_COUNT,
  SYNC_DAILY_TOPIC_QUOTA,
} from '../../services/import/import-config.js'
import { resolveCategory } from '../../services/import/category-map.js'
import {
  fetchLatestPosts,
  planCursor,
  planOnePost,
  planTopicCandidates,
  type CandidatePlanOverride,
  type SyncAction,
} from '../../services/import/import-sync.service.js'
import type {
  DiscoursePost,
  DiscourseTopicDetail,
} from '../../services/import/nodeloc-types.js'

/**
 * 增量 worker 单轮**干跑**入口:只跑一轮、一行都不写库、不回写 Redis 游标。
 *
 * 存在的理由:worker 从未真正跑过一次,而它一旦开启就会对着 16 万评论量级的库
 * 持续写入。干跑把「分派决策」与「副作用预测」打印出来,让人在开闸前肉眼核对
 * 三处静态审查最容易看漏的地方:
 * - **A1 冷启动游标**:游标缺失/损坏时必须只初始化、不回灌整页历史(否则与回填重复计账)
 * - **A3 四类分派**:新主题 / 新评论 / 编辑 / 删除,外加各类跳过
 * - **A7 排除分类**:命中 EXCLUDED_CATEGORY_IDS(含祖先)的主题必须跳过
 *
 * 决策全部复用 service 导出的 `planCursor` / `planOnePost`(**纯只读**),
 * 不是平行实现 —— 干跑验证的就是生产那套判定代码本身。
 * 副作用只在本文件里「叙述」,标注 [预测] 前缀,不执行。
 *
 * ⚠️ 只读边界(改本文件时务必守住):
 * - 禁止调用 `resolvePostAuthor`(会创建影子用户 = 写库)与 `resolveTopicImages`
 *   (会下载并落盘图片文件),所以正文只报 raw 长度,不做清洗预览
 * - 所有对源站的请求走 `fetchNodelocJson`,沿用其全局串行节流,不自建 fetch
 * - Redis 游标只读不写;写库调用一律不出现
 *
 * 用法:
 *   pnpm tsx src/scripts/import-nodeloc/sync-dryrun.ts
 *   pnpm tsx src/scripts/import-nodeloc/sync-dryrun.ts --cursor=12345   # 手工指定起点复现
 *   pnpm tsx src/scripts/import-nodeloc/sync-dryrun.ts --limit=10       # 只看前 10 条决策
 *
 * 新主题准入三层(任务 L)的演练:真实候选池初始为空,所以门槛/配额两层需要替身输入
 * (`planTopicCandidates(override)`,只替换**输入**,判定代码仍是生产那一份):
 *   --simulate-topics=105140,105141   # 假装这些对方 topicId 在池中且已成熟
 *   --simulate-age-hours=50           # 模拟滞留时长,≥SYNC_CANDIDATE_TTL_HOURS 演练永久丢弃
 *   --quota-used=10                   # 假装当日配额已用满,验证「用满即不发源站请求」
 *
 * ⚠️ 干跑特有的假象(不是 bug,别照着改代码):同一轮里若某主题的一楼判为 defer-topic、
 * 它后面的楼层又出现在同一页,干跑会把后者判成 import-topic。原因是干跑**不写候选池**,
 * `planOnePost` 里的 isPooledTopic 守卫查不到这一条。真实执行是「按 id 升序逐条处理」,
 * 一楼的 poolNewTopic 已 HSETNX 写入,后续楼层会正确落到 skip。
 */

/** 命令行参数 */
interface DryRunArgs {
  /** 手工指定游标起点(不给则读 Redis 现值);用于复现特定区间 */
  cursor?: number
  /** 最多输出多少条 pending 的决策明细(默认全部) */
  limit?: number
  /** 演练用:假装候选池里有这些对方 topicId(已成熟),不写 Redis */
  simulateTopics?: number[]
  /** 演练用:模拟候选已在池中滞留多少小时(默认 maturity+1;≥TTL 可演练永久丢弃) */
  simulateAgeHours?: number
  /** 演练用:假装当日配额已用掉 N 个 */
  quotaUsed?: number
}

function parseArgs(argv: string[]): DryRunArgs {
  const args: DryRunArgs = {}
  for (const a of argv) {
    const cursor = /^--cursor=(\d+)$/.exec(a)
    if (cursor) args.cursor = Number(cursor[1])
    const limit = /^--limit=(\d+)$/.exec(a)
    if (limit) args.limit = Number(limit[1])
    const sim = /^--simulate-topics=([\d,]+)$/.exec(a)
    if (sim) args.simulateTopics = sim[1]!.split(',').filter(Boolean).map(Number)
    const age = /^--simulate-age-hours=(\d+)$/.exec(a)
    if (age) args.simulateAgeHours = Number(age[1])
    const quota = /^--quota-used=(\d+)$/.exec(a)
    if (quota) args.quotaUsed = Number(quota[1])
    // --once / --dry-run 是语义声明:本入口天然只跑一轮且只读,接受但无需处理
  }
  return args
}

/** 影子用户是否已存在(只读;真实路径会 get-or-create,干跑只报会不会新建) */
async function describeAuthor(post: DiscoursePost): Promise<string> {
  const mapping = await prisma.importUserMapping.findUnique({
    where: { source_sourceUserId: { source: IMPORT_SOURCE, sourceUserId: post.user_id } },
    select: { localUserId: true },
  })
  return mapping
    ? `作者 ${post.username}(source ${post.user_id})→ 已有影子账号 #${mapping.localUserId}`
    : `作者 ${post.username}(source ${post.user_id})→ [预测] 新建影子账号(users +1 行 + 头像下载)`
}

/** 分类归属与排除判定(A7 眼看验证点) */
async function describeCategory(categoryId: number | undefined): Promise<string> {
  if (categoryId === undefined) return '分类:/posts.json 未带 category_id,交 importTopic 再判'
  const c = await resolveCategory(categoryId)
  const excluded = EXCLUDED_CATEGORY_IDS.has(categoryId)
  return (
    `分类:对方 category_id=${categoryId} → 本地 ${c.slug}` +
    `${c.subcategoryName ? `(子分类 tag「${c.subcategoryName}」)` : ''}` +
    `,排除=${c.excluded}${c.excluded && !excluded ? '(命中祖先排除)' : ''}`
  )
}

/** 逐条叙述「将要」发生的副作用(全部只读推导,不执行) */
async function describeEffects(post: DiscoursePost, action: SyncAction): Promise<string[]> {
  const out: string[] = []
  const postDelta = POINT_RULES[PointType.POST].delta
  const commentDelta = POINT_RULES[PointType.COMMENT].delta

  switch (action.kind) {
    case 'skip':
      out.push(`跳过:${action.reason}`)
      break

    case 'append-comment': {
      out.push(await describeAuthor(post))
      out.push(
        `[预测] comments +1 行(postId=${action.localPostId},` +
          `${action.parentId ? `parentId=${action.parentId} 楼中楼,floor=null` : '顶层楼层,floor=max+1(FOR UPDATE 锁帖子行)'})`,
      )
      if (action.parentId) {
        out.push('[预测] 冗余计数:不变(楼中楼不计 post.commentCount / user.commentCount / heatScore)')
      } else {
        out.push(
          `[预测] 冗余计数:post#${action.localPostId}.commentCount +1、heatScore +200、作者 user.commentCount +1`,
        )
      }
      out.push(
        `[预测] 积分:comment ${commentDelta >= 0 ? '+' : ''}${commentDelta} 给该楼作者` +
          `(占位账号「已注销用户」豁免);point_logs +1 行,createdAt 用原始发言时间 ${post.created_at}`,
      )
      out.push('[预测] import_mappings +1 行(localCommentId);Meili:不动(评论不进索引)')
      out.push(`正文:raw ${post.raw?.length ?? 0} 字符(干跑不做清洗/图片下载,故不预览)`)
      break
    }

    case 'defer-topic':
      out.push(
        `[预测] 新主题 ${action.topicId} 只登记进候选池(Redis HASH,不导入任何内容):` +
          `${SYNC_TOPIC_MATURITY_HOURS}h 后才评估质量门槛`,
      )
      out.push(
        '[预测] 一行库都不写;该主题此刻的 views/likes/posts_count 还接近 0,现在判定必然误杀',
      )
      break

    case 'import-topic': {
      const topic = await fetchNodelocJson<DiscourseTopicDetail>(`/t/${action.topicId}.json`)
      if (!topic) {
        out.push(`[预测] importTopic(${action.topicId}) → missing(404/403,无副作用)`)
        break
      }
      const c = await resolveCategory(topic.category_id)
      out.push(`主题「${topic.title.slice(0, 40)}」共 ${topic.posts_count} 楼,views=${topic.views}`)
      out.push(await describeCategory(topic.category_id))
      if (c.excluded) {
        out.push('[预测] importTopic → excluded,无任何写入(A7 排除生效)')
        break
      }
      const floors = Math.max(0, (topic.posts_count ?? 1) - 1)
      out.push(
        `[预测] posts +1 行、comments 约 +${floors} 行(hidden/自删楼层会被过滤,实际可能更少)、` +
          `import_mappings 约 +${floors + 1} 行`,
      )
      out.push(
        `[预测] 冗余计数:一楼作者 user.postCount +1、各顶层评论作者 user.commentCount 各 +1;` +
          `post.heatScore = like*300 + 顶层评论数*200 + views`,
      )
      out.push(
        `[预测] 积分重放:一楼作者 post ${postDelta >= 0 ? '+' : ''}${postDelta}、` +
          `每条评论作者 comment ${commentDelta >= 0 ? '+' : ''}${commentDelta}` +
          `(约 ${floors} 笔,占位账号豁免),point_logs 约 +${floors + 1} 行`,
      )
      out.push('[预测] Meili:indexPost 写入该帖索引')
      out.push('[预测] 影子账号:该主题全部发言者逐个 get-or-create(可能新建大量 users 行 + 头像下载)')
      break
    }

    case 'edit': {
      out.push(
        `对方版本 ${action.fromVersion} → ${action.toVersion};映射 #${action.mappingId} 指向 ` +
          `${action.target === 'gone' ? '(本地内容已删)' : `${action.target}#${action.localId}`}`,
      )
      if (action.target === 'gone') {
        out.push('[预测] 仅 import_mappings.sourceVersion/syncedAt 更新,不碰内容表,不动 Meili')
        break
      }
      if (action.target === 'comment') {
        out.push(`[预测] comments#${action.localId}.content 覆盖为重清洗后的正文;计数/积分不变;Meili 不动`)
      } else {
        const local = await prisma.post.findUnique({
          where: { id: action.localId! },
          select: { title: true, category: true, tags: true },
        })
        out.push(
          `[预测] posts#${action.localId}.content 覆盖;标题 「${local?.title.slice(0, 30) ?? '?'}」→ ` +
            `「${post.topic_title?.slice(0, 30) ?? '(对方未带 topic_title,保持不变)'}」`,
        )
        const topic = await fetchNodelocJson<DiscourseTopicDetail>(`/t/${post.topic_id}.json`)
        if (topic) {
          const c = await resolveCategory(topic.category_id)
          out.push(`[预测] tags:本地 [${local?.tags.join(', ') ?? ''}] → 按子分类+对方 tags 重算`)
          if (local && c.slug !== local.category) {
            out.push(
              `⚠️ 分类漂移:本地 ${local.category} → 对方 ${c.slug}` +
                `${c.excluded ? '(属排除分类!)' : ''};决策 D2 只告警,不自动改分类`,
            )
          }
        }
        out.push('[预测] 冗余计数/积分不变;Meili:reindexPost 覆盖索引')
      }
      out.push('[预测] import_mappings.sourceVersion/syncedAt 更新')
      break
    }

    case 'delete': {
      if (action.target === 'comment') {
        const comment = await prisma.comment.findUnique({
          where: { id: action.localId },
          select: { id: true, postId: true, authorId: true, parentId: true },
        })
        if (!comment) {
          out.push('[预测] 本地评论行已不存在,removeSynced 直接返回,无副作用')
          break
        }
        const replies = await prisma.comment.count({ where: { parentId: comment.id } })
        out.push(
          `[预测] comments -${1 + replies} 行(本条 + ${replies} 条楼中楼级联);` +
            `import_mappings 这 ${1 + replies} 行的 localCommentId 置空(保留审计痕迹)`,
        )
        out.push(
          comment.parentId
            ? '[预测] 冗余计数:不变(被删的是楼中楼,从未计数)'
            : `[预测] 冗余计数:post#${comment.postId}.commentCount -1、heatScore -200、user#${comment.authorId}.commentCount -1`,
        )
        out.push('[预测] 积分:不回收(与真实用户删评论同口径);Meili:不动')
      } else {
        const comments = await prisma.comment.findMany({
          where: { postId: action.localId },
          select: { authorId: true, parentId: true },
        })
        const topAuthors = new Set(comments.filter((c) => !c.parentId).map((c) => c.authorId))
        out.push(
          `[预测] posts -1 行、comments -${comments.length} 行(级联);` +
            `该帖一楼与全部评论的 import_mappings 两侧置空`,
        )
        out.push(
          `[预测] 冗余计数:一楼作者 user.postCount -1;${topAuthors.size} 个评论者的 ` +
            `user.commentCount 按各自顶层评论数回滚`,
        )
        out.push('[预测] 积分:不回收;Meili:removePost 从索引移除(否则搜到点进去 404)')
      }
      break
    }
  }
  return out
}

/**
 * 新主题准入三层的判定结果(任务 L 的唯一验证手段)。
 * 决策全部来自 service 的 planTopicCandidates(只读),这里只负责排版。
 */
async function reportCandidates(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  console.log('\n═══ 新主题准入:成熟期 → 质量门槛 → 每日配额 ═══')
  console.log(
    `配置:成熟期 ${SYNC_TOPIC_MATURITY_HOURS}h、滞留上限 ${SYNC_CANDIDATE_TTL_HOURS}h、` +
      `单轮评估上限 ${SYNC_CANDIDATE_BATCH} 个;门槛 views≥${SYNC_GATE_MIN_VIEWS} ` +
      `且 likes≥${SYNC_GATE_MIN_LIKES} 且 posts_count≥${SYNC_GATE_MIN_POSTS_COUNT};` +
      `每日配额 ${SYNC_DAILY_TOPIC_QUOTA} 个新主题`,
  )
  console.log(
    `Redis key:候选池 ${RedisKey.importSyncCandidates(IMPORT_SOURCE)}、` +
      `配额 ${RedisKey.importSyncQuota(IMPORT_SOURCE, '<本地日期>')}`,
  )

  // 池子为空时(worker 从未跑过)用 --simulate-topics 造一份**内存里的**替身池,
  // 让门槛/配额两层的判定代码真的跑起来。仍然一个字节都不写 Redis。
  let override: CandidatePlanOverride | undefined
  if (args.simulateTopics?.length || args.quotaUsed !== undefined) {
    const ageHours = args.simulateAgeHours ?? SYNC_TOPIC_MATURITY_HOURS + 1
    const firstSeen = Date.now() - ageHours * 3600_000
    const pool: Record<string, string> = {}
    for (const id of args.simulateTopics ?? []) {
      // n 取「首见 + 成熟期」= 已到评估时间;f 决定滞留时长(≥TTL 则演练永久丢弃)
      pool[String(id)] = JSON.stringify({
        f: firstSeen,
        n: firstSeen + SYNC_TOPIC_MATURITY_HOURS * 3600_000,
      })
    }
    // 只给 --quota-used 时不要把真实池子替换成空池
    override = {
      pool: args.simulateTopics?.length ? pool : undefined,
      quotaUsed: args.quotaUsed,
    }
    console.log(
      `⚙️ 演练模式:${args.simulateTopics?.length ? `替身候选池 ${Object.keys(pool).length} 条(模拟滞留 ${ageHours}h)` : '沿用真实候选池'}` +
        `${args.quotaUsed !== undefined ? `、假定已用配额 ${args.quotaUsed}` : ''};Redis 仍然只读不写`,
    )
  }

  const plan = await planTopicCandidates(override)
  console.log(
    `候选池现有 ${plan.poolSize} 条;当日配额已用 ${plan.quotaUsed}/${plan.quotaLimit}` +
      `${plan.quotaExhausted ? ' → 已用满,本轮不评估、不发任何源站请求,池子留待明日' : ''}`,
  )
  if (plan.quotaExhausted || plan.poolSize === 0) return
  console.log(`已到评估时间(成熟)的候选 ${plan.matured} 条,本轮展开 ${plan.decisions.length} 条:`)

  for (const d of plan.decisions) {
    const sig = d.signals
      ? `views=${d.signals.views} likes=${d.signals.likes} posts_count=${d.signals.postsCount}`
      : '(信号不可用)'
    console.log(`\n── 主题 ${d.topicId} 观察 ${d.ageHours.toFixed(1)}h ${sig}`)
    switch (d.verdict.kind) {
      case 'import':
        console.log('   【门槛通过 + 抢到配额】→ [预测] importTopic 全量导入 + 积分重放 + 建索引')
        console.log('   [预测] 配额 +1(导入成功后才扣);候选池删除该条')
        break
      case 'reject-gate':
        console.log(`   【门槛拦下】${d.verdict.reason}`)
        console.log(
          `   [预测] 不导入、不丢弃:候选池顺延 ${SYNC_TOPIC_MATURITY_HOURS}h 后重评` +
            `(信号只会随时间增长),滞留满 ${SYNC_CANDIDATE_TTL_HOURS}h 才永久丢弃`,
        )
        break
      case 'drop-expired':
        console.log(`   【永久丢弃】${d.verdict.reason}`)
        console.log('   [预测] 候选池删除该条并打日志;游标早已推过,此主题不再有机会')
        break
      case 'drop-missing':
        console.log('   【丢弃】对方站已不可见(404/403)')
        break
      case 'drop-excluded':
        console.log('   【丢弃】成熟后判定属排除分类(A7)')
        break
    }
  }
}

/** /posts.json 楼层消费那一轮的判定(A1/A3/A7) */
async function reportPostsRound(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  console.log('═══ 增量 worker 单轮干跑(只读,不写库、不写 Redis 游标/候选池/配额)═══')
  console.log(
    `轮询间隔配置 ${SYNC_POLL_INTERVAL_MS}ms;排除分类 id:[${[...EXCLUDED_CATEGORY_IDS].join(', ')}]`,
  )

  const latest = await fetchLatestPosts()
  if (!latest) {
    console.log('⚠️ /posts.json 拉取失败或为空页,本轮真实执行也会直接 return')
    return
  }
  const ids = latest.map((p) => p.id)
  console.log(
    `/posts.json 取回 ${latest.length} 条楼层,id 区间 ${Math.min(...ids)} ~ ${Math.max(...ids)}`,
  )

  // A1:游标决策。注意 planCursor 只读 Redis,不回写
  const stored = await redis.get(RedisKey.importCursor(IMPORT_SOURCE))
  console.log(`Redis 游标现值:${stored === null ? '(未设置)' : stored}`)
  const plan = await planCursor(latest, args.cursor)

  if (plan.mode === 'cold-start') {
    console.log(
      `【A1 冷启动】游标缺失/损坏 → 只把游标初始化为本页最大 id ${plan.initTo},` +
        `**本轮不处理任何楼层**(历史由 backfill 负责,不回灌以免重复计账)`,
    )
    console.log('(干跑不写回 Redis;真实执行会 SET 该值后 return)')
    return
  }

  console.log(
    `【A1 正常消费】生效游标 ${plan.cursor}${args.cursor !== undefined ? '(命令行指定)' : '(来自 Redis)'};` +
      `pending ${plan.pending.length} 条(id 升序消费)`,
  )
  if (plan.overflow) {
    console.log('⚠️ 本页全为新增 → 可能已溢出 /posts.json 窗口丢楼,真实执行会 warn')
  }
  if (plan.pending.length === 0) {
    console.log('本轮无待处理楼层,真实执行会直接 return。')
    return
  }

  const shown = args.limit ? plan.pending.slice(0, args.limit) : plan.pending
  const tally = new Map<string, number>()

  for (const post of shown) {
    const action = await planOnePost(post)
    tally.set(action.kind, (tally.get(action.kind) ?? 0) + 1)
    console.log(
      `\n── post#${post.id} 主题 ${post.topic_id} 第 ${post.post_number} 楼 ` +
        `[${post.topic_archetype ?? 'regular'}] v${post.version ?? 1} ` +
        `${post.deleted_at ? 'deleted ' : ''}${post.user_deleted ? 'user_deleted ' : ''}${post.hidden ? 'hidden ' : ''}` +
        `→ 【${action.kind}】`,
    )
    // import-topic 分支会用主题详情里的 category_id 再打一次(更权威),这里不重复打印
    if (action.kind !== 'import-topic') {
      console.log(`   ${await describeCategory(post.category_id)}`)
    }
    for (const line of await describeEffects(post, action)) console.log(`   ${line}`)
  }

  console.log('\n═══ 本轮决策汇总 ═══')
  for (const [kind, n] of tally) console.log(`  ${kind}: ${n} 条`)
  if (args.limit && plan.pending.length > shown.length) {
    console.log(`  (--limit=${args.limit},另有 ${plan.pending.length - shown.length} 条未展开)`)
  }
}

/**
 * 两个阶段都跑:楼层消费 + 候选池评估。
 * 真实 worker 里候选池评估同样是**无条件**跑的(与本轮有没有新楼层无关),
 * 所以这里也不放在楼层阶段的条件分支里。
 */
async function main(): Promise<void> {
  await reportPostsRound()
  await reportCandidates()
  console.log('\n干跑结束:未写入任何数据库行,Redis 游标/候选池/配额均保持不变。')
}

main()
  .catch((err) => {
    console.error('[sync-dryrun] 失败:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })
