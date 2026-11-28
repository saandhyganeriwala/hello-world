-- AlterTable
ALTER TABLE "MerchantUser" ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "PendingAction" ADD COLUMN     "approvalCode" TEXT,
ADD COLUMN     "conversationKey" TEXT,
ADD COLUMN     "minRole" TEXT NOT NULL DEFAULT 'member';

-- AlterTable
ALTER TABLE "Shop" ADD COLUMN     "currencyCode" TEXT,
ADD COLUMN     "ianaTimezone" TEXT,
ADD COLUMN     "memory" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "onlineStorePublicationId" TEXT,
ADD COLUMN     "plan" TEXT NOT NULL DEFAULT 'none',
ADD COLUMN     "planCheckedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ShopSettings" DROP COLUMN "weeklySummaryEnabled",
ADD COLUMN     "lastDigestAt" TIMESTAMP(3),
ADD COLUMN     "lastSummaryAt" TIMESTAMP(3),
ADD COLUMN     "summaryFrequency" TEXT NOT NULL DEFAULT 'weekly',
ADD COLUMN     "summaryHour" INTEGER NOT NULL DEFAULT 9,
ADD COLUMN     "updatesDestination" TEXT NOT NULL DEFAULT 'group';

-- AlterTable
ALTER TABLE "WaMessage" ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "processedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "StoreGroup" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "groupId" TEXT,
    "requestId" TEXT,
    "subject" TEXT NOT NULL,
    "inviteLink" TEXT,
    "status" TEXT NOT NULL DEFAULT 'creating',
    "error" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupParticipant" (
    "id" TEXT NOT NULL,
    "storeGroupId" TEXT NOT NULL,
    "waId" TEXT,
    "userId" TEXT,
    "name" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "GroupParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Episode" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "route" TEXT NOT NULL DEFAULT 'agent',
    "messages" JSONB NOT NULL DEFAULT '[]',
    "summary" TEXT,
    "escalations" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Episode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "waMediaId" TEXT,
    "mimeType" TEXT NOT NULL,
    "caption" TEXT,
    "data" BYTEA NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "conversationKey" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreGroup_shopId_key" ON "StoreGroup"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreGroup_groupId_key" ON "StoreGroup"("groupId");

-- CreateIndex
CREATE INDEX "GroupParticipant_storeGroupId_idx" ON "GroupParticipant"("storeGroupId");

-- CreateIndex
CREATE INDEX "Episode_shopId_conversationKey_status_idx" ON "Episode"("shopId", "conversationKey", "status");

-- CreateIndex
CREATE INDEX "MediaAsset_shopId_conversationKey_createdAt_idx" ON "MediaAsset"("shopId", "conversationKey", "createdAt");

-- CreateIndex
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");

-- CreateIndex
CREATE INDEX "Job_conversationKey_status_idx" ON "Job"("conversationKey", "status");

-- CreateIndex
CREATE INDEX "WaMessage_groupId_processedAt_idx" ON "WaMessage"("groupId", "processedAt");

-- CreateIndex
CREATE INDEX "WaMessage_waId_processedAt_idx" ON "WaMessage"("waId", "processedAt");

-- AddForeignKey
ALTER TABLE "StoreGroup" ADD CONSTRAINT "StoreGroup_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupParticipant" ADD CONSTRAINT "GroupParticipant_storeGroupId_fkey" FOREIGN KEY ("storeGroupId") REFERENCES "StoreGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Episode" ADD CONSTRAINT "Episode_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

