/**
 * 几何语义择优分类。
 *
 * 目标（最低验收标准 1 与 2）：
 *   - 方正房间 → rect（4 个可拖动控制点），而不是几十节点的自由路径；
 *   - 旋转矩形 / 规则多边形 → polygon（顶点展开，不用 transform）；
 *   - 确实不规则的区域 → closedPath（节点可编辑）；
 *   - 直墙 → line；折墙 → polyline；手绘弧线 → openPath。
 *
 * 判据按「从最简到最复杂」逐级尝试，第一个通过的即采用。
 * 每一级都要求「与原始几何的偏差在容差内」，避免为了简化而失真。
 */

import type { Point, VectorKind } from '../../types/vector';
import {
  aabbFillRatio,
  analyzeRegularity,
  area,
  bounds,
  minAreaRect,
  perimeter,
  rectFillRatio,
  toClockwise,
} from '../geometry/polygon';
import { dist, EPS, undirectedAngleDiffDeg, angleDeg } from '../geometry/vec';
import { isStraight } from '../geometry/lineFit';
import { removeCollinear } from '../geometry/rdp';

export interface ClassifyOptions {
  /** 判为矩形时，与最小外接矩形的最小面积比。 */
  rectFillThreshold: number;
  /** 判为轴对齐矩形时，与轴对齐包围盒的最小面积比。 */
  aabbFillThreshold: number;
  /** 内角与 90° 的最大偏差（度）。 */
  rightAngleTolDeg: number;
  /** 边方向与坐标轴的最大偏差（度）。 */
  axisAlignTolDeg: number;
  /** 判为正多边形时，边长变异系数上限。 */
  regularEdgeCvMax: number;
  /** 判为正多边形时，内角最大偏差（度）。 */
  regularAngleTolDeg: number;
  /** 判为直线时，中间点到首尾连线的最大偏差（像素 / 单位，与输入同尺度）。 */
  straightTolerance: number;
  /** 共线点清除的角度容差（度）。 */
  collinearTolDeg: number;
  /** 顶点数超过此值的闭合形状不再尝试 rect / polygon 判定（性能保护）。 */
  maxVerticesForShapeTest: number;
}

export const DEFAULT_CLASSIFY: ClassifyOptions = {
  rectFillThreshold: 0.94,
  aabbFillThreshold: 0.93,
  rightAngleTolDeg: 9,
  axisAlignTolDeg: 7,
  regularEdgeCvMax: 0.12,
  regularAngleTolDeg: 9,
  straightTolerance: 2.4,
  collinearTolDeg: 6,
  maxVerticesForShapeTest: 256,
};

export interface ClassifiedShape {
  kind: VectorKind;
  /** 归一化后的顶点（rect 时为 4 角，可由 rect 字段重建）。 */
  points: Point[];
  /** kind === 'rect' 时的矩形参数。 */
  rect?: { x: number; y: number; w: number; h: number };
  /** kind === 'polygon' 时是否为近似正多边形。 */
  regular?: boolean;
  /** 相对原始几何的形状偏差（0..1，越小越忠实）。 */
  deviation: number;
  /** 分类时的判据说明，用于 UI 与调试。 */
  reason: string;
}

/**
 * 分类闭合区域。
 * 顶点顺序会被归一化为顺时针（与 SVG 常规填充朝向一致）。
 */
export function classifyClosed(rawPoints: readonly Point[], opts: ClassifyOptions): ClassifiedShape {
  // 先清理共线点，避免「一条直墙上多打了几个点」影响 4 顶点判定
  let pts = removeCollinear(rawPoints, opts.collinearTolDeg, true);
  pts = toClockwise(pts);

  const n = pts.length;
  const originalArea = area(rawPoints);

  if (n < 3) {
    return {
      kind: 'closedPath',
      points: pts,
      deviation: 0,
      reason: '顶点不足，保留为封闭路径',
    };
  }

  /* 级别 1：轴对齐矩形 —— 最理想的输出 */
  if (n <= opts.maxVerticesForShapeTest) {
    const rectResult = tryAxisAlignedRect(pts, opts, originalArea);
    if (rectResult !== null) return rectResult;
  }

  /* 级别 2：旋转矩形 → polygon（不使用 transform，规避 Axure 兼容风险） */
  if (n <= opts.maxVerticesForShapeTest) {
    const rotated = tryRotatedRect(pts, opts, originalArea);
    if (rotated !== null) return rotated;
  }

  /* 级别 3：正多边形 / 规则多边形 */
  if (n >= 3 && n <= 16) {
    const reg = analyzeRegularity(pts, opts.regularAngleTolDeg);
    if (reg.edgeCv <= opts.regularEdgeCvMax && reg.maxAngleDev <= opts.regularAngleTolDeg) {
      return {
        kind: 'polygon',
        points: pts,
        regular: true,
        deviation: relativeDeviation(originalArea, area(pts)),
        reason: `${n} 边形，边长与内角规则`,
      };
    }
  }

  /* 级别 4：一般多边形（节点数少且各边为直线） */
  if (n <= 12) {
    return {
      kind: 'polygon',
      points: pts,
      regular: false,
      deviation: relativeDeviation(originalArea, area(pts)),
      reason: `${n} 顶点多边形`,
    };
  }

  /* 级别 5：不规则封闭路径 */
  return {
    kind: 'closedPath',
    points: pts,
    deviation: relativeDeviation(originalArea, area(pts)),
    reason: `${n} 节点不规则区域，保留为可编辑封闭路径`,
  };
}

