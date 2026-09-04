/**
 * 几何工具单测。
 * 重点覆盖 transform.ts（唯一换算源）—— 对应最低验收标准 3 与 7。
 */

import { describe, expect, it } from 'vitest';
import { rdp, rdpClosed, removeCollinear, dedupePoints } from '../src/core/geometry/rdp';
import {
  analyzeRegularity,
  area,
  centroid,
  convexHull,
  minAreaRect,
  pointInPolygon,
  polygonContains,
  rectFillRatio,
  signedArea,
  toClockwise,
} from '../src/core/geometry/polygon';
import { findSelfIntersections, segmentIntersection } from '../src/core/geometry/intersect';
import { fitLine, isCollinearMergeable, mergeCollinearSegments, dedupeSegments } from '../src/core/geometry/lineFit';
import {
  canvasBoundsInUnit,
  imgToUnit,
  makeImageToUnit,
  rescaleElements,
  unitLengthToCanvas,
  unitToCanvas,
  canvasToUnit,
  strokeWidthToCanvas,
} from '../src/core/geometry/transform';
import { DEFAULT_SETTINGS, pixelsPerUnit, type ProjectSettings } from '../src/types/project';
import { defaultStyle, elementPoints, type VectorElement } from '../src/types/vector';
import { angleDiffDeg, undirectedAngleDiffDeg, pointLineDistance } from '../src/core/geometry/vec';

describe('rdp', () => {
  it('保留首尾端点', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 1, y: 0.1 },
      { x: 2, y: -0.1 },
      { x: 3, y: 0 },
    ];
    const out = rdp(pts, { epsilon: 0.5 });
    expect(out[0]).toEqual({ x: 0, y: 0 });
    expect(out[out.length - 1]).toEqual({ x: 3, y: 0 });
  });

  it('直线上的中间点被移除', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ x: i, y: 0 }));
    const out = rdp(pts, { epsilon: 0.1 });
    expect(out).toHaveLength(2);
  });

  it('保留超过容差的拐点', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 5 },
      { x: 10, y: 5 },
    ];
    const out = rdp(pts, { epsilon: 0.5 });
    expect(out).toHaveLength(4);
  });

  it('闭合折线简化后至少保留 3 点', () => {
    const circle = Array.from({ length: 40 }, (_, i) => {
      const t = (i / 40) * Math.PI * 2;
      return { x: Math.cos(t) * 10, y: Math.sin(t) * 10 };
    });
    const out = rdpClosed(circle, 50);
    expect(out.length).toBeGreaterThanOrEqual(3);
  });

  it('矩形环简化为 4 个角', () => {
    const ring: Array<{ x: number; y: number }> = [];
    for (let x = 0; x <= 40; x += 2) ring.push({ x, y: 0 });
    for (let y = 2; y <= 20; y += 2) ring.push({ x: 40, y });
    for (let x = 38; x >= 0; x -= 2) ring.push({ x, y: 20 });
    for (let y = 18; y >= 2; y -= 2) ring.push({ x: 0, y });
    const out = rdp(ring, { epsilon: 1, closed: true });
    expect(out.length).toBeLessThanOrEqual(5);
    expect(out.length).toBeGreaterThanOrEqual(4);
  });

  it('minPoints 生效', () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ x: i, y: 0 }));
    const out = rdp(pts, { epsilon: 100, closed: true, minPoints: 3 });
    expect(out.length).toBeGreaterThanOrEqual(3);
  });
});

describe('removeCollinear / dedupePoints', () => {
  it('移除共线中间点', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    const out = removeCollinear(pts, 5, false);
    expect(out).toHaveLength(3);
  });

  it('移除重复点', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 0.01, y: 0 },
      { x: 5, y: 0 },
    ];
    expect(dedupePoints(pts, 0.1)).toHaveLength(2);
  });
});

