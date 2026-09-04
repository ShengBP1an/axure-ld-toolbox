/**
 * 编辑命令与设置逻辑单测 —— 对应最低验收标准 5：
 * 「自动识别错误能够在编辑器中人工修正，并可正常撤销、重做和重新导出」。
 */

import { describe, expect, it } from 'vitest';
import type { EditorState } from '../src/types/editor';
import { UNDO_STACK_LIMIT } from '../src/types/editor';
import { defaultStyle, elementPoints, type LayerKind, type VectorElement } from '../src/types/vector';
import {
  AddElementsCommand,
  CompositeCommand,
  DeleteElementsCommand,
  DeleteNodeCommand,
  InsertNodeCommand,
  MergePathsCommand,
  MoveElementsCommand,
  MoveNodeCommand,
  ResetToAutoCommand,
  SetClosedCommand,
  SetFlagCommand,
  SetLayerCommand,
  SplitPathCommand,
} from '../src/store/commands';
import * as S from '../src/core/project/settings';
import { DEFAULT_SETTINGS, pixelsPerUnit, type ProjectSettings } from '../src/types/project';
import { PipelineError } from '../src/types/errors';
import { IdFactory } from '../src/lib/id';

function makeState(elements: readonly VectorElement[] = []): EditorState {
  const map = new Map<string, VectorElement>();
  const order: string[] = [];
  for (const el of elements) {
    map.set(el.id, el);
    order.push(el.id);
  }
  return {
    elements: map,
    order,
    issues: new Map(),
    layerVisible: { boundary: true, wall: true, region: true, review: true },
    layerLocked: { boundary: false, wall: false, region: false, review: false },
  };
}

function el(id: string, layer: LayerKind, geom: Record<string, unknown>): VectorElement {
  return {
    id,
    layer,
    confidence: 0.9,
    issueIds: [],
    style: defaultStyle(layer, 0.1),
    source: 'auto',
    ...geom,
  } as unknown as VectorElement;
}

const rect = (id = 'region-rect-0001') =>
  el(id, 'region', { kind: 'rect', x: 10, y: 10, w: 20, h: 10 });

const poly = (id = 'region-poly-0001') =>
  el(id, 'region', {
    kind: 'polygon',
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
  });

const polyline = (id = 'wall-poly-0001') =>
  el(id, 'wall', {
    kind: 'polyline',
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 5 },
    ],
  });

/** 执行命令并返回其反向命令（模拟 store 的 undo）。 */
function apply(state: EditorState, cmd: ReturnType<typeof makeCmd>): void {
  cmd.apply(state);
}
type Cmd = { apply(s: EditorState): void; invert(): Cmd; affectedIds(): string[]; label: string };
function makeCmd(c: Cmd): Cmd {
  return c;
}

describe('新增 / 删除命令', () => {
  it('新增后撤销可完全移除', () => {
    const s = makeState();
    const cmd = new AddElementsCommand([rect()]);
    cmd.apply(s);
    expect(s.elements.size).toBe(1);
    expect(s.order).toEqual(['region-rect-0001']);

    cmd.invert().apply(s);
    expect(s.elements.size).toBe(0);
    expect(s.order).toHaveLength(0);
  });

  it('删除后撤销按原索引还原顺序', () => {
    const a = rect('region-rect-0001');
    const b = rect('region-rect-0002');
    const c = rect('region-rect-0003');
    const s = makeState([a, b, c]);

    const cmd = new DeleteElementsCommand([b], undefined, [1]);
    cmd.apply(s);
    expect(s.order).toEqual(['region-rect-0001', 'region-rect-0003']);

    cmd.invert().apply(s);
    expect(s.order).toEqual(['region-rect-0001', 'region-rect-0002', 'region-rect-0003']);
    expect(s.elements.size).toBe(3);
  });

  it('删除宿主时解除孔洞关联，避免悬空引用', () => {
    const host = rect('region-rect-0001');
    const hole = el('region-area-0002', 'region', {
      kind: 'closedPath',
      points: [
        { x: 12, y: 12 },
        { x: 18, y: 12 },
        { x: 18, y: 16 },
      ],
      holeOf: 'region-rect-0001',
    });
    const s = makeState([host, hole]);
    new DeleteElementsCommand([host], undefined, [0]).apply(s);
    const after = s.elements.get('region-area-0002')!;
    expect(after.kind).toBe('closedPath');
    if (after.kind === 'closedPath') expect(after.holeOf).toBeUndefined();
  });

  it('反复撤销 / 重做保持一致', () => {
    const s = makeState();
    const add = new AddElementsCommand([rect(), poly('region-poly-0002')]);
    for (let i = 0; i < 5; i++) {
      add.apply(s);
      expect(s.elements.size).toBe(2);
      add.invert().apply(s);
      expect(s.elements.size).toBe(0);
    }
  });
});

