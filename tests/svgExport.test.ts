/**
 * SVG 导出单测 —— 对应最低验收标准 6 与 7：
 *   6. 主要逻辑对象保持独立，导入 Axure 转形状后可分别选择编辑
 *   7. SVG 画布比例与工具设置一致，关键控制点无坐标漂移
 */

import { describe, expect, it } from 'vitest';
import { SvgExporter } from '../src/core/export/SvgExporter';
import { preflight, validateSvg, RECOMMENDED_MAX_ELEMENTS } from '../src/core/export/svgValidate';
import { DEFAULT_EXPORT_SETTINGS } from '../src/types/export';
import { DEFAULT_SETTINGS, type ProjectSettings } from '../src/types/project';
import { defaultStyle, type LayerKind, type VectorElement } from '../src/types/vector';
import { buildReadmeText, VERIFICATION_ITEMS, CAPABILITY_DISCLAIMER } from '../src/core/export/axureNotes';

const exporter = new SvgExporter();

/** 1 单位 = 20 像素，便于人工核算坐标。 */
const SETTINGS: ProjectSettings = {
  ...DEFAULT_SETTINGS,
  mapWidth: 60,
  mapHeight: 40,
  canvasWidthPx: 1200,
  canvasHeightPx: 800,
  aspectRatio: 1.5,
};

function el(
  id: string,
  layer: LayerKind,
  geom: Partial<VectorElement> & Pick<VectorElement, 'kind'>,
): VectorElement {
  return {
    id,
    layer,
    confidence: 0.9,
    issueIds: [],
    style: defaultStyle(layer, 0.1),
    source: 'auto',
    ...geom,
  } as VectorElement;
}

function rect(id: string, x: number, y: number, w: number, h: number, layer: LayerKind = 'region'): VectorElement {
  return el(id, layer, { kind: 'rect', x, y, w, h });
}

