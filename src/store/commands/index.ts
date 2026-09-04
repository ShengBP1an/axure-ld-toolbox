/**
 * 编辑命令实现。
 *
 * 所有对矢量数据的修改都必须经由 EditorCommand，
 * 这是撤销 / 重做与置信度重算的唯一入口（对应最低验收标准 5）。
 *
 * invert() 返回反向命令而非整状态快照，内存占用与改动量成正比。
 */

import type { EditorCommand, EditorState } from '../../types/editor';
import type { Point, VectorElement } from '../../types/vector';
import { hasPointList } from '../../types/vector';

/** 深拷贝元素，避免命令持有的引用被后续修改污染。 */
function cloneElement(el: VectorElement): VectorElement {
  if (el.kind === 'line') return { ...el, a: { ...el.a }, b: { ...el.b }, issueIds: [...el.issueIds], style: { ...el.style } };
  if (el.kind === 'rect') return { ...el, issueIds: [...el.issueIds], style: { ...el.style } };
  return { ...el, points: el.points.map((p) => ({ ...p })), issueIds: [...el.issueIds], style: { ...el.style } };
}

/** 读取元素顶点的可写副本。 */
function readPoints(el: VectorElement): Point[] {
  switch (el.kind) {
    case 'line':
      return [{ ...el.a }, { ...el.b }];
    case 'rect':
      return [
        { x: el.x, y: el.y },
        { x: el.x + el.w, y: el.y },
        { x: el.x + el.w, y: el.y + el.h },
        { x: el.x, y: el.y + el.h },
      ];
    default:
      return el.points.map((p) => ({ ...p }));
  }
}

/**
 * 把顶点数组写回元素。
 * rect 在顶点被单独移动后不再是轴对齐矩形，会自动提升为 polygon —— 
 * 否则强行保持 rect 会静默丢弃用户的编辑。
 */
function writePoints(el: VectorElement, pts: Point[]): VectorElement {
  if (el.kind === 'line') {
    if (pts.length < 2) return el;
    return { ...el, a: { ...pts[0]! }, b: { ...pts[pts.length - 1]! } };
  }
  if (el.kind === 'rect') {
    if (pts.length !== 4) return el;
    if (isAxisAlignedRect(pts)) {
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      const minX = Math.min(...xs);
      const minY = Math.min(...ys);
      return { ...el, x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
    }
    // 退化为多边形以保留用户的自由编辑
    const { x: _x, y: _y, w: _w, h: _h, ...rest } = el;
    return { ...rest, kind: 'polygon', points: pts.map((p) => ({ ...p })), regular: false };
  }
  return { ...el, points: pts.map((p) => ({ ...p })) };
}

function isAxisAlignedRect(pts: readonly Point[], eps = 1e-6): boolean {
  if (pts.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % 4]!;
    const horizontal = Math.abs(a.y - b.y) <= eps;
    const vertical = Math.abs(a.x - b.x) <= eps;
    if (!horizontal && !vertical) return false;
  }
  return true;
}

/* ================================================================== */
/* 新增 / 删除                                                          */
/* ================================================================== */

export class AddElementsCommand implements EditorCommand {
  readonly type = 'addElements';
  readonly label: string;
  private readonly elements: VectorElement[];
  private readonly insertAt: number | null;

  constructor(elements: readonly VectorElement[], insertAt: number | null = null) {
    this.elements = elements.map(cloneElement);
    this.insertAt = insertAt;
    this.label = elements.length === 1 ? '新增图形' : `新增 ${elements.length} 个图形`;
  }

  apply(draft: EditorState): void {
    this.elements.forEach((el, i) => {
      draft.elements.set(el.id, cloneElement(el));
      if (this.insertAt === null) draft.order.push(el.id);
      else draft.order.splice(this.insertAt + i, 0, el.id);
    });
  }

  invert(): EditorCommand {
    return new DeleteElementsCommand(this.elements, this.label);
  }

  affectedIds(): string[] {
    return this.elements.map((e) => e.id);
  }
}

export class DeleteElementsCommand implements EditorCommand {
  readonly type = 'deleteElements';
  readonly label: string;
  /** 保存被删元素及其原顺序位置，供撤销时精确还原。 */
  private readonly snapshots: Array<{ element: VectorElement; index: number }>;

