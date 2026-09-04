/**
 * StructureRecognizer —— 识别流程编排。
 *
 * 输入：二值图（imgPx 空间）+ RecognizeParams
 * 输出：RawStructure（imgPx 空间的几何 + 问题标记 + 统计）
 *
 * 本模块不做坐标换算，也不生成最终 VectorElement，
 * 那是 GeometrySimplifier 的职责（唯一的 imgPx → unit 换算点）。
 */

import { PipelineError } from '../../types/errors';
import type { BinaryImage } from '../preprocess/IPreprocessor';
import { estimateStrokeWidth } from '../preprocess/morphology';
import type { Point } from '../../types/vector';
import type { Segment } from '../geometry/lineFit';
import { polylineToSegments, segLength } from '../geometry/lineFit';
import { bounds } from '../geometry/polygon';
import { Stopwatch } from '../../lib/logger';

import { pruneRedundant, thin } from './thinning';
import { buildSkeletonGraph, graphStats, pruneSpurs } from './skeletonGraph';
import { branchToSegments, fitBranch, type FittedBranch } from './segmentFit';
import { applySnapping, snapCoordinateBands } from './snapping';
import { bridgeAndClean, type BridgeResult } from './bridging';
import { buildPlanarGraph, extractOpenPolylines, type PlanarFace } from './planarFaces';
import { traceSolidRegions, type TracedContour } from './contourTrace';
import { alignmentScore } from './classify';
import type { RecognizeParams } from '../pipeline/params';
import { scaleParamsByStroke, stageProgress, type StageName } from '../pipeline/params';

/** 识别产物：仍在图像像素空间。 */
export interface RawFace {
  points: Point[];
  /** 是否为孔洞，及其宿主在 faces 数组中的索引。 */
  holeOfIndex: number | null;
  /** 是否为最外层（无宿主且面积最大）。 */
  outermost: boolean;
  area: number;
  /** 拟合残差聚合值，供置信度使用。 */
  fitRmse: number;
  /** 吸附位移聚合值。 */
  snapDisplacement: number;
  alignmentRatio: number;
  /** 是否来自实心块轮廓追踪（降级路径）。 */
  fromContour: boolean;
}

export interface RawPolyline {
  points: Point[];
  closed: boolean;
  curved: boolean;
  fitRmse: number;
  snapDisplacement: number;
  alignmentRatio: number;
  /** 端点是否悬空（用于 brokenLine 标记）。 */
  hasDanglingEnd: boolean;
}

export interface RawIssueSeed {
  type: 'brokenLine' | 'duplicateLine' | 'narrowPassage' | 'selfIntersect' | 'tinyShape';
  at: Point;
  metric: number;
  message: string;
}

export interface RawStructure {
  faces: RawFace[];
  polylines: RawPolyline[];
  issueSeeds: RawIssueSeed[];
  /** 估计的笔画宽度（像素），后续换算 strokeWidth 使用。 */
  strokeWidthPx: number;
  imageWidth: number;
  imageHeight: number;
  /** 简化前的总节点数。 */
  nodesBeforeSimplify: number;
  stats: {
    branchCount: number;
    segmentCount: number;
    faceCount: number;
    holeCount: number;
    bridgedCount: number;
    removedShort: number;
    removedDuplicate: number;
    snapCount: number;
    contourRegions: number;
  };
  timings: Record<string, number>;
  /** 实际使用的（已按笔画宽度缩放的）参数，便于复现。 */
  effectiveParams: RecognizeParams;
}

export type ProgressFn = (progress: number, stage: StageName, detail?: string) => void;

export interface RecognizeContext {
  /** 取消检查：返回 true 时立即抛出 CANCELLED。 */
  isCancelled?: () => boolean;
  onProgress?: ProgressFn;
}

export class StructureRecognizer {
  readonly name = 'StructureRecognizer';

