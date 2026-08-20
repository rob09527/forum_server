-- 点赞软删：取消点赞置 active=false 保留记录，重赞时不重复发分。
-- 该列此前经本地 db push 直接加到部分库（不在迁移历史内），
-- 用 IF NOT EXISTS 幂等：已加列的库跳过，未加列的库补齐。
ALTER TABLE "comment_likes" ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "post_likes" ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true;