function line(id: string, x1: number, y1: number, x2: number, y2: number): VectorElement {
  return el(id, 'wall', { kind: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
}

function run(elements: readonly VectorElement[], settings = SETTINGS, ex = DEFAULT_EXPORT_SETTINGS) {
  return exporter.run({ elements, settings, exportSettings: ex, projectName: '测试地图' });
}

describe('SVG 结构（验收标准 6）', () => {
  const elements = [
    rect('region-rect-0001', 5, 5, 20, 10),
    rect('region-rect-0002', 30, 5, 20, 10),
    line('wall-line-0001', 5, 20, 50, 20),
    el('boundary-poly-0001', 'boundary', {
      kind: 'polygon',
      points: [
        { x: 1, y: 1 },
        { x: 59, y: 1 },
        { x: 59, y: 39 },
        { x: 1, y: 39 },
      ],
    }),
    el('review-path-0001', 'review', {
      kind: 'openPath',
      points: [
        { x: 10, y: 30 },
        { x: 20, y: 32 },
        { x: 30, y: 29 },
      ],
    }),
  ];

  it('每个逻辑对象都是独立元素且带唯一可读 id', () => {
    const out = run(elements);
    expect(out.report.passed).toBe(true);
    for (const e of elements) {
      expect(out.svg).toContain(`id="${e.id}"`);
    }
    // id 出现次数唯一
    for (const e of elements) {
      const count = (out.svg.match(new RegExp(`id="${e.id}"`, 'g')) ?? []).length;
      expect(count).toBe(1);
    }
  });

  it('两个共享墙的房间导出为两个独立 rect（不合并为复合路径）', () => {
    const out = run([elements[0]!, elements[1]!]);
    const rectCount = (out.svg.match(/<rect\s/g) ?? []).length;
    expect(rectCount).toBe(2);
    expect(out.svg).not.toContain('fill-rule="evenodd"');
  });

  it('按图层建立 <g> 分组', () => {
    const out = run(elements);
    expect(out.svg).toContain('id="layer-region"');
    expect(out.svg).toContain('id="layer-wall"');
    expect(out.svg).toContain('id="layer-boundary"');
    expect(out.svg).toContain('id="layer-review"');
    expect(out.svg).toContain('data-layer="region"');
  });

  it('只使用基础元素，不出现 transform / 滤镜 / 蒙版 / 脚本', () => {
    const out = run(elements);
    const v = validateSvg(out.svg);
    expect(v.valid).toBe(true);
    expect(v.stats.hasTransform).toBe(false);
    expect(v.stats.hasFilter).toBe(false);
    expect(v.stats.hasMask).toBe(false);
    expect(v.stats.hasScript).toBe(false);
    expect(v.stats.hasExternalRef).toBe(false);
    expect(out.svg).not.toContain('<image');
    expect(out.svg).not.toContain('<style');
  });

  it('样式全部内联，不依赖外部 CSS', () => {
    const out = run(elements);
    expect(out.svg).toContain('stroke-width=');
    expect(out.svg).toContain('stroke-linecap=');
    expect(out.svg).toContain('stroke-linejoin=');
    expect(out.svg).not.toContain('class=');
    expect(out.svg).not.toContain('<link');
  });

  it('旋转矩形展开为 polygon 顶点，不使用 transform', () => {
    const rotated = el('region-poly-0009', 'region', {
      kind: 'polygon',
      points: [
        { x: 10, y: 10 },
        { x: 25, y: 14 },
        { x: 21, y: 26 },
        { x: 6, y: 22 },
      ],
    });
    const out = run([rotated]);
    expect(out.svg).toContain('<polygon');
    expect(out.svg).not.toContain('transform');
  });

  it('孔洞导出为独立对象并带 data-hole-of 关联', () => {
    const host = rect('region-rect-0100', 5, 5, 40, 30);
    const hole = el('region-area-0101', 'region', {
      kind: 'closedPath',
      points: [
        { x: 15, y: 12 },
        { x: 30, y: 12 },
        { x: 30, y: 24 },
        { x: 15, y: 24 },
      ],
      holeOf: 'region-rect-0100',
    });
    const out = run([host, hole]);
    expect(out.svg).toContain('data-hole-of="region-rect-0100"');
    expect(out.svg).not.toContain('evenodd');
  });

  it('路径只用 M / L / Z 指令', () => {
    const out = run([elements[4]!]);
    // 注意用 \sd=" 定位，避免匹配到 id=" 中的 d="
    const d = /\sd="([^"]+)"/.exec(out.svg)?.[1] ?? '';
    expect(d.length).toBeGreaterThan(0);
    expect(/^[MLZ0-9.\-\s]+$/.test(d)).toBe(true);
    expect(d.startsWith('M')).toBe(true);
    // 开放路径不应闭合
    expect(d.includes('Z')).toBe(false);
  });

  it('封闭路径以 Z 结尾', () => {
    const closed = el('region-area-0001', 'region', {
      kind: 'closedPath',
      points: [
        { x: 5, y: 5 },
        { x: 20, y: 6 },
        { x: 18, y: 18 },
        { x: 4, y: 16 },
      ],
    });
    const out = run([closed]);
    const d = /\sd="([^"]+)"/.exec(out.svg)?.[1] ?? '';
    expect(d.endsWith('Z')).toBe(true);
  });

  it('可按图层筛选导出', () => {
    const out = run(elements, SETTINGS, {
      ...DEFAULT_EXPORT_SETTINGS,
      layers: { boundary: false, wall: true, region: false, review: false },
    });
    expect(out.svg).toContain('id="layer-wall"');
    expect(out.svg).not.toContain('id="layer-region"');
    expect(out.svg).not.toContain('id="layer-boundary"');
  });
});

