/**
 * 校正编辑器画布。
 *
 * 交互状态机：idle → (hover) → panning / marquee / dragElements / dragNode / drawing
 * 所有几何修改都通过 EditorCommand 提交，保证可撤销。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore } from '../store/useEditorStore';
import { useProjectStore } from '../store/useProjectStore';
import type { NodeRef } from '../types/editor';
import type { Bounds, LayerKind, Point, VectorElement, VectorKind } from '../types/vector';
import { defaultStyle, elementBounds, elementPoints } from '../types/vector';
import { canvasBoundsInUnit, baseStrokeWidthUnit } from '../core/geometry/transform';
import {
  AddElementsCommand,
  DeleteElementsCommand,
  DeleteNodeCommand,
  InsertNodeCommand,
  MoveElementsCommand,
  MoveNodeCommand,
} from '../store/commands';
import { SpatialIndex } from './spatialIndex';
import { boxSelect, boxSelectNodes, hitTest, normalizeBox, projectOntoEdge } from './hitTest';
import { SnapContext, type SnapGuide } from './snapEngine';
import { drawBackdrop, drawBackground, drawVectors, makeBackdropCanvas } from './renderer';
import { fitBounds, pan, screenToUnit, zoomAt } from './viewport';
import { idFactory } from '../lib/id';

type Interaction =
  | { kind: 'idle' }
  | { kind: 'panning'; lastScreen: Point }
  | { kind: 'marquee'; startUnit: Point; currentUnit: Point }
  | { kind: 'dragElements'; startUnit: Point; lastUnit: Point; ids: string[]; moved: boolean }
  | {
      kind: 'dragNode';
      elementId: string;
      index: number;
      original: Point;
      current: Point;
      anchor: Point | null;
    }
  | { kind: 'drawing'; points: Point[] };

export interface EditorCanvasProps {
  /** 底图（原图）。 */
  sourceImage: HTMLImageElement | null;
  /** 标定 / 特殊模式下屏蔽编辑交互。 */
  interactionDisabled?: boolean;
  /** 问题悬停高亮区域。 */
  highlightRegion?: Bounds | null;
  /** 向外暴露视口控制。 */
  onViewportApi?: (api: ViewportApi) => void;
}

export interface ViewportApi {
  fitToContent(): void;
  focusOn(bounds: Bounds): void;
  zoomBy(factor: number): void;
  resetZoom(): void;
}