  run(binary: BinaryImage, params: RecognizeParams, ctx: RecognizeContext = {}): RawStructure {
    const sw = new Stopwatch();
    const check = (): void => {
      if (ctx.isCancelled?.() === true) throw new PipelineError('CANCELLED', undefined, false);
    };
    const report = (stage: StageName, within: number, detail?: string): void => {
      ctx.onProgress?.(stageProgress(stage, within), stage, detail);
    };

    if (binary.width <= 0 || binary.height <= 0) {
      throw new PipelineError('NO_STRUCTURE_FOUND', { reason: 'emptyImage' }, false);
    }

    /* 0) 估计笔画宽度并缩放全部阈值 */
    const strokeWidthPx = estimateStrokeWidth(binary);
    const p = scaleParamsByStroke(params, strokeWidthPx);
    check();

    /* 1) 实心填充块检测（降级路径，先做以便从骨架路径中排除） */
    let contours: TracedContour[] = [];
    if (p.enableContourFallback) {
      contours = traceSolidRegions(binary, p.contour);
    }
    sw.mark('contour');
    check();

    /* 2) 骨架化 */
    report('thinning', 0.1, '细化笔画');
    const thinResult = thin(binary);
    if (thinResult.pixelCount < 20) {
      throw new PipelineError(
        'NO_STRUCTURE_FOUND',
        { skeletonPixels: thinResult.pixelCount },
        true,
      );
    }
    const skeleton = pruneRedundant(thinResult.skeleton);
    sw.mark('thinning');
    report('thinning', 1);
    check();

    /* 3) 骨架拓扑图 */
    report('graph', 0.3, '构建结构图');
    let graph = buildSkeletonGraph(skeleton);
    graph = pruneSpurs(graph, p.spurLength);
    const gStats = graphStats(graph);
    sw.mark('graph');
    report('graph', 1);
    check();

    if (gStats.branchCount === 0) {
      throw new PipelineError('NO_STRUCTURE_FOUND', { branches: 0 }, true);
    }
    // 分支数异常多说明噪声未清干净
    if (gStats.branchCount > 8000) {
      throw new PipelineError('TOO_NOISY', { branches: gStats.branchCount }, true);
    }

    /* 4) 逐分支拟合 */
    report('fit', 0.1, `拟合 ${gStats.branchCount} 条分支`);
    const fitted: FittedBranch[] = [];
    graph.branches.forEach((b, i) => {
      if (i % 64 === 0) {
        check();
        report('fit', i / Math.max(1, graph.branches.length));
      }
      fitted.push(fitBranch(b, p.fit));
    });
    sw.mark('fit');
    report('fit', 1);

    let nodesBeforeSimplify = 0;
    for (const f of fitted) nodesBeforeSimplify += f.originalPointCount;

    /* 5) 展开为线段集合 */
    const segments: Segment[] = [];
    const segmentOwner: number[] = [];
    fitted.forEach((fb, idx) => {
      for (const s of branchToSegments(fb, p.fit.minSegmentLength)) {
        segments.push(s);
        segmentOwner.push(idx);
      }
    });

    if (segments.length === 0) {
      throw new PipelineError('NO_STRUCTURE_FOUND', { segments: 0 }, true);
    }
    check();

    /* 6) 吸附 */
    report('snap', 0.2, `吸附 ${segments.length} 条线段`);
    const snapped = applySnapping(segments, p.snap);
    // 坐标带对齐：让跨房间的共享墙落在同一坐标上（rect 输出的前提）
    const banded = snapCoordinateBands(snapped.segments, p.planar.vertexTolerance * 1.4);
    sw.mark('snap');
    check();

    /* 7) 桥接与清理 */
    report('snap', 0.7, '连接断线');
    const bridged: BridgeResult = bridgeAndClean(banded, p.bridge);
    sw.mark('bridge');
    report('snap', 1);
    check();

    /* 8) 平面图面提取 */
    report('faces', 0.2, '提取封闭区域');
    const planar = buildPlanarGraph(bridged.segments, p.planar);
    sw.mark('faces');
    check();

    /* 9) 组装 faces */
    const imageArea = binary.width * binary.height;
    const snapDisplacementAvg = averageDisplacement(snapped.records);
    const faces = assembleFaces(planar.faces, {
      snapDisplacement: snapDisplacementAvg,
      angleSteps: p.snap.angleSteps,
      angleTolDeg: p.snap.angleTolDeg,
    });

    /* 10) 追加实心块轮廓（降级路径产物） */
    let contourRegions = 0;
    for (const c of contours) {
      // 若该区域已被平面图覆盖（包围盒高度重合）则跳过，避免重复
      if (isCoveredByFaces(c.outer, faces)) continue;
      faces.push({
        points: c.outer.map((pt) => ({ ...pt })),
        holeOfIndex: null,
        outermost: false,
        area: polygonAreaOf(c.outer),
        fitRmse: 0,
        snapDisplacement: 0,
        alignmentRatio: alignmentScore(c.outer, p.snap.angleSteps, p.snap.angleTolDeg),
        fromContour: true,
      });
      const hostIndex = faces.length - 1;
      for (const hole of c.holes) {
        faces.push({
          points: hole.map((pt) => ({ ...pt })),
          holeOfIndex: hostIndex,
          outermost: false,
          area: polygonAreaOf(hole),
          fitRmse: 0,
          snapDisplacement: 0,
          alignmentRatio: 0,
          fromContour: true,
        });
      }
      contourRegions++;
      nodesBeforeSimplify += c.outer.length;
    }

    /* 11) 未成面的边 → 开放折线（墙线 / 分隔线） */
    report('classify', 0.4, '整理开放线条');
    const openChains = extractOpenPolylines(planar);
    const danglingSet = new Set(bridged.unresolved.map((u) => keyOfPoint(u.point)));
    const polylines: RawPolyline[] = [];

    for (const chain of openChains) {
      if (chain.length < 2) continue;
      const totalLen = polylineToSegments(chain, false).reduce((s, seg) => s + segLength(seg), 0);
      if (totalLen < p.bridge.minSegmentLength * 1.5) continue;
      const hasDangling =
        danglingSet.has(keyOfPoint(chain[0]!)) || danglingSet.has(keyOfPoint(chain[chain.length - 1]!));
      polylines.push({
        points: chain.map((pt) => ({ ...pt })),
        closed: false,
        curved: isCurvedChain(chain, fitted),
        fitRmse: averageRmse(fitted),
        snapDisplacement: snapDisplacementAvg,
        alignmentRatio: alignmentScore(chain, p.snap.angleSteps, p.snap.angleTolDeg),
        hasDanglingEnd: hasDangling,
      });
    }
    sw.mark('assemble');

    /* 12) 问题种子 */
    const issueSeeds: RawIssueSeed[] = [];
    for (const u of bridged.unresolved) {
      issueSeeds.push({
        type: 'brokenLine',
        at: u.point,
        metric: u.nearestDistance,
        message: `端点悬空，距最近线条 ${u.nearestDistance.toFixed(1)} 像素，未能自动连接。`,
      });
    }
    if (bridged.removedDuplicate > 0) {
      issueSeeds.push({
        type: 'duplicateLine',
        at: { x: binary.width / 2, y: 0 },
        metric: bridged.removedDuplicate,
        message: `已自动合并 ${bridged.removedDuplicate} 条重复 / 重叠线。`,
      });
    }

    /* 13) 总量保护 */
    const totalElements = faces.length + polylines.length;
    if (totalElements > p.maxElements) {
      throw new PipelineError(
        'TOO_MANY_ELEMENTS',
        { count: totalElements, limit: p.maxElements },
        true,
      );
    }

    report('classify', 1);

    return {
      faces,
      polylines,
      issueSeeds,
      strokeWidthPx,
      imageWidth: binary.width,
      imageHeight: binary.height,
      nodesBeforeSimplify,
      stats: {
        branchCount: gStats.branchCount,
        segmentCount: bridged.segments.length,
        faceCount: faces.filter((f) => f.holeOfIndex === null).length,
        holeCount: faces.filter((f) => f.holeOfIndex !== null).length,
        bridgedCount: bridged.records.length,
        removedShort: bridged.removedShort,
        removedDuplicate: bridged.removedDuplicate,
        snapCount: snapped.records.length,
        contourRegions,
      },
      timings: sw.timings(),
      effectiveParams: p,
    };
  }
}

