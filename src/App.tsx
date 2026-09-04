/**
 * 应用根组件：按步骤组织三栏内容，并串联工程存读。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Undo2 } from 'lucide-react';
import { AppShell } from './components/layout/AppShell';
import { StepFooter } from './components/layout/StepNav';
import { CanvasStatusBar, CanvasToolbar, SnapSettings } from './components/layout/CanvasChrome';
import { ImportPanel } from './components/import/ImportPanel';
import { PreprocessControls, PreprocessPreview } from './components/import/PreprocessPreview';
import { ScalePanel } from './components/scale/ScalePanel';
import { CalibrationOverlay } from './components/scale/CalibrationOverlay';
import { RecognizePanel } from './components/recognize/RecognizePanel';
import { IssueList } from './components/issues/IssueList';
import { LayerTree } from './components/inspector/LayerTree';
import { ElementInspector } from './components/inspector/ElementInspector';
import { ExportPanel, SvgPreview } from './components/export/ExportPanel';
import { AxureGuide } from './components/export/AxureGuide';
import { Banner, Button, Panel } from './components/ui';
import { EditorCanvas, type ViewportApi } from './editor/EditorCanvas';
import { useProjectStore } from './store/useProjectStore';
import { useEditorStore } from './store/useEditorStore';
import { usePipelineRunner, errorAdvice } from './hooks/usePipelineRunner';
import { screenToUnit } from './editor/viewport';
import type { Bounds } from './types/vector';
import {
  deserializeProject,
  projectFileName,
  serializeProject,
} from './core/project/serialize';
import { openFile, orphanHint, PROJECT_TYPE, readFileAsText, saveTextFile } from './lib/file';
import { decodeDataUrl } from './core/preprocess/decode';
import { idFactory } from './lib/id';
import { PipelineError } from './types/errors';

export default function App() {
  const step = useProjectStore((s) => s.step);
  const source = useProjectStore((s) => s.source);
  const result = useProjectStore((s) => s.result);
  const lastError = useProjectStore((s) => s.lastError);
  const clearError = useProjectStore((s) => s.clearError);
  const goStep = useProjectStore((s) => s.goStep);
  const markCompleted = useProjectStore((s) => s.markCompleted);
  const notify = useProjectStore((s) => s.notify);

  const runner = usePipelineRunner();

  const [calibrating, setCalibrating] = useState(false);
  const [highlight, setHighlight] = useState<Bounds | null>(null);
  const [cursorUnit, setCursorUnit] = useState<{ x: number; y: number } | null>(null);
  const viewportApi = useRef<ViewportApi | null>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);

  /* ---------------- 源图 <img> 元素（底图渲染用） ---------------- */
  const [sourceImg, setSourceImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (source === null || source.dataUrl === '') {
      setSourceImg(null);
      return;
    }
    const img = new Image();
    img.src = source.dataUrl;
    let cancelled = false;
    img
      .decode()
      .then(() => {
        if (!cancelled) setSourceImg(img);
      })
      .catch((e: unknown) => {
        console.error('[app] 底图解码失败', e);
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  /* ---------------- 工程存读 ---------------- */
  const saveProject = useCallback(async (): Promise<void> => {
    const p = useProjectStore.getState();
    const e = useEditorStore.getState();
    const text = serializeProject({
      projectName: p.projectName,
      source: p.source,
      settings: p.settings,
      preprocess: p.preprocess,
      preset: p.preset,
      recognize: p.recognize,
      exportSettings: p.exportSettings,
      elements: [...e.elements.values()],
      order: e.order,
      issues: [...e.issues.values()],
      autoElements: e.autoSnapshot?.elements ?? null,
      autoOrder: e.autoSnapshot?.order ?? null,
      idCounters: idFactory.snapshot(),
      layerVisible: e.layerVisible,
      layerLocked: e.layerLocked,
      strokeWidthPx: e.strokeWidthPx,
      imageArea: e.imageArea,
    });
    const outcome = await saveTextFile(
      text,
      projectFileName(p.projectName),
      PROJECT_TYPE,
      'application/json',
    ).catch((err: unknown) => {
      console.error('[app] 保存工程失败', err);
      notify('工程保存失败，请检查保存位置权限。', 'error');
      return { kind: 'cancelled' } as const;
    });

    switch (outcome.kind) {
      case 'picked':
        notify('工程已保存到本地。', 'success');
        break;
      case 'devDisk':
        notify(`工程已写入 ${outcome.path}${orphanHint(outcome)}`, 'success');
        break;
      case 'downloaded':
        notify(`工程已下载到默认下载目录。${orphanHint(outcome)}`, 'success');
        break;
      case 'cancelled':
        break;
    }
  }, [notify]);

  const openProject = useCallback(async (): Promise<void> => {
    const file = await openFile(PROJECT_TYPE, '.json,application/json');
    if (file === null) return;

    const text = await readFileAsText(file).catch((e: unknown) => {
      console.error('[app] 读取工程失败', e);
      return null;
    });
    if (text === null) {
      notify('工程文件读取失败。', 'error');
      return;
    }

    const parsed = ((): ReturnType<typeof deserializeProject> | null => {
      try {
        return deserializeProject(text);
      } catch (e) {
        if (e instanceof PipelineError) notify(e.message, 'error');
        else console.error('[app] 解析工程失败', e);
        return null;
      }
    })();
    if (parsed === null) return;

    const p = useProjectStore.getState();
    p.setProjectName(parsed.projectName);
    p.setPreset(parsed.preset);
    p.setPreprocess(parsed.preprocess);
    p.setRecognize(parsed.recognize);
    p.setExportSettings(parsed.exportSettings);

    // 恢复源图像素（用于重新识别）
    if (parsed.source !== null && parsed.source.dataUrl !== '') {
      const pixels = await decodeDataUrl(parsed.source.dataUrl).catch((e: unknown) => {
        console.error('[app] 工程内源图解码失败', e);
        return null;
      });
      if (pixels !== null) {
        p.setSource(parsed.source, pixels);
      }
    }
    // setSource 会重置 settings，因此在其后恢复
    p.applySettingsChange({ settings: parsed.settings, notice: null, level: 'info' });

    idFactory.reset();
    const restored = new IdRestore(parsed.idCounters);
    restored.applyTo();
    idFactory.syncWith(parsed.elements.map((el) => el.id));

    const e = useEditorStore.getState();
    e.loadResult(parsed.elements, parsed.issues, parsed.strokeWidthPx, parsed.imageArea);

    p.markCompleted('import');
    p.markCompleted('scale');
    if (parsed.elements.length > 0) {
      p.markCompleted('recognize');
      p.goStep('edit');
    } else {
      p.goStep('scale');
    }
    notify(`已载入工程「${parsed.projectName}」（${parsed.elements.length} 个对象）。`, 'success');
  }, [notify]);

  /* ---------------- 全局快捷键：Ctrl+S / Ctrl+Z / Ctrl+Shift+Z ---------------- */
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      const t = ev.target as HTMLElement | null;
      if (t !== null && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      if (!(ev.ctrlKey || ev.metaKey)) return;

      const k = ev.key.toLowerCase();
      if (k === 's') {
        ev.preventDefault();
        void saveProject();
        return;
      }
      if (k === 'o') {
        ev.preventDefault();
        void openProject();
        return;
      }
      if (k === 'z') {
        ev.preventDefault();
        const e = useEditorStore.getState();
        if (ev.shiftKey) e.redo();
        else e.undo();
      }
      if (k === 'y') {
        ev.preventDefault();
        useEditorStore.getState().redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveProject, openProject]);

  /* ---------------- 问题定位 ---------------- */
  const focusRegion = useCallback((region: Bounds | null): void => {
    if (region === null) return;
    viewportApi.current?.focusOn(region);
    setHighlight(region);
    window.setTimeout(() => setHighlight(null), 1800);
  }, []);

  /* ---------------- 画布容器（供标定层计算图像矩形） ---------------- */
  const imageRect = useMemo(() => {
    const host = canvasHostRef.current;
    if (host === null) return { left: 0, top: 0, width: 1, height: 1 };
    const r = host.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }, [calibrating]);

  const workingImage = useProjectStore((s) => s.workingImage);

  /* ---------------- 各步骤内容 ---------------- */
  const left = (() => {
    switch (step) {
      case 'import':
        // 未导入时拖拽区占据中央大面积区域，左栏只放流程说明
        return source === null ? (
          <Panel title="工作流程">
            <ol className="space-y-2">
              {[
                ['导入草图', '拖入或选择一张手绘地图照片 / 扫描图'],
                ['尺寸与比例', '设定地图真实尺寸与输出画布像素'],
                ['识别矢量化', '自动提取墙线与封闭区域'],
                ['校正编辑', '修正识别错误、编辑节点'],
                ['导出 SVG', '导入 Axure 并转换为形状'],
              ].map(([t, d], i) => (
                <li key={t} className="flex gap-2">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-ink-500 text-[9px] font-bold text-fg-dim">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-fg">{t}</p>
                    <p className="mt-0.5 text-[10px] leading-snug text-fg-muted">{d}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="divider" />
            <p className="text-[10px] leading-relaxed text-fg-dim">
              交付物为 Axure 兼容的分层 SVG，不直接生成 .rp 文件。
              图像与工程全程仅在本机处理。
            </p>
          </Panel>
        ) : (
          <>
            <ImportPanel />
            <PreprocessControls runner={runner} />
          </>
        );
      case 'scale':
        return <ScalePanel onStartCalibrate={() => setCalibrating(true)} />;
      case 'recognize':
        return <RecognizePanel runner={runner} />;
      case 'edit':
        return (
          <>
            <Panel title="吸附设置" collapsible>
              <SnapSettings />
            </Panel>
            <LayerTree />
          </>
        );
      case 'export':
        return <ExportPanel onFocus={(region) => focusRegion(region)} />;
    }
  })();

  const right = (() => {
    switch (step) {
      case 'import':
        return (
          <>
            <Panel title="下一步">
              <p className="text-[11px] leading-relaxed text-fg-muted">
                确认预处理结果已完整保留所有墙线后，进入「尺寸与比例」设置地图真实尺寸。
              </p>
            </Panel>
            <Panel title="预处理说明" collapsible defaultOpen={false}>
              <ul className="space-y-1.5 text-[10px] leading-relaxed text-fg-muted">
                <li>
                  <b className="text-fg">阴影抑制</b>：用大核盒式模糊估计低频光照场后做除法归一化，
                  拉平拍照阴影，同时保留高频笔画。
                </li>
                <li>
                  <b className="text-fg">对比度增强</b>：分块直方图均衡（CLAHE 近似）+ 限幅，
                  提亮暗区浅笔画而不过度放大噪声。
                </li>
                <li>
                  <b className="text-fg">二值化</b>：Bradley-Roth 自适应阈值（积分图 O(N)），
                  前景占比异常时回退 Otsu 全局阈值。
                </li>
                <li>
                  <b className="text-fg">倾斜校正</b>：投影方差法，水平墙线集中度最高时即为正立，
                  自动范围 ±15°。
                </li>
              </ul>
            </Panel>
          </>
        );
      case 'scale':
        return (
          <>
            <Panel title="为什么要区分两种尺寸">
              <div className="space-y-2 text-[10px] leading-relaxed text-fg-muted">
                <p>
                  <b className="text-fg">地图实际尺寸</b>是地图在游戏世界中的真实大小（米 / 格），
                  决定所有矢量坐标的存储值，也是你与关卡团队沟通的语言。
                </p>
                <p>
                  <b className="text-fg">输出画布像素</b>是 SVG 的 viewBox 尺寸，
                  决定图形导入 Axure 后有多大。
                </p>
                <p className="border-t border-ink-600/50 pt-2">
                  只改画布像素时，矢量坐标不变，只有导出像素按新比例换算；
                  改地图尺寸时，所有坐标与线宽按<b className="text-brand">同一组比例因子</b>整体更新，
                  不会出现局部对象比例不一致。
                </p>
              </div>
            </Panel>
          </>
        );
      case 'recognize':
        return (
          <>
            <Panel title="识别流水线" collapsible>
              <ol className="space-y-1.5 text-[10px] leading-relaxed text-fg-muted">
                <li><b className="text-fg">1. 骨架细化</b>：Zhang–Suen 把有宽度的墙线压成单像素路径，再剪除冗余像素使其严格 1 像素宽。</li>
                <li><b className="text-fg">2. 结构图</b>：按交叉数区分端点与交点，把骨架追踪为分支折线。</li>
                <li><b className="text-fg">3. 线段拟合</b>：RDP 粗分拐点 + 逐段全最小二乘拟合，用拟合线求交作为顶点，去除手绘抖动。</li>
                <li><b className="text-fg">4. 吸附</b>：角度吸附拉正近水平 / 垂直线；端点聚簇 + 坐标带对齐使相邻房间共享墙线。</li>
                <li><b className="text-fg">5. 桥接</b>：断线端点配对、延长求交补齐拐角、合并重复线与双线墙。</li>
                <li><b className="text-fg">6. 面提取</b>：平面图半边遍历提取所有内部面——这是共享墙房间能输出为多个独立矩形的关键。</li>
                <li><b className="text-fg">7. 分类</b>：择优输出 rect / polygon / line / polyline / path，优先最简语义。</li>
                <li><b className="text-fg">8. 简化</b>：RDP + 拓扑守卫，拒绝任何使通道消失或引入自相交的简化。</li>
              </ol>
            </Panel>
          </>
        );
      case 'edit':
        return (
          <>
            <ElementInspector />
            <IssueList onFocus={(region) => focusRegion(region)} onHover={setHighlight} />
            <ResetToAutoPanel />
          </>
        );
      case 'export':
        return <AxureGuide />;
    }
  })();

  const center = (() => {
    if (step === 'import') {
      return source === null ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 px-6 pt-6 text-center">
            <p className="text-head font-semibold text-fg">手绘 Layout → Axure 可编辑 LD</p>
            <p className="mx-auto mt-2 max-w-xl text-[12px] leading-relaxed text-fg-muted">
              导入草图 → 设置尺寸与比例 → 识别矢量化 → 校正 → 导出分层 SVG，
              再在 Axure RP 中「转换 SVG 为形状」得到可编辑白盒。
            </p>
          </div>
          <ImportPanel />
        </div>
      ) : (
        <>
          <PreprocessPreview />
          <StepFooter
            onNext={() => {
              markCompleted('import');
              goStep('scale');
            }}
            nextLabel="设置尺寸与比例"
          />
        </>
      );
    }

    if (step === 'export') {
      return (
        <>
          <SvgPreview />
          <StepFooter />
        </>
      );
    }

    // scale / recognize / edit 共用画布
    return (
      <>
        <div ref={canvasHostRef} className="relative min-h-0 flex-1">
          <EditorCanvas
            sourceImage={sourceImg}
            interactionDisabled={calibrating || step !== 'edit'}
            highlightRegion={highlight}
            onViewportApi={(api) => {
              viewportApi.current = api;
            }}
          />
          {step === 'edit' && <CanvasToolbar api={viewportApi.current} />}
          <CanvasStatusBar cursorUnit={cursorUnit} />

          {calibrating && workingImage !== null && (
            <CalibrationOverlay
              imageRect={imageRect}
              imageWidth={workingImage.width}
              imageHeight={workingImage.height}
              onDone={() => setCalibrating(false)}
              onCancel={() => setCalibrating(false)}
            />
          )}

          {/* 光标坐标跟踪 */}
          <div
            className="pointer-events-none absolute inset-0"
            onMouseMove={undefined}
          />
          <CursorTracker hostRef={canvasHostRef} onChange={setCursorUnit} />

          {step === 'scale' && workingImage === null && (
            <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
              <div className="glass-pill pointer-events-auto">
                <span className="text-[11px] text-fg-muted">
                  需要先生成工作图像才能进行两点标定
                </span>
                <Button variant="outline" className="h-6 text-[10px]" onClick={() => runner.runPreprocessPreview()}>
                  立即生成
                </Button>
              </div>
            </div>
          )}
        </div>

        {step === 'scale' && (
          <StepFooter
            onNext={() => {
              markCompleted('scale');
              goStep('recognize');
            }}
            nextLabel="开始识别"
          />
        )}
        {step === 'recognize' && (
          <StepFooter
            onNext={() => goStep('edit')}
            nextLabel="进入校正"
            nextDisabled={result === null}
            nextHint="请先完成识别"
          />
        )}
        {step === 'edit' && (
          <StepFooter
            onNext={() => {
              markCompleted('edit');
              goStep('export');
            }}
            nextLabel="导出 SVG"
          />
        )}
      </>
    );
  })();

  return (
    <AppShell
      left={left}
      center={center}
      right={right}
      onSaveProject={() => void saveProject()}
      onOpenProject={() => void openProject()}
      banner={
        lastError !== null && step !== 'recognize' ? (
          <Banner
            level={lastError.recoverable ? 'warning' : 'error'}
            title={lastError.message}
            onClose={clearError}
          >
            {errorAdvice(lastError.code)}
          </Banner>
        ) : undefined
      }
      primaryAction={
        result !== null && step !== 'export' ? (
          <Button
            variant="primary"
            icon={<Download size={13} />}
            onClick={() => {
              markCompleted('edit');
              goStep('export');
            }}
          >
            导出
          </Button>
        ) : undefined
      }
    />
  );
}

/** 「回到自动识别结果」面板。 */
function ResetToAutoPanel() {
  const resetToAuto = useEditorStore((s) => s.resetToAuto);
  const autoSnapshot = useEditorStore((s) => s.autoSnapshot);
  const undoStack = useEditorStore((s) => s.undoStack);
  const notify = useProjectStore((s) => s.notify);

  if (autoSnapshot === null) return null;

  return (
    <Panel title="恢复">
      <Button
        variant="outline"
        className="w-full"
        icon={<Undo2 size={13} />}
        disabled={undoStack.length === 0}
        onClick={() => {
          resetToAuto();
          notify('已回到自动识别的初始结果（本次操作也可撤销）。', 'info');
        }}
      >
        回到自动识别结果
      </Button>
      <p className="mt-1.5 text-[10px] leading-snug text-fg-dim">
        丢弃全部人工编辑，恢复到本次识别刚完成时的状态。该操作本身也进入撤销栈。
      </p>
      <p className="mt-1 text-[10px] text-fg-dim">
        当前已有 {undoStack.length} 步可撤销操作。
      </p>
    </Panel>
  );
}

/** 光标坐标跟踪（不引入额外重绘）。 */
function CursorTracker({
  hostRef,
  onChange,
}: {
  hostRef: React.RefObject<HTMLDivElement>;
  onChange: (p: { x: number; y: number } | null) => void;
}) {
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    let raf = 0;
    const onMove = (e: MouseEvent): void => {
      if (raf !== 0) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        const rect = host.getBoundingClientRect();
        const vp = useEditorStore.getState().viewport;
        onChange(screenToUnit({ x: e.clientX - rect.left, y: e.clientY - rect.top }, vp));
      });
    };
    const onLeave = (): void => onChange(null);
    host.addEventListener('mousemove', onMove);
    host.addEventListener('mouseleave', onLeave);
    return () => {
      host.removeEventListener('mousemove', onMove);
      host.removeEventListener('mouseleave', onLeave);
      if (raf !== 0) window.cancelAnimationFrame(raf);
    };
  }, [hostRef, onChange]);
  return null;
}

/** 恢复 ID 计数器的小工具（避免直接暴露内部字段）。 */
class IdRestore {
  constructor(private readonly counters: Record<string, number>) {}
  applyTo(): void {
    // IdFactory.syncWith 接受 id 列表；这里用合成 id 还原计数器
    const ids: string[] = [];
    for (const [prefix, n] of Object.entries(this.counters)) {
      ids.push(`${prefix}-${String(n).padStart(4, '0')}`);
    }
    idFactory.syncWith(ids);
  }
}