  constructor(elements: readonly VectorElement[], labelOverride?: string, indices?: readonly number[]) {
    this.snapshots = elements.map((el, i) => ({
      element: cloneElement(el),
      index: indices?.[i] ?? -1,
    }));
    this.label = labelOverride ?? (elements.length === 1 ? '删除图形' : `删除 ${elements.length} 个图形`);
  }

  apply(draft: EditorState): void {
    for (const s of this.snapshots) {
      draft.elements.delete(s.element.id);
      const idx = draft.order.indexOf(s.element.id);
      if (idx >= 0) draft.order.splice(idx, 1);
      // 解除孔洞关联，避免悬空引用
      for (const el of draft.elements.values()) {
        if (el.kind === 'closedPath' && el.holeOf === s.element.id) {
          delete el.holeOf;
        }
      }
    }
  }

  invert(): EditorCommand {
    const restore = new RestoreElementsCommand(this.snapshots);
    return restore;
  }

  affectedIds(): string[] {
    return this.snapshots.map((s) => s.element.id);
  }
}

/** 按原索引还原被删元素（DeleteElementsCommand 的反向命令）。 */
export class RestoreElementsCommand implements EditorCommand {
  readonly type = 'restoreElements';
  readonly label = '还原图形';
  private readonly snapshots: Array<{ element: VectorElement; index: number }>;

  constructor(snapshots: ReadonlyArray<{ element: VectorElement; index: number }>) {
    this.snapshots = snapshots.map((s) => ({ element: cloneElement(s.element), index: s.index }));
  }

  apply(draft: EditorState): void {
    // 按索引升序插入，保证顺序还原正确
    const sorted = [...this.snapshots].sort((a, b) => a.index - b.index);
    for (const s of sorted) {
      draft.elements.set(s.element.id, cloneElement(s.element));
      if (s.index >= 0 && s.index <= draft.order.length) draft.order.splice(s.index, 0, s.element.id);
      else draft.order.push(s.element.id);
    }
  }

  invert(): EditorCommand {
    return new DeleteElementsCommand(
      this.snapshots.map((s) => s.element),
      undefined,
      this.snapshots.map((s) => s.index),
    );
  }

  affectedIds(): string[] {
    return this.snapshots.map((s) => s.element.id);
  }
}

/* ================================================================== */
/* 移动                                                                */
/* ================================================================== */

export class MoveElementsCommand implements EditorCommand {
  readonly type = 'moveElements';
  readonly label = '移动图形';
  private readonly ids: string[];
  private readonly dx: number;
  private readonly dy: number;

  constructor(ids: readonly string[], dx: number, dy: number) {
    this.ids = [...ids];
    this.dx = dx;
    this.dy = dy;
  }

  apply(draft: EditorState): void {
    for (const id of this.ids) {
      const el = draft.elements.get(id);
      if (el === undefined || el.locked === true) continue;
      if (el.kind === 'rect') {
        draft.elements.set(id, { ...el, x: el.x + this.dx, y: el.y + this.dy, source: 'manual' });
        continue;
      }
      if (el.kind === 'line') {
        draft.elements.set(id, {
          ...el,
          a: { x: el.a.x + this.dx, y: el.a.y + this.dy },
          b: { x: el.b.x + this.dx, y: el.b.y + this.dy },
          source: 'manual',
        });
        continue;
      }
      draft.elements.set(id, {
        ...el,
        points: el.points.map((p) => ({ x: p.x + this.dx, y: p.y + this.dy })),
        source: 'manual',
      });
    }
  }

  invert(): EditorCommand {
    return new MoveElementsCommand(this.ids, -this.dx, -this.dy);
  }

  affectedIds(): string[] {
    return [...this.ids];
  }
}

/* ================================================================== */
/* 节点编辑                                                            */
/* ================================================================== */

export class MoveNodeCommand implements EditorCommand {
  readonly type = 'moveNode';
  readonly label = '移动节点';

  constructor(
    private readonly elementId: string,
    private readonly index: number,
    private readonly from: Point,
    private readonly to: Point,
  ) {}

