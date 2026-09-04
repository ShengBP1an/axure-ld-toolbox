/**
 * 图像解码、EXIF 方向修正、裁剪与下采样。
 * 仅在主线程运行（依赖 createImageBitmap / OffscreenCanvas）。
 * 原始 File / dataURL 始终保留，本模块只产出副本。
 */

import { PipelineError } from '../../types/errors';
import type { PreprocessParams, SourceImage } from '../../types/project';
import type { RgbaImage } from './IPreprocessor';
import { denormalizeQuad, warpPerspective } from './perspective';

/** 输入上限。超限时提示用户压缩，而非静默处理失败。 */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_DIMENSION = 8000;
export const ACCEPTED_MIME = ['image/jpeg', 'image/jpg', 'image/png'];

export interface ValidationResult {
  ok: boolean;
  error?: PipelineError;
}

export function validateFile(file: File): ValidationResult {
  const mime = file.type.toLowerCase();
  if (mime !== '' && !ACCEPTED_MIME.includes(mime)) {
    return { ok: false, error: new PipelineError('UNSUPPORTED_FORMAT', { mime }) };
  }
  if (file.size > MAX_FILE_BYTES) {
    return {
      ok: false,
      error: new PipelineError('TOO_LARGE', {
        sizeMb: Math.round((file.size / 1024 / 1024) * 10) / 10,
        limitMb: MAX_FILE_BYTES / 1024 / 1024,
      }),
    };
  }
  return { ok: true };
}

/**
 * 读取 JPEG EXIF Orientation（1..8）。
 * 手写最小解析器：只扫描 APP1 段中的 0x0112 tag，不引入第三方库。
 */
export async function readExifOrientation(file: File): Promise<number> {
  if (!file.type.toLowerCase().includes('jpeg') && !file.type.toLowerCase().includes('jpg')) return 1;
  // EXIF 位于文件头部，读取前 128KB 足够
  const head = await file.slice(0, 131072).arrayBuffer();
  const view = new DataView(head);
  if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return 1;

  let offset = 2;
  while (offset + 4 < view.byteLength) {
    const marker = view.getUint16(offset, false);
    if ((marker & 0xff00) !== 0xff00) break;
    const size = view.getUint16(offset + 2, false);
    if (marker === 0xffe1) {
      // APP1: 检查 "Exif\0\0"
      if (offset + 10 > view.byteLength) break;
      if (view.getUint32(offset + 4, false) !== 0x45786966) break;
      const tiffStart = offset + 10;
      if (tiffStart + 8 > view.byteLength) break;
      const byteOrder = view.getUint16(tiffStart, false);
      const little = byteOrder === 0x4949;
      if (!little && byteOrder !== 0x4d4d) break;
      const ifdOffset = view.getUint32(tiffStart + 4, little);
      const ifd = tiffStart + ifdOffset;
      if (ifd + 2 > view.byteLength) break;
      const entries = view.getUint16(ifd, little);
      for (let i = 0; i < entries; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 12 > view.byteLength) break;
        if (view.getUint16(entry, little) === 0x0112) {
          const v = view.getUint16(entry + 8, little);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      break;
    }
    offset += 2 + size;
  }
  return 1;
}

/** EXIF 方向对应的画布变换。 */
function applyOrientation(
  ctx: CanvasRenderingContext2D,
  orientation: number,
  w: number,
  h: number,
): void {
  switch (orientation) {
    case 2:
      ctx.transform(-1, 0, 0, 1, w, 0);
      break;
    case 3:
      ctx.transform(-1, 0, 0, -1, w, h);
      break;
    case 4:
      ctx.transform(1, 0, 0, -1, 0, h);
      break;
    case 5:
      ctx.transform(0, 1, 1, 0, 0, 0);
      break;
    case 6:
      ctx.transform(0, 1, -1, 0, h, 0);
      break;
    case 7:
      ctx.transform(0, -1, -1, 0, h, w);
      break;
    case 8:
      ctx.transform(0, -1, 1, 0, 0, w);
      break;
    default:
      break;
  }
}

export interface DecodedImage extends RgbaImage {
  /** EXIF 修正后的自然尺寸。 */
  naturalWidth: number;
  naturalHeight: number;
  orientation: number;
}

/** 解码文件为 EXIF 已修正的 RGBA 像素。 */
export async function decodeFile(file: File): Promise<DecodedImage> {
  const validation = validateFile(file);
  if (!validation.ok) throw validation.error!;

  const orientation = await readExifOrientation(file);
  const bitmap = await createImageBitmap(file).catch((e: unknown) => {
    console.error('[decode] createImageBitmap 失败', e);
    return null;
  });
  if (bitmap === null) throw new PipelineError('DECODE_FAILED');

  if (bitmap.width > MAX_DIMENSION || bitmap.height > MAX_DIMENSION) {
    bitmap.close();
    throw new PipelineError('TOO_LARGE', {
      width: bitmap.width,
      height: bitmap.height,
      limit: MAX_DIMENSION,
    });
  }

  const swap = orientation >= 5 && orientation <= 8;
  const outW = swap ? bitmap.height : bitmap.width;
  const outH = swap ? bitmap.width : bitmap.height;

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) {
    bitmap.close();
    throw new PipelineError('DECODE_FAILED', { reason: 'no2dContext' });
  }
  // 白底：处理带透明通道的 PNG，避免透明区被当作黑色笔画
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, outW, outH);
  applyOrientation(ctx, orientation, bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  const data = ctx.getImageData(0, 0, outW, outH);
  return {
    data: data.data,
    width: outW,
    height: outH,
    naturalWidth: outW,
    naturalHeight: outH,
    orientation,
  };
}

