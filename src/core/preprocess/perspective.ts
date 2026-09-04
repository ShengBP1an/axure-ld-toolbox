/**
 * 透视校正：四点投影变换矩阵求解 + 双线性重采样。
 *
 * 用途：修正拍照产生的梯形畸变。
 * 用户在原图上指定纸张 / 地图的四个角（左上、右上、右下、左下），
 * 工具解出 3×3 homography 并把该四边形映射为矩形。
 */

import type { Point } from '../../types/vector';
import { PipelineError } from '../../types/errors';
import { cross, sub } from '../geometry/vec';

/** 行主序 3×3 矩阵。 */
export type Matrix3 = [number, number, number, number, number, number, number, number, number];

export function applyMatrix(m: Matrix3, p: Point): Point {
  const x = m[0] * p.x + m[1] * p.y + m[2];
  const y = m[3] * p.x + m[4] * p.y + m[5];
  const w = m[6] * p.x + m[7] * p.y + m[8];
  if (Math.abs(w) < 1e-12) return { x: 0, y: 0 };
  return { x: x / w, y: y / w };
}

/**
 * 求解把 src 四点映射到 dst 四点的 homography。
 * 用 8×8 线性方程组（高斯消元），h22 固定为 1。
 */
export function solveHomography(src: readonly Point[], dst: readonly Point[]): Matrix3 {
  if (src.length !== 4 || dst.length !== 4) {
    throw new PipelineError('PERSPECTIVE_INVALID', { pointCount: src.length });
  }

  // 构建 A·h = b，h = [h00..h21]
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const s = src[i]!;
    const d = dst[i]!;
    A.push([s.x, s.y, 1, 0, 0, 0, -d.x * s.x, -d.x * s.y]);
    b.push(d.x);
    A.push([0, 0, 0, s.x, s.y, 1, -d.y * s.x, -d.y * s.y]);
    b.push(d.y);
  }

  const h = gaussianSolve(A, b);
  if (h === null) throw new PipelineError('PERSPECTIVE_INVALID', { reason: 'singular' });
  return [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
}

/** 高斯-约当消元求解线性方程组，奇异时返回 null。 */
function gaussianSolve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m: number[][] = A.map((row, i) => [...row, b[i]!]);

  for (let col = 0; col < n; col++) {
    // 选主元
    let pivot = col;
    let maxAbs = Math.abs(m[col]![col]!);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(m[r]![col]!);
      if (v > maxAbs) {
        maxAbs = v;
        pivot = r;
      }
    }
    if (maxAbs < 1e-12) return null;
    if (pivot !== col) {
      const tmp = m[col]!;
      m[col] = m[pivot]!;
      m[pivot] = tmp;
    }

    const pv = m[col]![col]!;
    for (let c = col; c <= n; c++) m[col]![c] = m[col]![c]! / pv;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]!;
      if (Math.abs(f) < 1e-15) continue;
      for (let c = col; c <= n; c++) m[r]![c] = m[r]![c]! - f * m[col]![c]!;
    }
  }
  return m.map((row) => row[n]!);
}

/** 检查四点是否构成有效凸四边形（顺序为左上、右上、右下、左下）。 */
export function isValidQuad(quad: readonly Point[]): boolean {
  if (quad.length !== 4) return false;
  for (const p of quad) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  }
  // 所有相邻边的叉积同号 → 凸
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i]!;
    const b = quad[(i + 1) % 4]!;
    const c = quad[(i + 2) % 4]!;
    const z = cross(sub(b, a), sub(c, b));
    if (Math.abs(z) < 1e-9) return false;
    const s = z > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export interface WarpResult {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * 对 RGBA 图像做透视校正。
 *
 * @param quad 源图上的四个角点（像素坐标，顺序：左上、右上、右下、左下）
 * @param outWidth 输出宽度；为 0 时按四边形的平均边长推导
 */
export function warpPerspective(
  src: { data: Uint8ClampedArray; width: number; height: number },
  quad: readonly Point[],
  outWidth = 0,
  outHeight = 0,
): WarpResult {
  if (!isValidQuad(quad)) throw new PipelineError('PERSPECTIVE_INVALID');

  const [tl, tr, br, bl] = quad as [Point, Point, Point, Point];
  const topLen = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const bottomLen = Math.hypot(br.x - bl.x, br.y - bl.y);
  const leftLen = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const rightLen = Math.hypot(br.x - tr.x, br.y - tr.y);

  const w = Math.max(8, Math.round(outWidth > 0 ? outWidth : (topLen + bottomLen) / 2));
  const h = Math.max(8, Math.round(outHeight > 0 ? outHeight : (leftLen + rightLen) / 2));

  // 求「输出 → 源」的逆变换，便于反向映射填充
  const dstQuad: Point[] = [
    { x: 0, y: 0 },
    { x: w - 1, y: 0 },
    { x: w - 1, y: h - 1 },
    { x: 0, y: h - 1 },
  ];
  const inv = solveHomography(dstQuad, [tl, tr, br, bl]);

  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = applyMatrix(inv, { x, y });
      const o = (y * w + x) * 4;
      sampleBilinear(src, s.x, s.y, out, o);
    }
  }
  return { data: out, width: w, height: h };
}

function sampleBilinear(
  src: { data: Uint8ClampedArray; width: number; height: number },
  fx: number,
  fy: number,
  out: Uint8ClampedArray,
  outOffset: number,
): void {
  const { data, width: w, height: h } = src;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) {
    // 越界填白纸色，避免黑边被识别为墙线
    out[outOffset] = 255;
    out[outOffset + 1] = 255;
    out[outOffset + 2] = 255;
    out[outOffset + 3] = 255;
    return;
  }
  const tx = fx - x0;
  const ty = fy - y0;
  const i00 = (y0 * w + x0) * 4;
  const i10 = i00 + 4;
  const i01 = ((y0 + 1) * w + x0) * 4;
  const i11 = i01 + 4;
  for (let c = 0; c < 4; c++) {
    const top = data[i00 + c]! + (data[i10 + c]! - data[i00 + c]!) * tx;
    const bot = data[i01 + c]! + (data[i11 + c]! - data[i01 + c]!) * tx;
    out[outOffset + c] = top + (bot - top) * ty;
  }
}

/** 把归一化坐标（0..1）的四点换算为像素坐标。 */
export function denormalizeQuad(
  quad: readonly Point[],
  width: number,
  height: number,
): Point[] {
  return quad.map((p) => ({ x: p.x * width, y: p.y * height }));
}