describe('polygon', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it('面积计算正确', () => {
    expect(area(square)).toBeCloseTo(100, 6);
  });

  it('signedArea 顺时针为正（y 向下坐标系）', () => {
    expect(signedArea(square)).toBeGreaterThan(0);
  });

  it('toClockwise 归一化朝向', () => {
    const ccw = [...square].reverse();
    expect(signedArea(toClockwise(ccw))).toBeGreaterThan(0);
  });

  it('质心正确', () => {
    const c = centroid(square);
    expect(c.x).toBeCloseTo(5, 6);
    expect(c.y).toBeCloseTo(5, 6);
  });

  it('点在多边形内判定', () => {
    expect(pointInPolygon({ x: 5, y: 5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 15, y: 5 }, square)).toBe(false);
  });

  it('包含判定', () => {
    const inner = [
      { x: 2, y: 2 },
      { x: 8, y: 2 },
      { x: 8, y: 8 },
      { x: 2, y: 8 },
    ];
    expect(polygonContains(square, inner)).toBe(true);
    expect(polygonContains(inner, square)).toBe(false);
  });

  it('凸包正确', () => {
    const pts = [...square, { x: 5, y: 5 }];
    expect(convexHull(pts)).toHaveLength(4);
  });

  it('轴对齐矩形的最小外接矩形与自身重合', () => {
    const mar = minAreaRect(square);
    expect(mar.area).toBeCloseTo(100, 4);
    expect(rectFillRatio(square)).toBeCloseTo(1, 4);
  });

  it('旋转 30° 的矩形仍被识别为矩形', () => {
    const rad = Math.PI / 6;
    const rotated = square.map((p) => ({
      x: p.x * Math.cos(rad) - p.y * Math.sin(rad),
      y: p.x * Math.sin(rad) + p.y * Math.cos(rad),
    }));
    expect(rectFillRatio(rotated)).toBeGreaterThan(0.98);
    const reg = analyzeRegularity(rotated, 8);
    expect(reg.allRightAngles).toBe(true);
    // 旋转后不再轴对齐
    expect(reg.axisAligned).toBe(false);
  });

  it('规则度分析：正方形边长方差为 0', () => {
    const reg = analyzeRegularity(square, 8);
    expect(reg.edgeCv).toBeCloseTo(0, 5);
    expect(reg.allRightAngles).toBe(true);
    expect(reg.axisAligned).toBe(true);
  });
});

describe('intersect', () => {
  it('交叉线段求交', () => {
    const hit = segmentIntersection({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 });
    expect(hit).not.toBeNull();
    expect(hit!.point.x).toBeCloseTo(5, 6);
    expect(hit!.point.y).toBeCloseTo(5, 6);
  });

  it('平行线段不相交', () => {
    expect(segmentIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 5 }, { x: 10, y: 5 })).toBeNull();
  });

  it('共线重叠被标记', () => {
    const hit = segmentIntersection({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 15, y: 0 });
    expect(hit).not.toBeNull();
    expect(hit!.collinear).toBe(true);
  });

  it('简单矩形无自相交', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(findSelfIntersections(square, true)).toHaveLength(0);
  });

  it('蝴蝶形检出自相交', () => {
    const bowtie = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    expect(findSelfIntersections(bowtie, true).length).toBeGreaterThan(0);
  });
});