/** 从 dataURL 解码（工程文件载入路径）。 */
export async function decodeDataUrl(dataUrl: string): Promise<RgbaImage> {
  const img = new Image();
  img.src = dataUrl;
  const loaded = await img
    .decode()
    .then(() => true)
    .catch((e: unknown) => {
      console.error('[decode] dataURL 解码失败', e);
      return false;
    });
  if (!loaded) throw new PipelineError('DECODE_FAILED');

  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new PipelineError('DECODE_FAILED', { reason: 'no2dContext' });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: d.data, width: canvas.width, height: canvas.height };
}

export interface PreparedImage extends RgbaImage {
  /** 相对原图的下采样因子（>1 表示已缩小）。 */
  downscale: number;
}

/**
 * 按参数准备工作图像：透视校正 → 裁剪 → 下采样。
 * 顺序固定，保证坐标映射可逆推。
 */
export function prepareWorkingImage(src: RgbaImage, params: PreprocessParams): PreparedImage {
  let current: RgbaImage = src;

  // 1) 透视校正（在原始分辨率上做，精度最高）
  if (params.perspective !== null) {
    const quad = denormalizeQuad(params.perspective, current.width, current.height);
    const warped = warpPerspective(current, quad);
    current = { data: warped.data, width: warped.width, height: warped.height };
  }

  // 2) 裁剪
  if (params.crop !== null) {
    const c = params.crop;
    const x0 = Math.max(0, Math.round(c.x * current.width));
    const y0 = Math.max(0, Math.round(c.y * current.height));
    const cw = Math.max(1, Math.min(current.width - x0, Math.round(c.w * current.width)));
    const ch = Math.max(1, Math.min(current.height - y0, Math.round(c.h * current.height)));
    current = cropRgba(current, x0, y0, cw, ch);
  }

  // 3) 下采样到工作尺寸
  const longSide = Math.max(current.width, current.height);
  const limit = Math.max(400, params.maxWorkingSize);
  if (longSide <= limit) {
    return { ...current, downscale: src.width > 0 ? src.width / current.width : 1 };
  }
  const k = limit / longSide;
  const tw = Math.max(1, Math.round(current.width * k));
  const th = Math.max(1, Math.round(current.height * k));
  const scaled = resizeRgba(current, tw, th);
  return { ...scaled, downscale: src.width > 0 ? src.width / tw : 1 };
}

export function cropRgba(src: RgbaImage, x0: number, y0: number, w: number, h: number): RgbaImage {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcOff = ((y0 + y) * src.width + x0) * 4;
    out.set(src.data.subarray(srcOff, srcOff + w * 4), y * w * 4);
  }
  return { data: out, width: w, height: h };
}

/**
 * 面积平均下采样（box filter）。
 * 相较最近邻，能保留细笔画的灰度信息，避免细线在缩小时整段消失。
 */
export function resizeRgba(src: RgbaImage, tw: number, th: number): RgbaImage {
  const out = new Uint8ClampedArray(tw * th * 4);
  const sx = src.width / tw;
  const sy = src.height / th;

  for (let y = 0; y < th; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(src.height, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(src.width, Math.max(x0 + 1, Math.ceil((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let off = (yy * src.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++) {
          r += src.data[off]!;
          g += src.data[off + 1]!;
          b += src.data[off + 2]!;
          a += src.data[off + 3]!;
          off += 4;
          n++;
        }
      }
      const o = (y * tw + x) * 4;
      if (n > 0) {
        out[o] = r / n;
        out[o + 1] = g / n;
        out[o + 2] = b / n;
        out[o + 3] = a / n;
      } else {
        out[o + 3] = 255;
      }
    }
  }
  return { data: out, width: tw, height: th };
}

/** 构建 SourceImage 元数据（dataURL 由调用方读入，保证原图只读保存）。 */
export function makeSourceImage(
  file: File,
  decoded: DecodedImage,
  dataUrl: string,
  id: string,
): SourceImage {
  return {
    id,
    fileName: file.name,
    mimeType: file.type || 'image/png',
    byteSize: file.size,
    naturalWidth: decoded.naturalWidth,
    naturalHeight: decoded.naturalHeight,
    exifOrientation: decoded.orientation,
    dataUrl,
    createdAt: Date.now(),
  };
}
