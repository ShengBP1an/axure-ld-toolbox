/**
 * 平面图半边遍历 —— 封闭区域提取的核心。
 *
 * 为什么不用轮廓追踪（contour tracing）：
 *   手绘地图中相邻房间大量共享墙线。对二值图做轮廓追踪时，
 *   两个共享一面墙的房间属于同一个连通块，会被追成「一个外轮廓 + 两个内孔」，
 *   无法得到两个独立矩形 —— 直接违反最低验收标准 1 与 6。
 *
 * 本模块的做法：
 *   1. 把线段集合构建成平面直线图（PSLG）：顶点去重 + 在所有交点处分裂边；
 *   2. 对每个顶点，按极角排序其出边；
 *   3. 沿「进入某半边后，取下一条顺时针方向的出边」规则遍历，
 *      每条闭合回路即为平面图的一个面；
 *   4. 有向面积为负（y 向下坐标系中逆时针）的面是无界外部面，丢弃；
 *      其余为内部面，即封闭区域；
 *   5. 完全被另一个面包含的面记为孔洞。
 *
 * 复杂度：交点求解 O(E²)（E 通常 < 800，实测可接受，且已用包围盒剪枝），
 *        半边遍历 O(E log E)。
 */

import type { Bounds, Point } from '../../types/vector';
import type { Segment } from '../geometry/lineFit';
import { segmentIntersection } from '../geometry/intersect';
import { area, bounds, pointInPolygon, signedArea } from '../geometry/polygon';
import { dist, EPS } from '../geometry/vec';

export interface PlanarVertex {
  id: number;
  x: number;
  y: number;
  /** 出边（半边）id 列表，按极角升序。 */
  outHalfEdges: number[];
}

export interface PlanarHalfEdge {
  id: number;
  from: number;
  to: number;
  /** 反向半边 id。 */
  twin: number;
  /** 极角（弧度，(-PI, PI]）。 */
  angle: number;
  /** 所属面索引，-1 表示未分配。 */
  face: number;
}

export interface PlanarFace {
  id: number;
  /** 顶点序列（不重复首点）。 */
  points: Point[];
  /** 顶点在图中的 id。 */
  vertexIds: number[];
  /** 有向面积；y 向下坐标系中，正值为顺时针（内部面）。 */
  signedArea: number;
  area: number;
  bounds: Bounds;
  /** 若为孔洞，指向宿主面索引。 */
  holeOf: number | null;
  /** 参与构成该面的原始线段索引集合。 */
  sourceSegments: number[];
}

export interface PlanarGraph {
  vertices: PlanarVertex[];
  halfEdges: PlanarHalfEdge[];
  faces: PlanarFace[];
  /** 未参与任何面的边（对应开放墙线 / 悬空线）。 */
  danglingEdgeIds: number[];
}

export interface PlanarOptions {
  /** 顶点去重容差（像素）。 */
  vertexTolerance: number;
  /** 面积小于此值的面视为噪声，丢弃（像素²）。 */
  minFaceArea: number;
  /** 单个面的最大顶点数保护（防止病态输入）。 */
  maxFaceVertices: number;
}

export const DEFAULT_PLANAR: PlanarOptions = {
  vertexTolerance: 2.0,
  minFaceArea: 120,
  maxFaceVertices: 4096,
};

/** 主入口：从线段集合构建平面图并提取面。 */
export function buildPlanarGraph(segments: readonly Segment[], opts: PlanarOptions): PlanarGraph {
  /* 1) 在所有交点处分裂线段 */
  const split = splitAtIntersections(segments, opts.vertexTolerance);

  /* 2) 顶点去重，建立边表 */
  const { vertices, edges } = buildVertexEdgeTable(split, opts.vertexTolerance);

  /* 3) 建立半边并按极角排序 */
  const halfEdges = buildHalfEdges(vertices, edges);

  /* 4) 遍历面 */
  const faces = traceFaces(vertices, halfEdges, opts);

  /* 5) 孔洞判定 */
  assignHoles(faces);

  const danglingEdgeIds = halfEdges.filter((he) => he.face < 0).map((he) => he.id);

  return { vertices, halfEdges, faces, danglingEdgeIds };
}

interface SplitSegment {
  a: Point;
  b: Point;
  /** 原始线段索引。 */
  source: number;
}

