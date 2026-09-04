/**
 * 拓扑守卫 —— 防止几何简化破坏空间结构。
 *
 * 对应 Prompt 3.3 第 7 条与最低验收标准 4：
 *   "防止过度简化导致通道消失、区域相交或拓扑关系改变"。
 *
 * 校验项：
 *   1. 面积漂移      简化前后面积变化不得超过阈值；
 *   2. 最小通道宽度  简化后区域的最小宽度不得低于阈值（细通道保护）；
 *   3. 自相交        简化不得引入自相交；
 *   4. 包含关系      孔洞与宿主的包含关系不得改变；
 *   5. 顶点下限      闭合区域至少 3 点、开放折线至少 2 点。
 *
 * 违规时的处理：不是直接放弃，而是「降低容差重试」，
 * 重试仍失败则保留原始几何并记录 simplifyBlocked 问题（可见、可修正）。
 */

import type { Point } from '../../types/vector';
import { area, minWidth, polygonContains } from '../geometry/polygon';
import { findSelfIntersections, isSelfIntersecting } from '../geometry/intersect';
import { dist, EPS } from '../geometry/vec';
import { rdp } from '../geometry/rdp';

export interface GuardOptions {
  /** 允许的最大面积相对变化。 */
  maxAreaDrift: number;
  /** 允许的最小通道宽度（与输入同尺度）。低于此值视为通道消失。 */
  minPassageWidth: number;
  /** 简化后允许的最大 Hausdorff 近似偏差（与输入同尺度）。 */
  maxShapeDeviation: number;
  /** 重试次数上限。 */
  maxRetries: number;
  /** 每次重试的容差衰减系数。 */
  retryDecay: number;
}

export const DEFAULT_GUARD: GuardOptions = {
  maxAreaDrift: 0.06,
  minPassageWidth: 4,
  maxShapeDeviation: 3.5,
  maxRetries: 3,
  retryDecay: 0.55,
};

export type ViolationKind =
  | 'areaDrift'
  | 'passageCollapsed'
  | 'selfIntersect'
  | 'containmentChanged'
  | 'tooFewVertices'
  | 'shapeDeviation';

export interface Violation {
  kind: ViolationKind;
  message: string;
  /** 度量值，便于调参与 UI 展示。 */
  metric: number;
  at?: Point;
}

export interface GuardCheckResult {
  ok: boolean;
  violations: Violation[];
}

/** 校验单个形状的简化结果。 */
export function checkSimplification(
  original: readonly Point[],
  simplified: readonly Point[],
  closed: boolean,
  opts: GuardOptions,
): GuardCheckResult {
  const violations: Violation[] = [];

  /* 1) 顶点下限 */
  const minVertices = closed ? 3 : 2;
  if (simplified.length < minVertices) {
    violations.push({
      kind: 'tooFewVertices',
      message: `简化后仅剩 ${simplified.length} 个顶点，低于最小要求 ${minVertices}`,
      metric: simplified.length,
    });
    return { ok: false, violations };
  }

  /* 2) 自相交 */
  const hits = findSelfIntersections(simplified, closed, 2);
  if (hits.length > 0 && !isSelfIntersecting(original, closed)) {
    violations.push({
      kind: 'selfIntersect',
      message: '简化引入了自相交',
      metric: hits.length,
      at: hits[0]!.point,
    });
  }

  if (closed) {
    /* 3) 面积漂移 */
    const a0 = area(original);
    const a1 = area(simplified);
    const ref = Math.max(a0, a1, EPS);
    const drift = Math.abs(a0 - a1) / ref;
    if (drift > opts.maxAreaDrift) {
      violations.push({
        kind: 'areaDrift',
        message: `面积变化 ${(drift * 100).toFixed(1)}%，超过允许的 ${(opts.maxAreaDrift * 100).toFixed(0)}%`,
        metric: drift,
      });
    }

    /* 4) 最小通道宽度 */
    const w0 = minWidth(original);
    const w1 = minWidth(simplified);
    // 原本就是细通道时不惩罚，只要没变得更细
    if (w1 < opts.minPassageWidth && w1 < w0 * 0.85) {
      violations.push({
        kind: 'passageCollapsed',
        message: `最小宽度由 ${w0.toFixed(1)} 降到 ${w1.toFixed(1)}，通道可能已消失`,
        metric: w1,
      });
    }
  }

  /* 5) 形状偏差（近似 Hausdorff：原顶点到简化折线的最大距离） */
  const deviation = maxPointToPolylineDistance(original, simplified, closed);
  if (deviation > opts.maxShapeDeviation) {
    violations.push({
      kind: 'shapeDeviation',
      message: `形状偏差 ${deviation.toFixed(1)}，超过允许的 ${opts.maxShapeDeviation}`,
      metric: deviation,
    });
  }

  return { ok: violations.length === 0, violations };
}

