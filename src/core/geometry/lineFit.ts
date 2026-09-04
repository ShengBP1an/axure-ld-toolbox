/**
 * 直线拟合、共线判定、线段合并与平行近邻线归并。
 */

import type { Point } from '../../types/vector';
import {
  angleDeg,
  dist,
  distSq,
  EPS,
  pointLineDistance,
  pointSegmentDistance,
  undirectedAngleDeg,
  undirectedAngleDiffDeg,
} from './vec';

export interface Segment {
  a: Point;
  b: Point;
}

export function segLength(s: Segment): number {
  return dist(s.a, s.b);
}

export function segAngleDeg(s: Segment): number {
  return undirectedAngleDeg(s.a, s.b);
}

export function segMidpoint(s: Segment): Point {
  return { x: (s.a.x + s.b.x) / 2, y: (s.a.y + s.b.y) / 2 };
}

export interface LineFit {
  /** 拟合直线上的一点（点集质心）。 */
  origin: Point;
  /** 单位方向向量。 */
  direction: Point;
  /** 均方根残差。 */
  rmse: number;
  /** 最大残差。 */
  maxError: number;
}

/**
 * 全最小二乘（Total Least Squares）直线拟合。
 * 相较普通最小二乘，对竖直线不会发散，适合手绘墙线。
 */
export function fitLine(points: readonly Point[]): LineFit {
  const n = points.length;
  if (n === 0) {
    return { origin: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, rmse: 0, maxError: 0 };
  }
  if (n === 1) {
    return { origin: { ...points[0]! }, direction: { x: 1, y: 0 }, rmse: 0, maxError: 0 };
  }

  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;

  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  // 协方差矩阵最大特征值对应的特征向量即主方向
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const direction = { x: Math.cos(theta), y: Math.sin(theta) };
  const origin = { x: cx, y: cy };

  let sum = 0;
  let maxError = 0;
  const nx = -direction.y;
  const ny = direction.x;
  for (const p of points) {
    const d = Math.abs((p.x - cx) * nx + (p.y - cy) * ny);
    sum += d * d;
    if (d > maxError) maxError = d;
  }
  return { origin, direction, rmse: Math.sqrt(sum / n), maxError };
}

/**
 * 将点集投影到拟合直线上，返回覆盖全部点的最短线段。
 *
 * 重要：输出线段的方向与输入点序一致（a 靠近首点，b 靠近末点）。
 * 全最小二乘求出的主方向符号是任意的，若不做定向，
 * 由多段线段串联顶点时会出现首尾颠倒，导致折线自我折返。
 */
export function fitSegment(points: readonly Point[]): { segment: Segment; fit: LineFit } {
  const fit = fitLine(points);
  if (points.length < 2) {
    const p = points[0] ?? { x: 0, y: 0 };
    return { segment: { a: { ...p }, b: { ...p } }, fit };
  }
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const p of points) {
    const t = (p.x - fit.origin.x) * fit.direction.x + (p.y - fit.origin.y) * fit.direction.y;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  const lo: Point = {
    x: fit.origin.x + fit.direction.x * tMin,
    y: fit.origin.y + fit.direction.y * tMin,
  };
  const hi: Point = {
    x: fit.origin.x + fit.direction.x * tMax,
    y: fit.origin.y + fit.direction.y * tMax,
  };

  // 按输入点序定向：首点更靠近 lo 则 a=lo，否则交换
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const forward = distSq(first, lo) + distSq(last, hi);
  const backward = distSq(first, hi) + distSq(last, lo);
  const segment: Segment = backward < forward ? { a: hi, b: lo } : { a: lo, b: hi };

  return { segment, fit };
}

/** 折线上的点是否都近似落在首尾连线上。 */
export function isStraight(points: readonly Point[], tolerance: number): boolean {
  if (points.length <= 2) return true;
  const a = points[0]!;
  const b = points[points.length - 1]!;
  if (dist(a, b) < EPS) return false;
  for (let i = 1; i < points.length - 1; i++) {
    if (pointLineDistance(points[i]!, a, b) > tolerance) return false;
  }
  return true;
}