  apply(draft: EditorState): void {
    const el = draft.elements.get(this.elementId);
    if (el === undefined || el.locked === true) return;
    const pts = readPoints(el);
    if (this.index < 0 || this.index >= pts.length) return;
    pts[this.index] = { ...this.to };
    draft.elements.set(this.elementId, { ...writePoints(el, pts), source: 'manual' });
  }

  invert(): EditorCommand {
    return new MoveNodeCommand(this.elementId, this.index, this.to, this.from);
  }

  affectedIds(): string[] {
    return [this.elementId];
  }
}

export class InsertNodeCommand implements EditorCommand {
  readonly type = 'insertNode';
  readonly label = '新增节点';

  constructor(
    private readonly elementId: string,
    private readonly index: number,
    private readonly point: Point,
  ) {}

  apply(draft: EditorState): void {
    const el = draft.elements.get(this.elementId);
    if (el === undefined || el.locked === true) return;
    // line / rect 插点后必然不再是原类型，先提升为折线 / 多边形
    const promoted = promoteForNodeEdit(el);
    const pts = readPoints(promoted);
    const at = Math.max(0, Math.min(pts.length, this.index));
    pts.splice(at, 0, { ...this.point });
    draft.elements.set(this.elementId, { ...writePointsAllowGrow(promoted, pts), source: 'manual' });
  }

  invert(): EditorCommand {
    return new DeleteNodeCommand(this.elementId, this.index, this.point);
  }

  affectedIds(): string[] {
    return [this.elementId];
  }
}

export class DeleteNodeCommand implements EditorCommand {
  readonly type = 'deleteNode';
  readonly label = '删除节点';

  constructor(
    private readonly elementId: string,
    private readonly index: number,
    private readonly removed: Point,
  ) {}

  apply(draft: EditorState): void {
    const el = draft.elements.get(this.elementId);
    if (el === undefined || el.locked === true) return;
    const promoted = promoteForNodeEdit(el);
    const pts = readPoints(promoted);
    // 保底：闭合形状至少 3 点，开放至少 2 点
    const closed = promoted.kind === 'polygon' || promoted.kind === 'closedPath';
    const minKeep = closed ? 3 : 2;
    if (pts.length <= minKeep) return;
    if (this.index < 0 || this.index >= pts.length) return;
    pts.splice(this.index, 1);
    draft.elements.set(this.elementId, { ...writePointsAllowGrow(promoted, pts), source: 'manual' });
  }

  invert(): EditorCommand {
    return new InsertNodeCommand(this.elementId, this.index, this.removed);
  }

  affectedIds(): string[] {
    return [this.elementId];
  }
}

/** line / rect 无法承载任意节点数，节点编辑前提升为 polyline / polygon。 */
function promoteForNodeEdit(el: VectorElement): VectorElement {
  if (el.kind === 'line') {
    const { a, b, ...rest } = el;
    return { ...rest, kind: 'polyline', points: [{ ...a }, { ...b }] };
  }
  if (el.kind === 'rect') {
    const { x, y, w, h, ...rest } = el;
    return {
      ...rest,
      kind: 'polygon',
      points: [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ],
      regular: false,
    };
  }
  return el;
}

/** 写回顶点，允许数量变化（用于插入 / 删除节点）。 */
function writePointsAllowGrow(el: VectorElement, pts: Point[]): VectorElement {
  if (hasPointList(el)) return { ...el, points: pts.map((p) => ({ ...p })) };
  return writePoints(el, pts);
}

/* ================================================================== */
/* 闭合 / 打开 / 合并 / 拆分                                            */
/* ================================================================== */

export class SetClosedCommand implements EditorCommand {
  readonly type = 'setClosed';
  readonly label: string;
  private before: VectorElement | null = null;

  constructor(
    private readonly elementId: string,
    private readonly closed: boolean,
  ) {
    this.label = closed ? '闭合路径' : '打开路径';
  }

