#!/usr/bin/env node
/**
 * 单入口循环构建脚本
 * 每个入口独立 build，输出 IIFE 自包含 bundle，避开 MV3 content script 不支持 ES module 的限制
 */
import { build } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  copyFileSync, mkdirSync, existsSync, readdirSync, rmSync
} from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const distDir = resolve(root, 'dist');

const entries = {
  background: 'src/background/index.js',
  content: 'src/content/index.js',
  popup: 'src/popup/popup.js',
  options: 'src/options/options.js'
};

function copyAssets() {
  copyFileSync(resolve(root, 'src/popup/popup.html'), resolve(distDir, 'popup.html'));
  copyFileSync(resolve(root, 'src/options/options.html'), resolve(distDir, 'options.html'));
  copyFileSync(resolve(root, 'src/manifest.json'), resolve(distDir, 'manifest.json'));

  const stylesDir = resolve(distDir, 'styles');
  if (!existsSync(stylesDir)) mkdirSync(stylesDir, { recursive: true });
  if (existsSync(resolve(root, 'src/styles/content.css'))) {
    copyFileSync(resolve(root, 'src/styles/content.css'), resolve(stylesDir, 'content.css'));
  }
  if (existsSync(resolve(root, 'src/styles/panel.css'))) {
    copyFileSync(resolve(root, 'src/styles/panel.css'), resolve(stylesDir, 'panel.css'));
  }
  if (existsSync(resolve(root, 'src/styles/recorder.css'))) {
    copyFileSync(resolve(root, 'src/styles/recorder.css'), resolve(stylesDir, 'recorder.css'));
  }
  if (existsSync(resolve(root, 'src/popup/popup.css'))) {
    copyFileSync(resolve(root, 'src/popup/popup.css'), resolve(distDir, 'popup.css'));
  }
  if (existsSync(resolve(root, 'src/options/options.css'))) {
    copyFileSync(resolve(root, 'src/options/options.css'), resolve(distDir, 'options.css'));
  }

  const libDir = resolve(distDir, 'lib');
  if (!existsSync(libDir)) mkdirSync(libDir, { recursive: true });
  copyFileSync(resolve(root, 'lib/marked.min.js'), resolve(libDir, 'marked.min.js'));

  const iconsDir = resolve(distDir, 'icons');
  const srcIcons = resolve(root, 'icons');
  if (existsSync(srcIcons)) {
    if (!existsSync(iconsDir)) mkdirSync(iconsDir, { recursive: true });
    readdirSync(srcIcons).forEach(file => {
      copyFileSync(resolve(srcIcons, file), resolve(iconsDir, file));
    });
  }
}

async function buildEntry(name, file) {
  await build({
    root,
    configFile: false,
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      rollupOptions: {
        input: resolve(root, file),
        output: {
          entryFileNames: `${name}.js`,
          format: 'iife',
          inlineDynamicImports: true,
          name: `__webchat_${name}__`
        }
      },
      target: 'esnext',
      minify: false,
      sourcemap: false
    },
    resolve: {
      alias: {
        '@': resolve(root, 'src'),
        '@lib': resolve(root, 'src/lib')
      }
    },
    logLevel: 'warn'
  });
}

async function main() {
  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  for (const [name, file] of Object.entries(entries)) {
    console.log(`▶ building ${name}`);
    await buildEntry(name, file);
  }
  copyAssets();
  console.log('✔ build done →', distDir);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
