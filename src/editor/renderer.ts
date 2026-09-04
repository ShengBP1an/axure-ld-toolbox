/**
 * 画布渲染器。
 *
 * 分三层绘制：
 *   1. 底图层（原图 / 预处理图，可调不透明度）
 *   2. 矢量层（按图层着色，选中高亮）
 *   3. 覆盖层（节点、包围框、吸附参考线、问题高亮、框选矩形）
 *
 * 使用 Canvas 2D 而非 SVG DOM：2000 个元素时 SVG 的 DOM 更新会明显掉帧，
 * Canvas 可自控重绘范围与绘制顺序。
 */

import type {
  BackdropConfig,
  HoverState,
  NodeRef,
  Selection,
  ViewportState,
} from '../types/editor';
import type { Bounds, LayerKind, Point, VectorElement } from '../types/vector';
import { elementBounds, elementPoints, isClosedKind } from '../types/vector';
import type { RecognitionIssue } from '../types/recognition';
import { LOW_CONFIDENCE_THRESHOLD, VERY_LOW_CONFIDENCE } from '../core/recognize/confidence';
import { unitToScreen, visibleBounds } from './viewport';
import type { SnapGuide } from './snapEngine';

/** 图层配色（与 defaultStyle 一致，但渲染时可覆盖以保证可读性）。 */
const LAYER_COLOR: Record<LayerKind, { stroke: string; fill: string; width: number }> = {
  boundary: { stroke: '#22D3EE', fill: 'rgba(34,211,238,0.06)', width: 2.2 },
  wall: { stroke: '#C6D4E3', fill: 'none', width: 1.5 },
  region: { stroke: '#0EA5E9', fill: 'rgba(14,165,233,0.13)', width: 1.4 },
  review: { stroke: '#FBBF24', fill: 'rgba(251,191,36,0.07)', width: 1.6 },
};

const SELECT_COLOR = '#22D3EE';
const HOVER_COLOR = '#A78BFA';
const NODE_FILL = '#0A0E14';
const GUIDE_COLOR = '#F472B6';
const ISSUE_COLOR = '#FBBF24';
const ISSUE_ERROR_COLOR = '#F87171';

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  dpr: number;
  viewport: ViewportState;
  backdrop: BackdropConfig;
  /** 地图边界（unit 空间），绘制画布纸面。 */
  mapBounds: Bounds;
}

export interface RenderData {
  elements: readonly VectorElement[];
  selection: Selection;
  hover: HoverState;
  issues: readonly RecognitionIssue[];
  /** 需要脉冲高亮的问题区域（问题列表悬停时）。 */
  highlightRegion: Bounds | null;
  /** 吸附参考线。 */
  guides: readonly SnapGuide[];
  /** 框选矩形（unit 空间）。 */
  marquee: Bounds | null;
  /** 绘制中的草稿路径。 */
  draft: { points: Point[]; closed: boolean } | null;
  /** 是否显示节点（节点工具或有选中时）。 */
  showNodes: boolean;
}

