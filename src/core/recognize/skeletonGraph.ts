/**
 * 骨架图构建：把单像素骨架转换为「节点 + 分支折线」的无向图。
 *
 * 节点 = 端点（邻居数 1）或交点（交叉数 ≥3）；
 * 分支 = 两个节点之间的像素折线，或孤立环。
 *
 * 这一步把「像素」抽象为「拓扑结构」，是后续几何拟合与面提取的基础。
 */

import type { BinaryImage } from '../preprocess/IPreprocessor';
import type { Point } from '../../types/vector';
import { crossingNumber, neighborCount } from './thinning';

export interface SkeletonNode {
  id: number;
  x: number;
  y: number;
  /** 端点 / 交点 / 环上任选起点。 */
  kind: 'endpoint' | 'junction' | 'loopSeed';
  /** 相连的分支 id。 */
  branchIds: number[];
}

export interface SkeletonBranch {
  id: number;
  /** 起止节点 id；闭环时两者相同。 */
  startNode: number;
  endNode: number;
  /** 像素折线（含两端节点像素）。 */
  pixels: Point[];
  /** 像素路径长度（对角步长按 √2 计）。 */
  length: number;
  closed: boolean;
}

export interface SkeletonGraph {
  nodes: SkeletonNode[];
  branches: SkeletonBranch[];
  width: number;
  height: number;
}

const DX8 = [0, 1, 1, 1, 0, -1, -1, -1];
const DY8 = [-1, -1, 0, 1, 1, 1, 0, -1];

/** 从骨架图像构建拓扑图。 */
export function buildSkeletonGraph(skeleton: BinaryImage): SkeletonGraph {
  const { width: w, height: h, data } = skeleton;

  /* 1) 分类每个骨架像素 */
  // 0 = 背景, 1 = 通过点, 2 = 端点, 3 = 交点
  //
  // 关键：必须用「交叉数（crossing number）」而非「邻居数」判定交点。
  // 斜线在细化后是阶梯状的，其拐角像素常有 3 个 8 邻居，
  // 若按邻居数判定会被误认为交点 —— 一条斜墙会被切成几十段，
  // 骨架图分支数暴增、平面图无法闭合。
  // 交叉数统计 8 邻域环上 1→0 的转换次数，斜线拐角正确得到 2。
  const kind = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      if (data[off + x]! === 0) continue;
      const nc = neighborCount(skeleton, x, y);
      if (nc === 0) {
        kind[off + x] = 2; // 孤立点视为端点
        continue;
      }
      if (nc === 1) {
        kind[off + x] = 2;
        continue;
      }
      const cn = crossingNumber(skeleton, x, y);
      if (cn <= 1) kind[off + x] = 2;
      else if (cn === 2) kind[off + x] = 1;
      else kind[off + x] = 3;
    }
  }

  /* 2) 建立节点 */
  const nodes: SkeletonNode[] = [];
  const nodeAt = new Int32Array(w * h).fill(-1);
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      const k = kind[off + x]!;
      if (k !== 2 && k !== 3) continue;
      nodeAt[off + x] = nodes.length;
      nodes.push({
        id: nodes.length,
        x,
        y,
        kind: k === 2 ? 'endpoint' : 'junction',
        branchIds: [],
      });
    }
  }

  /* 3) 从每个节点出发追踪分支 */
  const branches: SkeletonBranch[] = [];
  // 记录已消耗的「有向出边」，避免同一分支被两端各追一次
  const visitedEdge = new Set<string>();

  const edgeKey = (px: number, py: number, qx: number, qy: number): string =>
    `${px},${py}>${qx},${qy}`;

  for (const node of nodes) {
    for (let d = 0; d < 8; d++) {
      const nx = node.x + DX8[d]!;
      const ny = node.y + DY8[d]!;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (data[ny * w + nx]! === 0) continue;
      if (visitedEdge.has(edgeKey(node.x, node.y, nx, ny))) continue;

      const branch = traceBranch(skeleton, kind, nodeAt, node, nx, ny, visitedEdge);
      if (branch === null) continue;
      branch.id = branches.length;
      branches.push(branch);
      nodes[branch.startNode]!.branchIds.push(branch.id);
      if (branch.endNode !== branch.startNode) {
        nodes[branch.endNode]!.branchIds.push(branch.id);
      }
    }
  }

  /* 4) 处理孤立闭环（无端点、无交点的环，上面追踪不到） */
  const inBranch = new Uint8Array(w * h);
  for (const b of branches) {
    for (const p of b.pixels) inBranch[p.y * w + p.x] = 1;
  }
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      if (data[off + x]! === 0 || inBranch[off + x]! === 1) continue;
      if (kind[off + x]! !== 1) continue;
      const loop = traceLoop(skeleton, x, y, inBranch);
      if (loop === null || loop.length < 4) continue;
      const seed: SkeletonNode = {
        id: nodes.length,
        x,
        y,
        kind: 'loopSeed',
        branchIds: [],
      };
      nodes.push(seed);
      const branch: SkeletonBranch = {
        id: branches.length,
        startNode: seed.id,
        endNode: seed.id,
        pixels: loop,
        length: pathLength(loop, true),
        closed: true,
      };
      seed.branchIds.push(branch.id);
      branches.push(branch);
    }
  }

  return { nodes, branches, width: w, height: h };
}

