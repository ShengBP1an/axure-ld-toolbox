/**
 * 基础向量运算。所有函数为纯函数，不修改入参。
 */

import type { Point } from '../../types/vector';

/** 几何比较的统一容差。地图单位下 1e-9 足以区分有效差异。 */
export const EPS = 1e-9;

export function pt(x: number, y: number): Point {
  return { x, y };
}

export function clone(p: Point): Point {
  return { x: p.x, y: p.y };
}

export function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function mul(a: Point, k: number): Point {
  return { x: a.x * k, y: a.y * k };
}

export function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y;
}

/** 二维叉积的 z 分量，用于判定转向与共线。 */
export function cross(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x;
}

export function len(a: Point): number {
  return Math.hypot(a.x, a.y);
}

export function lenSq(a: Point): number {
  return a.x * a.x + a.y * a.y;
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function distSq(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function normalize(a: Point): Point {
  const l = len(a);
  if (l < EPS) return { x: 0, y: 0 };
  return { x: a.x / l, y: a.y / l };
}

export function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function equals(a: Point, b: Point, eps = EPS): boolean {
  return Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps;
}

/** 绕原点旋转（弧度，屏幕坐标系 y 向下，故为顺时针正向）。 */
export function rotate(p: Point, rad: number): Point {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

export function rotateAround(p: Point, center: Point, rad: number): Point {
  return add(center, rotate(sub(p, center), rad));
}

/** 线段 ab 上距离 p 最近点的参数 t（已钳制到 [0,1]）。 */
export function projectParam(p: Point, a: Point, b: Point): number {
  const ab = sub(b, a);
  const l2 = lenSq(ab);
  if (l2 < EPS) return 0;
  const t = dot(sub(p, a), ab) / l2;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** 点到线段的最近点。 */
export function closestPointOnSegment(p: Point, a: Point, b: Point): Point {
  return lerp(a, b, projectParam(p, a, b));
}

/** 点到线段的距离。 */
export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  return dist(p, closestPointOnSegment(p, a, b));
}

/** 点到「无限长直线」的垂距，RDP 与直线拟合使用。 */
export function pointLineDistance(p: Point, a: Point, b: Point): number {
  const ab = sub(b, a);
  const l = len(ab);
  if (l < EPS) return dist(p, a);
  return Math.abs(cross(ab, sub(p, a))) / l;
}

/** 向量角度（弧度），范围 (-PI, PI]。 */
export function angleOf(v: Point): number {
  return Math.atan2(v.y, v.x);
}

/** 线段方向角（度），范围 [0, 360)。 */
export function angleDeg(a: Point, b: Point): number {
  const d = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return d < 0 ? d + 360 : d;
}

/** 归一化到 [0, 180)，用于「无向」线段的方向比较。 */
export function undirectedAngleDeg(a: Point, b: Point): number {
  const d = angleDeg(a, b) % 180;
  return d < 0 ? d + 180 : d;
}

/** 两个角度（度）的最小差值，考虑环绕，结果在 [0, 180]。 */
export function angleDiffDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/** 两个「无向」角度（度）的最小差值，结果在 [0, 90]。 */
export function undirectedAngleDiffDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 180;
  if (d > 90) d = 180 - d;
  return d;
}

export function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function toDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function isFiniteNumber(v: number): boolean {
  return Number.isFinite(v);
}

export function isFinitePoint(p: Point): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

/** 折线总长度。 */
export function polylineLength(points: readonly Point[], closed = false): number {
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += dist(points[i - 1]!, points[i]!);
  }
  if (closed) total += dist(points[points.length - 1]!, points[0]!);
  return total;
}