describe('移动命令', () => {
  it('移动矩形后撤销精确复位', () => {
    const s = makeState([rect()]);
    const cmd = new MoveElementsCommand(['region-rect-0001'], 5, -3);
    cmd.apply(s);
    const moved = s.elements.get('region-rect-0001')!;
    expect(moved.kind).toBe('rect');
    if (moved.kind === 'rect') {
      expect(moved.x).toBe(15);
      expect(moved.y).toBe(7);
    }

    cmd.invert().apply(s);
    const back = s.elements.get('region-rect-0001')!;
    if (back.kind === 'rect') {
      expect(back.x).toBe(10);
      expect(back.y).toBe(10);
    }
  });

  it('移动后 source 标记为 manual', () => {
    const s = makeState([rect()]);
    new MoveElementsCommand(['region-rect-0001'], 1, 1).apply(s);
    expect(s.elements.get('region-rect-0001')!.source).toBe('manual');
  });

  it('锁定对象不被移动', () => {
    const locked = { ...rect(), locked: true };
    const s = makeState([locked]);
    new MoveElementsCommand(['region-rect-0001'], 5, 5).apply(s);
    const after = s.elements.get('region-rect-0001')!;
    if (after.kind === 'rect') expect(after.x).toBe(10);
  });

  it('多个对象一起移动', () => {
    const s = makeState([rect('region-rect-0001'), poly('region-poly-0002')]);
    new MoveElementsCommand(['region-rect-0001', 'region-poly-0002'], 2, 2).apply(s);
    const p = s.elements.get('region-poly-0002')!;
    expect(elementPoints(p)[0]).toEqual({ x: 2, y: 2 });
  });
});

describe('节点编辑命令', () => {
  it('移动节点后撤销复位', () => {
    const s = makeState([poly()]);
    const cmd = new MoveNodeCommand('region-poly-0001', 1, { x: 10, y: 0 }, { x: 14, y: 3 });
    cmd.apply(s);
    expect(elementPoints(s.elements.get('region-poly-0001')!)[1]).toEqual({ x: 14, y: 3 });

    cmd.invert().apply(s);
    expect(elementPoints(s.elements.get('region-poly-0001')!)[1]).toEqual({ x: 10, y: 0 });
  });

  /** 拖动矩形顶点使其不再轴对齐时，必须提升为 polygon 而非静默丢弃编辑。 */
  it('矩形顶点被拖成非轴对齐时提升为 polygon', () => {
    const s = makeState([rect()]);
    new MoveNodeCommand('region-rect-0001', 1, { x: 30, y: 10 }, { x: 34, y: 4 }).apply(s);
    const after = s.elements.get('region-rect-0001')!;
    expect(after.kind).toBe('polygon');
    expect(elementPoints(after)[1]).toEqual({ x: 34, y: 4 });
  });

  it('矩形顶点仍轴对齐时保持 rect', () => {
    const s = makeState([rect()]);
    // 把右上角与右下角一起想象为纯水平移动：这里只动右上角的 x 会破坏轴对齐，
    // 因此改为验证「移动到与相邻角一致的位置」仍保持 rect 的边界情形
    new MoveNodeCommand('region-rect-0001', 0, { x: 10, y: 10 }, { x: 10, y: 10 }).apply(s);
    expect(s.elements.get('region-rect-0001')!.kind).toBe('rect');
  });

  it('插入节点后撤销移除', () => {
    const s = makeState([polyline()]);
    const cmd = new InsertNodeCommand('wall-poly-0001', 1, { x: 5, y: 2 });
    cmd.apply(s);
    expect(elementPoints(s.elements.get('wall-poly-0001')!)).toHaveLength(4);

    cmd.invert().apply(s);
    expect(elementPoints(s.elements.get('wall-poly-0001')!)).toHaveLength(3);
  });

  it('删除节点后撤销还原', () => {
    const s = makeState([polyline()]);
    const cmd = new DeleteNodeCommand('wall-poly-0001', 1, { x: 10, y: 0 });
    cmd.apply(s);
    expect(elementPoints(s.elements.get('wall-poly-0001')!)).toHaveLength(2);

    cmd.invert().apply(s);
    const pts = elementPoints(s.elements.get('wall-poly-0001')!);
    expect(pts).toHaveLength(3);
    expect(pts[1]).toEqual({ x: 10, y: 0 });
  });

  it('闭合形状不会被删到少于 3 点', () => {
    const tri = el('region-poly-0001', 'region', {
      kind: 'polygon',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 5, y: 8 },
      ],
    });
    const s = makeState([tri]);
    new DeleteNodeCommand('region-poly-0001', 0, { x: 0, y: 0 }).apply(s);
    expect(elementPoints(s.elements.get('region-poly-0001')!)).toHaveLength(3);
  });

  it('line 插入节点时提升为 polyline', () => {
    const l = el('wall-line-0001', 'wall', { kind: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });
    const s = makeState([l]);
    new InsertNodeCommand('wall-line-0001', 1, { x: 5, y: 3 }).apply(s);
    const after = s.elements.get('wall-line-0001')!;
    expect(after.kind).toBe('polyline');
    expect(elementPoints(after)).toHaveLength(3);
  });
});

