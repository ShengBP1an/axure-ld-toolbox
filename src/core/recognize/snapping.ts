/**
 * 吸附：角度吸附 + 端点聚簇。
 *
 * 目的（对应最低验收标准 4）：
 *   - 手绘的「近水平」墙线（偏 2~5°）应被拉正为严格水平，否则导出后
 *     在 Axure 中无法与其它对象对齐；
 *   - 相邻墙线的端点应精确共享同一坐标，否则平面图无法闭合成面，
 *     方正房间就会退化为高节点自由路径。
 *
 * 顺序很重要：先角度吸附（改变线的方向），再端点聚簇（统一交汇点），
 * 最后把线段端点重投影回吸附后的直线上，保证「既共享端点又保持角度」。
 */

import type { Point } from '../../types/vector';
import type { Segment } from '../geometry/lineFit';
import { segAngleDeg, segLength } from '../geometry/lineFit';
import {
  angleDeg,
  dist,
  EPS,
  midpoint,
  toRad,
  undirectedAngleDiffDeg,
} from '../geometry/vec';

export interface SnapOptions {
  /** 参与吸附的候选角（度，无向，取 [0,180)）。 */
  angleSteps: number[];
  /** 角度容差（度）：偏差在此范围内才吸附。 */
  angleTolDeg: number;
  /** 端点聚簇半径（像素）。 */
  clusterRadius: number;
  /** 长度低于此值的段不做角度吸附（短段角度不可靠）。 */
  minLengthForAngleSnap: number;
  /** 是否启用角度吸附。 */
  enableAngle: boolean;
  /** 是否启用端点聚簇。 */
  enableCluster: boolean;
}

export const DEFAULT_SNAP_OPTIONS: SnapOptions = {
  // 0 / 90 为主，45 / 135 次之，30 / 60 / 120 / 150 用于斜向通道
  angleSteps: [0, 30, 45, 60, 90, 120, 135, 150],
  angleTolDeg: 7,
  clusterRadius: 6,
  minLengthForAngleSnap: 8,
  enableAngle: true,
  enableCluster: true,
};

export interface SnapRecord {
  segmentIndex: number;
  /** 吸附前后的角度（度）。 */
  fromAngle: number;
  toAngle: number;
  /** 端点被移动的最大距离（像素），用于置信度惩罚。 */
  displacement: number;
}

export interface SnapResult {
  segments: Segment[];
  records: SnapRecord[];
  /** 端点聚簇产生的簇心，供后续平面图顶点去重复用。 */
  clusters: Point[];
  /** 每个线段端点归属的簇索引，[a, b] 顺序；-1 表示未聚簇。 */
  endpointClusters: Array<[number, number]>;
}

/**
 * 角度吸附：绕线段中点旋转到最近的候选角。
 * 绕中点而非端点旋转，可让两端位移量最小、更贴近原始笔迹。
 */
export function snapAngles(
  segments: readonly Segment[],
  opts: SnapOptions,
): { segments: Segment[]; records: SnapRecord[] } {
  const out: Segment[] = [];
  const records: SnapRecord[] = [];

  segments.forEach((s, i) => {
    const l = segLength(s);
    if (!opts.enableAngle || l < opts.minLengthForAngleSnap) {
      out.push({ a: { ...s.a }, b: { ...s.b } });
      return;
    }

    const current = segAngleDeg(s);
    let bestStep = -1;
    let bestDiff = Infinity;
    for (const step of opts.angleSteps) {
      const d = undirectedAngleDiffDeg(current, step);
      if (d < bestDiff) {
        bestDiff = d;
        bestStep = step;
      }
    }

    if (bestStep < 0 || bestDiff > opts.angleTolDeg) {
      out.push({ a: { ...s.a }, b: { ...s.b } });
      return;
    }

    // 保持有向方向：若原方向在 [180,360)，目标角需 +180
    const directed = angleDeg(s.a, s.b);
    const target = undirectedAngleDiffDeg(directed, bestStep) === bestDiff && Math.abs(((directed % 180) + 180) % 180 - bestStep) < 90
      ? bestStep
      : bestStep;
    const useAngle = directed >= 180 ? target + 180 : target;

    const c = midpoint(s.a, s.b);
    const half = l / 2;
    const rad = toRad(useAngle);
    const dx = Math.cos(rad) * half;
    const dy = Math.sin(rad) * half;
    const na = { x: c.x - dx, y: c.y - dy };
    const nb = { x: c.x + dx, y: c.y + dy };

    const displacement = Math.max(dist(s.a, na), dist(s.b, nb));
    out.push({ a: na, b: nb });
    records.push({ segmentIndex: i, fromAngle: current, toAngle: bestStep, displacement });
  });

  return { segments: out, records };
}

