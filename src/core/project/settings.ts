/**
 * 项目设置逻辑：宽高比锁定推导、两点标定求解、标定与手输冲突优先级。
 *
 * 冲突优先级规则（Prompt 3.2 要求明确给出）：
 *   1. 两点标定成功后，scaleSource 置为 'calibration'，并按标定结果反推地图尺寸；
 *   2. 用户随后手动修改尺寸时，scaleSource 切回 'manual'，
 *      标定数据保留但标记 stale = true —— 不静默覆盖、可一键重新应用；
 *   3. 任一情况都会返回提示文案，由 UI 明确告知用户发生了什么。
 */

import { PipelineError } from '../../types/errors';
import type { Calibration, ProjectSettings, UnitSpec } from '../../types/project';
import { DEFAULT_SETTINGS, isAnisotropic, pixelsPerUnit, unitSymbol } from '../../types/project';
import type { Point } from '../../types/vector';
import { dist } from '../geometry/vec';

/** 修改结果：新设置 + 面向用户的提示。 */
export interface SettingsChange {
  settings: ProjectSettings;
  /** 需要向用户展示的提示（可为空）。 */
  notice: string | null;
  /** 提示级别。 */
  level: 'info' | 'warning';
}

function ok(settings: ProjectSettings): SettingsChange {
  return { settings, notice: null, level: 'info' };
}

/** 由原图尺寸初始化设置：默认锁定原图宽高比。 */
export function initFromImage(
  imageWidth: number,
  imageHeight: number,
  base: ProjectSettings = DEFAULT_SETTINGS,
): ProjectSettings {
  const ratio = imageHeight > 0 ? imageWidth / imageHeight : 1;
  // 画布像素默认取原图长边压到 1600 以内，兼顾 Axure 画布的常用尺寸
  const longSide = Math.max(imageWidth, imageHeight);
  const k = longSide > 1600 ? 1600 / longSide : 1;
  const canvasW = Math.max(1, Math.round(imageWidth * k));
  const canvasH = Math.max(1, Math.round(imageHeight * k));

  // 地图实际尺寸默认按 1 单位 = 20 像素给出一个可用初值
  const mapW = Math.round((canvasW / 20) * 10) / 10;
  const mapH = Math.round((mapW / ratio) * 10) / 10;

  return {
    ...base,
    mapWidth: mapW,
    mapHeight: mapH,
    canvasWidthPx: canvasW,
    canvasHeightPx: canvasH,
    lockAspect: true,
    aspectRatio: ratio,
    scaleSource: 'manual',
    calibration: null,
  };
}

/* ------------------------------------------------------------------ */
/* 地图实际尺寸                                                        */
/* ------------------------------------------------------------------ */

export function setMapWidth(s: ProjectSettings, value: number): SettingsChange {
  const w = sanitize(value, s.mapWidth);
  const next: ProjectSettings = { ...s, mapWidth: w };
  if (s.lockAspect && s.aspectRatio > 0) {
    next.mapHeight = round3(w / s.aspectRatio);
  }
  return withCalibrationConflict(s, next, '地图宽度');
}

export function setMapHeight(s: ProjectSettings, value: number): SettingsChange {
  const h = sanitize(value, s.mapHeight);
  const next: ProjectSettings = { ...s, mapHeight: h };
  if (s.lockAspect && s.aspectRatio > 0) {
    next.mapWidth = round3(h * s.aspectRatio);
  }
  return withCalibrationConflict(s, next, '地图高度');
}

/* ------------------------------------------------------------------ */
/* 画布像素尺寸                                                        */
/* ------------------------------------------------------------------ */

export function setCanvasWidth(s: ProjectSettings, value: number): SettingsChange {
  const w = Math.max(1, Math.round(sanitize(value, s.canvasWidthPx)));
  const next: ProjectSettings = { ...s, canvasWidthPx: w };
  if (s.lockAspect && s.aspectRatio > 0) {
    next.canvasHeightPx = Math.max(1, Math.round(w / s.aspectRatio));
  }
  return anisotropyNotice(next);
}

export function setCanvasHeight(s: ProjectSettings, value: number): SettingsChange {
  const h = Math.max(1, Math.round(sanitize(value, s.canvasHeightPx)));
  const next: ProjectSettings = { ...s, canvasHeightPx: h };
  if (s.lockAspect && s.aspectRatio > 0) {
    next.canvasWidthPx = Math.max(1, Math.round(h * s.aspectRatio));
  }
  return anisotropyNotice(next);
}

