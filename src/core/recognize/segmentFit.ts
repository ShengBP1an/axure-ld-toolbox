/**
 * 分支折线 → 线段 / 折线拟合。
 *
 * 流程：像素折线 → RDP 粗分（找拐点）→ 逐段最小二乘直线拟合（去抖动）
 *      → 相邻近共线段再合并 → 输出线段序列。
 *
 * 关键点：先 RDP 再拟合，而不是直接 RDP。
 * 直接 RDP 的顶点必落在原像素上，手绘抖动会残留；
 * 用拟合线求交作为顶点，能得到更"直"的墙线。
 */

import type { Point } from '../../types/vector';
import { rdp } from '../geometry/rdp';
import { fitLine, fitSegment, type Segment, segLength, segAngleDeg } from '../geometry/lineFit';
import { dist, EPS, undirectedAngleDiffDeg, cross, sub } from '../geometry/vec';
import type { SkeletonBranch } from './skeletonGraph';

export interface FitOptions {
  /** RDP 容差（像素）。 */
  rdpEpsilon: number;
  /** 相邻段合并的角度容差（度）。 */
  mergeAngleTolDeg: number;
  /** 最短保留段长（像素）。 */
  minSegmentLength: number;
  /** 拟合残差超过此值时判为「曲线」，保留为自由路径。 */
  curveRmseThreshold: number;
}

export const DEFAULT_FIT: FitOptions = {
  rdpEpsilon: 2.2,
  mergeAngleTolDeg: 12,
  minSegmentLength: 4,
  curveRmseThreshold: 2.6,
};

export interface FittedBranch {
  branchId: number;
  /** 拟合后的顶点序列。 */
  points: Point[];
  closed: boolean;
  /** 每段的拟合残差 RMSE。 */
  segmentRmse: number[];
  /** 整体最大残差，用于置信度。 */
  maxRmse: number;
  /** 是否被判定为曲线（不宜再吸附到常用角度）。 */
  curved: boolean;
  /** 原像素路径长度。 */
  pixelLength: number;
  /** 原像素点数，用于计算简化率。 */
  originalPointCount: number;
}

/** 对单个骨架分支做拟合。 */
export function fitBranch(branch: SkeletonBranch, opts: FitOptions): FittedBranch {
  const pixels = branch.pixels;
  const closed = branch.closed;

  if (pixels.length < 2) {
    return {
      branchId: branch.id,
      points: pixels.map((p) => ({ ...p })),
      closed: false,
      segmentRmse: [],
      maxRmse: 0,
      curved: false,
      pixelLength: branch.length,
      originalPointCount: pixels.length,
    };
  }

  /* 1) RDP 粗分：定位拐点 */
  const coarse = rdp(pixels, {
    epsilon: opts.rdpEpsilon,
    closed,
    minPoints: closed ? 3 : 2,
  });

  /* 2) 建立像素分段：把原像素按拐点切开 */
  const anchorIdx = mapAnchorsToIndices(pixels, coarse);
  const groups = splitByAnchors(pixels, anchorIdx, closed);

  /* 3) 逐段直线拟合 */
  const fits = groups.map((g) => fitSegment(g));
  const segmentRmse = fits.map((f) => f.fit.rmse);
  const maxRmse = segmentRmse.length > 0 ? Math.max(...segmentRmse) : 0;

  /* 4) 相邻近共线段合并 */
  const mergedSegments = mergeAdjacent(
    fits.map((f) => f.segment),
    opts.mergeAngleTolDeg,
    groups,
  );

  /* 5) 由相邻线段求交得到顶点（比取端点中点更"直"） */
  const points = segmentsToVertices(mergedSegments, closed);

  /* 6) 曲线判定：整体残差大 + 段数多 → 手绘弧线 */
  const curved = maxRmse > opts.curveRmseThreshold || mergedSegments.length > 6;

  return {
    branchId: branch.id,
    points,
    closed,
    segmentRmse,
    maxRmse,
    curved,
    pixelLength: branch.length,
    originalPointCount: pixels.length,
  };
}

/** 把 RDP 结果的顶点映射回原像素数组的索引。 */
function mapAnchorsToIndices(pixels: readonly Point[], anchors: readonly Point[]): number[] {
  const out: number[] = [];
  let search = 0;
  for (const a of anchors) {
    let bestIdx = search;
    let bestD = Infinity;
    for (let i = search; i < pixels.length; i++) {
      const d = dist(pixels[i]!, a);
      if (d < bestD) {
        bestD = d;
        bestIdx = i;
        if (d < 0.5) break;
      }
    }
    if (out.length === 0 || bestIdx > out[out.length - 1]!) out.push(bestIdx);
    search = bestIdx;
  }
  if (out.length === 0) out.push(0);
  if (out[0]! !== 0) out.unshift(0);
  const last = pixels.length - 1;
  if (out[out.length - 1]! !== last) out.push(last);
  return out;
}

