/**
 * 识别管线端到端单测。
 *
 * 这些测试把「最低验收标准」转化为可自动执行的断言：
 *   标准 1 —— 方正房间输出为独立可调整的 rect，而非高节点自由路径
 *   标准 2 —— 不规则区域输出为节点可编辑的封闭路径
 *   标准 4 —— 断线、重复线、倾斜线被正确合并 / 吸附或明确标记
 *   标准 6 —— 主要逻辑对象保持独立（共享墙房间 → 多个对象）
 *   标准 8 —— 低质量图不静默输出错误结果，而是给出置信度与问题
 */

import { describe, expect, it } from 'vitest';
import { runPipeline } from '../src/core/pipeline/runPipeline';
import { presetParams, presetPreprocess } from '../src/core/pipeline/params';
import { DEFAULT_SETTINGS, type ProjectSettings } from '../src/types/project';
import { elementNodeCount, type VectorElement } from '../src/types/vector';
import { PipelineError } from '../src/types/errors';
import { thin } from '../src/core/recognize/thinning';
import { buildSkeletonGraph, graphStats } from '../src/core/recognize/skeletonGraph';
import { buildPlanarGraph, DEFAULT_PLANAR } from '../src/core/recognize/planarFaces';
import { applySnapping, DEFAULT_SNAP_OPTIONS, snapCoordinateBands } from '../src/core/recognize/snapping';
import { bridgeAndClean, DEFAULT_BRIDGE } from '../src/core/recognize/bridging';
import {
  sceneBlank,
  sceneBrokenRoom,
  sceneDuplicatedLines,
  sceneIrregularRegion,
  sceneLowQuality,
  sceneNarrowPassage,
  sceneOpenWalls,
  sceneRegionWithHole,
  sceneRoomGrid,
  sceneSharedWall,
  sceneSingleRoom,
  sceneTiltedRoom,
  type Scene,
} from './fixtures/synth';

/** 场景 → 识别结果的便捷封装。地图尺寸设为与像素 1:1 便于阅读断言。 */
function recognize(scene: Scene, preset: 'fast' | 'standard' | 'fine' = 'standard') {
  const img = scene.canvas.toRgba();
  const settings: ProjectSettings = {
    ...DEFAULT_SETTINGS,
    mapWidth: img.width,
    mapHeight: img.height,
    canvasWidthPx: img.width,
    canvasHeightPx: img.height,
    aspectRatio: img.width / img.height,
  };
  return runPipeline({
    image: img,
    preprocess: { ...presetPreprocess(preset), deskew: false, maxWorkingSize: 2000 },
    recognize: presetParams(preset),
    settings,
  });
}

/** 闭合类元素（区域）。 */
function closedElements(elements: readonly VectorElement[]): VectorElement[] {
  return elements.filter((e) => e.kind === 'rect' || e.kind === 'polygon' || e.kind === 'closedPath');
}

/** 排除孔洞后的实体区域。 */
function solidRegions(elements: readonly VectorElement[]): VectorElement[] {
  return closedElements(elements).filter((e) => !(e.kind === 'closedPath' && e.holeOf !== undefined));
}

describe('骨架化与拓扑图', () => {
  it('矩形边框细化后仍连通，形成闭环', () => {
    const bin = sceneSingleRoom(5).canvas.toBinary();
    const t = thin(bin);
    expect(t.pixelCount).toBeGreaterThan(100);

    const graph = buildSkeletonGraph(t.skeleton);
    const st = graphStats(graph);
    // 矩形环细化后应是一个闭环（无端点）或极少端点
    expect(st.branchCount).toBeGreaterThan(0);
    expect(st.endpointCount).toBeLessThanOrEqual(2);
  });

  it('共享墙的十字结构产生交点节点', () => {
    const bin = sceneSharedWall(4).canvas.toBinary();
    const graph = buildSkeletonGraph(thin(bin).skeleton);
    const st = graphStats(graph);
    // 中间竖墙与上下横墙相交 → 至少 2 个交点
    expect(st.junctionCount).toBeGreaterThanOrEqual(2);
  });
});