/** 沿骨架从 node 经首步 (fx,fy) 追踪到下一个节点。 */
function traceBranch(
  skeleton: BinaryImage,
  kind: Uint8Array,
  nodeAt: Int32Array,
  startNode: SkeletonNode,
  fx: number,
  fy: number,
  visitedEdge: Set<string>,
): SkeletonBranch | null {
  const { width: w, height: h, data } = skeleton;
  const pixels: Point[] = [{ x: startNode.x, y: startNode.y }];

  let prevX = startNode.x;
  let prevY = startNode.y;
  let curX = fx;
  let curY = fy;
  visitedEdge.add(`${prevX},${prevY}>${curX},${curY}`);
  pixels.push({ x: curX, y: curY });

  const guard = w * h;
  let steps = 0;

  while (steps++ < guard) {
    // 到达节点则结束
    const curIdx = curY * w + curX;
    if (nodeAt[curIdx]! >= 0) {
      visitedEdge.add(`${curX},${curY}>${prevX},${prevY}`);
      const endId = nodeAt[curIdx]!;
      return {
        id: -1,
        startNode: startNode.id,
        endNode: endId,
        pixels,
        length: pathLength(pixels, false),
        closed: endId === startNode.id && pixels.length > 3,
      };
    }

    // 通过点：走向「真正前进」的邻居。
    // 阶梯状斜线的拐角像素可能有 2 个非来路邻居，其中一个与来路 8 相邻
    // （即那是同一步的冗余像素，走过去会原地打转甚至回头）。
    // 因此优先选择与来路不相邻的候选。
    let nextX = -1;
    let nextY = -1;
    let fallbackX = -1;
    let fallbackY = -1;
    for (let d = 0; d < 8; d++) {
      const nx = curX + DX8[d]!;
      const ny = curY + DY8[d]!;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (data[ny * w + nx]! === 0) continue;
      if (nx === prevX && ny === prevY) continue;
      const adjacentToPrev = Math.abs(nx - prevX) <= 1 && Math.abs(ny - prevY) <= 1;
      if (adjacentToPrev) {
        if (fallbackX < 0) {
          fallbackX = nx;
          fallbackY = ny;
        }
        continue;
      }
      nextX = nx;
      nextY = ny;
      break;
    }
    if (nextX < 0) {
      nextX = fallbackX;
      nextY = fallbackY;
    }
    if (nextX < 0) {
      // 走到尽头却不是登记节点（可能因边界裁剪），作为悬空端点收尾
      visitedEdge.add(`${curX},${curY}>${prevX},${prevY}`);
      return {
        id: -1,
        startNode: startNode.id,
        endNode: startNode.id,
        pixels,
        length: pathLength(pixels, false),
        closed: false,
      };
    }

    visitedEdge.add(`${curX},${curY}>${nextX},${nextY}`);
    visitedEdge.add(`${nextX},${nextY}>${curX},${curY}`);
    prevX = curX;
    prevY = curY;
    curX = nextX;
    curY = nextY;
    pixels.push({ x: curX, y: curY });
  }
  return null;
}

