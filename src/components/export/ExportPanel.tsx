/**
 * 导出面板：设置、预检、SVG 预览与保存。
 */

import { useCallback, useMemo, useState } from 'react';
import { CheckCircle2, Download, FileCode2, ShieldAlert } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useEditorStore } from '../../store/useEditorStore';
import { useProjectStore } from '../../store/useProjectStore';
import { LAYER_KINDS, LAYER_LABELS, type LayerKind, type Bounds } from '../../types/vector';
import { svgExporter } from '../../core/export/SvgExporter';
import { buildReadmeText } from '../../core/export/axureNotes';
import { RECOMMENDED_MAX_ELEMENTS } from '../../core/export/svgValidate';
import { bytes } from '../../lib/precision';
import { saveTextFile, orphanHint, SVG_TYPE } from '../../lib/file';
import { Banner, Button, Panel, Segmented, Slider, Stat, Switch } from '../ui';
import { PreflightReportView } from './PreflightReport';

export function ExportPanel({ onFocus }: { onFocus: (region: Bounds | null, ids: readonly string[]) => void }) {
  const settings = useProjectStore((s) => s.settings);
  const ex = useProjectStore((s) => s.exportSettings);
  const setEx = useProjectStore((s) => s.setExportSettings);
  const projectName = useProjectStore((s) => s.projectName);
  const notify = useProjectStore((s) => s.notify);
  const markCompleted = useProjectStore((s) => s.markCompleted);

  const elements = useEditorStore((s) => s.elements);
  const order = useEditorStore((s) => s.order);
  const revision = useEditorStore((s) => s.revision);

  const [saving, setSaving] = useState(false);
  /** 保存成功后置位，用于展示「必须再做一步转换」的强提示。 */
  const [savedOnce, setSavedOnce] = useState(false);

  const list = useMemo(
    () => order.map((id) => elements.get(id)).filter((e): e is NonNullable<typeof e> => e !== undefined),
    [order, elements, revision],
  );

  /** 每次设置或数据变化都重新生成（纯函数，可安全 memo）。 */
  const result = useMemo(
    () => svgExporter.run({ elements: list, settings, exportSettings: ex, projectName }),
    [list, settings, ex, projectName],
  );

  const save = useCallback(async (): Promise<void> => {
    if (!result.report.passed) {
      notify('存在阻止导出的致命问题，请先修正。', 'error');
      return;
    }
    setSaving(true);
    const outcome = await saveTextFile(
      result.svg,
      result.suggestedFileName,
      SVG_TYPE,
      'image/svg+xml',
    ).catch((e: unknown) => {
      console.error('[export] 保存失败', e);
      notify('文件写入失败，请检查保存位置权限。', 'error');
      return { kind: 'cancelled' } as const;
    });
    setSaving(false);

    const size = bytes(result.byteSize);
    const hint = orphanHint(outcome);
    switch (outcome.kind) {
      case 'picked':
        notify(`已保存 ${result.suggestedFileName}（${size}）`, 'success');
        markCompleted('export');
        setSavedOnce(true);
        break;
      case 'devDisk':
        notify(`已写入 ${outcome.path}（${size}）${hint}`, 'success');
        markCompleted('export');
        setSavedOnce(true);
        break;
      case 'downloaded':
        notify(`${result.suggestedFileName}（${size}）已下载到默认下载目录。${hint}`, 'success');
        markCompleted('export');
        setSavedOnce(true);
        break;
      case 'cancelled':
        break;
    }
  }, [result, notify, markCompleted]);

  const saveReadme = useCallback(async (): Promise<void> => {
    const text = buildReadmeText(projectName, settings.canvasWidthPx, settings.canvasHeightPx);
    await saveTextFile(
      text,
      `${projectName.replace(/[\\/:*?"<>|]/g, '_')}-Axure导入说明.md`,
      { description: 'Markdown 说明', accept: { 'text/markdown': ['.md'] } },
      'text/markdown',
    ).catch((e: unknown) => {
      console.error('[export] 保存说明失败', e);
      return { kind: 'cancelled' } as const;
    });
  }, [projectName, settings]);

  const exportedCount = list.filter((el) => ex.layers[el.layer] !== false && el.hidden !== true).length;

  return (
    <>
      {/* 预检横幅 */}
      {result.report.passed ? (
        <Banner level="success" title="预检通过，可以导出">
          {exportedCount} 个对象将被导出为 {settings.canvasWidthPx} × {settings.canvasHeightPx} px 的分层 SVG。
        </Banner>
      ) : (
        <Banner level="error" title="预检未通过，已阻止导出">
          存在 {result.report.items.filter((i) => i.blocking).length} 个致命问题，请在下方逐项修正。
        </Banner>
      )}

      <Panel title="导出设置" icon={<FileCode2 size={12} />}>
        <div className="space-y-3">
          <div>
            <p className="field-label">导出图层</p>
            <div className="space-y-0.5">
              {LAYER_KINDS.map((k: LayerKind) => {
                const count = list.filter((el) => el.layer === k && el.hidden !== true).length;
                return (
                  <Switch
                    key={k}
                    label={`${LAYER_LABELS[k]}（${count}）`}
                    checked={ex.layers[k] !== false}
                    onChange={(v) => setEx({ layers: { ...ex.layers, [k]: v } })}
                    disabled={count === 0}
                  />
                );
              })}
            </div>
          </div>

          <div className="divider" />

          <Slider
            label="坐标精度"
            value={ex.precision}
            min={0}
            max={4}
            step={1}
            onChange={(v) => setEx({ precision: v })}
            format={(v) => `${v} 位小数`}
            hint="2 位在 Axure 中足够，且能显著减小文件体积"
          />
          <Slider
            label="描边宽度倍率"
            value={ex.strokeScale}
            min={0.25}
            max={4}
            step={0.05}
            onChange={(v) => setEx({ strokeScale: v })}
            format={(v) => `${v.toFixed(2)}×`}
          />

          <div className="divider" />

          <Switch
            label="封闭区域带填充"
            checked={ex.fillRegions}
            onChange={(v) => setEx({ fillRegions: v })}
            hint="关闭后仅描边，避免大面积色块在 Axure 中遮挡墙线"
          />
          <Switch
            label="待确认对象保留虚线"
            checked={ex.keepDashForReview}
            onChange={(v) => setEx({ keepDashForReview: v })}
            hint="Axure 对 stroke-dasharray 的转换行为需验证；若转换后对象数暴增请关闭"
          />
          <Switch
            label="写入 metadata"
            checked={ex.includeMetadata}
            onChange={(v) => setEx({ includeMetadata: v })}
            hint="记录地图尺寸、单位、比例与工具版本；按规范不影响显示"
          />
          <Switch
            label="写入 data-* 属性"
            checked={ex.includeDataAttrs}
            onChange={(v) => setEx({ includeDataAttrs: v })}
            hint="保留置信度等追溯信息；转换为形状后大概率会丢失"
          />
          <Switch
            label="美化缩进"
            checked={ex.prettyPrint}
            onChange={(v) => setEx({ prettyPrint: v })}
          />
        </div>
      </Panel>

      <Panel title="导出概要">
        <div className="grid grid-cols-2 gap-1.5">
          <Stat label="导出对象" value={String(exportedCount)} accent />
          <Stat label="文件体积" value={result.byteSize > 0 ? bytes(result.byteSize) : '—'} />
          <Stat label="viewBox" value={`0 0 ${Math.round(settings.canvasWidthPx)} ${Math.round(settings.canvasHeightPx)}`} />
          <Stat
            label="对象上限"
            value={`${exportedCount} / ${RECOMMENDED_MAX_ELEMENTS}`}
            accent={exportedCount <= RECOMMENDED_MAX_ELEMENTS}
          />
        </div>

        <div className="mt-2.5 space-y-1.5">
          <Button
            variant="primary"
            className="w-full"
            icon={<Download size={14} />}
            disabled={!result.report.passed || saving}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存 SVG'}
          </Button>
          <Button variant="outline" className="w-full text-[11px]" onClick={() => void saveReadme()}>
            另存 Axure 导入说明（.md）
          </Button>
        </div>

        {/* 保存后必须再做一步转换，否则在 Axure 里只是一张图片。
            这是整个交付路径里最容易被遗漏的一步，务必醒目。 */}
        {savedOnce && (
          <div className="mt-2.5 rounded-md border border-brand/40 bg-brand/8 px-2.5 py-2.5">
            <p className="text-[10px] font-bold uppercase tracking-wide text-brand">
              下一步 · 在 Axure 中转换
            </p>
            <ol className="mt-1.5 space-y-1 text-[10px] leading-relaxed text-fg">
              <li>1. 把 SVG 拖进 Axure 画布（此时仍是一张图片，属正常）</li>
              <li>2. 选中它 → 右键 → Transform Image → Convert SVG to Shapes</li>
              <li>3. 转换后 Ctrl+Shift+G 取消分组，即可分别选中每个房间和墙线</li>
            </ol>
          </div>
        )}
      </Panel>

      <PreflightReportView report={result.report} onFocus={onFocus} />
    </>
  );
}

