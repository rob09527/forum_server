import { prisma } from '../../lib/prisma.js'
import { fetchNodelocJson } from './nodeloc-client.js'
import { IMPORT_SOURCE } from './import-config.js'
import { resolveCategory } from './category-map.js'
import { resolveTopicImages } from './import-images.js'
import { cleanMarkdown } from './clean-markdown.js'
import { resolvePostAuthor } from './shadow-users.js'
import type { DiscourseTopicDetail, DiscoursePost, DiscoursePostsResponse } from './nodeloc-types.js'

/**
 * 单主题全量导入:/t/{id}.json?include_raw=1(首 20 楼)+ /t/{id}/posts.json 补楼 →
 * 本地 Post + Comment 树 + import_mappings。
 * 楼层规则对齐 comment.service:
 * - 一楼 → Post;回复一楼/无回复对象 → 顶层 Comment(顺序 floor,计入 commentCount)
 * - 回复其他楼层 → 楼中楼,parentId 归一到**顶层祖先**(本站只有两层),floor=null,不计 commentCount
 * 计数只初始化一次(决策 6):viewCount=对方 views,likeCount=actions_summary id=2,
 * heatScore 按物化公式本地算;PointLog 不在此写(阶段 2.5 造数统一重放)。
 */

/** 补楼批大小(post_ids[] 查询串长度可控,Discourse 单批上限 300 内) */
const POSTS_BATCH_SIZE = 200

/** 导入结果状态 */
export type ImportTopicStatus = 'imported' | 'skipped' | 'excluded' | 'missing' | 'empty'

export interface ImportTopicResult {
  status: ImportTopicStatus
  /** status=imported 时的本地帖子 id */
  localPostId?: number
  /** 导入的评论行数(含楼中楼) */
  commentCount?: number
}

/** 从 actions_summary 取 like 数(id=2;like_count 字段实测恒为 null) */
function likeCountOf(post: DiscoursePost): number {
  return post.actions_summary?.find((a) => a.id === 2)?.count ?? 0
}

/** 组装本地 tags:子分类名 + 对方 tags(NodeLoc 实测为 {name} 对象数组),去重、每个 ≤20 字符、最多 5 个 */
export function buildTags(
  subcategoryName: string | null,
  topicTags: (string | { name: string })[] | undefined,
): string[] {
  const tags: string[] = []
  const names = (topicTags ?? []).map((t) => (typeof t === 'string' ? t : t?.name))
  for (const t of [subcategoryName, ...names]) {
    const tag = t?.trim().slice(0, 20)
    if (tag && !tags.includes(tag)) tags.push(tag)
    if (tags.length >= 5) break
  }
  return tags
}

/** 拉全主题楼层:详情自带首 20 楼,按 stream 差集分批补拉(均带 raw) */
async function fetchAllPosts(topic: DiscourseTopicDetail): Promise<DiscoursePost[]> {
  const posts = [...topic.post_stream.posts]
  const have = new Set(posts.map((p) => p.id))
  const missing = (topic.post_stream.stream ?? []).filter((id) => !have.has(id))

  for (let i = 0; i < missing.length; i += POSTS_BATCH_SIZE) {
    const batch = missing.slice(i, i + POSTS_BATCH_SIZE)
    const qs = batch.map((id) => `post_ids[]=${id}`).join('&')
    const res = await fetchNodelocJson<DiscoursePostsResponse>(
      `/t/${topic.id}/posts.json?${qs}&include_raw=1`,
    )
    if (res?.post_stream?.posts) posts.push(...res.post_stream.posts)
  }

  posts.sort((a, b) => a.post_number - b.post_number)
  return posts
}

/**
 * 导入一个主题。幂等:一楼已有 import_mappings 记录 → skipped(增量更新走 sync 服务)。
 */
