/**
 * 两点标定的画布内拾取层。
 * 显示带箭头的测量线与实际距离输入气泡。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import { unitSymbol } from '../../types/project';
import * as S from '../../core/project/settings';
import { PipelineError } from '../../types/errors';
import type { Point } from '../../types/vector';
import { Button } from '../ui';

interface CalibrationOverlayProps {
  /** 底图在容器内的显示区域（用于把屏幕坐标换算到图像像素坐标）。 */
  imageRect: { left: number; top: number; width: number; height: number };
  /** 工作图像的像素尺寸。 */
  imageWidth: number;
  imageHeight: number;
  onDone: () => void;
  onCancel: () => void;
}

export function CalibrationOverlay({
  imageRect,
  imageWidth,
  imageHeight,
  onDone,
  onCancel,
}: CalibrationOverlayProps) {
  const settings = useProjectStore((s) => s.settings);
  const apply = useProjectStore((s) => s.applySettingsChange);
  const notify = useProjectStore((s) => s.notify);

  const [p1, setP1] = useState<Point | null>(null);
  const [p2, setP2] = useState<Point | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [distanceText, setDistanceText] = useState('10');
  const inputRef = useRef<HTMLInputElement>(null);

  const sym = unitSymbol(settings.unit);

  /** 屏幕坐标 → 图像像素坐标。 */
  const toImage = useCallback(
    (clientX: number, clientY: number): Point => {
      const tx = (clientX - imageRect.left) / Math.max(1, imageRect.width);
      const ty = (clientY - imageRect.top) / Math.max(1, imageRect.height);
      return { x: tx * imageWidth, y: ty * imageHeight };
    },
    [imageRect, imageWidth, imageHeight],
  );

  /** 图像像素坐标 → 容器内屏幕百分比（用于绘制）。 */
  const toScreen = useCallback(
    (p: Point): { left: number; top: number } => ({
      left: imageRect.left + (p.x / Math.max(1, imageWidth)) * imageRect.width,
      top: imageRect.top + (p.y / Math.max(1, imageHeight)) * imageRect.height,
    }),
    [imageRect, imageWidth, imageHeight],
  );

  useEffect(() => {
    if (p1 !== null && p2 !== null) {
      // 两点齐备后自动聚焦距离输入
      window.setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [p1, p2]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const commit = useCallback((): void => {
    if (p1 === null || p2 === null) return;
    const realDistance = Number.parseFloat(distanceText);
    const change = ((): S.SettingsChange | null => {
      try {
        return S.applyCalibration(settings, {
          p1,
          p2,
          realDistance,
          imageWidth,
          imageHeight,
        });
      } catch (e) {
        if (e instanceof PipelineError) {
          notify(
            e.code === 'CALIBRATION_FAILED' && typeof e.detail?.pixelDistance === 'number'
              ? `两点距离仅 ${e.detail.pixelDistance} 像素，过近会放大比例误差。请选择相距至少 ${S.MIN_CALIBRATION_PIXELS} 像素的两点。`
              : e.message,
            'error',
          );
        } else {
          console.error('[calibrate] 应用标定失败', e);
        }
        return null;
      }
    })();

    if (change === null) return;
    apply(change);
    onDone();
  }, [p1, p2, distanceText, settings, imageWidth, imageHeight, apply, notify, onDone]);

  const pixelDistance = p1 !== null && p2 !== null ? Math.hypot(p2.x - p1.x, p2.y - p1.y) : 0;
  const liveDistance = p1 !== null && cursor !== null ? Math.hypot(cursor.x - p1.x, cursor.y - p1.y) : 0;

  const a = p1 !== null ? toScreen(p1) : null;
  const b = p2 !== null ? toScreen(p2) : p1 !== null && cursor !== null ? toScreen(cursor) : null;

  return (
    <div
      className="absolute inset-0 z-30 cursor-crosshair"
      onPointerMove={(e) => {
        if (p2 !== null) return;
        setCursor(toImage(e.clientX, e.clientY));
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        const p = toImage(e.clientX, e.clientY);
        if (p1 === null) {
          setP1(p);
          return;
        }
        if (p2 === null) {
          setP2(p);
        }
      }}
    >
      {/* 半透明遮罩，突出拾取态 */}
      <div className="absolute inset-0 bg-ink-900/25" />

      {/* 测量线 */}
      {a !== null && b !== null && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          <defs>
            <marker id="cal-arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L6,3 L0,6 Z" fill="#22D3EE" />
            </marker>
          </defs>
          <line
            x1={a.left}
            y1={a.top}
            x2={b.left}
            y2={b.top}
            stroke="#22D3EE"
            strokeWidth={1.6}
            strokeDasharray="5 3"
            markerEnd="url(#cal-arrow)"
            markerStart="url(#cal-arrow)"
          />
        </svg>
      )}

      {/* 端点标记 */}
      {a !== null && <PointMarker left={a.left} top={a.top} index={1} />}
      {p2 !== null && b !== null && <PointMarker left={b.left} top={b.top} index={2} />}

      {/* 提示 / 输入气泡 */}
      <div className="pointer-events-auto absolute left-1/2 top-4 -translate-x-1/2">
        {p1 === null && (
          <div className="glass-pill animate-fade-up">
            <span className="text-[12px] text-fg">点击第 1 个点</span>
            <span className="text-[10px] text-fg-dim">Esc 取消</span>
          </div>
        )}
        {p1 !== null && p2 === null && (
          <div className="glass-pill animate-fade-up">
            <span className="text-[12px] text-fg">点击第 2 个点</span>
            <span className="tabular text-[10px] text-brand">{liveDistance.toFixed(1)} px</span>
            <span className="text-[10px] text-fg-dim">Esc 取消</span>
          </div>
        )}
        {p1 !== null && p2 !== null && (
          <div className="animate-fade-up flex items-center gap-2 rounded-full border border-brand/50 bg-ink-800/92 px-3 py-2 shadow-glow backdrop-blur-md">
            <span className="tabular text-[11px] text-fg-muted">
              {pixelDistance.toFixed(1)} px =
            </span>
            <input
              ref={inputRef}
              type="number"
              step="0.1"
              min="0.001"
              value={distanceText}
              onChange={(e) => setDistanceText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
              }}
              className="tabular h-7 w-20 rounded border border-ink-500 bg-ink-900 px-1.5 text-center text-[12px]
                         font-semibold text-brand outline-none focus:border-brand"
            />
            <span className="text-[11px] font-medium text-fg-muted">{sym}</span>
            <Button variant="primary" className="h-7 px-2" icon={<Check size={13} />} onClick={commit}>
              应用
            </Button>
            <Button
              variant="ghost"
              className="h-7 px-2"
              onClick={() => {
                setP1(null);
                setP2(null);
                setCursor(null);
              }}
            >
              重选
            </Button>
            <button
              type="button"
              onClick={onCancel}
              aria-label="取消标定"
              className="cursor-pointer text-fg-dim transition-colors hover:text-danger"
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function PointMarker({ left, top, index }: { left: number; top: number; index: number }) {
  return (
    <span
      className="pointer-events-none absolute flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center
                 justify-center rounded-full border-2 border-brand bg-ink-900 text-[9px] font-bold text-brand"
      style={{ left, top }}
    >
      {index}
      <span className="absolute inset-0 animate-pulse-ring rounded-full bg-brand/40" />
    </span>
  );
}
