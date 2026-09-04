/**
 * 预处理参数面板与对比预览。
 * 每项自动校正都可单独关闭并重置 —— 对应「用户可撤销自动校正」的要求。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, SlidersHorizontal, Sparkles } from 'lucide-react';
import { cn } from '../../lib/cn';
import { percent } from '../../lib/precision';
import { useProjectStore } from '../../store/useProjectStore';
import { DEFAULT_PREPROCESS } from '../../types/project';
import { PARAM_RANGES } from '../../core/pipeline/params';
import { Button, Panel, Segmented, Slider, Switch, Tooltip } from '../ui';
import type { PipelineRunner } from '../../hooks/usePipelineRunner';

/** 参数面板。 */
export function PreprocessControls({ runner }: { runner: PipelineRunner }) {
  const p = useProjectStore((s) => s.preprocess);
  const setPreprocess = useProjectStore((s) => s.setPreprocess);
  const resetPreprocess = useProjectStore((s) => s.resetPreprocess);
  const source = useProjectStore((s) => s.source);
  const running = useProjectStore((s) => s.run.running);

  // 参数变化后自动重跑预处理预览（防抖）
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (source === null) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => runner.runPreprocessPreview(), 260);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [p, source, runner]);

  const resetOne = useCallback(
    (key: keyof typeof DEFAULT_PREPROCESS) => (
      <button
        type="button"
        onClick={() => setPreprocess({ [key]: DEFAULT_PREPROCESS[key] } as never)}
        className="shrink-0 cursor-pointer text-[10px] text-fg-dim transition-colors hover:text-brand"
      >
        重置
      </button>
    ),
    [setPreprocess],
  );

  if (source === null) return null;

  return (
    <Panel
      title="预处理"
      icon={<SlidersHorizontal size={12} />}
      collapsible
      action={
        <Tooltip text="把全部预处理参数恢复为预设默认值">
          <button
            type="button"
            onClick={resetPreprocess}
            className="flex cursor-pointer items-center gap-1 text-[10px] text-fg-dim transition-colors hover:text-brand"
          >
            <RotateCcw size={10} />
            全部重置
          </button>
        </Tooltip>
      }
    >
      <div className="space-y-3">
        <div>
          <p className="field-label">线条颜色</p>
          <Segmented
            value={p.darkStrokes ? 'dark' : 'light'}
            options={[
              { value: 'dark', label: '深色线条', title: '白纸黑线（常规）' },
              { value: 'light', label: '浅色线条', title: '深色底 + 浅色线' },
            ]}
            onChange={(v) => setPreprocess({ darkStrokes: v === 'dark' })}
          />
        </div>

        <div className="divider" />

        <Switch
          label="阴影抑制"
          checked={p.shadowSuppress > 0}
          onChange={(v) => setPreprocess({ shadowSuppress: v ? DEFAULT_PREPROCESS.shadowSuppress : 0 })}
          hint="用大核背景估计做除法归一化，拉平拍照光照不均"
          action={resetOne('shadowSuppress')}
        />
        {p.shadowSuppress > 0 && (
          <Slider
            label="抑制强度"
            value={p.shadowSuppress}
            min={0.05}
            max={1}
            step={0.05}
            onChange={(v) => setPreprocess({ shadowSuppress: v })}
            format={(v) => percent(v, 0)}
          />
        )}

        <Switch
          label="对比度增强"
          checked={p.contrastBoost > 0}
          onChange={(v) => setPreprocess({ contrastBoost: v ? DEFAULT_PREPROCESS.contrastBoost : 0 })}
          hint="分块直方图均衡（CLAHE 近似），提亮阴影区的浅淡笔画"
          action={resetOne('contrastBoost')}
        />
        {p.contrastBoost > 0 && (
          <Slider
            label="增强强度"
            value={p.contrastBoost}
            min={0.05}
            max={1}
            step={0.05}
            onChange={(v) => setPreprocess({ contrastBoost: v })}
            format={(v) => percent(v, 0)}
          />
        )}

        <div className="divider" />

        <Slider
          label="二值化窗口半径"
          value={p.thresholdRadius}
          min={PARAM_RANGES.thresholdRadius.min}
          max={PARAM_RANGES.thresholdRadius.max}
          step={PARAM_RANGES.thresholdRadius.step}
          onChange={(v) => setPreprocess({ thresholdRadius: v })}
          format={(v) => `${v} px`}
          hint="约为笔画宽度的 6~10 倍；过小会碎化笔画，过大退化为全局阈值"
        />
        <Slider
          label="二值化偏置"
          value={p.thresholdBias}
          min={PARAM_RANGES.thresholdBias.min}
          max={PARAM_RANGES.thresholdBias.max}
          step={PARAM_RANGES.thresholdBias.step}
          onChange={(v) => setPreprocess({ thresholdBias: v })}
          format={(v) => v.toFixed(2)}
          hint="值越大越保守（只保留更黑的笔画）；线条丢失时调小"
        />
        <Switch
          label="Otsu 全局兜底"
          checked={p.otsuFallback}
          onChange={(v) => setPreprocess({ otsuFallback: v })}
          hint="自适应结果异常（过稀 / 过密）时回退全局阈值，避免输出全黑或全白"
        />

        <div className="divider" />

        <Slider
          label="弥合断裂（闭运算）"
          value={p.denoiseClose}
          min={0}
          max={4}
          step={1}
          onChange={(v) => setPreprocess({ denoiseClose: v })}
          format={(v) => (v === 0 ? '关闭' : `${v} 次`)}
        />
        <Slider
          label="去除噪点（开运算）"
          value={p.denoiseOpen}
          min={0}
          max={4}
          step={1}
          onChange={(v) => setPreprocess({ denoiseOpen: v })}
          format={(v) => (v === 0 ? '关闭' : `${v} 次`)}
        />
        <Slider
          label="小噪点面积阈值"
          value={p.minBlobArea}
          min={0}
          max={200}
          step={2}
          onChange={(v) => setPreprocess({ minBlobArea: v })}
          format={(v) => (v === 0 ? '关闭' : `${v} px²`)}
          hint="小于此面积的孤立连通域视为噪点移除"
        />

        <div className="divider" />

        <Switch
          label="自动倾斜校正"
          checked={p.deskew}
          onChange={(v) => setPreprocess({ deskew: v })}
          hint="投影方差法，自动范围 ±15°；超出时会提示手动处理"
        />

        <Slider
          label="工作分辨率上限"
          value={p.maxWorkingSize}
          min={800}
          max={3000}
          step={100}
          onChange={(v) => setPreprocess({ maxWorkingSize: v })}
          format={(v) => `${v} px`}
          hint="长边超过此值会等比下采样；越大越慢但细节更多"
        />

        <Button
          variant="outline"
          className="w-full"
          disabled={running}
          icon={<Sparkles size={13} />}
          onClick={() => runner.runPreprocessPreview()}
        >
          {running ? '处理中…' : '刷新预览'}
        </Button>
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ */
/* 对比预览                                                            */
/* ------------------------------------------------------------------ */

/**
 * 原图 / 预处理图对比预览。
 * 中间分隔手柄可拖动，直观确认预处理是否保住了全部墙线。
 */
export function PreprocessPreview() {
  const source = useProjectStore((s) => s.source);
  const preview = useProjectStore((s) => s.preview);
  const running = useProjectStore((s) => s.run.running);
  const [split, setSplit] = useState(0.5);
  const [mode, setMode] = useState<'binary' | 'gray'>('binary');
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const binaryUrl = useBinaryPreviewUrl(preview, mode);

  const onPointerMove = useCallback((clientX: number): void => {
    const el = containerRef.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    const t = (clientX - rect.left) / rect.width;
    setSplit(Math.max(0.04, Math.min(0.96, t)));
  }, []);

  useEffect(() => {
    const move = (e: PointerEvent): void => {
      if (!dragging.current) return;
      onPointerMove(e.clientX);
    };
    const up = (): void => {
      dragging.current = false;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [onPointerMove]);

  if (source === null) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-3">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-fg">预处理对比</span>
          <span className="chip">拖动中间手柄对比</span>
        </div>
        <Segmented
          className="w-44"
          value={mode}
          options={[
            { value: 'binary', label: '二值图', title: '识别实际使用的输入' },
            { value: 'gray', label: '增强灰度', title: '对比度与阴影处理后的灰度图' },
          ]}
          onChange={setMode}
        />
      </div>

      <div
        ref={containerRef}
        className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-ink-600/70 bg-[#0d1219]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(46,61,80,0.35) 1px, transparent 1px), linear-gradient(90deg, rgba(46,61,80,0.35) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
      >
        {/* 原图（底层，铺满） */}
        <img
          src={source.dataUrl}
          alt="原始草图"
          className="no-drag absolute inset-0 h-full w-full object-contain"
        />

        {/* 预处理结果（上层，按 split 裁切） */}
        {binaryUrl !== null && (
          <div
            className="absolute inset-0 bg-[#0d1219]"
            style={{ clipPath: `inset(0 0 0 ${split * 100}%)` }}
          >
            <img
              src={binaryUrl}
              alt="预处理结果"
              className="no-drag absolute inset-0 h-full w-full object-contain"
              style={{ imageRendering: 'pixelated' }}
            />
          </div>
        )}

        {/* 分隔手柄 */}
        <div
          className="absolute inset-y-0 z-10 w-px cursor-col-resize bg-brand/70"
          style={{ left: `${split * 100}%` }}
          onPointerDown={(e) => {
            e.preventDefault();
            dragging.current = true;
          }}
        >
          <span className="absolute left-1/2 top-1/2 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-brand/70 bg-ink-800 shadow-glow">
            <span className="text-[9px] font-bold text-brand">⇔</span>
          </span>
        </div>

        <span className="absolute left-2 top-2 rounded bg-ink-900/80 px-1.5 py-0.5 text-[10px] font-medium text-fg-muted backdrop-blur">
          原图
        </span>
        <span className="absolute right-2 top-2 rounded bg-ink-900/80 px-1.5 py-0.5 text-[10px] font-medium text-brand backdrop-blur">
          {mode === 'binary' ? '二值化结果' : '增强灰度'}
        </span>

        {running && (
          <div className="absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden bg-ink-600">
            <div className="h-full w-1/3 animate-scan-band bg-brand-grad" />
          </div>
        )}

        {preview === null && !running && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-ink-900/50 backdrop-blur-sm">
            <p className="text-[12px] text-fg-muted">调整参数后将自动生成预览</p>
          </div>
        )}
      </div>

      {preview !== null && (
        <p className="shrink-0 text-center text-[10px] text-fg-dim">
          工作分辨率 {preview.binaryWidth} × {preview.binaryHeight} px
          {' · '}
          确认所有墙线都被完整保留后再进入下一步
        </p>
      )}
    </div>
  );
}

/**
 * 把二值 / 灰度缓冲渲染为可显示的 blob URL。
 * 使用 useMemo + 显式 revoke，避免频繁调参造成内存泄漏。
 */
function useBinaryPreviewUrl(
  preview: ReturnType<typeof useProjectStore.getState>['preview'],
  mode: 'binary' | 'gray',
): string | null {
  const [url, setUrl] = useState<string | null>(null);

  const key = useMemo(() => {
    if (preview === null) return null;
    return `${mode}:${preview.binaryWidth}x${preview.binaryHeight}:${preview.binaryData.length}:${preview.grayData.length}`;
  }, [preview, mode]);

  useEffect(() => {
    if (preview === null || key === null) {
      setUrl(null);
      return;
    }

    const w = mode === 'binary' ? preview.binaryWidth : preview.grayWidth;
    const h = mode === 'binary' ? preview.binaryHeight : preview.grayHeight;
    if (w <= 0 || h <= 0) {
      setUrl(null);
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
      setUrl(null);
      return;
    }

    const rgba = new Uint8ClampedArray(w * h * 4);
    if (mode === 'binary') {
      const d = preview.binaryData;
      for (let i = 0; i < w * h; i++) {
        const on = d[i] !== 0;
        const o = i * 4;
        // 前景用青蓝，背景深底，便于与原图叠加对比
        rgba[o] = on ? 0x22 : 0x0d;
        rgba[o + 1] = on ? 0xd3 : 0x12;
        rgba[o + 2] = on ? 0xee : 0x19;
        rgba[o + 3] = 255;
      }
    } else {
      const d = preview.grayData;
      for (let i = 0; i < w * h; i++) {
        const v = d[i] ?? 0;
        const o = i * 4;
        rgba[o] = v;
        rgba[o + 1] = v;
        rgba[o + 2] = v;
        rgba[o + 3] = 255;
      }
    }
    ctx.putImageData(new ImageData(rgba, w, h), 0, 0);

    let revoked = false;
    let created: string | null = null;
    canvas.toBlob((blob) => {
      if (blob === null || revoked) return;
      created = URL.createObjectURL(blob);
      setUrl(created);
    }, 'image/png');

    return () => {
      revoked = true;
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [key, preview, mode]);

  return url;
}

export { cn };
