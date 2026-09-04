/**
 * 画布悬浮工具条与状态栏。
 */

import { Grid3x3, Hand, Magnet, Maximize, MousePointer2, PenLine, SquareDot, Target, ZoomIn, ZoomOut } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useEditorStore } from '../../store/useEditorStore';
import { useProjectStore } from '../../store/useProjectStore';
import { unitSymbol } from '../../types/project';
import { TOOL_LABELS, type ToolKind } from '../../types/editor';
import { displayNumber } from '../../lib/precision';
import { pixelsPerUnit } from '../../types/project';
import type { ViewportApi } from '../../editor/EditorCanvas';
import { IconButton, Slider, Tooltip } from '../ui';

const TOOLS: Array<{ kind: ToolKind; icon: React.ReactNode; hotkey: string }> = [
  { kind: 'select', icon: <MousePointer2 size={15} />, hotkey: 'V' },
  { kind: 'node', icon: <SquareDot size={15} />, hotkey: 'N' },
  { kind: 'draw', icon: <PenLine size={15} />, hotkey: 'P' },
  { kind: 'pan', icon: <Hand size={15} />, hotkey: 'H' },
];

/** 左侧竖排工具条。 */
export function CanvasToolbar({ api }: { api: ViewportApi | null }) {
  const tool = useEditorStore((s) => s.tool);
  const setTool = useEditorStore((s) => s.setTool);

  return (
    <div className="absolute left-3 top-3 z-20 flex flex-col gap-1 rounded-lg border border-ink-600/70 bg-ink-800/80 p-1 shadow-panel backdrop-blur-md">
      {TOOLS.map((t) => (
        <Tooltip key={t.kind} text={`${TOOL_LABELS[t.kind]}（${t.hotkey}）`}>
          <IconButton label={TOOL_LABELS[t.kind]} active={tool === t.kind} onClick={() => setTool(t.kind)}>
            {t.icon}
          </IconButton>
        </Tooltip>
      ))}

      <span className="my-0.5 h-px w-full bg-ink-600" />

      <Tooltip text="放大">
        <IconButton label="放大" onClick={() => api?.zoomBy(1.25)}>
          <ZoomIn size={15} />
        </IconButton>
      </Tooltip>
      <Tooltip text="缩小">
        <IconButton label="缩小" onClick={() => api?.zoomBy(1 / 1.25)}>
          <ZoomOut size={15} />
        </IconButton>
      </Tooltip>
      <Tooltip text="适应窗口">
        <IconButton label="适应窗口" onClick={() => api?.fitToContent()}>
          <Maximize size={15} />
        </IconButton>
      </Tooltip>
    </div>
  );
}

