/**
 * 全局错误模型：所有管线错误必须为带 code 的 PipelineError，禁止抛裸字符串。
 */

export type ErrorCode =
  // 导入 / 解码
  | 'UNSUPPORTED_FORMAT'
  | 'TOO_LARGE'
  | 'DECODE_FAILED'
  // 预处理
  | 'LOW_CONTRAST'
  | 'DESKEW_OUT_OF_RANGE'
  | 'PERSPECTIVE_INVALID'
  // 识别
  | 'NO_STRUCTURE_FOUND'
  | 'TOO_NOISY'
  | 'TOO_MANY_ELEMENTS'
  // 简化
  | 'TOPOLOGY_VIOLATION'
  // 比例
  | 'SCALE_CONFLICT'
  | 'CALIBRATION_FAILED'
  // 导出
  | 'EXPORT_PREFLIGHT_FAILED'
  | 'EXPORT_WRITE_FAILED'
  // 工程文件
  | 'PROJECT_SCHEMA_MISMATCH'
  | 'PROJECT_PARSE_FAILED'
  // 其它
  | 'CANCELLED'
  | 'INTERNAL';

/** 面向用户的中文文案映射（UI 直接展示，不暴露堆栈）。 */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  UNSUPPORTED_FORMAT: '不支持的图片格式，请使用 JPG 或 PNG。',
  TOO_LARGE: '图片超出处理上限，请压缩后重试。',
  DECODE_FAILED: '图片解码失败，文件可能已损坏。',
  LOW_CONTRAST: '图像对比度过低，线条可能无法可靠提取，建议调整预处理参数。',
  DESKEW_OUT_OF_RANGE: '检测到的倾斜角超出自动校正范围，请手动旋转或做透视校正。',
  PERSPECTIVE_INVALID: '透视校正的四个角点不构成有效凸四边形。',
  NO_STRUCTURE_FOUND: '未识别到有效结构，请调整预处理参数或使用手动描线。',
  TOO_NOISY: '背景噪声过强，识别结果不可靠，建议提高降噪强度。',
  TOO_MANY_ELEMENTS: '识别出的对象数量超过建议上限，建议提高简化容差后重跑。',
  TOPOLOGY_VIOLATION: '几何简化会破坏拓扑结构，已自动降低容差重试。',
  SCALE_CONFLICT: '两点标定结果与手动输入的尺寸冲突，请选择采用哪一方。',
  CALIBRATION_FAILED: '标定失败：两点距离过近或实际距离无效。',
  EXPORT_PREFLIGHT_FAILED: '导出预检未通过，请先修正致命问题。',
  EXPORT_WRITE_FAILED: '文件写入失败，请检查保存位置权限。',
  PROJECT_SCHEMA_MISMATCH: '工程文件版本不兼容，无法载入。',
  PROJECT_PARSE_FAILED: '工程文件解析失败，内容可能已损坏。',
  CANCELLED: '操作已取消。',
  INTERNAL: '内部错误，请重试。',
};

export interface PipelineErrorDetail {
  /** 附加的可读上下文，例如 { width: 9000, limit: 8000 }，不得包含图像像素内容。 */
  readonly [key: string]: string | number | boolean | undefined;
}

export class PipelineError extends Error {
  readonly code: ErrorCode;
  readonly detail?: PipelineErrorDetail;
  /** 该错误是否允许用户通过调整参数继续（非致命）。 */
  readonly recoverable: boolean;

  constructor(code: ErrorCode, detail?: PipelineErrorDetail, recoverable = true) {
    super(ERROR_MESSAGES[code]);
    this.name = 'PipelineError';
    this.code = code;
    this.detail = detail;
    this.recoverable = recoverable;
  }

  /** 结构化克隆安全的序列化形式（用于 Worker 回传）。 */
  toJSON(): SerializedPipelineError {
    return {
      __pipelineError: true,
      code: this.code,
      message: this.message,
      detail: this.detail,
      recoverable: this.recoverable,
    };
  }
}

export interface SerializedPipelineError {
  readonly __pipelineError: true;
  readonly code: ErrorCode;
  readonly message: string;
  readonly detail?: PipelineErrorDetail;
  readonly recoverable: boolean;
}

export function isSerializedPipelineError(v: unknown): v is SerializedPipelineError {
  return typeof v === 'object' && v !== null && (v as { __pipelineError?: unknown }).__pipelineError === true;
}

export function reviveError(v: SerializedPipelineError): PipelineError {
  return new PipelineError(v.code, v.detail, v.recoverable);
}

export function errorMessageOf(code: ErrorCode): string {
  return ERROR_MESSAGES[code];
}
