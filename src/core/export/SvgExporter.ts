/**
 * SvgExporter —— Axure 兼容层。
 *
 * 设计约束（Prompt 3.5 硬要求）：
 *   - viewBox 与设置的画布像素尺寸严格一致；
 *   - 只使用 line / polyline / rect / polygon / 简单 path；
 *   - 每个逻辑对象有稳定、唯一、可读的 id；
 *   - 按边界 / 墙线 / 封闭区域 / 待确认建立 <g> 分组；
 *   - 样式全部内联，不依赖外部 CSS；
 *   - 不使用滤镜、蒙版、复杂裁剪、脚本、外部资源；
 *   - 不合并为位图或不可分别选择的复合路径；
 *   - 旋转矩形展开为 polygon 顶点，不用 transform（Axure 行为未验证）；
 *   - 孔洞导出为独立对象 + data-hole-of，不用 fill-rule="evenodd"；
 *   - metadata 记录尺寸、单位、比例、版本，但不影响显示。
 */

import type { ExportResult, ExportSettings, PreflightReport } from '../../types/export';
import type { ProjectSettings } from '../../types/project';
import { pixelsPerUnit, pixelsPerUnitY, unitSymbol } from '../../types/project';
import type { LayerKind, Point, StyleSpec, VectorElement } from '../../types/vector';
import { LAYER_KINDS, LAYER_LABELS, elementPoints } from '../../types/vector';
import { ALGORITHM_VERSION, TOOL_VERSION } from '../../types/recognition';
import { fmt } from '../../lib/precision';
import { unitToCanvas, unitLengthToCanvas } from '../geometry/transform';
import { preflight, validateSvg } from './svgValidate';

/** 各图层导出时的默认样式（明确 fill / stroke / linecap / linejoin / opacity）。 */
interface ExportStyle {
  fill: string;
  fillOpacity: number;
  stroke: string;
  strokeOpacity: number;
  strokeLinecap: 'butt' | 'round' | 'square';
  strokeLinejoin: 'miter' | 'round' | 'bevel';
  dash: boolean;
}

const LAYER_STYLE: Record<LayerKind, ExportStyle> = {
  boundary: {
    fill: 'none',
    fillOpacity: 1,
    stroke: '#1F2937',
    strokeOpacity: 1,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    dash: false,
  },
  wall: {
    fill: 'none',
    fillOpacity: 1,
    stroke: '#374151',
    strokeOpacity: 1,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    dash: false,
  },
  region: {
    fill: '#DBEAFE',
    fillOpacity: 0.55,
    stroke: '#2563EB',
    strokeOpacity: 1,
    strokeLinecap: 'butt',
    strokeLinejoin: 'miter',
    dash: false,
  },
  review: {
    fill: 'none',
    fillOpacity: 1,
    stroke: '#D97706',
    strokeOpacity: 1,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    dash: true,
  },
};

export interface ExportInput {
  elements: readonly VectorElement[];
  settings: ProjectSettings;
  exportSettings: ExportSettings;
  projectName: string;
}

export class SvgExporter {
  readonly name = 'SvgExporter';

  /**
   * 生成 SVG。
   * 预检不通过（存在 blocking 项）时仍返回报告，但 svg 为空字符串，
   * 由 UI 阻止保存并展示需修正的问题。
   */
  run(input: ExportInput): ExportResult {
    const { elements, settings, exportSettings: ex, projectName } = input;

    const report: PreflightReport = preflight(elements, settings, ex);
    if (!report.passed) {
      return {
        svg: '',
        report,
        suggestedFileName: fileNameOf(projectName),
        byteSize: 0,
      };
    }

    const svg = this.buildSvg(elements, settings, ex, projectName);
    const validation = validateSvg(svg);

    // 结构自检失败时并入报告并阻止导出（属于工具自身的 bug 防线）
    if (!validation.valid) {
      const items = [...report.items];
      for (const e of validation.errors) {
        items.push({
          id: `svg-${items.length}`,
          code: 'invalidCoordinate',
          severity: 'error',
          message: `SVG 结构自检失败：${e}`,
          elementIds: [],
          region: null,
          blocking: true,
        });
      }
      return {
        svg: '',
        report: { ...report, items, passed: false },
        suggestedFileName: fileNameOf(projectName),
        byteSize: 0,
      };
    }

    // 结构告警并入报告（不阻止导出）
    const items = [...report.items];
    for (const w of validation.warnings) {
      items.push({
        id: `svgw-${items.length}`,
        code: 'outOfCanvas',
        severity: 'warning',
        message: `SVG 兼容性提示：${w}`,
        elementIds: [],
        region: null,
        blocking: false,
      });
    }

    return {
      svg,
      report: { ...report, items },
      suggestedFileName: fileNameOf(projectName),
      byteSize: new TextEncoder().encode(svg).length,
    };
  }

