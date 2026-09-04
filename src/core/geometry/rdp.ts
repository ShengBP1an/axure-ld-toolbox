/**
 * Ramer–Douglas–Peucker 折线简化。
 *
 * 采用迭代式实现（显式栈）以避免深折线的递归栈溢出。
 * 支持开放与闭合折线，并可设置最少保留点数。
 */

import type { Point } from '../../types/vector';
import { dist, EPS, pointLineDistance } from './vec';

export interface RdpOptions {
  /** 容差（与点坐标同单位）。 */
  epsilon: number;
  /** 结果至少保留的点数（开放折线 ≥2，闭合 ≥3）。 */
  minPoints?: number;
  /** 是否为闭合折线：首尾相接，需分两段处理。 */
  closed?: boolean;
}

/** 开放折线的 RDP。返回原数组的子序列（保序，含首尾）。 */
export function rdpOpen(points: readonly Point[], epsilon: number): Point[] {
  const n = points.length;
  if (n <= 2) return points.map((p) => ({ ...p }));

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    if (end - start < 2) continue;
    const a = points[start]!;
    const b = points[end]!;
    const degenerate = dist(a, b) < EPS;

    let maxDist = -1;
    let maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const p = points[i]!;
      // 端点重合时退化为「到端点的距离」，避免除零把整段折叠掉
      const d = degenerate ? dist(p, a) : pointLineDistance(p, a, b);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }

    if (maxIdx >= 0 && maxDist > epsilon) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx]);
      stack.push([maxIdx, end]);
    }
  }

  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push({ ...points[i]! });
  }
  return out;
}

/**
 * 闭合折线的 RDP。
 * 先取环上距离最远的两点作为「锚点」，把环拆成两条开放折线分别简化，
 * 避免直接把环当作开放折线导致首点被强行保留而形状偏斜。
 *
 * 保证：结果至少 3 个点。闭合形状少于 3 点在几何上退化（面积为 0），
 * 因此容差过大时自动降低容差重试，而不是返回退化结果。
 */
export function rdpClosed(points: readonly Point[], epsilon: number): Point[] {
  const n = points.length;
  if (n <= 3) return points.map((p) => ({ ...p }));

  // 以点 0 为基准找最远点，作为第二锚点（O(n)，对本场景足够）
  let far = 1;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const d = dist(points[0]!, points[i]!);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }

  const first = points.slice(0, far + 1);
  const second = [...points.slice(far), points[0]!];

  const runOnce = (eps: number): Point[] => {
    const s1 = rdpOpen(first, eps);
    const s2 = rdpOpen(second, eps);
    // s1 末点 == s2 首点 == points[far]；s2 末点 == points[0] == s1 首点
    const out = [...s1];
    for (let i = 1; i < s2.length - 1; i++) out.push(s2[i]!);
    return out;
  };

  let eps = epsilon;
  let result = runOnce(eps);
  let guard = 0;
  while (result.length < 3 && guard < 20) {
    eps *= 0.5;
    result = runOnce(eps);
    guard++;
  }
  return result.length >= 3 ? result : points.map((p) => ({ ...p }));
}

/** 统一入口。 */
export function rdp(points: readonly Point[], opts: RdpOptions): Point[] {
  const closed = opts.closed === true;
  const minPoints = opts.minPoints ?? (closed ? 3 : 2);
  if (points.length <= minPoints) return points.map((p) => ({ ...p }));

  let eps = opts.epsilon;
  let result = closed ? rdpClosed(points, eps) : rdpOpen(points, eps);

  // 若低于最少点数，逐步降低容差重试，保证形状不被压扁
  let guard = 0;
  while (result.length < minPoints && guard < 12) {
    eps *= 0.5;
    result = closed ? rdpClosed(points, eps) : rdpOpen(points, eps);
    guard++;
  }
  if (result.length < minPoints) return points.map((p) => ({ ...p }));
  return result;
}

/** 移除距离过近的重复点（保留首点，闭合时同时检查末点与首点）。 */
export function dedupePoints(points: readonly Point[], tolerance: number, closed = false): Point[] {
  if (points.length === 0) return [];
  const out: Point[] = [{ ...points[0]! }];
  for (let i = 1; i < points.length; i++) {
    if (dist(points[i]!, out[out.length - 1]!) > tolerance) out.push({ ...points[i]! });
  }
  if (closed && out.length > 1 && dist(out[0]!, out[out.length - 1]!) <= tolerance) out.pop();
  return out;
}

/**
 * 移除近乎共线的中间点（RDP 之后的收尾），进一步降低节点数。
 * angleTolDeg 越大移除越激进。
 */
export function removeCollinear(points: readonly Point[], angleTolDeg: number, closed = false): Point[] {
  const n = points.length;
  const minKeep = closed ? 3 : 2;
  if (n <= minKeep) return points.map((p) => ({ ...p }));

  const cosTol = Math.cos(Math.PI - (angleTolDeg * Math.PI) / 180);
  const keep = new Uint8Array(n).fill(1);
  const startIdx = closed ? 0 : 1;
  const endIdx = closed ? n : n - 1;
  let kept = n;

  for (let i = startIdx; i < endIdx; i++) {
    if (kept <= minKeep) break;
    // 找到前后仍保留的邻居
    let prev = (i - 1 + n) % n;
    while (!keep[prev] && prev !== i) prev = (prev - 1 + n) % n;
    let next = (i + 1) % n;
    while (!keep[next] && next !== i) next = (next + 1) % n;
    if (prev === i || next === i || prev === next) continue;

    const a = points[prev]!;
    const b = points[i]!;
    const c = points[next]!;
    const v1x = a.x - b.x;
    const v1y = a.y - b.y;
    const v2x = c.x - b.x;
    const v2y = c.y - b.y;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    if (l1 < EPS || l2 < EPS) continue;
    const cosA = (v1x * v2x + v1y * v2y) / (l1 * l2);
    // 夹角接近 180° → cos 接近 -1 → 共线
    if (cosA <= cosTol) {
      keep[i] = 0;
      kept--;
    }
  }

  const out: Point[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push({ ...points[i]! });
  return out.length >= minKeep ? out : points.map((p) => ({ ...p }));
}