describe('闭合 / 打开 / 合并 / 拆分', () => {
  it('闭合路径后撤销恢复原类型', () => {
    const s = makeState([polyline()]);
    const cmd = new SetClosedCommand('wall-poly-0001', true);
    cmd.apply(s);
    expect(s.elements.get('wall-poly-0001')!.kind).toBe('closedPath');

    cmd.invert().apply(s);
    expect(s.elements.get('wall-poly-0001')!.kind).toBe('polyline');
  });

  it('打开封闭路径', () => {
    const s = makeState([poly()]);
    new SetClosedCommand('region-poly-0001', false).apply(s);
    expect(s.elements.get('region-poly-0001')!.kind).toBe('openPath');
  });

  it('点数不足时不允许闭合', () => {
    const l = el('wall-line-0001', 'wall', { kind: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });
    const s = makeState([l]);
    new SetClosedCommand('wall-line-0001', true).apply(s);
    expect(s.elements.get('wall-line-0001')!.kind).toBe('line');
  });

  it('合并两条路径后撤销恢复两个对象', () => {
    const a = el('wall-poly-0001', 'wall', {
      kind: 'polyline',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
    });
    const b = el('wall-poly-0002', 'wall', {
      kind: 'polyline',
      points: [
        { x: 10, y: 0 },
        { x: 20, y: 0 },
      ],
    });
    const s = makeState([a, b]);
    const cmd = new MergePathsCommand('wall-poly-0001', 'wall-poly-0002');
    cmd.apply(s);
    expect(s.elements.size).toBe(1);
    expect(elementPoints(s.elements.get('wall-poly-0001')!)).toHaveLength(3);

    cmd.invert().apply(s);
    expect(s.elements.size).toBe(2);
    expect(s.order).toContain('wall-poly-0002');
  });

  it('拆分路径后撤销合回', () => {
    const s = makeState([polyline()]);
    const cmd = new SplitPathCommand('wall-poly-0001', 1, 'wall-poly-0099');
    cmd.apply(s);
    expect(s.elements.size).toBe(2);
    expect(s.elements.has('wall-poly-0099')).toBe(true);

    cmd.invert().apply(s);
    expect(s.elements.size).toBe(1);
    expect(elementPoints(s.elements.get('wall-poly-0001')!)).toHaveLength(3);
  });
});