/** 两条线段是否共线且可合并（角度接近 + 横向偏移小 + 端点接近或重叠）。 */
export function isCollinearMergeable(
  s1: Segment,
  s2: Segment,
  angleTolDeg: number,
  lateralTol: number,
  gapTol: number,
): boolean {
  if (undirectedAngleDiffDeg(segAngleDeg(s1), segAngleDeg(s2)) > angleTolDeg) return false;
  // 横向偏移：s2 端点到 s1 所在直线的距离
  const d1 = pointLineDistance(s2.a, s1.a, s1.b);
  const d2 = pointLineDistance(s2.b, s1.a, s1.b);
  if (Math.max(d1, d2) > lateralTol) return false;
  // 纵向间隙：两段的最近端点距离；若已重叠则间隙为 0
  const gap = Math.min(
    pointSegmentDistance(s2.a, s1.a, s1.b),
    pointSegmentDistance(s2.b, s1.a, s1.b),
    pointSegmentDistance(s1.a, s2.a, s2.b),
    pointSegmentDistance(s1.b, s2.a, s2.b),
  );
  return gap <= gapTol;
}

/** 合并两条共线线段：取所有端点在主方向上的极值。 */
export function mergeSegments(s1: Segment, s2: Segment): Segment {
  const pts = [s1.a, s1.b, s2.a, s2.b];
  const { segment } = fitSegment(pts);
  return segment;
}

export interface MergeOptions {
  angleTolDeg: number;
  /** 横向偏移容差。 */
  lateralTol: number;
  /** 纵向间隙容差（断线连接距离）。 */
  gapTol: number;
  maxPasses?: number;
}

/**
 * 反复合并共线线段，直到没有可合并对。
 * 采用「按角度分桶 + 桶内两两尝试」以避免全量 O(n²)。
 */
export function mergeCollinearSegments(segments: readonly Segment[], opts: MergeOptions): Segment[] {
  let current = segments.map((s) => ({ a: { ...s.a }, b: { ...s.b } }));
  const maxPasses = opts.maxPasses ?? 4;

  for (let pass = 0; pass < maxPasses; pass++) {
    const bucketSize = Math.max(opts.angleTolDeg, 1);
    const buckets = new Map<number, number[]>();
    current.forEach((s, i) => {
      const key = Math.floor(segAngleDeg(s) / bucketSize);
      // 同时放入相邻桶，避免边界漏配
      for (const k of [key - 1, key, key + 1]) {
        const arr = buckets.get(k);
        if (arr) arr.push(i);
        else buckets.set(k, [i]);
      }
    });

    const consumed = new Uint8Array(current.length);
    const next: Segment[] = [];
    let mergedAny = false;

    for (let i = 0; i < current.length; i++) {
      if (consumed[i]) continue;
      let acc = current[i]!;
      consumed[i] = 1;

      const key = Math.floor(segAngleDeg(acc) / bucketSize);
      const candidates = new Set<number>();
      for (const k of [key - 1, key, key + 1]) {
        for (const idx of buckets.get(k) ?? []) candidates.add(idx);
      }

      let changed = true;
      while (changed) {
        changed = false;
        for (const j of candidates) {
          if (consumed[j]) continue;
          const other = current[j]!;
          if (isCollinearMergeable(acc, other, opts.angleTolDeg, opts.lateralTol, opts.gapTol)) {
            acc = mergeSegments(acc, other);
            consumed[j] = 1;
            changed = true;
            mergedAny = true;
          }
        }
      }
      next.push(acc);
    }

    current = next;
    if (!mergedAny) break;
  }
  return current;
}

/**
 * 平行近邻线归并：手绘时一条墙常被画成两条平行线（双线墙），
 * 若两条线平行、间距小于 proximityTol 且投影重叠率高，则合并为中心线。
 */
