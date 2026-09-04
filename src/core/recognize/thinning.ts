/**
 * Zhang–Suen 细化（骨架化）。
 *
 * 为什么需要：手绘墙线有宽度（2~8 像素），若直接追踪轮廓会得到「双线」，
 * 每条墙都变成一个细长闭环。先细化为单像素骨架，才能把墙抽象为「线」。
 *
 * 实现要点：
 *   - 双缓冲 Uint8Array，避免同一次迭代内互相影响；
 *   - 变更标记（changed）提前收敛，典型草图 6~14 轮即稳定；
 *   - 只扫描前景像素的包围盒，跳过大片空白。
 */

import type { BinaryImage } from '../preprocess/IPreprocessor';

const MAX_ITERATIONS = 64;

export interface ThinningResult {
  skeleton: BinaryImage;
  iterations: number;
  /** 骨架像素数。 */
  pixelCount: number;
}

export function thin(img: BinaryImage): ThinningResult {
  const { width: w, height: h } = img;
  let data = new Uint8Array(img.data);
  const marks: number[] = [];

  // 计算前景包围盒，缩小扫描范围
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      if (data[off + x]! === 0) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) {
    return { skeleton: { data, width: w, height: h }, iterations: 0, pixelCount: 0 };
  }
  const x0 = Math.max(1, minX);
  const y0 = Math.max(1, minY);
  const x1 = Math.min(w - 2, maxX);
  const y1 = Math.min(h - 2, maxY);

  let iterations = 0;
  let changed = true;

  while (changed && iterations < MAX_ITERATIONS) {
    changed = false;
    // 两个子迭代（step 0 / 1）方向不同，保证骨架居中且连通
    for (let step = 0; step < 2; step++) {
      marks.length = 0;
      for (let y = y0; y <= y1; y++) {
        const off = y * w;
        const up = off - w;
        const down = off + w;
        for (let x = x0; x <= x1; x++) {
          if (data[off + x]! === 0) continue;

          // 8 邻域，顺时针从正上方开始：p2..p9
          const p2 = data[up + x]!;
          const p3 = data[up + x + 1]!;
          const p4 = data[off + x + 1]!;
          const p5 = data[down + x + 1]!;
          const p6 = data[down + x]!;
          const p7 = data[down + x - 1]!;
          const p8 = data[off + x - 1]!;
          const p9 = data[up + x - 1]!;

          // 条件 1：前景邻居数在 2..6 之间
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;

          // 条件 2：0→1 转换数恰为 1（保证不破坏连通性）
          let a = 0;
          if (p2 === 0 && p3 === 1) a++;
          if (p3 === 0 && p4 === 1) a++;
          if (p4 === 0 && p5 === 1) a++;
          if (p5 === 0 && p6 === 1) a++;
          if (p6 === 0 && p7 === 1) a++;
          if (p7 === 0 && p8 === 1) a++;
          if (p8 === 0 && p9 === 1) a++;
          if (p9 === 0 && p2 === 1) a++;
          if (a !== 1) continue;

          // 条件 3 / 4：两个子迭代使用不同的方向约束
          if (step === 0) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }

          marks.push(off + x);
        }
      }

      if (marks.length > 0) {
        changed = true;
        for (const idx of marks) data[idx] = 0;
      }
    }
    iterations++;
  }

  let count = 0;
  for (let i = 0; i < data.length; i++) if (data[i]! !== 0) count++;

  return { skeleton: { data, width: w, height: h }, iterations, pixelCount: count };
}

