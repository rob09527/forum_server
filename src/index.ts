import { fastify } from './app.js'
import { config } from './config.js'
import { ensurePostsIndex } from './lib/meilisearch.js'

// 确保 Meili 帖子索引存在并应用设置（幂等）。不阻塞启动——搜索是派生能力，
// Meili 暂时不可用时服务照常启动，索引就绪后可用 search:reindex 回填。
ensurePostsIndex().catch((err) => {
  console.error('[search] ensure posts index failed:', err.message)
})

const start = async () => {
  try {
    await fastify.listen({ port: config.PORT, host: config.HOST })
    console.log(`Server running at http://localhost:${config.PORT}`)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
