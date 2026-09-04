/**
 * 草图导入面板：拖拽上传、格式校验、旋转 / 裁剪 / 透视入口。
 */

import { useCallback, useRef, useState } from 'react';
import { ImagePlus, RotateCcw, RotateCw, Trash2, Upload } from 'lucide-react';
import { cn } from '../../lib/cn';
import { bytes } from '../../lib/precision';
import { useProjectStore } from '../../store/useProjectStore';
import { decodeFile, makeSourceImage, MAX_DIMENSION, MAX_FILE_BYTES, validateFile } from '../../core/preprocess/decode';
import { readFileAsDataUrl, openFile, IMAGE_TYPE } from '../../lib/file';
import { PipelineError } from '../../types/errors';
import { Banner, Button, IconButton, Panel, Slider, Tooltip } from '../ui';
import { tempId } from '../../lib/id';

export function ImportPanel({ onLoaded }: { onLoaded?: () => void }) {
  const source = useProjectStore((s) => s.source);
  const setSource = useProjectStore((s) => s.setSource);
  const clearSource = useProjectStore((s) => s.clearSource);
  const preprocess = useProjectStore((s) => s.preprocess);
  const setPreprocess = useProjectStore((s) => s.setPreprocess);
  const notify = useProjectStore((s) => s.notify);

  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);

  const handleFile = useCallback(
    async (file: File): Promise<void> => {
      setError(null);
      const check = validateFile(file);
      if (!check.ok) {
        setError({
          title: check.error!.message,
          detail: `上限：${bytes(MAX_FILE_BYTES)}，长宽不超过 ${MAX_DIMENSION}px。当前文件 ${bytes(file.size)}。`,
        });
        return;
      }

      setLoading(true);
      const decoded = await decodeFile(file).catch((e: unknown) => {
        if (e instanceof PipelineError) {
          setError({
            title: e.message,
            detail:
              e.code === 'TOO_LARGE'
                ? `图片尺寸 ${String(e.detail?.width ?? '?')}×${String(e.detail?.height ?? '?')}，超过 ${MAX_DIMENSION}px 上限。`
                : '请确认文件完整且为标准 JPG / PNG 编码。',
          });
        } else {
          console.error('[import] 解码失败', e);
          setError({ title: '图片解码失败', detail: '请换用其它图片重试。' });
        }
        return null;
      });

      if (decoded === null) {
        setLoading(false);
        return;
      }

      const dataUrl = await readFileAsDataUrl(file).catch((e: unknown) => {
        console.error('[import] 读取 dataURL 失败', e);
        return '';
      });

      const src = makeSourceImage(file, decoded, dataUrl, tempId('img'));
      setSource(src, { data: decoded.data, width: decoded.width, height: decoded.height });
      setLoading(false);
      if (decoded.orientation !== 1) {
        notify(`已按 EXIF 方向（${decoded.orientation}）自动校正图片朝向。`, 'info');
      }
      onLoaded?.();
    },
    [setSource, notify, onLoaded],
  );

  const pick = useCallback(async (): Promise<void> => {
    const file = await openFile(IMAGE_TYPE, 'image/png,image/jpeg');
    if (file !== null) await handleFile(file);
  }, [handleFile]);

  /* ---------------- 空态：大面积拖拽区 ---------------- */
  if (source === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3 p-3">
        {error !== null && (
          <Banner level="error" title={error.title} onClose={() => setError(null)}>
            {error.detail}
          </Banner>
        )}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = e.dataTransfer.files[0];
            if (file !== undefined) void handleFile(file);
          }}
          className={cn(
            'relative flex min-h-0 flex-1 flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed transition-all duration-200',
            dragging
              ? 'border-brand bg-brand/8 shadow-[inset_0_0_60px_-20px_rgba(34,211,238,0.5)]'
              : 'border-ink-500/70 bg-ink-800/25 hover:border-ink-500',
          )}
        >
          {/* 线稿风格插画 + 呼吸光晕 */}
          <div className="relative">
            <div className="absolute inset-0 animate-breathe rounded-full bg-brand/25 blur-2xl" />
            <svg width="132" height="104" viewBox="0 0 132 104" className="relative">
              <g fill="none" stroke="#22D3EE" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.85">
                <rect x="10" y="10" width="112" height="84" rx="3" strokeOpacity="0.4" />
                <rect x="24" y="24" width="40" height="30" />
                <rect x="76" y="24" width="34" height="30" />
                <rect x="24" y="66" width="86" height="18" />
                <path d="M64 39 H76" strokeDasharray="3 3" />
                <path d="M44 54 V66" strokeDasharray="3 3" />
              </g>
              <g stroke="#6366F1" strokeWidth="1.4" strokeLinecap="round" opacity="0.6">
                <path d="M92 66 L110 84" />
                <path d="M110 66 L92 84" />
              </g>
            </svg>
          </div>

          <div className="text-center">
            <p className="text-head font-semibold text-fg">拖入手绘地图草图</p>
            <p className="mt-1.5 text-[12px] text-fg-muted">
              支持 JPG / PNG · 单张 · 最大 {bytes(MAX_FILE_BYTES)} · 长宽 ≤ {MAX_DIMENSION}px
            </p>
            <p className="mt-1 text-[11px] text-fg-dim">
              图片全程仅在本机处理，不会上传到任何服务器
            </p>
          </div>

          <Button variant="primary" icon={<Upload size={14} />} onClick={() => void pick()} disabled={loading}>
            {loading ? '正在读取…' : '选择图片'}
          </Button>

          <p className="absolute bottom-4 text-[10px] text-fg-dim">
            扫描图、拍照图均可 · 允许轻微透视、旋转、阴影与背景噪声
          </p>
        </div>
      </div>
    );
  }

  /* ---------------- 已导入：显示信息与几何校正 ---------------- */
  return (
    <>
      <Panel title="源文件" icon={<ImagePlus size={12} />}>
        <div className="space-y-2">
          <div className="rounded-md border border-ink-600/60 bg-ink-900/40 p-2">
            <p className="truncate text-[12px] font-medium text-fg" title={source.fileName}>
              {source.fileName}
            </p>
            <p className="tabular mt-0.5 text-[10px] text-fg-dim">
              {source.naturalWidth} × {source.naturalHeight} px · {bytes(source.byteSize)}
              {source.exifOrientation !== 1 && ` · EXIF ${source.exifOrientation} 已校正`}
            </p>
          </div>
          <div className="flex gap-1.5">
            <Button
              variant="outline"
              className="flex-1"
              icon={<Upload size={13} />}
              onClick={() => void pick()}
            >
              更换图片
            </Button>
            <Tooltip text="移除图片并清空识别结果">
              <IconButton label="移除图片" onClick={clearSource}>
                <Trash2 size={14} />
              </IconButton>
            </Tooltip>
          </div>
          <p className="text-[10px] leading-snug text-fg-dim">
            原图始终只读保留，所有处理都在副本上进行。
          </p>
        </div>
      </Panel>

      <Panel title="几何校正" collapsible defaultOpen>
        <div className="space-y-3">
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] font-medium text-fg-muted">手动旋转</span>
              <div className="flex items-center gap-1">
                <IconButton
                  label="逆时针 90°"
                  onClick={() => setPreprocess({ manualRotation: normalizeAngle(preprocess.manualRotation - 90) })}
                >
                  <RotateCcw size={13} />
                </IconButton>
                <IconButton
                  label="顺时针 90°"
                  onClick={() => setPreprocess({ manualRotation: normalizeAngle(preprocess.manualRotation + 90) })}
                >
                  <RotateCw size={13} />
                </IconButton>
              </div>
            </div>
            <Slider
              label="微调角度"
              value={preprocess.manualRotation}
              min={-180}
              max={180}
              step={0.5}
              onChange={(v) => setPreprocess({ manualRotation: v })}
              format={(v) => `${v.toFixed(1)}°`}
              hint="叠加在自动倾斜校正之后"
            />
          </div>

          <div className="divider" />

          <CropControls />

          <div className="divider" />

          <div>
            <p className="mb-1.5 text-[11px] font-medium text-fg-muted">透视校正</p>
            {preprocess.perspective === null ? (
              <>
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() =>
                    setPreprocess({
                      // 默认给出稍向内收的四角，用户可在画布上拖动调整
                      perspective: [
                        { x: 0.04, y: 0.04 },
                        { x: 0.96, y: 0.04 },
                        { x: 0.96, y: 0.96 },
                        { x: 0.04, y: 0.96 },
                      ],
                    })
                  }
                >
                  启用四点透视校正
                </Button>
                <p className="mt-1 text-[10px] leading-snug text-fg-dim">
                  拍照产生梯形畸变时使用；启用后在画布上拖动四个角点对齐纸张边缘。
                </p>
              </>
            ) : (
              <Button
                variant="danger"
                className="w-full"
                onClick={() => setPreprocess({ perspective: null })}
              >
                取消透视校正
              </Button>
            )}
          </div>
        </div>
      </Panel>
    </>
  );
}