/**
 * 在所有交点处分裂线段。
 * 用包围盒剪枝（先按 minX 排序）把实际比较次数降到接近线性。
 */
function splitAtIntersections(segments: readonly Segment[], tol: number): SplitSegment[] {
  const n = segments.length;
  // 每条线段上的切割参数 t 集合
  const cuts: number[][] = Array.from({ length: n }, () => [0, 1]);

  const boxes = segments.map((s) => ({
    minX: Math.min(s.a.x, s.b.x) - tol,
    maxX: Math.max(s.a.x, s.b.x) + tol,
    minY: Math.min(s.a.y, s.b.y) - tol,
    maxY: Math.max(s.a.y, s.b.y) + tol,
  }));

  const order = segments.map((_, i) => i).sort((i, j) => boxes[i]!.minX - boxes[j]!.minX);

  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi]!;
    const bi = boxes[i]!;
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj]!;
      const bj = boxes[j]!;
      if (bj.minX > bi.maxX) break; // 扫描线剪枝
      if (bj.minY > bi.maxY || bi.minY > bj.maxY) continue;

      const s1 = segments[i]!;
      const s2 = segments[j]!;
      const hit = segmentIntersection(s1.a, s1.b, s2.a, s2.b, 1e-9);
      if (hit === null || hit.collinear) continue;

      // 只有真正落在线段内部（非端点）的交点才需要切割
      const l1 = dist(s1.a, s1.b);
      const l2 = dist(s2.a, s2.b);
      if (l1 > EPS && hit.t * l1 > tol && (1 - hit.t) * l1 > tol) cuts[i]!.push(hit.t);
      if (l2 > EPS && hit.u * l2 > tol && (1 - hit.u) * l2 > tol) cuts[j]!.push(hit.u);
    }
  }

  const out: SplitSegment[] = [];
  for (let i = 0; i < n; i++) {
    const s = segments[i]!;
    const ts = [...new Set(cuts[i]!)].sort((a, b) => a - b);
    for (let k = 0; k < ts.length - 1; k++) {
      const t0 = ts[k]!;
      const t1 = ts[k + 1]!;
      const a: Point = { x: s.a.x + (s.b.x - s.a.x) * t0, y: s.a.y + (s.b.y - s.a.y) * t0 };
      const b: Point = { x: s.a.x + (s.b.x - s.a.x) * t1, y: s.a.y + (s.b.y - s.a.y) * t1 };
      if (dist(a, b) > tol * 0.5) out.push({ a, b, source: i });
    }
  }
  return out;
}

interface EdgeRecord {
  from: number;
  to: number;
  source: number;
}

