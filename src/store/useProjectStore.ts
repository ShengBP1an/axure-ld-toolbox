/**
 * 项目状态 store：源图、设置、预处理与识别参数、管线运行状态。
 *
 * 隐私：源图与识别结果只保存在内存与用户本地文件中，
 * 全程无网络请求、无遥测。
 */

import { create } from 'zustand';
import type { PreprocessParams, ProjectSettings, SourceImage, UnitSpec } from '../types/project';
import { DEFAULT_PREPROCESS, DEFAULT_SETTINGS } from '../types/project';
import type { RecognitionResult } from '../types/recognition';
import type { ExportSettings } from '../types/export';
import { DEFAULT_EXPORT_SETTINGS } from '../types/export';
import type { PresetKind, RecognizeParams, StageName } from '../core/pipeline/params';
import { presetParams, presetPreprocess } from '../core/pipeline/params';
import type { RgbaImage } from '../core/preprocess/IPreprocessor';
import * as settingsLogic from '../core/project/settings';
import type { ErrorCode } from '../types/errors';
import { createLogger } from '../lib/logger';

const log = createLogger('project');

export type StepId = 'import' | 'scale' | 'recognize' | 'edit' | 'export';

export const STEPS: readonly StepId[] = ['import', 'scale', 'recognize', 'edit', 'export'];

export const STEP_LABELS: Record<StepId, string> = {
  import: '导入草图',
  scale: '尺寸与比例',
  recognize: '识别矢量化',
  edit: '校正编辑',
  export: '导出 SVG',
};

export interface Notice {
  id: number;
  text: string;
  level: 'info' | 'warning' | 'error' | 'success';
}

export interface RunState {
  running: boolean;
  progress: number;
  stage: StageName | 'preprocess' | null;
  detail: string;
  /** 当前 job id，用于忽略过期回包。 */
  jobId: number;
}

/** 预处理预览产物（灰度 / 二值），仅存在于内存。 */
export interface PreviewBuffers {
  grayData: Uint8Array;
  grayWidth: number;
  grayHeight: number;
  binaryData: Uint8Array;
  binaryWidth: number;
  binaryHeight: number;
}

interface ProjectStore {
  projectName: string;
  step: StepId;
  /** 已完成的步骤，决定步骤条可跳转范围。 */
  completed: Record<StepId, boolean>;

  source: SourceImage | null;
  /** 解码后的原图像素（只读，不参与处理）。 */
  sourcePixels: RgbaImage | null;
  /** 按参数准备后的工作图像。 */
  workingImage: (RgbaImage & { downscale: number }) | null;

  settings: ProjectSettings;
  preprocess: PreprocessParams;
  recognize: RecognizeParams;
  preset: PresetKind;
  exportSettings: ExportSettings;

  result: RecognitionResult | null;
  preview: PreviewBuffers | null;
  idCounters: Record<string, number>;

  run: RunState;
  lastError: { code: ErrorCode; message: string; recoverable: boolean } | null;
  notices: Notice[];

  /* 操作 */
  setProjectName(name: string): void;
  goStep(step: StepId): void;
  markCompleted(step: StepId): void;

  setSource(source: SourceImage, pixels: RgbaImage): void;
  setWorkingImage(img: RgbaImage & { downscale: number }): void;
  clearSource(): void;

  applySettingsChange(change: settingsLogic.SettingsChange): void;
  setUnit(unit: UnitSpec): void;
  setPreprocess(patch: Partial<PreprocessParams>): void;
  resetPreprocess(): void;
  setPreset(preset: PresetKind): void;
  setRecognize(patch: Partial<RecognizeParams>): void;
  setExportSettings(patch: Partial<ExportSettings>): void;

  setResult(result: RecognitionResult, idCounters: Record<string, number>): void;
  setPreview(preview: PreviewBuffers): void;
  clearResult(): void;

  startRun(jobId: number): void;
  updateRun(progress: number, stage: StageName | 'preprocess', detail?: string): void;
  finishRun(): void;
  setError(code: ErrorCode, message: string, recoverable: boolean): void;
  clearError(): void;

  notify(text: string, level?: Notice['level']): void;
  dismissNotice(id: number): void;
  clearNotices(): void;
}

