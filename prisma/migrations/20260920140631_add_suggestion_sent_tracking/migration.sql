-- AlterTable
ALTER TABLE "AiSuggestion" ADD COLUMN     "finalReply" TEXT,
ADD COLUMN     "sentAt" TIMESTAMP(3),
ADD COLUMN     "sentMessageId" TEXT;