describe('lineFit', () => {
  it('水平点集拟合出水平方向', () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ x: i, y: 0 }));
    const fit = fitLine(pts);
    expect(Math.abs(fit.direction.y)).toBeLessThan(1e-6);
    expect(fit.rmse).toBeCloseTo(0, 6);
  });

  it('垂直点集拟合不发散（全最小二乘的优势）', () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ x: 5, y: i }));
    const fit = fitLine(pts);
    expect(Math.abs(fit.direction.x)).toBeLessThan(1e-6);
    expect(fit.rmse).toBeCloseTo(0, 6);
  });

  it('共线线段可合并', () => {
    const s1 = { a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
    const s2 = { a: { x: 12, y: 0 }, b: { x: 20, y: 0 } };
    expect(isCollinearMergeable(s1, s2, 5, 2, 5)).toBe(true);
    const merged = mergeCollinearSegments([s1, s2], { angleTolDeg: 5, lateralTol: 2, gapTol: 5 });
    expect(merged).toHaveLength(1);
  });

  it('垂直线段不被合并', () => {
    const s1 = { a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
    const s2 = { a: { x: 0, y: 0 }, b: { x: 0, y: 10 } };
    const merged = mergeCollinearSegments([s1, s2], { angleTolDeg: 5, lateralTol: 2, gapTol: 5 });
    expect(merged).toHaveLength(2);
  });

  it('重复线被去重', () => {
    const s1 = { a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
    const s2 = { a: { x: 0, y: 1 }, b: { x: 10, y: 1 } };
    expect(dedupeSegments([s1, s2], 2)).toHaveLength(1);
  });
});

describe('vec 角度工具', () => {
  it('角度差考虑环绕', () => {
    expect(angleDiffDeg(350, 10)).toBeCloseTo(20, 6);
    expect(undirectedAngleDiffDeg(1, 179)).toBeCloseTo(2, 6);
    expect(undirectedAngleDiffDeg(0, 90)).toBeCloseTo(90, 6);
  });

  it('点到直线距离', () => {
    expect(pointLineDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3, 6);
  });
});

/* ================================================================== */
/* transform：验收标准 3 与 7 的核心保障                                */
/* ================================================================== */

describe('transform —— 唯一换算源', () => {
  const settings: ProjectSettings = {
    ...DEFAULT_SETTINGS,
    mapWidth: 60,
    mapHeight: 40,
    canvasWidthPx: 1200,
    canvasHeightPx: 800,
  };

  it('pixelsPerUnit 计算正确', () => {
    expect(pixelsPerUnit(settings)).toBeCloseTo(20, 9);
  });

  it('unit ↔ canvasPx 往返无损', () => {
    const p = { x: 12.345, y: 6.789 };
    const back = canvasToUnit(unitToCanvas(p, settings), settings);
    expect(back.x).toBeCloseTo(p.x, 9);
    expect(back.y).toBeCloseTo(p.y, 9);
  });

  it('imgPx → unit：图像铺满地图矩形', () => {
    const t = makeImageToUnit(1000, 667, settings);
    expect(imgToUnit({ x: 0, y: 0 }, t)).toEqual({ x: 0, y: 0 });
    const br = imgToUnit({ x: 1000, y: 667 }, t);
    expect(br.x).toBeCloseTo(60, 9);
    expect(br.y).toBeCloseTo(40, 9);
  });

  it('画布范围（unit 空间）等于地图尺寸', () => {
    const b = canvasBoundsInUnit(settings);
    expect(b.maxX).toBeCloseTo(60, 9);
    expect(b.maxY).toBeCloseTo(40, 9);
  });

  /**
   * 验收标准 3：修改地图尺寸后，所有矢量坐标和线宽按同一规则更新。
   */
  it('地图尺寸翻倍后，所有坐标与线宽按同一比例更新', () => {
    const style = defaultStyle('wall', 0.1);
    const elements: VectorElement[] = [
      { id: 'a', kind: 'line', layer: 'wall', confidence: 1, issueIds: [], style, source: 'auto', a: { x: 1, y: 2 }, b: { x: 11, y: 2 } },
      { id: 'b', kind: 'rect', layer: 'region', confidence: 1, issueIds: [], style, source: 'auto', x: 5, y: 5, w: 20, h: 10 },
      {
        id: 'c',
        kind: 'closedPath',
        layer: 'region',
        confidence: 1,
        issueIds: [],
        style,
        source: 'auto',
        points: [
          { x: 30, y: 10 },
          { x: 40, y: 12 },
          { x: 35, y: 25 },
        ],
      },
    ];

    const to: ProjectSettings = { ...settings, mapWidth: 120, mapHeight: 80 };
    const scaled = rescaleElements(elements, settings, to);

    // 每个顶点严格 ×2
    for (let i = 0; i < elements.length; i++) {
      const src = elementPoints(elements[i]!);
      const dst = elementPoints(scaled[i]!);
      expect(dst).toHaveLength(src.length);
      for (let k = 0; k < src.length; k++) {
        expect(dst[k]!.x).toBeCloseTo(src[k]!.x * 2, 9);
        expect(dst[k]!.y).toBeCloseTo(src[k]!.y * 2, 9);
      }
      // 线宽同样 ×2（几何平均 = √(2×2) = 2）
      expect(scaled[i]!.style.strokeWidth).toBeCloseTo(elements[i]!.style.strokeWidth * 2, 9);
    }

    // rect 参数也正确更新
    const rect = scaled[1]!;
    expect(rect.kind).toBe('rect');
    if (rect.kind === 'rect') {
      expect(rect.x).toBeCloseTo(10, 9);
      expect(rect.w).toBeCloseTo(40, 9);
      expect(rect.h).toBeCloseTo(20, 9);
    }
  });

  /**
   * 验收标准 7：SVG 画布比例与工具设置一致，关键控制点无坐标漂移。
   *
   * 关键点：只改画布像素尺寸（不改地图尺寸）时，
   * unit 坐标必须完全不变，只有渲染 / 导出时的像素坐标按新比例变化。
   */
  it('仅改画布像素尺寸时，unit 坐标不漂移，导出像素按新比例', () => {
    const p = { x: 15, y: 10 };
    const px1 = unitToCanvas(p, settings);
    expect(px1.x).toBeCloseTo(300, 9);
    expect(px1.y).toBeCloseTo(200, 9);

    const bigger: ProjectSettings = { ...settings, canvasWidthPx: 2400, canvasHeightPx: 1600 };
    // rescaleElements 不应改变任何东西（地图尺寸未变）
    const style = defaultStyle('wall', 0.1);
    const el: VectorElement = {
      id: 'x', kind: 'line', layer: 'wall', confidence: 1, issueIds: [], style, source: 'auto',
      a: { x: 15, y: 10 }, b: { x: 25, y: 10 },
    };
    const same = rescaleElements([el], settings, bigger);
    expect(elementPoints(same[0]!)[0]).toEqual({ x: 15, y: 10 });

    // 但导出像素坐标翻倍
    const px2 = unitToCanvas(p, bigger);
    expect(px2.x).toBeCloseTo(600, 9);
    expect(px2.y).toBeCloseTo(400, 9);
  });

  it('非等比缩放下 strokeWidth 用几何平均，方向无关', () => {
    const aniso: ProjectSettings = { ...settings, canvasWidthPx: 1200, canvasHeightPx: 400 };
    // sx = 20, sy = 10 → 几何平均 = √200 ≈ 14.142
    expect(unitLengthToCanvas(1, aniso)).toBeCloseTo(Math.sqrt(200), 6);
    const style = defaultStyle('wall', 2);
    expect(strokeWidthToCanvas(style, aniso)).toBeCloseTo(2 * Math.sqrt(200), 6);
  });

  it('多次连续缩放与一次性缩放结果一致（无累积漂移）', () => {
    const style = defaultStyle('region', 0.2);
    const el: VectorElement = {
      id: 'r', kind: 'rect', layer: 'region', confidence: 1, issueIds: [], style, source: 'auto',
      x: 3, y: 4, w: 10, h: 6,
    };
    const s2: ProjectSettings = { ...settings, mapWidth: 90, mapHeight: 60 };
    const s3: ProjectSettings = { ...settings, mapWidth: 180, mapHeight: 120 };

    const stepwise = rescaleElements(rescaleElements([el], settings, s2), s2, s3)[0]!;
    const direct = rescaleElements([el], settings, s3)[0]!;

    const a = elementPoints(stepwise);
    const b = elementPoints(direct);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!.x).toBeCloseTo(b[i]!.x, 8);
      expect(a[i]!.y).toBeCloseTo(b[i]!.y, 8);
    }
    expect(stepwise.style.strokeWidth).toBeCloseTo(direct.style.strokeWidth, 8);
  });
});
