/**
 * 拓扑守卫单测 —— 对应最低验收标准 4：
 * 「防止过度简化导致通道消失、区域相交或拓扑关系改变」。
 */

import { describe, expect, it } from 'vitest';
import {
  checkSimplification,
  containmentChanged,
  DEFAULT_GUARD,
  extractContainment,
  findOverlaps,
  guardedSimplify,
} from '../src/core/recognize/topologyGuard';
import { area, minWidth } from '../src/core/geometry/polygon';
import { isSelfIntersecting } from '../src/core/geometry/intersect';
import type { Point } from '../src/types/vector';

/** 构造一个「哑铃形」区域：两端宽、中间细通道。 */
function dumbbell(passageWidth: number): Point[] {
  const h = passageWidth / 2;
  return [
    { x: 0, y: 0 },
    { x: 60, y: 0 },
    { x: 60, y: 50 - h },
    { x: 140, y: 50 - h },
    { x: 140, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 100 },
    { x: 140, y: 100 },
    { x: 140, y: 50 + h },
    { x: 60, y: 50 + h },
    { x: 60, y: 100 },
    { x: 0, y: 100 },
  ];
}

describe('checkSimplification', () => {
  const square: Point[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  it('顶点数低于下限被拦截', () => {
    const r = checkSimplification(square, [{ x: 0, y: 0 }, { x: 100, y: 100 }], true, DEFAULT_GUARD);
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.kind).toBe('tooFewVertices');
  });

  it('面积漂移过大被拦截', () => {
    const shrunk: Point[] = [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 60 },
      { x: 0, y: 60 },
    ];
    const r = checkSimplification(square, shrunk, true, DEFAULT_GUARD);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.kind === 'areaDrift')).toBe(true);
  });

  it('引入自相交被拦截', () => {
    const bowtie: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
    ];
    const r = checkSimplification(square, bowtie, true, DEFAULT_GUARD);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.kind === 'selfIntersect')).toBe(true);
  });

  it('形状偏差过大被拦截', () => {
    const longThin: Point[] = Array.from({ length: 20 }, (_, i) => ({ x: i * 5, y: i % 2 === 0 ? 0 : 30 }));
    const flattened: Point[] = [
      { x: 0, y: 0 },
      { x: 95, y: 0 },
    ];
    const r = checkSimplification(longThin, flattened, false, DEFAULT_GUARD);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.kind === 'shapeDeviation')).toBe(true);
  });

  it('合法简化通过校验', () => {
    const dense: Point[] = [];
    for (let x = 0; x <= 100; x += 5) dense.push({ x, y: 0 });
    for (let y = 5; y <= 100; y += 5) dense.push({ x: 100, y });
    for (let x = 95; x >= 0; x -= 5) dense.push({ x, y: 100 });
    for (let y = 95; y >= 5; y -= 5) dense.push({ x: 0, y });
    const r = checkSimplification(dense, square, true, DEFAULT_GUARD);
    expect(r.ok).toBe(true);
  });
});

describe('guardedSimplify（细通道保护）', () => {
  it('哑铃形的细通道在大容差下不会消失', () => {
    const shape = dumbbell(10);
    const before = minWidth(shape);
    const r = guardedSimplify(shape, true, 40, { ...DEFAULT_GUARD, minPassageWidth: 8 });
    const after = minWidth(r.points);

    // 通道宽度不得显著变窄
    expect(after).toBeGreaterThan(before * 0.7);
    // 面积保持
    expect(area(r.points)).toBeGreaterThan(area(shape) * 0.85);
  });

  it('容差过大时降级重试并记录违规', () => {
    const shape = dumbbell(8);
    const r = guardedSimplify(shape, true, 60, DEFAULT_GUARD);
    // 要么退回原始几何，要么记录过违规后用更小容差成功
    expect(r.fellBack || r.violations.length > 0 || r.retries > 0).toBe(true);
    expect(r.points.length).toBeGreaterThanOrEqual(3);
  });

  it('简化不引入自相交', () => {
    const star: Point[] = [];
    for (let i = 0; i < 20; i++) {
      const t = (i / 20) * Math.PI * 2;
      const r = i % 2 === 0 ? 60 : 26;
      star.push({ x: 100 + Math.cos(t) * r, y: 100 + Math.sin(t) * r });
    }
    expect(isSelfIntersecting(star, true)).toBe(false);
    const out = guardedSimplify(star, true, 12, DEFAULT_GUARD);
    expect(isSelfIntersecting(out.points, true)).toBe(false);
  });

  it('小容差下正常简化冗余点', () => {
    const dense: Point[] = [];
    for (let x = 0; x <= 200; x += 2) dense.push({ x, y: 0 });
    for (let y = 2; y <= 100; y += 2) dense.push({ x: 200, y });
    for (let x = 198; x >= 0; x -= 2) dense.push({ x, y: 100 });
    for (let y = 98; y >= 2; y -= 2) dense.push({ x: 0, y });

    const r = guardedSimplify(dense, true, 1.5, DEFAULT_GUARD);
    expect(r.fellBack).toBe(false);
    expect(r.points.length).toBeLessThan(10);
    expect(r.points.length).toBeGreaterThanOrEqual(4);
  });

  it('开放折线保留首尾端点', () => {
    const pts: Point[] = Array.from({ length: 30 }, (_, i) => ({ x: i * 3, y: Math.sin(i / 4) * 2 }));
    const r = guardedSimplify(pts, false, 2, DEFAULT_GUARD);
    expect(r.points[0]!.x).toBeCloseTo(pts[0]!.x, 6);
    expect(r.points[r.points.length - 1]!.x).toBeCloseTo(pts[pts.length - 1]!.x, 6);
  });
});

describe('包含关系与重叠', () => {
  const outer: Point[] = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 200, y: 200 },
    { x: 0, y: 200 },
  ];
  const inner: Point[] = [
    { x: 50, y: 50 },
    { x: 150, y: 50 },
    { x: 150, y: 150 },
    { x: 50, y: 150 },
  ];
  const separate: Point[] = [
    { x: 300, y: 0 },
    { x: 400, y: 0 },
    { x: 400, y: 100 },
    { x: 300, y: 100 },
  ];

  it('识别包含关系', () => {
    const pairs = extractContainment([inner, outer, separate]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toEqual({ innerIndex: 0, outerIndex: 1 });
  });

  it('包含关系变化被检出', () => {
    const before = extractContainment([inner, outer]);
    const after = extractContainment([separate, outer]);
    expect(containmentChanged(before, after)).toBe(true);
    expect(containmentChanged(before, before)).toBe(false);
  });

  it('包含关系不算重叠', () => {
    const pairs = extractContainment([inner, outer]);
    expect(findOverlaps([inner, outer], pairs)).toHaveLength(0);
  });

  it('部分重叠被检出', () => {
    const crossing: Point[] = [
      { x: 150, y: 150 },
      { x: 300, y: 150 },
      { x: 300, y: 250 },
      { x: 150, y: 250 },
    ];
    const overlaps = findOverlaps([outer, crossing], []);
    expect(overlaps.length).toBeGreaterThan(0);
  });

  it('完全分离不算重叠', () => {
    expect(findOverlaps([outer, separate], [])).toHaveLength(0);
  });
});