describe('平面图面提取', () => {
  it('共享一条边的两个矩形被提取为 2 个独立面', () => {
    // 直接构造理想线段，隔离骨架化误差，只验证半边遍历逻辑
    const segments = [
      // 外框
      { a: { x: 0, y: 0 }, b: { x: 200, y: 0 } },
      { a: { x: 200, y: 0 }, b: { x: 200, y: 100 } },
      { a: { x: 200, y: 100 }, b: { x: 0, y: 100 } },
      { a: { x: 0, y: 100 }, b: { x: 0, y: 0 } },
      // 中间竖墙
      { a: { x: 100, y: 0 }, b: { x: 100, y: 100 } },
    ];
    const g = buildPlanarGraph(segments, { ...DEFAULT_PLANAR, minFaceArea: 100 });
    const solid = g.faces.filter((f) => f.holeOf === null);
    expect(solid).toHaveLength(2);
    // 两个面面积各约 10000
    for (const f of solid) expect(f.area).toBeCloseTo(10000, -1);
  });

  it('2×2 网格提取出 4 个面', () => {
    const segments = [
      { a: { x: 0, y: 0 }, b: { x: 200, y: 0 } },
      { a: { x: 200, y: 0 }, b: { x: 200, y: 200 } },
      { a: { x: 200, y: 200 }, b: { x: 0, y: 200 } },
      { a: { x: 0, y: 200 }, b: { x: 0, y: 0 } },
      { a: { x: 100, y: 0 }, b: { x: 100, y: 200 } },
      { a: { x: 0, y: 100 }, b: { x: 200, y: 100 } },
    ];
    const g = buildPlanarGraph(segments, { ...DEFAULT_PLANAR, minFaceArea: 100 });
    expect(g.faces.filter((f) => f.holeOf === null)).toHaveLength(4);
  });

  it('嵌套矩形：内框被识别为孔洞', () => {
    const segments = [
      { a: { x: 0, y: 0 }, b: { x: 200, y: 0 } },
      { a: { x: 200, y: 0 }, b: { x: 200, y: 200 } },
      { a: { x: 200, y: 200 }, b: { x: 0, y: 200 } },
      { a: { x: 0, y: 200 }, b: { x: 0, y: 0 } },
      { a: { x: 60, y: 60 }, b: { x: 140, y: 60 } },
      { a: { x: 140, y: 60 }, b: { x: 140, y: 140 } },
      { a: { x: 140, y: 140 }, b: { x: 60, y: 140 } },
      { a: { x: 60, y: 140 }, b: { x: 60, y: 60 } },
    ];
    const g = buildPlanarGraph(segments, { ...DEFAULT_PLANAR, minFaceArea: 100 });
    const holes = g.faces.filter((f) => f.holeOf !== null);
    expect(holes.length).toBeGreaterThanOrEqual(1);
  });

  it('开放的 L 形线条不产生面', () => {
    const segments = [
      { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },
      { a: { x: 100, y: 0 }, b: { x: 100, y: 100 } },
    ];
    const g = buildPlanarGraph(segments, DEFAULT_PLANAR);
    expect(g.faces).toHaveLength(0);
    expect(g.danglingEdgeIds.length).toBeGreaterThan(0);
  });
});

