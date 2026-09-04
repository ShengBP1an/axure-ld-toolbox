/**
 * 形态学运算与连通域处理。
 * 全部基于 Uint8Array 双缓冲，避免逐像素对象分配。
 */

import type { BinaryImage } from './IPreprocessor';

/** 3×3 结构元（8 邻域）膨胀。使用双缓冲避免同轮迭代内互相影响。 */
export function dilate(img: BinaryImage, iterations = 1): BinaryImage {
  const { width: w, height: h } = img;
  // 复制输入，保证不修改源数据且两个缓冲类型一致
  let src = new Uint8Array(w * h);
  src.set(img.data);
  let dst = new Uint8Array(w * h);

  for (let it = 0; it < iterations; it++) {
    dst.fill(0);
    for (let y = 0; y < h; y++) {
      const off = y * w;
      for (let x = 0; x < w; x++) {
        if (src[off + x]! === 0) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) continue;
          const noff = ny * w;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w) continue;
            dst[noff + nx] = 1;
          }
        }
      }
    }
    const tmp = src;
    src = dst;
    dst = tmp;
  }
  return { data: src, width: w, height: h };
}

/** 3×3 结构元腐蚀。边界外视为背景，故边界像素必被腐蚀。 */
export function erode(img: BinaryImage, iterations = 1): BinaryImage {
  const { width: w, height: h } = img;
  let src = new Uint8Array(w * h);
  src.set(img.data);
  let dst = new Uint8Array(w * h);

  for (let it = 0; it < iterations; it++) {
    dst.fill(0);
    for (let y = 0; y < h; y++) {
      const off = y * w;
      for (let x = 0; x < w; x++) {
        if (src[off + x]! === 0) continue;
        let keep = true;
        for (let dy = -1; dy <= 1 && keep; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= h) {
            keep = false;
            break;
          }
          const noff = ny * w;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= w || src[noff + nx]! === 0) {
              keep = false;
              break;
            }
          }
        }
        if (keep) dst[off + x] = 1;
      }
    }
    const tmp = src;
    src = dst;
    dst = tmp;
  }
  return { data: src, width: w, height: h };
}

/** 开运算：先腐蚀后膨胀，去除孤立噪点而保留主体尺寸。 */
export function open(img: BinaryImage, iterations = 1): BinaryImage {
  if (iterations <= 0) return { data: new Uint8Array(img.data), width: img.width, height: img.height };
  return dilate(erode(img, iterations), iterations);
}

/** 闭运算：先膨胀后腐蚀，弥合细小断裂而保留主体尺寸。 */
export function close(img: BinaryImage, iterations = 1): BinaryImage {
  if (iterations <= 0) return { data: new Uint8Array(img.data), width: img.width, height: img.height };
  return erode(dilate(img, iterations), iterations);
}

export interface ConnectedComponents {
  /** 每个像素的标签，0 表示背景。 */
  labels: Int32Array;
  /** 标签数量（不含背景），标签取值 1..count。 */
  count: number;
  /** 每个标签的像素面积，索引 1..count。 */
  areas: Int32Array;
  /** 每个标签的包围盒 [minX, minY, maxX, maxY]。 */
  boxes: Int32Array;
}

/**
 * 8 连通域标记（两遍扫描 + 并查集）。
 * 用于小噪点过滤与「无有效结构」判定。
 */
