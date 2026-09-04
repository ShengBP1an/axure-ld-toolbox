/**
 * Axure 导入说明与「需验证」风险清单。
 *
 * 原则（Prompt 第八节第 9 条 / 默认假设最后一条）：
 * 本工具只承诺「导出 Axure 兼容 SVG」。
 * 不通过 MCP 或任何未公开接口生成 / 修改 .rp 文件。
 * 对未在真实 Axure RP 中验证过的行为，一律明确标注为「需验证」。
 */

export interface GuideStep {
  title: string;
  detail: string;
}

export const AXURE_IMPORT_STEPS: readonly GuideStep[] = [
  {
    title: '保存 SVG 到本地',
    detail: '在本页点击「保存 SVG」，选择一个便于查找的目录。文件全程未离开本机。',
  },
  {
    title: '在 Axure RP 中新建或打开页面',
    detail:
      '建议先把页面尺寸设为与本工具中「Axure 输出画布」一致的像素值，这样导入后位置即为最终位置。',
  },
  {
    title: '导入 SVG',
    detail:
      '菜单 File → Import…（文件 → 导入），选择刚保存的 .svg 文件；也可以直接把文件拖入 Axure 画布。',
  },
  {
    title: '转换为可编辑形状',
    detail:
      '选中导入后的 SVG 对象，右键 → Transform Image → Convert SVG to Shapes（转换 SVG 为形状）。' +
      '不同 Axure 版本菜单文案略有差异，通常位于右键菜单的图像 / 变换分组内。',
  },
  {
    title: '检查结果',
    detail:
      '转换后应能在「Outline / 概要」面板看到按图层分组的对象树，并能单独选中每个房间、每条墙线。' +
      '若整体仍是一个对象，说明转换未生效，请确认 Axure 版本是否支持该功能。',
  },
  {
    title: '按需调整',
    detail:
      '此时所有图形都是原生 Axure 形状，可自由改颜色、加文字标注、设置交互，作为 LD 白盒继续迭代。',
  },
];

export interface VerificationItem {
  topic: string;
  /** 本工具的处理方式。 */
  handling: string;
  /** 风险与需要真实验证的点。 */
  risk: string;
  /** 最小验证实验。 */
  experiment: string;
  /**
   * 是否已在真实 Axure RP 中实测通过。
   * 仅当用户亲自验证过才可置 true，不得凭推测填写。
   */
  verified?: boolean;
}

/**
 * 常见导入失败的自查项。
 *
 * 排在验证清单之前，因为实践中绝大多数「导入失败」并非兼容性问题，
 * 而是拿到了一个 0 字节的空文件。
 */
export const IMPORT_TROUBLESHOOTING: readonly GuideStep[] = [
  {
    title: '先确认文件不是 0 字节',
    detail:
      '在资源管理器中查看文件大小。若为 0 KB，说明保存过程被中断，该文件无效。' +
      '典型成因：在受限浏览器环境中弹出了「选择保存位置」对话框，' +
      '系统已建好文件但内容写入被拒绝。此时请以工具提示中给出的实际路径为准。',
  },
  {
    title: '确认导入的是 .svg 而非 .ldproj.json',
    detail:
      '工程文件（.ldproj.json）只能由本工具打开，用于继续编辑；Axure 只接受导出的 .svg。',
  },
  {
    title: '仍然失败时改用精简导出',
    detail:
      '在导出设置中关闭「写入元数据」与「写入 data-* 属性」再导出一次，' +
      '以此排除 Axure 对自定义命名空间解析的差异。',
  },
];

/**
 * 需在真实 Axure RP 版本上验证的兼容项。
 * verified 为 true 的条目表示已由使用者实测确认，其余一律不得描述为"已确认可用"。
 */
