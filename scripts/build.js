#!/usr/bin/env node
/**
 * 单入口循环构建脚本
 * 每个入口独立 build，输出 IIFE 自包含 bundle，避开 MV3 content script 不支持 ES module 的限制
 *
 * 用法：
 *   node scripts/build.js         构建到 dist/
 *   node scripts/build.js --zip   构建并打包为 dist.zip 单文件
 *   node scripts/build.js --watch 开发模式监听
 */
import { build } from 'vite';
import { resolve, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import {
  copyFileSync, mkdirSync, existsSync, readdirSync, rmSync,
  readFileSync, statSync, writeFileSync
} from 'fs';
import { deflateRawSync } from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const distDir = resolve(root, 'dist');

const entries = {
  background: 'src/background/index.js',
  content: 'src/content/index.js',
  popup: 'src/popup/popup.js',
  sidepanel: 'src/sidepanel/sidepanel.js',
  options: 'src/options/options.js'
};

function copyAssets() {
  copyFileSync(resolve(root, 'src/popup/popup.html'), resolve(distDir, 'popup.html'));
  copyFileSync(resolve(root, 'src/sidepanel/sidepanel.html'), resolve(distDir, 'sidepanel.html'));
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
  if (existsSync(resolve(root, 'src/sidepanel/sidepanel.css'))) {
    copyFileSync(resolve(root, 'src/sidepanel/sidepanel.css'), resolve(distDir, 'sidepanel.css'));
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

// ============================================================
// ZIP 打包 — 纯 Node.js，零依赖
// ============================================================

/**
 * 递归收集目录下所有文件，返回 { relPath, absPath, buf }
 */
function collectFiles(dir, baseDir) {
  const result = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const abs = resolve(dir, ent.name);
    const rel = relative(baseDir, abs).replace(/\\/g, '/');
    if (ent.isDirectory()) {
      result.push(...collectFiles(abs, baseDir));
    } else {
      result.push({ relPath: rel, absPath: abs });
    }
  }
  return result;
}

/**
 * 创建 ZIP 文件（纯 Node.js 内置模块，无外部依赖）
 * 格式遵循 PKZIP / APPNOTE 规范
 */
function createZip(sourceDir, outputPath) {
  const files = collectFiles(sourceDir, sourceDir);

  // 第一遍：写 local file headers + data，记录 central directory 信息
  const allBufs = [];
  let cdOffset = 0;
  const allCdEntries = [];

  for (const { relPath, absPath } of files) {
    const raw = readFileSync(absPath);
    const compressed = deflateRawSync(raw);
    const useStore = compressed.length >= raw.length;
    const nameBuf = Buffer.from(relPath, 'utf-8');
    const data = useStore ? raw : compressed;
    const crc = crc32(raw);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(useStore ? 0 : 8, 8);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(useStore ? raw.length : compressed.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);

    allBufs.push(localHeader, nameBuf, data);

    allCdEntries.push({ nameBuf, crc, compressedSize: useStore ? raw.length : compressed.length, uncompressedSize: raw.length, useStore, offset: cdOffset });
    cdOffset += 30 + nameBuf.length + data.length;
  }

  // Central directory
  for (const e of allCdEntries) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x14, 4);
    cd.writeUInt16LE(0x14, 6);
    cd.writeUInt16LE(e.useStore ? 0 : 8, 10);
    cd.writeUInt32LE(e.crc, 16);
    cd.writeUInt32LE(e.compressedSize, 20);
    cd.writeUInt32LE(e.uncompressedSize, 24);
    cd.writeUInt16LE(e.nameBuf.length, 28);
    cd.writeUInt32LE(e.offset, 42);
    allBufs.push(cd, e.nameBuf);
  }

  // 计算 central directory 实际大小
  const cdBufTotal = allBufs.slice(allBufs.length - allCdEntries.length * 2);
  const cdActualSize = cdBufTotal.reduce((s, b) => s + b.length, 0);

  // End of central directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);   // [0-3]   signature
  eocd.writeUInt16LE(0, 4);            // [4-5]   disk number
  eocd.writeUInt16LE(0, 6);            // [6-7]   cd start disk
  eocd.writeUInt16LE(allCdEntries.length, 8);  // [8-9]   entries on this disk
  eocd.writeUInt16LE(allCdEntries.length, 10); // [10-11] total entries
  eocd.writeUInt32LE(cdActualSize, 12); // [12-15] cd size
  eocd.writeUInt32LE(cdOffset, 16);     // [16-19] cd offset
  // [20-21] comment length = 0 (already zero)

  allBufs.push(eocd);
  writeFileSync(outputPath, Buffer.concat(allBufs));
  return outputPath;
}

/**
 * 简易 CRC32（与 PKZIP 兼容）
 */
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = process.argv.slice(2);
  const doZip = args.includes('--zip');

  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  for (const [name, file] of Object.entries(entries)) {
    console.log(`▶ building ${name}`);
    await buildEntry(name, file);
  }
  copyAssets();
  console.log('✔ build done →', distDir);

  if (doZip) {
    const zipPath = resolve(root, 'webchat-extension.zip');
    console.log('▶ packaging zip...');
    createZip(distDir, zipPath);
    const sizeKB = (statSync(zipPath).size / 1024).toFixed(1);
    console.log(`✔ zip created → ${zipPath} (${sizeKB} KB)`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
