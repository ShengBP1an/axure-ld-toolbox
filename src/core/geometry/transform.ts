/**
 * transform.ts —— 全局唯一的坐标 / 比例换算入口。
 *
 * 三个坐标空间：
 *   1. imgPx    图像像素空间：预处理与识别的工作空间，左上原点。
 *   2. unit     地图单位空间：所有 VectorElement 的权威存储空间。
 *   3. canvasPx 画布像素空间：仅在渲染与 SVG 导出时使用。
 *
 * 约束：其它任何模块都不得自行乘除 pixelsPerUnit / downscale，
 * 必须调用本文件的函数，从而保证「修改地图尺寸后所有坐标与线宽按同一规则更新」。
 */

import type { ProjectSettings } from '../../types/project';
import { pixelsPerUnit, pixelsPerUnitY } from '../../types/project';
import type { Bounds, Point, StyleSpec, VectorElement } from '../../types/vector';
import { hasPointList } from '../../types/vector';

/** imgPx → unit 的换算参数。 */
export interface ImageToUnit {
  /** 工作图像宽高（像素）。 */
  imageWidth: number;
  imageHeight: number;
  /** 1 个工作图像像素代表多少地图单位（x 方向）。 */
  unitsPerPxX: number;
  /** y 方向；等比时与 x 相同。 */
  unitsPerPxY: number;
}

/**
 * 由项目设置与工作图像尺寸推导 imgPx → unit 变换。
 * 图像整体铺满地图矩形，因此比例即 mapWidth / imageWidth。
 */
export function makeImageToUnit(imageWidth: number, imageHeight: number, s: ProjectSettings): ImageToUnit {
  return {
    imageWidth,
    imageHeight,
    unitsPerPxX: imageWidth > 0 ? s.mapWidth / imageWidth : 1,
    unitsPerPxY: imageHeight > 0 ? s.mapHeight / imageHeight : 1,
  };
}

export function imgToUnit(p: Point, t: ImageToUnit): Point {
  return { x: p.x * t.unitsPerPxX, y: p.y * t.unitsPerPxY };
}

export function unitToImg(p: Point, t: ImageToUnit): Point {
  return { x: t.unitsPerPxX > 0 ? p.x / t.unitsPerPxX : 0, y: t.unitsPerPxY > 0 ? p.y / t.unitsPerPxY : 0 };
}

/** 图像像素长度 → 地图单位长度（用几何平均，避免非等比时方向依赖）。 */
export function imgLengthToUnit(px: number, t: ImageToUnit): number {
  return px * Math.sqrt(Math.abs(t.unitsPerPxX * t.unitsPerPxY));
}

export function unitLengthToImg(u: number, t: ImageToUnit): number {
  const k = Math.sqrt(Math.abs(t.unitsPerPxX * t.unitsPerPxY));
  return k > 0 ? u / k : 0;
}

/* ------------------------------------------------------------------ */
/* unit ↔ canvasPx                                                     */
/* ------------------------------------------------------------------ */

export function unitToCanvas(p: Point, s: ProjectSettings): Point {
  return { x: p.x * pixelsPerUnit(s), y: p.y * pixelsPerUnitY(s) };
}

export function canvasToUnit(p: Point, s: ProjectSettings): Point {
  const sx = pixelsPerUnit(s);
  const sy = pixelsPerUnitY(s);
  return { x: sx > 0 ? p.x / sx : 0, y: sy > 0 ? p.y / sy : 0 };
}

/**
 * 地图单位长度 → 画布像素长度。
 * 非等比时采用几何平均，保证同一个 strokeWidth 在任何方向上换算一致，
 * 不会出现「局部对象比例不一致」。
 */
export function unitLengthToCanvas(u: number, s: ProjectSettings): number {
  const sx = pixelsPerUnit(s);
  const sy = pixelsPerUnitY(s);
  return u * Math.sqrt(Math.abs(sx * sy));
}

export function canvasLengthToUnit(px: number, s: ProjectSettings): number {
  const k = Math.sqrt(Math.abs(pixelsPerUnit(s) * pixelsPerUnitY(s)));
  return k > 0 ? px / k : 0;
}

