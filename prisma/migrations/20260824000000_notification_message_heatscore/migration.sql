-- 系统通知群发正文单独存一张表，通知行通过 messageId 引用，避免逐用户冗余存储
-- （十万用户广播 → 1 条正文 + 每行一个 int 引用，而非 10 万 × 正文）
CREATE TABLE "notification_messages" (
    "id" SERIAL NOT NULL,
    "content" TEXT NOT NULL,
    "postId" INTEGER,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_messages_pkey" PRIMARY KEY ("id")
);

-- 通知表增加群发消息引用（可空；存量 system 通知 content 兜底，无需迁移数据）
ALTER TABLE "notifications" ADD COLUMN "messageId" INTEGER;
CREATE INDEX "notifications_messageId_idx" ON "notifications"("messageId");

-- 帖子热度分物化列（likeCount*300 + commentCount*200 + viewCount），并回填存量
ALTER TABLE "posts" ADD COLUMN "heatScore" INTEGER NOT NULL DEFAULT 0;
UPDATE "posts" SET "heatScore" = "likeCount" * 300 + "commentCount" * 200 + "viewCount";

-- 置顶优先 + 时间倒序（latest 首页 / 板块列表，orderBy [isPinned, createdAt] 走索引）
CREATE INDEX "posts_isPinned_createdAt_idx" ON "posts"("isPinned", "createdAt" DESC);
CREATE INDEX "posts_category_isPinned_createdAt_idx" ON "posts"("category", "isPinned", "createdAt" DESC);
-- 热度窗口扫描 + 热度倒序（hot 列表：WHERE createdAt >= 近7天 ORDER BY heatScore DESC）
CREATE INDEX "posts_createdAt_heatScore_idx" ON "posts"("createdAt", "heatScore" DESC);
