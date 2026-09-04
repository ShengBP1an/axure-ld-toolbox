/**
 * 去倾斜：投影方差法估计倾角。
 *
 * 原理：把二值图按候选角度旋转后做水平投影，
 * 当图像正立时，水平墙线会集中到少数几行，投影直方图方差最大。
 * 手绘 LD 草图以水平 / 垂直墙线为主，该方法比 Hough 更快且更稳定。
 *
 * 限制：仅处理 ±15°；超出范围时抛出告警，引导用户手动旋转或透视校正。
 */

import type { BinaryImage } from './IPreprocessor';

export const MAX_AUTO_SKEW_DEG = 15;

export interface DeskewEstimate {
  /** 估计的倾角（度）。正值表示图像需要顺时针旋转该角度才能正立的反向量，
   *  即调用 rotateBinary(img, -angle) 可以矫正。 */
  angle: number;
  /** 最优角度下的投影方差得分。 */
  score: number;
  /** 是否超出自动校正范围。 */
  outOfRange: boolean;
  /** 置信度 0..1：最优分数相对次优分数的优势。 */
  confidence: number;
}

/**
 * 估计倾角。采用「粗扫 1° + 细扫 0.1°」两级搜索，
 * 只对前景像素做投影，复杂度与前景像素数成正比。
 */
export function estimateSkew(img: BinaryImage, maxAngle = MAX_AUTO_SKEW_DEG): DeskewEstimate {
  const points = collectForeground(img, 40000);
  if (points.length < 50) {
    return { angle: 0, score: 0, outOfRange: false, confidence: 0 };
  }

  const coarse = searchAngle(points, img.height, -maxAngle, maxAngle, 1);
  const fine = searchAngle(points, img.height, coarse.best - 1, coarse.best + 1, 0.1);

  const angle = fine.best;
  const outOfRange = Math.abs(angle) >= maxAngle - 0.15;
  // 置信度：最优得分相对平均得分的提升幅度
  const confidence = fine.mean > 0 ? Math.min(1, Math.max(0, (fine.score / fine.mean - 1) / 0.6)) : 0;
  return { angle, score: fine.score, outOfRange, confidence };
}

interface SearchResult {
  best: number;
  score: number;
  mean: number;
}

function searchAngle(
  points: Int32Array,
  height: number,
  from: number,
  to: number,
  step: number,
): SearchResult {
  let best = 0;
  let bestScore = -1;
  let sum = 0;
  let n = 0;
  const buckets = new Float64Array(height + 1);

  for (let deg = from; deg <= to + 1e-9; deg += step) {
    const rad = (deg * Math.PI) / 180;
    const sin = Math.sin(rad);
    const cos = Math.cos(rad);
    buckets.fill(0);
    // 旋转 -deg 后的 y 坐标投影
    for (let i = 0; i < points.length; i += 2) {
      const x = points[i]!;
      const y = points[i + 1]!;
      const ry = Math.round(-x * sin + y * cos);
      if (ry >= 0 && ry <= height) buckets[ry]++;
    }
    const score = variance(buckets);
    sum += score;
    n++;
    if (score > bestScore) {
      bestScore = score;
      best = deg;
    }
  }
  return { best: Math.round(best * 100) / 100, score: bestScore, mean: n > 0 ? sum / n : 0 };
}

function variance(arr: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i]!;
  const mean = sum / arr.length;
  let v = 0;
  for (let i = 0; i < arr.length; i++) v += (arr[i]! - mean) ** 2;
  return v / arr.length;
}

/** 采样前景像素坐标（超过上限时均匀抽样，控制性能）。 */
function collectForeground(img: BinaryImage, maxSamples: number): Int32Array {
  const { width: w, height: h, data } = img;
  let total = 0;
  for (let i = 0; i < data.length; i++) if (data[i]! !== 0) total++;
  if (total === 0) return new Int32Array(0);

  const stride = total > maxSamples ? Math.ceil(total / maxSamples) : 1;
  const count = Math.ceil(total / stride);
  const out = new Int32Array(count * 2);
  let seen = 0;
  let k = 0;
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      if (data[off + x]! === 0) continue;
      if (seen % stride === 0 && k + 1 < out.length) {
        out[k] = x;
        out[k + 1] = y;
        k += 2;
      }
      seen++;
    }
  }
  return k === out.length ? out : out.slice(0, k);
}

/**
 * 旋转二值图（最近邻，保持二值性）。
 * 输出画布扩大以避免裁掉内容。
 */
export function rotateBinary(img: BinaryImage, degrees: number): BinaryImage {
  if (Math.abs(degrees) < 0.01) {
    return { data: new Uint8Array(img.data), width: img.width, height: img.height };
  }
  const rad = (degrees * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const { width: w, height: h } = img;

  const nw = Math.ceil(Math.abs(w * cos) + Math.abs(h * sin));
  const nh = Math.ceil(Math.abs(w * sin) + Math.abs(h * cos));
  const out = new Uint8Array(nw * nh);

  const cx = w / 2;
  const cy = h / 2;
  const ncx = nw / 2;
  const ncy = nh / 2;

  // 反向映射：遍历目标像素，回查源像素（避免空洞）
  for (let y = 0; y < nh; y++) {
    const dy = y - ncy;
    const off = y * nw;
    for (let x = 0; x < nw; x++) {
      const dx = x - ncx;
      const sx = Math.round(dx * cos + dy * sin + cx);
      const sy = Math.round(-dx * sin + dy * cos + cy);
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      out[off + x] = img.data[sy * w + sx]!;
    }
  }
  return { data: out, width: nw, height: nh };
}

/** 旋转灰度图（双线性插值，保持预览平滑）。 */
export function rotateGray(
  data: Uint8Array,
  w: number,
  h: number,
  degrees: number,
): { data: Uint8Array; width: number; height: number } {
  if (Math.abs(degrees) < 0.01) return { data: new Uint8Array(data), width: w, height: h };
  const rad = (degrees * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const nw = Math.ceil(Math.abs(w * cos) + Math.abs(h * sin));
  const nh = Math.ceil(Math.abs(w * sin) + Math.abs(h * cos));
  const out = new Uint8Array(nw * nh).fill(255);

  const cx = w / 2;
  const cy = h / 2;
  const ncx = nw / 2;
  const ncy = nh / 2;

  for (let y = 0; y < nh; y++) {
    const dy = y - ncy;
    const off = y * nw;
    for (let x = 0; x < nw; x++) {
      const dx = x - ncx;
      const fx = dx * cos + dy * sin + cx;
      const fy = -dx * sin + dy * cos + cy;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) continue;
      const tx = fx - x0;
      const ty = fy - y0;
      const p00 = data[y0 * w + x0]!;
      const p10 = data[y0 * w + x0 + 1]!;
      const p01 = data[(y0 + 1) * w + x0]!;
      const p11 = data[(y0 + 1) * w + x0 + 1]!;
      const top = p00 + (p10 - p00) * tx;
      const bot = p01 + (p11 - p01) * tx;
      out[off + x] = Math.round(top + (bot - top) * ty);
    }
  }
  return { data: out, width: nw, height: nh };
}