function tryAxisAlignedRect(
  pts: readonly Point[],
  opts: ClassifyOptions,
  originalArea: number,
): ClassifiedShape | null {
  if (pts.length !== 4) return null;

  const reg = analyzeRegularity(pts, opts.rightAngleTolDeg);
  if (!reg.allRightAngles) return null;
  if (!reg.axisAligned) return null;

  const fill = aabbFillRatio(pts);
  if (fill < opts.aabbFillThreshold) return null;

  const b = bounds(pts);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  if (w < EPS || h < EPS) return null;

  const rectArea = w * h;
  const deviation = relativeDeviation(originalArea, rectArea);
  // 面积偏差过大说明强行拉成矩形会明显失真
  if (deviation > 0.09) return null;

  return {
    kind: 'rect',
    points: [
      { x: b.minX, y: b.minY },
      { x: b.maxX, y: b.minY },
      { x: b.maxX, y: b.maxY },
      { x: b.minX, y: b.maxY },
    ],
    rect: { x: b.minX, y: b.minY, w, h },
    deviation,
    reason: `轴对齐矩形（充满度 ${(fill * 100).toFixed(1)}%）`,
  };
}

function tryRotatedRect(
  pts: readonly Point[],
  opts: ClassifyOptions,
  originalArea: number,
): ClassifiedShape | null {
  if (pts.length !== 4) return null;

  const reg = analyzeRegularity(pts, opts.rightAngleTolDeg);
  if (!reg.allRightAngles) return null;

  const fill = rectFillRatio(pts);
  if (fill < opts.rectFillThreshold) return null;

  const mar = minAreaRect(pts);
  if (mar.width < EPS || mar.height < EPS) return null;

  const deviation = relativeDeviation(originalArea, mar.area);
  if (deviation > 0.09) return null;

  // 用最小外接矩形的四角替换原顶点，得到严格 90° 的四边形
  const corners = toClockwise(mar.corners);
  return {
    kind: 'polygon',
    points: corners,
    regular: false,
    deviation,
    reason: `旋转矩形（${mar.angle.toFixed(1)}°，展开为 polygon 顶点）`,
  };
}

/**
 * 分类开放折线。
 */
export function classifyOpen(
  rawPoints: readonly Point[],
  opts: ClassifyOptions,
  curved: boolean,
): ClassifiedShape {
  const pts = removeCollinear(rawPoints, opts.collinearTolDeg, false);
  const n = pts.length;

  if (n < 2) {
    return { kind: 'openPath', points: pts, deviation: 0, reason: '点数不足' };
  }

  /* 级别 1：直线 */
  if (n === 2 || isStraight(pts, opts.straightTolerance)) {
    const a = pts[0]!;
    const b = pts[n - 1]!;
    return {
      kind: 'line',
      points: [{ ...a }, { ...b }],
      deviation: n === 2 ? 0 : maxDeviationFromLine(pts) / Math.max(dist(a, b), EPS),
      reason: n === 2 ? '两点直线' : `${n} 点近似直线，简化为直线`,
    };
  }

  /* 级别 2：折线（各段为直线，节点数适中） */
  if (!curved && n <= 24) {
    return {
      kind: 'polyline',
      points: pts,
      deviation: 0,
      reason: `${n} 节点折线`,
    };
  }

  /* 级别 3：开放路径（手绘弧线 / 高节点数） */
  return {
    kind: 'openPath',
    points: pts,
    deviation: 0,
    reason: curved ? `${n} 节点曲线，保留为开放路径` : `${n} 节点，超出折线阈值`,
  };
}

function relativeDeviation(a: number, b: number): number {
  const m = Math.max(Math.abs(a), Math.abs(b), EPS);
  return Math.abs(a - b) / m;
}

function maxDeviationFromLine(pts: readonly Point[]): number {
  const a = pts[0]!;
  const b = pts[pts.length - 1]!;
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const l = Math.hypot(abx, aby);
  if (l < EPS) return 0;
  let max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!;
    const d = Math.abs(abx * (p.y - a.y) - aby * (p.x - a.x)) / l;
    if (d > max) max = d;
  }
  return max;
}

/**
 * 判断闭合区域是否应归为「地图边界」图层。
 * 判据：面积占比极大（≥ 图像面积的 45%）且是最外层（无宿主）。
 */
export function isBoundaryFace(faceArea: number, imageArea: number, isOutermost: boolean): boolean {
  return isOutermost && imageArea > 0 && faceArea / imageArea >= 0.45;
}

/**
 * 判断开放折线是否应归为「地图边界」图层。
 * 判据：长度占图像周长比例大。
 */
export function isBoundaryPolyline(points: readonly Point[], imageWidth: number, imageHeight: number): boolean {
  const len = perimeter(points, false);
  const ref = 2 * (imageWidth + imageHeight);
  return ref > 0 && len / ref >= 0.5;
}

/** 检测折线的主方向是否为常用角（用于置信度加成）。 */
export function alignmentScore(points: readonly Point[], steps: readonly number[], tolDeg: number): number {
  if (points.length < 2) return 0;
  let aligned = 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (dist(a, b) < EPS) continue;
    total++;
    const ang = angleDeg(a, b);
    for (const s of steps) {
      if (undirectedAngleDiffDeg(ang, s) <= tolDeg) {
        aligned++;
        break;
      }
    }
  }
  return total > 0 ? aligned / total : 0;
}