/** 描边宽度换算：唯一入口，导出与渲染共用。 */
export function strokeWidthToCanvas(style: StyleSpec, s: ProjectSettings, scale = 1): number {
  return unitLengthToCanvas(style.strokeWidth, s) * scale;
}

/** 画布内的默认基准描边宽度（地图单位），随地图尺寸自适应。 */
export function baseStrokeWidthUnit(s: ProjectSettings): number {
  // 目标：约 1.5 画布像素
  return canvasLengthToUnit(1.5, s);
}

/* ------------------------------------------------------------------ */
/* 元素级换算                                                          */
/* ------------------------------------------------------------------ */

export type PointMapper = (p: Point) => Point;

/** 对元素的所有顶点施加映射，返回新元素（不修改原对象）。 */
export function mapElementPoints(el: VectorElement, f: PointMapper): VectorElement {
  switch (el.kind) {
    case 'line':
      return { ...el, a: f(el.a), b: f(el.b) };
    case 'rect': {
      const p0 = f({ x: el.x, y: el.y });
      const p1 = f({ x: el.x + el.w, y: el.y + el.h });
      return {
        ...el,
        x: Math.min(p0.x, p1.x),
        y: Math.min(p0.y, p1.y),
        w: Math.abs(p1.x - p0.x),
        h: Math.abs(p1.y - p0.y),
      };
    }
    default:
      return { ...el, points: el.points.map(f) };
  }
}

/** imgPx 空间的元素 → unit 空间。识别管线出口使用。 */
export function elementImgToUnit(el: VectorElement, t: ImageToUnit): VectorElement {
  const mapped = mapElementPoints(el, (p) => imgToUnit(p, t));
  return {
    ...mapped,
    style: { ...mapped.style, strokeWidth: imgLengthToUnit(el.style.strokeWidth, t) },
  } as VectorElement;
}

/**
 * 地图尺寸变化时的整体重缩放。
 * 所有顶点与 strokeWidth 使用同一组比例因子，保证不出现局部不一致。
 */
export function rescaleElements(
  elements: readonly VectorElement[],
  from: ProjectSettings,
  to: ProjectSettings,
): VectorElement[] {
  const kx = from.mapWidth > 0 ? to.mapWidth / from.mapWidth : 1;
  const ky = from.mapHeight > 0 ? to.mapHeight / from.mapHeight : 1;
  if (kx === 1 && ky === 1) return elements.map((e) => ({ ...e }));
  const kStroke = Math.sqrt(Math.abs(kx * ky));
  return elements.map((el) => {
    const mapped = mapElementPoints(el, (p) => ({ x: p.x * kx, y: p.y * ky }));
    return {
      ...mapped,
      style: { ...mapped.style, strokeWidth: el.style.strokeWidth * kStroke },
    } as VectorElement;
  });
}

/** 吸附阈值等「屏幕像素定义的量」换算到地图单位。 */
export function screenPxToUnit(px: number, viewScale: number): number {
  return viewScale > 0 ? px / viewScale : px;
}

/* ------------------------------------------------------------------ */
/* 精度                                                                */
/* ------------------------------------------------------------------ */

export function roundTo(v: number, precision: number): number {
  const f = 10 ** precision;
  return Math.round(v * f) / f;
}

export function roundPoint(p: Point, precision: number): Point {
  return { x: roundTo(p.x, precision), y: roundTo(p.y, precision) };
}

export function boundsUnitToCanvas(b: Bounds, s: ProjectSettings): Bounds {
  const a = unitToCanvas({ x: b.minX, y: b.minY }, s);
  const c = unitToCanvas({ x: b.maxX, y: b.maxY }, s);
  return { minX: a.x, minY: a.y, maxX: c.x, maxY: c.y };
}

/** 画布矩形（unit 空间），用于越界检查。 */
export function canvasBoundsInUnit(s: ProjectSettings): Bounds {
  return { minX: 0, minY: 0, maxX: s.mapWidth, maxY: s.mapHeight };
}
