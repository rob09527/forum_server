import { redis } from '../../lib/redis.js'
import { RedisKey } from '../../constants/redis-keys.js'
import { fetchNodelocJson } from './nodeloc-client.js'
import { IMPORT_SOURCE, BACKFILL_WINDOW_DAYS } from './import-config.js'
import { importTopic, type ImportTopicStatus } from './import-topic.js'
import type { DiscourseLatestResponse } from './nodeloc-types.js'

/**
 * NodeLoc 全量回填(原 scripts/import-nodeloc/backfill.ts 的翻页循环,迁成 worker 阶段 1)。
 * 按创建时间倒序翻 /latest.json?order=created,逐主题 importTopic(不写积分),
 * 直到整页都老于 BACKFILL_WINDOW_DAYS(365 天)为止。
 *
 * 与旧脚本的差异:断点从文件 .import-backfill-checkpoint.json 改为 Redis 页游标,
 * 每次调用只处理有界的一批(时间预算内),到点写游标返回 'more',由 60s 调度器续跑。
 * 单主题失败只记日志不终止 —— importTopic 本身幂等(一楼映射已存在 → skipped),下轮可补。
 */

/** 单 tick 时间预算(ms):到点写游标返回,避免一次调用长时间独占锁/进程 */
const BACKFILL_BUDGET_MS = 100_000

/** 单页主题状态计数,仅用于本轮日志(跨 tick 累计数不值得为此持久化) */
function emptyStats(): Record<ImportTopicStatus, number> {
  return { imported: 0, skipped: 0, excluded: 0, missing: 0, empty: 0 }
}

export async function runBackfillTick(assertLock: () => void): Promise<'done' | 'more'> {
  const pageKey = RedisKey.importBackfillPage(IMPORT_SOURCE)
  const rawPage = await redis.get(pageKey)
  let page = Number(rawPage)
  if (!rawPage || !Number.isFinite(page) || page < 0) page = 0

  const cutoff = new Date(Date.now() - BACKFILL_WINDOW_DAYS * 24 * 3600 * 1000)
  const startedAt = Date.now()
  const stats = emptyStats()
  let processed = 0

  console.log(
    `[import-backfill] 启动:窗口 ${BACKFILL_WINDOW_DAYS} 天(晚于 ${cutoff.toISOString().slice(0, 10)}),从第 ${page} 页续跑`,
  )

  for (;;) {
    if (Date.now() - startedAt >= BACKFILL_BUDGET_MS) {
      console.log(`[import-backfill] 本轮时间预算到,游标停在 ${page} 页,下轮继续`)
      return 'more'
    }
    assertLock()

    const res = await fetchNodelocJson<DiscourseLatestResponse>(
      `/latest.json?order=created&page=${page}`,
    )
    assertLock()
    const topics = res?.topic_list?.topics ?? []
    if (!topics.length) {
      console.log(`[import-backfill] 第 ${page} 页为空,列表见底,回填完成`)
      return 'done'
    }

    // order=created 为创建时间倒序:整页都老于窗口即可停
    const inWindow = topics.filter((t) => new Date(t.created_at) >= cutoff)
    for (const t of inWindow) {
      if (t.has_read_permission_restriction) {
        stats.missing += 1
        processed += 1
        continue
      }
      try {
        const result = await importTopic(t.id)
        stats[result.status] += 1
        processed += 1
        if (result.status === 'imported') {
          console.log(
            `[import-backfill] #${t.id} imported → post ${result.localPostId}(${result.commentCount} 评论)| ${t.title.slice(0, 40)}`,
          )
        }
      } catch (err) {
        // 单主题失败不终止整轮(网络抖动等);未写映射,下轮会补
        console.error(`[import-backfill] #${t.id} 失败(跳过,可重跑补):`, (err as Error).message)
      }
    }

    const pageDone = page
    page += 1
    assertLock()
    await redis.set(pageKey, String(page))

    const elapsedSec = Math.round((Date.now() - startedAt) / 1000)
    console.log(
      `[import-backfill] 第 ${pageDone} 页完成 | 本轮 ${processed} 主题 | ` +
        `imported ${stats.imported} / skipped ${stats.skipped} / excluded ${stats.excluded} / missing ${stats.missing} / empty ${stats.empty} | ${elapsedSec}s`,
    )

    if (inWindow.length < topics.length) {
      console.log('[import-backfill] 本页已出现窗口外旧帖,到达 365 天边界,回填完成')
      return 'done'
    }
    if (!res?.topic_list?.more_topics_url) {
      console.log('[import-backfill] more_topics_url 为空,列表见底,回填完成')
      return 'done'
    }
  }
}
