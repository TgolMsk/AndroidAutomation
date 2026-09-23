import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const PROTO_FILE = 'emulator_controller.proto';
const protoSource = resolve(__dirname, '../core/proto', PROTO_FILE);

/**
 * Core is bundled into the main process, so the emulator gRPC proto must ship next to the main
 * bundle (out/main/emulator_controller.proto); main/proto.ts resolves it relative to the bundle.
 */
function copyProtoPlugin(): Plugin {
  return {
    name: 'avdm:copy-proto',
    writeBundle(options) {
      const outDir = options.dir ?? (options.file ? dirname(options.file) : undefined);
      if (!outDir) return;
      if (!existsSync(protoSource)) {
        this.error(`未找到 ${protoSource}，无法构建可用的 gRPC 客户端`);
      }
      mkdirSync(outDir, { recursive: true });
      copyFileSync(protoSource, join(outDir, PROTO_FILE));
    },
  };
}

/**
 * The React refresh preamble is an inline script, which the production CSP (script-src 'self')
 * forbids. Relax it for the dev server only.
 */
function devCspPlugin(): Plugin {
  return {
    name: 'avdm:dev-csp',
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
      // Bundle local workspaces into both main entries; native dependencies remain external.
      externalizeDeps: { exclude: ['@avdm/core', '@avdm/automation'] },
      rollupOptions: {
        // Sharp resolves its platform native addon relative to its own package.
        // Bundling its JS into probe-worker.js breaks that lookup.
        external: ['sharp', '@techstark/opencv-js'],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'probe-worker': resolve(__dirname, 'src/main/automation/probe-worker.ts'),
          'gather-worker': resolve(__dirname, 'src/main/automation/gather-worker.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        // Sandboxed preloads must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), devCspPlugin()],
    build: {
      // electron-vite leaves bundles unminified by default; the renderer is the only part worth it.
      minify: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
