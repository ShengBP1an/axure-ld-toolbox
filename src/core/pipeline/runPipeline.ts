/**
 * runPipeline —— 预处理 → 识别 → 简化的纯函数串联。
 *
 * 不依赖 DOM，可在 Web Worker 与 Node 单测中直接调用，
 * 保证「算法模块可独立测试和替换」。
 */

import { PipelineError } from '../../types/errors';
import type { PreprocessParams, ProjectSettings } from '../../types/project';
import type { RecognitionIssue, RecognitionResult } from '../../types/recognition';
import type { IPreprocessor, RgbaImage } from '../preprocess/IPreprocessor';
import { defaultPreprocessor } from '../preprocess/PreprocessorTs';
import { StructureRecognizer } from '../recognize/StructureRecognizer';
import { GeometrySimplifier } from '../simplify/GeometrySimplifier';
import { IdFactory, signature } from '../../lib/id';
import { Stopwatch } from '../../lib/logger';
import type { RecognizeParams } from './params';
import { stageProgress, type StageName } from './params';

export interface PipelineInput {
  image: RgbaImage;
  preprocess: PreprocessParams;
  recognize: RecognizeParams;
  settings: ProjectSettings;
  /** 相对原图的下采样因子（由调用方在准备工作图时算出）。 */
  downscale?: number;
  /** 沿用工程内 ID 计数器，保证 ID 稳定。 */
  idCounters?: Record<string, number>;
}

export interface PipelineDeps {
  preprocessor?: IPreprocessor;
  recognizer?: StructureRecognizer;
  simplifier?: GeometrySimplifier;
}

export interface PipelineCallbacks {
  onProgress?: (progress: number, stage: StageName, detail?: string) => void;
  isCancelled?: () => boolean;
}

export interface PipelineOutput {
  result: RecognitionResult;
  /** 预处理产出的二值图（供 UI 预览与后续置信度重算）。 */
  binaryData: Uint8Array;
  binaryWidth: number;
  binaryHeight: number;
  /** 预处理产出的灰度图（供「预处理图」底图显示）。 */
  grayData: Uint8Array;
  grayWidth: number;
  grayHeight: number;
  /** 更新后的 ID 计数器，回写工程。 */
  idCounters: Record<string, number>;
  /** 总耗时（毫秒）。 */
  totalMs: number;
}

/**
 * 执行完整管线。
 *
 * 错误处理策略：
 *   - 可恢复错误（LOW_CONTRAST / NO_STRUCTURE_FOUND / TOO_NOISY / TOO_MANY_ELEMENTS）
 *     直接抛出 PipelineError，由 UI 展示原因并引导调参或手动描线；
 *   - 绝不返回「空白但看似成功」的结果（对应最低验收标准 8）。
 */
export function runPipeline(
  input: PipelineInput,
  deps: PipelineDeps = {},
  cb: PipelineCallbacks = {},
): PipelineOutput {
  const sw = new Stopwatch();
  const preprocessor = deps.preprocessor ?? defaultPreprocessor;
  const recognizer = deps.recognizer ?? new StructureRecognizer();
  const simplifier = deps.simplifier ?? new GeometrySimplifier();

  const check = (): void => {
    if (cb.isCancelled?.() === true) throw new PipelineError('CANCELLED', undefined, false);
  };

  /* 1) 预处理 */
  const pre = preprocessor.run(input.image, input.preprocess, (p, stage) => {
    cb.onProgress?.(stageProgress('preprocess', p), 'preprocess', stage);
  });
  sw.mark('preprocess');
  check();

  /* 2) 结构识别 */
  const raw = recognizer.run(pre.binary, input.recognize, {
    isCancelled: cb.isCancelled,
    onProgress: (p, stage, detail) => cb.onProgress?.(p, stage, detail),
  });
  sw.mark('recognize');
  check();

  /* 3) 几何简化与元素生成 */
  cb.onProgress?.(stageProgress('simplify', 0.2), 'simplify', '生成矢量对象');
  const ids = new IdFactory(input.idCounters ?? {});
  const result = simplifier.run(raw, raw.effectiveParams, input.settings, {
    binary: pre.binary,
    preprocessTimings: pre.timings,
    foregroundRatio: pre.foregroundRatio,
    downscale: input.downscale ?? pre.downscale,
    idFactory: ids,
  });
  sw.mark('simplify');

  /* 4) 把预处理告警合并进 issues（保证图像质量问题在 UI 可见） */
  const qualityIssues: RecognitionIssue[] = pre.warnings.map((warn) => ({
    id: ids.nextWith('issue'),
    type: 'imageQuality',
    severity: warn.code === 'SPARSE_FOREGROUND' ? 'error' : 'warning',
    message: warn.message,
    suggestion: '返回「导入」步骤调整预处理参数后重新识别。',
    elementIds: [],
    region: null,
    blocking: false,
  }));

  result.issues = [...qualityIssues, ...result.issues];
  result.paramsSignature = signature({
    pre: input.preprocess,
    rec: input.recognize,
    map: { w: input.settings.mapWidth, h: input.settings.mapHeight },
  });
  result.stats.timings = { ...result.stats.timings, ...sw.timings() };

  cb.onProgress?.(1, 'simplify', '完成');

  return {
    result,
    binaryData: pre.binary.data,
    binaryWidth: pre.binary.width,
    binaryHeight: pre.binary.height,
    grayData: pre.gray.data,
    grayWidth: pre.gray.width,
    grayHeight: pre.gray.height,
    idCounters: ids.snapshot(),
    totalMs: Math.round(sw.total() * 100) / 100,
  };
}

/** 仅执行预处理（导入步骤的实时预览用，避免跑完整识别）。 */
export function runPreprocessOnly(
  image: RgbaImage,
  params: PreprocessParams,
  preprocessor: IPreprocessor = defaultPreprocessor,
): {
  binaryData: Uint8Array;
  grayData: Uint8Array;
  width: number;
  height: number;
  grayWidth: number;
  grayHeight: number;
  warnings: Array<{ code: string; message: string }>;
  foregroundRatio: number;
  contrastScore: number;
  appliedSkew: number;
} {
  const pre = preprocessor.run(image, params);
  return {
    binaryData: pre.binary.data,
    grayData: pre.gray.data,
    width: pre.binary.width,
    height: pre.binary.height,
    grayWidth: pre.gray.width,
    grayHeight: pre.gray.height,
    warnings: pre.warnings.map((w) => ({ code: w.code, message: w.message })),
    foregroundRatio: pre.foregroundRatio,
    contrastScore: pre.contrastScore,
    appliedSkew: pre.appliedSkew,
  };
}
