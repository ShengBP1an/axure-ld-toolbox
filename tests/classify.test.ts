/**
 * 几何语义分类单测 —— 对应最低验收标准 1 与 2：
 *   1. 方正房间输出为 rect（低节点数），不是高节点自由路径；
 *   2. 不规则区域输出为节点可编辑的封闭路径。
 */

import { describe, expect, it } from 'vitest';
import {
  alignmentScore,
  classifyClosed,
  classifyOpen,
  DEFAULT_CLASSIFY,
  isBoundaryFace,
  isBoundaryPolyline,
} from '../src/core/recognize/classify';
import type { Point } from '../src/types/vector';

const OPTS = DEFAULT_CLASSIFY;

function rotate(pts: readonly Point[], deg: number, cx = 0, cy = 0): Point[] {
  const r = (deg * Math.PI) / 180;
  return pts.map((p) => ({
    x: cx + (p.x - cx) * Math.cos(r) - (p.y - cy) * Math.sin(r),
    y: cy + (p.x - cx) * Math.sin(r) + (p.y - cy) * Math.cos(r),
  }));
}

describe('classifyClosed（验收标准 1）', () => {
  it('完美轴对齐矩形 → rect，4 个节点', () => {
    const square: Point[] = [
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 110, y: 90 },
      { x: 10, y: 90 },
    ];
    const r = classifyClosed(square, OPTS);
    expect(r.kind).toBe('rect');
    expect(r.points).toHaveLength(4);
    expect(r.rect).toEqual({ x: 10, y: 20, w: 100, h: 70 });
    expect(r.deviation).toBeLessThan(0.01);
  });

  it('带轻微抖动的矩形仍输出 rect', () => {
    const jittered: Point[] = [
      { x: 10.4, y: 19.6 },
      { x: 109.7, y: 20.5 },
      { x: 110.2, y: 89.4 },
      { x: 9.8, y: 90.3 },
    ];
    const r = classifyClosed(jittered, OPTS);
    expect(r.kind).toBe('rect');
    expect(r.points).toHaveLength(4);
  });

  it('矩形边上多余的共线点被清除后仍输出 rect', () => {
    const withExtra: Point[] = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 100, y: 100 },
      { x: 50, y: 100 },
      { x: 0, y: 100 },
      { x: 0, y: 50 },
    ];
    const r = classifyClosed(withExtra, OPTS);
    expect(r.kind).toBe('rect');
    expect(r.points).toHaveLength(4);
  });

  it('旋转 30° 的矩形 → polygon（顶点展开，不用 transform）', () => {
    const square: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 0, y: 60 },
    ];
    const r = classifyClosed(rotate(square, 30, 50, 30), OPTS);
    expect(r.kind).toBe('polygon');
    expect(r.points).toHaveLength(4);
    // 关键：不输出 rect（rect 无法表达旋转），也不退化为高节点路径
    expect(r.rect).toBeUndefined();
  });

  it('正六边形 → polygon 且标记为规则', () => {
    const hexagon: Point[] = Array.from({ length: 6 }, (_, i) => {
      const t = (i / 6) * Math.PI * 2;
      return { x: 100 + Math.cos(t) * 50, y: 100 + Math.sin(t) * 50 };
    });
    const r = classifyClosed(hexagon, OPTS);
    expect(r.kind).toBe('polygon');
    expect(r.regular).toBe(true);
    expect(r.points).toHaveLength(6);
  });

  it('三角形 → polygon', () => {
    const tri: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 50, y: 80 },
    ];
    const r = classifyClosed(tri, OPTS);
    expect(r.kind).toBe('polygon');
    expect(r.points).toHaveLength(3);
  });

  it('L 形（6 顶点凹多边形）→ polygon，不被误判为 rect', () => {
    const lshape: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 40 },
      { x: 40, y: 40 },
      { x: 40, y: 100 },
      { x: 0, y: 100 },
    ];
    const r = classifyClosed(lshape, OPTS);
    expect(r.kind).toBe('polygon');
    expect(r.kind).not.toBe('rect');
    expect(r.points).toHaveLength(6);
  });

  it('明显非矩形的四边形不输出 rect', () => {
    const trapezoid: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 70, y: 60 },
      { x: 30, y: 60 },
    ];
    const r = classifyClosed(trapezoid, OPTS);
    expect(r.kind).not.toBe('rect');
    expect(r.kind).toBe('polygon');
  });
});

