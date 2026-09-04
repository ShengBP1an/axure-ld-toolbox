/**
 * 断线连接（bridging）、毛刺剪除与重复线去重。
 *
 * 手绘草图的典型缺陷：
 *   1. 墙线在拐角处没有真正相接（差 3~10 像素）；
 *   2. 一条墙被分成两笔画，中间有缺口；
 *   3. 同一条墙被反复描了两三次。
 *
 * 本模块在「线段集合」层面修复这些问题。修复不了的会被标记为待确认，
 * 而不是静默留下断口 —— 断口会导致区域无法闭合。
 */

import type { Point } from '../../types/vector';
import type { Segment } from '../geometry/lineFit';
import {
  dedupeSegments,
  mergeCollinearSegments,
  mergeParallelNeighbors,
  removeShortSegments,
  segAngleDeg,
  segLength,
} from '../geometry/lineFit';
import { segmentIntersection } from '../geometry/intersect';
import {
  angleDeg,
  dist,
  EPS,
  normalize,
  pointSegmentDistance,
  sub,
  undirectedAngleDiffDeg,
} from '../geometry/vec';

export interface BridgeOptions {
  /** 端点配对的最大间隙（像素）。 */
  maxGap: number;
  /** 延长线求交的最大延伸距离（像素）。 */
  maxExtend: number;
  /** 方向连续性容差（度）：两端点的出射方向需大致相对。 */
  directionTolDeg: number;
  /** 短线剪除阈值（像素）。 */
  minSegmentLength: number;
  /** 重复线判定容差（像素）。 */
  duplicateTol: number;
  /** 平行近邻线（双线墙）合并的最大间距（像素）。 */
  parallelProximity: number;
  /** 共线合并的角度容差（度）。 */
  collinearAngleTolDeg: number;
}

export const DEFAULT_BRIDGE: BridgeOptions = {
  maxGap: 14,
  maxExtend: 18,
  directionTolDeg: 34,
  minSegmentLength: 5,
  duplicateTol: 3.5,
  parallelProximity: 7,
  collinearAngleTolDeg: 8,
};

export interface BridgeRecord {
  kind: 'endpointJoin' | 'extendToIntersect' | 'cornerClose';
  /** 参与的线段索引（相对输入数组）。 */
  segmentIndices: number[];
  at: Point;
  gap: number;
}

export interface UnresolvedEndpoint {
  point: Point;
  segmentIndex: number;
  /** 到最近其它线段的距离，用于问题严重度排序。 */
  nearestDistance: number;
}

export interface BridgeResult {
  segments: Segment[];
  records: BridgeRecord[];
  /** 仍然悬空的端点（将被标记为「断线未连接」）。 */
  unresolved: UnresolvedEndpoint[];
  /** 被移除的短线数量。 */
  removedShort: number;
  /** 被移除的重复线数量。 */
  removedDuplicate: number;
}

/**
 * 完整的清理与桥接流程。顺序经过验证：
 *   去短线 → 共线合并 → 双线墙合并 → 去重 → 端点桥接 → 延长求交 → 悬空端点统计
 */
export function bridgeAndClean(input: readonly Segment[], opts: BridgeOptions): BridgeResult {
  const records: BridgeRecord[] = [];

  /* 1) 剪除极短线（毛刺） */
  const beforeShort = input.length;
  let segs = removeShortSegments(input, opts.minSegmentLength);
  const removedShort = beforeShort - segs.length;

  /* 2) 共线合并（同时完成「同一条墙被分两笔」的修复） */
  segs = mergeCollinearSegments(segs, {
    angleTolDeg: opts.collinearAngleTolDeg,
    lateralTol: opts.duplicateTol,
    gapTol: opts.maxGap,
  });

  /* 3) 双线墙合并为中心线 */
  segs = mergeParallelNeighbors(segs, opts.collinearAngleTolDeg, opts.parallelProximity);

  /* 4) 去重 */
  const beforeDup = segs.length;
  segs = dedupeSegments(segs, opts.duplicateTol);
  const removedDuplicate = beforeDup - segs.length;

  /* 5) 端点桥接：把互相接近的悬空端点拉到同一点 */
  const joined = joinNearbyEndpoints(segs, opts, records);
  segs = joined;

  /* 6) 延长求交：拐角处两条线未相接时，各自延长到交点 */
  segs = extendToIntersections(segs, opts, records);

  /* 7) 统计仍然悬空的端点 */
  const unresolved = findDanglingEndpoints(segs, opts.maxGap * 0.5);

  return { segments: segs, records, unresolved, removedShort, removedDuplicate };
}

