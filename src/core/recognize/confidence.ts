/**
 * 置信度模型与编辑后增量重算。
 *
 * 设计原则（对应最低验收标准 8）：
 *   工具绝不静默输出「看似正确但实际错误」的结果。
 *   每个对象都带 0..1 的置信度，低置信度对象在 UI 中高亮并进入问题列表。
 *
 * 置信度由若干可解释的因子加权而成，而非黑箱分数：
 *   - fitQuality     直线 / 折线拟合残差（残差大 → 手绘抖动或识别错误）
 *   - closure        闭合性（区域是否真正闭合）
 *   - support        笔画支持度（矢量线附近是否真有前景像素）
 *   - snapCost       吸附位移（被拉动越多 → 原始几何越不确定）
 *   - alignment      角度规整度（落在常用角上 → 更可能是有意为之的墙）
 *   - sizeSanity     尺寸合理性（异常小图形可能是噪点）
 */

import type { BinaryImage } from '../preprocess/IPreprocessor';
import type { Point, VectorElement } from '../../types/vector';
import { elementPoints, isClosedKind } from '../../types/vector';
import { area, bounds, minWidth, perimeter } from '../geometry/polygon';
import { dist, EPS } from '../geometry/vec';
import { isSelfIntersecting } from '../geometry/intersect';
import { clamp01 } from '../../lib/precision';

export interface ConfidenceFactors {
  fitQuality: number;
  closure: number;
  support: number;
  snapCost: number;
  alignment: number;
  sizeSanity: number;
}

/** 权重之和为 1。fitQuality 与 support 权重最高，因为它们最能反映「是否真的存在这条线」。 */
export const WEIGHTS: ConfidenceFactors = {
  fitQuality: 0.26,
  closure: 0.14,
  support: 0.28,
  snapCost: 0.12,
  alignment: 0.1,
  sizeSanity: 0.1,
};

/** 低于此值的对象被标记为「低置信度」并进入待确认图层。 */
export const LOW_CONFIDENCE_THRESHOLD = 0.62;
/** 低于此值视为高度可疑。 */
export const VERY_LOW_CONFIDENCE = 0.42;

export function combine(f: ConfidenceFactors): number {
  const s =
    f.fitQuality * WEIGHTS.fitQuality +
    f.closure * WEIGHTS.closure +
    f.support * WEIGHTS.support +
    f.snapCost * WEIGHTS.snapCost +
    f.alignment * WEIGHTS.alignment +
    f.sizeSanity * WEIGHTS.sizeSanity;
  return clamp01(Math.round(s * 1000) / 1000);
}

export interface SupportSampler {
  /** 采样折线沿线的前景像素覆盖率（0..1）。坐标为图像像素空间。 */
  coverage(points: readonly Point[], closed: boolean): number;
}

/**
 * 基于二值图的笔画支持度采样器。
 *
 * 做法：沿折线等距采样，在每个采样点的 ±radius 邻域内查找前景像素。
 * 覆盖率低说明这条矢量线「凭空产生」——通常来自过度桥接或吸附。
 */
export class BinarySupportSampler implements SupportSampler {
  constructor(
    private readonly image: BinaryImage,
    private readonly radius = 3,
    private readonly stepPx = 2,
  ) {}

  coverage(points: readonly Point[], closed: boolean): number {
    const n = points.length;
    if (n < 2) return 0;
    let hits = 0;
    let samples = 0;
    const limit = closed ? n : n - 1;

    for (let i = 0; i < limit; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % n]!;
      const l = dist(a, b);
      if (l < EPS) continue;
      const steps = Math.max(1, Math.ceil(l / this.stepPx));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        samples++;
        if (this.hasForegroundNear(x, y)) hits++;
      }
    }
    return samples > 0 ? hits / samples : 0;
  }

  private hasForegroundNear(fx: number, fy: number): boolean {
    const { width: w, height: h, data } = this.image;
    const cx = Math.round(fx);
    const cy = Math.round(fy);
    const r = this.radius;
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= h) continue;
      const off = y * w;
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= w) continue;
        if (data[off + x]! !== 0) return true;
      }
    }
    return false;
  }
}

/** 无图像可用时的降级采样器（编辑阶段使用，不惩罚支持度）。 */
export class NeutralSampler implements SupportSampler {
  coverage(): number {
    return 0.85;
  }
}

