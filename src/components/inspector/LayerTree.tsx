/**
 * 图层树：按 LayerKind 分组的对象列表，支持显隐与锁定。
 */

import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Eye, EyeOff, Layers, Lock, LockOpen } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useEditorStore } from '../../store/useEditorStore';
import {
  LAYER_KINDS,
  LAYER_LABELS,
  VECTOR_KIND_LABELS,
  elementNodeCount,
  type LayerKind,
  type VectorElement,
} from '../../types/vector';
import { SetFlagCommand } from '../../store/commands';
import { LOW_CONFIDENCE_THRESHOLD } from '../../core/recognize/confidence';
import { IconButton, Panel } from '../ui';

const LAYER_DOT: Record<LayerKind, string> = {
  boundary: 'bg-brand',
  wall: 'bg-[#C6D4E3]',
  region: 'bg-[#0EA5E9]',
  review: 'bg-warn',
};

export function LayerTree() {
  const elements = useEditorStore((s) => s.elements);
  const order = useEditorStore((s) => s.order);
  const revision = useEditorStore((s) => s.revision);
  const selection = useEditorStore((s) => s.selection);
  const layerVisible = useEditorStore((s) => s.layerVisible);
  const layerLocked = useEditorStore((s) => s.layerLocked);
  const setLayerVisible = useEditorStore((s) => s.setLayerVisible);
  const setLayerLocked = useEditorStore((s) => s.setLayerLocked);
  const selectElements = useEditorStore((s) => s.selectElements);
  const execute = useEditorStore((s) => s.execute);

  const grouped = useMemo(() => {
    const map = new Map<LayerKind, VectorElement[]>();
    for (const k of LAYER_KINDS) map.set(k, []);
    for (const id of order) {
      const el = elements.get(id);
      if (el === undefined) continue;
      map.get(el.layer)?.push(el);
    }
    return map;
  }, [order, elements, revision]);

  const [open, setOpen] = useState<Record<string, boolean>>({
    boundary: true,
    wall: false,
    region: true,
    review: true,
  });

  const total = order.length;

  return (
    <Panel title={`对象图层 (${total})`} icon={<Layers size={12} />} collapsible bodyClassName="p-0">
      <div className="max-h-[42vh] overflow-y-auto">
        {LAYER_KINDS.map((layer) => {
          const items = grouped.get(layer) ?? [];
          const isOpen = open[layer] === true;
          const visible = layerVisible[layer] !== false;
          const locked = layerLocked[layer] === true;

          return (
            <div key={layer} className="border-b border-ink-600/40 last:border-b-0">
              <div className="flex items-center gap-1 px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => setOpen({ ...open, [layer]: !isOpen })}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
                >
                  {isOpen ? <ChevronDown size={12} className="text-fg-dim" /> : <ChevronRight size={12} className="text-fg-dim" />}
                  <span className={cn('h-2 w-2 shrink-0 rounded-full', LAYER_DOT[layer])} />
                  <span
                    className={cn(
                      'truncate text-[11px] font-medium',
                      visible ? 'text-fg' : 'text-fg-dim line-through',
                    )}
                  >
                    {LAYER_LABELS[layer]}
                  </span>
                  <span className="tabular shrink-0 rounded bg-ink-600/70 px-1 text-[9px] font-semibold text-fg-muted">
                    {items.length}
                  </span>
                </button>
                <IconButton
                  label={visible ? '隐藏图层' : '显示图层'}
                  className="h-6 w-6"
                  onClick={() => setLayerVisible(layer, !visible)}
                >
                  {visible ? <Eye size={12} /> : <EyeOff size={12} />}
                </IconButton>
                <IconButton
                  label={locked ? '解锁图层' : '锁定图层'}
                  className="h-6 w-6"
                  active={locked}
                  onClick={() => setLayerLocked(layer, !locked)}
                >
                  {locked ? <Lock size={12} /> : <LockOpen size={12} />}
                </IconButton>
              </div>

              {isOpen && items.length > 0 && (
                <ul className="pb-1">
                  {items.map((el) => {
                    const isSelected = selection.elementIds.includes(el.id);
                    const low = el.confidence < LOW_CONFIDENCE_THRESHOLD;
                    return (
                      <li key={el.id}>
                        <div
                          className={cn(
                            'group flex items-center gap-1 pl-6 pr-1.5 transition-colors',
                            isSelected ? 'bg-brand/12' : 'hover:bg-ink-600/35',
                          )}
                        >
                          <button
                            type="button"
                            onClick={(e) => selectElements([el.id], e.shiftKey)}
                            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-1 text-left"
                          >
                            <span
                              className={cn(
                                'tabular truncate text-[10px]',
                                isSelected ? 'font-semibold text-brand' : 'text-fg-muted',
                              )}
                            >
                              {el.id}
                            </span>
                            <span className="shrink-0 text-[9px] text-fg-dim">
                              {VECTOR_KIND_LABELS[el.kind]} · {elementNodeCount(el)}点
                            </span>
                            {low && (
                              <span className="shrink-0 rounded bg-warn/18 px-1 text-[8px] font-bold text-warn">
                                {Math.round(el.confidence * 100)}%
                              </span>
                            )}
                            {el.source === 'manual' && (
                              <span className="shrink-0 rounded bg-accent2/18 px-1 text-[8px] font-bold text-accent2">
                                手动
                              </span>
                            )}
                          </button>
                          <IconButton
                            label={el.hidden === true ? '显示' : '隐藏'}
                            className="h-5 w-5 opacity-0 group-hover:opacity-100"
                            onClick={() => execute(new SetFlagCommand([el.id], 'hidden', el.hidden !== true))}
                          >
                            {el.hidden === true ? <EyeOff size={10} /> : <Eye size={10} />}
                          </IconButton>
                          <IconButton
                            label={el.locked === true ? '解锁' : '锁定'}
                            className="h-5 w-5 opacity-0 group-hover:opacity-100"
                            onClick={() => execute(new SetFlagCommand([el.id], 'locked', el.locked !== true))}
                          >
                            {el.locked === true ? <Lock size={10} /> : <LockOpen size={10} />}
                          </IconButton>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              {isOpen && items.length === 0 && (
                <p className="px-6 pb-2 text-[10px] text-fg-dim">该图层暂无对象</p>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
