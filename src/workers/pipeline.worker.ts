/**
 * 识别管线 Worker。
 *
 * 把 CPU 密集的预处理与识别放到独立线程，保证编辑器交互不掉帧。
 * 支持取消：主线程发 cancel 后，管线在下一个检查点抛出 CANCELLED。
 *
 * 说明：Worker 顶层必须有崩溃防护，否则未捕获异常会让整个 Worker
 * 静默失效、UI 永久停在「识别中」。因此此处使用错误边界捕获并
 * 转换为结构化 error 消息上报，而不是让异常逃逸。
 */

/// <reference lib="webworker" />

import { PipelineError, isSerializedPipelineError, type SerializedPipelineError } from '../types/errors';
import { runPipeline, runPreprocessOnly, type PipelineOutput } from '../core/pipeline/runPipeline';
import type { WorkerRequest, WorkerResponse } from './protocol';

/** 已被取消的 jobId 集合。 */
const cancelled = new Set<number>();

function post(msg: WorkerResponse, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) self.postMessage(msg, transfer);
  else self.postMessage(msg);
}

/** 把任意异常规范化为可结构化克隆的错误负载。 */
function toSerializedError(e: unknown): SerializedPipelineError {
  if (e instanceof PipelineError) return e.toJSON();
  if (isSerializedPipelineError(e)) return e;
  console.error('[worker] 未预期错误', e);
  return {
    __pipelineError: true,
    code: 'INTERNAL',
    message: '识别过程发生内部错误，请重试或调整参数。',
    recoverable: true,
  };
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: SerializedPipelineError; isCancel: boolean };

/** 同步错误边界。 */
function attempt<T>(fn: () => T): Attempt<T> {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    const isCancel = e instanceof PipelineError && e.code === 'CANCELLED';
    return { ok: false, error: toSerializedError(e), isCancel };
  }
}

self.onmessage = (ev: MessageEvent<WorkerRequest>): void => {
  const req = ev.data;

  if (req.type === 'cancel') {
    cancelled.add(req.jobId);
    return;
  }

  const jobId = req.jobId;
  cancelled.delete(jobId);

  if (req.type === 'preprocess') {
    handlePreprocess(req, jobId);
    return;
  }
  if (req.type === 'run') {
    handleRun(req, jobId);
  }
};

function handlePreprocess(req: Extract<WorkerRequest, { type: 'preprocess' }>, jobId: number): void {
  const r = attempt(() =>
    runPreprocessOnly({ data: req.pixels, width: req.width, height: req.height }, req.preprocess),
  );

  if (!r.ok) {
    post({ type: 'error', jobId, error: r.error });
    return;
  }
  const out = r.value;
  post(
    {
      type: 'preprocessDone',
      jobId,
      binaryData: out.binaryData,
      grayData: out.grayData,
      width: out.width,
      height: out.height,
      grayWidth: out.grayWidth,
      grayHeight: out.grayHeight,
      warnings: out.warnings,
      foregroundRatio: out.foregroundRatio,
      contrastScore: out.contrastScore,
      appliedSkew: out.appliedSkew,
    },
    [out.binaryData.buffer, out.grayData.buffer],
  );
}

function handleRun(req: Extract<WorkerRequest, { type: 'run' }>, jobId: number): void {
  const isCancelled = (): boolean => cancelled.has(jobId);

  const r = attempt<PipelineOutput>(() =>
    runPipeline(
      {
        image: { data: req.pixels, width: req.width, height: req.height },
        preprocess: req.preprocess,
        recognize: req.recognize,
        settings: req.settings,
        downscale: req.downscale,
        idCounters: req.idCounters,
      },
      {},
      {
        isCancelled,
        onProgress: (progress, stage, detail) => {
          post({ type: 'progress', jobId, progress, stage, detail });
        },
      },
    ),
  );

  cancelled.delete(jobId);

  if (!r.ok) {
    if (r.isCancel) post({ type: 'cancelled', jobId });
    else post({ type: 'error', jobId, error: r.error });
    return;
  }

  const out = r.value;
  post(
    {
      type: 'done',
      jobId,
      result: out.result,
      binaryData: out.binaryData,
      binaryWidth: out.binaryWidth,
      binaryHeight: out.binaryHeight,
      grayData: out.grayData,
      grayWidth: out.grayWidth,
      grayHeight: out.grayHeight,
      idCounters: out.idCounters,
      totalMs: out.totalMs,
    },
    [out.binaryData.buffer, out.grayData.buffer],
  );
}
