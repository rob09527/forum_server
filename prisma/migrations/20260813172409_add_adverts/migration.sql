-- CreateTable
CREATE TABLE "adverts" (
    "id" SERIAL NOT NULL,
    "title" TEXT,
    "image" TEXT NOT NULL,
    "position" TEXT NOT NULL DEFAULT 'top',
    "link" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "adverts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "adverts_position_isActive_sortOrder_idx" ON "adverts"("position", "isActive", "sortOrder" DESC);
