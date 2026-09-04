/**
 * 灰度化、对比度增强与阴影抑制。
 */

import type { GrayImage, RgbaImage } from './IPreprocessor';
import { boxBlur, buildIntegral, windowMean } from './integralImage';

/**
 * 加权灰度（ITU-R BT.601）。
 * 手绘草图的笔迹通常为深色铅笔 / 墨水，亮度通道足以分离。
 */
export function toGray(img: RgbaImage): GrayImage {
  const { data, width, height } = img;
  const out = new Uint8Array(width * height);
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const a = data[i + 3]!;
    let v = (r * 299 + g * 587 + b * 114) / 1000;
    // 透明区域按白纸处理，避免 PNG 透明底被当作黑色笔画
    if (a < 255) v = v * (a / 255) + 255 * (1 - a / 255);
    out[j] = v;
  }
  return { data: out, width, height };
}

/** 反相（用于浅色笔画画在深色背景的情形）。 */
export function invert(img: GrayImage): GrayImage {
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < out.length; i++) out[i] = 255 - img.data[i]!;
  return { data: out, width: img.width, height: img.height };
}

export interface Histogram {
  bins: Uint32Array;
  total: number;
}

export function histogram(img: GrayImage): Histogram {
  const bins = new Uint32Array(256);
  for (let i = 0; i < img.data.length; i++) bins[img.data[i]!]++;
  return { bins, total: img.data.length };
}

/**
 * 直方图拉伸：把 [pLow, pHigh] 百分位映射到 [0,255]。
 * 相较全局线性拉伸更抗少量极端像素（污点、闪光）。
 *
 * 安全阀 minRange：当源动态范围过窄时**不做拉伸**。
 * 否则近空白图（例如纯白纸）中仅由舍入产生的 2~3 级灰度差
 * 会被放大到满量程，凭空造出"笔画"，让空白图被误识别为有内容。
 */
export function stretchContrast(img: GrayImage, pLow = 0.01, pHigh = 0.99, minRange = 16): GrayImage {
  const { bins, total } = histogram(img);
  const loTarget = total * pLow;
  const hiTarget = total * pHigh;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += bins[v]!;
    if (acc >= loTarget) {
      lo = v;
      break;
    }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += bins[v]!;
    if (acc >= total - hiTarget) {
      hi = v;
      break;
    }
  }
  // 动态范围过窄 → 图像几乎无内容，拉伸只会放大噪声
  if (hi - lo < minRange) {
    return { data: new Uint8Array(img.data), width: img.width, height: img.height };
  }

  const lut = new Uint8Array(256);
  const range = hi - lo;
  for (let v = 0; v < 256; v++) {
    const t = ((v - lo) / range) * 255;
    lut[v] = t < 0 ? 0 : t > 255 ? 255 : Math.round(t);
  }
  const out = new Uint8Array(img.data.length);
  for (let i = 0; i < out.length; i++) out[i] = lut[img.data[i]!]!;
  return { data: out, width: img.width, height: img.height };
}

/**
 * CLAHE 近似：分块直方图均衡 + 双线性插值 + 对比度限幅。
 * 相比全局均衡，能同时提亮阴影区的浅笔画而不过度放大噪声。
 *
 * @param strength 0..1，0 为不处理（返回原图副本），1 为完全应用块均衡结果
 * @param tiles 每边的块数
 * @param clipLimit 直方图裁剪比例，抑制噪声放大
 */
export function claheApprox(img: GrayImage, strength: number, tiles = 8, clipLimit = 2.5): GrayImage {
  const src = new Uint8Array(img.data);
  if (strength <= 0) return { data: src, width: img.width, height: img.height };

  const { width: w, height: h } = img;
  const tx = Math.max(1, Math.min(tiles, Math.floor(w / 16) || 1));
  const ty = Math.max(1, Math.min(tiles, Math.floor(h / 16) || 1));
  const tileW = w / tx;
  const tileH = h / ty;

  // 每个块的映射 LUT
  const luts: Uint8Array[] = [];
  for (let by = 0; by < ty; by++) {
    for (let bx = 0; bx < tx; bx++) {
      const x0 = Math.floor(bx * tileW);
      const x1 = Math.min(w, Math.floor((bx + 1) * tileW));
      const y0 = Math.floor(by * tileH);
      const y1 = Math.min(h, Math.floor((by + 1) * tileH));
      const bins = new Uint32Array(256);
      let count = 0;
      for (let y = y0; y < y1; y++) {
        const off = y * w;
        for (let x = x0; x < x1; x++) {
          bins[src[off + x]!]++;
          count++;
        }
      }
      luts.push(buildClipLut(bins, count, clipLimit));
    }
  }

  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    // 块中心插值坐标
    const fy = y / tileH - 0.5;
    const by0 = Math.max(0, Math.min(ty - 1, Math.floor(fy)));
    const by1 = Math.max(0, Math.min(ty - 1, by0 + 1));
    const wy = Math.max(0, Math.min(1, fy - by0));
    const off = y * w;
    for (let x = 0; x < w; x++) {
      const fx = x / tileW - 0.5;
      const bx0 = Math.max(0, Math.min(tx - 1, Math.floor(fx)));
      const bx1 = Math.max(0, Math.min(tx - 1, bx0 + 1));
      const wx = Math.max(0, Math.min(1, fx - bx0));
      const v = src[off + x]!;

      const v00 = luts[by0 * tx + bx0]![v]!;
      const v01 = luts[by0 * tx + bx1]![v]!;
      const v10 = luts[by1 * tx + bx0]![v]!;
      const v11 = luts[by1 * tx + bx1]![v]!;
      const top = v00 + (v01 - v00) * wx;
      const bot = v10 + (v11 - v10) * wx;
      const eq = top + (bot - top) * wy;
      out[off + x] = Math.round(v + (eq - v) * strength);
    }
  }
  return { data: out, width: w, height: h };
}

