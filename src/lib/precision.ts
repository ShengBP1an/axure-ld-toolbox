/**
 * 浮点精度与数值格式化工具。
 */

export function roundTo(v: number, precision: number): number {
  if (!Number.isFinite(v)) return 0;
  const f = 10 ** precision;
  return Math.round(v * f) / f;
}

/** 定精度输出为字符串，去除多余的尾随零（缩小 SVG 体积）。 */
export function fmt(v: number, precision: number): string {
  if (!Number.isFinite(v)) return '0';
  const r = roundTo(v, precision);
  if (Number.isInteger(r)) return String(r);
  return r.toFixed(precision).replace(/\.?0+$/, '');
}

export function nearlyEqual(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) <= eps;
}

/** 相对误差比较，适合尺度差异大的量。 */
export function relativelyEqual(a: number, b: number, rel = 1e-4): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) <= rel * scale;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** 面向 UI 的数值展示：自动选择小数位。 */
export function displayNumber(v: number, maxFrac = 3): string {
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 100) return v.toFixed(1);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(maxFrac);
}

export function percent(v: number, frac = 1): string {
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(frac)}%`;
}

/** 字节数人类可读化。 */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function ms(n: number): string {
  if (n < 1) return '<1 ms';
  if (n < 1000) return `${n.toFixed(0)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}
