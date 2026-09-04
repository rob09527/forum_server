/**
 * NodeLoc 初始化：导入版本化 SQL 准备文件并写入必要 Redis 配置。
 * 图片资源由部署者自行放入 uploads，本脚本只导入数据库和配置。
 *
 * 运行：pnpm nodeloc:init
 */
import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { Pool } from 'pg'
import { Redis } from 'ioredis'

interface Manifest {
  /** 准备文件格式版本 */
  formatVersion: number
  /** 数据集名称 */
  dataset: string
  /** 各 SQL 文件对应行数 */
  tables: Record<string, number>
  /** 当前数据集中的影子用户数 */
  shadowUserCount: number
  /** 当前数据集中的帖子数 */
  postCount: number
  /** 当前数据集中的评论数 */
  commentCount: number
}

interface RedisDataset {
  /** Redis 准备文件格式版本 */
  formatVersion: number
  /** 允许初始化的配置 key */
  keys: Record<string, unknown>
}

const SQL_FILES = [
  '00-categories.sql',
  '01-shop_items.sql',
  '02-users.sql',
  '03-posts.sql',
  '04-comments.sql',
  '05-post_likes.sql',
  '06-comment_likes.sql',
  '07-bookmarks.sql',
  '08-follows.sql',
  '09-tips.sql',
  '10-bounties.sql',
  '11-user_decorations.sql',
  '12-point_logs.sql',
  '13-import_user_mappings.sql',
  '14-import_mappings.sql',
] as const

const REDIS_KEYS = new Set([
  'config:checkin', 'config:levels', 'config:shop', 'config:tip',
  'config:bounty', 'config:props', 'config:limits',
])

function datasetRoot(): string {
  return path.resolve(process.cwd(), process.env.NODELOC_DATA_DIR ?? 'scripts/import-nodeloc/dataset/current')
}

function parseJson<T>(text: string, file: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`准备文件 JSON 无法解析：${file}`)
  }
}

async function loadDataset(root: string): Promise<{ manifest: Manifest; redis: RedisDataset }> {
  const manifest = parseJson<Manifest>(await readFile(path.join(root, 'manifest.json'), 'utf8'), 'manifest.json')
  const redis = parseJson<RedisDataset>(await readFile(path.join(root, 'redis/config.json'), 'utf8'), 'redis/config.json')
  if (manifest.formatVersion !== 1 || manifest.dataset !== 'nodeloc') throw new Error('不支持的 NodeLoc 准备文件版本')
  if (redis.formatVersion !== 1) throw new Error('不支持的 Redis 准备文件版本')
  for (const key of Object.keys(redis.keys)) {
    if (!REDIS_KEYS.has(key)) throw new Error(`Redis 准备文件含未允许的 key：${key}`)
  }
  for (const file of SQL_FILES) await readFile(path.join(root, 'database', file))
  return { manifest, redis }
}

async function importSql(pool: Pool, root: string, manifest: Manifest): Promise<void> {
  await pool.query('BEGIN')
  try {
    for (const file of SQL_FILES) {
      const sql = await readFile(path.join(root, 'database', file), 'utf8')
      if (!sql.trim()) continue
      console.log(`[nodeloc:init] 导入 ${file}（${manifest.tables[file.replace(/^\d+-/, '').replace(/\.sql$/, '')] ?? '?'} 行）`)
      await pool.query(sql)
    }
    await pool.query('COMMIT')
  } catch (error) {
    await pool.query('ROLLBACK')
    throw error
  }
}

async function updateSequences(pool: Pool): Promise<void> {
  // 保留原始 ID 后必须推进序列，否则下一次真实插入可能发生主键冲突。
  const tables = ['categories', 'shop_items', 'users', 'posts', 'comments', 'post_likes', 'comment_likes', 'bookmarks', 'follows', 'tips', 'bounties', 'user_decorations', 'point_logs', 'import_user_mappings', 'import_mappings']
  for (const table of tables) {
    await pool.query(`SELECT setval(pg_get_serial_sequence('public."${table}"', 'id'), COALESCE((SELECT MAX("id") FROM public."${table}"), 1), (SELECT COUNT(*) > 0 FROM public."${table}"))`)
  }
}

async function importRedis(redisUrl: string, dataset: RedisDataset): Promise<void> {
  const redis = new Redis(redisUrl)
  try {
    for (const [key, value] of Object.entries(dataset.keys)) {
      const next = JSON.stringify(value)
      const current = await redis.get(key)
      if (current === next) {
        console.log(`[nodeloc:init] Redis ${key} 已是目标值，跳过`)
        continue
      }
      if (current !== null && process.env.NODELOC_REDIS_FORCE !== 'true') {
        throw new Error(`Redis ${key} 已存在且内容不同；如确认覆盖请设置 NODELOC_REDIS_FORCE=true`)
      }
      await redis.set(key, next)
      await redis.publish('config:invalidate', key)
      console.log(`[nodeloc:init] Redis ${key} 已写入`)
    }
  } finally {
    await redis.quit()
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  const redisUrl = process.env.REDIS_URL
  if (!databaseUrl) throw new Error('缺少 DATABASE_URL')
  if (!redisUrl) throw new Error('缺少 REDIS_URL')
  const root = datasetRoot()
  const { manifest, redis: redisDataset } = await loadDataset(root)
  console.log(`[nodeloc:init] 目标数据集：${manifest.shadowUserCount} 个影子用户、${manifest.postCount} 篇帖子、${manifest.commentCount} 条评论`)

  const pool = new Pool({ connectionString: databaseUrl })
  try {
    await pool.query('SELECT 1')
    await importSql(pool, root, manifest)
    await updateSequences(pool)
  } finally {
    await pool.end()
  }
  await importRedis(redisUrl, redisDataset)
  console.log('[nodeloc:init] ✓ 数据库与 Redis 初始化完成')
}

main().catch((error: unknown) => {
  console.error('[nodeloc:init] 失败：', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