function buildClipLut(bins: Uint32Array, count: number, clipLimit: number): Uint8Array {
  const lut = new Uint8Array(256);
  if (count <= 0) {
    for (let v = 0; v < 256; v++) lut[v] = v;
    return lut;
  }
  // 裁剪超过限幅的计数并均匀重分配
  const limit = Math.max(1, Math.floor((clipLimit * count) / 256));
  let excess = 0;
  const clipped = new Uint32Array(256);
  for (let v = 0; v < 256; v++) {
    const c = bins[v]!;
    if (c > limit) {
      excess += c - limit;
      clipped[v] = limit;
    } else {
      clipped[v] = c;
    }
  }
  const redistribute = Math.floor(excess / 256);
  for (let v = 0; v < 256; v++) clipped[v] += redistribute;

  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += clipped[v]!;
    lut[v] = Math.round((acc / count) * 255);
  }
  return lut;
}

/**
 * 阴影抑制：用大核背景估计做「除法归一化」。
 *
 * 原理：拍照阴影是缓变的低频光照场，笔画是高频细节。
 * 用大半径盒式模糊估计背景亮度 B，再计算 out = clamp(src / B * 255)，
 * 即可把不均匀光照拉平，同时保留笔画的相对暗度。
 *
 * @param strength 0..1，控制归一化程度
 */
export function suppressShadow(img: GrayImage, strength: number): GrayImage {
  const src = new Uint8Array(img.data);
  if (strength <= 0) return { data: src, width: img.width, height: img.height };

  // 半径取图像短边的 1/8，足以覆盖阴影尺度且不吃掉墙线
  const radius = Math.max(8, Math.round(Math.min(img.width, img.height) / 8));
  const bg = boxBlur(img, radius);
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const b = Math.max(1, bg.data[i]!);
    const normalized = Math.min(255, (src[i]! / b) * 220);
    out[i] = Math.round(src[i]! + (normalized - src[i]!) * strength);
  }
  return { data: out, width: img.width, height: img.height };
}

/**
 * 判断笔画是深色还是浅色。返回 true 表示笔画为深色（白纸黑线，常规情形）。
 *
 * 判据：以「众数所在灰阶」为纸面基准 —— 线稿中背景像素远多于笔画像素，
 * 因此直方图众数一定是纸面。若纸面偏亮，则笔画必然是暗的。
 *
 * 早期实现用「均值与 p10/p90 中点比较」，在稀疏线稿上会失效：
 * 笔画只占 5% 左右时 p10 与 p90 都落在纸面灰阶，中点等于纸面值，
 * 而均值略低于纸面值，于是得出「笔画是浅色」的相反结论。
 */
export function detectDarkStrokes(img: GrayImage): boolean {
  const { bins, total } = histogram(img);
  if (total === 0) return true;

  // 众数（纸面）灰阶
  let modeBin = 0;
  let modeCount = -1;
  for (let v = 0; v < 256; v++) {
    if (bins[v]! > modeCount) {
      modeCount = bins[v]!;
      modeBin = v;
    }
  }

  // 统计比纸面明显更暗 / 更亮的像素量
  const margin = 30;
  let darker = 0;
  let lighter = 0;
  for (let v = 0; v < 256; v++) {
    if (v < modeBin - margin) darker += bins[v]!;
    else if (v > modeBin + margin) lighter += bins[v]!;
  }

  // 纸面偏亮 → 笔画只能更暗
  if (modeBin >= 160) return true;
  // 纸面偏暗 → 笔画只能更亮
  if (modeBin <= 95) return false;
  // 中间灰纸面：取偏离量更大的一侧为笔画
  return darker >= lighter;
}

/** 局部对比度度量：窗口标准差的均值，归一化到 0..1。用于低对比度告警。 */
export function localContrastScore(img: GrayImage, radius = 12): number {
  const ii = buildIntegral(img);
  let acc = 0;
  let n = 0;
  const step = Math.max(1, Math.floor(Math.min(img.width, img.height) / 128));
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const mean = windowMean(ii, x, y, radius);
      acc += Math.abs(img.data[y * img.width + x]! - mean);
      n++;
    }
  }
  return n > 0 ? Math.min(1, acc / n / 40) : 0;
}
