/**
 * 识别参数面板：预设、阈值微调、运行控制与统计。
 */

import { Ban, Play, RotateCcw, Wand2 } from 'lucide-react';
import { useProjectStore } from '../../store/useProjectStore';
import {
  PARAM_RANGES,
  PRESET_DESCRIPTIONS,
  PRESET_LABELS,
  STAGE_LABELS,
  presetParams,
  type PresetKind,
} from '../../core/pipeline/params';
import { simplifyRatio } from '../../types/recognition';
import { ms, percent } from '../../lib/precision';
import { errorAdvice, type PipelineRunner } from '../../hooks/usePipelineRunner';
import { Banner, Button, Panel, ProgressBar, Segmented, Slider, Stat, Switch } from '../ui';

export function RecognizePanel({ runner }: { runner: PipelineRunner }) {
  const preset = useProjectStore((s) => s.preset);
  const setPreset = useProjectStore((s) => s.setPreset);
  const params = useProjectStore((s) => s.recognize);
  const setRecognize = useProjectStore((s) => s.setRecognize);
  const run = useProjectStore((s) => s.run);
  const result = useProjectStore((s) => s.result);
  const lastError = useProjectStore((s) => s.lastError);
  const clearError = useProjectStore((s) => s.clearError);
  const source = useProjectStore((s) => s.source);

  return (
    <>
      <Panel title="识别预设" icon={<Wand2 size={12} />}>
        <div className="space-y-2">
          <Segmented<PresetKind>
            value={preset}
            options={[
              { value: 'fast', label: PRESET_LABELS.fast, title: PRESET_DESCRIPTIONS.fast },
              { value: 'standard', label: PRESET_LABELS.standard, title: PRESET_DESCRIPTIONS.standard },
              { value: 'fine', label: PRESET_LABELS.fine, title: PRESET_DESCRIPTIONS.fine },
            ]}
            onChange={setPreset}
          />
          <p className="text-[10px] leading-relaxed text-fg-dim">{PRESET_DESCRIPTIONS[preset]}</p>

          <Button
            variant="primary"
            className="w-full"
            icon={run.running ? undefined : <Play size={13} />}
            disabled={source === null || run.running}
            onClick={() => runner.runRecognition()}
          >
            {run.running ? '识别中…' : result === null ? '开始识别' : '重新识别'}
          </Button>

          {run.running && (
            <>
              <ProgressBar
                value={run.progress}
                label={run.stage !== null && run.stage !== 'preprocess' ? STAGE_LABELS[run.stage] : '图像预处理'}
              />
              {run.detail !== '' && <p className="text-[10px] text-fg-dim">{run.detail}</p>}
              <Button variant="danger" className="w-full" icon={<Ban size={13} />} onClick={() => runner.cancel()}>
                取消
              </Button>
            </>
          )}
        </div>
      </Panel>

      {lastError !== null && (
        <Banner
          level={lastError.recoverable ? 'warning' : 'error'}
          title={lastError.message}
          onClose={clearError}
        >
          {errorAdvice(lastError.code)}
        </Banner>
      )}

      <Panel
        title="阈值微调"
        collapsible
        defaultOpen={false}
        action={
          <button
            type="button"
            onClick={() => setRecognize(presetParams(preset))}
            className="flex cursor-pointer items-center gap-1 text-[10px] text-fg-dim transition-colors hover:text-brand"
          >
            <RotateCcw size={10} />
            重置
          </button>
        }
      >
        <div className="space-y-3">
          <Slider
            label="节点简化容差"
            value={params.simplifyEpsilon}
            min={PARAM_RANGES.simplifyEpsilon.min}
            max={PARAM_RANGES.simplifyEpsilon.max}
            step={PARAM_RANGES.simplifyEpsilon.step}
            onChange={(v) => setRecognize({ simplifyEpsilon: v })}
            format={(v) => `${v.toFixed(1)} px`}
            hint="越大节点越少；拓扑守卫会阻止过度简化导致通道消失"
          />

          <div className="divider" />

          <Slider
            label="角度吸附容差"
            value={params.snap.angleTolDeg}
            min={PARAM_RANGES.angleTolDeg.min}
            max={PARAM_RANGES.angleTolDeg.max}
            step={PARAM_RANGES.angleTolDeg.step}
            onChange={(v) => setRecognize({ snap: { ...params.snap, angleTolDeg: v } })}
            format={(v) => `${v.toFixed(1)}°`}
            hint="偏差在此范围内的线会被拉正到 0/30/45/60/90° 等常用角"
          />
          <Slider
            label="端点聚簇半径"
            value={params.snap.clusterRadius}
            min={PARAM_RANGES.clusterRadius.min}
            max={PARAM_RANGES.clusterRadius.max}
            step={PARAM_RANGES.clusterRadius.step}
            onChange={(v) => setRecognize({ snap: { ...params.snap, clusterRadius: v } })}
            format={(v) => (v === 0 ? '关闭' : `${v.toFixed(1)} px`)}
            hint="相近端点合并为同一点——房间能否闭合成矩形的关键"
          />
          <Switch
            label="启用角度吸附"
            checked={params.snap.enableAngle}
            onChange={(v) => setRecognize({ snap: { ...params.snap, enableAngle: v } })}
          />

          <div className="divider" />

          <Slider
            label="断线连接最大间隙"
            value={params.bridge.maxGap}
            min={PARAM_RANGES.maxGap.min}
            max={PARAM_RANGES.maxGap.max}
            step={PARAM_RANGES.maxGap.step}
            onChange={(v) => setRecognize({ bridge: { ...params.bridge, maxGap: v } })}
            format={(v) => (v === 0 ? '关闭' : `${v} px`)}
            hint="超出此距离的缺口不会强行连接，而是标记为「断线未连接」"
          />
          <Slider
            label="延长求交距离"
            value={params.bridge.maxExtend}
            min={0}
            max={50}
            step={1}
            onChange={(v) => setRecognize({ bridge: { ...params.bridge, maxExtend: v } })}
            format={(v) => (v === 0 ? '关闭' : `${v} px`)}
            hint="房间四角没画到底时，把端点延长到交点"
          />
          <Slider
            label="最短线段长度"
            value={params.bridge.minSegmentLength}
            min={PARAM_RANGES.minSegmentLength.min}
            max={PARAM_RANGES.minSegmentLength.max}
            step={PARAM_RANGES.minSegmentLength.step}
            onChange={(v) => setRecognize({ bridge: { ...params.bridge, minSegmentLength: v } })}
            format={(v) => `${v} px`}
            hint="短于此值的线段视为毛刺剪除"
          />

          <div className="divider" />

          <Slider
            label="最小封闭区域面积"
            value={params.planar.minFaceArea}
            min={PARAM_RANGES.minFaceArea.min}
            max={PARAM_RANGES.minFaceArea.max}
            step={PARAM_RANGES.minFaceArea.step}
            onChange={(v) => setRecognize({ planar: { ...params.planar, minFaceArea: v } })}
            format={(v) => `${v} px²`}
            hint="小于此面积的面视为噪声丢弃"
          />
          <Slider
            label="矩形判定充满度"
            value={params.classify.aabbFillThreshold}
            min={0.8}
            max={0.99}
            step={0.005}
            onChange={(v) =>
              setRecognize({
                classify: { ...params.classify, aabbFillThreshold: v, rectFillThreshold: Math.max(v, 0.9) },
              })
            }
            format={(v) => percent(v, 1)}
            hint="越高越严格；调低会让更多近似方形输出为 rect"
          />
          <Switch
            label="实心块轮廓追踪"
            checked={params.enableContourFallback}
            onChange={(v) => setRecognize({ enableContourFallback: v })}
            hint="草图中把区域整块涂黑时启用的降级路径"
          />
        </div>
      </Panel>

      {result !== null && (
        <Panel title="识别统计" collapsible>
          <div className="grid grid-cols-2 gap-1.5">
            <Stat label="对象总数" value={String(result.stats.elementCount)} accent />
            <Stat label="封闭区域" value={String(result.stats.faceCount)} />
            <Stat label="线段数" value={String(result.stats.segmentCount)} />
            <Stat label="骨架分支" value={String(result.stats.branchCount)} />
            <Stat label="平均置信度" value={percent(result.stats.averageConfidence, 0)} accent />
            <Stat label="节点简化率" value={percent(simplifyRatio(result.stats), 0)} />
            <Stat
              label="工作分辨率"
              value={`${result.stats.workWidth}×${result.stats.workHeight}`}
            />
            <Stat
              label="前景占比"
              value={percent(result.stats.foregroundRatio, 1)}
            />
          </div>

          <div className="mt-2 rounded-md border border-ink-600/60 bg-ink-900/40 p-2">
            <p className="mb-1 text-[10px] font-semibold text-fg-muted">阶段耗时</p>
            <ul className="space-y-0.5">
              {Object.entries(result.stats.timings)
                .filter(([, v]) => v > 0.5)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 6)
                .map(([k, v]) => (
                  <li key={k} className="tabular flex justify-between text-[10px] text-fg-dim">
                    <span>{k}</span>
                    <span>{ms(v)}</span>
                  </li>
                ))}
            </ul>
          </div>

          <p className="mt-2 text-[10px] leading-snug text-fg-dim">
            算法版本 {result.algorithmVersion} · 参数签名 {result.paramsSignature.slice(0, 8)}
          </p>
        </Panel>
      )}
    </>
  );
}
