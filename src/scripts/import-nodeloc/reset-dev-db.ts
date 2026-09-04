import readline from 'node:readline'
import { config } from '../../config.js'
import { prisma } from '../../lib/prisma.js'
import { redis } from '../../lib/redis.js'
import { meili, POSTS_INDEX } from '../../lib/meilisearch.js'
import { hashPassword } from '../../utils/password.js'
import { deterministicLocalAvatar } from '../../utils/avatar.js'

/**
 * NodeLoc 全量回填前的清库脚本(仅限本地 dev 库,交接文档阶段 2 前置步骤)。
 * 运行:pnpm tsx src/scripts/import-nodeloc/reset-dev-db.ts
 *
 * 做三件事:
 * 1. TRUNCATE 业务内容表(RESTART IDENTITY CASCADE),**保留**:
 *    categories / shop_items(种子配置)、announcements / adverts(运营内容,无用户外键)
 *    ⚠️ 永远不碰 admin 的 base_sys_* 表与 _prisma_migrations(共享库红线)
 * 2. 前缀删除 Redis 业务键(SCAN 非阻塞),**保留** config:*(admin 写的 6 组游戏化配置)
 *    与 admin 前缀(admin:* / verify:* / dict:*);禁止 FLUSHDB
 * 3. 重建 UI 测试账号 demo_user_ui(截图脚本依赖;注意 id 会变,不再是 73)
 *    与清空 Meilisearch posts 索引(回填后统一 search:reindex)
 *
 * 双守卫(防误删生产):
 *   - NODE_ENV 必须为 development(dev .env 设 development;生产/测试 compose 设 production)
 *   - 非交互终端拒绝 + 要求完整输入目标库名确认(防 DATABASE_URL 误指到生产)
 */

/** 要清空的业务表(与 prisma schema @@map 一一对应;CASCADE 兜底漏列的外键) */
const TRUNCATE_TABLES = [
  'users',
  'posts',
  'comments',
  'post_likes',
  'comment_likes',
  'point_logs',
  'bookmarks',
  'follows',
  'notifications',
  'notification_messages',
  'user_decorations',
  'tips',
  'bounties',
  'conversations',
  'messages',
  'import_mappings',
  'import_user_mappings',
]

/** 要前缀清理的 Redis 业务键(不含 config:*,不含 admin 前缀) */
const REDIS_PREFIXES = [
  'session:',
  'user:',
  'post:',
  'posts:',
  'upload_rate:',
  'checkin:',
  'dm:',
  'dm_rate:',
  'point_daily:',
  'rate:',
  'bounty:',
  'decoration:',
  'import:',
]

/**
 * UI 截图测试账号(docs/scripts/出图 依赖)。
 * 默认值仅用于本地 dev(脚本本身被 NODE_ENV 守卫锁死在 development);可用 TEST_* 覆盖。
 */
const DEMO_EMAIL = process.env.TEST_EMAIL ?? 'demo_user_ui@forum.local'
const DEMO_USERNAME = process.env.TEST_USERNAME ?? 'demo_user_ui'
const DEMO_PASSWORD = process.env.TEST_PASSWORD ?? 'demo123456'

/** 从 DATABASE_URL 提取库名用于确认提示(尽力而为，解析失败退回 'forum') */
function dbNameFromUrl(url: string): string {
  try {
    const name = new URL(url).pathname.replace(/^\//, '')
    return name || 'forum'
  } catch {
    const m = url.match(/\/([^/?]+)(?:[?]|$)/)
    return m?.[1] ?? 'forum'
  }
}

/** 破坏性操作前的确认：非交互终端直接拒绝，否则要求完整输入目标库名 */
async function confirmReset(dbName: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('[reset] ✗ 当前不是交互终端，拒绝在无人确认的情况下清库。请在终端里直接运行本脚本。')
    process.exit(1)
  }

  console.log('\n=============== 即将清空(破坏性操作)===============')
  console.log(`  目标库      : ${dbName}`)
  console.log(`  业务表      : ${TRUNCATE_TABLES.length} 张(见脚本顶部 TRUNCATE_TABLES)`)
  console.log('  Redis       : 按前缀删除业务键(config:* 与 admin:* 保留，不 FLUSHDB)')
  console.log('  Meilisearch : 清空 posts 索引')
  console.log('  不会触及    : base_sys_*(后台账号/菜单)、_prisma_migrations(迁移历史)')
  console.log('====================================================\n')

  const answer = await new Promise<string>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(`确认清空?请完整输入目标库名「${dbName}」以继续(其它任何输入取消):`, (a) => {
      rl.close()
      resolve(a.trim())
    })
  })
  if (answer !== dbName) {
    console.log('[reset] 已取消，未做任何改动。')
    process.exit(0)
  }
}

async function truncateTables(): Promise<void> {
  const list = TRUNCATE_TABLES.map((t) => `"${t}"`).join(', ')
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`)
  console.log(`[reset] 已清空 ${TRUNCATE_TABLES.length} 张业务表(保留 categories/shop_items/announcements/adverts)`)
}

async function cleanRedis(): Promise<void> {
  let removed = 0
  for (const prefix of REDIS_PREFIXES) {
    let cursor = '0'
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500)
      cursor = next
      if (keys.length) {
        await redis.del(...keys)
        removed += keys.length
      }
    } while (cursor !== '0')
  }
  console.log(`[reset] Redis 已按前缀删除 ${removed} 个业务键(config:* 与 admin 前缀未动)`)
}

async function recreateDemoUser(): Promise<void> {
  const user = await prisma.user.create({
    data: {
      username: DEMO_USERNAME,
      email: DEMO_EMAIL,
      passwordHash: await hashPassword(DEMO_PASSWORD),
      avatar: deterministicLocalAvatar(DEMO_USERNAME),
    },
    select: { id: true },
  })
  console.log(`[reset] 测试账号 ${DEMO_EMAIL} 已重建,新 id=${user.id}(截图脚本里写死的旧 id 73 已失效)`)
}

async function clearSearchIndex(): Promise<void> {
  try {
    await meili.index(POSTS_INDEX).deleteAllDocuments()
    console.log('[reset] Meilisearch posts 索引已清空(回填完成后跑 pnpm search:reindex)')
  } catch (err) {
    console.warn('[reset] Meilisearch 清空失败(可忽略,reindex 会覆盖):', (err as Error).message)
  }
}

const run = async () => {
  // 守卫 1：仅限 development 环境（dev .env 设 development；生产/测试 compose 设 production）
  if (config.NODE_ENV !== 'development') {
    console.error(`[reset] ✗ 拒绝执行：NODE_ENV=${config.NODE_ENV}，本脚本仅限 development 环境。`)
    console.error('    生产/测试库请人工核对后操作（本脚本仅限 dev 环境，勿用于其它库）。')
    process.exit(1)
  }
  // 守卫 2：非交互终端 + 输入目标库名（防 DATABASE_URL 误指到生产）
  await confirmReset(dbNameFromUrl(config.DATABASE_URL))

  console.log('[reset] 开始清理 dev 库(共享库红线:不触碰 base_sys_* / _prisma_migrations)')
  await truncateTables()
  await cleanRedis()
  await recreateDemoUser()
  await clearSearchIndex()
  console.log('[reset] 完成')
}

run()
  .catch((err) => {
    console.error('[reset] 失败:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    redis.disconnect()
  })