interface AssembleContext {
  snapDisplacement: number;
  angleSteps: number[];
  angleTolDeg: number;
}

function assembleFaces(planarFaces: readonly PlanarFace[], ctx: AssembleContext): RawFace[] {
  if (planarFaces.length === 0) return [];

  // 找最大面（候选地图边界）
  let maxArea = -1;
  let maxIndex = -1;
  planarFaces.forEach((f, i) => {
    if (f.holeOf === null && f.area > maxArea) {
      maxArea = f.area;
      maxIndex = i;
    }
  });

  // 建立 planar face id → 数组索引的映射
  const idToIndex = new Map<number, number>();
  planarFaces.forEach((f, i) => idToIndex.set(f.id, i));

  return planarFaces.map((f, i) => ({
    points: f.points.map((p) => ({ ...p })),
    holeOfIndex: f.holeOf === null ? null : (idToIndex.get(f.holeOf) ?? null),
    outermost: i === maxIndex,
    area: f.area,
    fitRmse: 0,
    snapDisplacement: ctx.snapDisplacement,
    alignmentRatio: alignmentScore(f.points, ctx.angleSteps, ctx.angleTolDeg),
    fromContour: false,
  }));
}

function averageDisplacement(records: ReadonlyArray<{ displacement: number }>): number {
  if (records.length === 0) return 0;
  let s = 0;
  for (const r of records) s += r.displacement;
  return s / records.length;
}

