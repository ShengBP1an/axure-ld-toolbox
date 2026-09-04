/**
 * 线段求交与自相交检测。
 */

import type { Point } from '../../types/vector';
import { cross, dist, EPS, sub } from './vec';

export interface SegmentIntersection {
  point: Point;
  /** 在第一条线段上的参数 [0,1]。 */
  t: number;
  /** 在第二条线段上的参数 [0,1]。 */
  u: number;
  /** 是否为共线重叠（此时 point 取重叠区间中点）。 */
  collinear: boolean;
}

/**
 * 线段 p1p2 与 p3p4 求交。
 * 端点接触视为相交（inclusive），共线重叠单独标记。
 */
export function segmentIntersection(
  p1: Point,
  p2: Point,
  p3: Point,
  p4: Point,
  eps = 1e-9,
): SegmentIntersection | null {
  const r = sub(p2, p1);
  const s = sub(p4, p3);
  const denom = cross(r, s);
  const qp = sub(p3, p1);
  const qpr = cross(qp, r);

  if (Math.abs(denom) < eps) {
    if (Math.abs(qpr) > eps) return null; // 平行不共线
    // 共线：检查投影区间是否重叠
    const rr = r.x * r.x + r.y * r.y;
    if (rr < eps) return null;
    const t0 = (qp.x * r.x + qp.y * r.y) / rr;
    const t1 = t0 + (s.x * r.x + s.y * r.y) / rr;
    const lo = Math.min(t0, t1);
    const hi = Math.max(t0, t1);
    const oLo = Math.max(0, lo);
    const oHi = Math.min(1, hi);
    if (oLo > oHi + eps) return null;
    const tm = (oLo + oHi) / 2;
    return {
      point: { x: p1.x + r.x * tm, y: p1.y + r.y * tm },
      t: tm,
      u: 0.5,
      collinear: true,
    };
  }

  const t = cross(qp, s) / denom;
  const u = qpr / denom;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  const tc = t < 0 ? 0 : t > 1 ? 1 : t;
  return {
    point: { x: p1.x + r.x * tc, y: p1.y + r.y * tc },
    t: tc,
    u: u < 0 ? 0 : u > 1 ? 1 : u,
    collinear: false,
  };
}

/** 快速判断两线段是否相交（不求交点）。 */
export function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point, eps = 1e-9): boolean {
  return segmentIntersection(p1, p2, p3, p4, eps) !== null;
}

export interface SelfIntersection {
  /** 相交的两条边的起点索引。 */
  edgeA: number;
  edgeB: number;
  point: Point;
}

/**
 * 多边形 / 折线自相交检测。
 * 使用按 x 排序 + 活动区间剪枝（近似扫描线），最坏退化为 O(n²) 但对本场景规模足够。
 * 相邻边共享端点的情形被正确排除。
 */
export function findSelfIntersections(
  points: readonly Point[],
  closed: boolean,
  limit = 16,
): SelfIntersection[] {
  const n = points.length;
  const edgeCount = closed ? n : n - 1;
  if (edgeCount < 3) return [];

  interface Edge {
    i: number;
    a: Point;
    b: Point;
    minX: number;
    maxX: number;
  }
  const edges: Edge[] = [];
  for (let i = 0; i < edgeCount; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    if (dist(a, b) < EPS) continue;
    edges.push({ i, a, b, minX: Math.min(a.x, b.x), maxX: Math.max(a.x, b.x) });
  }
  edges.sort((p, q) => p.minX - q.minX);

  const out: SelfIntersection[] = [];
  for (let i = 0; i < edges.length && out.length < limit; i++) {
    const e1 = edges[i]!;
    for (let j = i + 1; j < edges.length; j++) {
      const e2 = edges[j]!;
      if (e2.minX > e1.maxX) break; // 扫描线剪枝
      // 跳过相邻边（共享端点）
      const diff = Math.abs(e1.i - e2.i);
      if (diff === 1) continue;
      if (closed && diff === edgeCount - 1) continue;

      const hit = segmentIntersection(e1.a, e1.b, e2.a, e2.b, 1e-9);
      if (hit === null) continue;
      // 排除仅在端点处「碰触」的退化情形
      const touchesEndpoint =
        dist(hit.point, e1.a) < 1e-7 ||
        dist(hit.point, e1.b) < 1e-7 ||
        dist(hit.point, e2.a) < 1e-7 ||
        dist(hit.point, e2.b) < 1e-7;
      if (touchesEndpoint && !hit.collinear) continue;

      out.push({ edgeA: e1.i, edgeB: e2.i, point: hit.point });
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function isSelfIntersecting(points: readonly Point[], closed: boolean): boolean {
  return findSelfIntersections(points, closed, 1).length > 0;
}

/** 计算两条线段的最短距离（用于重复线判定）。 */
export function segmentDistance(p1: Point, p2: Point, p3: Point, p4: Point): number {
  if (segmentsIntersect(p1, p2, p3, p4)) return 0;
  const d = (p: Point, a: Point, b: Point): number => {
    const ab = sub(b, a);
    const l2 = ab.x * ab.x + ab.y * ab.y;
    if (l2 < EPS) return dist(p, a);
    let t = ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / l2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return dist(p, { x: a.x + ab.x * t, y: a.y + ab.y * t });
  };
  return Math.min(d(p1, p3, p4), d(p2, p3, p4), d(p3, p1, p2), d(p4, p1, p2));
}
