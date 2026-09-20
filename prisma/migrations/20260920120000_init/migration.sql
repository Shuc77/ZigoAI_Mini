-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SALES', 'MANAGER');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('CUSTOMER', 'SALES');

-- CreateEnum
CREATE TYPE "LeadStage" AS ENUM ('NEW', 'DISCOVERY', 'INTERESTED', 'HIGH_INTENT', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('SUCCESS', 'RETRY_OK', 'FALLBACK', 'ERROR');

-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "salesGoal" TEXT NOT NULL,
    "rules" JSONB NOT NULL,
    "tone" TEXT NOT NULL,
    "forbidden" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "phone" TEXT,
    "source" TEXT,
    "note" TEXT,
    "assigneeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "senderUserId" TEXT,
    "batchId" TEXT,
    "clientMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerState" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "leadStage" "LeadStage" NOT NULL DEFAULT 'NEW',
    "intent" TEXT NOT NULL DEFAULT '待判断',
    "needHuman" BOOLEAN NOT NULL DEFAULT false,
    "humanReason" TEXT,
    "lastContactAt" TIMESTAMP(3),
    "lastCustomerMessageAt" TIMESTAMP(3),
    "followUpCount" INTEGER NOT NULL DEFAULT 0,
    "lastFollowUpAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiSuggestion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "batchId" TEXT,
    "customerIntent" TEXT NOT NULL,
    "intentDetail" TEXT,
    "leadStage" "LeadStage" NOT NULL,
    "nextAction" TEXT NOT NULL,
    "reply" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "needHuman" BOOLEAN NOT NULL,
    "humanReason" TEXT,
    "rulesApplied" JSONB NOT NULL,
    "ruleViolation" TEXT,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'SUCCESS',
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "rawRequest" JSONB,
    "rawResponse" JSONB,
    "latencyMs" INTEGER,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "estimatedCostCny" DOUBLE PRECISION,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUpTask" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'PENDING',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "suggestionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FollowUpTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_tenantId_idx" ON "User"("tenantId");

-- CreateIndex
CREATE INDEX "Customer_tenantId_assigneeId_idx" ON "Customer"("tenantId", "assigneeId");

-- CreateIndex
CREATE INDEX "Customer_tenantId_updatedAt_idx" ON "Customer"("tenantId", "updatedAt");

-- CreateIndex
CREATE INDEX "Message_tenantId_customerId_createdAt_idx" ON "Message"("tenantId", "customerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_tenantId_clientMessageId_key" ON "Message"("tenantId", "clientMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerState_customerId_key" ON "CustomerState"("customerId");

-- CreateIndex
CREATE INDEX "CustomerState_tenantId_leadStage_idx" ON "CustomerState"("tenantId", "leadStage");

-- CreateIndex
CREATE INDEX "CustomerState_tenantId_lastCustomerMessageAt_idx" ON "CustomerState"("tenantId", "lastCustomerMessageAt");

-- CreateIndex
CREATE INDEX "AiSuggestion_tenantId_customerId_createdAt_idx" ON "AiSuggestion"("tenantId", "customerId", "createdAt");

-- CreateIndex
CREATE INDEX "AiSuggestion_tenantId_status_createdAt_idx" ON "AiSuggestion"("tenantId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "FollowUpTask_tenantId_status_dueAt_idx" ON "FollowUpTask"("tenantId", "status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "FollowUpTask_tenantId_customerId_attempt_key" ON "FollowUpTask"("tenantId", "customerId", "attempt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerState" ADD CONSTRAINT "CustomerState_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerState" ADD CONSTRAINT "CustomerState_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSuggestion" ADD CONSTRAINT "AiSuggestion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiSuggestion" ADD CONSTRAINT "AiSuggestion_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpTask" ADD CONSTRAINT "FollowUpTask_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpTask" ADD CONSTRAINT "FollowUpTask_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
