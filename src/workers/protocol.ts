/**
 * Worker 消息协议。
 * 使用 Transferable 传递大数组，避免结构化克隆的拷贝开销。
 */

import type { PreprocessParams, ProjectSettings } from '../types/project';
import type { RecognitionResult } from '../types/recognition';
import type { SerializedPipelineError } from '../types/errors';
import type { RecognizeParams, StageName } from '../core/pipeline/params';

export interface RunRequest {
  type: 'run';
  /** 请求 id，用于匹配响应、忽略过期结果。 */
  jobId: number;
  /** RGBA 像素（其 buffer 作为 Transferable 传入）。 */
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  preprocess: PreprocessParams;
  recognize: RecognizeParams;
  settings: ProjectSettings;
  downscale: number;
  idCounters: Record<string, number>;
}

export interface PreprocessRequest {
  type: 'preprocess';
  jobId: number;
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  preprocess: PreprocessParams;
}

export interface CancelRequest {
  type: 'cancel';
  jobId: number;
}

export type WorkerRequest = RunRequest | PreprocessRequest | CancelRequest;

export interface ProgressMessage {
  type: 'progress';
  jobId: number;
  progress: number;
  stage: StageName | 'preprocess';
  detail?: string;
}

export interface DoneMessage {
  type: 'done';
  jobId: number;
  result: RecognitionResult;
  binaryData: Uint8Array;
  binaryWidth: number;
  binaryHeight: number;
  grayData: Uint8Array;
  grayWidth: number;
  grayHeight: number;
  idCounters: Record<string, number>;
  totalMs: number;
}

export interface PreprocessDoneMessage {
  type: 'preprocessDone';
  jobId: number;
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
}

export interface ErrorMessage {
  type: 'error';
  jobId: number;
  error: SerializedPipelineError;
}

export interface CancelledMessage {
  type: 'cancelled';
  jobId: number;
}

export type WorkerResponse =
  | ProgressMessage
  | DoneMessage
  | PreprocessDoneMessage
  | ErrorMessage
  | CancelledMessage;