/**
 * 骨架后处理：移除「冗余」像素，使骨架成为严格的 1 像素路径
 * （每个像素最多 2 个 8 邻居）。
 *
 * 为什么必须做：Zhang–Suen 只保证骨架宽度为 1、连通性不变，
 * 但在缓斜线（例如坡度 0.2 的墙）上会留下阶梯梯形结构，
 * 其中不少像素有 3~4 个邻居。这类像素会让「沿路径行走」的
 * 分支追踪出现歧义：从来路出发有两个候选邻居，走错就会原地打转，
 * 结果是一条斜墙被拆成几十段碎片，封闭区域无法闭合。
 *
 * 删除判据（保证不破坏连通性）：
 *   1. 该像素有 ≥3 个前景邻居（存在冗余）；
 *   2. 其前景邻居集合在「真实平面 8 邻接」下自身连通。
 *      满足 2 时删除该像素，其邻居之间仍可互相到达。
 *
 * 注意：这里用真实平面邻接判断邻居间的连通，而不是经典 Zhang–Suen
 * 的「8 邻域环上相邻」近似 —— 后者会把对角相邻的 E 与 S 误判为
 * 两个分量（它们中间的 SE 为背景），从而拒绝删除本可安全删除的像素。
 */
export function pruneRedundant(img: BinaryImage): BinaryImage {
  const { width: w, height: h } = img;
  const data = new Uint8Array(img.data);
  const work: BinaryImage = { data, width: w, height: h };

  const nx: number[] = [];
  const ny: number[] = [];

  let changed = true;
  let pass = 0;
  while (changed && pass < 8) {
    changed = false;
    pass++;
    for (let y = 0; y < h; y++) {
      const off = y * w;
      for (let x = 0; x < w; x++) {
        if (data[off + x]! === 0) continue;

        // 收集前景邻居
        nx.length = 0;
        ny.length = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          const yoff = yy * w;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            if (data[yoff + xx]! === 0) continue;
            nx.push(xx);
            ny.push(yy);
          }
        }

        const k = nx.length;
        if (k < 3) continue; // 无冗余

        if (neighborsConnected(nx, ny, k)) {
          data[off + x] = 0;
          changed = true;
        }
      }
    }
  }
  return work;
}

/** 判断邻居点集在 8 邻接下是否构成单一连通分量（点数很小，直接 BFS）。 */
function neighborsConnected(xs: readonly number[], ys: readonly number[], k: number): boolean {
  const seen = new Uint8Array(k);
  const stack: number[] = [0];
  seen[0] = 1;
  let visited = 1;

  while (stack.length > 0) {
    const i = stack.pop()!;
    for (let j = 0; j < k; j++) {
      if (seen[j]! === 1) continue;
      if (Math.abs(xs[i]! - xs[j]!) <= 1 && Math.abs(ys[i]! - ys[j]!) <= 1) {
        seen[j] = 1;
        visited++;
        stack.push(j);
      }
    }
  }
  return visited === k;
}

/**
 * 兼容旧名保留：语义等同 pruneRedundant。
 * @deprecated 使用 pruneRedundant
 */
export function pruneStaircase(img: BinaryImage): BinaryImage {
  return pruneRedundant(img);
}

/**
 * 计算像素的「交叉数」（crossing number）。
 * 用于判定端点（=1）、通过点（=2）、交点（≥3）。
 */
export function crossingNumber(img: BinaryImage, x: number, y: number): number {
  const { width: w, height: h, data } = img;
  if (x <= 0 || y <= 0 || x >= w - 1 || y >= h - 1) {
    // 边界像素：只统计有效邻居
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (data[ny * w + nx]! !== 0) n++;
      }
    }
    return n;
  }
  const off = y * w;
  const up = off - w;
  const down = off + w;
  const ring = [
    data[up + x]!,
    data[up + x + 1]!,
    data[off + x + 1]!,
    data[down + x + 1]!,
    data[down + x]!,
    data[down + x - 1]!,
    data[off + x - 1]!,
    data[up + x - 1]!,
  ];
  let transitions = 0;
  for (let i = 0; i < 8; i++) {
    if (ring[i]! === 1 && ring[(i + 1) % 8]! === 0) transitions++;
  }
  return transitions;
}

/** 8 邻域前景计数。 */
export function neighborCount(img: BinaryImage, x: number, y: number): number {
  const { width: w, height: h, data } = img;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= h) continue;
    const off = ny * w;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= w) continue;
      if (data[off + nx]! !== 0) n++;
    }
  }
  return n;
}
