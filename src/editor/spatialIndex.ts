/**
 * 均匀网格空间索引。
 *
 * 用途：命中测试与吸附候选查询。
 * 2000 个对象时，每帧全量遍历会明显掉帧；
 * 网格索引把查询降到「只检查光标附近的几个格子」。
 */

import type { Bounds, VectorElement } from '../types/vector';
import { boundsIntersect, elementBounds } from '../types/vector';

export class SpatialIndex {
  private readonly cellSize: number;
  private readonly cells = new Map<string, string[]>();
  private readonly boundsById = new Map<string, Bounds>();

  constructor(elements: readonly VectorElement[], targetCellCount = 32) {
    // 按内容范围推导格子尺寸，保证格子数量适中
    let overall: Bounds | null = null;
    const entries: Array<{ id: string; b: Bounds }> = [];
    for (const el of elements) {
      const b = elementBounds(el);
      if (!Number.isFinite(b.minX)) continue;
      entries.push({ id: el.id, b });
      overall =
        overall === null
          ? { ...b }
          : {
              minX: Math.min(overall.minX, b.minX),
              minY: Math.min(overall.minY, b.minY),
              maxX: Math.max(overall.maxX, b.maxX),
              maxY: Math.max(overall.maxY, b.maxY),
            };
    }

    const span =
      overall === null ? 1 : Math.max(overall.maxX - overall.minX, overall.maxY - overall.minY, 1e-6);
    this.cellSize = Math.max(span / targetCellCount, 1e-6);

    for (const e of entries) {
      this.boundsById.set(e.id, e.b);
      for (const key of this.keysFor(e.b)) {
        const arr = this.cells.get(key);
        if (arr) arr.push(e.id);
        else this.cells.set(key, [e.id]);
      }
    }
  }

  private *keysFor(b: Bounds): Generator<string> {
    const x0 = Math.floor(b.minX / this.cellSize);
    const x1 = Math.floor(b.maxX / this.cellSize);
    const y0 = Math.floor(b.minY / this.cellSize);
    const y1 = Math.floor(b.maxY / this.cellSize);
    // 保护：极端跨度时限制格子数量，避免索引本身成为瓶颈
    const maxCells = 4096;
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > maxCells) {
      yield 'all';
      return;
    }
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        yield `${x},${y}`;
      }
    }
  }

  /** 查询与给定范围可能相交的元素 id。 */
  query(range: Bounds): string[] {
    const found = new Set<string>();
    for (const key of this.keysFor(range)) {
      for (const id of this.cells.get(key) ?? []) found.add(id);
    }
    for (const id of this.cells.get('all') ?? []) found.add(id);

    // 用精确包围盒二次过滤
    const out: string[] = [];
    for (const id of found) {
      const b = this.boundsById.get(id);
      if (b !== undefined && boundsIntersect(b, range)) out.push(id);
    }
    return out;
  }

  /** 查询包围盒包含某点（带容差）的元素。 */
  queryPoint(x: number, y: number, tolerance: number): string[] {
    return this.query({
      minX: x - tolerance,
      minY: y - tolerance,
      maxX: x + tolerance,
      maxY: y + tolerance,
    });
  }

  boundsOf(id: string): Bounds | undefined {
    return this.boundsById.get(id);
  }

  get size(): number {
    return this.boundsById.size;
  }
}

/** 顶点索引：用于端点吸附的快速最近点查询。 */
export class PointIndex {
  private readonly cellSize: number;
  private readonly cells = new Map<string, Array<{ x: number; y: number; elementId: string; index: number }>>();

  constructor(
    entries: ReadonlyArray<{ x: number; y: number; elementId: string; index: number }>,
    cellSize: number,
  ) {
    this.cellSize = Math.max(cellSize, 1e-6);
    for (const e of entries) {
      const key = this.keyOf(e.x, e.y);
      const arr = this.cells.get(key);
      if (arr) arr.push(e);
      else this.cells.set(key, [e]);
    }
  }

  private keyOf(x: number, y: number): string {
    return `${Math.floor(x / this.cellSize)},${Math.floor(y / this.cellSize)}`;
  }

  /** 查询半径内最近的顶点；excludeElementId 用于排除自身。 */
  nearest(
    x: number,
    y: number,
    radius: number,
    excludeKey?: (elementId: string, index: number) => boolean,
  ): { x: number; y: number; elementId: string; index: number; distance: number } | null {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    const span = Math.max(1, Math.ceil(radius / this.cellSize));
    let best: { x: number; y: number; elementId: string; index: number; distance: number } | null = null;
    const r2 = radius * radius;

    for (let dy = -span; dy <= span; dy++) {
      for (let dx = -span; dx <= span; dx++) {
        const arr = this.cells.get(`${cx + dx},${cy + dy}`);
        if (arr === undefined) continue;
        for (const p of arr) {
          if (excludeKey?.(p.elementId, p.index) === true) continue;
          const ddx = p.x - x;
          const ddy = p.y - y;
          const d2 = ddx * ddx + ddy * ddy;
          if (d2 > r2) continue;
          if (best === null || d2 < best.distance * best.distance) {
            best = { ...p, distance: Math.sqrt(d2) };
          }
        }
      }
    }
    return best;
  }
}

/** 从元素集合构建顶点索引。 */
export function buildPointIndex(elements: readonly VectorElement[], cellSize: number): PointIndex {
  const entries: Array<{ x: number; y: number; elementId: string; index: number }> = [];
  for (const el of elements) {
    if (el.locked === true || el.hidden === true) continue;
    const pts = elementPointsOf(el);
    pts.forEach((p, index) => {
      entries.push({ x: p.x, y: p.y, elementId: el.id, index });
    });
  }
  return new PointIndex(entries, cellSize);
}

function elementPointsOf(el: VectorElement): Array<{ x: number; y: number }> {
  switch (el.kind) {
    case 'line':
      return [el.a, el.b];
    case 'rect':
      return [
        { x: el.x, y: el.y },
        { x: el.x + el.w, y: el.y },
        { x: el.x + el.w, y: el.y + el.h },
        { x: el.x, y: el.y + el.h },
      ];
    default:
      return el.points;
  }
}