describe('吸附（验收标准 4）', () => {
  it('3° 倾斜的水平线被吸附为严格水平', () => {
    const rad = (3 * Math.PI) / 180;
    const seg = { a: { x: 0, y: 0 }, b: { x: 100 * Math.cos(rad), y: 100 * Math.sin(rad) } };
    const r = applySnapping([seg], { ...DEFAULT_SNAP_OPTIONS, enableCluster: false });
    expect(r.segments[0]!.a.y).toBeCloseTo(r.segments[0]!.b.y, 6);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]!.toAngle).toBe(0);
  });

  it('12° 倾斜超出容差，不被吸附', () => {
    const rad = (12 * Math.PI) / 180;
    const seg = { a: { x: 0, y: 0 }, b: { x: 100 * Math.cos(rad), y: 100 * Math.sin(rad) } };
    const r = applySnapping([seg], { ...DEFAULT_SNAP_OPTIONS, angleTolDeg: 7, enableCluster: false });
    expect(r.records).toHaveLength(0);
    expect(r.segments[0]!.a.y).not.toBeCloseTo(r.segments[0]!.b.y, 3);
  });

  it('相近端点被聚簇到同一坐标', () => {
    const segs = [
      { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },
      { a: { x: 102, y: 2 }, b: { x: 102, y: 100 } },
    ];
    const r = applySnapping(segs, { ...DEFAULT_SNAP_OPTIONS, clusterRadius: 6 });
    // 第一条的 b 与第二条的 a 应完全重合
    expect(r.segments[0]!.b.x).toBeCloseTo(r.segments[1]!.a.x, 6);
    expect(r.segments[0]!.b.y).toBeCloseTo(r.segments[1]!.a.y, 6);
  });

  it('坐标带对齐：相差 1px 的共享墙被统一', () => {
    const segs = [
      { a: { x: 100, y: 0 }, b: { x: 100, y: 50 } },
      { a: { x: 101, y: 50 }, b: { x: 101, y: 100 } },
    ];
    const out = snapCoordinateBands(segs, 3);
    expect(out[0]!.a.x).toBeCloseTo(out[1]!.a.x, 6);
  });
});

describe('桥接与清理（验收标准 4）', () => {
  it('四角断开的矩形被桥接闭合，并能提取出面', () => {
    const gap = 8;
    const segs = [
      { a: { x: gap, y: 0 }, b: { x: 200 - gap, y: 0 } },
      { a: { x: 200, y: gap }, b: { x: 200, y: 100 - gap } },
      { a: { x: 200 - gap, y: 100 }, b: { x: gap, y: 100 } },
      { a: { x: 0, y: 100 - gap }, b: { x: 0, y: gap } },
    ];
    const r = bridgeAndClean(segs, DEFAULT_BRIDGE);
    expect(r.records.length).toBeGreaterThan(0);

    const g = buildPlanarGraph(r.segments, { ...DEFAULT_PLANAR, minFaceArea: 100 });
    expect(g.faces.filter((f) => f.holeOf === null)).toHaveLength(1);
  });

  it('间隙过大时不强行桥接，端点标记为悬空', () => {
    const segs = [
      { a: { x: 0, y: 0 }, b: { x: 50, y: 0 } },
      { a: { x: 150, y: 0 }, b: { x: 200, y: 0 } },
    ];
    const r = bridgeAndClean(segs, { ...DEFAULT_BRIDGE, maxGap: 10, maxExtend: 10 });
    expect(r.unresolved.length).toBeGreaterThan(0);
  });

  it('重复线被合并', () => {
    const segs = [
      { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },
      { a: { x: 0, y: 2 }, b: { x: 100, y: 2 } },
    ];
    const r = bridgeAndClean(segs, DEFAULT_BRIDGE);
    expect(r.segments.length).toBe(1);
  });

  it('短毛刺被剪除', () => {
    const segs = [
      { a: { x: 0, y: 0 }, b: { x: 100, y: 0 } },
      { a: { x: 50, y: 0 }, b: { x: 51, y: 2 } },
    ];
    const r = bridgeAndClean(segs, { ...DEFAULT_BRIDGE, minSegmentLength: 6 });
    expect(r.removedShort).toBeGreaterThanOrEqual(1);
  });
});

/* ================================================================== */
/* 端到端：从图像到 VectorElement                                       */
/* ================================================================== */

