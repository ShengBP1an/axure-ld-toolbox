/**
 * 稳定、唯一、可读的 ID 生成。
 * 计数器随项目持久化，保证同一工程内 ID 不复用、跨保存载入保持稳定。
 */

import type { LayerKind, VectorKind } from '../types/vector';

const LAYER_PREFIX: Record<LayerKind, string> = {
  boundary: 'boundary',
  wall: 'wall',
  region: 'region',
  review: 'review',
};

const KIND_SUFFIX: Record<VectorKind, string> = {
  line: 'line',
  polyline: 'poly',
  rect: 'rect',
  polygon: 'poly',
  openPath: 'path',
  closedPath: 'area',
};

export interface IdCounters {
  [prefix: string]: number;
}

export class IdFactory {
  private counters: IdCounters;

  constructor(initial: IdCounters = {}) {
    this.counters = { ...initial };
  }

  /** 生成形如 'wall-line-0007' 的 ID。 */
  next(layer: LayerKind, kind: VectorKind): string {
    const prefix = `${LAYER_PREFIX[layer]}-${KIND_SUFFIX[kind]}`;
    const n = (this.counters[prefix] ?? 0) + 1;
    this.counters[prefix] = n;
    return `${prefix}-${String(n).padStart(4, '0')}`;
  }

  /** 通用前缀 ID，例如 issue / hole。 */
  nextWith(prefix: string): string {
    const n = (this.counters[prefix] ?? 0) + 1;
    this.counters[prefix] = n;
    return `${prefix}-${String(n).padStart(4, '0')}`;
  }

  /** 载入既有 ID 集合后同步计数器，避免新建对象与旧 ID 冲突。 */
  syncWith(ids: Iterable<string>): void {
    for (const id of ids) {
      const m = /^(.*)-(\d+)$/.exec(id);
      if (!m) continue;
      const prefix = m[1]!;
      const n = Number.parseInt(m[2]!, 10);
      if (!Number.isFinite(n)) continue;
      if ((this.counters[prefix] ?? 0) < n) this.counters[prefix] = n;
    }
  }

  snapshot(): IdCounters {
    return { ...this.counters };
  }

  reset(): void {
    this.counters = {};
  }
}

/** 模块级默认工厂，UI 侧新建对象使用。 */
export const idFactory = new IdFactory();

/** 非持久化的临时 ID（会话内唯一，不写入工程文件）。 */
let ephemeral = 0;
export function tempId(prefix = 'tmp'): string {
  ephemeral += 1;
  return `${prefix}-${ephemeral.toString(36)}`;
}

/** 参数签名，用于判断识别结果是否需要重跑。 */
export function signature(obj: unknown): string {
  const json = JSON.stringify(obj, (_k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v));
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  return ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)).padStart(12, '0');
}
