/**
 * 编辑器状态与命令模型。
 */

import type { RecognitionIssue } from './recognition';
import type { Point, VectorElement } from './vector';

export type ToolKind = 'select' | 'node' | 'draw' | 'calibrate' | 'pan';

export const TOOL_LABELS: Record<ToolKind, string> = {
  select: '选择 / 移动',
  node: '节点编辑',
  draw: '绘制',
  calibrate: '两点标定',
  pan: '平移',
};

/** 节点级选择的定位：元素 id + 顶点索引。 */
export interface NodeRef {
  elementId: string;
  index: number;
}

export interface Selection {
  elementIds: string[];
  nodes: NodeRef[];
}

export const EMPTY_SELECTION: Selection = { elementIds: [], nodes: [] };

export interface SnapConfig {
  enabled: boolean;
  grid: boolean;
  /** 网格间距（地图单位）。 */
  gridSize: number;
  endpoint: boolean;
  /** 端点吸附半径（屏幕像素，按缩放换算到地图单位）。 */
  endpointRadiusPx: number;
  angle: boolean;
  /** 角度吸附的候选角（度）。 */
  angleSteps: number[];
  /** 角度吸附容差（度）。 */
  angleTolerance: number;
}

export const DEFAULT_SNAP: SnapConfig = {
  enabled: true,
  grid: false,
  gridSize: 1,
  endpoint: true,
  endpointRadiusPx: 10,
  angle: true,
  angleSteps: [0, 45, 90, 135, 180, 225, 270, 315],
  angleTolerance: 6,
};

export interface ViewportState {
  /** 屏幕像素 = (unit坐标 * scale) + offset。 */
  scale: number;
  offsetX: number;
  offsetY: number;
}

export interface BackdropConfig {
  /** 底图模式。 */
  mode: 'none' | 'source' | 'preprocessed';
  /** 底图不透明度 0..1。 */
  opacity: number;
  /** 是否显示矢量结果。 */
  showVectors: boolean;
  /** 是否显示问题高亮。 */
  showIssues: boolean;
}

export const DEFAULT_BACKDROP: BackdropConfig = {
  mode: 'source',
  opacity: 0.45,
  showVectors: true,
  showIssues: true,
};

/** 编辑器的可变状态，命令只允许修改此对象。 */
export interface EditorState {
  elements: Map<string, VectorElement>;
  /** 保持稳定的渲染顺序。 */
  order: string[];
  issues: Map<string, RecognitionIssue>;
  /** 各图层显隐。 */
  layerVisible: Record<string, boolean>;
  layerLocked: Record<string, boolean>;
}

/**
 * 命令模式：撤销 / 重做与置信度重算的唯一入口。
 * invert() 返回反向命令，避免整状态快照带来的内存开销。
 */
export interface EditorCommand {
  readonly type: string;
  /** 撤销菜单展示文案。 */
  readonly label: string;
  apply(draft: EditorState): void;
  invert(): EditorCommand;
  /** 受影响的元素 id，用于增量重算置信度与问题标记。 */
  affectedIds(): string[];
}

export const UNDO_STACK_LIMIT = 100;

/** 绘制工具的临时状态。 */
export interface DrawDraft {
  points: Point[];
  closed: boolean;
}

export interface HoverState {
  elementId: string | null;
  node: NodeRef | null;
  /** 边命中：元素 id + 该边的起点索引。 */
  edge: { elementId: string; index: number } | null;
}

export const EMPTY_HOVER: HoverState = { elementId: null, node: null, edge: null };