let noticeSeq = 0;

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projectName: '未命名地图',
  step: 'import',
  completed: { import: false, scale: false, recognize: false, edit: false, export: false },

  source: null,
  sourcePixels: null,
  workingImage: null,

  settings: DEFAULT_SETTINGS,
  preprocess: DEFAULT_PREPROCESS,
  recognize: presetParams('standard'),
  preset: 'standard',
  exportSettings: DEFAULT_EXPORT_SETTINGS,

  result: null,
  preview: null,
  idCounters: {},

  run: { running: false, progress: 0, stage: null, detail: '', jobId: 0 },
  lastError: null,
  notices: [],

  setProjectName(projectName) {
    set({ projectName: projectName.trim() === '' ? '未命名地图' : projectName });
  },

  goStep(step) {
    set({ step });
  },

  markCompleted(step) {
    set({ completed: { ...get().completed, [step]: true } });
  },

  setSource(source, pixels) {
    // 原图只读保留；设置按原图尺寸初始化并默认锁定宽高比
    const settings = settingsLogic.initFromImage(source.naturalWidth, source.naturalHeight, get().settings);
    set({
      source,
      sourcePixels: pixels,
      settings,
      result: null,
      preview: null,
      workingImage: null,
      lastError: null,
      completed: { import: true, scale: false, recognize: false, edit: false, export: false },
    });
    log.info('载入草图', {
      width: source.naturalWidth,
      height: source.naturalHeight,
      orientation: source.exifOrientation,
    });
  },

  setWorkingImage(workingImage) {
    set({ workingImage });
  },

  clearSource() {
    set({
      source: null,
      sourcePixels: null,
      workingImage: null,
      result: null,
      preview: null,
      completed: { import: false, scale: false, recognize: false, edit: false, export: false },
      step: 'import',
    });
  },

  applySettingsChange(change) {
    set({ settings: change.settings });
    if (change.notice !== null) get().notify(change.notice, change.level);
  },

  setUnit(unit) {
    set({ settings: { ...get().settings, unit } });
  },

  setPreprocess(patch) {
    set({ preprocess: { ...get().preprocess, ...patch } });
  },

  resetPreprocess() {
    set({ preprocess: presetPreprocess(get().preset) });
    get().notify('已重置预处理参数为预设默认值。', 'info');
  },

  setPreset(preset) {
    set({
      preset,
      recognize: presetParams(preset),
      preprocess: { ...presetPreprocess(preset), crop: get().preprocess.crop, perspective: get().preprocess.perspective },
    });
  },

  setRecognize(patch) {
    set({ recognize: { ...get().recognize, ...patch } });
  },

  setExportSettings(patch) {
    set({ exportSettings: { ...get().exportSettings, ...patch } });
  },

  setResult(result, idCounters) {
    set({
      result,
      idCounters,
      lastError: null,
      completed: { ...get().completed, recognize: true },
    });
    log.info('识别完成', {
      elements: result.stats.elementCount,
      issues: result.issues.length,
      avgConfidence: Math.round(result.stats.averageConfidence * 100) / 100,
    });
  },

  setPreview(preview) {
    set({ preview });
  },

  clearResult() {
    set({ result: null, completed: { ...get().completed, recognize: false, edit: false, export: false } });
  },

  startRun(jobId) {
    set({
      run: { running: true, progress: 0, stage: null, detail: '准备中', jobId },
      lastError: null,
    });
  },

  updateRun(progress, stage, detail = '') {
    const cur = get().run;
    if (!cur.running) return;
    set({ run: { ...cur, progress, stage, detail } });
  },

  finishRun() {
    set({ run: { ...get().run, running: false, progress: 1, detail: '' } });
  },

  setError(code, message, recoverable) {
    set({
      lastError: { code, message, recoverable },
      run: { ...get().run, running: false },
    });
    log.error('管线错误', { code, recoverable });
  },

  clearError() {
    set({ lastError: null });
  },

  notify(text, level = 'info') {
    noticeSeq += 1;
    const notice: Notice = { id: noticeSeq, text, level };
    // 最多保留 4 条，避免堆积遮挡画布
    const notices = [...get().notices, notice].slice(-4);
    set({ notices });
  },

  dismissNotice(id) {
    set({ notices: get().notices.filter((n) => n.id !== id) });
  },

  clearNotices() {
    set({ notices: [] });
  },
}));

/** 步骤是否可进入（依赖前置条件）。 */
export function canEnterStep(step: StepId, s: Pick<ProjectStore, 'source' | 'result'>): boolean {
  switch (step) {
    case 'import':
      return true;
    case 'scale':
      return s.source !== null;
    case 'recognize':
      return s.source !== null;
    case 'edit':
      return s.result !== null;
    case 'export':
      return s.result !== null;
  }
}
