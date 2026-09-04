/**
 * GeometrySimplifier —— 识别产物 → 最终 VectorElement。
 *
 * 职责：
 *   1. 受拓扑守卫保护的 RDP 节点简化；
 *   2. 几何语义择优分类（rect / polygon / line / polyline / path）；
 *   3. 置信度计算与问题标记生成；
 *   4. imgPx → unit 坐标换算（全流程唯一的换算点，经 transform.ts）。
 *
 * 输出的 RecognitionResult 中所有坐标均为地图单位。
 */

import type { ProjectSettings } from '../../types/project';
import type {
  PipelineStats,
  RecognitionIssue,
  RecognitionResult,
} from '../../types/recognition';
import { ALGORITHM_VERSION } from '../../types/recognition';
import type { Bounds, LayerKind, Point, VectorElement } from '../../types/vector';
import { defaultStyle, elementBounds, elementPoints } from '../../types/vector';
import { IdFactory } from '../../lib/id';
import { clamp01 } from '../../lib/precision';
import {
  imgLengthToUnit,
  imgToUnit,
  makeImageToUnit,
  type ImageToUnit,
} from '../geometry/transform';
import { area, bounds, minWidth } from '../geometry/polygon';
import { findSelfIntersections } from '../geometry/intersect';
import type { BinaryImage } from '../preprocess/IPreprocessor';

import type { RawFace, RawPolyline, RawStructure } from '../recognize/StructureRecognizer';
import { classifyClosed, classifyOpen, isBoundaryFace, isBoundaryPolyline, type ClassifiedShape } from '../recognize/classify';
import {
  BinarySupportSampler,
  computeFactors,
  combine,
  LOW_CONFIDENCE_THRESHOLD,
  NeutralSampler,
  VERY_LOW_CONFIDENCE,
  type SupportSampler,
} from '../recognize/confidence';
import { guardedSimplify, type Violation } from '../recognize/topologyGuard';
import type { RecognizeParams } from '../pipeline/params';

export interface SimplifyContext {
  /** 用于笔画支持度采样的二值图；缺省时使用中性采样器。 */
  binary?: BinaryImage;
  /** 已完成的预处理统计，合并进最终 stats。 */
  preprocessTimings?: Record<string, number>;
  foregroundRatio?: number;
  downscale?: number;
  /** ID 工厂（沿用工程内计数器，保证 ID 稳定）。 */
  idFactory?: IdFactory;
}

export class GeometrySimplifier {
  readonly name = 'GeometrySimplifier';

