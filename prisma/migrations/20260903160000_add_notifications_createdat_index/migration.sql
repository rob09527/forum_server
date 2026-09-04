-- admin 后台「通知」列表的排序索引。
-- 手写迁移，只走 prisma migrate deploy（共享库，严禁 migrate dev/reset）。
-- 不用 CONCURRENTLY：Prisma 迁移在事务里执行，CONCURRENTLY 不允许在事务内建索引。
--
-- 为什么需要：后台列表是全表 `ORDER BY a."createdAt" DESC` 分页，
-- 现有索引 (userId, isRead, createdAt DESC) 以 userId 前导，排序用不上。
-- 导入完成后本表与 comments 同阶（约 16.8 万行），缺这条每翻一页都会全表扫 + 排序。
CREATE INDEX IF NOT EXISTS "notifications_createdAt_idx" ON "notifications" ("createdAt" DESC);