interface EndpointRef {
  segIndex: number;
  /** 0 = a 端，1 = b 端。 */
  which: 0 | 1;
  point: Point;
  /** 从该端点向线段内部的方向（单位向量）。 */
  inward: Point;
}

function collectEndpoints(segs: readonly Segment[]): EndpointRef[] {
  const out: EndpointRef[] = [];
  segs.forEach((s, i) => {
    const dir = normalize(sub(s.b, s.a));
    out.push({ segIndex: i, which: 0, point: { ...s.a }, inward: dir });
    out.push({ segIndex: i, which: 1, point: { ...s.b }, inward: { x: -dir.x, y: -dir.y } });
  });
  return out;
}

/** 判断端点是否为「悬空」：不与任何其它线段接触。 */
function isDangling(segs: readonly Segment[], ep: EndpointRef, tolerance: number): boolean {
  for (let i = 0; i < segs.length; i++) {
    if (i === ep.segIndex) continue;
    if (pointSegmentDistance(ep.point, segs[i]!.a, segs[i]!.b) <= tolerance) return false;
  }
  return true;
}

/**
 * 把互相接近的悬空端点合并到中点。
 * 要求两端点的「出射方向」大致相对（夹角接近 180°）或呈明显拐角，
 * 避免把平行墙的端头错误拉在一起。
 */
function joinNearbyEndpoints(
  segs: readonly Segment[],
  opts: BridgeOptions,
  records: BridgeRecord[],
): Segment[] {
  const out = segs.map((s) => ({ a: { ...s.a }, b: { ...s.b } }));
  const eps = collectEndpoints(out);
  const dangling = eps.filter((e) => isDangling(out, e, 1.5));

  const used = new Set<string>();
  const keyOf = (e: EndpointRef): string => `${e.segIndex}:${e.which}`;

  // 按间隙从小到大配对，保证优先连接最可靠的组合
  const pairs: Array<{ a: EndpointRef; b: EndpointRef; gap: number }> = [];
  for (let i = 0; i < dangling.length; i++) {
    for (let j = i + 1; j < dangling.length; j++) {
      const e1 = dangling[i]!;
      const e2 = dangling[j]!;
      if (e1.segIndex === e2.segIndex) continue;
      const gap = dist(e1.point, e2.point);
      if (gap > opts.maxGap) continue;

      // 出射方向（端点朝外）
      const o1 = { x: -e1.inward.x, y: -e1.inward.y };
      const o2 = { x: -e2.inward.x, y: -e2.inward.y };
      // 两出射方向相对 → 同一条墙的两段；或呈拐角 → 房间角落
      const outAngle = undirectedAngleDiffDeg(
        angleDeg({ x: 0, y: 0 }, o1),
        angleDeg({ x: 0, y: 0 }, o2),
      );
      const isContinuation = outAngle <= opts.directionTolDeg;
      const isCorner = Math.abs(outAngle - 90) <= opts.directionTolDeg;
      if (!isContinuation && !isCorner) continue;

      pairs.push({ a: e1, b: e2, gap });
    }
  }
  pairs.sort((p, q) => p.gap - q.gap);

  for (const p of pairs) {
    const ka = keyOf(p.a);
    const kb = keyOf(p.b);
    if (used.has(ka) || used.has(kb)) continue;
    used.add(ka);
    used.add(kb);

    const mid: Point = {
      x: (p.a.point.x + p.b.point.x) / 2,
      y: (p.a.point.y + p.b.point.y) / 2,
    };
    setEndpoint(out[p.a.segIndex]!, p.a.which, mid);
    setEndpoint(out[p.b.segIndex]!, p.b.which, mid);
    records.push({
      kind: 'endpointJoin',
      segmentIndices: [p.a.segIndex, p.b.segIndex],
      at: mid,
      gap: p.gap,
    });
  }

  return out;
}