/** 顶点去重（网格哈希）+ 去掉重复边。 */
function buildVertexEdgeTable(
  segments: readonly SplitSegment[],
  tol: number,
): { vertices: PlanarVertex[]; edges: EdgeRecord[] } {
  const vertices: PlanarVertex[] = [];
  const cell = Math.max(tol * 2, 1);
  const grid = new Map<string, number[]>();
  const tol2 = tol * tol;

  const findOrAdd = (p: Point): number => {
    const cx = Math.floor(p.x / cell);
    const cy = Math.floor(p.y / cell);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = grid.get(`${cx + dx},${cy + dy}`);
        if (!arr) continue;
        for (const vi of arr) {
          const v = vertices[vi]!;
          const ddx = v.x - p.x;
          const ddy = v.y - p.y;
          if (ddx * ddx + ddy * ddy <= tol2) return vi;
        }
      }
    }
    const id = vertices.length;
    vertices.push({ id, x: p.x, y: p.y, outHalfEdges: [] });
    const key = `${cx},${cy}`;
    const arr = grid.get(key);
    if (arr) arr.push(id);
    else grid.set(key, [id]);
    return id;
  };

  const seen = new Set<string>();
  const edges: EdgeRecord[] = [];
  for (const s of segments) {
    const from = findOrAdd(s.a);
    const to = findOrAdd(s.b);
    if (from === to) continue;
    const key = from < to ? `${from}-${to}` : `${to}-${from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to, source: s.source });
  }
  return { vertices, edges };
}

/** 为每条无向边建立一对半边，并按极角排序各顶点的出边。 */
function buildHalfEdges(vertices: PlanarVertex[], edges: readonly EdgeRecord[]): PlanarHalfEdge[] {
  const halfEdges: PlanarHalfEdge[] = [];

  for (const e of edges) {
    const vf = vertices[e.from]!;
    const vt = vertices[e.to]!;
    const id1 = halfEdges.length;
    const id2 = id1 + 1;
    halfEdges.push({
      id: id1,
      from: e.from,
      to: e.to,
      twin: id2,
      angle: Math.atan2(vt.y - vf.y, vt.x - vf.x),
      face: -1,
    });
    halfEdges.push({
      id: id2,
      from: e.to,
      to: e.from,
      twin: id1,
      angle: Math.atan2(vf.y - vt.y, vf.x - vt.x),
      face: -1,
    });
    vf.outHalfEdges.push(id1);
    vt.outHalfEdges.push(id2);
  }

  for (const v of vertices) {
    v.outHalfEdges.sort((a, b) => halfEdges[a]!.angle - halfEdges[b]!.angle);
  }
  return halfEdges;
}

/**
 * 面遍历。
 *
 * 规则：进入半边 he（从 u 到 v）后，在 v 处取「he 的孪生边在 v 的出边环上的前一条」，
 * 即相对来路顺时针方向的下一条边。反复执行直到回到起点，得到一个面。
 * 这是标准的平面图面遍历（next = twin.prev in rotation order）。
 */
function traceFaces(
  vertices: readonly PlanarVertex[],
  halfEdges: PlanarHalfEdge[],
  opts: PlanarOptions,
): PlanarFace[] {
  const faces: PlanarFace[] = [];

  // 预建：每个半边在其起点出边环中的位置
  const posInRing = new Int32Array(halfEdges.length).fill(-1);
  for (const v of vertices) {
    v.outHalfEdges.forEach((heId, idx) => {
      posInRing[heId] = idx;
    });
  }

  const nextHalfEdge = (heId: number): number => {
    const he = halfEdges[heId]!;
    const v = vertices[he.to]!;
    const twinId = he.twin;
    const idx = posInRing[twinId]!;
    if (idx < 0 || v.outHalfEdges.length === 0) return -1;
    // 取环上前一条（顺时针方向）
    const prevIdx = (idx - 1 + v.outHalfEdges.length) % v.outHalfEdges.length;
    return v.outHalfEdges[prevIdx]!;
  };

  for (let start = 0; start < halfEdges.length; start++) {
    if (halfEdges[start]!.face >= 0) continue;

    const cycle: number[] = [];
    let cur = start;
    let guard = 0;
    let broken = false;

    while (guard++ < opts.maxFaceVertices) {
      if (halfEdges[cur]!.face >= 0) {
        broken = true;
        break;
      }
      cycle.push(cur);
      halfEdges[cur]!.face = -2; // 临时占位，防止本轮重入
      const nxt = nextHalfEdge(cur);
      if (nxt < 0) {
        broken = true;
        break;
      }
      if (nxt === start) break;
      cur = nxt;
    }

    if (broken || cycle.length < 3) {
      for (const id of cycle) halfEdges[id]!.face = -1;
      continue;
    }

    const vertexIds = cycle.map((id) => halfEdges[id]!.from);
    const points = vertexIds.map((vid) => ({ x: vertices[vid]!.x, y: vertices[vid]!.y }));
    const sa = signedArea(points);

    // y 向下坐标系：signedArea > 0 为顺时针 = 内部有界面
    // signedArea < 0 为逆时针 = 无界外部面（整张图的外框），丢弃
    if (sa <= 0) {
      for (const id of cycle) halfEdges[id]!.face = -3; // 标记为外部面，不再重入
      continue;
    }

    const a = Math.abs(sa);
    if (a < opts.minFaceArea) {
      for (const id of cycle) halfEdges[id]!.face = -4; // 面积过小，丢弃但不重入
      continue;
    }

    const faceId = faces.length;
    for (const id of cycle) halfEdges[id]!.face = faceId;

    faces.push({
      id: faceId,
      points,
      vertexIds,
      signedArea: sa,
      area: a,
      bounds: bounds(points),
      holeOf: null,
      sourceSegments: [],
    });
  }

  // 清理临时标记：负值统一归为 -1（未分配到有效面）
  for (const he of halfEdges) {
    if (he.face < 0) he.face = -1;
  }

  return faces;
}

/**
 * 孔洞判定：若面 A 被面 B 完全包含，则 A 是 B 的孔洞。
 * 按面积降序处理，找「最小的包含者」作为直接宿主。
 */
function assignHoles(faces: PlanarFace[]): void {
  const order = faces.map((f) => f.id).sort((a, b) => faces[b]!.area - faces[a]!.area);

  for (const inner of order) {
    const fi = faces[inner]!;
    let hostId: number | null = null;
    let hostArea = Infinity;

    for (const outer of order) {
      if (outer === inner) continue;
      const fo = faces[outer]!;
      if (fo.area <= fi.area) continue;
      if (!containsBounds(fo.bounds, fi.bounds)) continue;
      // 用内面质心与全部顶点做包含判定
      if (!allPointsInside(fi.points, fo.points)) continue;
      if (fo.area < hostArea) {
        hostArea = fo.area;
        hostId = outer;
      }
    }
    fi.holeOf = hostId;
  }
}

function containsBounds(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.minX <= inner.minX + 0.5 &&
    outer.minY <= inner.minY + 0.5 &&
    outer.maxX >= inner.maxX - 0.5 &&
    outer.maxY >= inner.maxY - 0.5
  );
}

function allPointsInside(inner: readonly Point[], outer: readonly Point[]): boolean {
  for (const p of inner) {
    if (!pointInPolygon(p, outer)) return false;
  }
  return true;
}

/**
 * 找出「未被任何面使用」的边，它们对应开放的墙线 / 分隔线。
 * 这些边需要单独输出为 line / polyline，不能丢弃。
 */
export function extractOpenPolylines(graph: PlanarGraph): Point[][] {
  const { halfEdges, vertices } = graph;
  // 收集未分配面的无向边（每对半边只取一次）
  const used = new Set<number>();
  const adjacency = new Map<number, number[]>();

  for (const he of halfEdges) {
    if (he.face >= 0) continue;
    const twin = halfEdges[he.twin]!;
    if (twin.face >= 0) continue;
    const key = Math.min(he.id, he.twin);
    if (used.has(key)) continue;
    used.add(key);

    const push = (a: number, b: number): void => {
      const arr = adjacency.get(a);
      if (arr) arr.push(b);
      else adjacency.set(a, [b]);
    };
    push(he.from, he.to);
    push(he.to, he.from);
  }

  if (adjacency.size === 0) return [];

  // 沿度为 1 或 ≥3 的顶点切分链
  const visitedEdge = new Set<string>();
  const ekey = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const out: Point[][] = [];

  const startNodes = [...adjacency.keys()].filter((v) => (adjacency.get(v)?.length ?? 0) !== 2);
  const seeds = startNodes.length > 0 ? startNodes : [...adjacency.keys()];

  for (const seed of seeds) {
    for (const first of adjacency.get(seed) ?? []) {
      if (visitedEdge.has(ekey(seed, first))) continue;
      const chain: number[] = [seed];
      let prev = seed;
      let cur = first;
      visitedEdge.add(ekey(prev, cur));
      chain.push(cur);

      let guard = 0;
      while (guard++ < 10000) {
        const neighbors = adjacency.get(cur) ?? [];
        if (neighbors.length !== 2) break;
        const nxt = neighbors[0] === prev ? neighbors[1]! : neighbors[0]!;
        if (visitedEdge.has(ekey(cur, nxt))) break;
        visitedEdge.add(ekey(cur, nxt));
        chain.push(nxt);
        prev = cur;
        cur = nxt;
      }

      if (chain.length >= 2) {
        out.push(chain.map((vid) => ({ x: vertices[vid]!.x, y: vertices[vid]!.y })));
      }
    }
  }
  return out;
}

/** 统计信息，供 stats 与降级判断使用。 */
export function planarStats(graph: PlanarGraph): {
  vertexCount: number;
  edgeCount: number;
  faceCount: number;
  holeCount: number;
  totalFaceArea: number;
} {
  let holeCount = 0;
  let totalFaceArea = 0;
  for (const f of graph.faces) {
    if (f.holeOf !== null) holeCount++;
    totalFaceArea += f.area;
  }
  return {
    vertexCount: graph.vertices.length,
    edgeCount: graph.halfEdges.length / 2,
    faceCount: graph.faces.length,
    holeCount,
    totalFaceArea,
  };
}

export { area };