/** 清空并绘制背景网格与画布纸面。 */
export function drawBackground(rc: RenderContext): void {
  const { ctx, width, height, viewport, mapBounds } = rc;

  ctx.save();
  ctx.setTransform(rc.dpr, 0, 0, rc.dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // 深炭底
  ctx.fillStyle = '#0A0E14';
  ctx.fillRect(0, 0, width, height);

  // 等距网格（随缩放自适应密度）
  drawGrid(ctx, width, height, viewport);

  // 画布纸面
  const tl = unitToScreen({ x: mapBounds.minX, y: mapBounds.minY }, viewport);
  const br = unitToScreen({ x: mapBounds.maxX, y: mapBounds.maxY }, viewport);
  const pw = br.x - tl.x;
  const ph = br.y - tl.y;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.75)';
  ctx.shadowBlur = 28;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = '#111823';
  ctx.fillRect(tl.x, tl.y, pw, ph);
  ctx.restore();

  ctx.strokeStyle = 'rgba(34,211,238,0.28)';
  ctx.lineWidth = 1;
  ctx.strokeRect(tl.x + 0.5, tl.y + 0.5, pw - 1, ph - 1);

  ctx.restore();
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  v: ViewportState,
): void {
  // 目标屏幕间距 ~24px，取 1/2/5 × 10^n 的"漂亮"步长
  const targetPx = 24;
  const rawStep = targetPx / v.scale;
  const step = niceStep(rawStep);
  const screenStep = step * v.scale;
  if (screenStep < 6) return;

  const startX = Math.floor(-v.offsetX / screenStep) * screenStep + v.offsetX;
  const startY = Math.floor(-v.offsetY / screenStep) * screenStep + v.offsetY;

  ctx.save();
  ctx.strokeStyle = 'rgba(46,61,80,0.32)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = startX; x <= width; x += screenStep) {
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, height);
  }
  for (let y = startY; y <= height; y += screenStep) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(width, Math.round(y) + 0.5);
  }
  ctx.stroke();
  ctx.restore();
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = 10 ** exp;
  const norm = raw / base;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return mult * base;
}

