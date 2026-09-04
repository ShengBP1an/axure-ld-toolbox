/**
 * 管线 Worker 桥接。
 *
 * 负责：创建 Worker、发送任务、转发进度、处理取消与过期回包。
 * 主线程只做 UI，CPU 密集工作全在 Worker 内，保证编辑器交互不掉帧。
 */

import { useCallback, useEffect, useRef } from 'react';
import PipelineWorker from '../workers/pipeline.worker?worker';
import type { WorkerRequest, WorkerResponse } from '../workers/protocol';
import { useProjectStore } from '../store/useProjectStore';
import { useEditorStore } from '../store/useEditorStore';
import { prepareWorkingImage } from '../core/preprocess/decode';
import { createLogger, now } from '../lib/logger';
import { ERROR_MESSAGES, type ErrorCode } from '../types/errors';

const log = createLogger('pipeline');

let jobSeq = 0;

export interface PipelineRunner {
  /** 执行完整识别管线。 */
  runRecognition(): void;
  /** 只执行预处理（导入步骤的预览）。 */
  runPreprocessPreview(): void;
  /** 取消当前任务。 */
  cancel(): void;
}

export function usePipelineRunner(): PipelineRunner {
  const workerRef = useRef<Worker | null>(null);
  const activeJob = useRef<number>(0);
  const startedAt = useRef<number>(0);

  useEffect(() => {
    const worker = new PipelineWorker();
    workerRef.current = worker;

    worker.onmessage = (ev: MessageEvent<WorkerResponse>): void => {
      const msg = ev.data;
      // 忽略过期回包（用户已重新发起或取消）
      if (msg.jobId !== activeJob.current) return;

      const project = useProjectStore.getState();

      switch (msg.type) {
        case 'progress':
          project.updateRun(msg.progress, msg.stage, msg.detail);
          break;

        case 'preprocessDone':
          project.setPreview({
            grayData: msg.grayData,
            grayWidth: msg.grayWidth,
            grayHeight: msg.grayHeight,
            binaryData: msg.binaryData,
            binaryWidth: msg.width,
            binaryHeight: msg.height,
          });
          project.finishRun();
          for (const w of msg.warnings) {
            project.notify(w.message, 'warning');
          }
          break;

        case 'done': {
          const elapsed = Math.round(now() - startedAt.current);
          project.setResult(msg.result, msg.idCounters);
          project.setPreview({
            grayData: msg.grayData,
            grayWidth: msg.grayWidth,
            grayHeight: msg.grayHeight,
            binaryData: msg.binaryData,
            binaryWidth: msg.binaryWidth,
            binaryHeight: msg.binaryHeight,
          });
          project.finishRun();

          const strokeRef = Math.max(
            1,
            Math.round(msg.result.stats.workWidth / 600),
          );
          useEditorStore.getState().loadResult(
            msg.result.elements,
            msg.result.issues,
            strokeRef * 3,
            msg.result.stats.workWidth * msg.result.stats.workHeight,
          );

          log.info('识别完成', {
            ms: elapsed,
            elements: msg.result.stats.elementCount,
            issues: msg.result.issues.length,
          });
          project.notify(
            `识别完成：${msg.result.stats.elementCount} 个对象，耗时 ${(elapsed / 1000).toFixed(1)}s`,
            'success',
          );
          project.markCompleted('recognize');
          project.goStep('edit');
          break;
        }

        case 'error':
          project.setError(msg.error.code, msg.error.message, msg.error.recoverable);
          break;

        case 'cancelled':
          project.finishRun();
          project.notify('已取消识别。', 'info');
          break;
      }
    };

    worker.onerror = (e: ErrorEvent): void => {
      console.error('[pipeline] Worker 崩溃', e.message);
      useProjectStore
        .getState()
        .setError('INTERNAL', '识别线程异常退出，请刷新页面后重试。', false);
    };

    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const post = useCallback((req: WorkerRequest, transfer: Transferable[]): void => {
    const worker = workerRef.current;
    if (worker === null) return;
    worker.postMessage(req, transfer);
  }, []);

  const runRecognition = useCallback((): void => {
    const project = useProjectStore.getState();
    const pixels = project.sourcePixels;
    if (pixels === null) {
      project.notify('请先导入草图。', 'warning');
      return;
    }

    // 准备工作图像（透视 / 裁剪 / 下采样）；此步依赖 DOM 之外的纯计算
    const prepared = prepareWorkingImage(pixels, project.preprocess);
    project.setWorkingImage(prepared);

    jobSeq += 1;
    activeJob.current = jobSeq;
    startedAt.current = now();
    project.startRun(jobSeq);

    // 复制像素后转移所有权，避免 Worker 拿走主线程仍需展示的原图缓冲
    const copy = new Uint8ClampedArray(prepared.data);
    post(
      {
        type: 'run',
        jobId: jobSeq,
        pixels: copy,
        width: prepared.width,
        height: prepared.height,
        preprocess: project.preprocess,
        recognize: project.recognize,
        settings: project.settings,
        downscale: prepared.downscale,
        idCounters: project.idCounters,
      },
      [copy.buffer],
    );
  }, [post]);

  const runPreprocessPreview = useCallback((): void => {
    const project = useProjectStore.getState();
    const pixels = project.sourcePixels;
    if (pixels === null) return;

    const prepared = prepareWorkingImage(pixels, project.preprocess);
    project.setWorkingImage(prepared);

    jobSeq += 1;
    activeJob.current = jobSeq;
    project.startRun(jobSeq);

    const copy = new Uint8ClampedArray(prepared.data);
    post(
      {
        type: 'preprocess',
        jobId: jobSeq,
        pixels: copy,
        width: prepared.width,
        height: prepared.height,
        preprocess: project.preprocess,
      },
      [copy.buffer],
    );
  }, [post]);

  const cancel = useCallback((): void => {
    const worker = workerRef.current;
    if (worker === null) return;
    const id = activeJob.current;
    if (id === 0) return;
    worker.postMessage({ type: 'cancel', jobId: id } satisfies WorkerRequest);
  }, []);

  return { runRecognition, runPreprocessPreview, cancel };
}

/** 面向 UI 的错误文案（附带可操作建议）。 */
export function errorAdvice(code: ErrorCode): string {
  switch (code) {
    case 'NO_STRUCTURE_FOUND':
      return '请返回「导入」步骤：降低「二值化偏置」、提高「对比度增强」，或确认「线条颜色」设置正确。也可以直接用绘制工具手动描线。';
    case 'TOO_NOISY':
      return '请提高「去除噪点」强度或增大「小噪点过滤」面积阈值，再重新识别。';
    case 'TOO_MANY_ELEMENTS':
      return '请把识别预设切换为「快速」，或提高「简化容差」以减少对象数量。';
    case 'LOW_CONTRAST':
      return '请提高「对比度增强」与「阴影抑制」强度。';
    case 'TOO_LARGE':
      return '请把图片压缩到 25MB 以内、长宽不超过 8000 像素后重试。';
    case 'UNSUPPORTED_FORMAT':
      return '请使用 JPG 或 PNG 格式的图片。';
    case 'DECODE_FAILED':
      return '请确认文件未损坏，或换用其它图片重试。';
    default:
      return ERROR_MESSAGES[code];
  }
}