export function labelComponents(img: BinaryImage): ConnectedComponents {
  const { width: w, height: h, data } = img;
  const labels = new Int32Array(w * h);
  const parent: number[] = [0];

  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root]!;
    // 路径压缩
    let cur = x;
    while (parent[cur] !== root) {
      const next = parent[cur]!;
      parent[cur] = root;
      cur = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  let next = 1;
  // 第一遍：赋临时标签
  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      if (data[off + x]! === 0) continue;
      // 检查已扫描的邻居：左上、上、右上、左
      const neighbors: number[] = [];
      if (y > 0) {
        const up = (y - 1) * w;
        if (x > 0 && labels[up + x - 1]! > 0) neighbors.push(labels[up + x - 1]!);
        if (labels[up + x]! > 0) neighbors.push(labels[up + x]!);
        if (x + 1 < w && labels[up + x + 1]! > 0) neighbors.push(labels[up + x + 1]!);
      }
      if (x > 0 && labels[off + x - 1]! > 0) neighbors.push(labels[off + x - 1]!);

      if (neighbors.length === 0) {
        labels[off + x] = next;
        parent[next] = next;
        next++;
      } else {
        let min = neighbors[0]!;
        for (const n of neighbors) if (n < min) min = n;
        labels[off + x] = min;
        for (const n of neighbors) union(min, n);
      }
    }
  }

  // 第二遍：规范化标签为连续编号
  const remap = new Int32Array(next);
  let count = 0;
  for (let i = 1; i < next; i++) {
    if (find(i) === i) {
      count++;
      remap[i] = count;
    }
  }

  const areas = new Int32Array(count + 1);
  const boxes = new Int32Array((count + 1) * 4);
  for (let i = 1; i <= count; i++) {
    boxes[i * 4] = Number.MAX_SAFE_INTEGER;
    boxes[i * 4 + 1] = Number.MAX_SAFE_INTEGER;
    boxes[i * 4 + 2] = -1;
    boxes[i * 4 + 3] = -1;
  }

  for (let y = 0; y < h; y++) {
    const off = y * w;
    for (let x = 0; x < w; x++) {
      const l = labels[off + x]!;
      if (l === 0) continue;
      const final = remap[find(l)]!;
      labels[off + x] = final;
      areas[final]++;
      const b = final * 4;
      if (x < boxes[b]!) boxes[b] = x;
      if (y < boxes[b + 1]!) boxes[b + 1] = y;
      if (x > boxes[b + 2]!) boxes[b + 2] = x;
      if (y > boxes[b + 3]!) boxes[b + 3] = y;
    }
  }

  return { labels, count, areas, boxes };
}

/** 移除面积小于 minArea 的连通域（噪点）。 */
export function removeSmallBlobs(img: BinaryImage, minArea: number): { image: BinaryImage; removed: number } {
  if (minArea <= 1) {
    return { image: { data: new Uint8Array(img.data), width: img.width, height: img.height }, removed: 0 };
  }
  const cc = labelComponents(img);
  const out = new Uint8Array(img.data.length);
  let removed = 0;
  const keep = new Uint8Array(cc.count + 1);
  for (let l = 1; l <= cc.count; l++) {
    if (cc.areas[l]! >= minArea) keep[l] = 1;
    else removed++;
  }
  for (let i = 0; i < out.length; i++) {
    const l = cc.labels[i]!;
    if (l > 0 && keep[l]! === 1) out[i] = 1;
  }
  return { image: { data: out, width: img.width, height: img.height }, removed };
}

/**
 * 填充小孔洞（背景中被前景完全包围的小区域）。
 * 通过对背景做连通域标记，未接触边界且面积小的背景块即为孔洞。
 */
export function fillSmallHoles(img: BinaryImage, maxHoleArea: number): BinaryImage {
  if (maxHoleArea <= 0) return { data: new Uint8Array(img.data), width: img.width, height: img.height };
  const inverted: BinaryImage = {
    data: img.data.map((v) => (v === 0 ? 1 : 0)) as Uint8Array,
    width: img.width,
    height: img.height,
  };
  const cc = labelComponents(inverted);
  const touchesBorder = new Uint8Array(cc.count + 1);
  const { width: w, height: h } = img;
  for (let x = 0; x < w; x++) {
    const t = cc.labels[x]!;
    const b = cc.labels[(h - 1) * w + x]!;
    if (t > 0) touchesBorder[t] = 1;
    if (b > 0) touchesBorder[b] = 1;
  }
  for (let y = 0; y < h; y++) {
    const l = cc.labels[y * w]!;
    const r = cc.labels[y * w + w - 1]!;
    if (l > 0) touchesBorder[l] = 1;
    if (r > 0) touchesBorder[r] = 1;
  }

  const out = new Uint8Array(img.data);
  for (let i = 0; i < out.length; i++) {
    const l = cc.labels[i]!;
    if (l > 0 && touchesBorder[l]! === 0 && cc.areas[l]! <= maxHoleArea) out[i] = 1;
  }
  return { data: out, width: w, height: h };
}

/** 估算平均笔画宽度：前景面积 / 骨架长度的近似（用腐蚀次数逼近）。 */
export function estimateStrokeWidth(img: BinaryImage): number {
  let current = img;
  let area = 0;
  for (let i = 0; i < current.data.length; i++) if (current.data[i]! !== 0) area++;
  if (area === 0) return 1;

  // 连续腐蚀直到前景消失，迭代次数 × 2 近似为笔画宽度
  let iterations = 0;
  let remaining = area;
  while (remaining > 0 && iterations < 24) {
    current = erode(current, 1);
    remaining = 0;
    for (let i = 0; i < current.data.length; i++) if (current.data[i]! !== 0) remaining++;
    iterations++;
    if (remaining < area * 0.01) break;
  }
  return Math.max(1, iterations * 2 - 1);
}
