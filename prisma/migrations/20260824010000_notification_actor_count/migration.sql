-- 通知聚合：actorIds 只保留最近 3 个（防无界数组重写 O(n²)），
-- 新增 actorCount 冗余列记录触发者总数（like/follow 等于不同人数，comment 为评论次数近似）。
-- 共享库迁移约束：本文件经人工 review，由 prisma migrate deploy 应用。

-- 1) 新增 actorCount 列（默认 0）
ALTER TABLE "notifications" ADD COLUMN "actorCount" INTEGER NOT NULL DEFAULT 0;

-- 2) 回填：存量 actorCount = 数组长度
UPDATE "notifications" SET "actorCount" = cardinality("actorIds");

-- 3) 压缩存量超长数组为最近 3 个（保留后 3 个元素，对齐「最近触发者优先展示」语义）
UPDATE "notifications" SET "actorIds" = "actorIds"[1:3] WHERE cardinality("actorIds") > 3;
