#!/usr/bin/env node
// @ts-check
/**
 * Benchmarks the type-aware ("Typed*") mutators against a project's own Stryker setup and writes an HTML report.
 *
 * It runs Stryker twice in the project:
 *   1. baseline: the project's own Stryker config with the project's own Stryker install (primitive mutators only)
 *   2. typed:    the same config, with this repository's (local) Stryker build and type-aware mutation enabled,
 *                and `disableBail` so `killedBy` is complete (needed for the subsumption numbers)
 * Then compares both reports (see typed-benchmark-report.mjs).
 *
 * Both runs use Stryker's incremental mode with their own incremental file, so an interrupted benchmark resumes where it
 * stopped: interrupt with Ctrl-C (or `kill -INT <pid of this script>`), never `kill -9` (with `inPlace: true` Stryker
 * restores the original source files on SIGINT/SIGTERM, but cannot on SIGKILL). Use --fresh to start over.
 *
 * Run it with the Node version the project expects, e.g. via mise/nvm. Build this repository first (`pnpm run build`).
 *
 * Usage:
 *   node packages/instrumenter/tools/typed-benchmark.mjs --project ~/work/fetch_9/apps/server --module pricing
 *   node packages/instrumenter/tools/typed-benchmark.mjs --project ~/work/fetch_9/apps/server --module claims --layers domain
 *   node packages/instrumenter/tools/typed-benchmark.mjs --project . --mutate 'src/billing/**\/*.ts' --label billing
 *   node packages/instrumenter/tools/typed-benchmark.mjs --project ~/work/fetch_9/apps/server --module pricing --report-only
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { analyze, renderHtml } from './typed-benchmark-report.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(toolsDir, '../../..');
const localStrykerBin = path.join(repoRoot, 'packages/core/bin/stryker.js');

const HELP = `Usage: node typed-benchmark.mjs --project <dir> (--module <name> | --mutate <globs>) [options]

Scope
  --project <dir>          Directory with the project's Stryker config (default: current directory)
  --module <name>          Mutate src/modules/<name> (e.g. pricing, claims)
  --layers <list>          Layers within the module (default: domain,application). Also mutates <name>.public.ts
                           and public/** unless --layers is given explicitly
  --mutate <globs>         Comma-separated mutate globs, overrides --module/--layers
  --label <name>           Name of this benchmark (default: the module name)
  --tsconfig <file>        tsconfig for type information (default: src/modules/<name>/tsconfig.lib.json if it
                           exists, otherwise tsconfig.json)
  --base-config <file>     The project's Stryker config to extend (default: stryker.config.mjs, .json is supported)

Run
  --max-candidates <n>     Maximum mutants per site for each typed mutator (default: 3)
  --ignore-static          Set ignoreStatic in both runs (much faster, skips mutants in module-level code)
  --typed-bail             Don't disable bail in the typed run (faster, but subsumption numbers become unreliable)
  --concurrency <n>        Override the config's concurrency
  --skip-baseline          Only run the typed run (reuses an existing baseline report for the comparison)
  --skip-typed             Only run the baseline
  --fresh                  Discard incremental results of previous (interrupted) runs of this benchmark
  --allow-dirty            Run even if the project has uncommitted changes
  --out <dir>              Output directory (default: <project>/reports/mutation/typed-benchmark/<label>)

Report
  --report-only            Don't run Stryker, only (re)generate report.html from existing reports
  --baseline-report <file> Baseline mutation.json to use (default: <out>/baseline/mutation.json)
  --typed-report <file>    Typed mutation.json to use (default: <out>/typed/mutation.json)
`;

const { values: args } = parseArgs({
  options: {
    project: { type: 'string', default: '.' },
    module: { type: 'string' },
    layers: { type: 'string' },
    mutate: { type: 'string' },
    label: { type: 'string' },
    tsconfig: { type: 'string' },
    'base-config': { type: 'string', default: 'stryker.config.mjs' },
    'max-candidates': { type: 'string', default: '3' },
    'ignore-static': { type: 'boolean', default: false },
    'typed-bail': { type: 'boolean', default: false },
    concurrency: { type: 'string' },
    'skip-baseline': { type: 'boolean', default: false },
    'skip-typed': { type: 'boolean', default: false },
    fresh: { type: 'boolean', default: false },
    'allow-dirty': { type: 'boolean', default: false },
    out: { type: 'string' },
    'report-only': { type: 'boolean', default: false },
    'baseline-report': { type: 'string' },
    'typed-report': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  console.log(HELP);
  process.exit(0);
}

const fail = (/** @type {string} */ message) => {
  console.error(`typed-benchmark: ${message}`);
  process.exit(1);
};

