/**
 * Axure 导入指引与「需验证」风险清单。
 */

import { useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Info,
  LifeBuoy,
} from 'lucide-react';
import {
  AXURE_IMPORT_STEPS,
  CAPABILITY_DISCLAIMER,
  IMPORT_TROUBLESHOOTING,
  VERIFICATION_ITEMS,
} from '../../core/export/axureNotes';
import { Panel } from '../ui';

export function AxureGuide() {
  const pending = VERIFICATION_ITEMS.filter((v) => v.verified !== true).length;

  return (
    <>
      <Panel title="导入 Axure RP 步骤" icon={<BookOpen size={12} />} collapsible>
        <ol className="space-y-2.5">
          {AXURE_IMPORT_STEPS.map((s, i) => (
            <li key={s.title} className="flex gap-2.5">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-brand-grad text-[9px] font-bold text-ink-900">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold text-fg">{s.title}</p>
                <p className="mt-0.5 text-[10px] leading-relaxed text-fg-muted">{s.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </Panel>

      <Panel
        title="导入失败自查"
        icon={<LifeBuoy size={12} />}
        collapsible
        defaultOpen={false}
      >
        <ol className="space-y-2">
          {IMPORT_TROUBLESHOOTING.map((s, i) => (
            <li key={s.title} className="flex gap-2">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-ink-500 text-[9px] font-bold text-fg-dim">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold text-fg">{s.title}</p>
                <p className="mt-0.5 text-[10px] leading-relaxed text-fg-muted">{s.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </Panel>

      <Panel
        title={`需验证的兼容项 (${pending}/${VERIFICATION_ITEMS.length})`}
        icon={<AlertTriangle size={12} />}
        collapsible
        defaultOpen={false}
        bodyClassName="p-0"
      >
        <div className="border-b border-ink-600/50 bg-warn/6 px-2.5 py-2">
          <p className="text-[10px] leading-relaxed text-warn">
            标为「需验证」的行为尚未在你的 Axure 版本上确认，不应假设一定无损；
            每项都给出了最小验证实验。已实测通过的条目单独标绿。
          </p>
        </div>
        <ul className="divide-y divide-ink-600/40">
          {VERIFICATION_ITEMS.map((v) => (
            <VerificationRow key={v.topic} item={v} />
          ))}
        </ul>
      </Panel>

      <Panel title="能力边界声明" icon={<Info size={12} />} collapsible defaultOpen={false}>
        <ul className="space-y-1.5">
          {CAPABILITY_DISCLAIMER.map((d) => (
            <li key={d} className="flex gap-1.5 text-[10px] leading-relaxed text-fg-muted">
              <span className="text-fg-dim">·</span>
              <span>{d}</span>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

function VerificationRow({ item }: { item: (typeof VERIFICATION_ITEMS)[number] }) {
  const [open, setOpen] = useState(false);
  const ok = item.verified === true;
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-start gap-1.5 px-2.5 py-2 text-left transition-colors hover:bg-ink-600/40"
      >
        {open ? (
          <ChevronDown size={12} className="mt-0.5 shrink-0 text-fg-dim" />
        ) : (
          <ChevronRight size={12} className="mt-0.5 shrink-0 text-fg-dim" />
        )}
        <span className="min-w-0 flex-1 text-[11px] font-medium text-fg">{item.topic}</span>
        {ok ? (
          <span className="flex shrink-0 items-center gap-0.5 rounded bg-ok/18 px-1 py-px text-[8px] font-bold text-ok">
            <CheckCircle2 size={8} />
            已实测
          </span>
        ) : (
          <span className="shrink-0 rounded bg-warn/18 px-1 py-px text-[8px] font-bold text-warn">
            需验证
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-1.5 border-t border-ink-600/30 bg-ink-900/40 px-2.5 py-2 pl-6">
          <Field label="本工具处理" value={item.handling} />
          <Field label="风险" value={item.risk} accent={ok ? 'text-fg-dim' : 'text-warn'} />
          <Field
            label={ok ? '实测结论' : '验证方法'}
            value={item.experiment}
            accent={ok ? 'text-ok' : 'text-brand'}
          />
        </div>
      )}
    </li>
  );
}

function Field({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div>
      <p className={`text-[9px] font-semibold uppercase tracking-wide ${accent ?? 'text-fg-dim'}`}>
        {label}
      </p>
      <p className="mt-0.5 text-[10px] leading-relaxed text-fg-muted">{value}</p>
    </div>
  );
}