  private buildSvg(
    elements: readonly VectorElement[],
    s: ProjectSettings,
    ex: ExportSettings,
    projectName: string,
  ): string {
    const nl = ex.prettyPrint ? '\n' : '';
    const ind = (n: number): string => (ex.prettyPrint ? '  '.repeat(n) : '');

    const w = Math.max(1, Math.round(s.canvasWidthPx));
    const h = Math.max(1, Math.round(s.canvasHeightPx));

    const parts: string[] = [];
    parts.push('<?xml version="1.0" encoding="UTF-8"?>');
    parts.push(
      `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" ` +
        `width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    );

    if (ex.includeMetadata) {
      parts.push(this.buildMetadata(s, ex, projectName, ind, nl));
    }

    parts.push(`${ind(1)}<title>${escapeXml(projectName)} · LD 白盒</title>`);
    parts.push(
      `${ind(1)}<desc>由 Axure LD 工具箱 v${TOOL_VERSION} 生成。导入 Axure RP 后请使用「Convert SVG to shapes / 转换 SVG 为形状」获得可编辑对象。</desc>`,
    );

    // 按图层分组：先画区域（填充），再画墙线，最后是边界与待确认，保证描边不被填充遮挡
    const drawOrder: LayerKind[] = ['region', 'wall', 'boundary', 'review'];
    for (const layer of drawOrder) {
      if (ex.layers[layer] === false) continue;
      const layerElements = elements.filter(
        (el) => el.layer === layer && el.hidden !== true,
      );
      if (layerElements.length === 0) continue;

      parts.push(
        `${ind(1)}<g id="layer-${layer}" data-layer="${layer}" data-label="${escapeXml(LAYER_LABELS[layer])}">`,
      );
      for (const el of layerElements) {
        const node = this.buildElement(el, s, ex);
        if (node !== null) parts.push(`${ind(2)}${node}`);
      }
      parts.push(`${ind(1)}</g>`);
    }

    parts.push('</svg>');
    return parts.join(nl === '' ? '' : nl) + (nl === '' ? '' : nl);
  }

  private buildMetadata(
    s: ProjectSettings,
    ex: ExportSettings,
    projectName: string,
    ind: (n: number) => string,
    nl: string,
  ): string {
    const sym = unitSymbol(s.unit);
    const lines = [
      `${ind(1)}<metadata>`,
      `${ind(2)}<ldToolbox xmlns="https://local.tool/axure-ld/1.0"`,
      `${ind(3)}toolVersion="${TOOL_VERSION}"`,
      `${ind(3)}algorithmVersion="${ALGORITHM_VERSION}"`,
      `${ind(3)}projectName="${escapeXml(projectName)}"`,
      `${ind(3)}mapWidth="${fmt(s.mapWidth, 4)}"`,
      `${ind(3)}mapHeight="${fmt(s.mapHeight, 4)}"`,
      `${ind(3)}unit="${escapeXml(sym)}"`,
      `${ind(3)}unitKind="${s.unit.kind}"`,
      `${ind(3)}canvasWidthPx="${Math.round(s.canvasWidthPx)}"`,
      `${ind(3)}canvasHeightPx="${Math.round(s.canvasHeightPx)}"`,
      `${ind(3)}pixelsPerUnit="${fmt(pixelsPerUnit(s), 6)}"`,
      `${ind(3)}pixelsPerUnitY="${fmt(pixelsPerUnitY(s), 6)}"`,
      `${ind(3)}lockAspect="${String(s.lockAspect)}"`,
      `${ind(3)}scaleSource="${s.scaleSource}"`,
      `${ind(3)}coordinatePrecision="${ex.precision}"`,
      `${ind(3)}generatedAt="${new Date().toISOString()}"/>`,
      `${ind(1)}</metadata>`,
    ];
    return lines.join(nl === '' ? '' : nl);
  }

  /** 单个元素 → SVG 元素字符串。 */
  private buildElement(el: VectorElement, s: ProjectSettings, ex: ExportSettings): string | null {
    const p = ex.precision;
    const style = this.styleAttrs(el, s, ex);
    const meta = this.dataAttrs(el, ex);
    const id = ` id="${escapeXml(el.id)}"`;

    switch (el.kind) {
      case 'line': {
        const a = unitToCanvas(el.a, s);
        const b = unitToCanvas(el.b, s);
        return `<line${id} x1="${fmt(a.x, p)}" y1="${fmt(a.y, p)}" x2="${fmt(b.x, p)}" y2="${fmt(b.y, p)}"${style}${meta}/>`;
      }

      case 'polyline': {
        const pts = this.pointsAttr(el.points, s, p);
        return `<polyline${id} points="${pts}"${style}${meta}/>`;
      }

      case 'rect': {
        // 只有轴对齐矩形才走 rect；旋转矩形在分类阶段已转为 polygon
        const tl = unitToCanvas({ x: el.x, y: el.y }, s);
        const br = unitToCanvas({ x: el.x + el.w, y: el.y + el.h }, s);
        const rw = br.x - tl.x;
        const rh = br.y - tl.y;
        if (!(rw > 0) || !(rh > 0)) return null;
        return `<rect${id} x="${fmt(tl.x, p)}" y="${fmt(tl.y, p)}" width="${fmt(rw, p)}" height="${fmt(rh, p)}"${style}${meta}/>`;
      }

      case 'polygon': {
        const pts = this.pointsAttr(el.points, s, p);
        return `<polygon${id} points="${pts}"${style}${meta}/>`;
      }

      case 'openPath': {
        const d = this.pathData(el.points, s, p, false);
        if (d === '') return null;
        return `<path${id} d="${d}"${style}${meta}/>`;
      }

      case 'closedPath': {
        const d = this.pathData(el.points, s, p, true);
        if (d === '') return null;
        // 孔洞用独立对象 + data-hole-of 关联，避免 evenodd 复合路径
        const hole = el.holeOf !== undefined ? ` data-hole-of="${escapeXml(el.holeOf)}"` : '';
        return `<path${id} d="${d}"${style}${meta}${hole}/>`;
      }
    }
  }

  private pointsAttr(points: readonly Point[], s: ProjectSettings, p: number): string {
    return points
      .map((pt) => {
        const c = unitToCanvas(pt, s);
        return `${fmt(c.x, p)},${fmt(c.y, p)}`;
      })
      .join(' ');
  }

  /** 仅使用 M / L / Z —— 最简 path 数据，兼容性最好。 */
  private pathData(points: readonly Point[], s: ProjectSettings, p: number, closed: boolean): string {
    if (points.length < 2) return '';
    const parts: string[] = [];
    points.forEach((pt, i) => {
      const c = unitToCanvas(pt, s);
      parts.push(`${i === 0 ? 'M' : 'L'}${fmt(c.x, p)} ${fmt(c.y, p)}`);
    });
    if (closed) parts.push('Z');
    return parts.join(' ');
  }

  /** 内联样式属性（不依赖外部 CSS）。 */
  private styleAttrs(el: VectorElement, s: ProjectSettings, ex: ExportSettings): string {
    const theme = LAYER_STYLE[el.layer];
    const closed = el.kind === 'rect' || el.kind === 'polygon' || el.kind === 'closedPath';

    const strokeWidthPx = Math.max(
      0.25,
      unitLengthToCanvas(el.style.strokeWidth, s) * ex.strokeScale,
    );

    const fill = closed && ex.fillRegions && theme.fill !== 'none' ? theme.fill : 'none';
    const attrs: string[] = [
      ` fill="${fill}"`,
      ` stroke="${theme.stroke}"`,
      ` stroke-width="${fmt(strokeWidthPx, 2)}"`,
      ` stroke-linecap="${theme.strokeLinecap}"`,
      ` stroke-linejoin="${theme.strokeLinejoin}"`,
    ];
    if (fill !== 'none') attrs.push(` fill-opacity="${fmt(theme.fillOpacity, 2)}"`);
    if (theme.strokeOpacity !== 1) attrs.push(` stroke-opacity="${fmt(theme.strokeOpacity, 2)}"`);
    if (theme.dash && ex.keepDashForReview) {
      attrs.push(` stroke-dasharray="${fmt(strokeWidthPx * 3, 2)} ${fmt(strokeWidthPx * 2, 2)}"`);
    }
    return attrs.join('');
  }

  /** data-* 属性：保留识别元信息，不影响 Axure 显示。 */
  private dataAttrs(el: VectorElement, ex: ExportSettings): string {
    if (!ex.includeDataAttrs) return '';
    const attrs: string[] = [
      ` data-kind="${el.kind}"`,
      ` data-layer="${el.layer}"`,
      ` data-confidence="${fmt(el.confidence, 3)}"`,
      ` data-source="${el.source}"`,
    ];
    if (el.issueIds.length > 0) attrs.push(` data-issues="${el.issueIds.length}"`);
    if (el.name !== undefined) attrs.push(` data-name="${escapeXml(el.name)}"`);
    return attrs.join('');
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fileNameOf(projectName: string): string {
  const safe = projectName.replace(/[\\/:*?"<>|]/g, '_').trim();
  return `${safe === '' ? 'ld-map' : safe}.svg`;
}

export const svgExporter = new SvgExporter();
export { LAYER_KINDS };
