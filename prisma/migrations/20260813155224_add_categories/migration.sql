-- CreateTable
CREATE TABLE "categories" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL DEFAULT '📂',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- Seed 默认 9 个板块（与 constants/business.ts 历史常量一致）
INSERT INTO "categories" ("slug", "name", "icon", "sortOrder", "isEnabled", "createdAt", "updatedAt") VALUES
('general', '综合讨论', '📂', 1, true, now(), now()),
('llm', '大模型', '🤖', 2, true, now(), now()),
('agent', 'AI Agent', '🔧', 3, true, now(), now()),
('prompt', 'Prompt 工程', '✍️', 4, true, now(), now()),
('art', 'AI 绘画', '🎨', 5, true, now(), now()),
('opensource', '开源模型', '📦', 6, true, now(), now()),
('tools', 'AI 工具', '🛠', 7, true, now(), now()),
('paper', '论文解读', '📄', 8, true, now(), now()),
('share', '经验分享', '💡', 9, true, now(), now());
