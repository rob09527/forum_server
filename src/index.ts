import { fastify } from './app.js'
import { config } from './config.js'
import { ensurePostsIndex } from './lib/meilisearch.js'
import { checkAndNotifyExpired } from './services/shop/decoration-remind.js'
import { sweepExpiredBounties } from './services/bounty/bounty-sweep.js'

// 确保 Meili 帖子索引存在并应用设置（幂等）。不阻塞启动——搜索是派生能力，
// Meili 暂时不可用时服务照常启动，索引就绪后可用 search:reindex 回填。
ensurePostsIndex().catch((err) => {
  console.error('[search] ensure posts index failed:', err.message)
})

// 积分消费体系定时任务 [1.6.3][T3]：60s 周期，进程内调度器（无独立 worker）。
// - sweepExpiredBounties：Redis 抢锁（SET NX EX 60），多实例只有一个真正扫描
// - checkAndNotifyExpired：装饰到期当日提醒，事务内 set expiredNotifiedAt 幂等
// 两个任务彼此独立，串行执行、各自 try/catch，避免一个失败拖垮整轮。
const SCHEDULE_INTERVAL_MS = 60_000
setInterval(async () => {
  await runScheduled('bounty-sweep', sweepExpiredBounties)
  await runScheduled('decoration-remind', checkAndNotifyExpired)
}, SCHEDULE_INTERVAL_MS)

/** 调度器兜底：任务抛错只记日志，不影响后续任务与进程存活 */
async function runScheduled(name: string, task: () => Promise<unknown>): Promise<void> {
  try {
    await task()
  } catch (err) {
    console.error(`[scheduler] ${name} failed:`, err)
  }
}

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