/* ------------------------------------------------------------------ */
/* 宽高比锁定                                                          */
/* ------------------------------------------------------------------ */

export function setLockAspect(s: ProjectSettings, lock: boolean): SettingsChange {
  if (lock) {
    // 重新锁定时以当前地图尺寸为基准，并把画布拉回同比例
    const ratio = s.mapHeight > 0 ? s.mapWidth / s.mapHeight : s.aspectRatio;
    const next: ProjectSettings = {
      ...s,
      lockAspect: true,
      aspectRatio: ratio,
      canvasHeightPx: Math.max(1, Math.round(s.canvasWidthPx / (ratio || 1))),
    };
    return {
      settings: next,
      notice: `已锁定宽高比 ${ratio.toFixed(3)}，画布高度已同步为 ${next.canvasHeightPx}px。`,
      level: 'info',
    };
  }
  return {
    settings: { ...s, lockAspect: false },
    notice: '已解除宽高比锁定。非等比缩放会使图形横纵拉伸变形，请确认这是预期效果。',
    level: 'warning',
  };
}

/** 恢复原图宽高比。 */
export function restoreImageAspect(
  s: ProjectSettings,
  imageWidth: number,
  imageHeight: number,
): SettingsChange {
  if (imageWidth <= 0 || imageHeight <= 0) {
    return { settings: s, notice: '没有可用的原图尺寸信息。', level: 'warning' };
  }
  const ratio = imageWidth / imageHeight;
  const next: ProjectSettings = {
    ...s,
    lockAspect: true,
    aspectRatio: ratio,
    mapHeight: round3(s.mapWidth / ratio),
    canvasHeightPx: Math.max(1, Math.round(s.canvasWidthPx / ratio)),
  };
  return {
    settings: next,
    notice: `已恢复原图宽高比 ${ratio.toFixed(3)}。`,
    level: 'info',
  };
}

export function setUnit(s: ProjectSettings, unit: UnitSpec): SettingsChange {
  return ok({ ...s, unit });
}

/* ------------------------------------------------------------------ */
/* 两点标定                                                            */
/* ------------------------------------------------------------------ */

export interface CalibrationInput {
  /** 图像像素空间的两点。 */
  p1: Point;
  p2: Point;
  /** 用户输入的实际距离（地图单位）。 */
  realDistance: number;
  /** 当前工作图像尺寸（像素）。 */
  imageWidth: number;
  imageHeight: number;
}

/** 标定所需的最小像素距离：太近会让比例误差被放大。 */
export const MIN_CALIBRATION_PIXELS = 20;

/**
 * 应用两点标定。
 *
 * 计算：unitsPerImagePx = realDistance / pixelDistance
 * 然后由整幅图像的像素尺寸反推地图实际尺寸。
 *
 * @throws PipelineError CALIBRATION_FAILED 当两点过近或距离无效
 */
export function applyCalibration(s: ProjectSettings, input: CalibrationInput): SettingsChange {
  const pixelDistance = dist(input.p1, input.p2);
  if (pixelDistance < MIN_CALIBRATION_PIXELS) {
    throw new PipelineError('CALIBRATION_FAILED', {
      pixelDistance: Math.round(pixelDistance * 10) / 10,
      minimum: MIN_CALIBRATION_PIXELS,
    });
  }
  if (!Number.isFinite(input.realDistance) || input.realDistance <= 0) {
    throw new PipelineError('CALIBRATION_FAILED', { realDistance: input.realDistance });
  }
  if (input.imageWidth <= 0 || input.imageHeight <= 0) {
    throw new PipelineError('CALIBRATION_FAILED', { reason: 'noImage' });
  }

  const unitsPerImagePx = input.realDistance / pixelDistance;
  const mapWidth = round3(input.imageWidth * unitsPerImagePx);
  const mapHeight = round3(input.imageHeight * unitsPerImagePx);

  const calibration: Calibration = {
    p1: { ...input.p1 },
    p2: { ...input.p2 },
    realDistance: input.realDistance,
    unitsPerImagePx,
    stale: false,
    createdAt: Date.now(),
  };

  const next: ProjectSettings = {
    ...s,
    mapWidth,
    mapHeight,
    // 标定同时确定了宽高比（图像像素比即地图实际比）
    aspectRatio: input.imageWidth / input.imageHeight,
    scaleSource: 'calibration',
    calibration,
  };

  const sym = unitSymbol(s.unit);
  return {
    settings: next,
    notice: `已按标定更新地图尺寸为 ${mapWidth} × ${mapHeight} ${sym}（1 像素 ≈ ${unitsPerImagePx.toFixed(4)} ${sym}）。`,
    level: 'info',
  };
}

