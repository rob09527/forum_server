-- NodeLoc 数据导入映射表（内容映射 + 用户身份归一），见 docs/交接文档-NodeLoc数据导入.md
-- CreateTable
CREATE TABLE "import_mappings" (
    "id" SERIAL NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'nodeloc',
    "sourceTopicId" INTEGER NOT NULL,
    "sourcePostId" INTEGER NOT NULL,
    "sourcePostNumber" INTEGER NOT NULL,
    "sourceVersion" INTEGER NOT NULL DEFAULT 1,
    "localPostId" INTEGER,
    "localCommentId" INTEGER,
    "localUserId" INTEGER NOT NULL,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_user_mappings" (
    "id" SERIAL NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'nodeloc',
    "sourceUserId" INTEGER NOT NULL,
    "sourceUsername" TEXT NOT NULL,
    "localUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_user_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "import_mappings_source_sourcePostId_key" ON "import_mappings"("source", "sourcePostId");

-- CreateIndex
CREATE INDEX "import_mappings_source_sourceTopicId_idx" ON "import_mappings"("source", "sourceTopicId");

-- CreateIndex
CREATE INDEX "import_mappings_localPostId_idx" ON "import_mappings"("localPostId");

-- CreateIndex
CREATE UNIQUE INDEX "import_user_mappings_source_sourceUserId_key" ON "import_user_mappings"("source", "sourceUserId");

-- CreateIndex
CREATE INDEX "import_user_mappings_localUserId_idx" ON "import_user_mappings"("localUserId");

-- Seed 新增分类（NodeLoc 顶级分类对接，DB 驱动零代码；icon 用 lucide 名与现有行一致）
-- 注意红线：「全部」≠ general，这里不动 general 语义
INSERT INTO "categories" ("slug", "name", "icon", "sortOrder", "isEnabled", "createdAt", "updatedAt") VALUES
('internet', '互联网服务', 'globe', 10, true, now(), now()),
('digital', '数码硬件', 'smartphone', 11, true, now(), now()),
('dev', '编程开发', 'code', 12, true, now(), now()),
('apps', '应用软件', 'layout-grid', 13, true, now(), now()),
('life', '生活兴趣', 'coffee', 14, true, now(), now())
ON CONFLICT ("slug") DO NOTHING;
