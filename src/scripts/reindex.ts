import { ensurePostsIndex } from '../lib/meilisearch.js'
import { reindexAll } from '../services/search/search.service.js'

/**
 * 全量回填帖子搜索索引（存量数据首次回填 / 索引损坏修复）。
 * 运行：pnpm search:reindex
 */
const run = async () => {
  try {
    await ensurePostsIndex()
    const count = await reindexAll()
    console.log(`[search] 索引就绪，已写入 ${count} 篇帖子`)
    process.exit(0)
  } catch (err) {
    console.error('[search] 回填失败:', err)
    process.exit(1)
  }
}

run()