  apply(draft: EditorState): void {
    const el = draft.elements.get(this.elementId);
    if (el === undefined || el.locked === true) return;
    this.before = cloneElement(el);

    const pts = readPoints(el);
    if (this.closed) {
      if (pts.length < 3) return;
      const { ...rest } = stripGeometry(el);
      draft.elements.set(this.elementId, {
        ...rest,
        kind: 'closedPath',
        points: pts,
        source: 'manual',
      } as VectorElement);
    } else {
      if (pts.length < 2) return;
      const { ...rest } = stripGeometry(el);
      draft.elements.set(this.elementId, {
        ...rest,
        kind: 'openPath',
        points: pts,
        source: 'manual',
      } as VectorElement);
    }
  }

  invert(): EditorCommand {
    return new ReplaceElementCommand(this.elementId, this.before, this.closed ? '打开路径' : '闭合路径');
  }

  affectedIds(): string[] {
    return [this.elementId];
  }
}

/** 直接用快照替换元素（作为复杂命令的通用反向命令）。 */
export class ReplaceElementCommand implements EditorCommand {
  readonly type = 'replaceElement';
  readonly label: string;
  private readonly next: VectorElement | null;
  private prev: VectorElement | null = null;

  constructor(private readonly elementId: string, next: VectorElement | null, label = '修改图形') {
    this.next = next === null ? null : cloneElement(next);
    this.label = label;
  }

  apply(draft: EditorState): void {
    const cur = draft.elements.get(this.elementId);
    this.prev = cur === undefined ? null : cloneElement(cur);
    if (this.next === null) {
      draft.elements.delete(this.elementId);
      const i = draft.order.indexOf(this.elementId);
      if (i >= 0) draft.order.splice(i, 1);
      return;
    }
    draft.elements.set(this.elementId, cloneElement(this.next));
    if (!draft.order.includes(this.elementId)) draft.order.push(this.elementId);
  }

  invert(): EditorCommand {
    return new ReplaceElementCommand(this.elementId, this.prev, this.label);
  }

  affectedIds(): string[] {
    return [this.elementId];
  }
}

/** 去掉几何字段，只保留公共属性（用于类型转换）。 */
function stripGeometry(el: VectorElement): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: el.id,
    layer: el.layer,
    confidence: el.confidence,
    issueIds: [...el.issueIds],
    style: { ...el.style },
    source: el.source,
  };
  if (el.locked !== undefined) base.locked = el.locked;
  if (el.hidden !== undefined) base.hidden = el.hidden;
  if (el.name !== undefined) base.name = el.name;
  return base;
}

/**
 * 合并两条开放路径：把 b 的顶点接到 a 的末尾（按最近端点自动定向）。
 * b 被删除。
 */
export class MergePathsCommand implements EditorCommand {
  readonly type = 'mergePaths';
  readonly label = '合并路径';
  private snapshotA: VectorElement | null = null;
  private snapshotB: VectorElement | null = null;
  private indexB = -1;

  constructor(
    private readonly idA: string,
    private readonly idB: string,
  ) {}

  apply(draft: EditorState): void {
    const a = draft.elements.get(this.idA);
    const b = draft.elements.get(this.idB);
    if (a === undefined || b === undefined) return;
    if (a.locked === true || b.locked === true) return;

    this.snapshotA = cloneElement(a);
    this.snapshotB = cloneElement(b);
    this.indexB = draft.order.indexOf(this.idB);

    const pa = readPoints(a);
    const pb = readPoints(b);
    if (pa.length < 2 || pb.length < 2) return;

    // 选择让接缝最短的拼接方式
    const aEnd = pa[pa.length - 1]!;
    const aStart = pa[0]!;
    const bStart = pb[0]!;
    const bEnd = pb[pb.length - 1]!;
    const options: Array<{ d: number; pts: Point[] }> = [
      { d: sqDist(aEnd, bStart), pts: [...pa, ...pb.slice(1)] },
      { d: sqDist(aEnd, bEnd), pts: [...pa, ...[...pb].reverse().slice(1)] },
      { d: sqDist(aStart, bEnd), pts: [...pb, ...pa.slice(1)] },
      { d: sqDist(aStart, bStart), pts: [...[...pb].reverse(), ...pa.slice(1)] },
    ];
    options.sort((x, y) => x.d - y.d);
    const merged = options[0]!.pts;

    const rest = stripGeometry(a);
    draft.elements.set(this.idA, {
      ...rest,
      kind: merged.length > 2 ? 'polyline' : 'line',
      ...(merged.length > 2 ? { points: merged } : { a: merged[0]!, b: merged[1]! }),
      source: 'manual',
    } as VectorElement);

    draft.elements.delete(this.idB);
    if (this.indexB >= 0) draft.order.splice(this.indexB, 1);
  }

