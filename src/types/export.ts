/**
 * SVG 导出设置与预检报告。
 */

import type { Bounds, LayerKind } from './vector';
import type { Severity } from './recognition';

export interface ExportSettings {
  /** 坐标小数位数，2 位在 Axure 中足够且避免文件膨胀。 */
  precision: number;
  /** 需要导出的图层。 */
  layers: Record<LayerKind, boolean>;
  /** 是否写入 <metadata>（不影响 Axure 显示）。 */
  includeMetadata: boolean;
  /** 是否写入 data-* 属性（置信度、问题标记等）。 */
  includeDataAttrs: boolean;
  /** 「待确认」图层是否保留虚线（Axure 对 dasharray 的转换行为需验证）。 */
  keepDashForReview: boolean;
  /** 封闭区域是否带填充；关闭后仅描边，避免 Axure 中大面积遮挡。 */
  fillRegions: boolean;
  /** 是否美化缩进输出。 */
  prettyPrint: boolean;
  /** 全局描边宽度倍率。 */
  strokeScale: number;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  precision: 2,
  layers: { boundary: true, wall: true, region: true, review: true },
  includeMetadata: true,
  includeDataAttrs: true,
  keepDashForReview: true,
  fillRegions: true,
  prettyPrint: true,
  strokeScale: 1,
};

export type PreflightCode =
  | 'openRegion'
  | 'outOfCanvas'
  | 'tinyShape'
  | 'selfIntersect'
  | 'invalidCoordinate'
  | 'degenerate'
  | 'emptyExport'
  | 'tooManyElements';

export const PREFLIGHT_LABELS: Record<PreflightCode, string> = {
  openRegion: '存在未闭合的区域',
  outOfCanvas: '对象超出画布范围',
  tinyShape: '存在异常小图形',
  selfIntersect: '存在自相交多边形',
  invalidCoordinate: '存在非法坐标（NaN / Infinity）',
  degenerate: '存在退化图形（零长度 / 零面积）',
  emptyExport: '没有可导出的对象',
  tooManyElements: '对象数量超过建议上限',
};

export interface PreflightItem {
  id: string;
  code: PreflightCode;
  severity: Severity;
  message: string;
  elementIds: string[];
  region: Bounds | null;
  /** error 级且 blocking 为真时阻止导出。 */
  blocking: boolean;
}

export interface PreflightReport {
  items: PreflightItem[];
  /** 是否允许继续导出。 */
  passed: boolean;
  checkedElements: number;
  checkedAt: number;
}

export function reportBlockingCount(r: PreflightReport): number {
  return r.items.filter((i) => i.blocking).length;
}

export interface ExportResult {
  svg: string;
  report: PreflightReport;
  /** 建议文件名（不含路径）。 */
  suggestedFileName: string;
  byteSize: number;
}