function CropControls() {
  const preprocess = useProjectStore((s) => s.preprocess);
  const setPreprocess = useProjectStore((s) => s.setPreprocess);
  const crop = preprocess.crop;

  if (crop === null) {
    return (
      <div>
        <p className="mb-1.5 text-[11px] font-medium text-fg-muted">裁剪</p>
        <Button
          variant="outline"
          className="w-full"
          onClick={() => setPreprocess({ crop: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 } })}
        >
          启用裁剪
        </Button>
        <p className="mt-1 text-[10px] leading-snug text-fg-dim">
          去掉纸张外的桌面、手指等无关区域，可显著提升识别质量。
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-medium text-fg-muted">裁剪区域</span>
        <button
          type="button"
          onClick={() => setPreprocess({ crop: null })}
          className="cursor-pointer text-[10px] text-fg-dim transition-colors hover:text-danger"
        >
          取消
        </button>
      </div>
      <div className="space-y-2">
        <Slider
          label="左边距"
          value={crop.x}
          min={0}
          max={0.4}
          step={0.005}
          onChange={(v) => setPreprocess({ crop: { ...crop, x: v, w: Math.min(crop.w, 1 - v) } })}
          format={(v) => `${(v * 100).toFixed(1)}%`}
        />
        <Slider
          label="上边距"
          value={crop.y}
          min={0}
          max={0.4}
          step={0.005}
          onChange={(v) => setPreprocess({ crop: { ...crop, y: v, h: Math.min(crop.h, 1 - v) } })}
          format={(v) => `${(v * 100).toFixed(1)}%`}
        />
        <Slider
          label="宽度"
          value={crop.w}
          min={0.2}
          max={1}
          step={0.005}
          onChange={(v) => setPreprocess({ crop: { ...crop, w: Math.min(v, 1 - crop.x) } })}
          format={(v) => `${(v * 100).toFixed(1)}%`}
        />
        <Slider
          label="高度"
          value={crop.h}
          min={0.2}
          max={1}
          step={0.005}
          onChange={(v) => setPreprocess({ crop: { ...crop, h: Math.min(v, 1 - crop.y) } })}
          format={(v) => `${(v * 100).toFixed(1)}%`}
        />
      </div>
    </div>
  );
}

function normalizeAngle(a: number): number {
  let v = a;
  while (v > 180) v -= 360;
  while (v < -180) v += 360;
  return Math.round(v * 10) / 10;
}
