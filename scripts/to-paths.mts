/**
 * 把 SVG 中的基本图元统一改写为 <path>，用于排查 Axure
 * 「Convert SVG to Shapes」对非 path 元素支持不佳的可能性。
 *
 * 仅做元素形态转换，坐标与样式原样保留，不改变任何几何。
 *
 * 用法：node --experimental-strip-types scripts/to-paths.mts <输入> <输出>
 */

import fs from 'node:fs';

/** 提取标签上的属性表。 */
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  // 属性名首字符必须是字母，但后续可含数字（x1/y2）、连字符（stroke-width）、冒号（xml:space）。
  // 早期写成 [a-zA-Z-]+ 会静默漏掉 x1/y1/x2/y2，导致 <line> 坐标全部丢失。
  const re = /([a-zA-Z][\w:.-]*)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag)) !== null) out[m[1]!] = m[2]!;
  return out;
}

/** 除几何属性外的样式/标识属性原样透传。 */
function passthrough(a: Record<string, string>, drop: readonly string[]): string {
  return Object.entries(a)
    .filter(([k]) => !drop.includes(k))
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ');
}

function num(a: Record<string, string>, k: string): number {
  const v = Number.parseFloat(a[k] ?? '');
  if (!Number.isFinite(v)) {
    // 静默当 0 会产出 "M0 0 L0 0" 这类退化图形，且几乎不会被察觉。
    throw new Error(`缺少必需的几何属性 ${k}，无法安全转换`);
  }
  return v;
}

/** "x,y x,y" 或 "x y x y" → path 的 d 串。 */
function pointsToD(points: string, close: boolean): string {
  const nums = points.trim().split(/[\s,]+/).map(Number);
  const parts: string[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    parts.push(`${i === 0 ? 'M' : 'L'}${nums[i]} ${nums[i + 1]}`);
  }
  return parts.join(' ') + (close ? ' Z' : '');
}

function convert(svg: string): { out: string; counts: Record<string, number> } {
  const counts: Record<string, number> = { rect: 0, polygon: 0, polyline: 0, line: 0, path: 0 };

  let out = svg;

  // rect：保留圆角信息缺失的情况下按直角矩形展开
  out = out.replace(/<rect\b([^>]*?)\/>/g, (_full, body: string) => {
    const a = attrs(body);
    const x = num(a, 'x');
    const y = num(a, 'y');
    const w = num(a, 'width');
    const h = num(a, 'height');
    counts.rect! += 1;
    const d = `M${x} ${y} L${x + w} ${y} L${x + w} ${y + h} L${x} ${y + h} Z`;
    return `<path d="${d}" ${passthrough(a, ['x', 'y', 'width', 'height'])}/>`;
  });

  out = out.replace(/<polygon\b([^>]*?)\/>/g, (_full, body: string) => {
    const a = attrs(body);
    counts.polygon! += 1;
    return `<path d="${pointsToD(a.points ?? '', true)}" ${passthrough(a, ['points'])}/>`;
  });

  out = out.replace(/<polyline\b([^>]*?)\/>/g, (_full, body: string) => {
    const a = attrs(body);
    counts.polyline! += 1;
    return `<path d="${pointsToD(a.points ?? '', false)}" ${passthrough(a, ['points'])}/>`;
  });

  out = out.replace(/<line\b([^>]*?)\/>/g, (_full, body: string) => {
    const a = attrs(body);
    counts.line! += 1;
    const d = `M${num(a, 'x1')} ${num(a, 'y1')} L${num(a, 'x2')} ${num(a, 'y2')}`;
    return `<path d="${d}" ${passthrough(a, ['x1', 'y1', 'x2', 'y2'])}/>`;
  });

  counts.path = (out.match(/<path\b/g) ?? []).length;
  return { out, counts };
}

const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined) {
  console.error('用法: to-paths.mts <输入.svg> <输出.svg>');
  process.exit(1);
}

const src = fs.readFileSync(input, 'utf8');
const { out, counts } = convert(src);

// 转换后必须与转换前的图元总数一致，否则说明有元素被漏掉
const before =
  (src.match(/<rect\b/g) ?? []).length +
  (src.match(/<polygon\b/g) ?? []).length +
  (src.match(/<polyline\b/g) ?? []).length +
  (src.match(/<line\b/g) ?? []).length +
  (src.match(/<path\b/g) ?? []).length;
if (counts.path !== before) {
  console.error(`转换前后图元数不一致：${before} → ${counts.path}，已中止`);
  process.exit(1);
}
// 退化路径几乎一定是解析失误，而非真实数据
const degenerate = (out.match(/d="M0 0 L0 0"/g) ?? []).length;
if (degenerate > 0) {
  console.error(`检测到 ${degenerate} 条退化路径，已中止`);
  process.exit(1);
}

fs.writeFileSync(output, out, 'utf8');

console.log(`已写入 ${output}`);
console.log(
  `转换: rect ${counts.rect} / polygon ${counts.polygon} / polyline ${counts.polyline} / line ${counts.line}`,
);
console.log(`结果共 ${counts.path} 个 <path>`);