const projectDir = path.resolve(args.project ?? '.');
if (!fs.existsSync(projectDir))
  fail(`project directory "${projectDir}" does not exist`);
const label = args.label ?? args.module ?? (args.mutate ? 'custom' : undefined);
if (!label) fail('specify --module <name> or --mutate <globs> (see --help)');

/** @returns {string[] | undefined} */
function mutateGlobs() {
  if (args.mutate)
    return args.mutate
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean);
  if (!args.module) return undefined;
  const moduleDir = `src/modules/${args.module}`;
  if (!fs.existsSync(path.join(projectDir, moduleDir)))
    fail(`module directory "${moduleDir}" not found in ${projectDir}`);
  const layers = (args.layers ?? 'domain,application')
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);
  return [
    ...layers.map((layer) => `${moduleDir}/${layer}/**/*.ts`),
    ...(args.layers
      ? []
      : [`${moduleDir}/*.public.ts`, `${moduleDir}/**/public/**/*.ts`]),
    '!**/*.spec.ts',
    '!**/*.arch.spec.ts',
    '!**/*.test-helpers.ts',
    '!**/*.generated.ts',
    '!**/*.d.ts',
  ];
}

function tsconfigFile() {
  if (args.tsconfig) return args.tsconfig;
  if (args.module) {
    const lib = `src/modules/${args.module}/tsconfig.lib.json`;
    if (fs.existsSync(path.join(projectDir, lib))) return lib;
  }
  return 'tsconfig.json';
}

const outDir = path.resolve(
  projectDir,
  args.out ?? `reports/mutation/typed-benchmark/${label}`,
);
const runDirs = {
  baseline: path.join(outDir, 'baseline'),
  typed: path.join(outDir, 'typed'),
};
const runInfoFile = path.join(outDir, 'run.json');

/** @returns {Record<string, any>} */
function readRunInfo() {
  try {
    return JSON.parse(fs.readFileSync(runInfoFile, 'utf-8'));
  } catch {
    return {};
  }
}

/** @param {Record<string, any>} info */
function writeRunInfo(info) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(runInfoFile, JSON.stringify(info, null, 2));
}

