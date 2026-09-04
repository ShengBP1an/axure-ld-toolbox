/**
 * 命中测试：图形 / 节点 / 边的选择判定。
 *
 * 容差按当前缩放自适应 —— 缩得很小时也要能点中细线，
 * 放得很大时不应出现"离得很远也被选中"。
 */

import type { NodeRef, ViewportState } from '../types/editor';
import type { Bounds, Point, VectorElement } from '../types/vector';
import { boundsContains, boundsIntersect, elementBounds, elementPoints, isClosedKind } from '../types/vector';
import { pointInPolygon } from '../core/geometry/polygon';
import { pointSegmentDistance } from '../core/geometry/vec';
import { screenLengthToUnit } from './viewport';
import type { SpatialIndex } from './spatialIndex';

/** 屏幕像素容差（命中判定的手感基准）。 */
export const HIT_TOLERANCE_PX = 6;
export const NODE_TOLERANCE_PX = 7;

export interface HitResult {
  elementId: string;
  /** 命中类型。 */
  kind: 'node' | 'edge' | 'fill';
  /** node：顶点索引；edge：该边起点索引。 */
  index: number;
  /** 到命中目标的距离（unit）。 */
  distance: number;
}

/**
 * 在给定点做命中测试。
 * 优先级：节点 > 边 > 填充内部 —— 与专业矢量工具一致。
 */
export function hitTest(
  point: Point,
  elements: readonly VectorElement[],
  index: SpatialIndex,
  viewport: ViewportState,
  options: { preferNodes: boolean } = { preferNodes: true },
): HitResult | null {
  const nodeTol = screenLengthToUnit(NODE_TOLERANCE_PX, viewport);
  const edgeTol = screenLengthToUnit(HIT_TOLERANCE_PX, viewport);
  const maxTol = Math.max(nodeTol, edgeTol);

  const candidateIds = new Set(index.queryPoint(point.x, point.y, maxTol));
  // 按渲染顺序倒序（后绘制的在上层，优先命中）
  const candidates: VectorElement[] = [];
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i]!;
    if (el.hidden === true) continue;
    if (candidateIds.has(el.id)) candidates.push(el);
  }

  /* 1) 节点 */
  if (options.preferNodes) {
    let bestNode: HitResult | null = null;
    for (const el of candidates) {
      if (el.locked === true) continue;
      const pts = elementPoints(el);
      for (let i = 0; i < pts.length; i++) {
        const d = Math.hypot(pts[i]!.x - point.x, pts[i]!.y - point.y);
        if (d > nodeTol) continue;
        if (bestNode === null || d < bestNode.distance) {
          bestNode = { elementId: el.id, kind: 'node', index: i, distance: d };
        }
      }
    }
    if (bestNode !== null) return bestNode;
  }

  /* 2) 边 */
  let bestEdge: HitResult | null = null;
  for (const el of candidates) {
    const pts = elementPoints(el);
    const closed = isClosedKind(el.kind);
    const limit = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < limit; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      const d = pointSegmentDistance(point, a, b);
      if (d > edgeTol) continue;
      if (bestEdge === null || d < bestEdge.distance) {
        bestEdge = { elementId: el.id, kind: 'edge', index: i, distance: d };
      }
    }
  }
  if (bestEdge !== null) return bestEdge;

  /* 3) 填充内部（仅闭合形状，且需有填充） */
  for (const el of candidates) {
    if (!isClosedKind(el.kind)) continue;
    if (el.style.fill === 'none') continue;
    const pts = elementPoints(el);
    if (pointInPolygon(point, pts)) {
      return { elementId: el.id, kind: 'fill', index: -1, distance: 0 };
    }
  }

  return null;
}

/** 框选：返回与矩形相交（或被包含）的元素 id。 */
export function boxSelect(
  box: Bounds,
  elements: readonly VectorElement[],
  index: SpatialIndex,
  mode: 'intersect' | 'contain' = 'intersect',
): string[] {
  const ids = index.query(box);
  const out: string[] = [];
  const byId = new Map(elements.map((e) => [e.id, e]));

  for (const id of ids) {
    const el = byId.get(id);
    if (el === undefined || el.hidden === true || el.locked === true) continue;
    const b = elementBounds(el);
    if (mode === 'contain') {
      if (boundsContains(box, b)) out.push(id);
      continue;
    }
    // intersect 模式：包围盒相交后再做精确几何相交判定，避免"框住空白也选中"
    if (!boundsIntersect(box, b)) continue;
    if (geometryIntersectsBox(el, box)) out.push(id);
  }
  return out;
}

/** 元素几何是否与矩形真正相交。 */
function geometryIntersectsBox(el: VectorElement, box: Bounds): boolean {
  const pts = elementPoints(el);
  // 任一顶点在框内
  for (const p of pts) {
    if (p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY) return true;
  }
  // 任一边与框边相交
  const corners: Point[] = [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ];
  const closed = isClosedKind(el.kind);
  const limit = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < limit; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    for (let k = 0; k < 4; k++) {
      if (segmentsCross(a, b, corners[k]!, corners[(k + 1) % 4]!)) return true;
    }
  }
  // 框完全在闭合形状内部
  if (closed && pointInPolygon(corners[0]!, pts)) return true;
  return false;
}

function segmentsCross(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d = (a: Point, b: Point, c: Point): number => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

/** 框选节点（节点工具下使用）。 */
export function boxSelectNodes(
  box: Bounds,
  elements: readonly VectorElement[],
  restrictTo?: ReadonlySet<string>,
): NodeRef[] {
  const out: NodeRef[] = [];
  for (const el of elements) {
    if (el.hidden === true || el.locked === true) continue;
    if (restrictTo !== undefined && !restrictTo.has(el.id)) continue;
    const pts = elementPoints(el);
    pts.forEach((p, index) => {
      if (p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY) {
        out.push({ elementId: el.id, index });
      }
    });
  }
  return out;
}

/** 由两个屏幕点构造 unit 空间的规范化矩形。 */
export function normalizeBox(a: Point, b: Point): Bounds {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

/** 在边上找到插入新节点的位置（投影到最近点）。 */
export function projectOntoEdge(
  el: VectorElement,
  edgeIndex: number,
  point: Point,
): { point: Point; insertIndex: number } | null {
  const pts = elementPoints(el);
  if (pts.length < 2) return null;
  const a = pts[edgeIndex];
  const b = pts[(edgeIndex + 1) % pts.length];
  if (a === undefined || b === undefined) return null;

  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l2 = abx * abx + aby * aby;
  if (l2 < 1e-12) return null;
  let t = ((point.x - a.x) * abx + (point.y - a.y) * aby) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;

  return {
    point: { x: a.x + abx * t, y: a.y + aby * t },
    insertIndex: edgeIndex + 1,
  };
}
