import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';

/**
 * 开发期落盘通道。
 *
 * 背景：IDE 内置 WebView 会禁用 File System Access API，
 * 且其下载行为不可见，导致「保存 SVG / 保存工程」在预览中无法拿到文件。
 * 该中间件让页面在开发模式下把文本直接写进工作区的 exports/ 目录。
 *
 * 安全边界：
 * - 仅在 vite dev（apply: 'serve'）下注册，生产构建不含任何相关代码；
 * - 文件名剥离路径分隔符与 ..，写入位置被钉死在 exports/ 内；
 * - 只接受文本，且有体积上限。
 */
function devSavePlugin(rootDir: string): Plugin {
  const OUT_DIR = path.join(rootDir, 'exports');
  const MAX_BYTES = 64 * 1024 * 1024;

  return {
    name: 'ld-dev-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__save', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('method not allowed');
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        let aborted = false;

        req.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            aborted = true;
            res.statusCode = 413;
            res.end(JSON.stringify({ ok: false, error: '内容过大' }));
            req.destroy();
            return;
          }
          chunks.push(c);
        });

        req.on('end', () => {
          if (aborted) return;
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
              name?: unknown;
              content?: unknown;
            };
            if (typeof body.name !== 'string' || typeof body.content !== 'string') {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: '参数不合法' }));
              return;
            }

            // 只取基名并过滤危险字符，杜绝写出 exports/ 之外
            const safe = path
              .basename(body.name)
              .replace(/[\\/:*?"<>|]/g, '_')
              .replace(/^\.+/, '_');
            if (safe.length === 0) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: '文件名为空' }));
              return;
            }

            fs.mkdirSync(OUT_DIR, { recursive: true });
            const full = path.join(OUT_DIR, safe);
            // 双保险：解析后的绝对路径必须仍在 OUT_DIR 内
            if (!full.startsWith(OUT_DIR + path.sep)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: '路径越界' }));
              return;
            }

            fs.writeFileSync(full, body.content, 'utf8');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, path: full }));
            server.config.logger.info(`[ld-dev-save] 已写入 ${full}`);
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: String(e) }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), devSavePlugin(__dirname)],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
} as never);
