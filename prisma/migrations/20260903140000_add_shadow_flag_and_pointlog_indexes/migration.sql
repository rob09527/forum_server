-- 影子用户标记 + 后台积分流水/看板索引。
-- 手写迁移，只走 prisma migrate deploy（共享库，严禁 migrate dev/reset）。
-- 不用 CONCURRENTLY：Prisma 迁移在事务里执行，CONCURRENTLY 不允许在事务内建索引。
-- 本迁移在回填进程停止的窗口内执行，避免建索引的锁与导入写入相互等待。

-- 是否为外站数据导入生成的「影子用户」。
-- 加 DEFAULT false 是纯追加操作，不重写已有行，也不会丢数据。
-- 已回填的影子用户由随后的一条 UPDATE（join import_user_mappings）回填为 true。
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "isShadow" BOOLEAN NOT NULL DEFAULT false;

-- 排除影子用户后按注册时间倒序：getLatestUsers、admin 用户列表筛「真实用户」
CREATE INDEX IF NOT EXISTS "users_isShadow_createdAt_idx" ON "users" ("isShadow", "createdAt" DESC);

-- admin「积分流水」列表默认排序（现有两条索引均以 userId 前导，此处用不上）
CREATE INDEX IF NOT EXISTS "point_logs_createdAt_idx" ON "point_logs" ("createdAt" DESC);

-- admin 看板 getOverview 的按类型聚合
CREATE INDEX IF NOT EXISTS "point_logs_type_idx" ON "point_logs" ("type");