/** 按锚点索引把像素序列切成多组（相邻组共享边界点）。 */
function splitByAnchors(pixels: readonly Point[], anchors: readonly number[], closed: boolean): Point[][] {
  const groups: Point[][] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i]!;
    const b = anchors[i + 1]!;
    if (b <= a) continue;
    groups.push(pixels.slice(a, b + 1).map((p) => ({ ...p })));
  }
  if (closed && groups.length > 0) {
    // 闭合时补上「末点 → 首点」这一段
    const tail = anchors[anchors.length - 1]!;
    const wrap = [...pixels.slice(tail).map((p) => ({ ...p })), { ...pixels[0]! }];
    if (wrap.length >= 2) groups.push(wrap);
  }
  if (groups.length === 0) groups.push(pixels.map((p) => ({ ...p })));
  return groups;
}

/** 合并相邻的近共线线段（重新用两组像素合并拟合，而非简单平均）。 */
function mergeAdjacent(segments: readonly Segment[], angleTolDeg: number, groups: readonly Point[][]): Segment[] {
  if (segments.length <= 1) return segments.map((s) => ({ a: { ...s.a }, b: { ...s.b } }));

  const out: Segment[] = [];
  let accPixels: Point[] = [...(groups[0] ?? [])];
  let accSeg: Segment = segments[0]!;

  for (let i = 1; i < segments.length; i++) {
    const s = segments[i]!;
    if (undirectedAngleDiffDeg(segAngleDeg(accSeg), segAngleDeg(s)) <= angleTolDeg) {
      accPixels = [...accPixels, ...(groups[i] ?? [])];
      accSeg = fitSegment(accPixels).segment;
    } else {
      out.push(accSeg);
      accPixels = [...(groups[i] ?? [])];
      accSeg = s;
    }
  }
  out.push(accSeg);
  return out;
}

/**
 * 由线段序列求顶点：相邻线段求交作为拐点。
 * 平行或近平行时退化为取两端点中点，避免交点飞到无穷远。
 */
function segmentsToVertices(segments: readonly Segment[], closed: boolean): Point[] {
  if (segments.length === 0) return [];
  if (segments.length === 1) {
    const s = segments[0]!;
    return closed ? [{ ...s.a }, { ...s.b }] : [{ ...s.a }, { ...s.b }];
  }

  const points: Point[] = [];
  if (!closed) points.push({ ...segments[0]!.a });

  const limit = closed ? segments.length : segments.length - 1;
  for (let i = 0; i < limit; i++) {
    const s1 = segments[i]!;
    const s2 = segments[(i + 1) % segments.length]!;
    points.push(lineIntersectionOrMid(s1, s2));
  }

  if (!closed) points.push({ ...segments[segments.length - 1]!.b });
  return points;
}

/** 两条线段所在「直线」的交点；近平行时取端点中点。 */
function lineIntersectionOrMid(s1: Segment, s2: Segment): Point {
  const d1 = sub(s1.b, s1.a);
  const d2 = sub(s2.b, s2.a);
  const denom = cross(d1, d2);
  const l1 = Math.hypot(d1.x, d1.y);
  const l2 = Math.hypot(d2.x, d2.y);
  // 归一化后的叉积即 sin(夹角)，小于 sin(4°) 视为近平行
  if (l1 < EPS || l2 < EPS || Math.abs(denom) / (l1 * l2) < 0.07) {
    return { x: (s1.b.x + s2.a.x) / 2, y: (s1.b.y + s2.a.y) / 2 };
  }
  const t = cross(sub(s2.a, s1.a), d2) / denom;
  const p = { x: s1.a.x + d1.x * t, y: s1.a.y + d1.y * t };
  // 交点飞太远说明数值不稳定，退回中点
  const mid = { x: (s1.b.x + s2.a.x) / 2, y: (s1.b.y + s2.a.y) / 2 };
  const tolerance = Math.max(l1, l2) * 0.6 + 8;
  return dist(p, mid) > tolerance ? mid : p;
}

/** 把拟合结果展开为线段列表。 */
export function branchToSegments(fb: FittedBranch, minLength: number): Segment[] {
  const out: Segment[] = [];
  const n = fb.points.length;
  const limit = fb.closed ? n : n - 1;
  for (let i = 0; i < limit; i++) {
    const a = fb.points[i]!;
    const b = fb.points[(i + 1) % n]!;
    const s: Segment = { a: { ...a }, b: { ...b } };
    if (segLength(s) >= minLength) out.push(s);
  }
  return out;
}

/** 判断拟合结果是否为「单一直线」（后续可直出 line 元素）。 */
export function isSingleLine(fb: FittedBranch): boolean {
  return !fb.closed && fb.points.length === 2;
}

export { fitLine };