function setEndpoint(s: Segment, which: 0 | 1, p: Point): void {
  if (which === 0) {
    s.a.x = p.x;
    s.a.y = p.y;
  } else {
    s.b.x = p.x;
    s.b.y = p.y;
  }
}

/**
 * 延长求交：悬空端点沿自身方向延长，若能与另一条线段（或其延长线）
 * 在 maxExtend 内相交，则把端点移到交点。
 *
 * 这是修复「房间四角没画到底」的关键 —— 只有角点真正相接，
 * 平面图才能形成闭合面，进而输出为 rect。
 */
function extendToIntersections(
  segs: readonly Segment[],
  opts: BridgeOptions,
  records: BridgeRecord[],
): Segment[] {
  const out = segs.map((s) => ({ a: { ...s.a }, b: { ...s.b } }));

  for (let pass = 0; pass < 2; pass++) {
    const eps = collectEndpoints(out);
    let changed = false;

    for (const ep of eps) {
      if (!isDangling(out, ep, 1.5)) continue;
      const outward = { x: -ep.inward.x, y: -ep.inward.y };
      if (Math.hypot(outward.x, outward.y) < EPS) continue;

      const probeEnd: Point = {
        x: ep.point.x + outward.x * opts.maxExtend,
        y: ep.point.y + outward.y * opts.maxExtend,
      };

      let bestPoint: Point | null = null;
      let bestDist = Infinity;
      let bestIndex = -1;

      for (let i = 0; i < out.length; i++) {
        if (i === ep.segIndex) continue;
        const target = out[i]!;
        // 平行线不求交
        if (
          undirectedAngleDiffDeg(segAngleDeg(out[ep.segIndex]!), segAngleDeg(target)) < 12
        ) {
          continue;
        }
        const hit = segmentIntersection(ep.point, probeEnd, target.a, target.b);
        if (hit === null || hit.collinear) continue;
        const d = dist(ep.point, hit.point);
        if (d < bestDist) {
          bestDist = d;
          bestPoint = hit.point;
          bestIndex = i;
        }
      }

      if (bestPoint !== null && bestDist <= opts.maxExtend && bestDist > 0.5) {
        setEndpoint(out[ep.segIndex]!, ep.which, bestPoint);
        records.push({
          kind: 'extendToIntersect',
          segmentIndices: [ep.segIndex, bestIndex],
          at: bestPoint,
          gap: bestDist,
        });
        changed = true;
      }
    }

    if (!changed) break;
  }

  return out;
}

/** 找出所有仍然悬空的端点。 */
function findDanglingEndpoints(segs: readonly Segment[], tolerance: number): UnresolvedEndpoint[] {
  const out: UnresolvedEndpoint[] = [];
  const eps = collectEndpoints(segs);
  for (const ep of eps) {
    let nearest = Infinity;
    for (let i = 0; i < segs.length; i++) {
      if (i === ep.segIndex) continue;
      const d = pointSegmentDistance(ep.point, segs[i]!.a, segs[i]!.b);
      if (d < nearest) nearest = d;
      if (nearest <= tolerance) break;
    }
    if (nearest > tolerance) {
      out.push({ point: { ...ep.point }, segmentIndex: ep.segIndex, nearestDistance: nearest });
    }
  }
  return out;
}

/** 按长度降序返回最长的 n 条线段（用于「地图边界」判定）。 */
export function longestSegments(segs: readonly Segment[], n: number): number[] {
  return segs
    .map((s, i) => ({ i, l: segLength(s) }))
    .sort((a, b) => b.l - a.l)
    .slice(0, n)
    .map((x) => x.i);
}
