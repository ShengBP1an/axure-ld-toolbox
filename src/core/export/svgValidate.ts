/**
 * 导出前预检。
 *
 * 目标（Prompt 3.5 与最低验收标准 8）：
 * 不让明显错误的结果静默进入 Axure。
 * 致命项（非法坐标 / 退化图形 / 自相交 / 空导出）阻止导出；
 * 其余作为警告提示，用户可确认后继续。
 */

import type { ExportSettings, PreflightItem, PreflightReport } from '../../types/export';
import type { ProjectSettings } from '../../types/project';
import type { Bounds, VectorElement } from '../../types/vector';
import { elementBounds, elementPoints, isClosedKind } from '../../types/vector';
import { area, perimeter } from '../geometry/polygon';
import { findSelfIntersections } from '../geometry/intersect';
import { canvasBoundsInUnit } from '../geometry/transform';

/** 面积小于此比例（相对画布）的闭合图形视为异常小。 */
const TINY_AREA_RATIO = 2e-5;
/** 长度小于此比例（相对画布对角线）的开放图形视为异常小。 */
const TINY_LENGTH_RATIO = 0.004;
/** 建议的对象数量上限。 */
export const RECOMMENDED_MAX_ELEMENTS = 2000;

let seq = 0;
function nextId(): string {
  seq += 1;
  return `pf-${seq}`;
}

export function preflight(
  elements: readonly VectorElement[],
  settings: ProjectSettings,
  exportSettings: ExportSettings,
): PreflightReport {
  const items: PreflightItem[] = [];
  const canvas = canvasBoundsInUnit(settings);
  const canvasArea = Math.max(1e-9, settings.mapWidth * settings.mapHeight);
  const diagonal = Math.hypot(settings.mapWidth, settings.mapHeight);

  // 只检查将被导出的图层
  const exported = elements.filter(
    (el) => exportSettings.layers[el.layer] !== false && el.hidden !== true,
  );

  if (exported.length === 0) {
    items.push({
      id: nextId(),
      code: 'emptyExport',
      severity: 'error',
      message: '没有可导出的对象。请检查图层是否被全部关闭，或先完成识别。',
      elementIds: [],
      region: null,
      blocking: true,
    });
    return finalize(items, 0);
  }

  if (exported.length > RECOMMENDED_MAX_ELEMENTS) {
    items.push({
      id: nextId(),
      code: 'tooManyElements',
      severity: 'warning',
      message: `共 ${exported.length} 个对象，超过建议上限 ${RECOMMENDED_MAX_ELEMENTS}。Axure 中可能出现明显卡顿。`,
      elementIds: [],
      region: null,
      blocking: false,
    });
  }

  const invalidIds: string[] = [];
  const degenerateIds: string[] = [];
  const outOfCanvasIds: string[] = [];
  const tinyIds: string[] = [];
  const openRegionIds: string[] = [];
  const selfIntersectIds: string[] = [];

  let outRegion: Bounds | null = null;
  let tinyRegion: Bounds | null = null;
  let openRegion: Bounds | null = null;
  let siRegion: Bounds | null = null;

  for (const el of exported) {
    const pts = elementPoints(el);

    /* 1) 非法坐标 */
    let hasInvalid = false;
    for (const p of pts) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        hasInvalid = true;
        break;
      }
    }
    if (hasInvalid || !Number.isFinite(el.style.strokeWidth)) {
      invalidIds.push(el.id);
      continue; // 坐标非法时其余检查无意义
    }

    const closed = isClosedKind(el.kind);
    const b = elementBounds(el);

    /* 2) 自相交（必须在退化判定之前）
     *
     * 原因：对称的"蝴蝶结"多边形其 shoelace 净面积为 0，
     * 若先做退化判定就会被归为「零面积」，掩盖了真正的问题。
     * 自相交是更准确、更可操作的诊断，应优先报告。 */
    if (closed && pts.length >= 3) {
      const hits = findSelfIntersections(pts, true, 1);
      if (hits.length > 0) {
        selfIntersectIds.push(el.id);
        siRegion = siRegion === null ? b : unionOf(siRegion, b);
        continue;
      }
    }

    /* 3) 退化图形 */
    const degenerate = closed
      ? pts.length < 3 || area(pts) <= 1e-12
      : pts.length < 2 || perimeter(pts, false) <= 1e-9;
    if (degenerate) {
      degenerateIds.push(el.id);
      continue;
    }

    /* 4) 越界 */
    const outside =
      b.minX < canvas.minX - 1e-6 ||
      b.minY < canvas.minY - 1e-6 ||
      b.maxX > canvas.maxX + 1e-6 ||
      b.maxY > canvas.maxY + 1e-6;
    if (outside) {
      outOfCanvasIds.push(el.id);
      outRegion = outRegion === null ? b : unionOf(outRegion, b);
    }

    /* 5) 异常小 */
    const tiny = closed
      ? area(pts) / canvasArea < TINY_AREA_RATIO
      : perimeter(pts, false) / Math.max(diagonal, 1e-9) < TINY_LENGTH_RATIO;
    if (tiny) {
      tinyIds.push(el.id);
      tinyRegion = tinyRegion === null ? b : unionOf(tinyRegion, b);
    }

    /* 6) 未闭合的"区域" —— region 图层却是开放路径，导出后无法填充 */
    if (el.layer === 'region' && !closed) {
      openRegionIds.push(el.id);
      openRegion = openRegion === null ? b : unionOf(openRegion, b);
    }
  }

  if (invalidIds.length > 0) {
    items.push({
      id: nextId(),
      code: 'invalidCoordinate',
      severity: 'error',
      message: `${invalidIds.length} 个对象包含非法坐标（NaN / Infinity），必须删除或重新识别后才能导出。`,
      elementIds: invalidIds,
      region: null,
      blocking: true,
    });
  }

  if (degenerateIds.length > 0) {
    items.push({
      id: nextId(),
      code: 'degenerate',
      severity: 'error',
      message: `${degenerateIds.length} 个对象为退化图形（零长度或零面积），导入 Axure 后无法选择。请删除它们。`,
      elementIds: degenerateIds,
      region: null,
      blocking: true,
    });
  }

  if (selfIntersectIds.length > 0) {
    items.push({
      id: nextId(),
      code: 'selfIntersect',
      severity: 'error',
      message: `${selfIntersectIds.length} 个封闭区域存在自相交，转换为形状后填充会出现异常。请用节点工具解开交叉。`,
      elementIds: selfIntersectIds,
      region: siRegion,
      blocking: true,
    });
  }

  if (openRegionIds.length > 0) {
    items.push({
      id: nextId(),
      code: 'openRegion',
      severity: 'warning',
      message: `${openRegionIds.length} 个「封闭区域」图层的对象实际未闭合，导出后不会有填充。可在检查器中点击「闭合路径」。`,
      elementIds: openRegionIds,
      region: openRegion,
      blocking: false,
    });
  }

  if (outOfCanvasIds.length > 0) {
    items.push({
      id: nextId(),
      code: 'outOfCanvas',
      severity: 'warning',
      message: `${outOfCanvasIds.length} 个对象超出画布范围，导入 Axure 后可能被裁剪或位于画布外。`,
      elementIds: outOfCanvasIds,
      region: outRegion,
      blocking: false,
    });
  }

  if (tinyIds.length > 0) {
    items.push({
      id: nextId(),
      code: 'tinyShape',
      severity: 'warning',
      message: `${tinyIds.length} 个对象尺寸异常小，可能是残留噪点。建议确认后删除。`,
      elementIds: tinyIds,
      region: tinyRegion,
      blocking: false,
    });
  }

  return finalize(items, exported.length);
}

