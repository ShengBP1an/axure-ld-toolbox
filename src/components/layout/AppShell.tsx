/**
 * 应用外壳：顶部条 + 三栏布局 + 通知区。
 */

import React, { useEffect, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Compass,
  FolderOpen,
  Redo2,
  Save,
  Undo2,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { useProjectStore } from '../../store/useProjectStore';
import { useEditorStore } from '../../store/useEditorStore';
import { StepNav } from './StepNav';
import { Banner, IconButton, Tooltip } from '../ui';

interface AppShellProps {
  left: React.ReactNode;
  center: React.ReactNode;
  right: React.ReactNode;
  /** 顶部右侧主操作。 */
  primaryAction?: React.ReactNode;
  /** 全局横幅（例如管线错误），显示在三栏之上。 */
  banner?: React.ReactNode;
  onSaveProject?: () => void;
  onOpenProject?: () => void;
}

export function AppShell({
  left,
  center,
  right,
  primaryAction,
  banner,
  onSaveProject,
  onOpenProject,
}: AppShellProps) {
  const projectName = useProjectStore((s) => s.projectName);
  const setProjectName = useProjectStore((s) => s.setProjectName);
  const notices = useProjectStore((s) => s.notices);
  const dismissNotice = useProjectStore((s) => s.dismissNotice);

  const undo = useEditorStore((s) => s.undo);
  const redo = useEditorStore((s) => s.redo);
  const undoStack = useEditorStore((s) => s.undoStack);
  const redoStack = useEditorStore((s) => s.redoStack);

  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState(projectName);

  // 窄屏自动折叠右栏，保证画布可用面积
  useEffect(() => {
    const onResize = (): void => {
      if (window.innerWidth < 1280) setRightOpen(false);
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const undoLabel = undoStack[undoStack.length - 1]?.label;
  const redoLabel = redoStack[redoStack.length - 1]?.label;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-ink-900">
      {/* 顶部条 */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-ink-600/70 bg-ink-800/60 px-3 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-brand-grad text-ink-900 shadow-[0_0_14px_-3px_rgba(34,211,238,0.7)]">
            <Compass size={16} strokeWidth={2.5} />
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-fg-dim">
              Axure LD 工具箱
            </p>
            {renaming ? (
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={() => {
                  setProjectName(nameDraft);
                  setRenaming(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                  if (e.key === 'Escape') {
                    setNameDraft(projectName);
                    setRenaming(false);
                  }
                }}
                className="w-40 rounded border border-brand/60 bg-ink-900 px-1 text-[13px] font-semibold text-fg outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setNameDraft(projectName);
                  setRenaming(true);
                }}
                title="点击重命名"
                className="max-w-[220px] cursor-pointer truncate text-[13px] font-semibold text-fg transition-colors hover:text-brand"
              >
                {projectName}
              </button>
            )}
          </div>
        </div>

        <div className="mx-auto">
          <StepNav />
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Tooltip text={undoLabel !== undefined ? `撤销：${undoLabel}（Ctrl+Z）` : '无可撤销操作'}>
            <IconButton label="撤销" disabled={undoStack.length === 0} onClick={undo}>
              <Undo2 size={15} />
            </IconButton>
          </Tooltip>
          <Tooltip text={redoLabel !== undefined ? `重做：${redoLabel}（Ctrl+Shift+Z）` : '无可重做操作'}>
            <IconButton label="重做" disabled={redoStack.length === 0} onClick={redo}>
              <Redo2 size={15} />
            </IconButton>
          </Tooltip>

          <span className="mx-1 h-5 w-px bg-ink-600" />

          {onOpenProject !== undefined && (
            <Tooltip text="打开工程文件（.ldproj.json）">
              <IconButton label="打开工程" onClick={onOpenProject}>
                <FolderOpen size={15} />
              </IconButton>
            </Tooltip>
          )}
          {onSaveProject !== undefined && (
            <Tooltip text="保存工程到本地（Ctrl+S）">
              <IconButton label="保存工程" onClick={onSaveProject}>
                <Save size={15} />
              </IconButton>
            </Tooltip>
          )}

          {primaryAction !== undefined && <div className="ml-1">{primaryAction}</div>}
        </div>
      </header>

      {/* 全局横幅 */}
      {banner !== undefined && banner !== null && banner !== false && (
        <div className="shrink-0 border-b border-ink-600/60 bg-ink-800/40 px-3 py-2">{banner}</div>
      )}

      {/* 主体三栏 */}
      <div className="flex min-h-0 flex-1">
        {/* 左栏 */}
        <aside
          className={cn(
            'relative flex shrink-0 flex-col border-r border-ink-600/60 bg-ink-800/35 transition-[width] duration-200 ease-out',
            leftOpen ? 'w-[288px]' : 'w-0',
          )}
        >
          {leftOpen && (
            <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2.5">{left}</div>
          )}
          <button
            type="button"
            onClick={() => setLeftOpen(!leftOpen)}
            title={leftOpen ? '收起左栏' : '展开左栏'}
            className="absolute -right-3 top-3 z-20 flex h-6 w-6 cursor-pointer items-center justify-center
                       rounded-full border border-ink-500 bg-ink-800 text-fg-muted shadow-panel
                       transition-colors hover:border-brand/60 hover:text-brand"
          >
            {leftOpen ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}
          </button>
        </aside>

        {/* 中央画布 */}
        <main className="relative flex min-w-0 flex-1 flex-col">{center}</main>

        {/* 右栏 */}
        <aside
          className={cn(
            'relative flex shrink-0 flex-col border-l border-ink-600/60 bg-ink-800/35 transition-[width] duration-200 ease-out',
            rightOpen ? 'w-[320px]' : 'w-0',
          )}
        >
          {rightOpen && (
            <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2.5">{right}</div>
          )}
          <button
            type="button"
            onClick={() => setRightOpen(!rightOpen)}
            title={rightOpen ? '收起右栏' : '展开右栏'}
            className="absolute -left-3 top-3 z-20 flex h-6 w-6 cursor-pointer items-center justify-center
                       rounded-full border border-ink-500 bg-ink-800 text-fg-muted shadow-panel
                       transition-colors hover:border-brand/60 hover:text-brand"
          >
            {rightOpen ? <ChevronRight size={13} /> : <ChevronLeft size={13} />}
          </button>
        </aside>
      </div>

      {/* 通知区 */}
      {notices.length > 0 && (
        <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 w-[min(560px,90vw)] -translate-x-1/2 space-y-2">
          {notices.map((n) => (
            <div key={n.id} className="pointer-events-auto animate-fade-up">
              <Banner
                level={n.level}
                title={n.text}
                onClose={() => dismissNotice(n.id)}
              />
            </div>
          ))}
        </div>
      )}

      {/* 小屏提示 */}
      <SmallScreenHint />
    </div>
  );
}

function SmallScreenHint() {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const check = (): void => setNarrow(window.innerWidth < 1024);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  if (!narrow) return null;
  return (
    <div className="pointer-events-none fixed right-3 top-16 z-50 rounded-md border border-warn/45 bg-warn/10 px-2.5 py-1.5 text-[10px] text-warn backdrop-blur">
      建议在 1280px 以上宽度的屏幕使用，以获得完整工作区
    </div>
  );
}