  run(
    raw: RawStructure,
    params: RecognizeParams,
    settings: ProjectSettings,
    ctx: SimplifyContext = {},
  ): RecognitionResult {
    const t = makeImageToUnit(raw.imageWidth, raw.imageHeight, settings);
    const ids = ctx.idFactory ?? new IdFactory();
    const sampler: SupportSampler =
      ctx.binary !== undefined ? new BinarySupportSampler(ctx.binary, Math.max(2, Math.round(raw.strokeWidthPx))) : new NeutralSampler();

    const strokeWidthUnit = imgLengthToUnit(Math.max(1, raw.strokeWidthPx * 0.6), t);
    const imageArea = raw.imageWidth * raw.imageHeight;

    const elements: VectorElement[] = [];
    const issues: RecognitionIssue[] = [];
    let nodesAfter = 0;
    let confidenceSum = 0;
    let blockedCount = 0;

    /* ---------------- 闭合区域 ---------------- */
    // 先处理非孔洞，记录 index → elementId，供孔洞回填 holeOf
    const faceElementIds = new Map<number, string>();
    const orderedFaceIndices = raw.faces
      .map((_, i) => i)
      .sort((a, b) => {
        const fa = raw.faces[a]!;
        const fb = raw.faces[b]!;
        // 非孔洞优先，其次面积大的优先
        if ((fa.holeOfIndex === null) !== (fb.holeOfIndex === null)) {
          return fa.holeOfIndex === null ? -1 : 1;
        }
        return fb.area - fa.area;
      });

    for (const idx of orderedFaceIndices) {
      const face = raw.faces[idx]!;
      const built = this.buildFaceElement(face, idx, {
        params,
        t,
        ids,
        sampler,
        strokeWidthUnit,
        strokeWidthPx: raw.strokeWidthPx,
        imageArea,
        raw,
        faceElementIds,
      });
      if (built === null) continue;

      elements.push(built.element);
      faceElementIds.set(idx, built.element.id);
      nodesAfter += elementPoints(built.element).length;
      confidenceSum += built.element.confidence;
      issues.push(...built.issues);
      if (built.blocked) blockedCount++;
    }

    /* ---------------- 开放折线 ---------------- */
    for (const pl of raw.polylines) {
      const built = this.buildPolylineElement(pl, {
        params,
        t,
        ids,
        sampler,
        strokeWidthUnit,
        strokeWidthPx: raw.strokeWidthPx,
        imageArea,
        raw,
      });
      if (built === null) continue;

      elements.push(built.element);
      nodesAfter += elementPoints(built.element).length;
      confidenceSum += built.element.confidence;
      issues.push(...built.issues);
      if (built.blocked) blockedCount++;
    }

    /* ---------------- 全局问题（识别阶段种子） ---------------- */
    for (const seed of raw.issueSeeds) {
      const at = imgToUnit(seed.at, t);
      issues.push({
        id: ids.nextWith('issue'),
        type: seed.type,
        severity: seed.type === 'brokenLine' ? 'warning' : 'info',
        message: seed.message,
        suggestion:
          seed.type === 'brokenLine'
            ? '在编辑器中用节点工具拖动端点到相邻线条上，或直接删除该悬空线段。'
            : '如结果符合预期可忽略。',
        elementIds: [],
        region: pointRegion(at, imgLengthToUnit(12, t)),
        blocking: false,
      });
    }

    if (blockedCount > 0) {
      issues.push({
        id: ids.nextWith('issue'),
        type: 'simplifyBlocked',
        severity: 'info',
        message: `${blockedCount} 个对象的节点简化被拓扑守卫拦截，已保留更多节点以维持结构正确。`,
        suggestion: '若希望节点更少，可在参数中提高「简化容差」，但需确认细通道未消失。',
        elementIds: [],
        region: null,
        blocking: false,
      });
    }

    if (elements.length === 0) {
      issues.push({
        id: ids.nextWith('issue'),
        type: 'lowConfidence',
        severity: 'error',
        message: '没有生成任何矢量对象。',
        suggestion: '请返回上一步调整预处理参数（降低二值化偏置 / 提高对比度增强），或使用手动绘制。',
        elementIds: [],
        region: null,
        blocking: true,
      });
    }

    const stats: PipelineStats = {
      timings: { ...(ctx.preprocessTimings ?? {}), ...raw.timings },
      workWidth: raw.imageWidth,
      workHeight: raw.imageHeight,
      downscale: ctx.downscale ?? 1,
      branchCount: raw.stats.branchCount,
      segmentCount: raw.stats.segmentCount,
      faceCount: raw.stats.faceCount,
      elementCount: elements.length,
      nodesBeforeSimplify: raw.nodesBeforeSimplify,
      nodesAfterSimplify: nodesAfter,
      averageConfidence: elements.length > 0 ? confidenceSum / elements.length : 0,
      foregroundRatio: ctx.foregroundRatio ?? 0,
    };

    return {
      elements,
      issues,
      stats,
      algorithmVersion: ALGORITHM_VERSION,
      paramsSignature: '',
      createdAt: Date.now(),
    };
  }

  /* ------------------------------------------------------------------ */

