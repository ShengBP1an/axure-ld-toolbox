/**
 * 本地文件读写。
 * 优先使用 File System Access API，不可用时回退 <input type=file> 与 Blob 下载。
 * 全程本地，无任何网络请求。
 */

import { PipelineError } from '../types/errors';

interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  types?: FilePickerAcceptType[];
}

interface OpenFilePickerOptions {
  types?: FilePickerAcceptType[];
  multiple?: boolean;
}

interface FileSystemWritable {
  write(data: string | BufferSource | Blob): Promise<void>;
  close(): Promise<void>;
}

interface FileSystemFileHandleLike {
  getFile(): Promise<File>;
  createWritable(): Promise<FileSystemWritable>;
}

type WindowWithFsAccess = Window & {
  showSaveFilePicker?: (o?: SaveFilePickerOptions) => Promise<FileSystemFileHandleLike>;
  showOpenFilePicker?: (o?: OpenFilePickerOptions) => Promise<FileSystemFileHandleLike[]>;
};

function fsWindow(): WindowWithFsAccess | null {
  if (typeof window === 'undefined') return null;
  return window as WindowWithFsAccess;
}

/**
 * File System Access API 在当前宿主中是否已被证实不可用。
 *
 * 关键点：能力「存在」不等于「可用」。在 IDE 内置 WebView、跨源 iframe、
 * 非安全上下文中，`window.showSaveFilePicker` 照样是个函数，
 * 但真正调用时会抛 NotAllowedError / SecurityError。
 *
 * 更糟的是：用户在选择器里点「保存」的瞬间，操作系统已经把文件建好了（0 字节），
 * 之后 createWritable() 才被拒绝。网页无权删除它，于是每失败一次
 * 就在用户磁盘上留下一个空壳，用户很容易拿它去用然后报「文件损坏」。
 *
 * 因此该结论必须跨会话持久化——否则每次刷新页面都会重新踩一遍坑。
 */
const FS_BLOCKED_KEY = 'ld-toolbox.fsAccessBlocked';

function readBlockedFlag(): boolean {
  try {
    return localStorage.getItem(FS_BLOCKED_KEY) === '1';
  } catch {
    return false;
  }
}

let fsBlocked = readBlockedFlag();

/**
 * 无需用户手势即可判定的「必然不可用」场景。
 *
 * File System Access API 规范要求安全上下文；跨源 iframe 中亦被禁止。
 * 这两种情况可以在首次调用前就排除，从而连第一个空壳都不会产生。
 */
function isDefinitelyUnavailable(): boolean {
  if (typeof window === 'undefined') return true;
  if (!window.isSecureContext) return true;
  try {
    // 跨源嵌入时访问 top.location 会抛异常；同源嵌入则允许
    if (window.self !== window.top) {
      void window.top?.location.href;
    }
  } catch {
    return true;
  }
  return false;
}

