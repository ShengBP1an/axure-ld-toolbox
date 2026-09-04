/**
 * 合成样本生成器。
 *
 * 为什么需要：真实手绘草图无法进版本库，且无法精确控制变量。
 * 合成样本可以精确构造「方正房间 / 共享墙 / 断线 / 倾斜线 / 重复线 /
 * 不规则区域 / 带孔洞区域 / 细通道」等场景，
 * 从而把最低验收标准转化为可自动执行的断言。
 *
 * 生成的是 RGBA 图像（白底黑线），走与真实图片完全相同的管线。
 */

import type { RgbaImage } from '../../src/core/preprocess/IPreprocessor';
import type { Point } from '../../src/types/vector';

export interface CanvasSpec {
  width: number;
  height: number;
  /** 线宽（像素）。 */
  strokeWidth: number;
}

export class SynthCanvas {
  readonly width: number;
  readonly height: number;
  readonly strokeWidth: number;
  /** 灰度缓冲，255 = 白纸。 */
  private readonly buf: Uint8Array;

  constructor(spec: CanvasSpec) {
    this.width = spec.width;
    this.height = spec.height;
    this.strokeWidth = Math.max(1, spec.strokeWidth);
    this.buf = new Uint8Array(spec.width * spec.height).fill(255);
  }