function finalize(items: PreflightItem[], checked: number): PreflightReport {
  return {
    items,
    passed: !items.some((i) => i.blocking),
    checkedElements: checked,
    checkedAt: Date.now(),
  };
}

function unionOf(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/** 校验生成的 SVG 字符串的结构与坐标合法性。 */
export interface SvgValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** 统计信息。 */
  stats: {
    groups: number;
    shapes: number;
    hasScript: boolean;
    hasExternalRef: boolean;
    hasFilter: boolean;
    hasMask: boolean;
    hasTransform: boolean;
  };
}

/**
 * 结构自检。
 * 明确禁止：脚本、外部引用、滤镜、蒙版、复杂裁剪。
 * transform 在本工具中被刻意避免（Axure 转换行为未验证），出现即为告警。
 */
export function validateSvg(svg: string): SvgValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const groups = countMatches(svg, /<g[\s>]/g);
  const shapes =
    countMatches(svg, /<line[\s>]/g) +
    countMatches(svg, /<polyline[\s>]/g) +
    countMatches(svg, /<rect[\s>]/g) +
    countMatches(svg, /<polygon[\s>]/g) +
    countMatches(svg, /<path[\s>]/g);

  const hasScript = /<script/i.test(svg);
  const hasExternalRef = /(?:xlink:)?href\s*=\s*"(?!#)/i.test(svg) || /url\(\s*['"]?https?:/i.test(svg);
  const hasFilter = /<filter|filter\s*=/i.test(svg);
  const hasMask = /<mask|mask\s*=|<clipPath|clip-path\s*=/i.test(svg);
  const hasTransform = /\stransform\s*=/i.test(svg);

  if (!svg.trimStart().startsWith('<?xml') && !svg.trimStart().startsWith('<svg')) {
    errors.push('SVG 内容未以 <?xml 或 <svg 开头。');
  }
  if (!/<svg[^>]+viewBox=/i.test(svg)) {
    errors.push('缺少 viewBox 属性，Axure 导入后尺寸可能不正确。');
  }
  if (!svg.trimEnd().endsWith('</svg>')) {
    errors.push('SVG 未正确闭合。');
  }
  if (shapes === 0) {
    errors.push('SVG 中没有任何图形元素。');
  }
  if (hasScript) errors.push('SVG 中包含 <script>，不符合 Axure 导入要求。');
  if (hasExternalRef) errors.push('SVG 中包含外部资源引用。');
  if (hasFilter) errors.push('SVG 中包含滤镜，Axure 转换形状时会丢失或报错。');
  if (hasMask) errors.push('SVG 中包含蒙版 / 裁剪路径。');

  if (hasTransform) {
    warnings.push('SVG 中包含 transform 属性，Axure 对其转换行为未经验证，可能造成坐标漂移。');
  }
  if (/NaN|Infinity/.test(svg)) {
    errors.push('SVG 中包含 NaN 或 Infinity 坐标。');
  }
  if (/fill-rule\s*=\s*"evenodd"/i.test(svg)) {
    warnings.push('检测到 evenodd 复合路径，转换后可能无法分别选择子图形。');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: { groups, shapes, hasScript, hasExternalRef, hasFilter, hasMask, hasTransform },
  };
}

function countMatches(s: string, re: RegExp): number {
  return (s.match(re) ?? []).length;
}
