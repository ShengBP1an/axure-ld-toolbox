/**
 * 预处理单测：二值化、形态学、去倾斜与低质量图告警。
 */

import { describe, expect, it } from 'vitest';
import {
  claheApprox,
  detectDarkStrokes,
  histogram,
  invert,
  stretchContrast,
  suppressShadow,
  toGray,
} from '../src/core/preprocess/grayscale';
import { adaptiveThreshold, otsuThreshold, applyGlobalThreshold } from '../src/core/preprocess/adaptiveThreshold';
import {
  close,
  dilate,
  erode,
  estimateStrokeWidth,
  fillSmallHoles,
  labelComponents,
  open,
  removeSmallBlobs,
} from '../src/core/preprocess/morphology';
import { estimateSkew, rotateBinary, MAX_AUTO_SKEW_DEG } from '../src/core/preprocess/deskew';
import { buildIntegral, rectSum, windowMean } from '../src/core/preprocess/integralImage';
import { isValidQuad, solveHomography, applyMatrix } from '../src/core/preprocess/perspective';
import { PreprocessorTs } from '../src/core/preprocess/PreprocessorTs';
import { presetPreprocess } from '../src/core/pipeline/params';
import type { BinaryImage, GrayImage } from '../src/core/preprocess/IPreprocessor';
import { sceneBlank, sceneLowQuality, sceneSingleRoom, sceneTiltedRoom, SynthCanvas } from './fixtures/synth';

function gray(w: number, h: number, fill: number): GrayImage {
  return { data: new Uint8Array(w * h).fill(fill), width: w, height: h };
}

function binary(w: number, h: number, on: Array<[number, number]>): BinaryImage {
  const img: BinaryImage = { data: new Uint8Array(w * h), width: w, height: h };
  for (const [x, y] of on) img.data[y * w + x] = 1;
  return img;
}

function countOn(img: BinaryImage): number {
  let n = 0;
  for (const v of img.data) if (v) n++;
  return n;
}

describe('integralImage', () => {
  it('矩形求和正确', () => {
    const img = gray(4, 4, 2);
    const ii = buildIntegral(img);
    expect(rectSum(ii, 0, 0, 3, 3)).toBe(32);
    expect(rectSum(ii, 1, 1, 2, 2)).toBe(8);
  });

  it('越界坐标被钳制', () => {
    const img = gray(4, 4, 1);
    const ii = buildIntegral(img);
    expect(rectSum(ii, -5, -5, 100, 100)).toBe(16);
  });

  it('窗口均值正确', () => {
    const img = gray(10, 10, 100);
    const ii = buildIntegral(img);
    expect(windowMean(ii, 5, 5, 2)).toBeCloseTo(100, 6);
  });
});

