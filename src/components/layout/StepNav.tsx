/**
 * 顶部步骤条。
 * 已完成段填充青蓝渐变并带对勾，当前段发光描边，未达段低透明度且不可跳过。
 */

import { Check } from 'lucide-react';
import { cn } from '../../lib/cn';
import type { StepId } from '../../store/useProjectStore';
import { canEnterStep, STEP_LABELS, STEPS, useProjectStore } from '../../store/useProjectStore';

export function StepNav() {
  const step = useProjectStore((s) => s.step);
  const completed = useProjectStore((s) => s.completed);
  const source = useProjectStore((s) => s.source);
  const result = useProjectStore((s) => s.result);
  const goStep = useProjectStore((s) => s.goStep);

  const currentIndex = STEPS.indexOf(step);

  return (
    <nav aria-label="流程步骤" className="flex items-center gap-1">
      {STEPS.map((id, i) => {
        const isCurrent = id === step;
        const isDone = completed[id] === true && !isCurrent;
        const reachable = canEnterStep(id, { source, result });
        const isPast = i < currentIndex;

        return (
          <div key={id} className="flex items-center">
            <button
              type="button"
              disabled={!reachable}
              onClick={() => reachable && goStep(id)}
              title={reachable ? STEP_LABELS[id] : `请先完成前面的步骤`}
              className={cn(
                'group flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-all duration-200',
                isCurrent && 'bg-brand/12 text-brand shadow-[0_0_0_1px_rgba(34,211,238,0.45)]',
                !isCurrent && reachable && 'cursor-pointer text-fg-muted hover:bg-ink-600/60 hover:text-fg',
                !reachable && 'cursor-not-allowed text-fg-dim/60',
              )}
            >
              <span
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold transition-all',
                  isDone || isPast
                    ? 'bg-brand-grad text-ink-900'
                    : isCurrent
                      ? 'border border-brand text-brand'
                      : 'border border-ink-500 text-fg-dim',
                )}
              >
                {isDone || isPast ? <Check size={11} strokeWidth={3.5} /> : i + 1}
              </span>
              <span className="whitespace-nowrap">{STEP_LABELS[id]}</span>
            </button>

            {i < STEPS.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  'mx-0.5 h-px w-4 transition-colors duration-300',
                  i < currentIndex ? 'bg-brand/60' : 'bg-ink-600',
                )}
              />
            )}
          </div>
        );
      })}
    </nav>
  );
}

/** 步骤间导航按钮（上一步 / 下一步）。 */
export function StepFooter({
  onNext,
  nextLabel,
  nextDisabled,
  nextHint,
}: {
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  nextHint?: string;
}) {
  const step = useProjectStore((s) => s.step);
  const goStep = useProjectStore((s) => s.goStep);
  const source = useProjectStore((s) => s.source);
  const result = useProjectStore((s) => s.result);

  const idx = STEPS.indexOf(step);
  const prev: StepId | undefined = STEPS[idx - 1];

  return (
    <div className="flex items-center justify-between gap-3 border-t border-ink-600/60 px-3 py-2.5">
      {prev !== undefined && canEnterStep(prev, { source, result }) ? (
        <button
          type="button"
          onClick={() => goStep(prev)}
          className="btn-ghost text-[11px]"
        >
          ← {STEP_LABELS[prev]}
        </button>
      ) : (
        <span />
      )}

      {onNext !== undefined && (
        <div className="flex items-center gap-2">
          {nextHint !== undefined && nextDisabled === true && (
            <span className="text-[10px] text-fg-dim">{nextHint}</span>
          )}
          <button
            type="button"
            onClick={onNext}
            disabled={nextDisabled}
            className="btn-primary text-[12px]"
          >
            {nextLabel ?? '下一步'} →
          </button>
        </div>
      )}
    </div>
  );
}