function averageRmse(fitted: readonly FittedBranch[]): number {
  if (fitted.length === 0) return 0;
  let s = 0;
  let n = 0;
  for (const f of fitted) {
    if (f.segmentRmse.length === 0) continue;
    for (const r of f.segmentRmse) {
      s += r;
      n++;
    }
  }
  return n > 0 ? s / n : 0;
}

/** 判断折线是否落在被标记为曲线的分支上（近似：任一 curved 分支即视为曲线）。 */
function isCurvedChain(chain: readonly Point[], fitted: readonly FittedBranch[]): boolean {
  if (chain.length <= 3) return false;
  // 节点密集且分布不规则 → 曲线
  let curvedBranches = 0;
  for (const f of fitted) if (f.curved) curvedBranches++;
  return curvedBranches > 0 && chain.length > 8;
}

function polygonAreaOf(pts: readonly Point[]): number {
  const n = pts.length;
  if (n < 3) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % n]!;
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s / 2);
}

function isCoveredByFaces(contour: readonly Point[], faces: readonly RawFace[]): boolean {
  const cb = bounds(contour);
  const cArea = (cb.maxX - cb.minX) * (cb.maxY - cb.minY);
  if (cArea <= 0) return false;
  for (const f of faces) {
    if (f.holeOfIndex !== null) continue;
    const fb = bounds(f.points);
    const ix = Math.max(0, Math.min(cb.maxX, fb.maxX) - Math.max(cb.minX, fb.minX));
    const iy = Math.max(0, Math.min(cb.maxY, fb.maxY) - Math.max(cb.minY, fb.minY));
    const inter = ix * iy;
    if (inter / cArea > 0.8) return true;
  }
  return false;
}

function keyOfPoint(p: Point): string {
  return `${Math.round(p.x * 2)},${Math.round(p.y * 2)}`;
}

export const structureRecognizer = new StructureRecognizer();
