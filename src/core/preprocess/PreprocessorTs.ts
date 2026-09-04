/**
 * PreprocessorTs —— IPreprocessor 的默认纯 TypeScript 实现。
 *
 * 处理顺序（固定，保证可复现）：
 *   灰度化 → 阴影抑制 → 对比度增强（CLAHE 近似）→ 直方图拉伸
 *   → 自适应二值化 → 形态学开/闭 → 小噪点过滤 → 去倾斜
 *
 * 每一步都可通过 PreprocessParams 单独关闭，用于「撤销自动校正」。
 * 本实现不依赖 DOM，可在 Web Worker 与 Node 测试中运行。
 */

import { PipelineError } from '../../types/errors';
import type { PreprocessParams } from '../../types/project';
import {
  claheApprox,
  detectDarkStrokes,
  invert,
  stretchContrast,
  suppressShadow,
  toGray,
} from './grayscale';
import { adaptiveThreshold } from './adaptiveThreshold';
import { close, open, removeSmallBlobs } from './morphology';
import { estimateSkew, MAX_AUTO_SKEW_DEG, rotateBinary, rotateGray } from './deskew';
import type {
  BinaryImage,
  GrayImage,
  IPreprocessor,
  PreprocessOutput,
  PreprocessWarning,
  RgbaImage,
} from './IPreprocessor';
import { Stopwatch } from '../../lib/logger';

/** 对比度分数低于此值时给出告警（不阻断，但提示可能识别不可靠）。 */
const LOW_CONTRAST_THRESHOLD = 0.18;
/** 前景占比高于此值时视为噪声过强 / 二值化失控。 */
const NOISY_FOREGROUND_THRESHOLD = 0.38;
/** 前景占比低于此值时视为几乎无内容。 */
const SPARSE_FOREGROUND_THRESHOLD = 0.0025;

export class PreprocessorTs implements IPreprocessor {
  readonly name = 'PreprocessorTs';