/** 区分「用户主动取消」与「宿主环境禁止」。 */
function isUserCancel(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

function isBlockedByHost(e: unknown): boolean {
  if (!(e instanceof DOMException)) return false;
  // NotAllowedError：无用户激活或平台禁止；SecurityError：非安全上下文 / 跨源限制
  return e.name === 'NotAllowedError' || e.name === 'SecurityError';
}

function markBlocked(e: unknown): void {
  fsBlocked = true;
  try {
    localStorage.setItem(FS_BLOCKED_KEY, '1');
  } catch {
    /* 隐私模式下写不进去也无妨，本次会话内仍然生效 */
  }
  console.warn(
    '[file] 当前宿主禁止 File System Access API，已永久切换为下载 / 文件选择框回退方案。' +
      '如需恢复，请在控制台执行 localStorage.removeItem("' +
      FS_BLOCKED_KEY +
      '")。',
    e,
  );
}

/** 当前是否应当走「选择保存位置」路径。 */
function canUsePicker(w: WindowWithFsAccess | null): boolean {
  if (fsBlocked) return false;
  if (isDefinitelyUnavailable()) return false;
  return w !== null && typeof w.showSaveFilePicker === 'function';
}

export function hasFileSystemAccess(): boolean {
  return canUsePicker(fsWindow());
}

/** 保存结果。区分落盘方式，以便给出准确提示。 */
export type SaveOutcome =
  | { kind: 'picked' }
  /**
   * 由 vite dev 中间件写入工作区，附带绝对路径。
   * orphanName 非空表示：用户先前在选择器里确认过一个位置，
   * 系统已在那里建了文件、但随后写入被宿主拒绝，留下 0 字节残骸。
   */
  | { kind: 'devDisk'; path: string; orphanName?: string }
  | { kind: 'downloaded'; orphanName?: string }
  | { kind: 'cancelled' };

/**
 * 开发模式落盘通道。
 *
 * IDE 内置 WebView 既禁用 File System Access API、下载又不可见，
 * 此时页面拿不到文件。开发期由 vite 中间件代写到 exports/ 目录，
 * 生产构建下 import.meta.env.DEV 为 false，整段被摇树移除。
 */
async function saveViaDevServer(name: string, content: string): Promise<string | null> {
  if (!import.meta.env.DEV) return null;
  try {
    const res = await fetch('/__save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { ok?: boolean; path?: string };
    return data.ok === true && typeof data.path === 'string' ? data.path : null;
  } catch (e) {
    console.warn('[file] 开发落盘通道不可用', e);
    return null;
  }
}

export const SVG_TYPE: FilePickerAcceptType = {
  description: 'SVG 矢量图',
  accept: { 'image/svg+xml': ['.svg'] },
};

export const PROJECT_TYPE: FilePickerAcceptType = {
  description: 'LD 工具箱工程文件',
  accept: { 'application/json': ['.ldproj.json'] },
};

export const IMAGE_TYPE: FilePickerAcceptType = {
  description: '草图图片',
  accept: { 'image/*': ['.png', '.jpg', '.jpeg'] },
};

/**
 * 保存文本文件。
 *
 * 三级回退：选择保存位置 → 开发期写入工作区 exports/ → 浏览器下载。
 * 宿主禁止选择器不算失败——内容本身没有问题，只是落盘方式不同，
 * 报错会让用户误以为数据丢了。
 */
export async function saveTextFile(
  content: string,
  suggestedName: string,
  type: FilePickerAcceptType,
  mime: string,
): Promise<SaveOutcome> {
  const w = fsWindow();

  /* 用户已在选择器中确认位置、但写入被拒时，
   * 操作系统已在该位置建好空文件，无法从网页侧删除。
   * 必须记下来并告知用户，否则他会拿这个 0 字节文件去用。 */
  let orphanName: string | undefined;

  if (canUsePicker(w) && w?.showSaveFilePicker) {
    let picked = false;
    try {
      const handle = await w.showSaveFilePicker({ suggestedName, types: [type] });
      // 走到这里文件已被创建/截断
      picked = true;
      const writable = await handle.createWritable();
      try {
        await writable.write(new Blob([content], { type: mime }));
      } finally {
        await writable.close();
      }
      return { kind: 'picked' };
    } catch (e) {
      if (isUserCancel(e)) return { kind: 'cancelled' };
      if (picked) orphanName = suggestedName;
      if (isBlockedByHost(e)) {
        markBlocked(e);
        // 落到下方回退链
      } else {
        // 磁盘满、路径只读、句柄失效等真实写入故障，不静默吞掉
        console.error('[file] 写入所选位置失败', e);
        throw new PipelineError('EXPORT_WRITE_FAILED');
      }
    }
  }

  const devPath = await saveViaDevServer(suggestedName, content);
  if (devPath !== null) return { kind: 'devDisk', path: devPath, orphanName };

  downloadBlob(new Blob([content], { type: mime }), suggestedName);
  return { kind: 'downloaded', orphanName };
}

/** 拼接「所选位置残留空文件」的追加提示，无残留时返回空串。 */
export function orphanHint(outcome: SaveOutcome): string {
  const name = 'orphanName' in outcome ? outcome.orphanName : undefined;
  return name === undefined
    ? ''
    : ` 注意：你先前选择的位置留下了一个 0 字节的 ${name}，那是无效文件，请删除后改用上面的路径。`;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 延迟释放，避免部分浏览器下载被中断
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 打开文件选择器读取单个文件。返回 null 表示用户取消。 */
export async function openFile(type: FilePickerAcceptType, accept: string): Promise<File | null> {
  const w = fsWindow();

  if (canUsePicker(w) && w?.showOpenFilePicker) {
    try {
      const handles = await w.showOpenFilePicker({ types: [type], multiple: false });
      const first = handles[0];
      if (first === undefined) return null;
      // getFile() 自身也可能被宿主拒绝（句柄拿到了但读取权限被拦），
      // 必须一并纳入回退判断，否则会以未捕获的 Promise 异常形式冒泡。
      return await first.getFile();
    } catch (e) {
      if (isUserCancel(e)) return null;
      if (isBlockedByHost(e)) markBlocked(e);
      else console.error('[file] showOpenFilePicker 失败，回退为文件选择框', e);
      // 两种情况都回退到 <input type=file>
    }
  }

  return pickViaInput(accept);
}

function pickViaInput(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';

    let settled = false;
    const finish = (file: File | null): void => {
      if (settled) return;
      settled = true;
      if (input.parentNode !== null) input.remove();
      resolve(file);
    };

    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    // 取消时不会触发 change。窗口重新获得焦点后延时兜底，
    // 延时必须长于 change 的派发间隔，否则会在用户已选文件时误判为取消。
    window.addEventListener(
      'focus',
      () => {
        setTimeout(() => finish(input.files?.[0] ?? null), 800);
      },
      { once: true },
    );

    document.body.appendChild(input);
    input.click();
  });
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new PipelineError('DECODE_FAILED'));
    reader.readAsDataURL(file);
  });
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new PipelineError('PROJECT_PARSE_FAILED'));
    reader.readAsText(file, 'utf-8');
  });
}

export function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new PipelineError('DECODE_FAILED'));
    reader.readAsArrayBuffer(file);
  });
}