/** 追踪孤立闭环。 */
function traceLoop(skeleton: BinaryImage, sx: number, sy: number, mark: Uint8Array): Point[] | null {
  const { width: w, height: h, data } = skeleton;
  const pixels: Point[] = [{ x: sx, y: sy }];
  mark[sy * w + sx] = 1;

  let prevX = -1;
  let prevY = -1;
  let curX = sx;
  let curY = sy;
  const guard = w * h;
  let steps = 0;

  while (steps++ < guard) {
    let nextX = -1;
    let nextY = -1;
    let fallbackX = -1;
    let fallbackY = -1;
    for (let d = 0; d < 8; d++) {
      const nx = curX + DX8[d]!;
      const ny = curY + DY8[d]!;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (data[ny * w + nx]! === 0) continue;
      if (nx === prevX && ny === prevY) continue;
      if (nx === sx && ny === sy && pixels.length > 2) {
        return pixels; // 闭合
      }
      if (mark[ny * w + nx]! === 1) continue;
      // 与来路 8 相邻的候选是同一步的冗余像素，优先跳过（见 traceBranch 注释）
      if (prevX >= 0 && Math.abs(nx - prevX) <= 1 && Math.abs(ny - prevY) <= 1) {
        if (fallbackX < 0) {
          fallbackX = nx;
          fallbackY = ny;
        }
        continue;
      }
      nextX = nx;
      nextY = ny;
      break;
    }
    if (nextX < 0) {
      nextX = fallbackX;
      nextY = fallbackY;
    }
    if (nextX < 0) return pixels.length > 3 ? pixels : null;
    mark[nextY * w + nextX] = 1;
    prevX = curX;
    prevY = curY;
    curX = nextX;
    curY = nextY;
    pixels.push({ x: curX, y: curY });
  }
  return null;
}

function pathLength(pixels: readonly Point[], closed: boolean): number {
  let total = 0;
  for (let i = 1; i < pixels.length; i++) {
    const a = pixels[i - 1]!;
    const b = pixels[i]!;
    total += a.x !== b.x && a.y !== b.y ? Math.SQRT2 : 1;
  }
  if (closed && pixels.length > 2) {
    const a = pixels[pixels.length - 1]!;
    const b = pixels[0]!;
    total += a.x !== b.x && a.y !== b.y ? Math.SQRT2 : 1;
  }
  return total;
}

/**
 * 剪除短毛刺分支：一端为端点、长度小于阈值、另一端为交点。
 * 手绘线的起笔 / 收笔常带小钩，细化后成为几像素的分叉。
 */
export function pruneSpurs(graph: SkeletonGraph, minLength: number): SkeletonGraph {
  const removed = new Set<number>();
  for (const b of graph.branches) {
    if (b.closed) continue;
    if (b.length >= minLength) continue;
    const s = graph.nodes[b.startNode]!;
    const e = graph.nodes[b.endNode]!;
    const endpointCount = (s.kind === 'endpoint' ? 1 : 0) + (e.kind === 'endpoint' ? 1 : 0);
    const junctionCount = (s.kind === 'junction' ? 1 : 0) + (e.kind === 'junction' ? 1 : 0);
    // 悬空毛刺：一端端点 + 一端交点
    if (endpointCount === 1 && junctionCount === 1) removed.add(b.id);
  }
  if (removed.size === 0) return graph;

  const branches = graph.branches.filter((b) => !removed.has(b.id));
  const nodes = graph.nodes.map((n) => ({
    ...n,
    branchIds: n.branchIds.filter((id) => !removed.has(id)),
  }));
  return { ...graph, branches, nodes };
}

/** 统计图的规模，供 stats 与「无有效结构」判定使用。 */
export function graphStats(graph: SkeletonGraph): {
  nodeCount: number;
  branchCount: number;
  totalLength: number;
  endpointCount: number;
  junctionCount: number;
} {
  let totalLength = 0;
  for (const b of graph.branches) totalLength += b.length;
  let endpointCount = 0;
  let junctionCount = 0;
  for (const n of graph.nodes) {
    if (n.kind === 'endpoint') endpointCount++;
    else if (n.kind === 'junction') junctionCount++;
  }
  return {
    nodeCount: graph.nodes.length,
    branchCount: graph.branches.length,
    totalLength,
    endpointCount,
    junctionCount,
  };
}
