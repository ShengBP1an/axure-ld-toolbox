/**
 * 识别结果与问题标记模型。
 */

import type { Bounds, VectorElement } from './vector';

export const ALGORITHM_VERSION = '1.0.0';
export const TOOL_VERSION = '0.1.0';

export type IssueType =
  /** 低置信度对象，需人工确认。 */
  | 'lowConfidence'
  /** 断线：端点悬空，未与任何其它线相接。 */
  | 'brokenLine'
  /** 重叠 / 重复线。 */
  | 'duplicateLine'
  /** 区域未闭合。 */
  | 'openRegion'
  /** 多边形自相交。 */
  | 'selfIntersect'
  /** 异常小图形，可能是噪点。 */
  | 'tinyShape'
  /** 对象超出画布范围。 */
  | 'outOfCanvas'
  /** 简化被拓扑守卫拦截，已降低容差。 */
  | 'simplifyBlocked'
  /** 细通道，简化时需重点保护。 */
  | 'narrowPassage'
  /** 预处理阶段的图像质量告警。 */
  | 'imageQuality'
  /** 比例 / 标定相关冲突。 */
  | 'scaleConflict';

export type Severity = 'info' | 'warning' | 'error';

export const ISSUE_LABELS: Record<IssueType, string> = {
  lowConfidence: '低置信度',
  brokenLine: '断线未连接',
  duplicateLine: '重复 / 重叠线',
  openRegion: '区域未闭合',
  selfIntersect: '多边形自相交',
  tinyShape: '异常小图形',
  outOfCanvas: '超出画布',
  simplifyBlocked: '简化被拦截',
  narrowPassage: '细通道',
  imageQuality: '图像质量',
  scaleConflict: '比例冲突',
};

export interface RecognitionIssue {
  id: string;
  type: IssueType;
  severity: Severity;
  /** 面向用户的说明文案。 */
  message: string;
  /** 建议操作，例如「使用连接工具补齐端点」。 */
  suggestion: string;
  /** 关联的矢量对象 id，可为空（例如全局图像质量告警）。 */
  elementIds: string[];
  /** 问题定位区域，坐标为地图单位；用于画布高亮与跳转。 */
  region: Bounds | null;
  /** 是否阻止导出（error 级中的致命项）。 */
  blocking: boolean;
}

export interface PipelineStats {
  /** 各阶段耗时（毫秒）。 */
  timings: Record<string, number>;
  /** 工作图像尺寸。 */
  workWidth: number;
  workHeight: number;
  /** imgPx → 原图像素的下采样因子（>1 表示已缩小）。 */
  downscale: number;
  /** 骨架分支数。 */
  branchCount: number;
  /** 拟合后的线段数。 */
  segmentCount: number;
  /** 提取到的封闭面数。 */
  faceCount: number;
  /** 最终输出对象数。 */
  elementCount: number;
  /** 简化前后的节点数，用于计算简化率。 */
  nodesBeforeSimplify: number;
  nodesAfterSimplify: number;
  /** 平均置信度。 */
  averageConfidence: number;
  /** 前景像素占比，用于低对比度 / 噪声判定。 */
  foregroundRatio: number;
}

export function simplifyRatio(s: PipelineStats): number {
  if (s.nodesBeforeSimplify <= 0) return 0;
  return 1 - s.nodesAfterSimplify / s.nodesBeforeSimplify;
}

export interface RecognitionResult {
  elements: VectorElement[];
  issues: RecognitionIssue[];
  stats: PipelineStats;
  algorithmVersion: string;
  /** 生成结果所用参数的快照哈希，便于判断是否需重跑。 */
  paramsSignature: string;
  createdAt: number;
}

export function emptyStats(): PipelineStats {
  return {
    timings: {},
    workWidth: 0,
    workHeight: 0,
    downscale: 1,
    branchCount: 0,
    segmentCount: 0,
    faceCount: 0,
    elementCount: 0,
    nodesBeforeSimplify: 0,
    nodesAfterSimplify: 0,
    averageConfidence: 0,
    foregroundRatio: 0,
  };
}

export const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function sortIssues(issues: RecognitionIssue[]): RecognitionIssue[] {
  return [...issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
