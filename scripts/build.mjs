// scripts/build.mjs —— 构建页面：语法检查 + 引擎自检 + 汇总到 dist/
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'public');
const outDir = path.join(root, 'dist');

// 1) 引擎/解析器模块可导入且自检通过
const { parseSheet, DrillSession, assertConverged } = await import(pathToFileURL(path.join(srcDir, 'drill.mjs')).href);
const sheet = parseSheet(`
REPLICAS 2
GEN a insert 构建自检 parent=root seq=1
HOLD b insert 离线子项 parent=a seq=2
DELIVER b R1
DELIVER b R2
`);
const session = new DrillSession(sheet.replicaCount);
sheet.lines.forEach((l) => session.apply(l));
if (!assertConverged(session)) throw new Error('构建自检未收敛');

// 2) 前端 ES 模块语法检查（app.mjs 依赖 DOM，用 node --check 仅校验语法）
for (const f of ['core.mjs', 'drill.mjs', 'app.mjs']) {
  execFileSync(process.execPath, ['--check', path.join(srcDir, f)], { stdio: 'pipe' });
  console.log(`[build] 语法检查通过：public/${f}`);
}

// 3) 拷贝静态产物到 dist/（无打包步骤，原生 ES 模块直出）
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
for (const f of ['index.html', 'styles.css', 'app.mjs', 'core.mjs', 'drill.mjs']) {
  await writeFile(path.join(outDir, f), await readFile(path.join(srcDir, f)));
}
console.log('[build] 页面产物已输出到 dist/（5 个文件）');
