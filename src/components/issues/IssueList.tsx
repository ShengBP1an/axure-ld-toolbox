/**
 * 问题列表：按严重度分组，点击定位并选中对象。
 */

import { useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, Info, ListChecks } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useEditorStore } from '../../store/useEditorStore';
import { ISSUE_LABELS, type RecognitionIssue, type Severity } from '../../types/recognition';
import type { Bounds } from '../../types/vector';
import { Panel, Segmented } from '../ui';

const SEVERITY_META: Record<Severity, { label: string; color: string; bar: string; icon: React.ReactNode }> = {
  error: {
    label: '错误',
    color: 'text-danger',
    bar: 'bg-danger',
    icon: <AlertCircle size={12} />,
  },
  warning: {
    label: '警告',
    color: 'text-warn',
    bar: 'bg-warn',
    icon: <AlertTriangle size={12} />,
  },
  info: {
    label: '提示',
    color: 'text-brand',
    bar: 'bg-brand',
    icon: <Info size={12} />,
  },
};

type Filter = 'all' | Severity;

export function IssueList({
  onFocus,
  onHover,
}: {
  onFocus: (region: Bounds | null, elementIds: readonly string[]) => void;
  onHover: (region: Bounds | null) => void;
}) {
  const issues = useEditorStore((s) => s.issues);
  const revision = useEditorStore((s) => s.revision);
  const selectElements = useEditorStore((s) => s.selectElements);
  const [filter, setFilter] = useState<Filter>('all');

  const all = useMemo(() => [...issues.values()], [issues, revision]);

  const counts = useMemo(() => {
    const c = { error: 0, warning: 0, info: 0 };
    for (const i of all) c[i.severity] += 1;
    return c;
  }, [all]);

  const list = useMemo(() => {
    const filtered = filter === 'all' ? all : all.filter((i) => i.severity === filter);
    const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
    return [...filtered].sort((a, b) => rank[a.severity] - rank[b.severity]);
  }, [all, filter]);

  return (
    <Panel
      title={`问题与待确认 (${all.length})`}
      icon={<ListChecks size={12} />}
      collapsible
      bodyClassName="p-0"
    >
      <div className="border-b border-ink-600/50 p-2.5">
        <Segmented<Filter>
          value={filter}
          options={[
            { value: 'all', label: `全部 ${all.length}` },
            { value: 'error', label: `错误 ${counts.error}` },
            { value: 'warning', label: `警告 ${counts.warning}` },
            { value: 'info', label: `提示 ${counts.info}` },
          ]}
          onChange={setFilter}
        />
      </div>

      {list.length === 0 ? (
        <div className="p-5 text-center">
          <p className="text-[12px] text-fg-muted">
            {all.length === 0 ? '没有检测到问题' : '当前筛选无匹配项'}
          </p>
          {all.length === 0 && (
            <p className="mt-1 text-[10px] text-fg-dim">所有对象的置信度都在阈值以上</p>
          )}
        </div>
      ) : (
        <ul className="max-h-[38vh] divide-y divide-ink-600/40 overflow-y-auto">
          {list.map((issue) => (
            <IssueRow
              key={issue.id}
              issue={issue}
              onClick={() => {
                if (issue.elementIds.length > 0) selectElements(issue.elementIds, false);
                onFocus(issue.region, issue.elementIds);
              }}
              onHover={(entering) => onHover(entering ? issue.region : null)}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function IssueRow({
  issue,
  onClick,
  onHover,
}: {
  issue: RecognitionIssue;
  onClick: () => void;
  onHover: (entering: boolean) => void;
}) {
  const meta = SEVERITY_META[issue.severity];
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
        className="group flex w-full cursor-pointer gap-2 px-2.5 py-2 text-left transition-colors hover:bg-ink-600/40"
      >
        <span className={cn('mt-0.5 w-0.5 shrink-0 self-stretch rounded-full', meta.bar)} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={meta.color}>{meta.icon}</span>
            <span className={cn('text-[11px] font-semibold', meta.color)}>
              {ISSUE_LABELS[issue.type]}
            </span>
            {issue.blocking && (
              <span className="rounded bg-danger/18 px-1 py-px text-[9px] font-bold text-danger">
                阻止导出
              </span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-fg">{issue.message}</p>
          <p className="mt-1 text-[10px] leading-snug text-fg-dim">{issue.suggestion}</p>
          {issue.elementIds.length > 0 && (
            <p className="tabular mt-1 truncate text-[9px] text-fg-dim/80">
              {issue.elementIds.slice(0, 3).join(', ')}
              {issue.elementIds.length > 3 && ` +${issue.elementIds.length - 3}`}
            </p>
          )}
        </div>
        {issue.region !== null && (
          <span className="mt-0.5 shrink-0 self-start text-[9px] text-fg-dim opacity-0 transition-opacity group-hover:opacity-100">
            定位 →
          </span>
        )}
      </button>
    </li>
  );
}