/** 并查集，用于端点聚簇。 */
class UnionFind {
  private parent: Int32Array;

  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root]! !== root) root = this.parent[root]!;
    let cur = x;
    while (this.parent[cur]! !== root) {
      const next = this.parent[cur]!;
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

/**
 * 端点聚簇：把距离小于 radius 的端点合并到同一坐标（簇心）。
 * 使用均匀网格加速邻近查询，避免 O(n²)。
 */
export function clusterEndpoints(
  segments: readonly Segment[],
  radius: number,
): { segments: Segment[]; clusters: Point[]; endpointClusters: Array<[number, number]> } {
  const n = segments.length;
  if (n === 0) return { segments: [], clusters: [], endpointClusters: [] };

  // 收集所有端点：索引 2i = 段 i 的 a，2i+1 = 段 i 的 b
  const pts: Point[] = [];
  for (const s of segments) {
    pts.push({ ...s.a }, { ...s.b });
  }

  const uf = new UnionFind(pts.length);
  const cell = Math.max(1, radius);
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number): string => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;

  pts.forEach((p, i) => {
    const k = key(p.x, p.y);
    const arr = grid.get(k);
    if (arr) arr.push(i);
    else grid.set(k, [i]);
  });

  const r2 = radius * radius;
  pts.forEach((p, i) => {
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = grid.get(`${cx + dx},${cy + dy}`);
        if (!arr) continue;
        for (const j of arr) {
          if (j <= i) continue;
          const q = pts[j]!;
          const ddx = p.x - q.x;
          const ddy = p.y - q.y;
          if (ddx * ddx + ddy * ddy <= r2) uf.union(i, j);
        }
      }
    }
  });

  // 计算簇心（成员均值）
  const rootToCluster = new Map<number, number>();
  const sums: Array<{ x: number; y: number; n: number }> = [];
  const memberCluster = new Int32Array(pts.length).fill(-1);

  pts.forEach((p, i) => {
    const root = uf.find(i);
    let ci = rootToCluster.get(root);
    if (ci === undefined) {
      ci = sums.length;
      rootToCluster.set(root, ci);
      sums.push({ x: 0, y: 0, n: 0 });
    }
    const acc = sums[ci]!;
    acc.x += p.x;
    acc.y += p.y;
    acc.n++;
    memberCluster[i] = ci;
  });

  const clusters: Point[] = sums.map((s) => ({ x: s.x / s.n, y: s.y / s.n }));

  const outSegments: Segment[] = [];
  const endpointClusters: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const ca = memberCluster[i * 2]!;
    const cb = memberCluster[i * 2 + 1]!;
    outSegments.push({
      a: { ...clusters[ca]! },
      b: { ...clusters[cb]! },
    });
    endpointClusters.push([ca, cb]);
  }

  return { segments: outSegments, clusters, endpointClusters };
}

/**
 * 完整吸附流程。
 *
 * 第三步「重投影」的作用：端点聚簇后线段角度会被轻微破坏，
 * 此处把每条线段重新按「聚簇后端点连线」与「吸附目标角」折中，
 * 优先保证端点共享（拓扑正确），角度偏差限制在容差内。
 */
export function applySnapping(segments: readonly Segment[], opts: SnapOptions): SnapResult {
  const angleSnapped = opts.enableAngle
    ? snapAngles(segments, opts)
    : { segments: segments.map((s) => ({ a: { ...s.a }, b: { ...s.b } })), records: [] as SnapRecord[] };

  if (!opts.enableCluster || opts.clusterRadius <= 0) {
    return {
      segments: angleSnapped.segments,
      records: angleSnapped.records,
      clusters: [],
      endpointClusters: [],
    };
  }

  const clustered = clusterEndpoints(angleSnapped.segments, opts.clusterRadius);

  // 重投影：对轴对齐目标做一次「硬对齐」，让共享顶点严格共线
  const aligned = alignAxisAligned(clustered.segments, clustered.clusters, clustered.endpointClusters, opts);

  // 剔除退化线段：两端落入同一簇时长度归零，若保留会在平面图中
  // 生成自环半边并干扰面遍历
  const keep: number[] = [];
  aligned.forEach((s, i) => {
    if (segLength(s) > opts.clusterRadius * 0.25 + EPS) keep.push(i);
  });

  return {
    segments: keep.map((i) => aligned[i]!),
    records: angleSnapped.records,
    clusters: clustered.clusters,
    endpointClusters: keep.map((i) => clustered.endpointClusters[i]!),
  };
}