/** 绘制底图。 */
export function drawBackdrop(
  rc: RenderContext,
  image: HTMLImageElement | HTMLCanvasElement | null,
): void {
  if (image === null || rc.backdrop.mode === 'none' || rc.backdrop.opacity <= 0) return;

  const { ctx, viewport, mapBounds } = rc;
  const tl = unitToScreen({ x: mapBounds.minX, y: mapBounds.minY }, viewport);
  const br = unitToScreen({ x: mapBounds.maxX, y: mapBounds.maxY }, viewport);

  ctx.save();
  ctx.setTransform(rc.dpr, 0, 0, rc.dpr, 0, 0);
  ctx.globalAlpha = rc.backdrop.opacity;
  ctx.imageSmoothingEnabled = viewport.scale < 2;
  ctx.drawImage(image, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  ctx.restore();
}

/** 绘制矢量对象与覆盖层。 */
export function drawVectors(rc: RenderContext, data: RenderData): void {
  const { ctx, viewport } = rc;
  if (!rc.backdrop.showVectors) return;

  ctx.save();
  ctx.setTransform(rc.dpr, 0, 0, rc.dpr, 0, 0);

  const view = visibleBounds(viewport, rc.width, rc.height);
  const selectedIds = new Set(data.selection.elementIds);
  const issueElementIds = collectIssueElements(data.issues);

  /* 1) 填充与描边 */
  for (const el of data.elements) {
    if (el.hidden === true) continue;
    const b = elementBounds(el);
    // 视锥剔除
    if (b.maxX < view.minX || b.minX > view.maxX || b.maxY < view.minY || b.minY > view.maxY) continue;

    const pts = elementPoints(el);
    if (pts.length < 2) continue;
    const closed = isClosedKind(el.kind);
    const theme = LAYER_COLOR[el.layer];
    const lowConfidence = el.confidence < LOW_CONFIDENCE_THRESHOLD;
    const hasIssue = issueElementIds.has(el.id);

    ctx.beginPath();
    tracePath(ctx, pts, closed, viewport);

    // 填充
    if (closed && theme.fill !== 'none') {
      ctx.fillStyle = theme.fill;
      ctx.fill();
    }

    // 描边
    ctx.lineWidth = theme.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = theme.stroke;
    ctx.globalAlpha = el.locked === true ? 0.45 : 1;

    // 低置信度 / 待确认用虚线，视觉上立刻区分
    if (lowConfidence || el.layer === 'review') {
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = el.confidence < VERY_LOW_CONFIDENCE ? ISSUE_ERROR_COLOR : ISSUE_COLOR;
    } else {
      ctx.setLineDash([]);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    // 问题标记：外圈光晕
    if (hasIssue && rc.backdrop.showIssues) {
      ctx.save();
      ctx.strokeStyle = ISSUE_COLOR;
      ctx.globalAlpha = 0.3;
      ctx.lineWidth = theme.width + 5;
      ctx.stroke();
      ctx.restore();
    }
  }

  /* 2) 悬停高亮 */
  if (data.hover.elementId !== null) {
    const el = data.elements.find((e) => e.id === data.hover.elementId);
    if (el !== undefined && !selectedIds.has(el.id)) {
      const pts = elementPoints(el);
      ctx.beginPath();
      tracePath(ctx, pts, isClosedKind(el.kind), viewport);
      ctx.strokeStyle = HOVER_COLOR;
      ctx.lineWidth = LAYER_COLOR[el.layer].width + 1.4;
      ctx.globalAlpha = 0.75;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  /* 3) 选中高亮 + 包围框 */
  for (const id of data.selection.elementIds) {
    const el = data.elements.find((e) => e.id === id);
    if (el === undefined || el.hidden === true) continue;
    const pts = elementPoints(el);

    ctx.beginPath();
    tracePath(ctx, pts, isClosedKind(el.kind), viewport);
    ctx.strokeStyle = SELECT_COLOR;
    ctx.lineWidth = LAYER_COLOR[el.layer].width + 1.2;
    ctx.stroke();

    drawSelectionBox(ctx, elementBounds(el), viewport);
  }

  /* 4) 节点 */
  if (data.showNodes) {
    const selectedNodes = new Set(data.selection.nodes.map((n) => `${n.elementId}:${n.index}`));
    const targetIds =
      data.selection.elementIds.length > 0
        ? new Set(data.selection.elementIds)
        : new Set(data.elements.filter((e) => e.hidden !== true).map((e) => e.id));

    for (const el of data.elements) {
      if (el.hidden === true || !targetIds.has(el.id)) continue;
      const pts = elementPoints(el);
      pts.forEach((p, i) => {
        const s = unitToScreen(p, viewport);
        const isSelected = selectedNodes.has(`${el.id}:${i}`);
        const isHovered =
          data.hover.node !== null && data.hover.node.elementId === el.id && data.hover.node.index === i;
        const size = isHovered ? 5.5 : isSelected ? 4.5 : 3.5;

        ctx.beginPath();
        ctx.rect(s.x - size, s.y - size, size * 2, size * 2);
        ctx.fillStyle = isSelected ? SELECT_COLOR : NODE_FILL;
        ctx.fill();
        ctx.strokeStyle = isSelected ? '#FFFFFF' : SELECT_COLOR;
        ctx.lineWidth = 1.4;
        ctx.stroke();
      });
    }
  }

  /* 5) 吸附参考线 */
  for (const g of data.guides) {
    ctx.save();
    ctx.strokeStyle = GUIDE_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    if (g.kind === 'endpoint') {
      const s = unitToScreen(g.from, viewport);
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(s.x, s.y, 8, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.arc(s.x, s.y, 13, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const a = unitToScreen(g.from, viewport);
      const b = unitToScreen(g.to, viewport);
      // 延长参考线到画布外，便于对齐判断
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ext = 2000;
      ctx.beginPath();
      ctx.moveTo(a.x - (dx / len) * ext, a.y - (dy / len) * ext);
      ctx.lineTo(a.x + (dx / len) * ext, a.y + (dy / len) * ext);
      ctx.stroke();
      if (g.label !== undefined) {
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.fillStyle = GUIDE_COLOR;
        ctx.font = '600 10px Roboto, sans-serif';
        ctx.fillText(g.label, b.x + 8, b.y - 6);
      }
    }
    ctx.restore();
  }

  /* 6) 绘制草稿 */
  if (data.draft !== null && data.draft.points.length > 0) {
    ctx.save();
    ctx.strokeStyle = SELECT_COLOR;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    tracePath(ctx, data.draft.points, data.draft.closed, viewport);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const p of data.draft.points) {
      const s = unitToScreen(p, viewport);
      ctx.beginPath();
      ctx.rect(s.x - 3, s.y - 3, 6, 6);
      ctx.fillStyle = NODE_FILL;
      ctx.fill();
      ctx.strokeStyle = SELECT_COLOR;
      ctx.lineWidth = 1.3;
      ctx.stroke();
    }
    ctx.restore();
  }

  /* 7) 框选矩形 */
  if (data.marquee !== null) {
    const tl = unitToScreen({ x: data.marquee.minX, y: data.marquee.minY }, viewport);
    const br = unitToScreen({ x: data.marquee.maxX, y: data.marquee.maxY }, viewport);
    ctx.save();
    ctx.fillStyle = 'rgba(34,211,238,0.1)';
    ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    ctx.strokeStyle = SELECT_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(tl.x + 0.5, tl.y + 0.5, br.x - tl.x - 1, br.y - tl.y - 1);
    ctx.restore();
  }

  /* 8) 问题区域脉冲高亮 */
  if (data.highlightRegion !== null && rc.backdrop.showIssues) {
    const r = data.highlightRegion;
    const tl = unitToScreen({ x: r.minX, y: r.minY }, viewport);
    const br = unitToScreen({ x: r.maxX, y: r.maxY }, viewport);
    ctx.save();
    ctx.strokeStyle = ISSUE_COLOR;
    ctx.lineWidth = 2;
    ctx.shadowColor = ISSUE_COLOR;
    ctx.shadowBlur = 14;
    const pad = 6;
    ctx.strokeRect(tl.x - pad, tl.y - pad, br.x - tl.x + pad * 2, br.y - tl.y + pad * 2);
    ctx.restore();
  }

  ctx.restore();
}

function tracePath(
  ctx: CanvasRenderingContext2D,
  pts: readonly Point[],
  closed: boolean,
  v: ViewportState,
): void {
  const first = unitToScreen(pts[0]!, v);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < pts.length; i++) {
    const s = unitToScreen(pts[i]!, v);
    ctx.lineTo(s.x, s.y);
  }
  if (closed) ctx.closePath();
}

function drawSelectionBox(ctx: CanvasRenderingContext2D, b: Bounds, v: ViewportState): void {
  const tl = unitToScreen({ x: b.minX, y: b.minY }, v);
  const br = unitToScreen({ x: b.maxX, y: b.maxY }, v);
  const pad = 4;
  ctx.save();
  ctx.strokeStyle = 'rgba(34,211,238,0.5)';
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.strokeRect(tl.x - pad, tl.y - pad, br.x - tl.x + pad * 2, br.y - tl.y + pad * 2);
  ctx.restore();
}

function collectIssueElements(issues: readonly RecognitionIssue[]): Set<string> {
  const out = new Set<string>();
  for (const i of issues) {
    if (i.severity === 'info') continue;
    for (const id of i.elementIds) out.add(id);
  }
  return out;
}

/** 把二值 / 灰度缓冲渲染为离屏 canvas，作为底图使用。 */
export function makeBackdropCanvas(
  data: Uint8Array,
  width: number,
  height: number,
  mode: 'binary' | 'gray',
): HTMLCanvasElement | null {
  if (width <= 0 || height <= 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;

  const rgba = new Uint8ClampedArray(width * height * 4);
  if (mode === 'binary') {
    for (let i = 0; i < width * height; i++) {
      const on = data[i] !== 0;
      const o = i * 4;
      rgba[o] = 0xe6;
      rgba[o + 1] = 0xed;
      rgba[o + 2] = 0xf3;
      rgba[o + 3] = on ? 235 : 0;
    }
  } else {
    for (let i = 0; i < width * height; i++) {
      const v = data[i] ?? 0;
      const o = i * 4;
      rgba[o] = v;
      rgba[o + 1] = v;
      rgba[o + 2] = v;
      rgba[o + 3] = 255;
    }
  }
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas;
}