/** 重新应用已存在但已过期（stale）的标定。 */
export function reapplyCalibration(
  s: ProjectSettings,
  imageWidth: number,
  imageHeight: number,
): SettingsChange {
  const c = s.calibration;
  if (c === null) {
    return { settings: s, notice: '尚未进行过两点标定。', level: 'warning' };
  }
  return applyCalibration(s, {
    p1: c.p1,
    p2: c.p2,
    realDistance: c.realDistance,
    imageWidth,
    imageHeight,
  });
}

/** 重置标定：清除标定数据并回到手动模式。 */
export function resetCalibration(s: ProjectSettings): SettingsChange {
  if (s.calibration === null) return ok(s);
  return {
    settings: { ...s, calibration: null, scaleSource: 'manual' },
    notice: '已清除两点标定，比例改为手动输入。',
    level: 'info',
  };
}

/**
 * 手动修改尺寸时的标定冲突处理。
 * 标定数据保留但标记 stale，并明确告知用户优先级。
 */
function withCalibrationConflict(
  prev: ProjectSettings,
  next: ProjectSettings,
  fieldLabel: string,
): SettingsChange {
  const hasActiveCalibration = prev.calibration !== null && !prev.calibration.stale;
  if (!hasActiveCalibration) return anisotropyNotice(next);

  const staled: ProjectSettings = {
    ...next,
    scaleSource: 'manual',
    calibration: { ...prev.calibration!, stale: true },
  };
  return {
    settings: staled,
    notice: `手动修改了「${fieldLabel}」，已优先采用手动输入值；两点标定结果被标记为过期（数据保留，可点击「重新应用标定」恢复）。`,
    level: 'warning',
  };
}

/** 非等比时给出变形提示。 */
function anisotropyNotice(next: ProjectSettings): SettingsChange {
  if (!next.lockAspect && isAnisotropic(next)) {
    const sx = pixelsPerUnit(next);
    const sy = next.mapHeight > 0 ? next.canvasHeightPx / next.mapHeight : sx;
    return {
      settings: next,
      notice: `当前为非等比缩放（横向 ${sx.toFixed(2)} px/单位，纵向 ${sy.toFixed(2)} px/单位），导出图形会被拉伸变形。`,
      level: 'warning',
    };
  }
  return ok(next);
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

export interface SettingsValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateSettings(s: ProjectSettings): SettingsValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!(s.mapWidth > 0)) errors.push('地图宽度必须大于 0。');
  if (!(s.mapHeight > 0)) errors.push('地图高度必须大于 0。');
  if (!(s.canvasWidthPx >= 1)) errors.push('画布宽度必须至少 1 像素。');
  if (!(s.canvasHeightPx >= 1)) errors.push('画布高度必须至少 1 像素。');

  if (s.canvasWidthPx > 20000 || s.canvasHeightPx > 20000) {
    warnings.push('画布像素尺寸过大，Axure 中可能出现性能问题。');
  }
  if (!s.lockAspect && isAnisotropic(s)) {
    warnings.push('宽高比未锁定且横纵比例不同，图形会变形。');
  }
  if (s.calibration !== null && s.calibration.stale) {
    warnings.push('两点标定结果已过期（尺寸被手动修改过）。');
  }
  const ppu = pixelsPerUnit(s);
  if (ppu > 0 && ppu < 0.5) {
    warnings.push('每单位不足 0.5 像素，导出后细节可能不可见。建议增大画布尺寸。');
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** 面向 UI 的比例摘要文案。 */
export function scaleSummary(s: ProjectSettings): string {
  const sym = unitSymbol(s.unit);
  const ppu = pixelsPerUnit(s);
  return `1 ${sym} = ${ppu.toFixed(2)} px`;
}

function sanitize(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return round3(value);
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