export function EditorCanvas({
  sourceImage,
  interactionDisabled = false,
  highlightRegion = null,
  onViewportApi,
}: EditorCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [interaction, setInteraction] = useState<Interaction>({ kind: 'idle' });
  const [guides, setGuides] = useState<readonly SnapGuide[]>([]);
  const snapCtxRef = useRef<SnapContext | null>(null);

  const settings = useProjectStore((s) => s.settings);
  const preview = useProjectStore((s) => s.preview);

  const elements = useEditorStore((s) => s.elements);
  const order = useEditorStore((s) => s.order);
  const revision = useEditorStore((s) => s.revision);
  const issues = useEditorStore((s) => s.issues);
  const selection = useEditorStore((s) => s.selection);
  const hover = useEditorStore((s) => s.hover);
  const tool = useEditorStore((s) => s.tool);
  const snap = useEditorStore((s) => s.snap);
  const snapSuspended = useEditorStore((s) => s.snapSuspended);
  const backdrop = useEditorStore((s) => s.backdrop);
  const viewport = useEditorStore((s) => s.viewport);
  const layerVisible = useEditorStore((s) => s.layerVisible);
  const layerLocked = useEditorStore((s) => s.layerLocked);

  const setViewport = useEditorStore((s) => s.setViewport);
  const setHover = useEditorStore((s) => s.setHover);
  const selectElements = useEditorStore((s) => s.selectElements);
  const selectNodes = useEditorStore((s) => s.selectNodes);
  const clearSelection = useEditorStore((s) => s.clearSelection);
  const execute = useEditorStore((s) => s.execute);

  /** 可见元素（按渲染顺序）。 */
  const visible = useMemo<VectorElement[]>(() => {
    const out: VectorElement[] = [];
    for (const id of order) {
      const el = elements.get(id);
      if (el === undefined) continue;
      if (el.hidden === true) continue;
      if (layerVisible[el.layer] === false) continue;
      out.push(layerLocked[el.layer] === true ? { ...el, locked: true } : el);
    }
    return out;
    // revision 变化即代表数据变化
  }, [order, elements, layerVisible, layerLocked, revision]);

  const index = useMemo(() => new SpatialIndex(visible), [visible]);
  const issueList = useMemo(() => [...issues.values()], [issues, revision]);
  const mapBounds = useMemo(() => canvasBoundsInUnit(settings), [settings]);

  /** 底图 canvas（预处理图模式）。 */
  const backdropCanvas = useMemo(() => {
    if (backdrop.mode !== 'preprocessed' || preview === null) return null;
    return makeBackdropCanvas(preview.binaryData, preview.binaryWidth, preview.binaryHeight, 'binary');
  }, [backdrop.mode, preview]);

  /* ---------------- 尺寸同步 ---------------- */
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r === undefined) return;
      setSize({ width: Math.round(r.width), height: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---------------- 自动适应窗口 ----------------
   *
   * 除首次挂载外，地图尺寸变化时也必须重新适应：
   * 否则用户在「尺寸与比例」步骤把地图从默认 60×40 改成 100×70 后，
   * 视口仍按旧尺寸定位，画面会明显偏移 / 越界。 */
  const lastFitKey = useRef<string>('');
  useEffect(() => {
    if (size.width === 0 || size.height === 0) return;
    const key = `${mapBounds.maxX.toFixed(4)}x${mapBounds.maxY.toFixed(4)}`;
    if (key === lastFitKey.current) return;
    lastFitKey.current = key;
    setViewport(fitBounds(mapBounds, size.width, size.height, 48));
  }, [size, mapBounds, setViewport]);

  /* ---------------- 视口 API ---------------- */
  useEffect(() => {
    if (onViewportApi === undefined) return;
    onViewportApi({
      fitToContent: () => {
        const b = visible.length > 0 ? unionBounds(visible) : mapBounds;
        setViewport(fitBounds(b, size.width, size.height, 48));
      },
      focusOn: (b) => {
        const cur = useEditorStore.getState().viewport;
        const cx = (b.minX + b.maxX) / 2;
        const cy = (b.minY + b.maxY) / 2;
        const w = Math.max(1e-6, b.maxX - b.minX);
        const h = Math.max(1e-6, b.maxY - b.minY);
        const needed = Math.min((size.width * 0.4) / w, (size.height * 0.4) / h);
        const scale = Math.max(cur.scale, Math.min(needed, 60));
        setViewport({
          scale,
          offsetX: size.width / 2 - cx * scale,
          offsetY: size.height / 2 - cy * scale,
        });
      },
      zoomBy: (factor) => {
        setViewport(zoomAt(viewport, { x: size.width / 2, y: size.height / 2 }, factor));
      },
      resetZoom: () => {
        setViewport(fitBounds(mapBounds, size.width, size.height, 48));
      },
    });
  }, [onViewportApi, visible, mapBounds, size, viewport, setViewport]);

  /* ---------------- 绘制 ---------------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || size.width === 0 || size.height === 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    const rc = {
      ctx,
      width: size.width,
      height: size.height,
      dpr,
      viewport,
      backdrop: snapSuspendedBackdrop(backdrop),
      mapBounds,
    };

    drawBackground(rc);
    if (backdrop.mode === 'source') drawBackdrop(rc, sourceImage);
    else if (backdrop.mode === 'preprocessed') drawBackdrop(rc, backdropCanvas);

    const marquee =
      interaction.kind === 'marquee' ? normalizeBox(interaction.startUnit, interaction.currentUnit) : null;
    const draft = interaction.kind === 'drawing' ? { points: interaction.points, closed: false } : null;

    drawVectors(rc, {
      elements: previewElements(visible, interaction),
      selection,
      hover,
      issues: issueList,
      highlightRegion,
      guides,
      marquee,
      draft,
      showNodes: tool === 'node' || selection.elementIds.length > 0 || interaction.kind === 'dragNode',
    });
  }, [
    size,
    viewport,
    backdrop,
    mapBounds,
    sourceImage,
    backdropCanvas,
    visible,
    selection,
    hover,
    issueList,
    highlightRegion,
    guides,
    interaction,
    tool,
    revision,
  ]);

  /* ---------------- 指针事件 ---------------- */

  const toUnit = useCallback(
    (e: { clientX: number; clientY: number }): Point => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect === undefined) return { x: 0, y: 0 };
      return screenToUnit({ x: e.clientX - rect.left, y: e.clientY - rect.top }, viewport);
    },
    [viewport],
  );

  const toScreenLocal = useCallback((e: { clientX: number; clientY: number }): Point => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect === undefined) return { x: 0, y: 0 };
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  const effectiveSnap = useMemo(
    () => ({ ...snap, enabled: snap.enabled && !snapSuspended }),
    [snap, snapSuspended],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (interactionDisabled) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const unit = toUnit(e);

      // 中键或空格 / 平移工具 → 平移
      if (e.button === 1 || tool === 'pan') {
        setInteraction({ kind: 'panning', lastScreen: toScreenLocal(e) });
        return;
      }
      if (e.button !== 0) return;

      /* 绘制工具 */
      if (tool === 'draw') {
        const snapped = solveSnap(unit, null);
        setInteraction((prev) =>
          prev.kind === 'drawing'
            ? { kind: 'drawing', points: [...prev.points, snapped] }
            : { kind: 'drawing', points: [snapped] },
        );
        return;
      }

      const hit = hitTest(unit, visible, index, viewport, { preferNodes: tool === 'node' });

      /* 节点工具 */
      if (tool === 'node') {
        if (hit !== null && hit.kind === 'node') {
          const el = elements.get(hit.elementId);
          if (el === undefined || el.locked === true) return;
          const pts = elementPoints(el);
          const anchor = neighborAnchor(pts, hit.index, el.kind);
          snapCtxRef.current = new SnapContext(visible, effectiveSnap, viewport);
          selectNodes([{ elementId: hit.elementId, index: hit.index }], e.shiftKey);
          selectElements([hit.elementId], false);
          setInteraction({
            kind: 'dragNode',
            elementId: hit.elementId,
            index: hit.index,
            original: { ...pts[hit.index]! },
            current: { ...pts[hit.index]! },
            anchor,
          });
          return;
        }
        // Alt + 点击边 → 插入节点
        if (hit !== null && hit.kind === 'edge' && e.altKey) {
          const el = elements.get(hit.elementId);
          if (el === undefined || el.locked === true) return;
          const proj = projectOntoEdge(el, hit.index, unit);
          if (proj !== null) {
            execute(new InsertNodeCommand(el.id, proj.insertIndex, proj.point));
          }
          return;
        }
        if (hit !== null) {
          selectElements([hit.elementId], e.shiftKey);
          return;
        }
        setInteraction({ kind: 'marquee', startUnit: unit, currentUnit: unit });
        if (!e.shiftKey) clearSelection();
        return;
      }

      /* 选择工具 */
      if (hit !== null) {
        const el = elements.get(hit.elementId);
        if (el === undefined) return;
        const alreadySelected = selection.elementIds.includes(hit.elementId);
        if (!alreadySelected) selectElements([hit.elementId], e.shiftKey);

        if (el.locked !== true) {
          const ids = alreadySelected || e.shiftKey
            ? unique([...selection.elementIds, hit.elementId])
            : [hit.elementId];
          snapCtxRef.current = new SnapContext(visible, effectiveSnap, viewport);
          setInteraction({ kind: 'dragElements', startUnit: unit, lastUnit: unit, ids, moved: false });
        }
        return;
      }

      if (!e.shiftKey) clearSelection();
      setInteraction({ kind: 'marquee', startUnit: unit, currentUnit: unit });
    },
    [
      interactionDisabled,
      tool,
      toUnit,
      toScreenLocal,
      visible,
      index,
      viewport,
      elements,
      selection.elementIds,
      selectElements,
      selectNodes,
      clearSelection,
      execute,
      effectiveSnap,
    ],
  );

  const solveSnap = useCallback(
    (raw: Point, anchor: Point | null, exclude?: (id: string, i: number) => boolean): Point => {
      const ctx = snapCtxRef.current;
      if (ctx === null || !effectiveSnap.enabled) return raw;
      const r = ctx.solve(raw, anchor, exclude);
      setGuides(r.guides);
      return r.point;
    },
    [effectiveSnap.enabled],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (interactionDisabled) return;
      const unit = toUnit(e);

      switch (interaction.kind) {
        case 'idle': {
          const hit = hitTest(unit, visible, index, viewport, { preferNodes: tool === 'node' });
          setHover({
            elementId: hit?.elementId ?? null,
            node: hit !== null && hit.kind === 'node' ? { elementId: hit.elementId, index: hit.index } : null,
            edge: hit !== null && hit.kind === 'edge' ? { elementId: hit.elementId, index: hit.index } : null,
          });
          break;
        }
        case 'panning': {
          const cur = toScreenLocal(e);
          setViewport(pan(viewport, cur.x - interaction.lastScreen.x, cur.y - interaction.lastScreen.y));
          setInteraction({ kind: 'panning', lastScreen: cur });
          break;
        }
        case 'marquee':
          setInteraction({ ...interaction, currentUnit: unit });
          break;
        case 'dragElements': {
          const dx = unit.x - interaction.lastUnit.x;
          const dy = unit.y - interaction.lastUnit.y;
          if (dx === 0 && dy === 0) break;
          // 拖动过程中即时应用，配合命令栈的合并策略
          execute(new MoveElementsCommand(interaction.ids, dx, dy));
          setInteraction({ ...interaction, lastUnit: unit, moved: true });
          break;
        }
        case 'dragNode': {
          const idsSet = new Set([interaction.elementId]);
          const snapped = solveSnap(unit, interaction.anchor, (id, i) =>
            idsSet.has(id) && i === interaction.index,
          );
          setInteraction({ ...interaction, current: snapped });
          break;
        }
        case 'drawing':
          // 绘制态下用 hover 展示下一个点的吸附预览
          break;
      }
    },
    [
      interactionDisabled,
      interaction,
      toUnit,
      toScreenLocal,
      visible,
      index,
      viewport,
      tool,
      setHover,
      setViewport,
      execute,
      solveSnap,
    ],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>): void => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      setGuides([]);
      snapCtxRef.current = null;

      switch (interaction.kind) {
        case 'marquee': {
          const box = normalizeBox(interaction.startUnit, interaction.currentUnit);
          const tiny = box.maxX - box.minX < 1e-9 && box.maxY - box.minY < 1e-9;
          if (!tiny) {
            if (tool === 'node') {
              const restrict =
                selection.elementIds.length > 0 ? new Set(selection.elementIds) : undefined;
              const nodes = boxSelectNodes(box, visible, restrict);
              selectNodes(nodes, e.shiftKey);
            } else {
              const ids = boxSelect(box, visible, index, 'intersect');
              selectElements(ids, e.shiftKey);
            }
          }
          setInteraction({ kind: 'idle' });
          break;
        }
        case 'dragNode': {
          const moved =
            Math.abs(interaction.current.x - interaction.original.x) > 1e-9 ||
            Math.abs(interaction.current.y - interaction.original.y) > 1e-9;
          if (moved) {
            execute(
              new MoveNodeCommand(
                interaction.elementId,
                interaction.index,
                interaction.original,
                interaction.current,
              ),
            );
          }
          setInteraction({ kind: 'idle' });
          break;
        }
        case 'drawing':
          // 保持绘制态，等待双击 / Enter 结束
          break;
        default:
          setInteraction({ kind: 'idle' });
      }
    },
    [interaction, tool, visible, index, selection.elementIds, selectElements, selectNodes, execute],
  );

  /* ---------------- 滚轮缩放 ---------------- */
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      setViewport(zoomAt(useEditorStore.getState().viewport, anchor, factor));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setViewport]);

  /* ---------------- 完成绘制 ---------------- */
  const finishDrawing = useCallback(
    (closed: boolean): void => {
      if (interaction.kind !== 'drawing') return;
      const pts = interaction.points;
      const minPts = closed ? 3 : 2;
      if (pts.length < minPts) {
        setInteraction({ kind: 'idle' });
        return;
      }

      const sw = baseStrokeWidthUnit(settings);
      const layer: LayerKind = closed ? 'region' : 'wall';
      const kind: VectorKind = closed ? 'closedPath' : pts.length === 2 ? 'line' : 'polyline';
      const id = idFactory.next(layer, kind);
      const base = {
        id,
        layer,
        confidence: 0.95,
        issueIds: [],
        style: defaultStyle(layer, sw),
        source: 'manual' as const,
      };
      const el: VectorElement =
        kind === 'line'
          ? { ...base, kind: 'line', a: pts[0]!, b: pts[1]! }
          : closed
            ? { ...base, kind: 'closedPath', points: pts }
            : { ...base, kind: 'polyline', points: pts };

      execute(new AddElementsCommand([el]));
      selectElements([id], false);
      setInteraction({ kind: 'idle' });
    },
    [interaction, settings, execute, selectElements],
  );

  /* ---------------- 键盘快捷键 ---------------- */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      // 输入框内不拦截
      if (target !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      const store = useEditorStore.getState();

      // 临时关闭吸附
      if (e.key === 'Alt' || e.key === 'Control') {
        store.setSnapSuspended(true);
      }

      if (e.key === 'Escape') {
        if (interaction.kind === 'drawing') setInteraction({ kind: 'idle' });
        else store.clearSelection();
        return;
      }

      if (interaction.kind === 'drawing') {
        if (e.key === 'Enter') {
          e.preventDefault();
          finishDrawing(false);
          return;
        }
        if (e.key.toLowerCase() === 'c') {
          e.preventDefault();
          finishDrawing(true);
          return;
        }
      }

      /* 删除 */
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (store.selection.nodes.length > 0 && store.tool === 'node') {
          // 逆序删除，避免索引位移
          const sorted = [...store.selection.nodes].sort((a, b) => b.index - a.index);
          for (const n of sorted) {
            const el = store.elements.get(n.elementId);
            if (el === undefined) continue;
            const pts = elementPoints(el);
            const p = pts[n.index];
            if (p === undefined) continue;
            store.execute(new DeleteNodeCommand(n.elementId, n.index, p));
          }
          return;
        }
        const els = store.selectedElements().filter((el) => el.locked !== true);
        if (els.length > 0) {
          const indices = els.map((el) => store.order.indexOf(el.id));
          store.execute(new DeleteElementsCommand(els, undefined, indices));
          store.clearSelection();
        }
        return;
      }

      /* 全选 */
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        store.selectElements(visible.filter((el) => el.locked !== true).map((el) => el.id), false);
        return;
      }

      /* 复制（原地偏移） */
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        const sw = baseStrokeWidthUnit(settings);
        const offset = sw * 6;
        const copies: VectorElement[] = store.selectedElements().map((el) => {
          const newId = idFactory.next(el.layer, el.kind);
          const shifted = shiftElement(el, offset, offset);
          return { ...shifted, id: newId, source: 'manual', issueIds: [] };
        });
        if (copies.length > 0) {
          store.execute(new AddElementsCommand(copies));
          store.selectElements(copies.map((c) => c.id), false);
        }
        return;
      }

      /* 工具切换 */
      const key = e.key.toLowerCase();
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (key === 'v') store.setTool('select');
        else if (key === 'n') store.setTool('node');
        else if (key === 'p') store.setTool('draw');
        else if (key === 'h') store.setTool('pan');
        else if (key === 'g') store.setSnap({ grid: !store.snap.grid });
      }

      /* 方向键微移 */
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const d = 1 / Math.max(1e-6, store.viewport.scale);
        const dx = (e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0) * d;
        const dy = (e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0) * d;
        const ids = store.selection.elementIds.filter(
          (id) => store.elements.get(id)?.locked !== true,
        );
        if (ids.length > 0) store.execute(new MoveElementsCommand(ids, dx, dy));
      }
    };

    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === 'Alt' || e.key === 'Control') {
        useEditorStore.getState().setSnapSuspended(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [interaction.kind, finishDrawing, visible, settings]);

  const cursor =
    interaction.kind === 'panning'
      ? 'grabbing'
      : tool === 'pan'
        ? 'grab'
        : tool === 'draw'
          ? 'crosshair'
          : tool === 'node'
            ? 'default'
            : hover.elementId !== null
              ? 'move'
              : 'default';

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden"
      style={{ cursor, touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        if (interaction.kind === 'idle') setHover({ elementId: null, node: null, edge: null });
      }}
      onDoubleClick={() => {
        if (interaction.kind === 'drawing') finishDrawing(false);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (interaction.kind === 'drawing') finishDrawing(true);
      }}
    >
      <canvas ref={canvasRef} className="block" />

      {interaction.kind === 'drawing' && (
        <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2">
          <div className="glass-pill animate-fade-up">
            <span className="text-[11px] text-fg">
              绘制中 · {interaction.points.length} 个点
            </span>
            <span className="text-[10px] text-fg-dim">Enter 结束 · C 闭合 · Esc 取消</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** 拖动节点时的预览：把正在拖的顶点替换为当前位置。 */
function previewElements(elements: readonly VectorElement[], interaction: Interaction): VectorElement[] {
  if (interaction.kind !== 'dragNode') return elements as VectorElement[];
  return elements.map((el) => {
    if (el.id !== interaction.elementId) return el;
    const pts = elementPoints(el);
    if (interaction.index < 0 || interaction.index >= pts.length) return el;
    const next = pts.map((p, i) => (i === interaction.index ? interaction.current : p));
    if (el.kind === 'line') return { ...el, a: next[0]!, b: next[1]! };
    if (el.kind === 'rect') {
      // 拖动矩形顶点时以多边形形态预览
      return { ...el, kind: 'polygon', points: next, regular: false } as VectorElement;
    }
    return { ...el, points: next } as VectorElement;
  });
}

/** 节点拖动时的角度吸附参考点：取相邻顶点。 */
function neighborAnchor(pts: readonly Point[], index: number, kind: VectorElement['kind']): Point | null {
  const closed = kind === 'polygon' || kind === 'closedPath' || kind === 'rect';
  const n = pts.length;
  if (n < 2) return null;
  if (closed) return pts[(index - 1 + n) % n] ?? null;
  if (index > 0) return pts[index - 1] ?? null;
  return pts[1] ?? null;
}

function shiftElement(el: VectorElement, dx: number, dy: number): VectorElement {
  if (el.kind === 'line') {
    return { ...el, a: { x: el.a.x + dx, y: el.a.y + dy }, b: { x: el.b.x + dx, y: el.b.y + dy } };
  }
  if (el.kind === 'rect') return { ...el, x: el.x + dx, y: el.y + dy };
  return { ...el, points: el.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
}

function unionBounds(elements: readonly VectorElement[]): Bounds {
  let out: Bounds | null = null;
  for (const el of elements) {
    const b = elementBounds(el);
    if (!Number.isFinite(b.minX)) continue;
    out =
      out === null
        ? { ...b }
        : {
            minX: Math.min(out.minX, b.minX),
            minY: Math.min(out.minY, b.minY),
            maxX: Math.max(out.maxX, b.maxX),
            maxY: Math.max(out.maxY, b.maxY),
          };
  }
  return out ?? { minX: 0, minY: 0, maxX: 1, maxY: 1 };
}

function snapSuspendedBackdrop<T>(b: T): T {
  return b;
}

function unique(a: readonly string[]): string[] {
  return [...new Set(a)];
}
