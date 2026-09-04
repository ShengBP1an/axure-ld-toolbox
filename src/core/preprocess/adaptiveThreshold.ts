/**
 * 二值化：Bradley-Roth 自适应阈值 + Otsu 全局兜底。
 *
 * 选择理由：
 *   - 手绘草图常有不均匀光照与阴影，全局阈值会整块丢线或整块糊成实心；
 *   - Bradley-Roth 用积分图做局部均值比较，复杂度 O(N)，无需逐窗口重算；
 *   - 当自适应结果的前景占比异常（过稀或过密，说明局部对比不足）时，
 *     回退 Otsu 全局阈值，避免输出全黑 / 全白。
 */

import type { BinaryImage, GrayImage } from './IPreprocessor';
import { buildIntegral, rectCount, rectSum } from './integralImage';
import { histogram } from './grayscale';

export interface ThresholdOptions {
  /** 窗口半径（像素）。经验值：约为笔画宽度的 6~10 倍。 */
  radius: number;
  /** 相对偏置 0..1：像素需比窗口均值暗 (1-bias) 倍才判为前景。 */
  bias: number;
  /** 前景为深色（true）时判定 v < mean*(1-bias)。 */
  darkStrokes: boolean;
  /** 自适应结果异常时是否回退 Otsu。 */
  otsuFallback: boolean;
}

export interface ThresholdResult {
  binary: BinaryImage;
  /** 实际使用的方法。 */
  method: 'adaptive' | 'otsu';
  foregroundRatio: number;
  /** Otsu 阈值（无论是否采用都会计算，用于对比度评估）。 */
  otsuThreshold: number;
  /** Otsu 类间方差归一化值（0..1），作为对比度分数。 */
  otsuSeparability: number;
}

/** 前景占比的合理区间：手绘线稿通常在 1%~35%。 */
const MIN_REASONABLE_RATIO = 0.004;
const MAX_REASONABLE_RATIO = 0.42;

export function adaptiveThreshold(img: GrayImage, opts: ThresholdOptions): ThresholdResult {
  const { width: w, height: h } = img;
  const ii = buildIntegral(img);
  const bin = new Uint8Array(w * h);
  const r = Math.max(1, Math.round(opts.radius));
  const bias = Math.max(0, Math.min(0.9, opts.bias));

  let fg = 0;
  for (let y = 0; y < h; y++) {
    const off = y * w;
    const y0 = y - r;
    const y1 = y + r;
    for (let x = 0; x < w; x++) {
      const sum = rectSum(ii, x - r, y0, x + r, y1);
      const cnt = rectCount(ii, x - r, y0, x + r, y1);
      const mean = cnt > 0 ? sum / cnt : 128;
      const v = img.data[off + x]!;
      const on = opts.darkStrokes ? v < mean * (1 - bias) : v > mean * (1 + bias);
      if (on) {
        bin[off + x] = 1;
        fg++;
      }
    }
  }

  const total = w * h;
  const ratio = total > 0 ? fg / total : 0;
  const otsu = otsuThreshold(img);

  const abnormal = ratio < MIN_REASONABLE_RATIO || ratio > MAX_REASONABLE_RATIO;
  if (opts.otsuFallback && abnormal) {
    const fallback = applyGlobalThreshold(img, otsu.threshold, opts.darkStrokes);
    // 只有在 Otsu 结果更合理时才采用
    const fbRatio = fallback.ratio;
    if (fbRatio >= MIN_REASONABLE_RATIO && fbRatio <= MAX_REASONABLE_RATIO) {
      return {
        binary: { data: fallback.data, width: w, height: h },
        method: 'otsu',
        foregroundRatio: fbRatio,
        otsuThreshold: otsu.threshold,
        otsuSeparability: otsu.separability,
      };
    }
  }

  return {
    binary: { data: bin, width: w, height: h },
    method: 'adaptive',
    foregroundRatio: ratio,
    otsuThreshold: otsu.threshold,
    otsuSeparability: otsu.separability,
  };
}

export interface OtsuResult {
  threshold: number;
  /** 类间方差 / 总方差，0..1。越接近 1 说明前后景分离度越好（对比度好）。 */
  separability: number;
}

/** Otsu 全局阈值：最大化类间方差。 */
export function otsuThreshold(img: GrayImage): OtsuResult {
  const { bins, total } = histogram(img);
  if (total === 0) return { threshold: 128, separability: 0 };

  let sumAll = 0;
  for (let v = 0; v < 256; v++) sumAll += v * bins[v]!;
  const meanAll = sumAll / total;

  let totalVar = 0;
  for (let v = 0; v < 256; v++) totalVar += bins[v]! * (v - meanAll) ** 2;
  totalVar /= total;

  let wB = 0;
  let sumB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += bins[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * bins[t]!;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = (wB / total) * (wF / total) * (mB - mF) ** 2;
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return {
    threshold: best,
    separability: totalVar > 0 ? Math.min(1, bestVar / totalVar) : 0,
  };
}

export function applyGlobalThreshold(
  img: GrayImage,
  threshold: number,
  darkStrokes: boolean,
): { data: Uint8Array; ratio: number } {
  const out = new Uint8Array(img.data.length);
  let fg = 0;
  for (let i = 0; i < out.length; i++) {
    const v = img.data[i]!;
    const on = darkStrokes ? v <= threshold : v > threshold;
    if (on) {
      out[i] = 1;
      fg++;
    }
  }
  return { data: out, ratio: out.length > 0 ? fg / out.length : 0 };
}

/**
 * Sauvola 变体（可选，对纸张纹理更稳健）。
 * 保留为备选路径：当 Bradley-Roth 在强纹理背景上产生大量噪点时可切换。
 */
export function sauvolaThreshold(
  img: GrayImage,
  radius: number,
  k = 0.2,
  R = 128,
  darkStrokes = true,
): BinaryImage {
  const { width: w, height: h } = img;
  const ii = buildIntegral(img);
  const sq: GrayImage = { data: img.data, width: w, height: h };
  // 平方积分图需单独构建
  const sw = w + 1;
  const sum2 = new Float64Array(sw * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const rowOff = y * w;
    const outOff = (y + 1) * sw;
    const prevOff = y * sw;
    for (let x = 0; x < w; x++) {
      const v = sq.data[rowOff + x]!;
      rowSum += v * v;
      sum2[outOff + x + 1] = sum2[prevOff + x + 1]! + rowSum;
    }
  }

  const out = new Uint8Array(w * h);
  const r = Math.max(1, Math.round(radius));
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      const cnt = rectCount(ii, x - r, y - r, x + r, y + r);
      if (cnt === 0) continue;
      const s1 = rectSum(ii, x - r, y - r, x + r, y + r);
      const ax = Math.max(0, x - r);
      const ay = Math.max(0, y - r);
      const bx = Math.min(w - 1, x + r);
      const by = Math.min(h - 1, y + r);
      const s2 =
        sum2[(by + 1) * sw + bx + 1]! - sum2[ay * sw + bx + 1]! - sum2[(by + 1) * sw + ax]! + sum2[ay * sw + ax]!;
      const mean = s1 / cnt;
      const std = Math.sqrt(Math.max(0, s2 / cnt - mean * mean));
      const t = mean * (1 + k * (std / R - 1));
      const v = img.data[off + x]!;
      out[off + x] = (darkStrokes ? v < t : v > t) ? 1 : 0;
    }
  }
  return { data: out, width: w, height: h };
}
