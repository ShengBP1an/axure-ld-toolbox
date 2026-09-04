/**
 * 分级日志。
 *
 * 隐私约束：仅记录阶段耗时、元素计数与错误码，
 * 绝不记录像素数据、文件名或本地路径。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** 默认级别：开发环境输出 debug，生产环境只输出 warn 以上。 */
function detectDefaultLevel(): LogLevel {
  const meta = import.meta as unknown as { env?: { DEV?: boolean } };
  return meta.env?.DEV === true ? 'debug' : 'warn';
}

let minLevel: LogLevel = detectDefaultLevel();

export function setLogLevel(l: LogLevel): void {
  minLevel = l;
}

function enabled(l: LogLevel): boolean {
  return LEVEL_ORDER[l] >= LEVEL_ORDER[minLevel];
}

type Fields = Record<string, string | number | boolean | undefined>;

function emit(level: LogLevel, scope: string, message: string, fields?: Fields): void {
  if (!enabled(level)) return;
  const prefix = `[${scope}]`;
  const payload = fields ? [prefix, message, fields] : [prefix, message];
  if (level === 'error') console.error(...payload);
  else if (level === 'warn') console.warn(...payload);
  else console.log(...payload);
}

export interface Logger {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  /** 计时并在结束时输出耗时，返回毫秒数。 */
  time<T>(label: string, fn: () => T): T;
  timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T>;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, f) => emit('debug', scope, m, f),
    info: (m, f) => emit('info', scope, m, f),
    warn: (m, f) => emit('warn', scope, m, f),
    error: (m, f) => emit('error', scope, m, f),
    time<T>(label: string, fn: () => T): T {
      const t0 = now();
      const r = fn();
      emit('debug', scope, `${label} 完成`, { ms: Math.round(now() - t0) });
      return r;
    },
    async timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
      const t0 = now();
      const r = await fn();
      emit('debug', scope, `${label} 完成`, { ms: Math.round(now() - t0) });
      return r;
    },
  };
}

/** 跨环境（主线程 / Worker / Node 测试）可用的高精度计时。 */
export function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/** 阶段耗时收集器，供管线统计使用。 */
export class Stopwatch {
  private marks: Record<string, number> = {};
  private last = now();

  mark(stage: string): void {
    const t = now();
    this.marks[stage] = Math.round((t - this.last) * 100) / 100;
    this.last = t;
  }

  timings(): Record<string, number> {
    return { ...this.marks };
  }

  total(): number {
    return Object.values(this.marks).reduce((s, v) => s + v, 0);
  }
}