/** 底部状态栏：缩放、坐标、比例、吸附开关。 */
export function CanvasStatusBar({ cursorUnit }: { cursorUnit: { x: number; y: number } | null }) {
  const viewport = useEditorStore((s) => s.viewport);
  const snap = useEditorStore((s) => s.snap);
  const setSnap = useEditorStore((s) => s.setSnap);
  const snapSuspended = useEditorStore((s) => s.snapSuspended);
  const backdrop = useEditorStore((s) => s.backdrop);
  const setBackdrop = useEditorStore((s) => s.setBackdrop);
  const settings = useProjectStore((s) => s.settings);

  const sym = unitSymbol(settings.unit);
  const ppu = pixelsPerUnit(settings);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex flex-wrap items-center justify-center gap-2 px-3">
      {/* 缩放与坐标 */}
      <div className="glass-pill pointer-events-auto">
        <span className="tabular text-[10px] font-semibold text-brand">
          {/* 缩放百分比定义为「1 导出像素 = 1 屏幕像素」时为 100%。
              viewport.scale 的单位是「屏幕像素 / 地图单位」，
              因此需除以 pixelsPerUnit（导出像素 / 地图单位）才是像素级缩放比。 */}
          {((viewport.scale / Math.max(ppu, 1e-6)) * 100).toFixed(0)}%
        </span>
        <span className="h-3 w-px bg-ink-600" />
        {cursorUnit !== null ? (
          <span className="tabular text-[10px] text-fg-muted">
            {displayNumber(cursorUnit.x)}, {displayNumber(cursorUnit.y)} {sym}
            <span className="ml-1.5 text-fg-dim">
              ({(cursorUnit.x * ppu).toFixed(0)}, {(cursorUnit.y * ppu).toFixed(0)} px)
            </span>
          </span>
        ) : (
          <span className="text-[10px] text-fg-dim">移动光标查看坐标</span>
        )}
        <span className="h-3 w-px bg-ink-600" />
        <span className="tabular text-[10px] text-fg-muted">
          1 {sym} = {ppu.toFixed(2)} px
        </span>
      </div>

      {/* 吸附开关组 */}
      <div className="glass-pill pointer-events-auto">
        <Tooltip text={snapSuspended ? '按住 Alt 期间吸附已临时关闭' : '总开关（按住 Alt 临时关闭）'}>
          <button
            type="button"
            onClick={() => setSnap({ enabled: !snap.enabled })}
            className={cn(
              'flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
              snapSuspended
                ? 'text-fg-dim line-through'
                : snap.enabled
                  ? 'bg-brand/18 text-brand'
                  : 'text-fg-dim hover:text-fg',
            )}
          >
            <Magnet size={11} />
            吸附
          </button>
        </Tooltip>
        <Tooltip text="端点吸附：让墙线端点精确共享坐标">
          <button
            type="button"
            onClick={() => setSnap({ endpoint: !snap.endpoint })}
            className={cn(
              'cursor-pointer rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
              snap.endpoint ? 'bg-brand/18 text-brand' : 'text-fg-dim hover:text-fg',
            )}
          >
            端点
          </button>
        </Tooltip>
        <Tooltip text="角度吸附：拉正为水平 / 垂直 / 45° 等">
          <button
            type="button"
            onClick={() => setSnap({ angle: !snap.angle })}
            className={cn(
              'cursor-pointer rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
              snap.angle ? 'bg-brand/18 text-brand' : 'text-fg-dim hover:text-fg',
            )}
          >
            角度
          </button>
        </Tooltip>
        <Tooltip text={`网格吸附（G）· 间距 ${snap.gridSize} ${sym}`}>
          <button
            type="button"
            onClick={() => setSnap({ grid: !snap.grid })}
            className={cn(
              'flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
              snap.grid ? 'bg-brand/18 text-brand' : 'text-fg-dim hover:text-fg',
            )}
          >
            <Grid3x3 size={11} />
            网格
          </button>
        </Tooltip>
      </div>

      {/* 底图控制 */}
      <div className="glass-pill pointer-events-auto min-w-[230px]">
        <div className="flex gap-0.5">
          {(
            [
              { v: 'source', label: '原图' },
              { v: 'preprocessed', label: '预处理' },
              { v: 'none', label: '关闭' },
            ] as const
          ).map((o) => (
            <button
              key={o.v}
              type="button"
              onClick={() => setBackdrop({ mode: o.v })}
              className={cn(
                'cursor-pointer rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
                backdrop.mode === o.v ? 'bg-brand/18 text-brand' : 'text-fg-dim hover:text-fg',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        {backdrop.mode !== 'none' && (
          <div className="min-w-[86px] flex-1">
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={backdrop.opacity}
              onChange={(e) => setBackdrop({ opacity: Number.parseFloat(e.target.value) })}
              title={`底图不透明度 ${(backdrop.opacity * 100).toFixed(0)}%`}
              className="h-1 w-full cursor-pointer appearance-none rounded-full bg-ink-600
                         [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5
                         [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full
                         [&::-webkit-slider-thumb]:bg-brand"
            />
          </div>
        )}
        <span className="h-3 w-px bg-ink-600" />
        <Tooltip text="显示 / 隐藏矢量结果">
          <button
            type="button"
            onClick={() => setBackdrop({ showVectors: !backdrop.showVectors })}
            className={cn(
              'cursor-pointer rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
              backdrop.showVectors ? 'bg-brand/18 text-brand' : 'text-fg-dim hover:text-fg',
            )}
          >
            矢量
          </button>
        </Tooltip>
        <Tooltip text="显示 / 隐藏问题高亮">
          <button
            type="button"
            onClick={() => setBackdrop({ showIssues: !backdrop.showIssues })}
            className={cn(
              'cursor-pointer rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors',
              backdrop.showIssues ? 'bg-warn/18 text-warn' : 'text-fg-dim hover:text-fg',
            )}
          >
            问题
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

/** 网格间距设置（编辑步骤左栏使用）。 */
export function SnapSettings() {
  const snap = useEditorStore((s) => s.snap);
  const setSnap = useEditorStore((s) => s.setSnap);
  const settings = useProjectStore((s) => s.settings);
  const sym = unitSymbol(settings.unit);

  return (
    <div className="space-y-2.5">
      <Slider
        label="网格间距"
        value={snap.gridSize}
        min={0.1}
        max={Math.max(1, Math.round(settings.mapWidth / 8))}
        step={0.1}
        onChange={(v) => setSnap({ gridSize: v })}
        format={(v) => `${v.toFixed(1)} ${sym}`}
      />
      <Slider
        label="端点吸附半径"
        value={snap.endpointRadiusPx}
        min={2}
        max={30}
        step={1}
        onChange={(v) => setSnap({ endpointRadiusPx: v })}
        format={(v) => `${v} px`}
        hint="屏幕像素，随缩放自动换算"
      />
      <Slider
        label="角度吸附容差"
        value={snap.angleTolerance}
        min={0}
        max={20}
        step={0.5}
        onChange={(v) => setSnap({ angleTolerance: v })}
        format={(v) => `${v.toFixed(1)}°`}
      />
      <p className="text-[10px] leading-snug text-fg-dim">
        按住 <b className="text-fg-muted">Alt</b> 可临时关闭全部吸附。
      </p>
    </div>
  );
}

export { Target };