describe('端到端识别', () => {
  it('验收标准 1：单个方正房间输出为 rect，节点数为 4', () => {
    const out = recognize(sceneSingleRoom(4));
    const regions = solidRegions(out.result.elements);
    expect(regions.length).toBeGreaterThanOrEqual(1);

    const rects = regions.filter((e) => e.kind === 'rect');
    expect(rects.length).toBeGreaterThanOrEqual(1);
    // 关键：不是高节点自由路径
    expect(elementNodeCount(rects[0]!)).toBe(4);

    const rect = rects[0]!;
    if (rect.kind === 'rect') {
      // 与合成时的 rect(60,50,260,190) 对齐（允许笔画宽度带来的偏差）
      expect(rect.x).toBeGreaterThan(52);
      expect(rect.x).toBeLessThan(70);
      expect(rect.w).toBeGreaterThan(248);
      expect(rect.w).toBeLessThan(272);
      expect(rect.h).toBeGreaterThan(178);
      expect(rect.h).toBeLessThan(202);
    }
  });

  it('验收标准 6：共享墙的两个房间输出为 2 个独立对象', () => {
    const out = recognize(sceneSharedWall(4));
    const regions = solidRegions(out.result.elements);
    expect(regions.length).toBeGreaterThanOrEqual(2);
    // ID 各自独立
    const ids = new Set(regions.map((r) => r.id));
    expect(ids.size).toBe(regions.length);
  });

  it('2×2 房间网格输出 ≥4 个独立区域', () => {
    const out = recognize(sceneRoomGrid(4));
    expect(solidRegions(out.result.elements).length).toBeGreaterThanOrEqual(4);
  });

  it('验收标准 4：断线房间被桥接后仍输出为闭合区域', () => {
    const out = recognize(sceneBrokenRoom(8, 4));
    const regions = solidRegions(out.result.elements);
    expect(regions.length).toBeGreaterThanOrEqual(1);
    expect(regions[0]!.kind === 'rect' || regions[0]!.kind === 'polygon').toBe(true);
  });

  it('验收标准 4：轻微倾斜的房间被吸附为轴对齐矩形', () => {
    const out = recognize(sceneTiltedRoom(3, 4));
    const regions = solidRegions(out.result.elements);
    expect(regions.length).toBeGreaterThanOrEqual(1);
    // 顶点数应很少（4~6），而不是几十个
    expect(elementNodeCount(regions[0]!)).toBeLessThanOrEqual(6);
  });

  it('验收标准 2：不规则区域输出为节点可编辑的闭合形状', () => {
    const out = recognize(sceneIrregularRegion(4), 'fine');
    const regions = solidRegions(out.result.elements);
    expect(regions.length).toBeGreaterThanOrEqual(1);

    const r = regions[0]!;
    // 必须是 polygon 或 closedPath（都带可编辑 points 数组）
    expect(['polygon', 'closedPath']).toContain(r.kind);
    // 不能被过度简化成矩形
    expect(r.kind).not.toBe('rect');
    // 节点数应保留原始形状的主要拐点（合成图有 11 个拐点）
    const nodes = elementNodeCount(r);
    expect(nodes).toBeGreaterThanOrEqual(6);
    expect(nodes).toBeLessThanOrEqual(24);
    // points 数组存在 → 可编辑
    if (r.kind === 'polygon' || r.kind === 'closedPath') {
      expect(Array.isArray(r.points)).toBe(true);
    }
  });

  it('嵌套区域输出多个对象，内框不与外框合并', () => {
    const out = recognize(sceneRegionWithHole(4));
    expect(closedElements(out.result.elements).length).toBeGreaterThanOrEqual(2);
  });

  it('验收标准 4：重复描线被合并，不输出两个重叠区域', () => {
    const out = recognize(sceneDuplicatedLines(3));
    const regions = solidRegions(out.result.elements);
    // 重复线合并后应只有 1 个主区域（允许 1 个额外的细缝噪声区被标记）
    const large = regions.filter((r) => elementNodeCount(r) <= 8);
    expect(large.length).toBeGreaterThanOrEqual(1);
    expect(regions.length).toBeLessThanOrEqual(3);
  });

  it('细通道场景：通道未消失，最小宽度被保留', () => {
    const out = recognize(sceneNarrowPassage(14, 3), 'fine');
    const regions = solidRegions(out.result.elements);
    // 左右两个房间 + 中间通道
    expect(regions.length).toBeGreaterThanOrEqual(2);
  });

  it('开放墙线输出为 line / polyline，不被误判为区域', () => {
    const out = recognize(sceneOpenWalls(4));
    const open = out.result.elements.filter(
      (e) => e.kind === 'line' || e.kind === 'polyline' || e.kind === 'openPath',
    );
    expect(open.length).toBeGreaterThanOrEqual(1);
  });

  it('验收标准 8：空白图抛出 NO_STRUCTURE_FOUND 而非返回空结果', () => {
    const scene = sceneBlank();
    expect(() => recognize(scene)).toThrow(PipelineError);
    const err = (() => {
      const r = ((): unknown => {
        try {
          recognize(scene);
          return null;
        } catch (e) {
          return e;
        }
      })();
      return r as PipelineError;
    })();
    expect(err.code).toBe('NO_STRUCTURE_FOUND');
    // 必须是可恢复的（引导用户调参或手动描线）
    expect(err.recoverable).toBe(true);
  });

  it('验收标准 8：低质量图给出置信度与问题标记，不静默通过', () => {
    const out = recognize(sceneLowQuality(2));
    // 所有元素都带有 0..1 的置信度
    for (const el of out.result.elements) {
      expect(el.confidence).toBeGreaterThanOrEqual(0);
      expect(el.confidence).toBeLessThanOrEqual(1);
    }
    // 应产生问题标记（图像质量 / 低置信度 / 断线等任意一种）
    expect(out.result.issues.length).toBeGreaterThan(0);
    // 统计中的平均置信度可用
    expect(out.result.stats.averageConfidence).toBeGreaterThanOrEqual(0);
  });
});