describe('画布与坐标（验收标准 7）', () => {
  it('viewBox 与设置的画布像素严格一致', () => {
    const out = run([rect('region-rect-0001', 5, 5, 20, 10)]);
    expect(out.svg).toContain('viewBox="0 0 1200 800"');
    expect(out.svg).toContain('width="1200"');
    expect(out.svg).toContain('height="800"');
  });

  it('关键控制点坐标精确换算，无漂移', () => {
    // 1 单位 = 20px：rect(5,5,20,10) → x=100 y=100 w=400 h=200
    const out = run([rect('region-rect-0001', 5, 5, 20, 10)]);
    expect(out.svg).toContain('x="100"');
    expect(out.svg).toContain('y="100"');
    expect(out.svg).toContain('width="400"');
    expect(out.svg).toContain('height="200"');
  });

  it('画布尺寸翻倍后导出坐标同比例翻倍', () => {
    const e = rect('region-rect-0001', 5, 5, 20, 10);
    const big: ProjectSettings = { ...SETTINGS, canvasWidthPx: 2400, canvasHeightPx: 1600 };
    const out = run([e], big);
    expect(out.svg).toContain('viewBox="0 0 2400 1600"');
    expect(out.svg).toContain('x="200"');
    expect(out.svg).toContain('width="800"');
  });

  it('线段端点坐标精确', () => {
    const out = run([line('wall-line-0001', 0, 0, 60, 40)]);
    expect(out.svg).toContain('x1="0"');
    expect(out.svg).toContain('y1="0"');
    expect(out.svg).toContain('x2="1200"');
    expect(out.svg).toContain('y2="800"');
  });

  it('polygon 顶点坐标精确', () => {
    const out = run([
      el('boundary-poly-0001', 'boundary', {
        kind: 'polygon',
        points: [
          { x: 0, y: 0 },
          { x: 60, y: 0 },
          { x: 60, y: 40 },
        ],
      }),
    ]);
    expect(out.svg).toContain('points="0,0 1200,0 1200,800"');
  });

  it('坐标精度设置生效', () => {
    const e = rect('region-rect-0001', 5.123456, 5, 20, 10);
    const p0 = run([e], SETTINGS, { ...DEFAULT_EXPORT_SETTINGS, precision: 0 });
    const p3 = run([e], SETTINGS, { ...DEFAULT_EXPORT_SETTINGS, precision: 3 });
    expect(p0.svg).toContain('x="102"');
    expect(p3.svg).toContain('x="102.469"');
  });

  it('metadata 记录尺寸、单位、比例与版本', () => {
    const out = run([rect('region-rect-0001', 5, 5, 20, 10)]);
    expect(out.svg).toContain('<metadata>');
    expect(out.svg).toContain('mapWidth="60"');
    expect(out.svg).toContain('mapHeight="40"');
    expect(out.svg).toContain('pixelsPerUnit="20"');
    expect(out.svg).toContain('toolVersion=');
    expect(out.svg).toContain('algorithmVersion=');
  });

  it('可关闭 metadata 与 data-* 属性', () => {
    const out = run([rect('region-rect-0001', 5, 5, 20, 10)], SETTINGS, {
      ...DEFAULT_EXPORT_SETTINGS,
      includeMetadata: false,
      includeDataAttrs: false,
    });
    expect(out.svg).not.toContain('<metadata>');
    expect(out.svg).not.toContain('data-confidence');
  });
});

