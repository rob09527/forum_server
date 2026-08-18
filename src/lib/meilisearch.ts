import { MeiliSearch } from 'meilisearch'
import { config } from '../config.js'

/** 帖子搜索索引名 */
export const POSTS_INDEX = 'posts'

/**
 * 全局 Meilisearch 客户端实例。
 * 所有模块共用这一个实例，不要各自 new MeiliSearch()。
 * 本地 dev 无 master key；生产通过 .env 注入。
 */
export const meili = new MeiliSearch({
  host: config.MEILI_HOST,
  apiKey: config.MEILI_MASTER_KEY || undefined,
})

/**
 * 确保帖子索引存在并应用索引设置（幂等，服务启动时调用）。
 * 索引不存在则创建（primaryKey 用帖子自增 id），已存在则仅更新设置。
 */
export async function ensurePostsIndex(): Promise<void> {
  try {
    await meili.getRawIndex(POSTS_INDEX)
  } catch {
    await meili.createIndex(POSTS_INDEX, { primaryKey: 'id' })
  }

  await meili.index(POSTS_INDEX).updateSettings({
    searchableAttributes: ['title', 'content'],
    filterableAttributes: ['category', 'authorId', 'tags'],
    sortableAttributes: ['createdAt'],
    rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness', 'createdAt:desc'],
  })
}