  /** 画一条粗线段（Bresenham + 圆盘笔刷）。 */
  line(a: Point, b: Point, width = this.strokeWidth, value = 20): this {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      this.dot(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, width, value);
    }
    return this;
  }

  /** 画折线。 */
  polyline(points: readonly Point[], closed = false, width = this.strokeWidth, value = 20): this {
    const n = points.length;
    const limit = closed ? n : n - 1;
    for (let i = 0; i < limit; i++) {
      this.line(points[i]!, points[(i + 1) % n]!, width, value);
    }
    return this;
  }

  /** 画矩形边框。 */
  rect(x: number, y: number, w: number, h: number, width = this.strokeWidth, value = 20): this {
    return this.polyline(
      [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ],
      true,
      width,
      value,
    );
  }

  /** 填充矩形（测试实心块降级路径）。 */
  fillRect(x: number, y: number, w: number, h: number, value = 20): this {
    for (let yy = Math.max(0, Math.round(y)); yy < Math.min(this.height, Math.round(y + h)); yy++) {
      const off = yy * this.width;
      for (let xx = Math.max(0, Math.round(x)); xx < Math.min(this.width, Math.round(x + w)); xx++) {
        this.buf[off + xx] = value;
      }
    }
    return this;
  }

  /** 圆盘笔刷落点。 */
  private dot(cx: number, cy: number, width: number, value: number): void {
    const r = width / 2;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(this.width - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(this.height - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      const off = y * this.width;
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2 + 0.25) {
          const cur = this.buf[off + x]!;
          if (value < cur) this.buf[off + x] = value;
        }
      }
    }
  }

  /** 叠加均匀噪声，模拟纸张纹理。 */
  addNoise(amplitude: number, seed = 42): this {
    let s = seed;
    const rnd = (): number => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
    for (let i = 0; i < this.buf.length; i++) {
      const v = this.buf[i]! + (rnd() - 0.5) * 2 * amplitude;
      this.buf[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
    return this;
  }

  /** 叠加线性阴影渐变，模拟拍照光照不均。 */
  addShadow(strength = 0.35): this {
    for (let y = 0; y < this.height; y++) {
      const off = y * this.width;
      for (let x = 0; x < this.width; x++) {
        const k = 1 - strength * ((x / this.width) * 0.6 + (y / this.height) * 0.4);
        this.buf[off + x] = Math.round(this.buf[off + x]! * k);
      }
    }
    return this;
  }

  toRgba(): RgbaImage {
    const data = new Uint8ClampedArray(this.width * this.height * 4);
    for (let i = 0; i < this.buf.length; i++) {
      const v = this.buf[i]!;
      const o = i * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
    return { data, width: this.width, height: this.height };
  }

  /** 直接输出二值图（1 = 前景），用于跳过预处理的算法单测。 */
  toBinary(threshold = 128): { data: Uint8Array; width: number; height: number } {
    const data = new Uint8Array(this.buf.length);
    for (let i = 0; i < this.buf.length; i++) data[i] = this.buf[i]! < threshold ? 1 : 0;
    return { data, width: this.width, height: this.height };
  }
}

/* ------------------------------------------------------------------ */
/* 预设场景                                                            */
/* ------------------------------------------------------------------ */

export interface SceneMeta {
  name: string;
  /** 期望的独立封闭区域数量。 */
  expectedRegions: number;
  /** 期望能输出为 rect 的区域数量下限。 */
  expectedRects: number;
  description: string;
}

export interface Scene {
  canvas: SynthCanvas;
  meta: SceneMeta;
}

/** 场景 1：单个方正房间。期望输出 1 个 rect。 */
export function sceneSingleRoom(strokeWidth = 3): Scene {
  const c = new SynthCanvas({ width: 400, height: 300, strokeWidth });
  c.rect(60, 50, 260, 190);
  return {
    canvas: c,
    meta: {
      name: 'singleRoom',
      expectedRegions: 1,
      expectedRects: 1,
      description: '单个方正房间，验证 rect 输出（验收标准 1）',
    },
  };
}

/**
 * 场景 2：两个房间共享一面墙。
 * 期望输出 2 个独立 rect —— 这是平面图半边遍历相较轮廓追踪的关键优势。
 */
export function sceneSharedWall(strokeWidth = 3): Scene {
  const c = new SynthCanvas({ width: 460, height: 300, strokeWidth });
  // 外框
  c.rect(50, 50, 360, 200);
  // 中间竖墙（共享）
  c.line({ x: 230, y: 50 }, { x: 230, y: 250 });
  return {
    canvas: c,
    meta: {
      name: 'sharedWall',
      expectedRegions: 2,
      expectedRects: 2,
      description: '两房间共享一面墙，验证独立矩形输出（验收标准 1/6）',
    },
  };
}

/** 场景 3：2×2 房间网格，共享十字墙。期望 4 个 rect。 */
export function sceneRoomGrid(strokeWidth = 3): Scene {
  const c = new SynthCanvas({ width: 480, height: 400, strokeWidth });
  c.rect(50, 50, 380, 300);
  c.line({ x: 240, y: 50 }, { x: 240, y: 350 });
  c.line({ x: 50, y: 200 }, { x: 430, y: 200 });
  return {
    canvas: c,
    meta: {
      name: 'roomGrid',
      expectedRegions: 4,
      expectedRects: 4,
      description: '2×2 房间网格，验证多房间共享墙',
    },
  };
}

/** 场景 4：断线的房间（四角均差 8 像素）。期望桥接后仍闭合为 1 个区域。 */
export function sceneBrokenRoom(gap = 8, strokeWidth = 3): Scene {
  const c = new SynthCanvas({ width: 400, height: 300, strokeWidth });
  const x0 = 60;
  const y0 = 50;
  const x1 = 320;
  const y1 = 240;
  // 四条边各自缩短，使四角留出缺口
  c.line({ x: x0 + gap, y: y0 }, { x: x1 - gap, y: y0 });
  c.line({ x: x1, y: y0 + gap }, { x: x1, y: y1 - gap });
  c.line({ x: x1 - gap, y: y1 }, { x: x0 + gap, y: y1 });
  c.line({ x: x0, y: y1 - gap }, { x: x0, y: y0 + gap });
  return {
    canvas: c,
    meta: {
      name: 'brokenRoom',
      expectedRegions: 1,
      expectedRects: 1,
      description: `四角断开 ${gap}px，验证断线连接（验收标准 4）`,
    },
  };
}

/** 场景 5：轻微倾斜的房间（3°）。期望吸附为轴对齐 rect。 */
export function sceneTiltedRoom(degrees = 3, strokeWidth = 3): Scene {
  const c = new SynthCanvas({ width: 460, height: 360, strokeWidth });
  const cx = 230;
  const cy = 180;
  const rad = (degrees * Math.PI) / 180;
  const corners: Point[] = [
    { x: -130, y: -95 },
    { x: 130, y: -95 },
    { x: 130, y: 95 },
    { x: -130, y: 95 },
  ].map((p) => ({
    x: cx + p.x * Math.cos(rad) - p.y * Math.sin(rad),
    y: cy + p.x * Math.sin(rad) + p.y * Math.cos(rad),
  }));
  c.polyline(corners, true);
  return {
    canvas: c,
    meta: {
      name: 'tiltedRoom',
      expectedRegions: 1,
      expectedRects: 1,
      description: `${degrees}° 倾斜房间，验证角度吸附（验收标准 4）`,
    },
  };
}

/** 场景 6：不规则封闭区域（锯齿形）。期望输出可编辑的 closedPath / polygon。 */
export function sceneIrregularRegion(strokeWidth = 3): Scene {
  const c = new SynthCanvas({ width: 440, height: 360, strokeWidth });
  const pts: Point[] = [
    { x: 70, y: 70 },
    { x: 160, y: 50 },
    { x: 250, y: 95 },
    { x: 330, y: 60 },
    { x: 380, y: 150 },
    { x: 320, y: 230 },
    { x: 350, y: 300 },
    { x: 230, y: 310 },
    { x: 150, y: 265 },
    { x: 60, y: 290 },
    { x: 95, y: 180 },
  ];
  c.polyline(pts, true);
  return {
    canvas: c,
    meta: {
      name: 'irregularRegion',
      expectedRegions: 1,
      expectedRects: 0,
      description: '不规则多边形区域，验证节点可编辑封闭路径（验收标准 2）',
    },
  };
}

/** 场景 7：带孔洞的房间（房间内有一个独立小房间）。 */
export function sceneRegionWithHole(strokeWidth = 3): Scene {
  const c = new SynthCanvas({ width: 460, height: 380, strokeWidth });
  c.rect(50, 50, 360, 280);
  c.rect(170, 150, 120, 90);
  return {
    canvas: c,
    meta: {
      name: 'regionWithHole',
      expectedRegions: 2,
      expectedRects: 2,
      description: '嵌套区域，验证孔洞 / 内外边界区分',
    },
  };
}

/** 场景 8：细通道（两个房间由一条 10px 宽走廊连接）。期望通道不消失。 */
export function sceneNarrowPassage(passageWidth = 12, strokeWidth = 3): Scene {
  const c = new SynthCanvas({ width: 520, height: 300, strokeWidth });
  const cy = 150;
  const half = passageWidth / 2;
  // 左房间
  c.rect(40, 70, 150, 160);
  // 右房间
  c.rect(330, 70, 150, 160);
  // 走廊上下两条墙
  c.line({ x: 190, y: cy - half }, { x: 330, y: cy - half });
  c.line({ x: 190, y: cy + half }, { x: 330, y: cy + half });
  return {
    canvas: c,
    meta: {
      name: 'narrowPassage',
      expectedRegions: 3,
      expectedRects: 2,
      description: `${passageWidth}px 细通道，验证简化不使通道消失（验收标准 4）`,
    },
  };
}

/** 场景 9：重复描线的房间（每条边画两次，偏移 2px）。期望去重为 1 个 rect。 */
export function sceneDuplicatedLines(strokeWidth = 3): Scene {
  const c = new SynthCanvas({ width: 400, height: 300, strokeWidth });
  c.rect(60, 50, 260, 190);
  c.rect(62, 52, 260, 190);
  return {
    canvas: c,
    meta: {
      name: 'duplicatedLines',
      expectedRegions: 1,
      expectedRects: 1,
      description: '重复描线，验证重复线合并（验收标准 4）',
    },
  };
}

/** 场景 10：低质量图（噪声 + 阴影 + 细淡线）。期望不静默输出错误结果。 */
export function sceneLowQuality(strokeWidth = 2): Scene {
  const c = new SynthCanvas({ width: 420, height: 320, strokeWidth });
  c.rect(60, 50, 280, 200, strokeWidth, 120);
  c.addShadow(0.4).addNoise(26, 7);
  return {
    canvas: c,
    meta: {
      name: 'lowQuality',
      expectedRegions: 1,
      expectedRects: 0,
      description: '低对比度 + 噪声 + 阴影，验证置信度与问题提示（验收标准 8）',
    },
  };
}

/** 场景 11：空白图。期望抛出 NO_STRUCTURE_FOUND。 */
export function sceneBlank(): Scene {
  const c = new SynthCanvas({ width: 300, height: 200, strokeWidth: 3 });
  return {
    canvas: c,
    meta: {
      name: 'blank',
      expectedRegions: 0,
      expectedRects: 0,
      description: '空白图，验证「未识别到有效结构」提示',
    },
  };
}

/** 场景 12：开放的墙线（不闭合的 L 形分隔墙）。 */
export function sceneOpenWalls(strokeWidth = 3): Scene {
  const c = new SynthCanvas({ width: 400, height: 300, strokeWidth });
  c.polyline(
    [
      { x: 60, y: 60 },
      { x: 60, y: 220 },
      { x: 240, y: 220 },
    ],
    false,
  );
  c.line({ x: 300, y: 60 }, { x: 300, y: 200 });
  return {
    canvas: c,
    meta: {
      name: 'openWalls',
      expectedRegions: 0,
      expectedRects: 0,
      description: '开放墙线，验证 line / polyline 输出',
    },
  };
}

export const ALL_SCENES: ReadonlyArray<() => Scene> = [
  sceneSingleRoom,
  sceneSharedWall,
  sceneRoomGrid,
  () => sceneBrokenRoom(),
  () => sceneTiltedRoom(),
  sceneIrregularRegion,
  sceneRegionWithHole,
  () => sceneNarrowPassage(),
  sceneDuplicatedLines,
  sceneOpenWalls,
];
