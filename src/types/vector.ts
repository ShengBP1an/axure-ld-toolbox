/**
 * 矢量数据模型。
 *
 * 坐标系约定（全局唯一）：
 *   - 所有 VectorElement 的顶点坐标一律以「地图单位（unit）」存储；
 *   - 原点在左上角，x 向右为正，y 向下为正；
 *   - strokeWidth 同样以地图单位存储；
 *   - 渲染与导出时才经 core/geometry/transform.ts 换算到画布像素，
 *     任何其它模块不得自行乘除 pixelsPerUnit。
 */

export interface Point {
  x: number;
  y: number;
}

/** 逻辑图层，决定 SVG 的 <g> 分组与默认配色。 */
export type LayerKind = 'boundary' | 'wall' | 'region' | 'review';

export const LAYER_KINDS: readonly LayerKind[] = ['boundary', 'wall', 'region', 'review'];

export const LAYER_LABELS: Record<LayerKind, string> = {
  boundary: '地图边界',
  wall: '墙线 / 分隔线',
  region: '封闭区域',
  review: '待确认',
};

/** SVG 元素种类，与导出映射一一对应。 */
export type VectorKind = 'line' | 'polyline' | 'rect' | 'polygon' | 'openPath' | 'closedPath';

export const VECTOR_KIND_LABELS: Record<VectorKind, string> = {
  line: '直线',
  polyline: '折线',
  rect: '矩形',
  polygon: '多边形',
  openPath: '开放路径',
  closedPath: '封闭路径',
};

export interface StyleSpec {
  /** CSS 颜色字符串，'none' 表示不填充。 */
  fill: string;
  fillOpacity: number;
  stroke: string;
  /** 以地图单位表示，导出时换算为像素。 */
  strokeWidth: number;
  strokeOpacity: number;
  strokeLinecap: 'butt' | 'round' | 'square';
  strokeLinejoin: 'miter' | 'round' | 'bevel';
  /** 仅用于「待确认」对象的虚线提示，导出时可按设置移除。 */
  strokeDasharray?: string;
}

export interface VectorBase {
  /** 稳定、唯一、可读，例如 'wall-line-0007'。跨保存/载入保持不变。 */
  id: string;
  layer: LayerKind;
  /** 0..1，编辑后由 confidence.ts 增量重算。 */
  confidence: number;
  issueIds: string[];
  style: StyleSpec;
  locked?: boolean;
  hidden?: boolean;
  /** auto = 自动识别产物；manual = 用户新建或已被用户修改。 */
  source: 'auto' | 'manual';
  /** 可选的可读名称，缺省时 UI 用 id + kind 展示。 */
  name?: string;
}

export type LineElement = VectorBase & { kind: 'line'; a: Point; b: Point };
export type PolylineElement = VectorBase & { kind: 'polyline'; points: Point[] };
export type RectElement = VectorBase & { kind: 'rect'; x: number; y: number; w: number; h: number };
export type PolygonElement = VectorBase & { kind: 'polygon'; points: Point[]; regular?: boolean };
export type OpenPathElement = VectorBase & { kind: 'openPath'; points: Point[] };
export type ClosedPathElement = VectorBase & {
  kind: 'closedPath';
  points: Point[];
  /** 若本对象是某个区域的孔洞，记录其宿主 id（导出为独立对象 + data-hole-of）。 */
  holeOf?: string;
};

export type VectorElement =
  | LineElement
  | PolylineElement
  | RectElement
  | PolygonElement
  | OpenPathElement
  | ClosedPathElement;

/** 判断元素在几何上是否闭合（决定 SVG 是否需要 Z / 是否可填充）。 */
export function isClosedKind(kind: VectorKind): boolean {
  return kind === 'rect' || kind === 'polygon' || kind === 'closedPath';
}

/** 判断元素是否以 points 数组承载顶点（line / rect 除外）。 */
export function hasPointList(
  el: VectorElement,
): el is PolylineElement | PolygonElement | OpenPathElement | ClosedPathElement {
  return el.kind === 'polyline' || el.kind === 'polygon' || el.kind === 'openPath' || el.kind === 'closedPath';
}

/** 统一读取任意元素的顶点序列（rect 展开为四角，line 展开为两端）。 */
export function elementPoints(el: VectorElement): Point[] {
  switch (el.kind) {
    case 'line':
      return [el.a, el.b];
    case 'rect':
      return [
        { x: el.x, y: el.y },
        { x: el.x + el.w, y: el.y },
        { x: el.x + el.w, y: el.y + el.h },
        { x: el.x, y: el.y + el.h },
      ];
    default:
      return el.points;
  }
}

/** 顶点数量，UI 与简化率统计使用。 */
export function elementNodeCount(el: VectorElement): number {
  return elementPoints(el).length;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function elementBounds(el: VectorElement): Bounds {
  const pts = elementPoints(el);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function boundsUnion(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function expandBounds(b: Bounds, pad: number): Bounds {
  return { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return !(a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY);
}

export function boundsContains(outer: Bounds, inner: Bounds): boolean {
  return (
    outer.minX <= inner.minX && outer.minY <= inner.minY && outer.maxX >= inner.maxX && outer.maxY >= inner.maxY
  );
}

/** 各图层默认样式（strokeWidth 单位为地图单位，由调用方按比例给出）。 */
export function defaultStyle(layer: LayerKind, strokeWidth: number): StyleSpec {
  switch (layer) {
    case 'boundary':
      return {
        fill: 'none',
        fillOpacity: 1,
        stroke: '#22D3EE',
        strokeWidth: strokeWidth * 1.6,
        strokeOpacity: 1,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      };
    case 'wall':
      return {
        fill: 'none',
        fillOpacity: 1,
        stroke: '#C6D4E3',
        strokeWidth,
        strokeOpacity: 1,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      };
    case 'region':
      return {
        fill: '#0EA5E9',
        fillOpacity: 0.14,
        stroke: '#0EA5E9',
        strokeWidth,
        strokeOpacity: 0.9,
        strokeLinecap: 'butt',
        strokeLinejoin: 'miter',
      };
    case 'review':
      return {
        fill: 'none',
        fillOpacity: 1,
        stroke: '#FBBF24',
        strokeWidth,
        strokeOpacity: 1,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        strokeDasharray: `${strokeWidth * 3} ${strokeWidth * 2}`,
      };
  }
}