export interface ScoreInput {
  points: readonly Point[];
  closed: boolean;
  /** 拟合残差（像素）；未知时传 0。 */
  fitRmse: number;
  /** 吸附位移（像素）；未知时传 0。 */
  snapDisplacement: number;
  /** 落在常用角上的边的比例 0..1。 */
  alignmentRatio: number;
  /** 参考笔画宽度（像素），用于把残差归一化。 */
  strokeWidth: number;
  /** 图像面积（像素²），用于尺寸合理性。 */
  imageArea: number;
  /** 是否存在未闭合缺口。 */
  hasGap: boolean;
}

export function computeFactors(input: ScoreInput, sampler: SupportSampler): ConfidenceFactors {
  const sw = Math.max(1, input.strokeWidth);

  // 拟合质量：残差为 0 → 1；残差达到 2 倍笔画宽 → 0
  const fitQuality = clamp01(1 - input.fitRmse / (sw * 2));

  // 闭合性
  let closure = 1;
  if (input.closed) {
    if (input.hasGap) closure = 0.4;
    if (isSelfIntersecting(input.points, true)) closure = Math.min(closure, 0.25);
  } else {
    closure = input.hasGap ? 0.55 : 0.8;
  }

  // 笔画支持度
  const support = clamp01(sampler.coverage(input.points, input.closed));

  // 吸附代价：位移为 0 → 1；位移达到 3 倍笔画宽 → 0
  const snapCost = clamp01(1 - input.snapDisplacement / (sw * 3));

  const alignment = clamp01(input.alignmentRatio);

  // 尺寸合理性
  const sizeSanity = computeSizeSanity(input);

  return { fitQuality, closure, support, snapCost, alignment, sizeSanity };
}

function computeSizeSanity(input: ScoreInput): number {
  const pts = input.points;
  if (pts.length < 2) return 0;
  const sw = Math.max(1, input.strokeWidth);

  if (input.closed) {
    const a = area(pts);
    // 面积小于 (6 倍笔画宽)² 视为噪点
    const minReasonable = (sw * 6) ** 2;
    if (a < minReasonable) return clamp01(a / minReasonable) * 0.5;
    // 细长度：最小宽度小于 2 倍笔画宽说明是「假面」（两条几乎重合的线夹出的缝）
    const mw = minWidth(pts);
    if (mw < sw * 2) return 0.3;
    // 面积占满整图也可疑（可能是把图像边框识别成了区域）
    if (input.imageArea > 0 && a / input.imageArea > 0.97) return 0.45;
    return 1;
  }

  const len = perimeter(pts, false);
  const minReasonable = sw * 8;
  if (len < minReasonable) return clamp01(len / minReasonable) * 0.6;
  return 1;
}

export function scoreShape(input: ScoreInput, sampler: SupportSampler): number {
  return combine(computeFactors(input, sampler));
}

/**
 * 编辑后重算置信度。
 *
 * 规则：
 *   - 用户手动创建 / 编辑过的对象（source === 'manual'）视为可信，置信度提到 0.95；
 *     用户的判断优先于算法，且不应因手绘线离原图偏远而被反复标记为问题。
 *   - 自动对象在几何被修改后，重新评估闭合性、自相交与尺寸合理性；
 *     笔画支持度沿用（无图像时用 NeutralSampler）。
 */
export function recomputeAfterEdit(
  el: VectorElement,
  sampler: SupportSampler,
  strokeWidthPx: number,
  imageArea: number,
): number {
  if (el.source === 'manual') return 0.95;

  const pts = elementPoints(el);
  const closed = isClosedKind(el.kind);
  const factors = computeFactors(
    {
      points: pts,
      closed,
      fitRmse: 0,
      snapDisplacement: 0,
      alignmentRatio: 1,
      strokeWidth: strokeWidthPx,
      imageArea,
      hasGap: false,
    },
    sampler,
  );
  // 编辑后不再惩罚吸附与拟合（这两项只在自动识别时有意义）
  return combine({ ...factors, fitQuality: 1, snapCost: 1 });
}

/** 面积 / 包围盒等辅助度量，供 UI 检查器展示。 */
export function shapeMetrics(points: readonly Point[], closed: boolean): {
  area: number;
  perimeter: number;
  minWidth: number;
  aspect: number;
} {
  const b = bounds(points);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  return {
    area: closed ? area(points) : 0,
    perimeter: perimeter(points, closed),
    minWidth: closed ? minWidth(points) : 0,
    aspect: h > EPS ? w / h : 0,
  };
}
