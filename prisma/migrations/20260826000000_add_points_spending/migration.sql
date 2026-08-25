-- 积分消费体系：4 张新表 + users/posts/comments/point_logs 扩展（docs/积分消费体系.md 第 1.7 节）
--
-- 共享库迁移约束（红线）：本库与 Cool Admin 共享（base_sys_* 等后台表同在）。
-- 本文件经人工 review 去除了 migrate diff 生成的 DROP TABLE "base_sys_*"（diff 会把
-- Prisma schema 之外的 admin 表误判为「多余表」而生成 DROP，绝不可执行），
-- 只保留加法操作，由 `prisma migrate deploy` 应用。严禁 migrate dev / reset。
-- 存量数据天然兼容（新列全部可空或有默认值），无需回填。

-- 1) comments：打赏冗余列
ALTER TABLE "comments" ADD COLUMN "tipAmount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "tipCount" INTEGER NOT NULL DEFAULT 0;

-- 2) posts：打赏冗余列 + 悬赏冗余列
ALTER TABLE "posts" ADD COLUMN "bountyAmount" INTEGER,
ADD COLUMN "bountyStatus" TEXT,
ADD COLUMN "tipAmount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "tipCount" INTEGER NOT NULL DEFAULT 0;

-- 3) users：装饰生效槽（6 列）+ 上传配额加购
ALTER TABLE "users" ADD COLUMN "decorColorExpireAt" TIMESTAMP(3),
ADD COLUMN "decorColorValue" TEXT,
ADD COLUMN "decorTitleExpireAt" TIMESTAMP(3),
ADD COLUMN "decorTitleStyle" TEXT,
ADD COLUMN "decorTitleValue" TEXT,
ADD COLUMN "uploadQuotaBonus" INTEGER NOT NULL DEFAULT 0;

-- 4) 装饰商品目录
CREATE TABLE "shop_items" (
    "id" SERIAL NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "renderValue" TEXT NOT NULL,
    "renderStyle" TEXT,
    "price" INTEGER NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_items_pkey" PRIMARY KEY ("id")
);

-- 5) 用户装饰持有记录
CREATE TABLE "user_decorations" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "renderValue" TEXT NOT NULL,
    "renderStyle" TEXT,
    "price" INTEGER NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "expireAt" TIMESTAMP(3) NOT NULL,
    "expiredNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_decorations_pkey" PRIMARY KEY ("id")
);

-- 6) 打赏账本
CREATE TABLE "tips" (
    "id" SERIAL NOT NULL,
    "fromUserId" INTEGER NOT NULL,
    "toUserId" INTEGER NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tips_pkey" PRIMARY KEY ("id")
);

-- 7) 悬赏账本
CREATE TABLE "bounties" (
    "id" SERIAL NOT NULL,
    "postId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'escrow',
    "expireAt" TIMESTAMP(3) NOT NULL,
    "acceptedCommentId" INTEGER,
    "acceptedUserId" INTEGER,
    "payout" INTEGER,
    "fee" INTEGER,
    "settleType" TEXT,
    "settledAt" TIMESTAMP(3),
    "operator" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bounties_pkey" PRIMARY KEY ("id")
);

-- 8) 索引
CREATE INDEX "shop_items_type_isActive_sortOrder_idx" ON "shop_items"("type", "isActive", "sortOrder");

CREATE INDEX "user_decorations_userId_type_expireAt_idx" ON "user_decorations"("userId", "type", "expireAt" DESC);
CREATE INDEX "user_decorations_itemId_idx" ON "user_decorations"("itemId");
CREATE UNIQUE INDEX "user_decorations_userId_itemId_key" ON "user_decorations"("userId", "itemId");

CREATE INDEX "tips_targetType_targetId_createdAt_idx" ON "tips"("targetType", "targetId", "createdAt" DESC);
CREATE INDEX "tips_fromUserId_createdAt_idx" ON "tips"("fromUserId", "createdAt" DESC);
CREATE INDEX "tips_toUserId_createdAt_idx" ON "tips"("toUserId", "createdAt" DESC);
CREATE UNIQUE INDEX "tips_fromUserId_targetType_targetId_key" ON "tips"("fromUserId", "targetType", "targetId");

CREATE UNIQUE INDEX "bounties_postId_key" ON "bounties"("postId");
CREATE INDEX "bounties_status_expireAt_idx" ON "bounties"("status", "expireAt");
CREATE INDEX "bounties_userId_status_idx" ON "bounties"("userId", "status");

CREATE INDEX "point_logs_userId_type_createdAt_idx" ON "point_logs"("userId", "type", "createdAt" DESC);

CREATE INDEX "posts_bountyStatus_createdAt_idx" ON "posts"("bountyStatus", "createdAt" DESC);
