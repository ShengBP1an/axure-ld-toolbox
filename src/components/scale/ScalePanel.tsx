/**
 * 尺寸与比例设置栏。
 *
 * 严格区分「地图实际尺寸」与「输出画布像素尺寸」两个概念，
 * 中间以锁形按钮表示宽高比锁定状态。
 */

import { useMemo } from 'react';
import { Link2, Maximize2, Ruler, Target, Unlink2 } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useProjectStore } from '../../store/useProjectStore';
import { isAnisotropic, pixelsPerUnit, unitSymbol, UNIT_LABELS, type UnitKind } from '../../types/project';
import * as S from '../../core/project/settings';
import { Banner, Button, NumberField, Panel, Select, Stat, Tooltip } from '../ui';

export function ScalePanel({ onStartCalibrate }: { onStartCalibrate: () => void }) {
  const settings = useProjectStore((s) => s.settings);
  const source = useProjectStore((s) => s.source);
  const workingImage = useProjectStore((s) => s.workingImage);
  const apply = useProjectStore((s) => s.applySettingsChange);
  const setUnit = useProjectStore((s) => s.setUnit);
  const notify = useProjectStore((s) => s.notify);

  const sym = unitSymbol(settings.unit);
  const ppu = pixelsPerUnit(settings);
  const validation = useMemo(() => S.validateSettings(settings), [settings]);
  const aniso = !settings.lockAspect && isAnisotropic(settings);

  const imgW = workingImage?.width ?? source?.naturalWidth ?? 0;
  const imgH = workingImage?.height ?? source?.naturalHeight ?? 0;

  return (
    <>
      {/* 当前比例：等宽大字号强调 */}
      <Panel title="当前换算比例" icon={<Ruler size={12} />}>
        <div className="rounded-lg border border-brand/25 bg-brand/6 p-3 text-center">
          <p className="tabular text-[26px] font-bold leading-none text-brand">
            {ppu.toFixed(2)}
          </p>
          <p className="mt-1 text-[11px] text-fg-muted">
            像素 / {sym}
            <span className="text-fg-dim"> （pixelsPerUnit）</span>
          </p>
          <p className="mt-2 border-t border-brand/15 pt-2 text-[10px] text-fg-dim">
            1 {sym} 在导出的 SVG 中占 {ppu.toFixed(2)} px
          </p>
        </div>

        <div className="mt-2.5 grid grid-cols-2 gap-1.5">
          <Stat label="比例来源" value={settings.scaleSource === 'calibration' ? '两点标定' : '手动输入'} accent={settings.scaleSource === 'calibration'} />
          <Stat label="宽高比" value={settings.aspectRatio.toFixed(3)} />
        </div>
      </Panel>

      {/* 地图实际尺寸 */}
      <Panel title="地图实际尺寸" icon={<Maximize2 size={12} />}>
        <div className="space-y-2.5">
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="宽度"
              value={settings.mapWidth}
              suffix={sym}
              min={0.001}
              step={1}
              onCommit={(v) => apply(S.setMapWidth(settings, v))}
            />
            <NumberField
              label="高度"
              value={settings.mapHeight}
              suffix={sym}
              min={0.001}
              step={1}
              onCommit={(v) => apply(S.setMapHeight(settings, v))}
            />
          </div>
          <Select<UnitKind>
            label="地图单位"
            value={settings.unit.kind}
            options={[
              { value: 'm', label: UNIT_LABELS.m },
              { value: 'cm', label: UNIT_LABELS.cm },
              { value: 'custom', label: UNIT_LABELS.custom },
            ]}
            onChange={(kind) =>
              setUnit({ kind, symbol: kind === 'custom' ? settings.unit.symbol || 'tile' : kind })
            }
          />
          {settings.unit.kind === 'custom' && (
            <div>
              <label className="field-label" htmlFor="unit-symbol">
                自定义单位符号
              </label>
              <input
                id="unit-symbol"
                className="text-input"
                value={settings.unit.symbol}
                placeholder="例如 tile / grid"
                onChange={(e) => setUnit({ kind: 'custom', symbol: e.target.value })}
              />
            </div>
          )}
          <p className="text-[10px] leading-snug text-fg-dim">
            这是地图在游戏世界中的真实尺寸，与下方的输出像素尺寸是两个独立概念。
          </p>
        </div>
      </Panel>

      {/* 宽高比锁定按钮：连接两个卡片 */}
      <div className="flex items-center gap-2 px-1">
        <span className="h-px flex-1 bg-ink-600/70" />
        <Tooltip
          text={
            settings.lockAspect
              ? '已锁定宽高比：修改宽度会自动推导高度，反之亦然。点击解除锁定。'
              : '已解除锁定：允许非等比缩放，但图形会被拉伸变形。点击重新锁定。'
          }
        >
          <button
            type="button"
            onClick={() => apply(S.setLockAspect(settings, !settings.lockAspect))}
            className={cn(
              'flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border transition-all duration-150',
              settings.lockAspect
                ? 'border-brand/60 bg-brand/18 text-brand shadow-glow'
                : 'border-ink-500 bg-ink-800 text-fg-dim hover:border-warn/60 hover:text-warn',
            )}
            aria-pressed={settings.lockAspect}
          >
            {settings.lockAspect ? <Link2 size={15} /> : <Unlink2 size={15} />}
          </button>
        </Tooltip>
        <span className="h-px flex-1 bg-ink-600/70" />
      </div>

      {/* 输出画布 */}
      <Panel title="Axure 输出画布" icon={<Maximize2 size={12} />}>
        <div className="space-y-2.5">
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="画布宽度"
              value={settings.canvasWidthPx}
              suffix="px"
              min={1}
              step={10}
              precision={0}
              onCommit={(v) => apply(S.setCanvasWidth(settings, v))}
            />
            <NumberField
              label="画布高度"
              value={settings.canvasHeightPx}
              suffix="px"
              min={1}
              step={10}
              precision={0}
              onCommit={(v) => apply(S.setCanvasHeight(settings, v))}
            />
          </div>

          {aniso && (
            <Banner level="warning" title="非等比缩放">
              横纵比例不同（横向 {ppu.toFixed(2)}、纵向{' '}
              {(settings.mapHeight > 0 ? settings.canvasHeightPx / settings.mapHeight : 0).toFixed(2)} px/{sym}），
              导出的图形会被拉伸变形。
            </Banner>
          )}

          <div className="flex gap-1.5">
            <Button
              variant="outline"
              className="flex-1 text-[11px]"
              onClick={() => apply(S.restoreImageAspect(settings, source?.naturalWidth ?? 0, source?.naturalHeight ?? 0))}
              disabled={source === null}
            >
              恢复原图比例
            </Button>
          </div>
          <p className="text-[10px] leading-snug text-fg-dim">
            这是导出 SVG 的 viewBox 尺寸，决定图形在 Axure 中的像素大小。
          </p>
        </div>
      </Panel>

      {/* 两点标定 */}
      <Panel title="两点标定" icon={<Target size={12} />}>
        <div className="space-y-2.5">
          {settings.calibration === null ? (
            <>
              <p className="text-[11px] leading-relaxed text-fg-muted">
                在图上选择两个已知实际距离的点（例如一堵墙的两端），
                输入真实距离，工具会据此反推整幅地图的实际尺寸。
              </p>
              <Button
                variant="primary"
                className="w-full"
                icon={<Target size={13} />}
                onClick={onStartCalibrate}
                disabled={imgW === 0}
              >
                开始拾取两点
              </Button>
            </>
          ) : (
            <>
              <div
                className={cn(
                  'rounded-md border p-2',
                  settings.calibration.stale
                    ? 'border-warn/45 bg-warn/8'
                    : 'border-ok/40 bg-ok/8',
                )}
              >
                <p className="text-[11px] font-semibold text-fg">
                  {settings.calibration.stale ? '标定已过期' : '标定生效中'}
                </p>
                <p className="tabular mt-1 text-[10px] leading-relaxed text-fg-muted">
                  两点像素距离 {distanceOf(settings.calibration).toFixed(1)} px
                  <br />
                  实际距离 {settings.calibration.realDistance} {sym}
                  <br />1 px ≈ {settings.calibration.unitsPerImagePx.toFixed(4)} {sym}
                </p>
                {settings.calibration.stale && (
                  <p className="mt-1.5 border-t border-warn/20 pt-1.5 text-[10px] leading-snug text-warn">
                    尺寸被手动修改过，当前以手动输入为准。标定数据已保留。
                  </p>
                )}
              </div>

              <div className="flex gap-1.5">
                {settings.calibration.stale && (
                  <Button
                    variant="primary"
                    className="flex-1 text-[11px]"
                    onClick={() => {
                      const change = tryReapply(settings, imgW, imgH);
                      if (change === null) {
                        notify('重新应用标定失败：图像信息不可用。', 'error');
                        return;
                      }
                      apply(change);
                    }}
                  >
                    重新应用标定
                  </Button>
                )}
                <Button variant="outline" className="flex-1 text-[11px]" onClick={onStartCalibrate}>
                  重新拾取
                </Button>
                <Button
                  variant="danger"
                  className="text-[11px]"
                  onClick={() => apply(S.resetCalibration(settings))}
                >
                  清除
                </Button>
              </div>
            </>
          )}

          <div className="rounded-md border border-ink-600/60 bg-ink-900/40 p-2">
            <p className="text-[10px] font-semibold text-fg-muted">冲突优先级</p>
            <p className="mt-1 text-[10px] leading-relaxed text-fg-dim">
              标定成功后以标定为准；之后若手动修改尺寸，则改为以手动输入为准，
              标定被标记为过期（数据保留，可一键重新应用），不会静默覆盖。
            </p>
          </div>
        </div>
      </Panel>

      {(validation.errors.length > 0 || validation.warnings.length > 0) && (
        <div className="space-y-2">
          {validation.errors.map((e) => (
            <Banner key={e} level="error" title={e} />
          ))}
          {validation.warnings.map((w) => (
            <Banner key={w} level="warning" title={w} />
          ))}
        </div>
      )}
    </>
  );
}

function distanceOf(c: { p1: { x: number; y: number }; p2: { x: number; y: number } }): number {
  return Math.hypot(c.p2.x - c.p1.x, c.p2.y - c.p1.y);
}

/** 包装 reapply，捕获 CALIBRATION_FAILED。 */
function tryReapply(
  settings: Parameters<typeof S.reapplyCalibration>[0],
  w: number,
  h: number,
): S.SettingsChange | null {
  if (w <= 0 || h <= 0) return null;
  const result = ((): S.SettingsChange | null => {
    try {
      return S.reapplyCalibration(settings, w, h);
    } catch (e) {
      console.error('[scale] 重新应用标定失败', e);
      return null;
    }
  })();
  return result;
}
