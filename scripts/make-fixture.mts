/**
 * 生成用于端到端验证的合成草图 PNG。
 * 复用 tests/fixtures/synth.ts 的场景，内置最小 PNG 编码器（仅依赖 Node zlib）。
 *
 * 用法：node --experimental-strip-types scripts/make-fixture.mts <scene> <out.png>
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import {
  sceneRoomGrid,
  sceneBrokenRoom,
  sceneIrregularRegion,
  sceneNarrowPassage,
  type Scene,
} from '../tests/fixtures/synth.ts';
import { SynthCanvas } from '../tests/fixtures/synth.ts';

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const len = data.length;
  const out = new Uint8Array(12 + len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + len);
  dv.setUint32(8 + len, crc32(crcInput));
  return out;
}

/** 把 RGBA 像素编码为 PNG（非隔行、8bit truecolor+alpha）。 */
function encodePng(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (width * 4 + 1);
    raw[o] = 0; // filter: none
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), o + 1);
  }

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));

  const parts = [
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 综合场景：房间网格 + 断线房间 + 不规则区域 + 细通道，覆盖多项验收标准。 */
function sceneCombined(): Scene {
  const c = new SynthCanvas({ width: 1000, height: 700, strokeWidth: 4 });

  // 地图外边界
  c.rect(30, 30, 940, 640, 5);

  // 左上：2×2 房间网格（共享十字墙）→ 应输出 4 个独立矩形
  c.rect(70, 70, 320, 240);
  c.line({ x: 230, y: 70 }, { x: 230, y: 310 });
  c.line({ x: 70, y: 190 }, { x: 390, y: 190 });

  // 右上：四角断开的房间（缺口 9px）→ 应被桥接后闭合
  const gap = 9;
  const bx = 470;
  const by = 70;
  const bw = 300;
  const bh = 200;
  c.line({ x: bx + gap, y: by }, { x: bx + bw - gap, y: by });
  c.line({ x: bx + bw, y: by + gap }, { x: bx + bw, y: by + bh - gap });
  c.line({ x: bx + bw - gap, y: by + bh }, { x: bx + gap, y: by + bh });
  c.line({ x: bx, y: by + bh - gap }, { x: bx, y: by + gap });

  // 右上角：轻微倾斜（3°）的小房间 → 应吸附为轴对齐矩形
  const cx = 860;
  const cy = 400;
  const rad = (3 * Math.PI) / 180;
  const tilted = [
    { x: -70, y: -55 },
    { x: 70, y: -55 },
    { x: 70, y: 55 },
    { x: -70, y: 55 },
  ].map((p) => ({
    x: cx + p.x * Math.cos(rad) - p.y * Math.sin(rad),
    y: cy + p.x * Math.sin(rad) + p.y * Math.cos(rad),
  }));
  c.polyline(tilted, true);

  // 左下：不规则区域 → 应输出可编辑封闭路径
  c.polyline(
    [
      { x: 80, y: 390 },
      { x: 190, y: 360 },
      { x: 300, y: 410 },
      { x: 340, y: 500 },
      { x: 260, y: 600 },
      { x: 140, y: 590 },
      { x: 70, y: 500 },
    ],
    true,
  );

  // 中下：细通道连接两个小房间 → 通道不得消失
  c.rect(420, 430, 120, 150);
  c.rect(640, 430, 120, 150);
  const my = 505;
  c.line({ x: 540, y: my - 9 }, { x: 640, y: my - 9 });
  c.line({ x: 540, y: my + 9 }, { x: 640, y: my + 9 });

  // 开放分隔墙（L 形）→ 应输出 polyline
  c.polyline(
    [
      { x: 470, y: 320 },
      { x: 470, y: 370 },
      { x: 700, y: 370 },
    ],
    false,
  );

  // 轻微噪声与阴影，模拟真实拍照
  c.addShadow(0.18).addNoise(7, 11);

  return {
    canvas: c,
    meta: {
      name: 'combined',
      expectedRegions: 11,
      expectedRects: 7,
      description: '综合场景：房间网格 + 断线 + 倾斜 + 不规则 + 细通道 + 开放墙线',
    },
  };
}

const SCENES: Record<string, () => Scene> = {
  combined: sceneCombined,
  grid: () => sceneRoomGrid(4),
  broken: () => sceneBrokenRoom(9, 4),
  irregular: () => sceneIrregularRegion(4),
  passage: () => sceneNarrowPassage(14, 4),
};

const name = process.argv[2] ?? 'combined';
const out = process.argv[3] ?? `fixtures/${name}.png`;
const factory = SCENES[name];
if (factory === undefined) {
  console.error(`未知场景：${name}。可用：${Object.keys(SCENES).join(', ')}`);
  process.exit(1);
}

const scene = factory();
const rgba = scene.canvas.toRgba();
const png = encodePng(rgba.data, rgba.width, rgba.height);
writeFileSync(out, png);
console.log(`已生成 ${out} (${rgba.width}×${rgba.height}, ${(png.length / 1024).toFixed(1)} KB)`);
console.log(`场景：${scene.meta.description}`);
