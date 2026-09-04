import { prisma } from '../../lib/prisma.js'
import { redis } from '../../lib/redis.js'
import { RedisKey } from '../../constants/redis-keys.js'
import { ensurePostsIndex } from '../../lib/meilisearch.js'
import { IMPORT_SOURCE } from '../import/import-config.js'
import { importTopic, type ImportTopicResult } from '../import/import-topic.js'
import { reindexAll } from '../search/search.service.js'
import { getNodelocConfig } from '../config/config.service.js'

/**
 * NodeLoc 数据导入管理服务。
 * 由 admin 后端（Cool Admin）通过 /api/admin/nodeloc/* 调用，服务间密钥鉴权，非浏览器直连。
 *
 * 职责分两类：
 * - 只读监控（getNodelocOverview）：聚合 worker 三阶段状态（Redis）+ 内容/影子/积分规模（DB）
 * - 安全调控：单主题重灌（importTopic）、重建搜索索引（reindexAll）
 * 危险操作（清空重 0、切 phase、推/退游标）不进此层，仍走 CLI（deploy/manage.sh reset-import 等）。
 */

/** NodeLoc 导入概览（admin 看板数据源） */
export interface NodelocOverview {
  /** worker 开关（热切换后生效值，config:nodeloc.syncEnabled） */
  syncEnabled: boolean
  /** 三阶段标记：backfill | fabricate | incremental | null（尚未启动） */
  phase: string | null
  /** 增量游标：已同步到的对方最大 post id（字符串数字，无 TTL） */
  cursor: string | null
  /** 回填页游标：回填阶段翻到第几页（回填完成时删除） */
  backfillPage: string | null
  /** 内容同步与影子数据规模 */
  stats: {
    /** 帖子映射数（localPostId 非空） */
    postMappings: number
    /** 评论映射数（localCommentId 非空） */
    commentMappings: number
    /** 孤立映射数（两侧皆空，删除同步审计痕迹） */
    orphanMappings: number
    /** 影子账号数（isShadow=true，passwordHash=null 不可登录） */
    shadowUsers: number
    /** 占位账号数（sourceUserId<0，应恒为 1） */
    placeholderUsers: number
    /** 影子帖子数 */
    shadowPosts: number
    /** 影子评论数 */
    shadowComments: number
    /** 影子关注数（造数产物） */
    shadowFollows: number
    /** 影子积分流水数（回灌 + 造数产物） */
    shadowPointLogs: number
  }
}

/** 读取 worker 三阶段状态（Redis）与数据规模（DB），返回 admin 看板数据 */
export async function getNodelocOverview(): Promise<NodelocOverview> {
  const [{ syncEnabled }, phase, cursor, backfillPage] = await Promise.all([
    getNodelocConfig(),
    redis.get(RedisKey.importPhase(IMPORT_SOURCE)),
    redis.get(RedisKey.importCursor(IMPORT_SOURCE)),
    redis.get(RedisKey.importBackfillPage(IMPORT_SOURCE)),
  ])

  const [
    postMappings,
    commentMappings,
    orphanMappings,
    shadowUsers,
    placeholderUsers,
    shadowPosts,
    shadowComments,
    shadowFollows,
    shadowPointLogs,
  ] = await Promise.all([
    prisma.importMapping.count({ where: { source: IMPORT_SOURCE, localPostId: { not: null } } }),
    prisma.importMapping.count({ where: { source: IMPORT_SOURCE, localCommentId: { not: null } } }),
    prisma.importMapping.count({
      where: { source: IMPORT_SOURCE, localPostId: null, localCommentId: null },
    }),
    prisma.user.count({ where: { isShadow: true } }),
    prisma.importUserMapping.count({ where: { source: IMPORT_SOURCE, sourceUserId: { lt: 0 } } }),
    prisma.post.count({ where: { author: { isShadow: true } } }),
    prisma.comment.count({ where: { author: { isShadow: true } } }),
    prisma.follow.count({ where: { follower: { isShadow: true } } }),
    prisma.pointLog.count({ where: { user: { isShadow: true } } }),
  ])

  return {
    syncEnabled,
    phase,
    cursor,
    backfillPage,
    stats: {
      postMappings,
      commentMappings,
      orphanMappings,
      shadowUsers,
      placeholderUsers,
      shadowPosts,
      shadowComments,
      shadowFollows,
      shadowPointLogs,
    },
  }
}

/** 单主题重灌：重新拉取该 NodeLoc 主题全量楼层（importTopic 幂等，已导主题返回 skipped） */
export async function reimportTopic(topicId: number): Promise<ImportTopicResult> {
  return importTopic(topicId)
}

/** 重建帖子搜索索引：确保索引存在后全量回填（回填完成后调用，否则回灌内容搜不到） */
export async function reindexPosts(): Promise<{ count: number }> {
  await ensurePostsIndex()
  const count = await reindexAll()
  return { count }
}
