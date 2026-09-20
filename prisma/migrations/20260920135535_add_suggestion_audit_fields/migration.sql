-- AlterTable
ALTER TABLE "AiSuggestion" ADD COLUMN     "stateAdjustments" JSONB,
ADD COLUMN     "trigger" TEXT NOT NULL DEFAULT 'NEW_MESSAGE';
