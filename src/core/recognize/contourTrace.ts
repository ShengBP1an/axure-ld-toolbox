/**
 * Moore 邻域边界追踪 —— 大面积填充块的降级路径。
 *
 * 使用场景：用户把区域整块涂黑（而非只画轮廓线）。
 * 此时骨架化会把整块压成一根线，平面图无法得到正确面积，
 * 因此对「大面积实心连通域」改用轮廓追踪。
 *
 * 不作为主路径，因为共享墙的房间会被并成一个连通块。
 */

import type { Point } from '../../types/vector';
import type { BinaryImage } from '../preprocess/IPreprocessor';
import { labelComponents } from '../preprocess/morphology';
import { area } from '../geometry/polygon';

/** Moore 邻域顺序（顺时针，从正左开始）。 */
const MOORE_DX = [-1, -1, 0, 1, 1, 1, 0, -1];
const MOORE_DY = [0, -1, -1, -1, 0, 1, 1, 1];

export interface TracedContour {
  /** 外轮廓像素序列（顺时针）。 */
  outer: Point[];
  /** 内孔轮廓。 */
  holes: Point[][];
  /** 连通域面积（像素数）。 */
  pixelArea: number;
  /** 连通域标签。 */
  label: number;
}

export interface ContourOptions {
  /** 只处理面积 ≥ 此值的连通域。 */
  minArea: number;
  /** 实心度阈值：面积 / 包围盒面积。低于此值说明是线条而非填充块。 */
  minSolidity: number;
  /** 孔洞最小面积。 */
  minHoleArea: number;
}

export const DEFAULT_CONTOUR: ContourOptions = {
  minArea: 400,
  minSolidity: 0.55,
  minHoleArea: 80,
};

/**
 * 检测并追踪实心填充块。
 * 返回空数组表示图中没有需要走此路径的区域（正常线稿情形）。
 */
export function traceSolidRegions(img: BinaryImage, opts: ContourOptions): TracedContour[] {
  const cc = labelComponents(img);
  const out: TracedContour[] = [];

  for (let label = 1; label <= cc.count; label++) {
    const pixelArea = cc.areas[label]!;
    if (pixelArea < opts.minArea) continue;

    const b = label * 4;
    const bw = cc.boxes[b + 2]! - cc.boxes[b]! + 1;
    const bh = cc.boxes[b + 3]! - cc.boxes[b + 1]! + 1;
    const boxArea = bw * bh;
    if (boxArea <= 0) continue;
    // 实心度过低 → 是线条骨架，交给平面图路径处理
    if (pixelArea / boxArea < opts.minSolidity) continue;

    const outer = traceOuterContour(cc.labels, img.width, img.height, label, cc.boxes[b]!, cc.boxes[b + 1]!);
    if (outer.length < 4) continue;

    const holes = traceHoles(cc.labels, img.width, img.height, label, opts.minHoleArea);
    out.push({ outer, holes, pixelArea, label });
  }
  return out;
}

/** Moore 追踪单个连通域的外轮廓。 */
function traceOuterContour(
  labels: Int32Array,
  w: number,
  h: number,
  label: number,
  hintX: number,
  hintY: number,
): Point[] {
  // 从包围盒左上开始扫描第一个属于该标签的像素
  let sx = -1;
  let sy = -1;
  for (let y = hintY; y < h && sx < 0; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      if (labels[off + x]! === label) {
        sx = x;
        sy = y;
        break;
      }
    }
  }
  if (sx < 0) return [];

  const contour: Point[] = [{ x: sx, y: sy }];
  const at = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x]! === label;

  let cx = sx;
  let cy = sy;
  // 上一次进入方向的反向，作为下次搜索起点
  let backtrackDir = 0;
  const guard = w * h * 4;
  let steps = 0;

  while (steps++ < guard) {
    let found = false;
    // 从 backtrack 方向开始顺时针搜索下一个前景邻居
    for (let k = 1; k <= 8; k++) {
      const d = (backtrackDir + k) % 8;
      const nx = cx + MOORE_DX[d]!;
      const ny = cy + MOORE_DY[d]!;
      if (!at(nx, ny)) continue;
      // 下一次从「来路」的反方向再往回一格开始搜
      backtrackDir = (d + 5) % 8;
      cx = nx;
      cy = ny;
      found = true;
      break;
    }
    if (!found) break;
    if (cx === sx && cy === sy) break;
    contour.push({ x: cx, y: cy });
    if (contour.length > w * h) break;
  }
  return contour;
}

/** 追踪连通域内部的孔洞（背景连通域且不接触图像边界）。 */
function traceHoles(
  labels: Int32Array,
  w: number,
  h: number,
  hostLabel: number,
  minHoleArea: number,
): Point[][] {
  // 构造「宿主内部的背景」掩码
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = labels[i]! === hostLabel ? 0 : 1;

  const holeCc = labelComponents({ data: mask, width: w, height: h });
  const touchesBorder = new Uint8Array(holeCc.count + 1);
  for (let x = 0; x < w; x++) {
    const t = holeCc.labels[x]!;
    const bt = holeCc.labels[(h - 1) * w + x]!;
    if (t > 0) touchesBorder[t] = 1;
    if (bt > 0) touchesBorder[bt] = 1;
  }
  for (let y = 0; y < h; y++) {
    const l = holeCc.labels[y * w]!;
    const r = holeCc.labels[y * w + w - 1]!;
    if (l > 0) touchesBorder[l] = 1;
    if (r > 0) touchesBorder[r] = 1;
  }

  const holes: Point[][] = [];
  for (let l = 1; l <= holeCc.count; l++) {
    if (touchesBorder[l]! === 1) continue;
    if (holeCc.areas[l]! < minHoleArea) continue;
    const b = l * 4;
    const contour = traceOuterContour(holeCc.labels, w, h, l, holeCc.boxes[b]!, holeCc.boxes[b + 1]!);
    if (contour.length >= 4) holes.push(contour);
  }
  return holes;
}

/** 轮廓的几何面积（与像素计数不同，用于一致性校验）。 */
export function contourArea(contour: readonly Point[]): number {
  return area(contour);
}