  run(
    input: RgbaImage,
    params: PreprocessParams,
    onProgress?: (p: number, stage: string) => void,
  ): PreprocessOutput {
    if (input.width <= 0 || input.height <= 0) {
      throw new PipelineError('DECODE_FAILED', { width: input.width, height: input.height });
    }

    const sw = new Stopwatch();
    const warnings: PreprocessWarning[] = [];
    const report = (p: number, stage: string): void => onProgress?.(p, stage);

    /* 1) 灰度化 */
    report(0.05, '灰度化');
    let gray: GrayImage = toGray(input);
    sw.mark('grayscale');

    /* 笔画极性判定：浅色线画在深色背景上时需反相 */
    const autoDark = detectDarkStrokes(gray);
    const darkStrokes = params.darkStrokes;
    if (darkStrokes !== autoDark) {
      // 用户设置与自动检测不一致时按用户设置执行，但记录提示
      warnings.push({
        code: 'LOW_CONTRAST',
        message: `自动检测认为笔画为${autoDark ? '深' : '浅'}色，与当前设置不同；若识别结果异常可切换「线条颜色」。`,
      });
    }
    if (!darkStrokes) {
      gray = invert(gray);
    }

    /* 2) 阴影抑制 */
    if (params.shadowSuppress > 0) {
      report(0.18, '阴影抑制');
      gray = suppressShadow(gray, params.shadowSuppress);
    }
    sw.mark('shadowSuppress');

    /* 3) 对比度增强 */
    if (params.contrastBoost > 0) {
      report(0.32, '对比度增强');
      gray = claheApprox(gray, params.contrastBoost);
      gray = stretchContrast(gray, 0.012, 0.988);
    }
    sw.mark('contrast');

    /* 4) 自适应二值化 */
    report(0.48, '二值化');
    const radius = clampRadius(params.thresholdRadius, gray.width, gray.height);
    const th = adaptiveThreshold(gray, {
      radius,
      bias: params.thresholdBias,
      // 反相后前景恒为「深色」
      darkStrokes: true,
      otsuFallback: params.otsuFallback,
    });
    let binary: BinaryImage = th.binary;
    sw.mark('threshold');

    const contrastScore = th.otsuSeparability;
    if (contrastScore < LOW_CONTRAST_THRESHOLD) {
      warnings.push({
        code: 'LOW_CONTRAST',
        message: '图像前后景分离度低，浅淡线条可能被漏掉。可提高「对比度增强」或降低「二值化偏置」。',
        metric: Math.round(contrastScore * 1000) / 1000,
      });
    }

    /* 5) 形态学去噪 */
    if (params.denoiseClose > 0) {
      report(0.6, '弥合断裂');
      binary = close(binary, params.denoiseClose);
    }
    if (params.denoiseOpen > 0) {
      report(0.68, '去除噪点');
      binary = open(binary, params.denoiseOpen);
    }
    sw.mark('morphology');

    /* 6) 小连通域过滤 */
    if (params.minBlobArea > 1) {
      report(0.76, '过滤小噪点');
      const scaledMin = scaleBlobArea(params.minBlobArea, binary.width, binary.height);
      const r = removeSmallBlobs(binary, scaledMin);
      binary = r.image;
    }
    sw.mark('blobFilter');

    /* 7) 去倾斜 */
    let appliedSkew = 0;
    if (params.deskew) {
      report(0.85, '倾斜校正');
      const est = estimateSkew(binary, MAX_AUTO_SKEW_DEG);
      if (est.outOfRange) {
        warnings.push({
          code: 'DESKEW_OUT_OF_RANGE',
          message: `检测到倾角约 ${est.angle.toFixed(1)}°，已达自动校正上限 ±${MAX_AUTO_SKEW_DEG}°。建议手动旋转或使用透视校正。`,
          metric: est.angle,
        });
      }
      // 置信度过低时不动图，避免把噪声当成倾斜而引入额外形变
      if (!est.outOfRange && est.confidence > 0.25 && Math.abs(est.angle) > 0.3) {
        binary = rotateBinary(binary, -est.angle);
        const rg = rotateGray(gray.data, gray.width, gray.height, -est.angle);
        gray = { data: rg.data, width: rg.width, height: rg.height };
        appliedSkew = est.angle;
      }
    }

    /* 8) 手动旋转叠加 */
    if (Math.abs(params.manualRotation) > 0.01) {
      report(0.92, '手动旋转');
      binary = rotateBinary(binary, params.manualRotation);
      const rg = rotateGray(gray.data, gray.width, gray.height, params.manualRotation);
      gray = { data: rg.data, width: rg.width, height: rg.height };
      appliedSkew += params.manualRotation;
    }
    sw.mark('deskew');

    /* 9) 质量评估 */
    const fgRatio = ratioOf(binary);
    if (fgRatio > NOISY_FOREGROUND_THRESHOLD) {
      warnings.push({
        code: 'DENSE_FOREGROUND',
        message: '前景像素过多，可能是背景纹理被当作笔画。建议提高「二值化偏置」或增大「去噪」强度。',
        metric: Math.round(fgRatio * 1000) / 1000,
      });
    } else if (fgRatio < SPARSE_FOREGROUND_THRESHOLD) {
      warnings.push({
        code: 'SPARSE_FOREGROUND',
        message: '几乎没有提取到笔画。请检查「线条颜色」设置，或降低「二值化偏置」。',
        metric: Math.round(fgRatio * 10000) / 10000,
      });
    }

    report(1, '预处理完成');
    return {
      binary,
      gray,
      downscale: 1,
      appliedSkew,
      foregroundRatio: fgRatio,
      contrastScore,
      warnings,
      timings: sw.timings(),
    };
  }
}

/** 窗口半径需与图像尺寸相称：过小会碎化笔画，过大退化为全局阈值。 */
function clampRadius(r: number, w: number, h: number): number {
  const short = Math.min(w, h);
  const lo = 3;
  const hi = Math.max(lo + 1, Math.round(short / 8));
  return Math.max(lo, Math.min(hi, Math.round(r)));
}

/** 噪点面积阈值按图像面积等比缩放，保证不同分辨率下行为一致。 */
function scaleBlobArea(base: number, w: number, h: number): number {
  const refArea = 2000 * 1500;
  const k = (w * h) / refArea;
  return Math.max(4, Math.round(base * Math.max(0.25, Math.min(4, k))));
}

function ratioOf(img: BinaryImage): number {
  let n = 0;
  for (let i = 0; i < img.data.length; i++) if (img.data[i]! !== 0) n++;
  const total = img.width * img.height;
  return total > 0 ? n / total : 0;
}

/** 模块默认实例。 */
export const defaultPreprocessor: IPreprocessor = new PreprocessorTs();
