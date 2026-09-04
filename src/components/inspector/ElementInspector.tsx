/**
 * 对象检查器：类型、坐标、节点数、置信度与基础属性编辑。
 */

import { useMemo } from 'react';
import { Combine, Radius, Scissors, SquareDot, Unlink } from 'lucide-react';
import { useEditorStore } from '../../store/useEditorStore';
import { useProjectStore } from '../../store/useProjectStore';
import {
  LAYER_KINDS,
  LAYER_LABELS,
  VECTOR_KIND_LABELS,
  elementBounds,
  elementNodeCount,
  elementPoints,
  isClosedKind,
  type LayerKind,
} from '../../types/vector';
import { unitSymbol } from '../../types/project';
import { area, perimeter } from '../../core/geometry/polygon';
import { displayNumber } from '../../lib/precision';
import { MergePathsCommand, SetClosedCommand, SetLayerCommand, SplitPathCommand } from '../../store/commands';
import { idFactory } from '../../lib/id';
import { ConfidenceRing, Panel, Select, Stat, Button, Tooltip } from '../ui';

export function ElementInspector() {
  const selected = useEditorStore((s) => s.selection.elementIds);
  const selectedNodes = useEditorStore((s) => s.selection.nodes);
  const elements = useEditorStore((s) => s.elements);
  const revision = useEditorStore((s) => s.revision);
  const execute = useEditorStore((s) => s.execute);
  const issuesOf = useEditorStore((s) => s.issuesOf);
  const settings = useProjectStore((s) => s.settings);
  const notify = useProjectStore((s) => s.notify);

  const sym = unitSymbol(settings.unit);

  const els = useMemo(
    () => selected.map((id) => elements.get(id)).filter((e): e is NonNullable<typeof e> => e !== undefined),
    [selected, elements, revision],
  );

  if (els.length === 0) {
    return (
      <Panel title="检查器" icon={<SquareDot size={12} />}>
        <p className="py-3 text-center text-[11px] text-fg-muted">未选中对象</p>
        <div className="rounded-md border border-ink-600/60 bg-ink-900/40 p-2">
          <p className="text-[10px] font-semibold text-fg-muted">快捷键</p>
          <ul className="mt-1 space-y-0.5 text-[10px] leading-relaxed text-fg-dim">
            <li><b className="text-fg-muted">V</b> 选择 · <b className="text-fg-muted">N</b> 节点 · <b className="text-fg-muted">P</b> 绘制 · <b className="text-fg-muted">H</b> 平移</li>
            <li><b className="text-fg-muted">G</b> 网格吸附 · 按住 <b className="text-fg-muted">Alt</b> 临时关闭吸附</li>
            <li>节点模式下 <b className="text-fg-muted">Alt+点击边</b> 插入节点</li>
            <li><b className="text-fg-muted">Del</b> 删除 · <b className="text-fg-muted">Ctrl+D</b> 复制 · <b className="text-fg-muted">Ctrl+A</b> 全选</li>
            <li>绘制中：<b className="text-fg-muted">Enter</b> 结束 · <b className="text-fg-muted">C</b> 闭合</li>
          </ul>
        </div>
      </Panel>
    );
  }

  /* 多选：只显示汇总与批量操作 */
  if (els.length > 1) {
    const avgConfidence = els.reduce((s, e) => s + e.confidence, 0) / els.length;
    const totalNodes = els.reduce((s, e) => s + elementNodeCount(e), 0);
    const openPaths = els.filter((e) => !isClosedKind(e.kind));

    return (
      <Panel title={`检查器 · ${els.length} 个对象`} icon={<SquareDot size={12} />}>
        <div className="space-y-2.5">
          <div className="flex items-center gap-3">
            <ConfidenceRing value={avgConfidence} />
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-fg-muted">平均置信度</p>
              <p className="tabular text-[13px] font-semibold text-fg">
                {(avgConfidence * 100).toFixed(0)}%
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            <Stat label="对象数" value={String(els.length)} />
            <Stat label="总节点数" value={String(totalNodes)} />
          </div>

          <Select<LayerKind>
            label="批量设置图层"
            value={els[0]!.layer}
            options={LAYER_KINDS.map((k) => ({ value: k, label: LAYER_LABELS[k] }))}
            onChange={(layer) => execute(new SetLayerCommand(selected, layer))}
          />

          {els.length === 2 && openPaths.length === 2 && (
            <Button
              variant="outline"
              className="w-full"
              icon={<Combine size={13} />}
              onClick={() => {
                execute(new MergePathsCommand(els[0]!.id, els[1]!.id));
                notify('已合并两条路径（按最近端点自动定向）。', 'success');
              }}
            >
              合并这两条路径
            </Button>
          )}
        </div>
      </Panel>
    );
  }

  /* 单选：完整属性 */
  const el = els[0]!;
  const pts = elementPoints(el);
  const b = elementBounds(el);
  const closed = isClosedKind(el.kind);
  const elIssues = issuesOf(el.id);
  const nodeIndex = selectedNodes.find((n) => n.elementId === el.id)?.index;

  return (
    <Panel title="检查器" icon={<SquareDot size={12} />}>
      <div className="space-y-2.5">
        <div className="flex items-center gap-3">
          <ConfidenceRing value={el.confidence} />
          <div className="min-w-0 flex-1">
            <p className="tabular truncate text-[12px] font-semibold text-fg" title={el.id}>
              {el.id}
            </p>
            <p className="mt-0.5 text-[10px] text-fg-muted">
              {VECTOR_KIND_LABELS[el.kind]} · {LAYER_LABELS[el.layer]}
            </p>
            <p className="mt-0.5 text-[10px] text-fg-dim">
              {el.source === 'auto' ? '自动识别' : '手动创建 / 已编辑'}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          <Stat label="节点数" value={String(pts.length)} accent={pts.length <= 6} />
          <Stat label={closed ? '面积' : '长度'} value={
            closed
              ? `${displayNumber(area(pts))} ${sym}²`
              : `${displayNumber(perimeter(pts, false))} ${sym}`
          } />
          <Stat label="宽度" value={`${displayNumber(b.maxX - b.minX)} ${sym}`} />
          <Stat label="高度" value={`${displayNumber(b.maxY - b.minY)} ${sym}`} />
        </div>

        <div className="rounded-md border border-ink-600/60 bg-ink-900/40 p-2">
          <p className="mb-1 text-[10px] font-semibold text-fg-muted">位置（{sym}）</p>
          <p className="tabular text-[10px] leading-relaxed text-fg-dim">
            左上 ({displayNumber(b.minX)}, {displayNumber(b.minY)})
            <br />
            右下 ({displayNumber(b.maxX)}, {displayNumber(b.maxY)})
          </p>
          {nodeIndex !== undefined && pts[nodeIndex] !== undefined && (
            <p className="tabular mt-1.5 border-t border-ink-600/50 pt-1.5 text-[10px] text-brand">
              选中节点 #{nodeIndex}: ({displayNumber(pts[nodeIndex]!.x)}, {displayNumber(pts[nodeIndex]!.y)})
            </p>
          )}
        </div>

        <Select<LayerKind>
          label="所属图层"
          value={el.layer}
          options={LAYER_KINDS.map((k) => ({ value: k, label: LAYER_LABELS[k] }))}
          onChange={(layer) => execute(new SetLayerCommand([el.id], layer))}
        />

        {/* 路径操作 */}
        <div className="space-y-1.5">
          <p className="field-label">路径操作</p>
          {closed ? (
            <Tooltip text="把封闭路径打开为开放路径（会失去填充）">
              <Button
                variant="outline"
                className="w-full"
                icon={<Unlink size={13} />}
                onClick={() => execute(new SetClosedCommand(el.id, false))}
              >
                打开路径
              </Button>
            </Tooltip>
          ) : (
            <Tooltip text="首尾相接使其成为封闭区域（可填充、可作为房间）">
              <Button
                variant="outline"
                className="w-full"
                icon={<Radius size={13} />}
                disabled={pts.length < 3}
                onClick={() => execute(new SetClosedCommand(el.id, true))}
              >
                闭合路径
              </Button>
            </Tooltip>
          )}

          {nodeIndex !== undefined && nodeIndex > 0 && nodeIndex < pts.length - 1 && !closed && (
            <Button
              variant="outline"
              className="w-full"
              icon={<Scissors size={13} />}
              onClick={() => {
                const newId = idFactory.next(el.layer, 'polyline');
                execute(new SplitPathCommand(el.id, nodeIndex, newId));
                notify(`已在节点 #${nodeIndex} 处拆分为两条路径。`, 'success');
              }}
            >
              在选中节点处拆分
            </Button>
          )}
        </div>

        {elIssues.length > 0 && (
          <div className="rounded-md border border-warn/35 bg-warn/6 p-2">
            <p className="text-[10px] font-semibold text-warn">该对象的问题（{elIssues.length}）</p>
            <ul className="mt-1 space-y-1">
              {elIssues.map((i) => (
                <li key={i.id} className="text-[10px] leading-snug text-fg-muted">
                  · {i.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  );
}