/**
 * 轴对齐硬对齐：把近水平线的两端 y 统一、近垂直线的两端 x 统一。
 *
 * 这一步是「方正房间输出为 rect」的决定性环节：
 * 只有当上下墙严格水平、左右墙严格垂直时，
 * 提取出的面才会是标准矩形，而非 4 个顶点略有偏移的多边形。
 *
 * 采用「簇坐标全局对齐」：把所有簇心按 x / y 分别聚类，
 * 同一坐标带内的簇统一取平均值，从而让多个房间共享同一条墙线。
 */
function alignAxisAligned(
  segments: readonly Segment[],
  clusters: readonly Point[],
  endpointClusters: ReadonlyArray<[number, number]>,
  opts: SnapOptions,
): Segment[] {
  if (clusters.length === 0) return segments.map((s) => ({ a: { ...s.a }, b: { ...s.b } }));

  // 收集需要对齐的约束：近水平段要求两端 y 相同，近垂直段要求两端 x 相同
  const yGroups = new UnionFind(clusters.length);
  const xGroups = new UnionFind(clusters.length);

  segments.forEach((s, i) => {
    const l = segLength(s);
    if (l < opts.minLengthForAngleSnap) return;
    const ang = segAngleDeg(s);
    const [ca, cb] = endpointClusters[i]!;
    if (ca < 0 || cb < 0) return;
    if (undirectedAngleDiffDeg(ang, 0) <= opts.angleTolDeg) yGroups.union(ca, cb);
    if (undirectedAngleDiffDeg(ang, 90) <= opts.angleTolDeg) xGroups.union(ca, cb);
  });

  const alignedY = averageByGroup(clusters, yGroups, 'y');
  const alignedX = averageByGroup(clusters, xGroups, 'x');

  const finalClusters: Point[] = clusters.map((c, i) => ({
    x: alignedX[i] ?? c.x,
    y: alignedY[i] ?? c.y,
  }));

  return segments.map((s, i) => {
    const [ca, cb] = endpointClusters[i]!;
    if (ca < 0 || cb < 0) return { a: { ...s.a }, b: { ...s.b } };
    return { a: { ...finalClusters[ca]! }, b: { ...finalClusters[cb]! } };
  });
}

function averageByGroup(
  clusters: readonly Point[],
  uf: UnionFind,
  axis: 'x' | 'y',
): Array<number | undefined> {
  const sums = new Map<number, { sum: number; n: number }>();
  clusters.forEach((c, i) => {
    const root = uf.find(i);
    const acc = sums.get(root);
    const v = axis === 'x' ? c.x : c.y;
    if (acc) {
      acc.sum += v;
      acc.n++;
    } else {
      sums.set(root, { sum: v, n: 1 });
    }
  });
  return clusters.map((_, i) => {
    const acc = sums.get(uf.find(i));
    // 单元素组不做改动，避免把孤立点误拉
    if (!acc || acc.n < 2) return undefined;
    return acc.sum / acc.n;
  });
}

/**
 * 全局坐标带对齐：把彼此相距很近的 x（或 y）坐标统一。
 * 用于跨房间共享墙线的场景 —— 两个相邻房间的分隔墙如果 x 相差 1px，
 * 平面图会生成一条极窄的假面。
 */
export function snapCoordinateBands(
  segments: readonly Segment[],
  tolerance: number,
): Segment[] {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of segments) {
    xs.push(s.a.x, s.b.x);
    ys.push(s.a.y, s.b.y);
  }
  const xMap = buildBandMap(xs, tolerance);
  const yMap = buildBandMap(ys, tolerance);

  return segments.map((s) => ({
    a: { x: xMap(s.a.x), y: yMap(s.a.y) },
    b: { x: xMap(s.b.x), y: yMap(s.b.y) },
  }));
}

/** 一维坐标聚类：排序后按间隙切分，同带取均值。 */
function buildBandMap(values: readonly number[], tolerance: number): (v: number) => number {
  if (values.length === 0) return (v) => v;
  const sorted = [...values].sort((a, b) => a - b);
  const bands: Array<{ lo: number; hi: number; mean: number }> = [];
  let start = 0;
  for (let i = 1; i <= sorted.length; i++) {
    const brk = i === sorted.length || sorted[i]! - sorted[i - 1]! > tolerance;
    if (!brk) continue;
    let sum = 0;
    for (let k = start; k < i; k++) sum += sorted[k]!;
    bands.push({ lo: sorted[start]!, hi: sorted[i - 1]!, mean: sum / (i - start) });
    start = i;
  }

  return (v: number): number => {
    // 二分查找所属带
    let lo = 0;
    let hi = bands.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const b = bands[mid]!;
      if (v < b.lo - EPS) hi = mid - 1;
      else if (v > b.hi + EPS) lo = mid + 1;
      else return b.mean;
    }
    return v;
  };
}