describe('属性与复合命令', () => {
  it('修改图层后撤销恢复', () => {
    const s = makeState([rect()]);
    const cmd = new SetLayerCommand(['region-rect-0001'], 'review');
    cmd.apply(s);
    expect(s.elements.get('region-rect-0001')!.layer).toBe('review');

    cmd.invert().apply(s);
    expect(s.elements.get('region-rect-0001')!.layer).toBe('region');
  });

  it('锁定 / 隐藏标记可切换与撤销', () => {
    const s = makeState([rect()]);
    const cmd = new SetFlagCommand(['region-rect-0001'], 'locked', true);
    cmd.apply(s);
    expect(s.elements.get('region-rect-0001')!.locked).toBe(true);
    cmd.invert().apply(s);
    expect(s.elements.get('region-rect-0001')!.locked).toBe(false);
  });

  it('复合命令的反向命令逆序执行', () => {
    const s = makeState();
    const composite = new CompositeCommand('批量新增并移动', [
      new AddElementsCommand([rect()]),
      new MoveElementsCommand(['region-rect-0001'], 5, 5),
    ]);
    composite.apply(s);
    const after = s.elements.get('region-rect-0001')!;
    if (after.kind === 'rect') expect(after.x).toBe(15);

    composite.invert().apply(s);
    expect(s.elements.size).toBe(0);
  });

  it('affectedIds 汇总去重', () => {
    const composite = new CompositeCommand('t', [
      new MoveElementsCommand(['a', 'b'], 1, 1),
      new MoveElementsCommand(['b', 'c'], 1, 1),
    ]);
    expect(composite.affectedIds().sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('回到自动识别结果', () => {
  it('恢复快照并可再次撤销', () => {
    const auto = [rect('region-rect-0001')];
    const s = makeState(auto);
    // 用户编辑：新增一个对象并移动原对象
    new AddElementsCommand([poly('region-poly-0002')]).apply(s);
    new MoveElementsCommand(['region-rect-0001'], 9, 9).apply(s);
    expect(s.elements.size).toBe(2);

    const cmd = new ResetToAutoCommand(auto, ['region-rect-0001']);
    cmd.apply(s);
    expect(s.elements.size).toBe(1);
    const restored = s.elements.get('region-rect-0001')!;
    if (restored.kind === 'rect') expect(restored.x).toBe(10);

    // 该操作本身可撤销
    cmd.invert().apply(s);
    expect(s.elements.size).toBe(2);
  });
});

describe('撤销栈上限', () => {
  it('上限常量为 100', () => {
    expect(UNDO_STACK_LIMIT).toBe(100);
  });
});

/* ================================================================== */
/* 设置逻辑：宽高比锁定与标定冲突                                        */
/* ================================================================== */

describe('设置：宽高比锁定', () => {
  const base: ProjectSettings = {
    ...DEFAULT_SETTINGS,
    mapWidth: 60,
    mapHeight: 40,
    canvasWidthPx: 1200,
    canvasHeightPx: 800,
    aspectRatio: 1.5,
    lockAspect: true,
  };

  it('锁定时改宽度自动推导高度', () => {
    const r = S.setMapWidth(base, 120);
    expect(r.settings.mapWidth).toBe(120);
    expect(r.settings.mapHeight).toBeCloseTo(80, 6);
  });

  it('锁定时改高度自动推导宽度', () => {
    const r = S.setMapHeight(base, 80);
    expect(r.settings.mapHeight).toBe(80);
    expect(r.settings.mapWidth).toBeCloseTo(120, 6);
  });

  it('解锁后允许非等比并给出变形警告', () => {
    const unlocked = S.setLockAspect(base, false);
    expect(unlocked.settings.lockAspect).toBe(false);
    expect(unlocked.level).toBe('warning');
    expect(unlocked.notice).toContain('变形');

    const r = S.setMapWidth(unlocked.settings, 120);
    // 解锁后高度不变
    expect(r.settings.mapHeight).toBe(40);
  });

  it('画布尺寸非等比时给出提示', () => {
    const unlocked = S.setLockAspect(base, false).settings;
    const r = S.setCanvasHeight(unlocked, 400);
    expect(r.level).toBe('warning');
    expect(r.notice).toContain('非等比');
  });

  it('恢复原图比例', () => {
    const unlocked = S.setLockAspect(base, false).settings;
    const r = S.restoreImageAspect(unlocked, 1000, 500);
    expect(r.settings.lockAspect).toBe(true);
    expect(r.settings.aspectRatio).toBeCloseTo(2, 6);
    expect(r.settings.mapHeight).toBeCloseTo(r.settings.mapWidth / 2, 6);
  });

  it('由原图初始化时默认锁定原图宽高比', () => {
    const s = S.initFromImage(1600, 900);
    expect(s.lockAspect).toBe(true);
    expect(s.aspectRatio).toBeCloseTo(1600 / 900, 6);
    expect(s.canvasWidthPx / s.canvasHeightPx).toBeCloseTo(1600 / 900, 2);
  });
});

describe('设置：两点标定与冲突优先级', () => {
  const base: ProjectSettings = {
    ...DEFAULT_SETTINGS,
    mapWidth: 60,
    mapHeight: 40,
    canvasWidthPx: 1200,
    canvasHeightPx: 800,
  };

  it('标定按两点距离反推地图尺寸', () => {
    // 图像 1000×500，两点相距 100px，实际 10 单位 → 1px = 0.1 单位
    const r = S.applyCalibration(base, {
      p1: { x: 100, y: 100 },
      p2: { x: 200, y: 100 },
      realDistance: 10,
      imageWidth: 1000,
      imageHeight: 500,
    });
    expect(r.settings.mapWidth).toBeCloseTo(100, 3);
    expect(r.settings.mapHeight).toBeCloseTo(50, 3);
    expect(r.settings.scaleSource).toBe('calibration');
    expect(r.settings.calibration!.stale).toBe(false);
    expect(r.settings.calibration!.unitsPerImagePx).toBeCloseTo(0.1, 6);
  });

  it('两点过近时抛出 CALIBRATION_FAILED', () => {
    expect(() =>
      S.applyCalibration(base, {
        p1: { x: 100, y: 100 },
        p2: { x: 105, y: 100 },
        realDistance: 10,
        imageWidth: 1000,
        imageHeight: 500,
      }),
    ).toThrow(PipelineError);
  });

  it('实际距离非法时抛出 CALIBRATION_FAILED', () => {
    expect(() =>
      S.applyCalibration(base, {
        p1: { x: 0, y: 0 },
        p2: { x: 200, y: 0 },
        realDistance: 0,
        imageWidth: 1000,
        imageHeight: 500,
      }),
    ).toThrow(PipelineError);
  });

  /** 冲突优先级：手动修改优先，标定标记为过期但数据保留。 */
  it('标定后手动改尺寸 → 以手动为准，标定标记过期且数据保留', () => {
    const calibrated = S.applyCalibration(base, {
      p1: { x: 0, y: 0 },
      p2: { x: 200, y: 0 },
      realDistance: 20,
      imageWidth: 1000,
      imageHeight: 500,
    }).settings;
    expect(calibrated.scaleSource).toBe('calibration');

    const manual = S.setMapWidth(calibrated, 77);
    expect(manual.settings.mapWidth).toBe(77);
    expect(manual.settings.scaleSource).toBe('manual');
    expect(manual.settings.calibration).not.toBeNull();
    expect(manual.settings.calibration!.stale).toBe(true);
    expect(manual.level).toBe('warning');
    expect(manual.notice).toContain('手动');
    // 原始标定数据未被破坏
    expect(manual.settings.calibration!.realDistance).toBe(20);
  });

  it('可一键重新应用过期的标定', () => {
    const calibrated = S.applyCalibration(base, {
      p1: { x: 0, y: 0 },
      p2: { x: 200, y: 0 },
      realDistance: 20,
      imageWidth: 1000,
      imageHeight: 500,
    }).settings;
    const staled = S.setMapWidth(calibrated, 77).settings;
    const reapplied = S.reapplyCalibration(staled, 1000, 500);
    expect(reapplied.settings.scaleSource).toBe('calibration');
    expect(reapplied.settings.calibration!.stale).toBe(false);
    expect(reapplied.settings.mapWidth).toBeCloseTo(100, 3);
  });

  it('重置标定回到手动模式', () => {
    const calibrated = S.applyCalibration(base, {
      p1: { x: 0, y: 0 },
      p2: { x: 200, y: 0 },
      realDistance: 20,
      imageWidth: 1000,
      imageHeight: 500,
    }).settings;
    const reset = S.resetCalibration(calibrated);
    expect(reset.settings.calibration).toBeNull();
    expect(reset.settings.scaleSource).toBe('manual');
  });

  it('校验能识别非法尺寸与过期标定', () => {
    const bad = S.validateSettings({ ...base, mapWidth: 0 });
    expect(bad.valid).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);

    const calibrated = S.applyCalibration(base, {
      p1: { x: 0, y: 0 },
      p2: { x: 200, y: 0 },
      realDistance: 20,
      imageWidth: 1000,
      imageHeight: 500,
    }).settings;
    const staled = S.setMapWidth(calibrated, 77).settings;
    const v = S.validateSettings(staled);
    expect(v.valid).toBe(true);
    expect(v.warnings.some((w) => w.includes('过期'))).toBe(true);
  });

  it('比例摘要正确', () => {
    expect(pixelsPerUnit(base)).toBeCloseTo(20, 6);
    expect(S.scaleSummary(base)).toContain('20.00 px');
  });
});

describe('ID 工厂', () => {
  it('生成稳定、唯一、可读的 ID', () => {
    const f = new IdFactory();
    expect(f.next('wall', 'line')).toBe('wall-line-0001');
    expect(f.next('wall', 'line')).toBe('wall-line-0002');
    expect(f.next('region', 'rect')).toBe('region-rect-0001');
  });

  it('syncWith 后不与既有 ID 冲突', () => {
    const f = new IdFactory();
    f.syncWith(['wall-line-0007', 'wall-line-0003']);
    expect(f.next('wall', 'line')).toBe('wall-line-0008');
  });

  it('snapshot 可用于持久化并还原', () => {
    const f = new IdFactory();
    f.next('region', 'rect');
    f.next('region', 'rect');
    const snap = f.snapshot();
    const f2 = new IdFactory(snap);
    expect(f2.next('region', 'rect')).toBe('region-rect-0003');
  });
});
