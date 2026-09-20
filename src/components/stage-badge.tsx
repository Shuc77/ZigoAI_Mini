import type { LeadStage } from '@/generated/prisma/enums';
import { LEAD_STAGE_LABELS } from '@/lib/types';

const STAGE_STYLES: Record<LeadStage, string> = {
  NEW: 'bg-slate-100 text-slate-700 border-slate-200',
  DISCOVERY: 'bg-sky-50 text-sky-700 border-sky-200',
  INTERESTED: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  HIGH_INTENT: 'bg-amber-50 text-amber-700 border-amber-200',
  WON: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  LOST: 'bg-rose-50 text-rose-700 border-rose-200',
};

export function StageBadge({ stage }: { stage: LeadStage }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STAGE_STYLES[stage]}`}
    >
      {LEAD_STAGE_LABELS[stage]}
    </span>
  );
}

export function NeedHumanBadge({ reason }: { reason?: string | null }) {
  return (
    <span
      className="inline-flex items-center rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-700"
      title={reason ?? undefined}
    >
      建议人工介入
    </span>
  );
}
