/**
 * 项目设置：区分「地图实际尺寸」与「输出画布像素尺寸」。
 */

import type { Point } from './vector';

export type UnitKind = 'm' | 'cm' | 'custom';

export const UNIT_LABELS: Record<UnitKind, string> = {
  m: '米 (m)',
  cm: '厘米 (cm)',
  custom: '自定义单位',
};

export interface UnitSpec {
  kind: UnitKind;
  /** 自定义单位时的显示符号，例如 'tile' / 'grid'。 */
  symbol: string;
}

export const DEFAULT_UNIT: UnitSpec = { kind: 'm', symbol: 'm' };

export function unitSymbol(u: UnitSpec): string {
  if (u.kind === 'm') return 'm';
  if (u.kind === 'cm') return 'cm';
  return u.symbol || 'u';
}

/** 比例来源，用于「两点标定 vs 手动输入」的冲突优先级判定。 */
export type ScaleSource = 'manual' | 'calibration';

export interface Calibration {
  /** 标定两点，坐标在「图像像素空间 imgPx」（预处理后的工作尺寸）。 */
  p1: Point;
  p2: Point;
  /** 用户输入的两点间实际距离（地图单位）。 */
  realDistance: number;
  /** 由标定推得的 imgPx → unit 比例：每个图像像素代表多少地图单位。 */
  unitsPerImagePx: number;
  /** 标定后用户又手动改了尺寸时置为 true：数据保留，可一键重新应用。 */
  stale: boolean;
  createdAt: number;
}

export interface SourceImage {
  /** 稳定 id，工程文件内引用。 */
  id: string;
  fileName: string;
  mimeType: string;
  byteSize: number;
  /** 原始像素尺寸（EXIF 方向修正后）。 */
  naturalWidth: number;
  naturalHeight: number;
  /** EXIF 方向值 1..8，1 为无需旋转。 */
  exifOrientation: number;
  /** 内嵌于工程文件的 dataURL，保证工程可迁移；原图只读，不被处理破坏。 */
  dataUrl: string;
  createdAt: number;
}

/** 预处理参数，全部可单独关闭以撤销对应的自动校正。 */
export interface PreprocessParams {
  /** 工作空间长边上限，超出则等比下采样。 */
  maxWorkingSize: number;
  grayscale: boolean;
  /** 分块对比度增强（CLAHE 近似）强度 0..1，0 关闭。 */
  contrastBoost: number;
  /** 阴影抑制（大核背景估计后相除）强度 0..1，0 关闭。 */
  shadowSuppress: number;
  /** 自适应二值化窗口半径（像素）。 */
  thresholdRadius: number;
  /** Bradley-Roth 相对阈值百分比，典型 0.10~0.20。 */
  thresholdBias: number;
  /** 是否在自适应失败（前景占比异常）时回退 Otsu 全局阈值。 */
  otsuFallback: boolean;
  /** 形态学开运算次数，去孤立噪点。 */
  denoiseOpen: number;
  /** 形态学闭运算次数，弥合细小断裂。 */
  denoiseClose: number;
  /** 小连通域面积阈值（像素），小于此值视为噪点移除。 */
  minBlobArea: number;
  /** 自动去倾斜，限 ±15°。 */
  deskew: boolean;
  /** 手动旋转角（度），叠加在自动去倾斜之后。 */
  manualRotation: number;
  /** 裁剪区域（原图归一化坐标 0..1），null 表示不裁剪。 */
  crop: { x: number; y: number; w: number; h: number } | null;
  /** 透视校正四角点（原图归一化坐标，顺序：左上、右上、右下、左下），null 表示不做。 */
  perspective: [Point, Point, Point, Point] | null;
  /** 线条为深色（true）还是浅色（false，反相处理）。 */
  darkStrokes: boolean;
}

export const DEFAULT_PREPROCESS: PreprocessParams = {
  maxWorkingSize: 2000,
  grayscale: true,
  contrastBoost: 0.6,
  shadowSuppress: 0.5,
  thresholdRadius: 18,
  thresholdBias: 0.14,
  otsuFallback: true,
  denoiseOpen: 1,
  denoiseClose: 1,
  minBlobArea: 24,
  deskew: true,
  manualRotation: 0,
  crop: null,
  perspective: null,
  darkStrokes: true,
};

export interface ProjectSettings {
  /** 地图实际宽度（地图单位）。 */
  mapWidth: number;
  /** 地图实际高度（地图单位）。 */
  mapHeight: number;
  unit: UnitSpec;
  /** SVG / Axure 输出画布宽度（像素）。 */
  canvasWidthPx: number;
  /** SVG / Axure 输出画布高度（像素）。 */
  canvasHeightPx: number;
  /** 是否锁定宽高比（默认 true，比值取自原图）。 */
  lockAspect: boolean;
  /** 锁定时使用的宽高比 = width / height。 */
  aspectRatio: number;
  /** 当前比例来源。 */
  scaleSource: ScaleSource;
  calibration: Calibration | null;
}

/** 唯一的比例定义：1 个地图单位对应多少画布像素。 */
export function pixelsPerUnit(s: ProjectSettings): number {
  return s.mapWidth > 0 ? s.canvasWidthPx / s.mapWidth : 1;
}

/** 纵向比例，用于解锁宽高比后的非等比检测。 */
export function pixelsPerUnitY(s: ProjectSettings): number {
  return s.mapHeight > 0 ? s.canvasHeightPx / s.mapHeight : 1;
}

/** 非等比程度：1 表示完全等比。用于「可能造成图形变形」的提示。 */
export function anisotropy(s: ProjectSettings): number {
  const sx = pixelsPerUnit(s);
  const sy = pixelsPerUnitY(s);
  if (sx <= 0 || sy <= 0) return 1;
  return sx / sy;
}

export function isAnisotropic(s: ProjectSettings, tolerance = 0.005): boolean {
  return Math.abs(anisotropy(s) - 1) > tolerance;
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  mapWidth: 60,
  mapHeight: 40,
  unit: DEFAULT_UNIT,
  canvasWidthPx: 1200,
  canvasHeightPx: 800,
  lockAspect: true,
  aspectRatio: 1200 / 800,
  scaleSource: 'manual',
  calibration: null,
};
