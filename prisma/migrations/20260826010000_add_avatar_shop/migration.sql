-- 头像商品化：users 增加「租用头像」生效槽（基础头像 + 付费租用覆盖，见 docs/积分消费体系.md 1.3.3 单槽模型）
--
-- 共享库迁移约束（红线）：本库与 Cool Admin 共享（base_sys_* 等后台表同在）。
-- 本文件经人工 review 只保留加法操作（diff 可能生成 DROP TABLE "base_sys_*"，绝不可执行），
-- 由 `prisma migrate deploy` 应用。严禁 migrate dev / reset。
-- 存量数据天然兼容（新列全部可空），无需回填。

-- users：租用头像生效槽（2 列）
ALTER TABLE "users" ADD COLUMN "decorAvatarValue" TEXT,
ADD COLUMN "decorAvatarExpireAt" TIMESTAMP(3);