/** SVG 代码预览（带极简语法高亮）。 */
export function SvgPreview() {
  const settings = useProjectStore((s) => s.settings);
  const ex = useProjectStore((s) => s.exportSettings);
  const projectName = useProjectStore((s) => s.projectName);
  const elements = useEditorStore((s) => s.elements);
  const order = useEditorStore((s) => s.order);
  const revision = useEditorStore((s) => s.revision);
  const [mode, setMode] = useState<'render' | 'code'>('render');

  const list = useMemo(
    () => order.map((id) => elements.get(id)).filter((e): e is NonNullable<typeof e> => e !== undefined),
    [order, elements, revision],
  );
  const result = useMemo(
    () => svgExporter.run({ elements: list, settings, exportSettings: ex, projectName }),
    [list, settings, ex, projectName],
  );

  const dataUrl = useMemo(() => {
    if (result.svg === '') return null;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svg)}`;
  }, [result.svg]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 p-3">
      <div className="flex shrink-0 items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold text-fg">导出预览</span>
          {result.svg === '' && (
            <span className="flex items-center gap-1 text-[10px] text-danger">
              <ShieldAlert size={11} />
              预检未通过，未生成 SVG
            </span>
          )}
          {result.svg !== '' && (
            <span className="flex items-center gap-1 text-[10px] text-ok">
              <CheckCircle2 size={11} />
              {bytes(result.byteSize)}
            </span>
          )}
        </div>
        <Segmented
          className="w-40"
          value={mode}
          options={[
            { value: 'render', label: '渲染结果' },
            { value: 'code', label: 'SVG 代码' },
          ]}
          onChange={setMode}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-ink-600/70 bg-ink-900/60">
        {result.svg === '' ? (
          <div className="flex h-full items-center justify-center p-6 text-center">
            <p className="text-[12px] leading-relaxed text-fg-muted">
              存在阻止导出的问题，SVG 尚未生成。
              <br />
              <span className="text-[11px] text-fg-dim">请在左侧预检报告中逐项修正。</span>
            </p>
          </div>
        ) : mode === 'render' ? (
          <div
            className="flex h-full items-center justify-center overflow-auto p-4"
            style={{
              backgroundImage:
                'linear-gradient(45deg, #151c26 25%, transparent 25%), linear-gradient(-45deg, #151c26 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #151c26 75%), linear-gradient(-45deg, transparent 75%, #151c26 75%)',
              backgroundSize: '16px 16px',
              backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
            }}
          >
            {dataUrl !== null && (
              <img
                src={dataUrl}
                alt="SVG 导出预览"
                className="max-h-full max-w-full bg-white shadow-paper"
              />
            )}
          </div>
        ) : (
          <pre className="h-full overflow-auto p-3 font-mono text-[10.5px] leading-relaxed">
            <code>{highlight(result.svg)}</code>
          </pre>
        )}
      </div>

      <p className="shrink-0 text-center text-[10px] text-fg-dim">
        渲染结果为浏览器解析的效果；Axure 转换为形状后的最终外观需在 Axure 中确认
      </p>
    </div>
  );
}

/** 极简 SVG 语法高亮（标签 / 属性名 / 属性值）。 */
function highlight(svg: string): React.ReactNode[] {
  // 限制预览长度，避免超大文件卡住渲染
  const text = svg.length > 60000 ? `${svg.slice(0, 60000)}\n… （预览已截断，完整内容以保存的文件为准）` : svg;
  const out: React.ReactNode[] = [];
  const re = /(<\/?[\w:-]+)|([\w:-]+)(=)("[^"]*")|(\/?>)|(<!--[\s\S]*?-->)|(<\?[\s\S]*?\?>)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(<span key={key++} className="text-brand">{m[1]}</span>);
    } else if (m[2] !== undefined) {
      out.push(<span key={key++} className="text-accent2">{m[2]}</span>);
      out.push(<span key={key++} className="text-fg-dim">{m[3]}</span>);
      out.push(<span key={key++} className="text-ok">{m[4]}</span>);
    } else if (m[5] !== undefined) {
      out.push(<span key={key++} className="text-brand">{m[5]}</span>);
    } else if (m[6] !== undefined || m[7] !== undefined) {
      out.push(<span key={key++} className="text-fg-dim">{m[6] ?? m[7]}</span>);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export { cn };
