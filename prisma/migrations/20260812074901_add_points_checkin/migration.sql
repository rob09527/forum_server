-- AlterTable
ALTER TABLE "users" ADD COLUMN     "checkinStreak" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "checkinTotalDays" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastCheckinAt" TIMESTAMP(3),
ADD COLUMN     "totalPointsEarned" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "point_logs" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "balanceAfter" INTEGER NOT NULL,
    "refId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "point_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "point_logs_userId_createdAt_idx" ON "point_logs"("userId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "point_logs" ADD CONSTRAINT "point_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
