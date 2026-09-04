/**
 * 视口变换：屏幕像素 ↔ 地图单位。
 *
 * 约定：screen = unit * scale + offset
 * scale 的含义是「1 个地图单位对应多少屏幕像素」。
 */

import type { ViewportState } from '../types/editor';
import type { Bounds, Point } from '../types/vector';

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 400;

export function unitToScreen(p: Point, v: ViewportState): Point {
  return { x: p.x * v.scale + v.offsetX, y: p.y * v.scale + v.offsetY };
}

export function screenToUnit(p: Point, v: ViewportState): Point {
  return { x: (p.x - v.offsetX) / v.scale, y: (p.y - v.offsetY) / v.scale };
}

export function unitLengthToScreen(len: number, v: ViewportState): number {
  return len * v.scale;
}

export function screenLengthToUnit(len: number, v: ViewportState): number {
  return v.scale > 0 ? len / v.scale : len;
}

export function clampScale(s: number): number {
  return s < MIN_SCALE ? MIN_SCALE : s > MAX_SCALE ? MAX_SCALE : s;
}

/** 以某个屏幕锚点为中心缩放（保证锚点下的内容不动）。 */
export function zoomAt(v: ViewportState, screenAnchor: Point, factor: number): ViewportState {
  const nextScale = clampScale(v.scale * factor);
  const actualFactor = nextScale / v.scale;
  return {
    scale: nextScale,
    offsetX: screenAnchor.x - (screenAnchor.x - v.offsetX) * actualFactor,
    offsetY: screenAnchor.y - (screenAnchor.y - v.offsetY) * actualFactor,
  };
}

export function pan(v: ViewportState, dx: number, dy: number): ViewportState {
  return { ...v, offsetX: v.offsetX + dx, offsetY: v.offsetY + dy };
}

/** 适应窗口：让给定的 unit 空间矩形完整可见并居中。 */
export function fitBounds(
  bounds: Bounds,
  viewWidth: number,
  viewHeight: number,
  padding = 40,
): ViewportState {
  const w = Math.max(1e-6, bounds.maxX - bounds.minX);
  const h = Math.max(1e-6, bounds.maxY - bounds.minY);
  const availW = Math.max(1, viewWidth - padding * 2);
  const availH = Math.max(1, viewHeight - padding * 2);
  const scale = clampScale(Math.min(availW / w, availH / h));

  return {
    scale,
    offsetX: (viewWidth - w * scale) / 2 - bounds.minX * scale,
    offsetY: (viewHeight - h * scale) / 2 - bounds.minY * scale,
  };
}

/** 让某个 unit 坐标点居中（用于问题跳转定位）。 */
export function centerOn(v: ViewportState, target: Point, viewWidth: number, viewHeight: number): ViewportState {
  return {
    scale: v.scale,
    offsetX: viewWidth / 2 - target.x * v.scale,
    offsetY: viewHeight / 2 - target.y * v.scale,
  };
}

/**
 * 跳转到某个区域：必要时缩放到能看清，然后居中。
 * minScale 保证极小对象也能被看到。
 */
export function focusBounds(
  bounds: Bounds,
  viewWidth: number,
  viewHeight: number,
  current: ViewportState,
  minVisiblePx = 160,
): ViewportState {
  const w = Math.max(1e-6, bounds.maxX - bounds.minX);
  const h = Math.max(1e-6, bounds.maxY - bounds.minY);
  const neededScale = Math.min(minVisiblePx / w, minVisiblePx / h);
  const scale = clampScale(Math.max(current.scale, Math.min(neededScale, 40)));
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return {
    scale,
    offsetX: viewWidth / 2 - cx * scale,
    offsetY: viewHeight / 2 - cy * scale,
  };
}

/** 当前视口可见的 unit 空间范围（用于视锥剔除）。 */
export function visibleBounds(v: ViewportState, viewWidth: number, viewHeight: number): Bounds {
  const tl = screenToUnit({ x: 0, y: 0 }, v);
  const br = screenToUnit({ x: viewWidth, y: viewHeight }, v);
  return { minX: tl.x, minY: tl.y, maxX: br.x, maxY: br.y };
}
