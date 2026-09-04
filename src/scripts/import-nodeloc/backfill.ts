import fs from 'node:fs'
import path from 'node:path'
import { prisma } from '../../lib/prisma.js'
import { redis } from '../../lib/redis.js'
import { fetchNodelocJson } from '../../services/import/nodeloc-client.js'
import { BACKFILL_WINDOW_DAYS } from '../../services/import/import-config.js'
import { importTopic, type ImportTopicStatus } from '../../services/import/import-topic.js'
import type { DiscourseLatestResponse } from '../../services/import/nodeloc-types.js'

/**
 * NodeLoc 全量回填(交接文档阶段 2):按创建时间倒序翻 /latest.json?order=created,
 * 逐主题调 importTopic,直到整页都老于 BACKFILL_WINDOW_DAYS(365 天)为止。
 *
 * 运行:pnpm tsx src/scripts/import-nodeloc/backfill.ts(先跑 reset-dev-db.ts)
 * - 全程 ≤1 req/s(nodeloc-client 串行节流),预计通宵级时长,建议后台跑
 * - 断点续跑:页游标存 server/.import-backfill-checkpoint.json,
 *   且 importTopic 本身幂等(一楼映射已存在 → skipped),重复跑不重复导
 * - PointLog 不在此写:积分统一由阶段 2.5 造数脚本重放
 */

/** 断点文件(server/ 根,不进 src;已在 .gitignore 范围外也无妨,纯本地运行态) */
const CHECKPOINT_FILE = path.resolve(process.cwd(), '.import-backfill-checkpoint.json')

interface Checkpoint {
  /** 下一个待处理页码(0 起) */
  page: number
  /** 已处理主题数(含跳过) */
  processed: number
  /** 各状态计数 */
  stats: Record<ImportTopicStatus, number>
}

function loadCheckpoint(): Checkpoint {
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8')) as Checkpoint
  } catch {
    return {
      page: 0,
      processed: 0,
      stats: { imported: 0, skipped: 0, excluded: 0, missing: 0, empty: 0 },
    }
  }
}

function saveCheckpoint(cp: Checkpoint): void {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2))
}

const run = async () => {
  const cutoff = new Date(Date.now() - BACKFILL_WINDOW_DAYS * 24 * 3600 * 1000)
  const cp = loadCheckpoint()
  const startedAt = Date.now()
  console.log(
    `[backfill] 启动:窗口 ${BACKFILL_WINDOW_DAYS} 天(晚于 ${cutoff.toISOString().slice(0, 10)}),从第 ${cp.page} 页续跑,已处理 ${cp.processed}`,
  )

  for (;;) {
    const res = await fetchNodelocJson<DiscourseLatestResponse>(
      `/latest.json?order=created&page=${cp.page}`,
    )
    const topics = res?.topic_list?.topics ?? []
    if (!topics.length) {
      console.log(`[backfill] 第 ${cp.page} 页为空,列表见底,结束`)
      break
    }

    // order=created 为创建时间倒序:整页都老于窗口即可停
    const inWindow = topics.filter((t) => new Date(t.created_at) >= cutoff)
    for (const t of inWindow) {
      if (t.has_read_permission_restriction) {
        cp.stats.missing += 1
        cp.processed += 1
        continue
      }
      try {
        const result = await importTopic(t.id)
        cp.stats[result.status] += 1
        cp.processed += 1
        if (result.status === 'imported') {
          console.log(
            `[backfill] #${t.id} imported → post ${result.localPostId}(${result.commentCount} 评论)| ${t.title.slice(0, 40)}`,
          )
        }
      } catch (err) {
        // 单主题失败不终止整轮(网络抖动等);未写映射,下次重跑会补
        console.error(`[backfill] #${t.id} 失败(跳过,可重跑补):`, (err as Error).message)
      }
    }

    const pageDone = cp.page
    cp.page += 1
    saveCheckpoint(cp)

    const elapsedMin = Math.round((Date.now() - startedAt) / 60000)
    console.log(
      `[backfill] 第 ${pageDone} 页完成 | 累计 ${cp.processed} 主题 | ` +
        `imported ${cp.stats.imported} / skipped ${cp.stats.skipped} / excluded ${cp.stats.excluded} / missing ${cp.stats.missing} / empty ${cp.stats.empty} | ${elapsedMin} 分钟`,
    )

    if (inWindow.length < topics.length) {
      console.log('[backfill] 本页已出现窗口外旧帖,到达 365 天边界,结束')
      break
    }
    if (!res?.topic_list?.more_topics_url) {
      console.log('[backfill] more_topics_url 为空,列表见底,结束')
      break
    }
  }

  console.log(
    `[backfill] 全部完成:${JSON.stringify(cp.stats)},总计 ${cp.processed} 主题,耗时 ${Math.round((Date.now() - startedAt) / 60000)} 分钟`,
  )
  console.log('[backfill] 后续:阶段 2.5 造数(fabricate)→ points:audit → search:reindex → 再开 IMPORT_SYNC_ENABLED')
}

run()
  .catch((err) => {
    console.error('[backfill] 致命错误(断点已保存,可直接重跑续传):', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })
