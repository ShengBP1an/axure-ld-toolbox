/**
 * 多边形运算：面积、朝向、包含判定、最小外接矩形、规则度评估。
 */

import type { Bounds, Point } from '../../types/vector';
import { angleDeg, cross, dist, EPS, rotate, sub, undirectedAngleDiffDeg } from './vec';

/** 有向面积（Shoelace）。屏幕坐标系 y 向下时，正值代表顺时针。 */
export function signedArea(points: readonly Point[]): number {
  const n = points.length;
  if (n < 3) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

export function area(points: readonly Point[]): number {
  return Math.abs(signedArea(points));
}

export function perimeter(points: readonly Point[], closed = true): number {
  const n = points.length;
  if (n < 2) return 0;
  let s = 0;
  const limit = closed ? n : n - 1;
  for (let i = 0; i < limit; i++) {
    s += dist(points[i]!, points[(i + 1) % n]!);
  }
  return s;
}

export function centroid(points: readonly Point[]): Point {
  const n = points.length;
  if (n === 0) return { x: 0, y: 0 };
  if (n < 3) {
    let sx = 0;
    let sy = 0;
    for (const p of points) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / n, y: sy / n };
  }
  let cx = 0;
  let cy = 0;
  let a2 = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i]!;
    const q = points[(i + 1) % n]!;
    const f = p.x * q.y - q.x * p.y;
    a2 += f;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  if (Math.abs(a2) < EPS) {
    let sx = 0;
    let sy = 0;
    for (const p of points) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / n, y: sy / n };
  }
  return { x: cx / (3 * a2), y: cy / (3 * a2) };
}

/** 归一化朝向为逆时针（signedArea < 0 在 y 向下坐标系中为逆时针）。 */
export function toCounterClockwise(points: readonly Point[]): Point[] {
  const out = points.map((p) => ({ ...p }));
  if (signedArea(out) > 0) out.reverse();
  return out;
}

export function toClockwise(points: readonly Point[]): Point[] {
  const out = points.map((p) => ({ ...p }));
  if (signedArea(out) < 0) out.reverse();
  return out;
}

export function bounds(points: readonly Point[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function boundsArea(b: Bounds): number {
  return Math.max(0, b.maxX - b.minX) * Math.max(0, b.maxY - b.minY);
}

/** 射线法判断点是否在多边形内（边界视为内部）。 */
export function pointInPolygon(p: Point, poly: readonly Point[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    // 边界判定
    if (Math.abs(cross(sub(b, a), sub(p, a))) < 1e-7) {
      const withinX = p.x >= Math.min(a.x, b.x) - 1e-7 && p.x <= Math.max(a.x, b.x) + 1e-7;
      const withinY = p.y >= Math.min(a.y, b.y) - 1e-7 && p.y <= Math.max(a.y, b.y) + 1e-7;
      if (withinX && withinY) return true;
    }
    const intersects = a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** inner 是否被 outer 完全包含（用顶点采样近似，适合非自相交多边形）。 */
export function polygonContains(outer: readonly Point[], inner: readonly Point[]): boolean {
  if (outer.length < 3 || inner.length < 1) return false;
  for (const p of inner) {
    if (!pointInPolygon(p, outer)) return false;
  }
  return true;
}

/** 凸包（Andrew monotone chain），最小外接矩形的前置步骤。 */
export function convexHull(points: readonly Point[]): Point[] {
  const n = points.length;
  if (n < 3) return points.map((p) => ({ ...p }));
  const sorted = points.map((p) => ({ ...p })).sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

  const build = (src: Point[]): Point[] => {
    const stack: Point[] = [];
    for (const p of src) {
      while (stack.length >= 2 && cross(sub(stack[stack.length - 1]!, stack[stack.length - 2]!), sub(p, stack[stack.length - 1]!)) <= 0) {
        stack.pop();
      }
      stack.push(p);
    }
    return stack;
  };

  const lower = build(sorted);
  const upper = build([...sorted].reverse());
  lower.pop();
  upper.pop();
  const hull = [...lower, ...upper];
  return hull.length >= 3 ? hull : points.map((p) => ({ ...p }));
}

export interface MinAreaRect {
  /** 四个角点，按顺序。 */
  corners: [Point, Point, Point, Point];
  center: Point;
  width: number;
  height: number;
  /** 旋转角（度，[0,180)），为 width 方向边与 x 轴夹角。 */
  angle: number;
  area: number;
}

/** 旋转卡壳法求最小面积外接矩形。 */
export function minAreaRect(points: readonly Point[]): MinAreaRect {
  const hull = convexHull(points);
  const n = hull.length;
  if (n < 3) {
    const b = bounds(points);
    return {
      corners: [
        { x: b.minX, y: b.minY },
        { x: b.maxX, y: b.minY },
        { x: b.maxX, y: b.maxY },
        { x: b.minX, y: b.maxY },
      ],
      center: { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 },
      width: b.maxX - b.minX,
      height: b.maxY - b.minY,
      angle: 0,
      area: boundsArea(b),
    };
  }

  let best: MinAreaRect | null = null;
  for (let i = 0; i < n; i++) {
    const a = hull[i]!;
    const b = hull[(i + 1) % n]!;
    const edgeAngle = Math.atan2(b.y - a.y, b.x - a.x);
    const rot = -edgeAngle;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of hull) {
      const r = rotate(p, rot);
      if (r.x < minX) minX = r.x;
      if (r.y < minY) minY = r.y;
      if (r.x > maxX) maxX = r.x;
      if (r.y > maxY) maxY = r.y;
    }
    const w = maxX - minX;
    const h = maxY - minY;
    const ar = w * h;
    if (best === null || ar < best.area - EPS) {
      const back = (p: Point) => rotate(p, edgeAngle);
      const c0 = back({ x: minX, y: minY });
      const c1 = back({ x: maxX, y: minY });
      const c2 = back({ x: maxX, y: maxY });
      const c3 = back({ x: minX, y: maxY });
      let deg = (edgeAngle * 180) / Math.PI;
      deg = ((deg % 180) + 180) % 180;
      best = {
        corners: [c0, c1, c2, c3],
        center: back({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 }),
        width: w,
        height: h,
        angle: deg,
        area: ar,
      };
    }
  }
  return best!;
}

/**
 * 多边形与其最小外接矩形的面积比（0..1）。
 * 用于「能否稳定表示为矩形」的判据，避免逐点栅格化开销。
 */
export function rectFillRatio(points: readonly Point[]): number {
  const mar = minAreaRect(points);
  if (mar.area < EPS) return 0;
  return Math.min(1, area(points) / mar.area);
}

/** 多边形与轴对齐包围盒的面积比。 */
export function aabbFillRatio(points: readonly Point[]): number {
  const b = bounds(points);
  const ba = boundsArea(b);
  if (ba < EPS) return 0;
  return Math.min(1, area(points) / ba);
}

export interface PolygonRegularity {
  /** 边长的变异系数（标准差 / 均值），越小越规则。 */
  edgeCv: number;
  /** 内角与理论正多边形内角的最大偏差（度）。 */
  maxAngleDev: number;
  /** 各内角是否都接近 90°（矩形判据）。 */
  allRightAngles: boolean;
  /** 各边是否都近似轴对齐。 */
  axisAligned: boolean;
}

/** 评估多边形规则度，供 classify 择优使用。 */
export function analyzeRegularity(points: readonly Point[], angleTolDeg = 8): PolygonRegularity {
  const n = points.length;
  if (n < 3) {
    return { edgeCv: 1, maxAngleDev: 180, allRightAngles: false, axisAligned: false };
  }

  const edges: number[] = [];
  let axisAligned = true;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    edges.push(dist(a, b));
    const ang = angleDeg(a, b);
    const devH = undirectedAngleDiffDeg(ang, 0);
    const devV = undirectedAngleDiffDeg(ang, 90);
    if (Math.min(devH, devV) > angleTolDeg) axisAligned = false;
  }

  const mean = edges.reduce((s, v) => s + v, 0) / n;
  const variance = edges.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const edgeCv = mean > EPS ? Math.sqrt(variance) / mean : 1;

  const idealInterior = ((n - 2) * 180) / n;
  let maxAngleDev = 0;
  let allRight = true;
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n]!;
    const cur = points[i]!;
    const next = points[(i + 1) % n]!;
    const v1 = sub(prev, cur);
    const v2 = sub(next, cur);
    const l1 = Math.hypot(v1.x, v1.y);
    const l2 = Math.hypot(v2.x, v2.y);
    if (l1 < EPS || l2 < EPS) {
      allRight = false;
      continue;
    }
    const cosA = Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (l1 * l2)));
    const interior = (Math.acos(cosA) * 180) / Math.PI;
    maxAngleDev = Math.max(maxAngleDev, Math.abs(interior - idealInterior));
    if (Math.abs(interior - 90) > angleTolDeg) allRight = false;
  }

  return { edgeCv, maxAngleDev, allRightAngles: allRight, axisAligned };
}

/** 多边形的「最小宽度」近似：面积 / 最长边方向长度，用于细通道保护。 */
export function minWidth(points: readonly Point[]): number {
  const mar = minAreaRect(points);
  return Math.min(mar.width, mar.height);
}