function git(/** @type {string[]} */ ...gitArgs) {
  const result = spawnSync('git', gitArgs, {
    cwd: projectDir,
    encoding: 'utf-8',
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function gitCommit(/** @type {string} */ dir) {
  const result = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: dir,
    encoding: 'utf-8',
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** Fails when the project has uncommitted changes: Stryker's `inPlace` mode modifies (and restores) the source files. */
function assertClean() {
  if (args['allow-dirty']) return;
  const status = git(
    'status',
    '--porcelain',
    '--',
    '.',
    `:(exclude)${path.relative(projectDir, outDir) || '.'}`,
  );
  if (status === undefined) {
    console.warn(
      'typed-benchmark: project is not a git repository, skipping the uncommitted-changes check',
    );
    return;
  }
  if (status) {
    fail(
      `the project has uncommitted changes. With "inPlace" Stryker modifies the source files while it runs, so commit or stash first (or pass --allow-dirty):\n${status.split('\n').slice(0, 10).join('\n')}`,
    );
  }
}

function checkNodeVersion() {
  let dir = projectDir;
  while (true) {
    const nvmrc = path.join(dir, '.nvmrc');
    if (fs.existsSync(nvmrc)) {
      const wanted = fs.readFileSync(nvmrc, 'utf-8').trim().replace(/^v/, '');
      if (wanted && !process.version.slice(1).startsWith(wanted)) {
        console.warn(
          `typed-benchmark: the project wants Node ${wanted} (${nvmrc}), but this is Node ${process.version}`,
        );
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** The project's own Stryker install, if any. */
function projectStryker() {
  try {
    const require = createRequire(path.join(projectDir, 'package.json'));
    const pkgFile = require.resolve('@stryker-mutator/core/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf-8'));
    const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.stryker;
    return {
      bin: path.resolve(path.dirname(pkgFile), bin),
      version: /** @type {string} */ (pkg.version),
    };
  } catch {
    return undefined;
  }
}

/**
 * Writes a Stryker config next to the base config (so its relative imports keep working) that extends the base config.
 * @param {'baseline' | 'typed'} kind
 * @param {{ local: boolean, typeAware: boolean }} options
 */
function writeConfig(kind, { local, typeAware }) {
  const baseConfig = args['base-config'] ?? 'stryker.config.mjs';
  if (!fs.existsSync(path.join(projectDir, baseConfig)))
    fail(`base config "${baseConfig}" not found in ${projectDir}`);
  const runDir = runDirs[kind];
  const settings = {
    // Running a local Stryker build: plugins referenced by package name must come from the project, not from this repository
    resolvePlugins: local,
    typeAware: local
      ? {
          enabled: typeAware,
          maxCandidatesPerSite: Number(args['max-candidates']),
        }
      : undefined,
    tsconfigFile: typeAware ? tsconfigFile() : undefined,
    disableBail: typeAware && !args['typed-bail'] ? true : undefined,
    ignoreStatic: args['ignore-static'] || undefined,
    concurrency: args.concurrency ? Number(args.concurrency) : undefined,
    mutate: mutateGlobs(),
    jsonReport: path.join(runDir, 'mutation.json'),
    htmlReport: path.join(runDir, 'index.html'),
    incrementalFile: path.join(runDir, 'incremental.json'),
  };
  const importBase = baseConfig.endsWith('.json')
    ? `import base from './${baseConfig}' with { type: 'json' };`
    : `import base from './${baseConfig}';`;
  const configFile = path.join(
    projectDir,
    `stryker.typed-benchmark-${kind}.config.mjs`,
  );
  fs.writeFileSync(
    configFile,
    `// Generated by stryker-js packages/instrumenter/tools/typed-benchmark.mjs. Removed when the benchmark ends, safe to delete.
${importBase}
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const settings = ${JSON.stringify(settings, null, 2)};
const require = createRequire(import.meta.url);

/** Resolves a plugin package name to the plugin's entry file in this project. */
function resolvePlugin(plugin) {
  if (typeof plugin !== 'string' || !plugin.startsWith('@stryker-mutator/') || plugin.includes('*')) return plugin;
  try {
    const pkgFile = require.resolve(plugin + '/package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf-8'));
    const root = typeof pkg.exports === 'object' && pkg.exports !== null && !Array.isArray(pkg.exports) && '.' in pkg.exports ? pkg.exports['.'] : pkg.exports;
    const entry = typeof root === 'string' ? root : (root?.import ?? root?.default ?? pkg.main);
    return entry ? path.resolve(path.dirname(pkgFile), entry) : plugin;
  } catch {
    return plugin;
  }
}

function plugins() {
  const configured = base.plugins ?? ['@stryker-mutator/*'];
  const named = configured.filter((plugin) => !(typeof plugin === 'string' && plugin.includes('*')));
  if (named.length < configured.length) {
    // A glob would match this repository's plugins instead of the project's, so name the ones the config uses
    if (base.testRunner && !base.testRunner.includes('/')) named.push('@stryker-mutator/' + base.testRunner + '-runner');
    for (const checker of base.checkers ?? []) named.push('@stryker-mutator/' + checker + '-checker');
  }
  return named.map(resolvePlugin);
}

const { typeAware: _typeAware, ...baseMutator } = base.mutator ?? {};

export default {
  ...base,
  ...(settings.resolvePlugins ? { plugins: plugins() } : {}),
  ...(settings.mutate ? { mutate: settings.mutate } : {}),
  mutator: settings.typeAware ? { ...baseMutator, typeAware: settings.typeAware } : baseMutator,
  ...(settings.tsconfigFile ? { tsconfigFile: settings.tsconfigFile } : {}),
  ...(settings.disableBail ? { disableBail: true } : {}),
  ...(settings.ignoreStatic ? { ignoreStatic: true } : {}),
  ...(settings.concurrency ? { concurrency: settings.concurrency } : {}),
  reporters: ['progress-append-only', 'json', 'html'],
  jsonReporter: { fileName: settings.jsonReport },
  htmlReporter: { fileName: settings.htmlReport },
  incremental: true,
  incrementalFile: settings.incrementalFile,
};
`,
  );
  return { configFile, settings };
}

/** @type {import('node:child_process').ChildProcess | undefined} */
let child;
let interrupted = false;
/** @type {string[]} */
const generatedConfigs = [];

function removeGeneratedConfigs() {
  for (const file of generatedConfigs.splice(0))
    fs.rmSync(file, { force: true });
}

for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) {
  process.on(signal, () => {
    if (interrupted) return;
    interrupted = true;
    if (child && child.exitCode === null) {
      console.error(
        `\ntyped-benchmark: ${signal} received, letting Stryker save its progress and restore the source files...`,
      );
      // Stryker runs in its own process group (detached), so it only gets this one signal
      child.kill(signal === 'SIGHUP' ? 'SIGTERM' : signal);
    } else {
      removeGeneratedConfigs();
      process.exit(130);
    }
  });
}

/**
 * @param {'baseline' | 'typed'} kind
 * @param {string} bin
 * @param {string} configFile
 * @returns {Promise<{ code: number | null, ms: number }>}
 */
function runStryker(kind, bin, configFile) {
  const runDir = runDirs[kind];
  fs.mkdirSync(runDir, { recursive: true });
  const log = fs.createWriteStream(path.join(runDir, 'stryker.log'), {
    flags: 'a',
  });
  log.write(
    `\n=== ${new Date().toISOString()} ${bin} run ${path.basename(configFile)}\n`,
  );
  const started = Date.now();
  return new Promise((resolve) => {
    child = spawn(process.execPath, [bin, 'run', path.basename(configFile)], {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    child.stdout?.on('data', (chunk) => {
      process.stdout.write(chunk);
      log.write(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      process.stderr.write(chunk);
      log.write(chunk);
    });
    child.on('exit', (code) => {
      log.end();
      child = undefined;
      resolve({ code, ms: Date.now() - started });
    });
  });
}

/**
 * @param {'baseline' | 'typed'} kind
 * @param {{ bin: string, local: boolean, version: string }} stryker
 */
async function run(kind, stryker) {
  assertClean();
  const runDir = runDirs[kind];
  if (args.fresh)
    fs.rmSync(path.join(runDir, 'incremental.json'), { force: true });
  const resumed = fs.existsSync(path.join(runDir, 'incremental.json'));
  const { configFile, settings } = writeConfig(kind, {
    local: stryker.local,
    typeAware: kind === 'typed',
  });
  generatedConfigs.push(configFile);
  console.log(
    `\ntyped-benchmark: ${kind} run with ${stryker.local ? 'local' : 'project'} Stryker ${stryker.version}${resumed ? ' (resuming from previous results)' : ''}\n`,
  );
  const { code, ms } = await runStryker(kind, stryker.bin, configFile);
  removeGeneratedConfigs();
  const info = readRunInfo();
  info[kind] = {
    stryker: `${stryker.local ? 'local' : 'project'} ${stryker.version}`,
    exitCode: code,
    durationMs:
      (resumed && info[kind]?.durationMs ? info[kind].durationMs : 0) + ms,
    resumed,
    finishedAt: new Date().toISOString(),
    settings,
  };
  writeRunInfo(info);
  if (interrupted) {
    console.error(
      `\ntyped-benchmark: interrupted during the ${kind} run. Rerun the same command to resume (or add --fresh to start over).`,
    );
    process.exit(130);
  }
  if (code !== 0)
    fail(
      `the ${kind} run failed with exit code ${code}, see ${path.join(runDir, 'stryker.log')}`,
    );
}

function writeReport() {
  const baselineFile = path.resolve(
    args['baseline-report'] ?? path.join(runDirs.baseline, 'mutation.json'),
  );
  const typedFile = path.resolve(
    args['typed-report'] ?? path.join(runDirs.typed, 'mutation.json'),
  );
  if (!fs.existsSync(typedFile))
    fail(`no type-aware report found at ${typedFile}`);
  const baselineReport = fs.existsSync(baselineFile)
    ? JSON.parse(fs.readFileSync(baselineFile, 'utf-8'))
    : undefined;
  const typedReport = JSON.parse(fs.readFileSync(typedFile, 'utf-8'));
  const analysis = analyze(baselineReport, typedReport);
  const info = readRunInfo();
  fs.mkdirSync(outDir, { recursive: true });
  const reportFile = path.join(outDir, 'report.html');
  const relative = (/** @type {string} */ file) =>
    path.relative(outDir, file).split(path.sep).join('/');
  const baselineHtml = path.join(path.dirname(baselineFile), 'index.html');
  const typedHtml = path.join(path.dirname(typedFile), 'index.html');
  fs.writeFileSync(
    reportFile,
    renderHtml(analysis, {
      title: `Type-aware mutation benchmark: ${label}`,
      generatedAt: new Date().toISOString(),
      settings: {
        project: projectDir,
        'project commit': git('rev-parse', '--short', 'HEAD') ?? '–',
        'stryker-js commit': gitCommit(repoRoot) ?? '–',
        mutate: mutateGlobs() ?? '(from the base config)',
        tsconfig: tsconfigFile(),
        'base config': args['base-config'],
        'max candidates per site': Number(args['max-candidates']),
        'typed run disables bail': !args['typed-bail'],
        'ignore static': args['ignore-static'],
        'baseline Stryker': info.baseline?.stryker ?? '–',
        'typed Stryker': info.typed?.stryker ?? '–',
        node: process.version,
        'baseline report': baselineReport ? baselineFile : '(none)',
        'typed report': typedFile,
      },
      durations: {
        baseline: info.baseline?.durationMs,
        typed: info.typed?.durationMs,
      },
      links: {
        baseline:
          baselineReport && fs.existsSync(baselineHtml)
            ? relative(baselineHtml)
            : undefined,
        typed: fs.existsSync(typedHtml) ? relative(typedHtml) : undefined,
      },
    }),
  );
  console.log(`\ntyped-benchmark: report written to ${reportFile}`);
  console.log(
    `  ${analysis.typedOnly.total} type-aware mutants, ${analysis.typedOnly.survived} survived, ${analysis.survivorsWherePrimitivesDie.length} where all overlapping primitive mutants are detected`,
  );
}

if (!args['report-only']) {
  if (
    !fs.existsSync(path.join(repoRoot, 'packages/core/dist/src/index.js')) ||
    !fs.existsSync(
      path.join(repoRoot, 'packages/instrumenter/dist/src/index.js'),
    )
  ) {
    fail(
      `the local Stryker build is missing, run "pnpm run build" in ${repoRoot} first`,
    );
  }
  checkNodeVersion();
  const localVersion = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'packages/core/package.json'), 'utf-8'),
  ).version;
  const local = {
    bin: localStrykerBin,
    local: true,
    version: `${localVersion} (${gitCommit(repoRoot) ?? 'unknown commit'})`,
  };
  const installed = projectStryker();
  if (!installed && !args['skip-baseline'])
    console.warn(
      'typed-benchmark: the project has no @stryker-mutator/core install, the baseline uses the local build with type-aware mutation disabled',
    );
  const baselineStryker = installed ? { ...installed, local: false } : local;

  try {
    if (!args['skip-baseline']) await run('baseline', baselineStryker);
    if (!args['skip-typed']) await run('typed', local);
  } finally {
    removeGeneratedConfigs();
  }
}
writeReport();
