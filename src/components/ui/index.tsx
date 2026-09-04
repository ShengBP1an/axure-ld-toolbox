/**
 * 轻量 UI 基础组件。
 * 不引入 Radix 完整体系，只实现工具台真正需要的受控控件，
 * 保证包体小、行为可预测。
 */

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../lib/cn';

/* ------------------------------------------------------------------ */
/* Button                                                              */
/* ------------------------------------------------------------------ */

type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  icon?: React.ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'btn-primary',
  outline: 'btn-outline',
  ghost: 'btn-ghost',
  danger: 'btn-danger',
};

export function Button({ variant = 'outline', icon, className, children, ...rest }: ButtonProps) {
  return (
    <button type="button" className={cn(VARIANT_CLASS[variant], className)} {...rest}>
      {icon}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* IconButton                                                          */
/* ------------------------------------------------------------------ */

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
}

export function IconButton({ label, active = false, className, children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        'flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-md transition-all duration-150',
        active
          ? 'bg-brand/18 text-brand shadow-[0_0_0_1px_rgba(34,211,238,0.4)]'
          : 'text-fg-muted hover:bg-ink-600/70 hover:text-fg active:scale-95',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* NumberField —— 数值输入 + 单位后缀                                    */
/* ------------------------------------------------------------------ */

interface NumberFieldProps {
  label: string;
  value: number;
  onCommit: (v: number) => void;
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  disabled?: boolean;
  hint?: string;
}

/**
 * 受控数值输入：编辑中保持字符串态（允许中间态如 "1." ），
 * 失焦或回车时才提交，避免每敲一个字符就触发全量重算。
 */
export function NumberField({
  label,
  value,
  onCommit,
  suffix,
  min,
  max,
  step = 1,
  precision = 3,
  disabled = false,
  hint,
}: NumberFieldProps) {
  const id = useId();
  const [text, setText] = useState(() => format(value, precision));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setText(format(value, precision));
  }, [value, precision, editing]);

  const commit = useCallback(() => {
    setEditing(false);
    const parsed = Number.parseFloat(text);
    if (!Number.isFinite(parsed)) {
      setText(format(value, precision));
      return;
    }
    let next = parsed;
    if (min !== undefined && next < min) next = min;
    if (max !== undefined && next > max) next = max;
    setText(format(next, precision));
    if (next !== value) onCommit(next);
  }, [text, value, min, max, precision, onCommit]);

  return (
    <div>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type="number"
          inputMode="decimal"
          className={cn('num-input tabular', suffix !== undefined && 'pr-9')}
          value={text}
          step={step}
          min={min}
          max={max}
          disabled={disabled}
          onFocus={() => setEditing(true)}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              setText(format(value, precision));
              setEditing(false);
              e.currentTarget.blur();
            }
          }}
        />
        {suffix !== undefined && (
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] font-medium text-fg-dim">
            {suffix}
          </span>
        )}
      </div>
      {hint !== undefined && <p className="mt-1 text-[10px] leading-snug text-fg-dim">{hint}</p>}
    </div>
  );
}

function format(v: number, precision: number): string {
  if (!Number.isFinite(v)) return '0';
  const r = Math.round(v * 10 ** precision) / 10 ** precision;
  return String(r);
}

