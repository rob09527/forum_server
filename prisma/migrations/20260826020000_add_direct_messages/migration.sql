-- 私信（1v1 会话化）：users 加 dmPrivacy 隐私开关 + 新增 conversations / messages 表。
--
-- 共享库迁移约束（红线）：本库与 Cool Admin 共享（base_sys_* 等后台表同在）。
-- 本文件经人工 review 只保留加法操作（diff 可能生成 DROP TABLE "base_sys_*"，绝不可执行），
-- 由 `prisma migrate deploy` 应用。严禁 migrate dev / reset。
-- 存量数据天然兼容（新列带默认 everyone，新表为空），无需回填。

-- AlterTable
ALTER TABLE "users" ADD COLUMN "dmPrivacy" TEXT NOT NULL DEFAULT 'everyone';

-- CreateTable
CREATE TABLE "conversations" (
    "id" SERIAL NOT NULL,
    "userAId" INTEGER NOT NULL,
    "userBId" INTEGER NOT NULL,
    "lastMessageId" INTEGER,
    "lastMessagePreview" TEXT,
    "lastMessageAt" TIMESTAMP(3),
    "unreadCountA" INTEGER NOT NULL DEFAULT 0,
    "unreadCountB" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" SERIAL NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "senderId" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversations_userAId_userBId_key" ON "conversations"("userAId", "userBId");

-- CreateIndex
CREATE INDEX "conversations_userAId_lastMessageAt_idx" ON "conversations"("userAId", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "conversations_userBId_lastMessageAt_idx" ON "conversations"("userBId", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "messages_conversationId_createdAt_idx" ON "messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "messages_conversationId_id_idx" ON "messages"("conversationId", "id");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