describe('classifyClosed（验收标准 2）', () => {
  it('高节点不规则区域 → closedPath，且 points 可编辑', () => {
    const blob: Point[] = Array.from({ length: 28 }, (_, i) => {
      const t = (i / 28) * Math.PI * 2;
      const r = 60 + Math.sin(i * 1.7) * 22 + Math.cos(i * 0.9) * 11;
      return { x: 150 + Math.cos(t) * r, y: 150 + Math.sin(t) * r };
    });
    const r = classifyClosed(blob, OPTS);
    expect(r.kind).toBe('closedPath');
    expect(r.points.length).toBeGreaterThan(12);
    // 节点可编辑：points 是独立数组
    expect(Array.isArray(r.points)).toBe(true);
  });

  it('中等复杂度不规则区域 → polygon 或 closedPath（都可编辑节点）', () => {
    const pts: Point[] = [
      { x: 20, y: 30 },
      { x: 90, y: 12 },
      { x: 160, y: 48 },
      { x: 190, y: 120 },
      { x: 130, y: 175 },
      { x: 60, y: 160 },
      { x: 15, y: 100 },
    ];
    const r = classifyClosed(pts, OPTS);
    expect(['polygon', 'closedPath']).toContain(r.kind);
    expect(r.points.length).toBeGreaterThanOrEqual(6);
  });

  it('不规则区域不会被强行压成矩形', () => {
    const irregular: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 10 },
      { x: 95, y: 80 },
      { x: 5, y: 60 },
    ];
    const r = classifyClosed(irregular, OPTS);
    expect(r.kind).not.toBe('rect');
  });

  it('顶点顺序被归一化为顺时针（y 向下）', () => {
    const ccw: Point[] = [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 },
      { x: 100, y: 0 },
    ];
    const r = classifyClosed(ccw, OPTS);
    // 归一化后应为 rect（朝向已修正）
    expect(r.kind).toBe('rect');
  });
});

describe('classifyOpen', () => {
  it('两点 → line', () => {
    const r = classifyOpen([{ x: 0, y: 0 }, { x: 100, y: 0 }], OPTS, false);
    expect(r.kind).toBe('line');
    expect(r.points).toHaveLength(2);
  });

  it('近似直线的多点 → line（简化为两端点）', () => {
    const pts: Point[] = Array.from({ length: 12 }, (_, i) => ({ x: i * 10, y: (i % 2) * 0.6 }));
    const r = classifyOpen(pts, OPTS, false);
    expect(r.kind).toBe('line');
    expect(r.points).toHaveLength(2);
  });

  it('L 形折线 → polyline', () => {
    const pts: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 80 },
    ];
    const r = classifyOpen(pts, OPTS, false);
    expect(r.kind).toBe('polyline');
    expect(r.points).toHaveLength(3);
  });

  it('被标记为曲线的折线 → openPath', () => {
    const pts: Point[] = Array.from({ length: 16 }, (_, i) => {
      const t = (i / 15) * Math.PI;
      return { x: Math.cos(t) * 80 + 100, y: Math.sin(t) * 60 };
    });
    const r = classifyOpen(pts, OPTS, true);
    expect(r.kind).toBe('openPath');
    expect(r.points.length).toBeGreaterThan(3);
  });

  it('节点数超过折线阈值 → openPath', () => {
    const pts: Point[] = Array.from({ length: 40 }, (_, i) => ({
      x: i * 8,
      y: (i % 3) * 14,
    }));
    const r = classifyOpen(pts, OPTS, false);
    expect(r.kind).toBe('openPath');
  });
});

describe('图层判定', () => {
  it('占据大部分画面的最外层面 → 地图边界', () => {
    expect(isBoundaryFace(9000, 10000, true)).toBe(true);
    expect(isBoundaryFace(9000, 10000, false)).toBe(false);
    expect(isBoundaryFace(1000, 10000, true)).toBe(false);
  });

  it('长度接近画面周长的折线 → 地图边界', () => {
    const longLine: Point[] = [
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 400, y: 300 },
    ];
    expect(isBoundaryPolyline(longLine, 400, 300)).toBe(true);

    const shortLine: Point[] = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
    ];
    expect(isBoundaryPolyline(shortLine, 400, 300)).toBe(false);
  });
});

describe('alignmentScore', () => {
  const steps = [0, 45, 90, 135];

  it('全轴对齐折线得分为 1', () => {
    const pts: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ];
    expect(alignmentScore(pts, steps, 5)).toBeCloseTo(1, 6);
  });

  it('斜向折线得分为 0', () => {
    const pts: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 27 },
    ];
    expect(alignmentScore(pts, steps, 5)).toBeCloseTo(0, 6);
  });

  it('部分对齐得到中间分数', () => {
    const pts: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 160, y: 33 },
    ];
    const s = alignmentScore(pts, steps, 5);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});