export const VERIFICATION_ITEMS: readonly VerificationItem[] = [
  {
    topic: '「Convert SVG to shapes」的可用性与菜单位置',
    handling: '交付路径完全依赖该功能；本工具只负责产出结构清晰的 SVG。',
    risk: '该功能的存在与菜单位置随 Axure 版本变化；旧版本可能没有此项，导入后只能作为图片使用。',
    experiment:
      '在目标 Axure 版本导入本工具的示例 SVG，尝试转换，记录菜单路径与是否成功；失败则退回「作为底图 + 手动重绘」的用法。',
  },
  {
    topic: 'SVG 文件本身能否被 Axure 正常导入',
    handling: '输出标准 SVG 1.1，含 XML 声明、metadata、title/desc 与 data-* 属性。',
    risk: '部分解析器对自定义命名空间的 metadata 敏感。',
    experiment: '已实测：完整版与剥离 metadata / data-* 的精简版均可正常导入，故保持默认设置。',
    verified: true,
  },
  {
    topic: '嵌套 <g> 分组层级是否被保留',
    handling: '按边界 / 墙线 / 封闭区域 / 待确认建立 4 个顶层 <g>，不做更深嵌套。',
    risk: '转换后 Axure 可能把分组拍平，导致图层结构丢失（对象本身仍应可分别选择）。',
    experiment: '导入含 4 个分组的 SVG，转换后查看 Outline 面板是否保留分组节点。',
  },
  {
    topic: 'stroke-dasharray（待确认图层的虚线）',
    handling: '「待确认」图层默认输出虚线；可在导出设置中关闭。',
    risk: '虚线可能被转换为实线，或被拆成大量独立小线段导致对象数暴增。',
    experiment:
      '导出一份保留虚线、一份关闭虚线的 SVG，分别转换后对比对象数量；若数量异常则默认关闭该项。',
  },
  {
    topic: 'fill-opacity 半透明填充',
    handling: '封闭区域默认带 0.55 的 fill-opacity。',
    risk: '透明度可能被丢弃（变为不透明），从而遮挡底层墙线。',
    experiment: '转换后检查区域是否仍为半透明；若丢失则关闭「区域填充」改为仅描边。',
  },
  {
    topic: 'data-* 自定义属性',
    handling: '写入 data-kind / data-layer / data-confidence / data-hole-of 等便于追溯的属性。',
    risk: '几乎可以确定会在转换为形状时丢失（Axure 形状没有对应承载）。',
    experiment: '不影响图形正确性，无需阻断；如需保留元信息请同时归档 SVG 源文件。',
  },
  {
    topic: '<metadata> 是否影响显示',
    handling: '写入地图尺寸、单位、比例、工具版本等元数据。',
    risk: '按 SVG 规范 metadata 不渲染；极少数解析器可能报错。',
    experiment: '若导入失败，先关闭「写入元数据」再试，以定位是否为 metadata 引起。',
  },
  {
    topic: '坐标精度与位置漂移',
    handling: 'viewBox 与 width/height 严格等于设置的画布像素；坐标默认保留 2 位小数。',
    risk: 'Axure 可能对坐标取整，造成亚像素级位移；大量对象累积后可能出现视觉错位。',
    experiment:
      '在 SVG 中放置已知坐标的标记点（例如画布四角与中心），转换后读取 Axure 中的 x/y 值，记录偏差是否 ≤1px。',
  },
  {
    topic: '大量对象的性能',
    handling: '预检在超过 2000 个对象时给出警告。',
    risk: '对象过多时 Axure 编辑与生成原型都会明显变慢。',
    experiment: '分别导入 200 / 800 / 2000 对象的 SVG，记录转换耗时与编辑流畅度，据此确定最终建议上限。',
  },
];

/** 明确的能力边界声明，UI 中直接展示，避免误导。 */
export const CAPABILITY_DISCLAIMER = [
  '本工具的交付物是「Axure 兼容的可编辑 SVG」，不直接生成或修改 .rp 文件。',
  '不通过 Axure MCP 或任何未公开接口写入 Axure 工程。',
  '首版不识别手写文字（无 OCR），也不识别出生点、掩体、动线等玩法语义。',
  '所有图像与工程文件只保存在本机，无网络上传、无遥测。',
] as const;

/** 生成可随 SVG 一起保存的说明文本。 */
export function buildReadmeText(projectName: string, canvasWidth: number, canvasHeight: number): string {
  const lines: string[] = [
    `# ${projectName} · Axure 导入说明`,
    '',
    `画布尺寸：${canvasWidth} × ${canvasHeight} px`,
    '',
    '## 导入步骤',
    '',
  ];
  AXURE_IMPORT_STEPS.forEach((s, i) => {
    lines.push(`${i + 1}. **${s.title}**`);
    lines.push(`   ${s.detail}`);
    lines.push('');
  });

  lines.push('## 导入失败时的自查');
  lines.push('');
  IMPORT_TROUBLESHOOTING.forEach((s, i) => {
    lines.push(`${i + 1}. **${s.title}**`);
    lines.push(`   ${s.detail}`);
    lines.push('');
  });

  lines.push('## 需在你的 Axure 版本上验证的项');
  lines.push('');
  for (const v of VERIFICATION_ITEMS) {
    lines.push(`- **${v.topic}**${v.verified === true ? '（已实测通过）' : ''}`);
    lines.push(`  - 本工具处理：${v.handling}`);
    lines.push(`  - 风险：${v.risk}`);
    lines.push(`  - 验证方法：${v.experiment}`);
    lines.push('');
  }

  lines.push('## 能力边界');
  lines.push('');
  for (const d of CAPABILITY_DISCLAIMER) lines.push(`- ${d}`);
  lines.push('');
  return lines.join('\n');
}