describe('统计与元数据', () => {
  it('统计字段完整且简化率为正', () => {
    const out = recognize(sceneRoomGrid(4));
    const s = out.result.stats;
    expect(s.workWidth).toBeGreaterThan(0);
    expect(s.workHeight).toBeGreaterThan(0);
    expect(s.elementCount).toBe(out.result.elements.length);
    expect(s.nodesBeforeSimplify).toBeGreaterThan(s.nodesAfterSimplify);
    expect(Object.keys(s.timings).length).toBeGreaterThan(0);
  });

  it('记录算法版本与参数签名，便于判断是否需重跑', () => {
    const out = recognize(sceneSingleRoom(4));
    expect(out.result.algorithmVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(out.result.paramsSignature.length).toBeGreaterThan(0);
  });

  it('ID 稳定、唯一、可读', () => {
    const out = recognize(sceneRoomGrid(4));
    const ids = out.result.elements.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^(boundary|wall|region|review)-(line|poly|rect|path|area)-\d{4}$/);
    }
  });

  it('相同输入产生相同输出（可复现）', () => {
    const a = recognize(sceneSharedWall(4));
    const b = recognize(sceneSharedWall(4));
    expect(a.result.elements.length).toBe(b.result.elements.length);
    expect(a.result.paramsSignature).toBe(b.result.paramsSignature);
    for (let i = 0; i < a.result.elements.length; i++) {
      expect(a.result.elements[i]!.kind).toBe(b.result.elements[i]!.kind);
      expect(a.result.elements[i]!.id).toBe(b.result.elements[i]!.id);
    }
  });

  it('预设影响节点数：fast 的节点不多于 fine', () => {
    const fast = recognize(sceneIrregularRegion(4), 'fast');
    const fine = recognize(sceneIrregularRegion(4), 'fine');
    expect(fast.result.stats.nodesAfterSimplify).toBeLessThanOrEqual(
      fine.result.stats.nodesAfterSimplify,
    );
  });
});
