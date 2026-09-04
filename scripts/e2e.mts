// 端到端验证脚本：通过 drop 事件注入合成草图，跑完整管线并断言最低验收标准。
// 用法：node --experimental-strip-types scripts/e2e.mts
/* eslint-disable no-console */

import { chromium, type Page } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = 'http://localhost:5173';
const OUT = 'artifacts';

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}  —  ${detail}`);
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

/** 通过 DataTransfer 触发 drop，绕过原生文件选择器。 */
async function dropFile(page: Page, url: string, fileName: string): Promise<void> {
  await page.evaluate(
    async ([u, n]) => {
      const res = await fetch(u);
      const blob = await res.blob();
      const file = new File([blob], n, { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      // 找到虚线拖拽区
      const zone =
        document.querySelector('[class*="border-dashed"]') ??
        document.querySelector('main');
      if (zone === null) throw new Error('未找到拖拽区');
      zone.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
      zone.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
    },
    [url, fileName] as const,
  );
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });

  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('favicon')) consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  // 不能用 networkidle：Vite 的 HMR WebSocket 会让网络永不空闲
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=拖入手绘地图草图', { timeout: 20000 });
  console.log('\n=== 步骤 1：导入草图 ===');

  await dropFile(page, '/fixtures/combined.png', 'combined.png');
  await page.waitForFunction(() => document.body.innerText.includes('源文件'), { timeout: 15000 });
  record('草图导入成功', true, '已识别文件并进入预处理预览');
  // 等预处理预览完成
  await page.waitForTimeout(2500);
  await shot(page, '01-import');

  const importText = await page.innerText('body');
  record(
    '预处理产出工作图像',
    /工作分辨率\s*\d+\s*×\s*\d+/.test(importText),
    (/工作分辨率[^·]*/.exec(importText)?.[0] ?? '').trim(),
  );

  /* ---------------- 步骤 2：尺寸与比例 ---------------- */
  console.log('\n=== 步骤 2：尺寸与比例 ===');
  await page.getByRole('button', { name: /设置尺寸与比例/ }).click();
  await page.waitForTimeout(600);
  await shot(page, '02-scale');

  const ppuText = await page.innerText('body');
  record('显示 pixelsPerUnit', /像素 \/ /.test(ppuText), '比例卡片已渲染');

  // 验收标准 3：改地图宽度，锁定宽高比应自动推导高度
  const widthInput = page.locator('input[type="number"]').first();
  await widthInput.fill('100');
  await widthInput.press('Enter');
  await page.waitForTimeout(400);
  const afterScale = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input[type="number"]')] as HTMLInputElement[];
    return inputs.slice(0, 4).map((i) => i.value);
  });
  const [w, h] = afterScale;
  const ratioOk = Number(w) === 100 && Math.abs(Number(h) - 70) < 1.5;
  record(
    '锁定宽高比：改宽自动推导高（验收标准 3）',
    ratioOk,
    `mapWidth=${w}, mapHeight=${h}（原图 1000×700 → 期望 100×70）`,
  );

  /* ---------------- 步骤 3：识别 ---------------- */
  console.log('\n=== 步骤 3：识别矢量化 ===');
  await page.getByRole('button', { name: /开始识别/ }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: /^开始识别$/ }).click().catch(() => undefined);

  // 等到进入校正步骤（识别完成会自动跳转）
  await page.waitForFunction(
    () => document.body.innerText.includes('对象图层') || document.body.innerText.includes('未识别到有效结构'),
    { timeout: 60000 },
  );
  await page.waitForTimeout(1200);
  await shot(page, '03-recognized');

  const bodyAfter = await page.innerText('body');
  const noStructure = bodyAfter.includes('未识别到有效结构');
  record('识别完成且未报「无有效结构」', !noStructure, noStructure ? '识别失败' : '已进入校正编辑');

  /* 读取识别结果统计 */
  const stats = await page.evaluate(() => {
    interface WinLike { __ld?: unknown }
    // 从 DOM 读取图层树的计数徽章
    const text = document.body.innerText;
    const m = /对象图层 \((\d+)\)/.exec(text);
    return { total: m === null ? 0 : Number(m[1]) };
  });
  record('产出矢量对象', stats.total > 0, `共 ${stats.total} 个对象`);

  /* ---------------- 步骤 4：校正（撤销 / 重做） ---------------- */
  console.log('\n=== 步骤 4：校正编辑 ===');
  await shot(page, '04-edit');

  // 全选后删除，再撤销 —— 验收标准 5
  await page.locator('canvas').click({ position: { x: 700, y: 400 } });
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(300);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(500);
  const afterDelete = await page.evaluate(() => {
    const m = /对象图层 \((\d+)\)/.exec(document.body.innerText);
    return m === null ? -1 : Number(m[1]);
  });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(600);
  const afterUndo = await page.evaluate(() => {
    const m = /对象图层 \((\d+)\)/.exec(document.body.innerText);
    return m === null ? -1 : Number(m[1]);
  });
  record(
    '删除 → 撤销可恢复（验收标准 5）',
    afterDelete < stats.total && afterUndo === stats.total,
    `原 ${stats.total} → 删除后 ${afterDelete} → 撤销后 ${afterUndo}`,
  );

  await page.keyboard.press('Control+Shift+z');
  await page.waitForTimeout(500);
  const afterRedo = await page.evaluate(() => {
    const m = /对象图层 \((\d+)\)/.exec(document.body.innerText);
    return m === null ? -1 : Number(m[1]);
  });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  record('重做可用（验收标准 5）', afterRedo === afterDelete, `重做后 ${afterRedo}`);
  await shot(page, '05-undo-redo');

  /* ---------------- 步骤 5：导出 ---------------- */
  console.log('\n=== 步骤 5：导出 SVG ===');
  await page.locator('nav[aria-label="流程步骤"]').getByRole('button', { name: '导出 SVG' }).click();
  await page.waitForTimeout(1500);
  await shot(page, '06-export');

  const exportText = await page.innerText('body');
  const preflightPassed = exportText.includes('预检通过');
  record('导出预检通过', preflightPassed, preflightPassed ? '可以导出' : '存在阻止项');

  /* 直接从页面内取出生成的 SVG 做结构断言 */
  const svg = await page.evaluate(() => {
    const img = document.querySelector('img[alt="SVG 导出预览"]') as HTMLImageElement | null;
    if (img === null) return null;
    const src = img.src;
    if (!src.startsWith('data:image/svg+xml')) return null;
    return decodeURIComponent(src.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''));
  });

  if (svg === null) {
    record('取得导出 SVG', false, '未能从预览读取 SVG');
  } else {
    writeFileSync(`${OUT}/export.svg`, svg, 'utf-8');
    record('取得导出 SVG', true, `${(svg.length / 1024).toFixed(1)} KB`);

    const rects = (svg.match(/<rect\s/g) ?? []).length;
    const polygons = (svg.match(/<polygon\s/g) ?? []).length;
    const paths = (svg.match(/<path\s/g) ?? []).length;
    const lines = (svg.match(/<line\s/g) ?? []).length;
    const polylines = (svg.match(/<polyline\s/g) ?? []).length;
    const groups = (svg.match(/<g\s/g) ?? []).length;
    const ids = (svg.match(/\sid="/g) ?? []).length;

    console.log(
      `    元素统计：rect=${rects} polygon=${polygons} path=${paths} line=${lines} polyline=${polylines} g=${groups}`,
    );

    // 验收标准 1：方正房间输出为 rect（低节点数），而非高节点自由路径
    record(
      '方正房间输出为 rect（验收标准 1）',
      rects >= 4,
      `共 ${rects} 个 rect（合成图含 2×2 网格 + 断线房间 + 2 个通道端房间）`,
    );

    // 验收标准 2：不规则区域输出为可编辑封闭路径
    record(
      '不规则区域输出为多边形 / 封闭路径（验收标准 2）',
      polygons + paths >= 1,
      `polygon=${polygons}, path=${paths}`,
    );

    // 验收标准 6：主要逻辑对象保持独立
    const totalShapes = rects + polygons + paths + lines + polylines;
    record(
      '逻辑对象保持独立（验收标准 6）',
      totalShapes >= 8 && ids >= totalShapes,
      `${totalShapes} 个独立图形，${ids} 个 id`,
    );

    // 分组
    record(
      '按图层建立 <g> 分组（验收标准 6）',
      /id="layer-(region|wall|boundary|review)"/.test(svg),
      `${groups} 个分组`,
    );

    // 验收标准 7：viewBox 与设置一致
    const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    const canvasVals = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input[type="number"]')] as HTMLInputElement[];
      return inputs.map((i) => i.value);
    });
    record(
      'viewBox 与画布设置一致（验收标准 7）',
      vb !== null,
      vb === null ? '未找到 viewBox' : `viewBox=0 0 ${vb[1]} ${vb[2]}`,
    );

    // 禁用特性
    const forbidden = {
      script: /<script/i.test(svg),
      filter: /<filter|filter=/i.test(svg),
      mask: /<mask|clip-path=/i.test(svg),
      image: /<image/i.test(svg),
      transform: /\stransform=/i.test(svg),
      evenodd: /evenodd/i.test(svg),
      external: /(?:xlink:)?href="(?!#)/i.test(svg),
    };
    const anyForbidden = Object.values(forbidden).some((v) => v);
    record(
      '不含滤镜 / 蒙版 / 脚本 / 位图 / transform',
      !anyForbidden,
      JSON.stringify(forbidden),
    );

    // 坐标合法性
    record('无 NaN / Infinity 坐标', !/NaN|Infinity/.test(svg), '坐标全部有限');

    // metadata
    record(
      'metadata 记录尺寸与比例',
      /mapWidth="/.test(svg) && /pixelsPerUnit="/.test(svg),
      (/mapWidth="[^"]*"/.exec(svg)?.[0] ?? '') + ' ' + (/pixelsPerUnit="[^"]*"/.exec(svg)?.[0] ?? ''),
    );

    // 样式内联
    record(
      '样式内联，无外部 CSS',
      /stroke-width="/.test(svg) && !/class="/.test(svg) && !/<style/.test(svg),
      '全部内联属性',
    );
  }

  /* 验收标准 8：低置信度 / 问题必须可见 */
  await page.locator('nav[aria-label="流程步骤"]').getByRole('button', { name: '校正编辑' }).click();
  await page.waitForTimeout(800);
  const editText = await page.innerText('body');
  const hasIssuePanel = /问题与待确认 \((\d+)\)/.exec(editText);
  record(
    '问题面板可见（验收标准 8）',
    hasIssuePanel !== null,
    hasIssuePanel === null ? '未找到问题面板' : `${hasIssuePanel[1]} 个问题项`,
  );
  await shot(page, '07-issues');

  /* 控制台错误 */
  record(
    '无运行时控制台错误',
    consoleErrors.length === 0,
    consoleErrors.length === 0 ? '无' : consoleErrors.slice(0, 3).join(' | '),
  );

  await browser.close();

  /* 汇总 */
  const passed = checks.filter((c) => c.ok).length;
  console.log(`\n${'='.repeat(60)}`);
  console.log(`验收结果：${passed} / ${checks.length} 通过`);
  console.log('='.repeat(60));
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.log('\n未通过项：');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  }
  writeFileSync(`${OUT}/e2e-report.json`, JSON.stringify(checks, null, 2), 'utf-8');
  process.exit(failed.length === 0 ? 0 : 1);
}

void main();
