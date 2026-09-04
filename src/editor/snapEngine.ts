/**
 * 吸附引擎：网格 / 端点 / 角度吸附求解。
 *
 * 输出除了吸附后坐标，还包含参考线信息，
 * 让用户看到"为什么吸到这里"。
 */

import type { SnapConfig, ViewportState } from '../types/editor';
import type { Point, VectorElement } from '../types/vector';
import { screenLengthToUnit } from './viewport';
import { PointIndex, buildPointIndex } from './spatialIndex';
import { toRad, undirectedAngleDiffDeg, angleDeg } from '../core/geometry/vec';

export interface SnapGuide {
  kind: 'grid' | 'endpoint' | 'angle';
  /** 参考线的两个端点（unit 空间）；endpoint 类型时两点相同表示一个吸附圈。 */
  from: Point;
  to: Point;
  label?: string;
}

export interface SnapResult {
  point: Point;
  snapped: boolean;
  guides: SnapGuide[];
}

/** 吸附上下文：一次拖动期间可复用，避免每帧重建索引。 */
export class SnapContext {
  private readonly pointIndex: PointIndex;

  constructor(
    elements: readonly VectorElement[],
    private readonly config: SnapConfig,
    private readonly viewport: ViewportState,
  ) {
    const radius = screenLengthToUnit(config.endpointRadiusPx, viewport);
    this.pointIndex = buildPointIndex(elements, Math.max(radius * 2, 1e-6));
  }

  /**
   * 求解吸附。
   * @param raw 未吸附的目标点（unit）
   * @param anchor 角度吸附的参考起点（例如线段另一端），为 null 时不做角度吸附
   * @param exclude 排除的顶点（拖动自身时必须排除，否则会吸到自己）
   */
  solve(
    raw: Point,
    anchor: Point | null,
    exclude?: (elementId: string, index: number) => boolean,
  ): SnapResult {
    const cfg = this.config;
    if (!cfg.enabled) return { point: raw, snapped: false, guides: [] };

    const guides: SnapGuide[] = [];
    let result = { ...raw };
    let snapped = false;

    /* 1) 端点吸附优先级最高 —— 它直接决定拓扑是否闭合 */
    if (cfg.endpoint) {
      const radius = screenLengthToUnit(cfg.endpointRadiusPx, this.viewport);
      const near = this.pointIndex.nearest(raw.x, raw.y, radius, exclude);
      if (near !== null) {
        result = { x: near.x, y: near.y };
        snapped = true;
        guides.push({
          kind: 'endpoint',
          from: { x: near.x, y: near.y },
          to: { x: near.x, y: near.y },
          label: '端点',
        });
        // 端点吸附命中后不再叠加其它吸附，避免互相打架
        return { point: result, snapped, guides };
      }
    }

    /* 2) 角度吸附：把 anchor→result 的方向对齐到常用角 */
    if (cfg.angle && anchor !== null) {
      const dx = result.x - anchor.x;
      const dy = result.y - anchor.y;
      const len = Math.hypot(dx, dy);
      if (len > 1e-9) {
        const current = angleDeg(anchor, result);
        let bestStep: number | null = null;
        let bestDiff = Infinity;
        for (const step of cfg.angleSteps) {
          const diff = Math.abs(normalizeDelta(current - step));
          if (diff < bestDiff) {
            bestDiff = diff;
            bestStep = step;
          }
        }
        if (bestStep !== null && bestDiff <= cfg.angleTolerance) {
          const rad = toRad(bestStep);
          result = { x: anchor.x + Math.cos(rad) * len, y: anchor.y + Math.sin(rad) * len };
          snapped = true;
          guides.push({
            kind: 'angle',
            from: { ...anchor },
            to: { ...result },
            label: `${bestStep}°`,
          });
        }
      }
    }

    /* 3) 网格吸附 */
    if (cfg.grid && cfg.gridSize > 0) {
      const gx = Math.round(result.x / cfg.gridSize) * cfg.gridSize;
      const gy = Math.round(result.y / cfg.gridSize) * cfg.gridSize;
      const tol = screenLengthToUnit(10, this.viewport);
      if (Math.abs(gx - result.x) <= tol && Math.abs(gy - result.y) <= tol) {
        result = { x: gx, y: gy };
        snapped = true;
        guides.push({
          kind: 'grid',
          from: { x: gx, y: gy },
          to: { x: gx, y: gy },
          label: '网格',
        });
      }
    }

    return { point: result, snapped, guides };
  }
}

/** 把角度差归一化到 (-180, 180]。 */
function normalizeDelta(d: number): number {
  let v = d % 360;
  if (v > 180) v -= 360;
  if (v <= -180) v += 360;
  return v;
}

/** 无吸附时的直通结果。 */
export function noSnap(p: Point): SnapResult {
  return { point: p, snapped: false, guides: [] };
}

export { undirectedAngleDiffDeg };
