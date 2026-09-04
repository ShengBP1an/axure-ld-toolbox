/**
 * 编辑器状态 store。
 *
 * 所有对矢量数据的修改都通过 EditorCommand 执行，
 * 命令栈提供撤销 / 重做，并在每次修改后增量重算置信度与问题标记。
 */

import { create } from 'zustand';
import type {
  BackdropConfig,
  EditorCommand,
  EditorState,
  HoverState,
  NodeRef,
  Selection,
  SnapConfig,
  ToolKind,
  ViewportState,
} from '../types/editor';
import {
  DEFAULT_BACKDROP,
  DEFAULT_SNAP,
  EMPTY_HOVER,
  EMPTY_SELECTION,
  UNDO_STACK_LIMIT,
} from '../types/editor';
import type { RecognitionIssue } from '../types/recognition';
import type { LayerKind, VectorElement } from '../types/vector';
import { LAYER_KINDS } from '../types/vector';
import { ResetToAutoCommand } from './commands';
import { cloneElement } from './commands';
import { NeutralSampler, recomputeAfterEdit } from '../core/recognize/confidence';
import { createLogger } from '../lib/logger';

const log = createLogger('editor');

interface HistoryEntry {
  command: EditorCommand;
  label: string;
}

interface EditorStore {
  /* 数据 */
  elements: Map<string, VectorElement>;
  order: string[];
  issues: Map<string, RecognitionIssue>;
  layerVisible: Record<string, boolean>;
  layerLocked: Record<string, boolean>;

  /* 自动识别初始快照（供「回到自动识别结果」） */
  autoSnapshot: { elements: VectorElement[]; order: string[] } | null;

  /* 交互 */
  selection: Selection;
  hover: HoverState;
  tool: ToolKind;
  snap: SnapConfig;
  backdrop: BackdropConfig;
  viewport: ViewportState;
  /** 临时关闭吸附（按住修饰键时）。 */
  snapSuspended: boolean;

  /* 历史 */
  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];

  /** 用于置信度重算的参考量（来自识别阶段）。 */
  strokeWidthPx: number;
  imageArea: number;
  /** 数据版本号，渲染层据此判断是否需要重绘。 */
  revision: number;

  /* 操作 */
  loadResult(elements: readonly VectorElement[], issues: readonly RecognitionIssue[], strokeWidthPx: number, imageArea: number): void;
  execute(command: EditorCommand): void;
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  undoLabel(): string | null;
  redoLabel(): string | null;
  resetToAuto(): void;

  setSelection(sel: Selection): void;
  selectElements(ids: readonly string[], additive?: boolean): void;
  selectNodes(nodes: readonly NodeRef[], additive?: boolean): void;
  clearSelection(): void;
  setHover(h: HoverState): void;

  setTool(t: ToolKind): void;
  setSnap(patch: Partial<SnapConfig>): void;
  setSnapSuspended(v: boolean): void;
  setBackdrop(patch: Partial<BackdropConfig>): void;
  setViewport(v: ViewportState): void;
  setLayerVisible(layer: LayerKind, visible: boolean): void;
  setLayerLocked(layer: LayerKind, locked: boolean): void;

  /* 查询 */
  visibleElements(): VectorElement[];
  selectedElements(): VectorElement[];
  issuesOf(elementId: string): RecognitionIssue[];
  clear(): void;
}

function defaultLayerFlags(value: boolean): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of LAYER_KINDS) out[k] = value;
  return out;
}

