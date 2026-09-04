/**
 * 工程文件序列化：*.ldproj.json
 *
 * 设计要点：
 *   - 单文件便携：源图以 dataURL 内嵌，可跨机器打开；
 *   - 带 schemaVersion，未来可做迁移；
 *   - 只保存必要数据，不保存中间位图（可由源图重算）；
 *   - 保存 ID 计数器，保证载入后新建对象的 ID 不与旧 ID 冲突。
 */

import { PipelineError } from '../../types/errors';
import type { PreprocessParams, ProjectSettings, SourceImage } from '../../types/project';
import { DEFAULT_PREPROCESS, DEFAULT_SETTINGS } from '../../types/project';
import type { ExportSettings } from '../../types/export';
import { DEFAULT_EXPORT_SETTINGS } from '../../types/export';
import type { RecognitionIssue } from '../../types/recognition';
import { TOOL_VERSION } from '../../types/recognition';
import type { VectorElement } from '../../types/vector';
import type { PresetKind, RecognizeParams } from '../pipeline/params';
import { presetParams } from '../pipeline/params';

export const SCHEMA_VERSION = 1;

export interface ProjectFile {
  schemaVersion: number;
  toolVersion: string;
  projectName: string;
  savedAt: string;

  source: SourceImage | null;
  settings: ProjectSettings;
  preprocess: PreprocessParams;
  preset: PresetKind;
  recognize: RecognizeParams;
  exportSettings: ExportSettings;

  /** 当前（含用户编辑）的矢量对象与渲染顺序。 */
  elements: VectorElement[];
  order: string[];
  issues: RecognitionIssue[];
  /** 自动识别的初始快照，供「回到自动识别结果」。 */
  autoElements: VectorElement[] | null;
  autoOrder: string[] | null;

  idCounters: Record<string, number>;
  /** 图层显隐 / 锁定状态。 */
  layerVisible: Record<string, boolean>;
  layerLocked: Record<string, boolean>;
  /** 置信度重算所需参考量。 */
  strokeWidthPx: number;
  imageArea: number;
}

export interface SerializeInput {
  projectName: string;
  source: SourceImage | null;
  settings: ProjectSettings;
  preprocess: PreprocessParams;
  preset: PresetKind;
  recognize: RecognizeParams;
  exportSettings: ExportSettings;
  elements: readonly VectorElement[];
  order: readonly string[];
  issues: readonly RecognitionIssue[];
  autoElements: readonly VectorElement[] | null;
  autoOrder: readonly string[] | null;
  idCounters: Record<string, number>;
  layerVisible: Record<string, boolean>;
  layerLocked: Record<string, boolean>;
  strokeWidthPx: number;
  imageArea: number;
}

export function serializeProject(input: SerializeInput): string {
  const file: ProjectFile = {
    schemaVersion: SCHEMA_VERSION,
    toolVersion: TOOL_VERSION,
    projectName: input.projectName,
    savedAt: new Date().toISOString(),
    source: input.source,
    settings: input.settings,
    preprocess: input.preprocess,
    preset: input.preset,
    recognize: input.recognize,
    exportSettings: input.exportSettings,
    elements: [...input.elements],
    order: [...input.order],
    issues: [...input.issues],
    autoElements: input.autoElements === null ? null : [...input.autoElements],
    autoOrder: input.autoOrder === null ? null : [...input.autoOrder],
    idCounters: { ...input.idCounters },
    layerVisible: { ...input.layerVisible },
    layerLocked: { ...input.layerLocked },
    strokeWidthPx: input.strokeWidthPx,
    imageArea: input.imageArea,
  };
  return JSON.stringify(file, null, 2);
}

/**
 * 解析工程文件。
 * 缺失字段用默认值补齐，保证旧版本文件仍可打开。
 *
 * @throws PipelineError PROJECT_PARSE_FAILED / PROJECT_SCHEMA_MISMATCH
 */
export function deserializeProject(text: string): ProjectFile {
  const parsed = ((): unknown => {
    try {
      return JSON.parse(text);
    } catch (e) {
      console.error('[project] JSON 解析失败', e);
      return null;
    }
  })();

  if (parsed === null || typeof parsed !== 'object') {
    throw new PipelineError('PROJECT_PARSE_FAILED');
  }
  const raw = parsed as Partial<ProjectFile>;

  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0;
  if (version > SCHEMA_VERSION) {
    throw new PipelineError('PROJECT_SCHEMA_MISMATCH', {
      fileVersion: version,
      supported: SCHEMA_VERSION,
    });
  }

  if (!Array.isArray(raw.elements)) {
    throw new PipelineError('PROJECT_PARSE_FAILED', { reason: 'missingElements' });
  }

  const preset: PresetKind =
    raw.preset === 'fast' || raw.preset === 'fine' || raw.preset === 'standard'
      ? raw.preset
      : 'standard';

  const elements = raw.elements as VectorElement[];
  const order = Array.isArray(raw.order) && raw.order.length === elements.length
    ? (raw.order as string[])
    : elements.map((e) => e.id);

  return {
    schemaVersion: SCHEMA_VERSION,
    toolVersion: typeof raw.toolVersion === 'string' ? raw.toolVersion : 'unknown',
    projectName: typeof raw.projectName === 'string' ? raw.projectName : '未命名地图',
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : new Date().toISOString(),
    source: (raw.source ?? null) as SourceImage | null,
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    preprocess: { ...DEFAULT_PREPROCESS, ...(raw.preprocess ?? {}) },
    preset,
    recognize: { ...presetParams(preset), ...(raw.recognize ?? {}) },
    exportSettings: { ...DEFAULT_EXPORT_SETTINGS, ...(raw.exportSettings ?? {}) },
    elements,
    order,
    issues: Array.isArray(raw.issues) ? (raw.issues as RecognitionIssue[]) : [],
    autoElements: Array.isArray(raw.autoElements) ? (raw.autoElements as VectorElement[]) : null,
    autoOrder: Array.isArray(raw.autoOrder) ? (raw.autoOrder as string[]) : null,
    idCounters: isRecord(raw.idCounters) ? (raw.idCounters as Record<string, number>) : {},
    layerVisible: isRecord(raw.layerVisible)
      ? (raw.layerVisible as Record<string, boolean>)
      : { boundary: true, wall: true, region: true, review: true },
    layerLocked: isRecord(raw.layerLocked)
      ? (raw.layerLocked as Record<string, boolean>)
      : { boundary: false, wall: false, region: false, review: false },
    strokeWidthPx: typeof raw.strokeWidthPx === 'number' ? raw.strokeWidthPx : 3,
    imageArea: typeof raw.imageArea === 'number' ? raw.imageArea : 0,
  };
}

function isRecord(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 建议的工程文件名。 */
export function projectFileName(projectName: string): string {
  const safe = projectName.replace(/[\\/:*?"<>|]/g, '_').trim();
  return `${safe === '' ? 'ld-project' : safe}.ldproj.json`;
}
