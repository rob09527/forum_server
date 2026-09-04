/**
 * 从当前数据库提取 NodeLoc 初始化准备文件。
 *
 * 只读取 isShadow 用户、NodeLoc 映射指向的帖子/评论及其必要关系，
 * 不导出整库，也不触碰 Cool Admin 的 base_sys_* / _prisma_migrations。
 * 生成的 SQL 保留原始 ID，供新环境一次性初始化使用。
 *
 * 运行：pnpm nodeloc:extract
 */
import 'dotenv/config'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { Pool } from 'pg'

const ROOT = path.resolve(process.cwd(), 'scripts/import-nodeloc/dataset/current')
const DB_DIR = path.join(ROOT, 'database')
const REDIS_DIR = path.join(ROOT, 'redis')

const TABLES = [
  'categories', 'shop_items', 'users', 'posts', 'comments', 'post_likes',
  'comment_likes', 'bookmarks', 'follows', 'tips', 'bounties',
  'user_decorations', 'point_logs', 'import_user_mappings', 'import_mappings',
] as const

type Table = (typeof TABLES)[number]
type Row = Record<string, unknown>

function quote(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (value instanceof Date) return `'${value.toISOString().replaceAll("'", "''")}'::timestamptz`
  if (Buffer.isBuffer(value)) return `'\\x${value.toString('hex')}'::bytea`
  if (Array.isArray(value)) return `ARRAY[${value.map(quote).join(',')}]`
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return `'${String(value).replaceAll("'", "''")}'`
}

function sqlInsert(table: string, columns: string[], row: Row): string {
  const names = columns.map((column) => `"${column}"`).join(', ')
  const values = columns.map((column) => quote(row[column])).join(', ')
  return `INSERT INTO public."${table}" (${names}) VALUES (${values}) ON CONFLICT DO NOTHING;\n`
}

async function ids(pool: Pool, sql: string): Promise<number[]> {
  const result = await pool.query<{ id: number }>(sql)
  return result.rows.map((row) => Number(row.id))
}

function inList(values: Set<number>): string {
  return values.size === 0 ? 'NULL' : [...values].sort((a, b) => a - b).join(',')
}

async function exportTable(pool: Pool, table: Table, where: string): Promise<number> {
  const columnsResult = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`,
    [table],
  )
  const columns = columnsResult.rows.map((row) => row.column_name)
  const result = await pool.query<Row>(`SELECT * FROM public."${table}" WHERE ${where} ORDER BY "id"`)
  const file = path.join(DB_DIR, `${TABLES.indexOf(table).toString().padStart(2, '0')}-${table}.sql`)
  let text = `-- NodeLoc dataset; table=${table}; rows=${result.rowCount ?? 0}\n`
  for (const row of result.rows) text += sqlInsert(table, columns, row)
  await writeFile(file, text, 'utf8')
  return result.rowCount ?? 0
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('缺少 DATABASE_URL')
  const pool = new Pool({ connectionString: databaseUrl })
  try {
    await pool.query('SELECT 1')
    await rm(ROOT, { recursive: true, force: true })
    await mkdir(DB_DIR, { recursive: true })
    await mkdir(REDIS_DIR, { recursive: true })

    const shadow = new Set(await ids(pool, 'SELECT id FROM public.users WHERE "isShadow" = TRUE'))
    const postSet = new Set(await ids(pool, 'SELECT "localPostId" AS id FROM public.import_mappings WHERE source=\'nodeloc\' AND "localPostId" IS NOT NULL'))
    const commentSet = new Set(await ids(pool, 'SELECT "localCommentId" AS id FROM public.import_mappings WHERE source=\'nodeloc\' AND "localCommentId" IS NOT NULL'))
    const postWhere = `id IN (${inList(postSet)})`
    const commentWhere = `id IN (${inList(commentSet)})`

    const where: Record<Table, string> = {
      categories: `slug IN (SELECT DISTINCT category FROM public.posts WHERE ${postWhere})`,
      shop_items: `id IN (SELECT DISTINCT "itemId" FROM public.user_decorations WHERE "userId" IN (SELECT id FROM public.users WHERE "isShadow"=TRUE))`,
      users: `id IN (${inList(shadow)})`,
      posts: postWhere,
      comments: commentWhere,
      post_likes: `"postId" IN (${inList(postSet)}) AND "userId" IN (${inList(shadow)})`,
      comment_likes: `"commentId" IN (${inList(commentSet)}) AND "userId" IN (${inList(shadow)})`,
      bookmarks: `"postId" IN (${inList(postSet)}) AND "userId" IN (${inList(shadow)})`,
      follows: `"followerId" IN (${inList(shadow)}) AND "followeeId" IN (${inList(shadow)})`,
      tips: `("targetType"='post' AND "targetId" IN (${inList(postSet)})) OR ("targetType"='comment' AND "targetId" IN (${inList(commentSet)})) OR "fromUserId" IN (${inList(shadow)}) OR "toUserId" IN (${inList(shadow)})`,
      bounties: `"postId" IN (${inList(postSet)})`,
      user_decorations: `"userId" IN (${inList(shadow)})`,
      point_logs: `"userId" IN (${inList(shadow)})`,
      import_user_mappings: `source='nodeloc' AND "localUserId" IN (${inList(shadow)})`,
      import_mappings: `source='nodeloc' AND ("localPostId" IN (${inList(postSet)}) OR "localCommentId" IN (${inList(commentSet)}))`,
    }

    const counts: Record<string, number> = {}
    for (const table of TABLES) counts[table] = await exportTable(pool, table, where[table])

    const redisConfig = {
      formatVersion: 1,
      note: '仅维护 NodeLoc 初始化需要的配置；不包含 session、缓存、锁、游标和计数器。',
      keys: {
        'config:checkin': { base: 5, streakBonusPerDay: 1, streakBonusCap: 5, milestoneEvery: 7, milestoneBonus: 30 },
        'config:levels': [
          { key: 'mythic', name: '神兽', minTotal: 3200 }, { key: 'divine', name: '神鸟', minTotal: 1600 },
          { key: 'phoenix', name: '凤凰', minTotal: 800 }, { key: 'pheasant', name: '山鸡', minTotal: 400 },
          { key: 'free', name: '走地鸡', minTotal: 200 }, { key: 'whole', name: '整鸡', minTotal: 100 },
          { key: 'wing', name: '鸡翅', minTotal: 60 }, { key: 'meat', name: '鸡肉', minTotal: 30 },
          { key: 'leg', name: '鸡腿', minTotal: 10 }, { key: 'claw', name: '鸡爪', minTotal: 0 },
        ],
      },
    }
    await writeFile(path.join(REDIS_DIR, 'config.json'), `${JSON.stringify(redisConfig, null, 2)}\n`, 'utf8')
    const manifest = {
      formatVersion: 1,
      dataset: 'nodeloc',
      generatedAt: new Date().toISOString(),
      mode: 'final-state',
      tables: counts,
      shadowUserCount: shadow.size,
      postCount: postSet.size,
      commentCount: commentSet.size,
      assets: 'manual',
    }
    await writeFile(path.join(ROOT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    console.log(`[nodeloc:extract] 完成：${shadow.size} 个影子用户，${postSet.size} 篇帖子，${commentSet.size} 条评论`)
    console.log(`[nodeloc:extract] 准备文件：${ROOT}`)
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  console.error('[nodeloc:extract] 失败:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
