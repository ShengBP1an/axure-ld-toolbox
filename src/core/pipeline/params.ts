/**
 * 识别参数：三档预设 + 阈值取值范围。
 *
 * 所有以「像素」为单位的阈值都会在 StructureRecognizer 内按
 * 「估计笔画宽度」自适应缩放，保证不同分辨率 / 不同笔粗下行为一致。
 */

import type { PreprocessParams } from '../../types/project';
import { DEFAULT_PREPROCESS } from '../../types/project';
import type { BridgeOptions } from '../recognize/bridging';
import type { ClassifyOptions } from '../recognize/classify';
import type { PlanarOptions } from '../recognize/planarFaces';
import type { SnapOptions } from '../recognize/snapping';
import type { FitOptions } from '../recognize/segmentFit';
import type { GuardOptions } from '../recognize/topologyGuard';
import type { ContourOptions } from '../recognize/contourTrace';

export type PresetKind = 'fast' | 'standard' | 'fine';

export const PRESET_LABELS: Record<PresetKind, string> = {
  fast: '快速',
  standard: '标准',
  fine: '精细',
};

export const PRESET_DESCRIPTIONS: Record<PresetKind, string> = {
  fast: '容差大、节点最少，适合快速出白盒；细节可能被抹平',
  standard: '平衡节点数与保真度，推荐默认',
  fine: '保留更多细节与小结构，节点较多，处理更慢',
};

export interface RecognizeParams {
  preset: PresetKind;
  fit: FitOptions;
  snap: SnapOptions;
  bridge: BridgeOptions;
  planar: PlanarOptions;
  classify: ClassifyOptions;
  guard: GuardOptions;
  contour: ContourOptions;
  /** 最终简化容差（像素），受笔画宽度缩放。 */
  simplifyEpsilon: number;
  /** 骨架毛刺剪除阈值（像素）。 */
  spurLength: number;
  /** 输出对象数量上限，超出则提示提高容差。 */
  maxElements: number;
  /** 是否启用实心填充块的轮廓追踪降级路径。 */
  enableContourFallback: boolean;
}

export const PARAM_RANGES = {
  rdpEpsilon: { min: 0.5, max: 8, step: 0.1 },
  simplifyEpsilon: { min: 0.5, max: 10, step: 0.1 },
  angleTolDeg: { min: 0, max: 20, step: 0.5 },
  clusterRadius: { min: 0, max: 20, step: 0.5 },
  maxGap: { min: 0, max: 40, step: 1 },
  minSegmentLength: { min: 1, max: 30, step: 1 },
  minFaceArea: { min: 20, max: 2000, step: 10 },
  spurLength: { min: 0, max: 30, step: 1 },
  thresholdRadius: { min: 3, max: 60, step: 1 },
  thresholdBias: { min: 0.02, max: 0.4, step: 0.01 },
} as const;

function baseParams(): Omit<RecognizeParams, 'preset'> {
  return {
    fit: {
      rdpEpsilon: 2.2,
      mergeAngleTolDeg: 12,
      minSegmentLength: 4,
      curveRmseThreshold: 2.6,
    },
    snap: {
      angleSteps: [0, 30, 45, 60, 90, 120, 135, 150],
      angleTolDeg: 7,
      clusterRadius: 6,
      minLengthForAngleSnap: 8,
      enableAngle: true,
      enableCluster: true,
    },
    bridge: {
      maxGap: 14,
      maxExtend: 18,
      directionTolDeg: 34,
      minSegmentLength: 5,
      duplicateTol: 3.5,
      parallelProximity: 7,
      collinearAngleTolDeg: 8,
    },
    planar: {
      vertexTolerance: 2,
      minFaceArea: 120,
      maxFaceVertices: 4096,
    },
    classify: {
      rectFillThreshold: 0.94,
      aabbFillThreshold: 0.93,
      rightAngleTolDeg: 9,
      axisAlignTolDeg: 7,
      regularEdgeCvMax: 0.12,
      regularAngleTolDeg: 9,
      straightTolerance: 2.4,
      collinearTolDeg: 6,
      maxVerticesForShapeTest: 256,
    },
    guard: {
      maxAreaDrift: 0.06,
      minPassageWidth: 4,
      maxShapeDeviation: 3.5,
      maxRetries: 3,
      retryDecay: 0.55,
    },
    contour: {
      minArea: 400,
      minSolidity: 0.55,
      minHoleArea: 80,
    },
    simplifyEpsilon: 2,
    spurLength: 7,
    maxElements: 2000,
    enableContourFallback: true,
  };
}