export function mergeParallelNeighbors(
  segments: readonly Segment[],
  angleTolDeg: number,
  proximityTol: number,
  minOverlapRatio = 0.5,
): Segment[] {
  const src = segments.map((s) => ({ a: { ...s.a }, b: { ...s.b } }));
  const consumed = new Uint8Array(src.length);
  const out: Segment[] = [];

  for (let i = 0; i < src.length; i++) {
    if (consumed[i]) continue;
    const s1 = src[i]!;
    const a1 = segAngleDeg(s1);
    const l1 = segLength(s1);
    let merged: Segment | null = null;

    for (let j = i + 1; j < src.length; j++) {
      if (consumed[j]) continue;
      const s2 = src[j]!;
      if (undirectedAngleDiffDeg(a1, segAngleDeg(s2)) > angleTolDeg) continue;

      const d1 = pointLineDistance(s2.a, s1.a, s1.b);
      const d2 = pointLineDistance(s2.b, s1.a, s1.b);
      const gap = (d1 + d2) / 2;
      // 距离过近视为重复线（交给 mergeCollinear 处理），过远视为不同墙
      if (gap < 1e-6 || gap > proximityTol) continue;
      // 平行性：两端到直线距离应接近
      if (Math.abs(d1 - d2) > proximityTol * 0.5) continue;

      const overlap = projectionOverlapRatio(s1, s2);
      if (overlap < minOverlapRatio) continue;

      const l2 = segLength(s2);
      if (Math.min(l1, l2) / Math.max(l1, l2, EPS) < 0.4) continue;

      // 取中心线
      merged = {
        a: { x: (s1.a.x + s2.a.x) / 2, y: (s1.a.y + s2.a.y) / 2 },
        b: { x: (s1.b.x + s2.b.x) / 2, y: (s1.b.y + s2.b.y) / 2 },
      };
      // 端点方向可能相反，取更短的配对
      const alt = {
        a: { x: (s1.a.x + s2.b.x) / 2, y: (s1.a.y + s2.b.y) / 2 },
        b: { x: (s1.b.x + s2.a.x) / 2, y: (s1.b.y + s2.a.y) / 2 },
      };
      if (segLength(alt) > segLength(merged)) merged = alt;

      consumed[j] = 1;
      break;
    }

    consumed[i] = 1;
    out.push(merged ?? s1);
  }
  return out;
}

/** 两条近平行线段在主方向上的投影重叠率（0..1）。 */
export function projectionOverlapRatio(s1: Segment, s2: Segment): number {
  const dx = s1.b.x - s1.a.x;
  const dy = s1.b.y - s1.a.y;
  const l = Math.hypot(dx, dy);
  if (l < EPS) return 0;
  const ux = dx / l;
  const uy = dy / l;
  const proj = (p: Point) => (p.x - s1.a.x) * ux + (p.y - s1.a.y) * uy;
  const t1 = [0, l];
  const t2 = [proj(s2.a), proj(s2.b)].sort((a, b) => a - b);
  const lo = Math.max(t1[0]!, t2[0]!);
  const hi = Math.min(t1[1]!, t2[1]!);
  const overlap = Math.max(0, hi - lo);
  return overlap / Math.min(l, t2[1]! - t2[0]! || l);
}

/** 去除长度小于阈值的短线（毛刺）。 */
export function removeShortSegments(segments: readonly Segment[], minLength: number): Segment[] {
  return segments.filter((s) => segLength(s) >= minLength).map((s) => ({ a: { ...s.a }, b: { ...s.b } }));
}

/** 去重：完全或近似重合的线段只保留一条（保留更长者）。 */
export function dedupeSegments(segments: readonly Segment[], tolerance: number): Segment[] {
  const sorted = [...segments].sort((a, b) => segLength(b) - segLength(a));
  const kept: Segment[] = [];
  for (const s of sorted) {
    let dup = false;
    for (const k of kept) {
      const sameDir =
        distSq(s.a, k.a) <= tolerance * tolerance && distSq(s.b, k.b) <= tolerance * tolerance;
      const revDir = distSq(s.a, k.b) <= tolerance * tolerance && distSq(s.b, k.a) <= tolerance * tolerance;
      if (sameDir || revDir) {
        dup = true;
        break;
      }
      // 被更长线段完全覆盖
      if (
        undirectedAngleDiffDeg(segAngleDeg(s), segAngleDeg(k)) < 4 &&
        pointSegmentDistance(s.a, k.a, k.b) <= tolerance &&
        pointSegmentDistance(s.b, k.a, k.b) <= tolerance
      ) {
        dup = true;
        break;
      }
    }
    if (!dup) kept.push({ a: { ...s.a }, b: { ...s.b } });
  }
  return kept;
}

/** 把折线拆分为线段列表。 */
export function polylineToSegments(points: readonly Point[], closed = false): Segment[] {
  const out: Segment[] = [];
  const n = points.length;
  const limit = closed ? n : n - 1;
  for (let i = 0; i < limit; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    if (dist(a, b) > EPS) out.push({ a: { ...a }, b: { ...b } });
  }
  return out;
}

export { angleDeg };