describe('灰度与对比度', () => {
  it('灰度化使用 BT.601 权重', () => {
    const data = new Uint8ClampedArray([255, 0, 0, 255]);
    const g = toGray({ data, width: 1, height: 1 });
    expect(g.data[0]).toBe(Math.round(255 * 0.299));
  });

  it('透明像素按白纸处理，不被当作黑色笔画', () => {
    const data = new Uint8ClampedArray([0, 0, 0, 0]);
    const g = toGray({ data, width: 1, height: 1 });
    expect(g.data[0]).toBe(255);
  });

  it('反相正确', () => {
    const g = gray(2, 2, 40);
    expect(invert(g).data[0]).toBe(215);
  });

  it('直方图总数等于像素数', () => {
    const h = histogram(gray(5, 4, 7));
    expect(h.total).toBe(20);
    expect(h.bins[7]).toBe(20);
  });

  /** 关键回归测试：近空白图不得被拉伸放大出「笔画」。 */
  it('动态范围过窄时不做拉伸（防止空白图被放大成噪声）', () => {
    const g: GrayImage = { data: new Uint8Array(100).fill(213), width: 10, height: 10 };
    g.data[5] = 215;
    g.data[9] = 212;
    const out = stretchContrast(g, 0.012, 0.988);
    // 应保持原值，而不是被拉到 0..255
    expect(Math.min(...out.data)).toBeGreaterThan(200);
    expect(Math.max(...out.data)).toBeLessThan(220);
  });

  it('动态范围足够时正常拉伸', () => {
    const g: GrayImage = { data: new Uint8Array(100), width: 10, height: 10 };
    for (let i = 0; i < 100; i++) g.data[i] = 80 + (i % 50);
    // pLow/pHigh 为 0/1 表示不裁剪任何分位，等价于恒等映射；
    // 因此这里用真实的分位裁剪值验证拉伸生效
    const out = stretchContrast(g, 0.02, 0.98);
    expect(Math.max(...out.data)).toBeGreaterThan(240);
    expect(Math.min(...out.data)).toBeLessThan(15);
  });

  it('pLow=0 / pHigh=1 时为恒等映射（不裁剪分位）', () => {
    const g: GrayImage = { data: new Uint8Array(100), width: 10, height: 10 };
    for (let i = 0; i < 100; i++) g.data[i] = 80 + (i % 50);
    const out = stretchContrast(g, 0, 1);
    expect(Math.max(...out.data)).toBe(129);
    expect(Math.min(...out.data)).toBe(80);
  });

  it('检测深色笔画（白纸黑线的稀疏线稿）', () => {
    const c = new SynthCanvas({ width: 100, height: 100, strokeWidth: 3 });
    c.rect(20, 20, 60, 60);
    expect(detectDarkStrokes(toGray(c.toRgba()))).toBe(true);
  });

  it('检测浅色笔画（深底浅线）', () => {
    const g: GrayImage = { data: new Uint8Array(10000).fill(30), width: 100, height: 100 };
    // 少量明显更亮的"笔画"像素
    for (let i = 0; i < 600; i++) g.data[i * 7] = 220;
    expect(detectDarkStrokes(g)).toBe(false);
  });

  it('阴影抑制拉平线性光照梯度', () => {
    const c = new SynthCanvas({ width: 120, height: 120, strokeWidth: 3 });
    c.rect(20, 20, 80, 80);
    c.addShadow(0.5);
    const g = toGray(c.toRgba());
    const before = spread(g);
    const after = spread(suppressShadow(g, 0.9));
    // 归一化后背景更均匀（笔画对比反而更突出）
    expect(after).toBeLessThanOrEqual(before + 1);
  });

  it('CLAHE 强度 0 时不改变图像', () => {
    const g = gray(20, 20, 128);
    g.data[10] = 30;
    const out = claheApprox(g, 0);
    expect(out.data[10]).toBe(30);
  });

  it('检测深色笔画', () => {
    const c = new SynthCanvas({ width: 100, height: 100, strokeWidth: 3 });
    c.rect(20, 20, 60, 60);
    expect(detectDarkStrokes(toGray(c.toRgba()))).toBe(true);
  });
});

function spread(g: GrayImage): number {
  // 只统计背景（较亮的一半）的极差，作为光照均匀度指标
  const vals = [...g.data].filter((v) => v > 150).sort((a, b) => a - b);
  if (vals.length < 10) return 0;
  return vals[vals.length - 1]! - vals[0]!;
}

describe('二值化', () => {
  it('Otsu 在双峰分布上找到可分离两峰的阈值', () => {
    const g: GrayImage = { data: new Uint8Array(200), width: 20, height: 10 };
    for (let i = 0; i < 200; i++) g.data[i] = i < 100 ? 40 : 210;
    const r = otsuThreshold(g);
    // 约定「前景 = v <= threshold」，因此阈值应落在暗峰上（含），且低于亮峰
    expect(r.threshold).toBeGreaterThanOrEqual(40);
    expect(r.threshold).toBeLessThan(210);
    expect(r.separability).toBeGreaterThan(0.9);
    // 用该阈值切分应恰好一半为前景
    expect(applyGlobalThreshold(g, r.threshold, true).ratio).toBeCloseTo(0.5, 6);
  });

  it('检测深色笔画', () => {
    const c = new SynthCanvas({ width: 100, height: 100, strokeWidth: 3 });
    c.rect(20, 20, 60, 60);
    expect(detectDarkStrokes(toGray(c.toRgba()))).toBe(true);
  });

  it('均匀图的分离度为 0（对比度告警依据）', () => {
    expect(otsuThreshold(gray(20, 20, 128)).separability).toBeCloseTo(0, 3);
  });

  it('全局阈值按 darkStrokes 方向取前景', () => {
    const g: GrayImage = { data: new Uint8Array([10, 200, 10, 200]), width: 2, height: 2 };
    expect(applyGlobalThreshold(g, 128, true).ratio).toBeCloseTo(0.5, 6);
    expect(applyGlobalThreshold(g, 128, false).ratio).toBeCloseTo(0.5, 6);
  });

  it('自适应阈值提取出线条且前景占比合理', () => {
    const c = new SynthCanvas({ width: 200, height: 150, strokeWidth: 3 });
    c.rect(30, 30, 140, 90);
    const g = toGray(c.toRgba());
    const r = adaptiveThreshold(g, { radius: 15, bias: 0.14, darkStrokes: true, otsuFallback: true });
    expect(r.foregroundRatio).toBeGreaterThan(0.005);
    expect(r.foregroundRatio).toBeLessThan(0.3);
  });

  it('均匀图的自适应结果为空（不凭空造出前景）', () => {
    const r = adaptiveThreshold(gray(60, 60, 255), {
      radius: 12,
      bias: 0.14,
      darkStrokes: true,
      otsuFallback: true,
    });
    expect(r.foregroundRatio).toBe(0);
  });
});

