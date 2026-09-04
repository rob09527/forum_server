-- NodeLoc 导入后的规模索引补齐（users 约 3 万行、import_mappings 约 18 万行）。
-- 手写迁移，只走 prisma migrate deploy（共享库，严禁 migrate dev/reset）。
-- 不用 CONCURRENTLY：Prisma 迁移在事务里执行，CONCURRENTLY 不允许在事务内建索引；
-- 当前两表体量还小（users 数百行），直接建索引的锁时间可忽略。

-- 首页「最新加入」getLatestUsers：ORDER BY "createdAt" DESC LIMIT n
CREATE INDEX IF NOT EXISTS "users_createdAt_idx" ON "users" ("createdAt" DESC);

-- 增量 worker 与 verify.ts 按本地评论 id 反查映射行
CREATE INDEX IF NOT EXISTS "import_mappings_localCommentId_idx" ON "import_mappings" ("localCommentId");