  private buildFaceElement(
    face: RawFace,
    faceIndex: number,
    c: BuildContext & { faceElementIds: Map<number, string> },
  ): BuiltElement | null {
    /* 1) 简化（受拓扑守卫保护） */
    const guarded = guardedSimplify(face.points, true, c.params.simplifyEpsilon, c.params.guard);
    if (guarded.points.length < 3) return null;

    /* 2) 分类 */
    const shape = classifyClosed(guarded.points, c.params.classify);
    if (shape.points.length < 3) return null;

    /* 3) 图层判定 */
    const isBoundary = isBoundaryFace(face.area, c.imageArea, face.outermost);
    const isHole = face.holeOfIndex !== null;

    /* 4) 置信度（在 imgPx 空间计算，采样器基于二值图） */
    const factors = computeFactors(
      {
        points: shape.points,
        closed: true,
        fitRmse: face.fitRmse,
        snapDisplacement: face.snapDisplacement,
        alignmentRatio: face.alignmentRatio,
        strokeWidth: c.strokeWidthPx,
        imageArea: c.imageArea,
        hasGap: false,
      },
      c.sampler,
    );
    // 简化被拦截时轻微降低置信度，提示用户此处几何较复杂
    let confidence = combine(factors);
    if (guarded.fellBack) confidence = clamp01(confidence - 0.06);
    if (shape.deviation > 0.05) confidence = clamp01(confidence - shape.deviation * 0.4);

    const layer: LayerKind =
      confidence < LOW_CONFIDENCE_THRESHOLD ? 'review' : isBoundary ? 'boundary' : 'region';

    /* 5) 换算到地图单位 */
    const unitPoints = shape.points.map((p) => imgToUnit(p, c.t));
    const id = c.ids.next(layer, shape.kind);
    const style = defaultStyle(layer, c.strokeWidthUnit);

    const element = buildElement(id, layer, shape, unitPoints, style, confidence);
    if (element === null) return null;

    if (isHole && element.kind === 'closedPath') {
      const hostId = c.faceElementIds.get(face.holeOfIndex!);
      if (hostId !== undefined) element.holeOf = hostId;
    }

    /* 6) 问题标记 */
    const issues: RecognitionIssue[] = [];
    const region = elementBounds(element);

    if (confidence < LOW_CONFIDENCE_THRESHOLD) {
      issues.push({
        id: c.ids.nextWith('issue'),
        type: 'lowConfidence',
        severity: confidence < VERY_LOW_CONFIDENCE ? 'error' : 'warning',
        message: `区域「${id}」置信度 ${(confidence * 100).toFixed(0)}%（笔画支持度 ${(factors.support * 100).toFixed(0)}%）。`,
        suggestion:
          factors.support < 0.6
            ? '该区域附近笔画稀疏，可能是误识别。请对照底图确认后调整或删除。'
            : '请对照底图核对形状与位置。',
        elementIds: [id],
        region,
        blocking: false,
      });
    }

    const selfHits = findSelfIntersections(unitPoints, true, 1);
    if (selfHits.length > 0) {
      issues.push({
        id: c.ids.nextWith('issue'),
        type: 'selfIntersect',
        severity: 'error',
        message: `区域「${id}」存在自相交，导出后填充可能异常。`,
        suggestion: '使用节点工具拖动交叉处的顶点解开自相交。',
        elementIds: [id],
        region,
        blocking: true,
      });
    }

    const mwUnit = imgLengthToUnit(minWidth(shape.points), c.t);
    const passageLimit = imgLengthToUnit(c.params.guard.minPassageWidth * 1.5, c.t);
    if (mwUnit > 0 && mwUnit < passageLimit) {
      issues.push({
        id: c.ids.nextWith('issue'),
        type: 'narrowPassage',
        severity: 'info',
        message: `区域「${id}」最窄处仅 ${mwUnit.toFixed(2)} 单位，属细通道。`,
        suggestion: '简化时已重点保护该区域；如需更少节点请手动调整。',
        elementIds: [id],
        region,
        blocking: false,
      });
    }

    const areaUnit = area(unitPoints);
    const tinyLimit = (imgLengthToUnit(c.strokeWidthPx * 6, c.t)) ** 2;
    if (areaUnit < tinyLimit) {
      issues.push({
        id: c.ids.nextWith('issue'),
        type: 'tinyShape',
        severity: 'warning',
        message: `区域「${id}」面积异常小（${areaUnit.toFixed(3)} 平方单位），可能是噪点。`,
        suggestion: '确认后可直接删除，或提高预处理的「小噪点过滤」阈值重跑。',
        elementIds: [id],
        region,
        blocking: false,
      });
    }

    element.issueIds = issues.map((i) => i.id);
    return { element, issues, blocked: guarded.fellBack, violations: guarded.violations };
  }

