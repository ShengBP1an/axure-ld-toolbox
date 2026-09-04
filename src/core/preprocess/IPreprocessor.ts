/**
 * 预处理模块接口 —— 明确的可替换边界。
 *
 * 默认实现为 PreprocessorTs（纯 TypeScript，零依赖，可在 Worker 与 Node 测试中运行）。
 * 若未来引入 OpenCV.js，只需新增实现本接口的 PreprocessorCv，
 * 识别层与导出层无需任何改动。
 */

import type { PreprocessParams } from '../../types/project';
import type { PipelineError } from '../../types/errors';

/** 单通道灰度图。 */
export interface GrayImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/** 二值图：1 = 前景（笔画），0 = 背景。 */
export interface BinaryImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/** 预处理输入：已解码的 RGBA 像素。 */
export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type PreprocessWarningCode = 'LOW_CONTRAST' | 'TOO_NOISY' | 'DESKEW_OUT_OF_RANGE' | 'SPARSE_FOREGROUND' | 'DENSE_FOREGROUND';

export interface PreprocessWarning {
  code: PreprocessWarningCode;
  message: string;
  /** 相关的度量值，便于 UI 展示与调参。 */
  metric?: number;
}

export interface PreprocessOutput {
  binary: BinaryImage;
  /** 二值化前的灰度图，供 UI 预览「预处理图」。 */
  gray: GrayImage;
  /** 工作图像相对原图的下采样因子（>1 表示已缩小）。 */
  downscale: number;
  /** 自动检测并已应用的倾斜角（度，正为顺时针）。 */
  appliedSkew: number;
  /** 前景像素占比。 */
  foregroundRatio: number;
  /** 灰度直方图的对比度度量（Otsu 类间方差归一化，0..1）。 */
  contrastScore: number;
  warnings: PreprocessWarning[];
  timings: Record<string, number>;
}

export interface IPreprocessor {
  readonly name: string;
  /**
   * 执行预处理。
   * @throws PipelineError 代码为 DECODE_FAILED / LOW_CONTRAST（致命级）/ PERSPECTIVE_INVALID
   */
  run(input: RgbaImage, params: PreprocessParams, onProgress?: (p: number, stage: string) => void): PreprocessOutput;
}

export function createGray(width: number, height: number): GrayImage {
  return { data: new Uint8Array(width * height), width, height };
}

export function createBinary(width: number, height: number): BinaryImage {
  return { data: new Uint8Array(width * height), width, height };
}

export function cloneBinary(img: BinaryImage): BinaryImage {
  return { data: new Uint8Array(img.data), width: img.width, height: img.height };
}

/** 前景像素计数。 */
export function countForeground(img: BinaryImage): number {
  let n = 0;
  const d = img.data;
  for (let i = 0; i < d.length; i++) if (d[i]! !== 0) n++;
  return n;
}

export function foregroundRatio(img: BinaryImage): number {
  const total = img.width * img.height;
  return total > 0 ? countForeground(img) / total : 0;
}

/** 边界安全的像素读取（越界返回 0）。 */
export function getPx(img: GrayImage | BinaryImage, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 0;
  return img.data[y * img.width + x]!;
}

export function setPx(img: GrayImage | BinaryImage, x: number, y: number, v: number): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  img.data[y * img.width + x] = v;
}

/** 将二值图转为可预览的 RGBA（前景深色，背景透明）。 */
export function binaryToRgba(img: BinaryImage, color: [number, number, number] = [10, 14, 20]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(img.width * img.height * 4);
  const [r, g, b] = color;
  for (let i = 0; i < img.data.length; i++) {
    const on = img.data[i]! !== 0;
    const o = i * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = on ? 255 : 0;
  }
  return out;
}

/** 将灰度图转为 RGBA 预览。 */
export function grayToRgba(img: GrayImage): Uint8ClampedArray {
  const out = new Uint8ClampedArray(img.width * img.height * 4);
  for (let i = 0; i < img.data.length; i++) {
    const v = img.data[i]!;
    const o = i * 4;
    out[o] = v;
    out[o + 1] = v;
    out[o + 2] = v;
    out[o + 3] = 255;
  }
  return out;
}

export type { PreprocessParams, PipelineError };