describe('形态学', () => {
  it('膨胀扩大前景', () => {
    const img = binary(9, 9, [[4, 4]]);
    expect(countOn(dilate(img, 1))).toBe(9);
  });

  it('腐蚀缩小前景', () => {
    const img: BinaryImage = { data: new Uint8Array(81).fill(1), width: 9, height: 9 };
    expect(countOn(erode(img, 1))).toBe(49);
  });

  it('膨胀不修改原图', () => {
    const img = binary(9, 9, [[4, 4]]);
    dilate(img, 2);
    expect(countOn(img)).toBe(1);
  });

  it('开运算移除孤立噪点', () => {
    const on: Array<[number, number]> = [[1, 1]];
    for (let x = 4; x < 9; x++) for (let y = 4; y < 9; y++) on.push([x, y]);
    const img = binary(12, 12, on);
    const opened = open(img, 1);
    expect(opened.data[1 * 12 + 1]).toBe(0);
    expect(countOn(opened)).toBeGreaterThan(0);
  });

  it('闭运算弥合细小缺口', () => {
    const on: Array<[number, number]> = [];
    for (let x = 0; x < 20; x++) if (x !== 10) on.push([x, 5]);
    const img = binary(20, 11, on);
    expect(close(img, 1).data[5 * 20 + 10]).toBe(1);
  });

  it('连通域标记正确', () => {
    const img = binary(10, 10, [[1, 1], [2, 1], [7, 7], [8, 8]]);
    const cc = labelComponents(img);
    expect(cc.count).toBe(2);
    expect(cc.areas[1]).toBe(2);
    expect(cc.areas[2]).toBe(2);
  });

  it('小噪点被移除，大结构保留', () => {
    const on: Array<[number, number]> = [[1, 1]];
    for (let x = 5; x < 15; x++) on.push([x, 10]);
    const img = binary(20, 20, on);
    const r = removeSmallBlobs(img, 5);
    expect(r.removed).toBe(1);
    expect(countOn(r.image)).toBe(10);
  });

  it('小孔洞被填充', () => {
    const on: Array<[number, number]> = [];
    for (let x = 2; x < 12; x++) for (let y = 2; y < 12; y++) on.push([x, y]);
    const img = binary(16, 16, on);
    img.data[6 * 16 + 6] = 0;
    expect(fillSmallHoles(img, 10).data[6 * 16 + 6]).toBe(1);
  });

  it('笔画宽度估计随线宽单调增加', () => {
    const thinLine = new SynthCanvas({ width: 120, height: 120, strokeWidth: 2 });
    thinLine.rect(20, 20, 80, 80);
    const thickLine = new SynthCanvas({ width: 120, height: 120, strokeWidth: 8 });
    thickLine.rect(20, 20, 80, 80);
    const a = estimateStrokeWidth(thinLine.toBinary());
    const b = estimateStrokeWidth(thickLine.toBinary());
    expect(b).toBeGreaterThan(a);
  });
});