/* ------------------------------------------------------------------ */
/* Slider                                                              */
/* ------------------------------------------------------------------ */

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  /** 数值展示格式化。 */
  format?: (v: number) => string;
  disabled?: boolean;
  hint?: string;
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format: fmt,
  disabled = false,
  hint,
}: SliderProps) {
  const id = useId();
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <div className={disabled ? 'opacity-50' : undefined}>
      <div className="mb-1 flex items-baseline justify-between">
        <label htmlFor={id} className="text-[11px] font-medium tracking-wide text-fg-muted">
          {label}
        </label>
        <span className="tabular text-[11px] font-semibold text-brand">
          {fmt ? fmt(value) : value}
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number.parseFloat(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none
                   [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5
                   [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full
                   [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-ink-900
                   [&::-webkit-slider-thumb]:bg-brand [&::-webkit-slider-thumb]:shadow-[0_0_8px_rgba(34,211,238,0.6)]
                   [&::-webkit-slider-thumb]:transition-transform
                   [&::-webkit-slider-thumb]:hover:scale-110
                   [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5
                   [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2
                   [&::-moz-range-thumb]:border-ink-900 [&::-moz-range-thumb]:bg-brand"
        style={{
          background: `linear-gradient(to right, #22D3EE 0%, #0EA5E9 ${pct}%, #2E3D50 ${pct}%, #2E3D50 100%)`,
        }}
      />
      {hint !== undefined && <p className="mt-1 text-[10px] leading-snug text-fg-dim">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Switch                                                              */
/* ------------------------------------------------------------------ */

interface SwitchProps {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  hint?: string;
  /** 右侧附加操作，例如「重置」。 */
  action?: React.ReactNode;
}

export function Switch({ label, checked, onChange, disabled = false, hint, action }: SwitchProps) {
  return (
    <div className="flex items-start justify-between gap-2 py-1">
      <div className="min-w-0 flex-1">
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          disabled={disabled}
          onClick={() => onChange(!checked)}
          className="group flex w-full cursor-pointer items-center gap-2 text-left disabled:cursor-not-allowed"
        >
          <span
            className={cn(
              'relative h-4 w-7 shrink-0 rounded-full transition-colors duration-150',
              checked ? 'bg-brand/85' : 'bg-ink-500',
            )}
          >
            <span
              className={cn(
                'absolute top-0.5 h-3 w-3 rounded-full bg-ink-900 shadow transition-transform duration-150',
                checked ? 'translate-x-3.5' : 'translate-x-0.5',
              )}
            />
          </span>
          <span
            className={cn(
              'truncate text-[12px] transition-colors',
              checked ? 'text-fg' : 'text-fg-muted group-hover:text-fg',
            )}
          >
            {label}
          </span>
        </button>
        {hint !== undefined && <p className="ml-9 mt-0.5 text-[10px] leading-snug text-fg-dim">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Segmented                                                           */
/* ------------------------------------------------------------------ */

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  title?: string;
}

interface SegmentedProps<T extends string> {
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (v: T) => void;
  className?: string;
}

export function Segmented<T extends string>({ value, options, onChange, className }: SegmentedProps<T>) {
  return (
    <div className={cn('flex gap-0.5 rounded-md border border-ink-600/80 bg-ink-900/60 p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex-1 cursor-pointer rounded px-2 py-1 text-[11px] font-medium transition-all duration-150',
            value === o.value
              ? 'bg-brand-grad text-ink-900 shadow-[0_0_10px_-2px_rgba(34,211,238,0.5)]'
              : 'text-fg-muted hover:bg-ink-600/60 hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Select                                                              */
/* ------------------------------------------------------------------ */

interface SelectProps<T extends string> {
  label?: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
}

export function Select<T extends string>({ label, value, options, onChange, disabled }: SelectProps<T>) {
  const id = useId();
  return (
    <div>
      {label !== undefined && (
        <label htmlFor={id} className="field-label">
          {label}
        </label>
      )}
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-8 w-full cursor-pointer rounded-md border border-ink-500/80 bg-ink-900/70 px-2 text-[12px]
                   text-fg outline-none transition-colors hover:border-ink-500 focus:border-brand/70"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-ink-800">
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

interface PanelProps {
  title: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  /** 标题栏右侧操作。 */
  action?: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  className?: string;
  bodyClassName?: string;
}

export function Panel({
  title,
  icon,
  children,
  action,
  collapsible = false,
  defaultOpen = true,
  className,
  bodyClassName,
}: PanelProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={cn('panel', className)}>
      <header className="flex items-center justify-between border-b border-ink-600/60">
        <button
          type="button"
          disabled={!collapsible}
          onClick={() => collapsible && setOpen(!open)}
          className={cn('panel-title min-w-0 flex-1', collapsible && 'cursor-pointer hover:text-fg-muted')}
        >
          {icon}
          <span className="truncate">{title}</span>
        </button>
        {action !== undefined && <div className="pr-2">{action}</div>}
      </header>
      {open && <div className={cn('p-3', bodyClassName)}>{children}</div>}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* ConfidenceRing —— 置信度环形进度                                      */
/* ------------------------------------------------------------------ */

export function ConfidenceRing({ value, size = 44 }: { value: number; size?: number }) {
  const clamped = Math.max(0, Math.min(1, value));
  const stroke = 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const color = clamped >= 0.75 ? '#34D399' : clamped >= 0.62 ? '#22D3EE' : clamped >= 0.42 ? '#FBBF24' : '#F87171';
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#2E3D50" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - clamped)}
          style={{ transition: 'stroke-dashoffset 260ms ease-out' }}
        />
      </svg>
      <span
        className="tabular absolute inset-0 flex items-center justify-center text-[11px] font-bold"
        style={{ color }}
      >
        {Math.round(clamped * 100)}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Banner                                                              */
/* ------------------------------------------------------------------ */

interface BannerProps {
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  onClose?: () => void;
}

const BANNER_STYLE: Record<BannerProps['level'], string> = {
  info: 'border-brand/40 bg-brand/8 text-fg',
  success: 'border-ok/40 bg-ok/8 text-fg',
  warning: 'border-warn/45 bg-warn/8 text-fg',
  error: 'border-danger/50 bg-danger/10 text-fg',
};

const BANNER_DOT: Record<BannerProps['level'], string> = {
  info: 'bg-brand',
  success: 'bg-ok',
  warning: 'bg-warn',
  error: 'bg-danger',
};

export function Banner({ level, title, children, action, onClose }: BannerProps) {
  return (
    <div className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5', BANNER_STYLE[level])}>
      <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', BANNER_DOT[level])} />
      <div className="min-w-0 flex-1">
        <p className="text-[12px] font-semibold leading-snug">{title}</p>
        {children !== undefined && (
          <div className="mt-1 text-[11px] leading-relaxed text-fg-muted">{children}</div>
        )}
      </div>
      {action}
      {onClose !== undefined && (
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="shrink-0 cursor-pointer text-fg-dim transition-colors hover:text-fg"
        >
          ✕
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Stat                                                                */
/* ------------------------------------------------------------------ */

export function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-md border border-ink-600/60 bg-ink-900/40 px-2 py-1.5">
      <p className="truncate text-[10px] text-fg-dim">{label}</p>
      <p className={cn('tabular truncate text-[13px] font-semibold', accent ? 'text-brand' : 'text-fg')}>
        {value}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tooltip（轻量，仅悬停展示）                                            */
/* ------------------------------------------------------------------ */

export function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => {
        timer.current = window.setTimeout(() => setShow(true), 400);
      }}
      onMouseLeave={() => {
        if (timer.current !== null) window.clearTimeout(timer.current);
        setShow(false);
      }}
    >
      {children}
      {show && (
        <span
          role="tooltip"
          className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 w-max max-w-[240px]
                     -translate-x-1/2 rounded-md border border-ink-500 bg-ink-800 px-2 py-1
                     text-[11px] leading-snug text-fg shadow-panel"
        >
          {text}
        </span>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* ProgressBar                                                         */
/* ------------------------------------------------------------------ */

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div>
      {label !== undefined && (
        <div className="mb-1 flex justify-between text-[10px] text-fg-muted">
          <span>{label}</span>
          <span className="tabular">{pct.toFixed(0)}%</span>
        </div>
      )}
      <div className="h-1 w-full overflow-hidden rounded-full bg-ink-600">
        <div
          className="h-full rounded-full bg-brand-grad transition-[width] duration-200 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
