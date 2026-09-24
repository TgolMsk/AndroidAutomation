import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const PROTO_FILE = 'emulator_controller.proto';
const protoSource = resolve(__dirname, '../../packages/core/proto', PROTO_FILE);

/** Core is bundled into the main process; its gRPC proto must ship beside the bundle. */
function copyProtoPlugin(): Plugin {
  return {
    name: 'wanlong:copy-proto',
    writeBundle(options) {
      const outDir = options.dir ?? (options.file ? dirname(options.file) : undefined);
      if (!outDir) return;
      if (!existsSync(protoSource)) this.error(`未找到 ${protoSource}，无法构建模拟器 gRPC 客户端`);
      mkdirSync(outDir, { recursive: true });
      copyFileSync(protoSource, join(outDir, PROTO_FILE));
    },
  };
}

/** React refresh injects an inline script in development only. */
function devCspPlugin(): Plugin {
  return {
    name: 'wanlong:dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
    },
  };
}

export default defineConfig({
  main: {
    plugins: [copyProtoPlugin()],
    build: {
      externalizeDeps: { exclude: ['@avdm/core', '@avdm/automation', '@avdm/emulator-shell'] },
      rollupOptions: {
        // Sharp resolves native libraries relative to its own installed package.
        external: ['sharp', '@techstark/opencv-js'],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'probe-worker': resolve(__dirname, 'src/main/automation/probe-worker.ts'),
          'template-test-worker': resolve(__dirname, 'src/main/automation/template-test-worker.ts'),
          'gather-worker': resolve(__dirname, 'src/main/automation/gather-worker.ts'),
          'home-verify-worker': resolve(__dirname, 'src/main/automation/accounts/home-verify-worker.ts'),
          'login-preview-worker': resolve(__dirname, 'src/main/automation/accounts/login-preview-worker.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      // Sandboxed preloads cannot resolve workspace packages at runtime.
      externalizeDeps: { exclude: ['@avdm/emulator-shell'] },
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), devCspPlugin()],
    build: {
      minify: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
