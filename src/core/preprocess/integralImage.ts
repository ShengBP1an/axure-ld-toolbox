/**
 * 积分图（Summed-Area Table）。
 * 使自适应二值化的任意窗口求和降为 O(1)，整体复杂度 O(N)。
 */

import type { GrayImage } from './IPreprocessor';

export interface IntegralImage {
  /** (width+1) * (height+1)，第 0 行 / 列为 0 以简化边界处理。 */
  sum: Float64Array;
  width: number;
  height: number;
}

export function buildIntegral(img: GrayImage): IntegralImage {
  const { width: w, height: h, data } = img;
  const sw = w + 1;
  const sum = new Float64Array(sw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const rowOff = y * w;
    const outOff = (y + 1) * sw;
    const prevOff = y * sw;
    for (let x = 0; x < w; x++) {
      rowSum += data[rowOff + x]!;
      sum[outOff + x + 1] = sum[prevOff + x + 1]! + rowSum;
    }
  }
  return { sum, width: w, height: h };
}

/** 平方积分图，用于计算局部方差（Sauvola / 噪声度量）。 */
export function buildIntegralSquared(img: GrayImage): IntegralImage {
  const { width: w, height: h, data } = img;
  const sw = w + 1;
  const sum = new Float64Array(sw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const rowOff = y * w;
    const outOff = (y + 1) * sw;
    const prevOff = y * sw;
    for (let x = 0; x < w; x++) {
      const v = data[rowOff + x]!;
      rowSum += v * v;
      sum[outOff + x + 1] = sum[prevOff + x + 1]! + rowSum;
    }
  }
  return { sum, width: w, height: h };
}

/**
 * 求矩形区域 [x0,x1] × [y0,y1]（含端点）的像素和。
 * 坐标会被钳制到图像范围内。
 */
export function rectSum(ii: IntegralImage, x0: number, y0: number, x1: number, y1: number): number {
  const w = ii.width;
  const h = ii.height;
  const sw = w + 1;
  const ax = x0 < 0 ? 0 : x0;
  const ay = y0 < 0 ? 0 : y0;
  const bx = x1 >= w ? w - 1 : x1;
  const by = y1 >= h ? h - 1 : y1;
  if (bx < ax || by < ay) return 0;
  const s = ii.sum;
  return s[(by + 1) * sw + bx + 1]! - s[ay * sw + bx + 1]! - s[(by + 1) * sw + ax]! + s[ay * sw + ax]!;
}

/** 矩形区域内的有效像素个数（已钳制）。 */
export function rectCount(ii: IntegralImage, x0: number, y0: number, x1: number, y1: number): number {
  const ax = x0 < 0 ? 0 : x0;
  const ay = y0 < 0 ? 0 : y0;
  const bx = x1 >= ii.width ? ii.width - 1 : x1;
  const by = y1 >= ii.height ? ii.height - 1 : y1;
  if (bx < ax || by < ay) return 0;
  return (bx - ax + 1) * (by - ay + 1);
}

/** 以 (x,y) 为中心、半径 r 的窗口均值。 */
export function windowMean(ii: IntegralImage, x: number, y: number, r: number): number {
  const s = rectSum(ii, x - r, y - r, x + r, y + r);
  const c = rectCount(ii, x - r, y - r, x + r, y + r);
  return c > 0 ? s / c : 0;
}

/** 以 (x,y) 为中心、半径 r 的窗口标准差。 */
export function windowStd(ii: IntegralImage, ii2: IntegralImage, x: number, y: number, r: number): number {
  const c = rectCount(ii, x - r, y - r, x + r, y + r);
  if (c <= 1) return 0;
  const s = rectSum(ii, x - r, y - r, x + r, y + r);
  const s2 = rectSum(ii2, x - r, y - r, x + r, y + r);
  const mean = s / c;
  const variance = Math.max(0, s2 / c - mean * mean);
  return Math.sqrt(variance);
}

/**
 * 用积分图做快速盒式模糊（近似高斯），供阴影背景估计使用。
 * radius 较大时性能仍为 O(N)。
 */
export function boxBlur(img: GrayImage, radius: number): GrayImage {
  if (radius <= 0) return { data: new Uint8Array(img.data), width: img.width, height: img.height };
  const ii = buildIntegral(img);
  const out = new Uint8Array(img.width * img.height);
  for (let y = 0; y < img.height; y++) {
    const off = y * img.width;
    for (let x = 0; x < img.width; x++) {
      out[off + x] = Math.round(windowMean(ii, x, y, radius));
    }
  }
  return { data: out, width: img.width, height: img.height };
}
