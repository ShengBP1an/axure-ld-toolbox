/**
 * 预检报告：逐项展示、可跳转修正。
 */

import { AlertCircle, AlertTriangle, CheckCircle2, Info, ShieldCheck } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useEditorStore } from '../../store/useEditorStore';
import { PREFLIGHT_LABELS, type PreflightItem, type PreflightReport } from '../../types/export';
import type { Bounds } from '../../types/vector';
import { Panel } from '../ui';

export function PreflightReportView({
  report,
  onFocus,
}: {
  report: PreflightReport;
  onFocus: (region: Bounds | null, ids: readonly string[]) => void;
}) {
  const selectElements = useEditorStore((s) => s.selectElements);
  const blocking = report.items.filter((i) => i.blocking);
  const nonBlocking = report.items.filter((i) => !i.blocking);

  return (
    <Panel
      title={`导出预检 (${report.items.length})`}
      icon={<ShieldCheck size={12} />}
      collapsible
      bodyClassName="p-0"
    >
      {report.items.length === 0 ? (
        <div className="flex items-center gap-2 p-3">
          <CheckCircle2 size={16} className="shrink-0 text-ok" />
          <div>
            <p className="text-[11px] font-semibold text-ok">全部检查通过</p>
            <p className="mt-0.5 text-[10px] text-fg-dim">
              已检查 {report.checkedElements} 个对象：坐标合法、无退化图形、无自相交、无越界。
            </p>
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-ink-600/40">
          {blocking.map((item) => (
            <PreflightRow
              key={item.id}
              item={item}
              onClick={() => {
                if (item.elementIds.length > 0) selectElements(item.elementIds, false);
                onFocus(item.region, item.elementIds);
              }}
            />
          ))}
          {nonBlocking.map((item) => (
            <PreflightRow
              key={item.id}
              item={item}
              onClick={() => {
                if (item.elementIds.length > 0) selectElements(item.elementIds, false);
                onFocus(item.region, item.elementIds);
              }}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function PreflightRow({ item, onClick }: { item: PreflightItem; onClick: () => void }) {
  const icon =
    item.severity === 'error' ? (
      <AlertCircle size={12} className="text-danger" />
    ) : item.severity === 'warning' ? (
      <AlertTriangle size={12} className="text-warn" />
    ) : (
      <Info size={12} className="text-brand" />
    );

  const color =
    item.severity === 'error' ? 'text-danger' : item.severity === 'warning' ? 'text-warn' : 'text-brand';
  const bar = item.severity === 'error' ? 'bg-danger' : item.severity === 'warning' ? 'bg-warn' : 'bg-brand';

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={item.elementIds.length === 0 && item.region === null}
        className={cn(
          'flex w-full gap-2 px-2.5 py-2 text-left transition-colors',
          item.elementIds.length > 0 || item.region !== null
            ? 'cursor-pointer hover:bg-ink-600/40'
            : 'cursor-default',
        )}
      >
        <span className={cn('mt-0.5 w-0.5 shrink-0 self-stretch rounded-full', bar)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {icon}
            <span className={cn('text-[11px] font-semibold', color)}>
              {PREFLIGHT_LABELS[item.code]}
            </span>
            {item.blocking && (
              <span className="rounded bg-danger/18 px-1 py-px text-[9px] font-bold text-danger">
                必须修正
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-fg">{item.message}</p>
          {item.elementIds.length > 0 && (
            <p className="tabular mt-1 truncate text-[9px] text-fg-dim/80">
              {item.elementIds.slice(0, 4).join(', ')}
              {item.elementIds.length > 4 && ` +${item.elementIds.length - 4}`}
            </p>
          )}
        </div>
        {(item.elementIds.length > 0 || item.region !== null) && (
          <span className="mt-0.5 shrink-0 self-start text-[9px] text-fg-dim">定位 →</span>
        )}
      </button>
    </li>
  );
}