  invert(): EditorCommand {
    return new UnmergePathsCommand(this.idA, this.snapshotA, this.snapshotB, this.indexB);
  }

  affectedIds(): string[] {
    return [this.idA, this.idB];
  }
}

/** MergePathsCommand 的反向命令：恢复两个原始路径。 */
export class UnmergePathsCommand implements EditorCommand {
  readonly type = 'unmergePaths';
  readonly label = '撤销合并路径';

  constructor(
    private readonly idA: string,
    private readonly snapshotA: VectorElement | null,
    private readonly snapshotB: VectorElement | null,
    private readonly indexB: number,
  ) {}

  apply(draft: EditorState): void {
    if (this.snapshotA !== null) draft.elements.set(this.idA, cloneElement(this.snapshotA));
    if (this.snapshotB !== null) {
      draft.elements.set(this.snapshotB.id, cloneElement(this.snapshotB));
      if (!draft.order.includes(this.snapshotB.id)) {
        if (this.indexB >= 0 && this.indexB <= draft.order.length) {
          draft.order.splice(this.indexB, 0, this.snapshotB.id);
        } else {
          draft.order.push(this.snapshotB.id);
        }
      }
    }
  }

  invert(): EditorCommand {
    return new MergePathsCommand(this.idA, this.snapshotB?.id ?? '');
  }

  affectedIds(): string[] {
    return [this.idA, this.snapshotB?.id ?? ''].filter((s) => s !== '');
  }
}

/** 在指定节点处把一条路径拆成两条。 */
export class SplitPathCommand implements EditorCommand {
  readonly type = 'splitPath';
  readonly label = '拆分路径';
  private snapshot: VectorElement | null = null;

  constructor(
    private readonly elementId: string,
    private readonly atIndex: number,
    /** 新生成元素的 id（由调用方通过 IdFactory 分配，保证稳定）。 */
    private readonly newId: string,
  ) {}

  apply(draft: EditorState): void {
    const el = draft.elements.get(this.elementId);
    if (el === undefined || el.locked === true) return;
    const pts = readPoints(el);
    if (this.atIndex <= 0 || this.atIndex >= pts.length - 1) return;

    this.snapshot = cloneElement(el);
    const first = pts.slice(0, this.atIndex + 1);
    const second = pts.slice(this.atIndex);

    const rest = stripGeometry(el);
    draft.elements.set(this.elementId, makeOpen(rest, first));

    const restNew = { ...rest, id: this.newId, issueIds: [] as string[] };
    draft.elements.set(this.newId, makeOpen(restNew, second));
    const idx = draft.order.indexOf(this.elementId);
    draft.order.splice(idx >= 0 ? idx + 1 : draft.order.length, 0, this.newId);
  }

  invert(): EditorCommand {
    return new UnsplitPathCommand(this.elementId, this.newId, this.snapshot);
  }

  affectedIds(): string[] {
    return [this.elementId, this.newId];
  }
}

export class UnsplitPathCommand implements EditorCommand {
  readonly type = 'unsplitPath';
  readonly label = '撤销拆分路径';

  constructor(
    private readonly elementId: string,
    private readonly newId: string,
    private readonly snapshot: VectorElement | null,
  ) {}

  apply(draft: EditorState): void {
    draft.elements.delete(this.newId);
    const i = draft.order.indexOf(this.newId);
    if (i >= 0) draft.order.splice(i, 1);
    if (this.snapshot !== null) draft.elements.set(this.elementId, cloneElement(this.snapshot));
  }

  invert(): EditorCommand {
    return new SplitPathCommand(this.elementId, 1, this.newId);
  }

  affectedIds(): string[] {
    return [this.elementId, this.newId];
  }
}

function makeOpen(rest: Record<string, unknown>, pts: Point[]): VectorElement {
  if (pts.length === 2) {
    return { ...rest, kind: 'line', a: pts[0]!, b: pts[1]!, source: 'manual' } as VectorElement;
  }
  return { ...rest, kind: 'polyline', points: pts, source: 'manual' } as VectorElement;
}