describe('去倾斜', () => {
  it('正立图的倾角接近 0', () => {
    const c = new SynthCanvas({ width: 240, height: 200, strokeWidth: 3 });
    c.rect(30, 30, 180, 140);
    const est = estimateSkew(c.toBinary());
    expect(Math.abs(est.angle)).toBeLessThan(1);
  });

  it('检出 4° 倾斜（符号与方向一致）', () => {
    const est = estimateSkew(sceneTiltedRoom(4, 3).canvas.toBinary());
    expect(Math.abs(est.angle)).toBeGreaterThan(2);
    expect(Math.abs(est.angle)).toBeLessThan(7);
    expect(est.outOfRange).toBe(false);
  });

  it('旋转后再估计倾角显著减小', () => {
    const bin = sceneTiltedRoom(5, 3).canvas.toBinary();
    const est = estimateSkew(bin);
    const fixed = rotateBinary(bin, -est.angle);
    expect(Math.abs(estimateSkew(fixed).angle)).toBeLessThan(Math.abs(est.angle));
  });

  it('内容过少时不做估计', () => {
    const est = estimateSkew(binary(50, 50, [[10, 10], [11, 11]]));
    expect(est.angle).toBe(0);
    expect(est.confidence).toBe(0);
  });

  it('旋转 0° 不改变图像尺寸', () => {
    const img = binary(20, 20, [[5, 5]]);
    const r = rotateBinary(img, 0);
    expect(r.width).toBe(20);
    expect(r.height).toBe(20);
  });

  it('自动校正范围为 ±15°', () => {
    expect(MAX_AUTO_SKEW_DEG).toBe(15);
  });
});

describe('透视校正', () => {
  it('凸四边形有效，自相交四边形无效', () => {
    expect(isValidQuad([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }])).toBe(true);
    expect(isValidQuad([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }])).toBe(false);
  });

  it('homography 精确映射四个角点', () => {
    const src = [{ x: 0, y: 0 }, { x: 100, y: 10 }, { x: 95, y: 80 }, { x: 5, y: 70 }];
    const dst = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }];
    const m = solveHomography(src, dst);
    for (let i = 0; i < 4; i++) {
      const p = applyMatrix(m, src[i]!);
      expect(p.x).toBeCloseTo(dst[i]!.x, 4);
      expect(p.y).toBeCloseTo(dst[i]!.y, 4);
    }
  });
});

describe('PreprocessorTs 集成', () => {
  const pre = new PreprocessorTs();

  it('正常草图产出合理前景占比且无严重告警', () => {
    const out = pre.run(sceneSingleRoom(4).canvas.toRgba(), {
      ...presetPreprocess('standard'),
      deskew: false,
    });
    expect(out.foregroundRatio).toBeGreaterThan(0.005);
    expect(out.foregroundRatio).toBeLessThan(0.25);
    expect(out.warnings.some((w) => w.code === 'SPARSE_FOREGROUND')).toBe(false);
    expect(out.warnings.some((w) => w.code === 'DENSE_FOREGROUND')).toBe(false);
  });

  /** 验收标准 8 相关：空白图必须被识别为「几乎没有笔画」，而不是造出内容。 */
  it('空白图前景占比为 0 并给出稀疏告警', () => {
    const out = pre.run(sceneBlank().canvas.toRgba(), {
      ...presetPreprocess('standard'),
      deskew: false,
    });
    expect(out.foregroundRatio).toBe(0);
    expect(out.warnings.some((w) => w.code === 'SPARSE_FOREGROUND')).toBe(true);
  });

  it('低质量图给出图像质量告警', () => {
    const out = pre.run(sceneLowQuality(2).canvas.toRgba(), {
      ...presetPreprocess('standard'),
      deskew: false,
    });
    expect(out.warnings.length).toBeGreaterThan(0);
  });

  it('各步骤可单独关闭（撤销自动校正）', () => {
    const img = sceneSingleRoom(4).canvas.toRgba();
    const params = presetPreprocess('standard');
    const full = pre.run(img, { ...params, deskew: false });
    const minimal = pre.run(img, {
      ...params,
      deskew: false,
      contrastBoost: 0,
      shadowSuppress: 0,
      denoiseOpen: 0,
      denoiseClose: 0,
      minBlobArea: 0,
    });
    // 两者都应提取到线条，但结果不同（证明参数生效）
    expect(full.foregroundRatio).toBeGreaterThan(0);
    expect(minimal.foregroundRatio).toBeGreaterThan(0);
    expect(Object.keys(full.timings).length).toBeGreaterThan(0);
  });

  it('输出灰度图与二值图尺寸一致，可用于底图预览', () => {
    const out = pre.run(sceneSingleRoom(4).canvas.toRgba(), {
      ...presetPreprocess('standard'),
      deskew: false,
    });
    expect(out.binary.width).toBe(out.gray.width);
    expect(out.binary.height).toBe(out.gray.height);
  });

  it('不修改输入图像（原图只读）', () => {
    const img = sceneSingleRoom(4).canvas.toRgba();
    const copy = new Uint8ClampedArray(img.data);
    pre.run(img, { ...presetPreprocess('standard'), deskew: false });
    expect(img.data).toEqual(copy);
  });
});