export function presetParams(preset: PresetKind): RecognizeParams {
  const p = baseParams();

  if (preset === 'fast') {
    return {
      preset,
      ...p,
      fit: { ...p.fit, rdpEpsilon: 3.6, mergeAngleTolDeg: 16, minSegmentLength: 6, curveRmseThreshold: 3.6 },
      snap: { ...p.snap, angleTolDeg: 10, clusterRadius: 9, minLengthForAngleSnap: 10 },
      bridge: { ...p.bridge, maxGap: 20, maxExtend: 26, minSegmentLength: 8, duplicateTol: 5, parallelProximity: 10, collinearAngleTolDeg: 11 },
      planar: { ...p.planar, vertexTolerance: 3, minFaceArea: 260 },
      classify: { ...p.classify, rectFillThreshold: 0.9, aabbFillThreshold: 0.89, rightAngleTolDeg: 12, axisAlignTolDeg: 10, straightTolerance: 3.6, collinearTolDeg: 9 },
      guard: { ...p.guard, maxAreaDrift: 0.1, maxShapeDeviation: 5 },
      simplifyEpsilon: 3.4,
      spurLength: 10,
    };
  }

  if (preset === 'fine') {
    return {
      preset,
      ...p,
      fit: { ...p.fit, rdpEpsilon: 1.4, mergeAngleTolDeg: 8, minSegmentLength: 3, curveRmseThreshold: 1.9 },
      snap: { ...p.snap, angleTolDeg: 4.5, clusterRadius: 4, minLengthForAngleSnap: 6 },
      bridge: { ...p.bridge, maxGap: 9, maxExtend: 12, minSegmentLength: 3, duplicateTol: 2.4, parallelProximity: 5, collinearAngleTolDeg: 6 },
      planar: { ...p.planar, vertexTolerance: 1.4, minFaceArea: 60 },
      classify: { ...p.classify, rectFillThreshold: 0.96, aabbFillThreshold: 0.955, rightAngleTolDeg: 6.5, axisAlignTolDeg: 5, straightTolerance: 1.6, collinearTolDeg: 4 },
      guard: { ...p.guard, maxAreaDrift: 0.04, minPassageWidth: 3, maxShapeDeviation: 2.2 },
      contour: { ...p.contour, minArea: 240, minHoleArea: 50 },
      simplifyEpsilon: 1.3,
      spurLength: 5,
      maxElements: 4000,
    };
  }

  return { preset: 'standard', ...p };
}

export function presetPreprocess(preset: PresetKind): PreprocessParams {
  if (preset === 'fast') {
    return { ...DEFAULT_PREPROCESS, maxWorkingSize: 1400, contrastBoost: 0.45, denoiseOpen: 1, denoiseClose: 1, minBlobArea: 40 };
  }
  if (preset === 'fine') {
    return { ...DEFAULT_PREPROCESS, maxWorkingSize: 2400, contrastBoost: 0.7, denoiseOpen: 1, denoiseClose: 1, minBlobArea: 14 };
  }
  return { ...DEFAULT_PREPROCESS };
}

/**
 * 按估计笔画宽度缩放全部像素级阈值。
 *
 * 基准笔画宽度取 3 像素（2000px 宽草图的常见铅笔线）。
 * 笔画更粗时，桥接间隙、聚簇半径等都应等比放大，
 * 否则粗线草图会出现大量「明明相接却判为断线」的误报。
 */
export function scaleParamsByStroke(params: RecognizeParams, strokeWidthPx: number): RecognizeParams {
  const k = clampScale(strokeWidthPx / 3);
  if (Math.abs(k - 1) < 0.08) return params;

  return {
    ...params,
    fit: {
      ...params.fit,
      rdpEpsilon: params.fit.rdpEpsilon * k,
      minSegmentLength: params.fit.minSegmentLength * k,
      curveRmseThreshold: params.fit.curveRmseThreshold * k,
    },
    snap: {
      ...params.snap,
      clusterRadius: params.snap.clusterRadius * k,
      minLengthForAngleSnap: params.snap.minLengthForAngleSnap * k,
    },
    bridge: {
      ...params.bridge,
      maxGap: params.bridge.maxGap * k,
      maxExtend: params.bridge.maxExtend * k,
      minSegmentLength: params.bridge.minSegmentLength * k,
      duplicateTol: params.bridge.duplicateTol * k,
      parallelProximity: params.bridge.parallelProximity * k,
    },
    planar: {
      ...params.planar,
      vertexTolerance: params.planar.vertexTolerance * k,
      minFaceArea: params.planar.minFaceArea * k * k,
    },
    classify: {
      ...params.classify,
      straightTolerance: params.classify.straightTolerance * k,
    },
    guard: {
      ...params.guard,
      minPassageWidth: params.guard.minPassageWidth * k,
      maxShapeDeviation: params.guard.maxShapeDeviation * k,
    },
    contour: {
      ...params.contour,
      minArea: params.contour.minArea * k * k,
      minHoleArea: params.contour.minHoleArea * k * k,
    },
    simplifyEpsilon: params.simplifyEpsilon * k,
    spurLength: params.spurLength * k,
  };
}

function clampScale(k: number): number {
  return k < 0.5 ? 0.5 : k > 3.5 ? 3.5 : k;
}

/** 阶段名称，用于进度上报与耗时统计。 */
export const STAGES = [
  'preprocess',
  'thinning',
  'graph',
  'fit',
  'snap',
  'faces',
  'classify',
  'simplify',
] as const;

export type StageName = (typeof STAGES)[number];

export const STAGE_LABELS: Record<StageName, string> = {
  preprocess: '图像预处理',
  thinning: '骨架细化',
  graph: '结构图构建',
  fit: '线段拟合',
  snap: '吸附与桥接',
  faces: '闭合区域提取',
  classify: '几何分类',
  simplify: '节点简化',
};

/** 阶段进度的累计权重，用于把 8 个阶段映射为 0..1 的总进度。 */
export const STAGE_WEIGHTS: Record<StageName, number> = {
  preprocess: 0.3,
  thinning: 0.16,
  graph: 0.08,
  fit: 0.14,
  snap: 0.08,
  faces: 0.14,
  classify: 0.05,
  simplify: 0.05,
};

export function stageProgress(stage: StageName, within: number): number {
  let acc = 0;
  for (const s of STAGES) {
    if (s === stage) return Math.min(1, acc + STAGE_WEIGHTS[s] * Math.max(0, Math.min(1, within)));
    acc += STAGE_WEIGHTS[s];
  }
  return acc;
}