export interface GuardedSimplifyResult {
  points: Point[];
  /** 实际使用的容差。 */
  epsilonUsed: number;
  /** 是否退回原始几何。 */
  fellBack: boolean;
  /** 触发过的违规（即使最终成功也记录，用于统计）。 */
  violations: Violation[];
  /** 重试次数。 */
  retries: number;
}

/**
 * 受守卫保护的 RDP 简化。
 * 违规则按 retryDecay 逐级降低容差重试；全部失败则返回原始几何。
 */
export function guardedSimplify(
  points: readonly Point[],
  closed: boolean,
  epsilon: number,
  opts: GuardOptions,
): GuardedSimplifyResult {
  const allViolations: Violation[] = [];
  let eps = epsilon;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    const simplified = rdp(points, {
      epsilon: eps,
      closed,
      minPoints: closed ? 3 : 2,
    });

    // 简化没有减少节点则无需校验
    if (simplified.length >= points.length) {
      return {
        points: points.map((p) => ({ ...p })),
        epsilonUsed: eps,
        fellBack: false,
        violations: allViolations,
        retries: attempt,
      };
    }

    const check = checkSimplification(points, simplified, closed, opts);
    if (check.ok) {
      return {
        points: simplified,
        epsilonUsed: eps,
        fellBack: false,
        violations: allViolations,
        retries: attempt,
      };
    }

    allViolations.push(...check.violations);
    eps *= opts.retryDecay;
    if (eps < 0.05) break;
  }

  return {
    points: points.map((p) => ({ ...p })),
    epsilonUsed: eps,
    fellBack: true,
    violations: allViolations,
    retries: opts.maxRetries,
  };
}

/**
 * 全局拓扑校验：检查一组区域之间的包含关系是否在简化后保持不变。
 * 用于孔洞 / 嵌套房间场景。
 */
export interface ContainmentPair {
  innerIndex: number;
  outerIndex: number;
}

export function extractContainment(shapes: ReadonlyArray<readonly Point[]>): ContainmentPair[] {
  const out: ContainmentPair[] = [];
  const areas = shapes.map((s) => area(s));
  for (let i = 0; i < shapes.length; i++) {
    for (let j = 0; j < shapes.length; j++) {
      if (i === j) continue;
      if (areas[j]! <= areas[i]!) continue;
      if (polygonContains(shapes[j]!, shapes[i]!)) out.push({ innerIndex: i, outerIndex: j });
    }
  }
  return out;
}

/** 比较两组包含关系是否一致。 */
export function containmentChanged(
  before: readonly ContainmentPair[],
  after: readonly ContainmentPair[],
): boolean {
  if (before.length !== after.length) return true;
  const key = (p: ContainmentPair): string => `${p.innerIndex}<${p.outerIndex}`;
  const setB = new Set(before.map(key));
  for (const p of after) {
    if (!setB.has(key(p))) return true;
  }
  return false;
}

/**
 * 检测区域之间的相互侵入（简化后本不该重叠的区域发生重叠）。
 * 用「顶点落入他人内部」做快速近似判定。
 */
export function findOverlaps(
  shapes: ReadonlyArray<readonly Point[]>,
  ignoreContainment: readonly ContainmentPair[],
): Array<{ a: number; b: number }> {
  const contained = new Set(ignoreContainment.map((p) => `${p.innerIndex}<${p.outerIndex}`));
  const out: Array<{ a: number; b: number }> = [];

  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      if (contained.has(`${i}<${j}`) || contained.has(`${j}<${i}`)) continue;
      if (partialOverlap(shapes[i]!, shapes[j]!)) out.push({ a: i, b: j });
    }
  }
  return out;
}

/** 部分重叠：一部分顶点在内、一部分在外。 */
function partialOverlap(p1: readonly Point[], p2: readonly Point[]): boolean {
  let inside = 0;
  let outside = 0;
  for (const p of p1) {
    if (pointInside(p, p2)) inside++;
    else outside++;
    if (inside > 0 && outside > 0) return true;
  }
  return false;
}

function pointInside(p: Point, poly: readonly Point[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** 近似 Hausdorff 距离：原顶点到简化折线的最大距离。 */
function maxPointToPolylineDistance(
  original: readonly Point[],
  simplified: readonly Point[],
  closed: boolean,
): number {
  const n = simplified.length;
  if (n < 2) return Infinity;
  let max = 0;
  const limit = closed ? n : n - 1;

  for (const p of original) {
    let best = Infinity;
    for (let i = 0; i < limit; i++) {
      const a = simplified[i]!;
      const b = simplified[(i + 1) % n]!;
      const d = pointSegDist(p, a, b);
      if (d < best) best = d;
      if (best < 1e-6) break;
    }
    if (best > max) max = best;
  }
  return max;
}

function pointSegDist(p: Point, a: Point, b: Point): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  if (l2 < EPS) return dist(p, a);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return dist(p, { x: a.x + abx * t, y: a.y + aby * t });
}