/** 从 store 抽取命令可操作的可变视图。 */
function draftOf(store: EditorStore): EditorState {
  return {
    elements: store.elements,
    order: store.order,
    issues: store.issues,
    layerVisible: store.layerVisible,
    layerLocked: store.layerLocked,
  };
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  elements: new Map(),
  order: [],
  issues: new Map(),
  layerVisible: defaultLayerFlags(true),
  layerLocked: defaultLayerFlags(false),
  autoSnapshot: null,

  selection: EMPTY_SELECTION,
  hover: EMPTY_HOVER,
  tool: 'select',
  snap: DEFAULT_SNAP,
  backdrop: DEFAULT_BACKDROP,
  viewport: { scale: 1, offsetX: 0, offsetY: 0 },
  snapSuspended: false,

  undoStack: [],
  redoStack: [],

  strokeWidthPx: 3,
  imageArea: 0,
  revision: 0,

  loadResult(elements, issues, strokeWidthPx, imageArea) {
    const map = new Map<string, VectorElement>();
    const order: string[] = [];
    for (const el of elements) {
      map.set(el.id, cloneElement(el));
      order.push(el.id);
    }
    const issueMap = new Map<string, RecognitionIssue>();
    for (const i of issues) issueMap.set(i.id, i);

    set({
      elements: map,
      order,
      issues: issueMap,
      autoSnapshot: {
        elements: elements.map(cloneElement),
        order: [...order],
      },
      selection: EMPTY_SELECTION,
      hover: EMPTY_HOVER,
      undoStack: [],
      redoStack: [],
      strokeWidthPx,
      imageArea,
      revision: get().revision + 1,
      layerVisible: defaultLayerFlags(true),
      layerLocked: defaultLayerFlags(false),
    });
    log.info('载入识别结果', { elements: elements.length, issues: issues.length });
  },

  execute(command) {
    const s = get();
    const draft = draftOf(s);
    // Map / Array 为可变容器，命令直接原地修改
    command.apply(draft);

    const affected = command.affectedIds();
    refreshConfidence(draft, affected, s.strokeWidthPx, s.imageArea);
    pruneIssues(draft);

    const undoStack = [...s.undoStack, { command, label: command.label }];
    if (undoStack.length > UNDO_STACK_LIMIT) undoStack.shift();

    set({
      elements: new Map(draft.elements),
      order: [...draft.order],
      issues: new Map(draft.issues),
      undoStack,
      redoStack: [],
      revision: s.revision + 1,
      selection: sanitizeSelection(s.selection, draft),
    });
  },

  undo() {
    const s = get();
    const last = s.undoStack[s.undoStack.length - 1];
    if (last === undefined) return;

    const draft = draftOf(s);
    const inverse = last.command.invert();
    inverse.apply(draft);
    refreshConfidence(draft, inverse.affectedIds(), s.strokeWidthPx, s.imageArea);
    pruneIssues(draft);

    set({
      elements: new Map(draft.elements),
      order: [...draft.order],
      issues: new Map(draft.issues),
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, last],
      revision: s.revision + 1,
      selection: sanitizeSelection(s.selection, draft),
    });
    log.debug('撤销', { label: last.label });
  },

  redo() {
    const s = get();
    const next = s.redoStack[s.redoStack.length - 1];
    if (next === undefined) return;

    const draft = draftOf(s);
    next.command.apply(draft);
    refreshConfidence(draft, next.command.affectedIds(), s.strokeWidthPx, s.imageArea);
    pruneIssues(draft);

    set({
      elements: new Map(draft.elements),
      order: [...draft.order],
      issues: new Map(draft.issues),
      undoStack: [...s.undoStack, next],
      redoStack: s.redoStack.slice(0, -1),
      revision: s.revision + 1,
      selection: sanitizeSelection(s.selection, draft),
    });
    log.debug('重做', { label: next.label });
  },

  canUndo() {
    return get().undoStack.length > 0;
  },

  canRedo() {
    return get().redoStack.length > 0;
  },

  undoLabel() {
    const s = get();
    return s.undoStack[s.undoStack.length - 1]?.label ?? null;
  },

  redoLabel() {
    const s = get();
    return s.redoStack[s.redoStack.length - 1]?.label ?? null;
  },

  resetToAuto() {
    const snap = get().autoSnapshot;
    if (snap === null) return;
    get().execute(new ResetToAutoCommand(snap.elements, snap.order));
  },

  setSelection(selection) {
    set({ selection });
  },

  selectElements(ids, additive = false) {
    const cur = get().selection;
    const next = additive ? unique([...cur.elementIds, ...ids]) : [...ids];
    set({ selection: { elementIds: next, nodes: additive ? cur.nodes : [] } });
  },

  selectNodes(nodes, additive = false) {
    const cur = get().selection;
    const merged = additive ? [...cur.nodes, ...nodes] : [...nodes];
    const seen = new Set<string>();
    const deduped = merged.filter((n) => {
      const k = `${n.elementId}:${n.index}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    set({ selection: { elementIds: cur.elementIds, nodes: deduped } });
  },

  clearSelection() {
    set({ selection: EMPTY_SELECTION });
  },

  setHover(hover) {
    set({ hover });
  },

  setTool(tool) {
    // 切换工具时清除节点选择，避免残留高亮
    set({ tool, selection: { elementIds: get().selection.elementIds, nodes: [] } });
  },

  setSnap(patch) {
    set({ snap: { ...get().snap, ...patch } });
  },

  setSnapSuspended(snapSuspended) {
    set({ snapSuspended });
  },

  setBackdrop(patch) {
    set({ backdrop: { ...get().backdrop, ...patch } });
  },

  setViewport(viewport) {
    set({ viewport });
  },

  setLayerVisible(layer, visible) {
    set({ layerVisible: { ...get().layerVisible, [layer]: visible }, revision: get().revision + 1 });
  },

  setLayerLocked(layer, locked) {
    set({ layerLocked: { ...get().layerLocked, [layer]: locked }, revision: get().revision + 1 });
  },

  visibleElements() {
    const s = get();
    const out: VectorElement[] = [];
    for (const id of s.order) {
      const el = s.elements.get(id);
      if (el === undefined) continue;
      if (el.hidden === true) continue;
      if (s.layerVisible[el.layer] === false) continue;
      out.push(el);
    }
    return out;
  },

  selectedElements() {
    const s = get();
    const out: VectorElement[] = [];
    for (const id of s.selection.elementIds) {
      const el = s.elements.get(id);
      if (el !== undefined) out.push(el);
    }
    return out;
  },

  issuesOf(elementId) {
    const s = get();
    const out: RecognitionIssue[] = [];
    for (const i of s.issues.values()) {
      if (i.elementIds.includes(elementId)) out.push(i);
    }
    return out;
  },

  clear() {
    set({
      elements: new Map(),
      order: [],
      issues: new Map(),
      autoSnapshot: null,
      selection: EMPTY_SELECTION,
      hover: EMPTY_HOVER,
      undoStack: [],
      redoStack: [],
      revision: get().revision + 1,
    });
  },
}));

/**
 * 编辑后增量重算置信度。
 * 只处理受影响的对象，避免每次拖动都全量重算。
 */
function refreshConfidence(
  draft: EditorState,
  affectedIds: readonly string[],
  strokeWidthPx: number,
  imageArea: number,
): void {
  const sampler = new NeutralSampler();
  for (const id of affectedIds) {
    const el = draft.elements.get(id);
    if (el === undefined) continue;
    const confidence = recomputeAfterEdit(el, sampler, strokeWidthPx, imageArea);
    draft.elements.set(id, { ...el, confidence });
  }
}

/** 移除指向已不存在对象的问题标记，避免问题列表出现死链接。 */
function pruneIssues(draft: EditorState): void {
  for (const [id, issue] of [...draft.issues]) {
    if (issue.elementIds.length === 0) continue;
    const alive = issue.elementIds.filter((eid) => draft.elements.has(eid));
    if (alive.length === 0) {
      draft.issues.delete(id);
      continue;
    }
    if (alive.length !== issue.elementIds.length) {
      draft.issues.set(id, { ...issue, elementIds: alive });
    }
  }
}

/** 清理选择中已被删除的对象与越界节点索引。 */
function sanitizeSelection(sel: Selection, draft: EditorState): Selection {
  const elementIds = sel.elementIds.filter((id) => draft.elements.has(id));
  const nodes = sel.nodes.filter((n) => draft.elements.has(n.elementId));
  if (elementIds.length === sel.elementIds.length && nodes.length === sel.nodes.length) return sel;
  return { elementIds, nodes };
}

function unique(arr: readonly string[]): string[] {
  return [...new Set(arr)];
}