  private buildPolylineElement(pl: RawPolyline, c: BuildContext): BuiltElement | null {
    const guarded = guardedSimplify(pl.points, false, c.params.simplifyEpsilon, c.params.guard);
    if (guarded.points.length < 2) return null;

    const shape = classifyOpen(guarded.points, c.params.classify, pl.curved);
    if (shape.points.length < 2) return null;

    const factors = computeFactors(
      {
        points: shape.points,
        closed: false,
        fitRmse: pl.fitRmse,
        snapDisplacement: pl.snapDisplacement,
        alignmentRatio: pl.alignmentRatio,
        strokeWidth: c.strokeWidthPx,
        imageArea: c.imageArea,
        hasGap: pl.hasDanglingEnd,
      },
      c.sampler,
    );
    let confidence = combine(factors);
    if (guarded.fellBack) confidence = clamp01(confidence - 0.06);

    const isBoundary = isBoundaryPolyline(shape.points, c.raw.imageWidth, c.raw.imageHeight);
    const layer: LayerKind =
      confidence < LOW_CONFIDENCE_THRESHOLD ? 'review' : isBoundary ? 'boundary' : 'wall';

    const unitPoints = shape.points.map((p) => imgToUnit(p, c.t));
    const id = c.ids.next(layer, shape.kind);
    const style = defaultStyle(layer, c.strokeWidthUnit);
    const element = buildElement(id, layer, shape, unitPoints, style, confidence);
    if (element === null) return null;

    const issues: RecognitionIssue[] = [];
    const region = elementBounds(element);

    if (pl.hasDanglingEnd) {
      issues.push({
        id: c.ids.nextWith('issue'),
        type: 'brokenLine',
        severity: 'warning',
        message: `线条「${id}」有端点未与其它线条相接。`,
        suggestion: '若该处应闭合，请用节点工具把端点拖到相邻线条上（会自动端点吸附）。',
        elementIds: [id],
        region,
        blocking: false,
      });
    }

    if (confidence < LOW_CONFIDENCE_THRESHOLD) {
      issues.push({
        id: c.ids.nextWith('issue'),
        type: 'lowConfidence',
        severity: confidence < VERY_LOW_CONFIDENCE ? 'error' : 'warning',
        message: `线条「${id}」置信度 ${(confidence * 100).toFixed(0)}%。`,
        suggestion: '请对照底图确认；若为误识别可直接删除。',
        elementIds: [id],
        region,
        blocking: false,
      });
    }

    element.issueIds = issues.map((i) => i.id);
    return { element, issues, blocked: guarded.fellBack, violations: guarded.violations };
  }
}

interface BuildContext {
  params: RecognizeParams;
  t: ImageToUnit;
  ids: IdFactory;
  sampler: SupportSampler;
  strokeWidthUnit: number;
  strokeWidthPx: number;
  imageArea: number;
  raw: RawStructure;
}

interface BuiltElement {
  element: VectorElement;
  issues: RecognitionIssue[];
  blocked: boolean;
  violations: Violation[];
}

/** 根据分类结果构造具体的 VectorElement。 */
function buildElement(
  id: string,
  layer: LayerKind,
  shape: ClassifiedShape,
  unitPoints: Point[],
  style: ReturnType<typeof defaultStyle>,
  confidence: number,
): VectorElement | null {
  const base = {
    id,
    layer,
    confidence,
    issueIds: [] as string[],
    style,
    source: 'auto' as const,
  };

  switch (shape.kind) {
    case 'line': {
      if (unitPoints.length < 2) return null;
      return { ...base, kind: 'line', a: unitPoints[0]!, b: unitPoints[unitPoints.length - 1]! };
    }
    case 'rect': {
      // 由换算后的顶点重建矩形，避免用 imgPx 的 rect 参数直接乘比例（非等比时会错）
      const b = bounds(unitPoints);
      const w = b.maxX - b.minX;
      const h = b.maxY - b.minY;
      if (w <= 0 || h <= 0) return null;
      return { ...base, kind: 'rect', x: b.minX, y: b.minY, w, h };
    }
    case 'polygon': {
      if (unitPoints.length < 3) return null;
      return { ...base, kind: 'polygon', points: unitPoints, regular: shape.regular };
    }
    case 'polyline': {
      if (unitPoints.length < 2) return null;
      return { ...base, kind: 'polyline', points: unitPoints };
    }
    case 'openPath': {
      if (unitPoints.length < 2) return null;
      return { ...base, kind: 'openPath', points: unitPoints };
    }
    case 'closedPath': {
      if (unitPoints.length < 3) return null;
      return { ...base, kind: 'closedPath', points: unitPoints };
    }
  }
}

function pointRegion(p: Point, pad: number): Bounds {
  return { minX: p.x - pad, minY: p.y - pad, maxX: p.x + pad, maxY: p.y + pad };
}

export const geometrySimplifier = new GeometrySimplifier();
