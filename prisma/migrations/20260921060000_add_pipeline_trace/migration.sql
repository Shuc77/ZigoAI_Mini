-- AlterTable
-- 判断链路（trace）：把一次 AI 判断的**分段耗时**与**每一步的输入输出**落库，
-- 让"这次判断到底怎么来的、慢在哪"能在页面上直接看到，而不是只能翻容器日志。
ALTER TABLE "AiSuggestion" ADD COLUMN     "pipelineTrace" JSONB;
