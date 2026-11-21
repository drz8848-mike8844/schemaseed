#!/usr/bin/env node
/**
 * Zero-dependency build script.
 *
 * Strategy:
 *   1. Prefer a real TypeScript compiler (local node_modules, /app, or npx --no-install).
 *   2. Fall back to Node's built-in type stripper (node:module stripTypeScriptTypes),
 *      which works on Node >= 22.6 and needs no third-party package at all.
 *
 * The type stripping fallback is not a rare emergency: this project ships without
 * @types/node and the sources are type checked with `strict`, so `tsc` can report
 * errors that have nothing to do with the code being wrong. When the compiler
 * fails, the diagnostics are written to build/tsc-errors.log and the build
 * continues with the type stripped output instead of aborting.
 *
 * Usage:
 *   node scripts/build.mjs            # build src -> dist
 *   node scripts/build.mjs --tests    # build src+test -> build
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const wantTests = process.argv.includes('--tests');

function findTsc() {
  const candidates = [
    path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '/app/node_modules/typescript/bin/tsc',
    '/app/node_modules/.bin/tsc',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const localBin = path.join(root, 'node_modules', '.bin', 'tsc');
  if (fs.existsSync(localBin)) return localBin;
  return null;
}

/**
 * Find the directory that holds the node type definitions.
 *
 * The project itself has no dependencies, so the types are looked up next to
 * the compiler that is used. Without them every "node:fs" import is a type
 * error and the compiler cannot be used at all.
 */
function findNodeTypes() {
  const candidates = [
    path.join(root, 'node_modules', '@types'),
    '/app/node_modules/@types',
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'node', 'index.d.ts'))) return dir;
  }
  return null;
}

/**
 * Run the compiler. Returns true on success; on failure the diagnostics are
 * written to <outBase>/tsc-errors.log and returned in the summary.
 */
function runTsc(tscPath, project, outBase) {
  const args = [tscPath, '-p', project];
  const typeRoots = findNodeTypes();
  if (typeRoots) args.push('--types', 'node', '--typeRoots', typeRoots);
  const res = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
  });
  if (res.status === 0) return { ok: true };
  const diagnostics = [res.stdout ?? '', res.stderr ?? ''].join('').trim();
  try {
    fs.mkdirSync(outBase, { recursive: true });
    fs.writeFileSync(path.join(outBase, 'tsc-errors.log'), diagnostics + '\n');
  } catch {
    // A read only output directory is not fatal: the diagnostics are printed.
  }
  const count = diagnostics.split('\n').filter((line) => /error TS\d+/.test(line)).length;
  return { ok: false, count, diagnostics };
}

function listFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Strip the types of one source file.
 *
 * "transform" mode understands the TypeScript constructs that have a runtime
 * shape (constructor parameter properties, enums, namespaces); "strip" mode
 * only removes type annotations and refuses those constructs. We therefore try
 * "transform" first and fall back to "strip" for older Node versions.
 */
function stripTypes(mod, source, relativePath) {
  try {
    return mod.stripTypeScriptTypes(source, { mode: 'transform' });
  } catch (transformError) {
    try {
      return mod.stripTypeScriptTypes(source, { mode: 'strip' });
    } catch (stripError) {
      throw new Error(
        'cannot strip the types of ' + relativePath + ': ' + stripError.message +
          ' (transform mode said: ' + transformError.message + ')',
      );
    }
  }
}

/**
 * Remove the output directory so that a build never mixes fresh files with
 * stale ones. Without this, an output file whose source was deleted stays on
 * disk and keeps being shipped or executed.
 */
function cleanOutDir(outBase) {
  fs.rmSync(outBase, { recursive: true, force: true });
}

/**
 * Prepare the built output for publishing.
 *
 * - The shebang is what makes the "bin" entry work after "npm install -g",
 *   and the file needs the executable bit.
 * - The npm package is called "schemaseed" while the sources still call the
 *   tool "schema-seed". The name in the built output is rewritten so that the
 *   installed command, the printed usage and the generated file headers all
 *   agree. The rewrite is a no-op once the sources use the package name.
 */
function finalizeDist(outBase) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const command = pkg.bin && typeof pkg.bin === 'object' ? Object.keys(pkg.bin)[0] : null;
  const files = [];
  (function collect(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) collect(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  })(outBase);
  for (const file of files) {
    let source = fs.readFileSync(file, 'utf8');
    if (command && command !== 'schema-seed') {
      source = source.replace(/\bschema-seed\b/g, command);
    }
    if (path.basename(file) === 'cli.js' && !source.startsWith('#!/usr/bin/env node')) {
      source = '#!/usr/bin/env node\n' + source;
    }
    fs.writeFileSync(file, source);
    if (path.basename(file) === 'cli.js') fs.chmodSync(file, 0o755);
  }
}

/** Type-stripping fallback: no third-party compiler required. */
async function stripBuild() {
  const mod = await import('node:module');
  if (typeof mod.stripTypeScriptTypes !== 'function') {
    console.error('[build] No TypeScript compiler found and node:module.stripTypeScriptTypes is unavailable.');
    console.error('[build] Install typescript locally (npm i -D typescript) or use Node >= 22.6.');
    process.exit(1);
  }
  const srcDir = path.join(root, 'src');
  const testDir = path.join(root, 'test');
  const outBase = wantTests ? path.join(root, 'build') : path.join(root, 'dist');
  const files = listFiles(srcDir);
  if (wantTests && fs.existsSync(testDir)) files.push(...listFiles(testDir));
  let count = 0;
  for (const file of files) {
    // The tsc build uses rootDir "src" with outDir "dist" (src/cli.ts ->
    // dist/cli.js). The fallback has to produce the same layout, otherwise the
    // published "bin" target (dist/cli.js) does not exist after a rebuild.
    const baseDir = wantTests ? root : srcDir;
    const rel = path.relative(baseDir, file);
    const outFile = path.join(outBase, rel.replace(/\.ts$/, '.js'));
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const source = fs.readFileSync(file, 'utf8');
    const js = stripTypes(mod, source, rel);
    fs.writeFileSync(outFile, js);
    count++;
  }
  console.log('[build] type-stripped ' + count + ' file(s) -> ' + path.relative(root, outBase));
}

async function main() {
  const project = wantTests ? 'tsconfig.test.json' : 'tsconfig.json';
  const outBase = wantTests ? path.join(root, 'build') : path.join(root, 'dist');
  // The published package ships the sources and this script but not the
  // tsconfig files, so the compiler is only used when its project file is
  // actually there. Without it the type stripper below does the job.
  const hasProject = fs.existsSync(path.join(root, project));
  const tsc = hasProject ? findTsc() : null;
  cleanOutDir(outBase);
  if (tsc) {
    console.log('[build] using tsc: ' + tsc);
    const result = runTsc(tsc, project, outBase);
    if (result.ok) {
      if (!wantTests) finalizeDist(outBase);
      console.log('[build] done -> ' + (wantTests ? 'build/' : 'dist/'));
      return;
    }
    console.error(
      '[build] tsc reported ' + result.count + ' error(s); see ' +
        path.relative(root, path.join(outBase, 'tsc-errors.log')) +
        '. Falling back to node:module.stripTypeScriptTypes.',
    );
  } else {
    console.log(
      '[build] ' + (hasProject ? 'no local tsc found' : 'no ' + project + ' found') +
        '; falling back to node:module.stripTypeScriptTypes',
    );
  }
  await stripBuild();
  if (!wantTests) finalizeDist(outBase);
}

await main();