export async function importTopic(topicId: number): Promise<ImportTopicResult> {
  // 幂等预检(按 topicId,免抓取):回填断点重跑时已导主题秒级跳过,不白耗对方 API 配额
  const existingTopic = await prisma.importMapping.findFirst({
    where: { source: IMPORT_SOURCE, sourceTopicId: topicId, localPostId: { not: null } },
    select: { localPostId: true },
  })
  if (existingTopic) return { status: 'skipped', localPostId: existingTopic.localPostId ?? undefined }

  const topic = await fetchNodelocJson<DiscourseTopicDetail>(`/t/${topicId}.json?include_raw=1`)
  if (!topic) return { status: 'missing' } // 404/403:已删或登录可见,跳过
  if (topic.has_read_permission_restriction) return { status: 'missing' }

  const category = await resolveCategory(topic.category_id)
  if (category.excluded) return { status: 'excluded' }

  const posts = await fetchAllPosts(topic)
  const first = posts.find((p) => p.post_number === 1)
  // 一楼被作者自删/隐藏 → 整帖没有正文载体,跳过
  if (!first || first.user_deleted || first.hidden || !first.raw) return { status: 'empty' }

  // 幂等检查(以一楼 source post id 为准)
  const existing = await prisma.importMapping.findUnique({
    where: { source_sourcePostId: { source: IMPORT_SOURCE, sourcePostId: first.id } },
    select: { id: true, localPostId: true },
  })
  if (existing) return { status: 'skipped', localPostId: existing.localPostId ?? undefined }

  // 图片管道(下载在事务外做,IO 慢且失败可兜底远程 URL)
  const imageCtx = await resolveTopicImages(posts)

  // 作者归一(含影子用户创建,也在事务外:头像下载有网络 IO)
  const authorIdByPostNumber = new Map<number, number>()
  for (const p of posts) {
    authorIdByPostNumber.set(p.post_number, await resolvePostAuthor(p))
  }

  const postCreatedAt = new Date(topic.created_at)
  const content = cleanMarkdown(first.raw, imageCtx)
  const tags = buildTags(category.subcategoryName, topic.tags)

  // 楼层分拣:顶层(回复一楼/无回复对象)与楼中楼;楼中楼 parent 归一到顶层祖先
  const commentSources = posts.filter(
    (p) => p.post_number > 1 && !p.user_deleted && !p.hidden && p.raw,
  )

  const result = await prisma.$transaction(
    async (tx) => {
      const post = await tx.post.create({
        data: {
          title: topic.title.slice(0, 200),
          content: content || topic.title, // 清洗后空正文(纯投票帖等)兜底标题
          category: category.slug,
          tags,
          authorId: authorIdByPostNumber.get(1)!,
          viewCount: topic.views ?? 0,
          likeCount: likeCountOf(first),
          createdAt: postCreatedAt,
          updatedAt: postCreatedAt,
        },
        select: { id: true },
      })

      // 逐楼建评论:floor 只给顶层;楼中楼 parentId=顶层祖先 id
      /** post_number → { localId, topLevelId }(topLevelId 用于把深层回复拍平到两层) */
      const byNumber = new Map<number, { localId: number; topLevelId: number }>()
      let floor = 0
      let topLevelCount = 0
      /** 作者 → 其顶层评论数(users.commentCount 只算顶层,见下方冗余计数处的说明) */
      const topLevelByAuthor = new Map<number, number>()

      for (const p of commentSources) {
        const replyTo = p.reply_to_post_number ?? 1
        const parentInfo = replyTo > 1 ? byNumber.get(replyTo) : undefined
        const isTopLevel = !parentInfo
        if (isTopLevel) {
          floor += 1
          topLevelCount += 1
          const uid = authorIdByPostNumber.get(p.post_number)!
          topLevelByAuthor.set(uid, (topLevelByAuthor.get(uid) ?? 0) + 1)
        }

        const comment = await tx.comment.create({
          data: {
            postId: post.id,
            authorId: authorIdByPostNumber.get(p.post_number)!,
            content: cleanMarkdown(p.raw!, imageCtx) || '……',
            parentId: parentInfo ? parentInfo.topLevelId : null,
            floor: isTopLevel ? floor : null,
            likeCount: likeCountOf(p),
            createdAt: new Date(p.created_at),
          },
          select: { id: true },
        })
        byNumber.set(p.post_number, {
          localId: comment.id,
          topLevelId: parentInfo ? parentInfo.topLevelId : comment.id,
        })
      }

      // 冗余计数 + 物化热度(commentCount 只算顶层,对齐 comment.service 口径)
      const totalLikes = likeCountOf(first)
      await tx.post.update({
        where: { id: post.id },
        data: {
          commentCount: topLevelCount,
          heatScore: totalLikes * 300 + topLevelCount * 200 + (topic.views ?? 0),
        },
      })

      // 作者冗余计数。users.commentCount **只算顶层评论**:comment.service 的 +1 写在
      // `parentId === null` 分支里(与 post.commentCount 同口径),楼中楼回复不计。
      // 早先这里按全部评论累加,导致 users.commentCount 比实际口径偏大(已修正)。
      await tx.user.update({
        where: { id: authorIdByPostNumber.get(1)! },
        data: { postCount: { increment: 1 } },
      })
      for (const [uid, n] of topLevelByAuthor) {
        await tx.user.update({ where: { id: uid }, data: { commentCount: { increment: n } } })
      }

      // 映射行:一楼 → localPostId,其余 → localCommentId
      await tx.importMapping.createMany({
        data: [
          {
            source: IMPORT_SOURCE,
            sourceTopicId: topic.id,
            sourcePostId: first.id,
            sourcePostNumber: 1,
            sourceVersion: first.version ?? 1,
            localPostId: post.id,
            localUserId: authorIdByPostNumber.get(1)!,
          },
          ...commentSources.map((p) => ({
            source: IMPORT_SOURCE,
            sourceTopicId: topic.id,
            sourcePostId: p.id,
            sourcePostNumber: p.post_number,
            sourceVersion: p.version ?? 1,
            localCommentId: byNumber.get(p.post_number)!.localId,
            localUserId: authorIdByPostNumber.get(p.post_number)!,
          })),
        ],
      })

      return { localPostId: post.id, commentCount: commentSources.length }
    },
    { timeout: 60_000 }, // 千楼大帖行数多,放宽默认 5s 事务超时
  )

  return { status: 'imported', ...result }
}