describe('导出预检', () => {
  it('空导出被阻止', () => {
    const r = preflight([], SETTINGS, DEFAULT_EXPORT_SETTINGS);
    expect(r.passed).toBe(false);
    expect(r.items[0]!.code).toBe('emptyExport');
    expect(r.items[0]!.blocking).toBe(true);
  });

  it('非法坐标被阻止', () => {
    const bad = el('region-rect-0001', 'region', { kind: 'rect', x: Number.NaN, y: 0, w: 10, h: 10 });
    const r = preflight([bad], SETTINGS, DEFAULT_EXPORT_SETTINGS);
    expect(r.passed).toBe(false);
    expect(r.items.some((i) => i.code === 'invalidCoordinate' && i.blocking)).toBe(true);
  });

  it('退化图形被阻止', () => {
    const zero = rect('region-rect-0001', 5, 5, 0, 0);
    const r = preflight([zero], SETTINGS, DEFAULT_EXPORT_SETTINGS);
    expect(r.passed).toBe(false);
    expect(r.items.some((i) => i.code === 'degenerate' && i.blocking)).toBe(true);
  });

  it('自相交被阻止（对称蝴蝶结的净面积为 0，也必须报为自相交而非退化）', () => {
    const bowtie = el('region-area-0001', 'region', {
      kind: 'closedPath',
      points: [
        { x: 5, y: 5 },
        { x: 25, y: 25 },
        { x: 25, y: 5 },
        { x: 5, y: 25 },
      ],
    });
    const r = preflight([bowtie], SETTINGS, DEFAULT_EXPORT_SETTINGS);
    expect(r.passed).toBe(false);
    expect(r.items.some((i) => i.code === 'selfIntersect' && i.blocking)).toBe(true);
    // 不应被误报为退化图形
    expect(r.items.some((i) => i.code === 'degenerate')).toBe(false);
  });

  it('非对称自相交也被阻止', () => {
    const twisted = el('region-area-0002', 'region', {
      kind: 'closedPath',
      points: [
        { x: 5, y: 5 },
        { x: 30, y: 8 },
        { x: 8, y: 20 },
        { x: 32, y: 24 },
      ],
    });
    const r = preflight([twisted], SETTINGS, DEFAULT_EXPORT_SETTINGS);
    expect(r.passed).toBe(false);
    expect(r.items.some((i) => i.code === 'selfIntersect')).toBe(true);
  });

  it('越界与异常小图形为警告，不阻止导出', () => {
    const outside = rect('region-rect-0001', 55, 35, 20, 20);
    const r = preflight([outside], SETTINGS, DEFAULT_EXPORT_SETTINGS);
    expect(r.items.some((i) => i.code === 'outOfCanvas' && !i.blocking)).toBe(true);
    expect(r.passed).toBe(true);
  });

  it('region 图层的开放路径给出未闭合警告', () => {
    const open = el('region-path-0001', 'region', {
      kind: 'openPath',
      points: [
        { x: 5, y: 5 },
        { x: 20, y: 5 },
        { x: 20, y: 15 },
      ],
    });
    const r = preflight([open], SETTINGS, DEFAULT_EXPORT_SETTINGS);
    expect(r.items.some((i) => i.code === 'openRegion')).toBe(true);
    expect(r.passed).toBe(true);
  });

  it('对象数超上限给出警告', () => {
    const many: VectorElement[] = [];
    for (let i = 0; i < RECOMMENDED_MAX_ELEMENTS + 5; i++) {
      const x = (i % 50) * 1.1;
      const y = Math.floor(i / 50) * 0.7;
      many.push(rect(`region-rect-${String(i).padStart(4, '0')}`, x, y, 1, 0.6));
    }
    const r = preflight(many, SETTINGS, DEFAULT_EXPORT_SETTINGS);
    expect(r.items.some((i) => i.code === 'tooManyElements')).toBe(true);
  });

  it('预检不通过时不产出 SVG', () => {
    const bad = rect('region-rect-0001', 5, 5, 0, 0);
    const out = run([bad]);
    expect(out.report.passed).toBe(false);
    expect(out.svg).toBe('');
    expect(out.byteSize).toBe(0);
  });

  it('正常输入预检通过并产出非空 SVG', () => {
    const out = run([rect('region-rect-0001', 5, 5, 20, 10)]);
    expect(out.report.passed).toBe(true);
    expect(out.svg.length).toBeGreaterThan(100);
    expect(out.byteSize).toBeGreaterThan(100);
    expect(out.suggestedFileName).toBe('测试地图.svg');
  });
});

describe('SVG 结构自检', () => {
  it('检出缺少 viewBox', () => {
    const v = validateSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    expect(v.valid).toBe(false);
    expect(v.errors.some((e) => e.includes('viewBox'))).toBe(true);
  });

  it('检出脚本', () => {
    const v = validateSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>x</script><rect/></svg>',
    );
    expect(v.valid).toBe(false);
    expect(v.stats.hasScript).toBe(true);
  });

  it('检出 NaN 坐标', () => {
    const v = validateSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect x="NaN"/></svg>',
    );
    expect(v.valid).toBe(false);
  });

  it('transform 与 evenodd 为告警而非错误', () => {
    const v = validateSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect transform="rotate(3)" fill-rule="evenodd"/></svg>',
    );
    expect(v.valid).toBe(true);
    expect(v.warnings.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Axure 说明与能力边界', () => {
  it('提供导入步骤与需验证清单', () => {
    expect(VERIFICATION_ITEMS.length).toBeGreaterThanOrEqual(6);
    for (const v of VERIFICATION_ITEMS) {
      expect(v.experiment.length).toBeGreaterThan(10);
      expect(v.risk.length).toBeGreaterThan(10);
    }
  });

  /** 验收标准 9：不得把只读 MCP 或未公开接口描述为可直接生成 .rp。 */
  it('能力边界明确声明不生成 .rp、不使用未公开接口', () => {
    const text = CAPABILITY_DISCLAIMER.join(' ');
    expect(text).toContain('不直接生成或修改 .rp');
    expect(text).toContain('未公开接口');
    expect(text).toContain('无网络上传');
  });

  it('说明文档包含导入步骤与验证方法', () => {
    const md = buildReadmeText('测试地图', 1200, 800);
    expect(md).toContain('Convert SVG to Shapes');
    expect(md).toContain('1200 × 800 px');
    expect(md).toContain('需在你的 Axure 版本上验证的项');
    expect(md).toContain('能力边界');
  });
});