/* ================================================================== */
/* 属性修改                                                            */
/* ================================================================== */

export class SetLayerCommand implements EditorCommand {
  readonly type = 'setLayer';
  readonly label = '修改图层';
  private readonly prev = new Map<string, VectorElement['layer']>();

  constructor(
    private readonly ids: readonly string[],
    private readonly layer: VectorElement['layer'],
  ) {}

  apply(draft: EditorState): void {
    for (const id of this.ids) {
      const el = draft.elements.get(id);
      if (el === undefined) continue;
      this.prev.set(id, el.layer);
      draft.elements.set(id, { ...el, layer: this.layer });
    }
  }

  invert(): EditorCommand {
    const snapshot = new Map(this.prev);
    return new RestoreLayersCommand(snapshot);
  }

  affectedIds(): string[] {
    return [...this.ids];
  }
}

export class RestoreLayersCommand implements EditorCommand {
  readonly type = 'restoreLayers';
  readonly label = '恢复图层';

  constructor(private readonly snapshot: Map<string, VectorElement['layer']>) {}

  apply(draft: EditorState): void {
    for (const [id, layer] of this.snapshot) {
      const el = draft.elements.get(id);
      if (el !== undefined) draft.elements.set(id, { ...el, layer });
    }
  }

  invert(): EditorCommand {
    return new RestoreLayersCommand(new Map(this.snapshot));
  }

  affectedIds(): string[] {
    return [...this.snapshot.keys()];
  }
}

export class SetFlagCommand implements EditorCommand {
  readonly type = 'setFlag';
  readonly label: string;

  constructor(
    private readonly ids: readonly string[],
    private readonly flag: 'locked' | 'hidden',
    private readonly value: boolean,
  ) {
    const name = flag === 'locked' ? '锁定' : '隐藏';
    this.label = value ? name : `取消${name}`;
  }

  apply(draft: EditorState): void {
    for (const id of this.ids) {
      const el = draft.elements.get(id);
      if (el === undefined) continue;
      draft.elements.set(id, { ...el, [this.flag]: this.value });
    }
  }

  invert(): EditorCommand {
    return new SetFlagCommand(this.ids, this.flag, !this.value);
  }

  affectedIds(): string[] {
    return [...this.ids];
  }
}

/**
 * 批量复合命令：把多个命令打包为一次撤销单元。
 * 例如「删除多个对象并解除其孔洞关联」。
 */
export class CompositeCommand implements EditorCommand {
  readonly type = 'composite';

  constructor(
    readonly label: string,
    private readonly commands: readonly EditorCommand[],
  ) {}

  apply(draft: EditorState): void {
    for (const c of this.commands) c.apply(draft);
  }

  invert(): EditorCommand {
    // 反向命令需逆序执行
    return new CompositeCommand(this.label, [...this.commands].reverse().map((c) => c.invert()));
  }

  affectedIds(): string[] {
    const ids = new Set<string>();
    for (const c of this.commands) for (const id of c.affectedIds()) ids.add(id);
    return [...ids];
  }
}

/** 「回到自动识别初始结果」：用快照整体替换。 */
export class ResetToAutoCommand implements EditorCommand {
  readonly type = 'resetToAuto';
  readonly label = '回到自动识别结果';
  private prevElements: VectorElement[] = [];
  private prevOrder: string[] = [];

  constructor(
    private readonly autoElements: readonly VectorElement[],
    private readonly autoOrder: readonly string[],
  ) {}

  apply(draft: EditorState): void {
    this.prevElements = [...draft.elements.values()].map(cloneElement);
    this.prevOrder = [...draft.order];
    draft.elements.clear();
    draft.order.length = 0;
    for (const el of this.autoElements) draft.elements.set(el.id, cloneElement(el));
    draft.order.push(...this.autoOrder);
  }

  invert(): EditorCommand {
    return new ResetToAutoCommand(this.prevElements, this.prevOrder);
  }

  affectedIds(): string[] {
    return this.autoOrder.slice();
  }
}

function sqDist(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export { cloneElement, readPoints, writePoints, promoteForNodeEdit };
