/**
 * 插桩中立性验证。
 *
 * 工程题的门槛（gates）判定完全依赖 `counters.*` 和 `virtualElapsedMs`
 * 这类指标。如果插桩让任何一项发生偏移，门槛就会失真 —— 学员的代码没变，
 * 却因为「开了调试」而通不过，或者反过来蒙混过关。
 *
 * 所以这里对每一关的**参考实现**跑两遍：一遍原样，一遍插桩，
 * 然后逐项比对指标。任何一项不同就报错退出。
 *
 * 用法：node scripts/verify-trace-neutrality.js [projectId]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const libDir = path.join(root, 'src', 'lib', 'engineering');
const sharedLibDir = path.join(root, 'src', 'lib');
const traceDir = path.join(root, 'src', 'lib', 'trace');
const buildDir = path.join(os.tmpdir(), 'algolocal-trace-neutrality');
const engineeringOutDir = path.join(buildDir, 'engineering');
const traceOutDir = path.join(buildDir, 'trace');
const SHARED_MODULES = ['consoleFormat.ts'];

function transpileTo(sourceDir, outDir, names) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of names) {
    if (!name.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(sourceDir, name), 'utf8');
    const output = ts.transpileModule(source, {
      fileName: name,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText;
    fs.writeFileSync(path.join(outDir, name.replace(/\.ts$/, '.js')), output, 'utf8');
  }
}

function buildRuntime() {
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });
  transpileTo(sharedLibDir, buildDir, SHARED_MODULES);
  transpileTo(libDir, engineeringOutDir, fs.readdirSync(libDir));
  transpileTo(traceDir, traceOutDir, fs.readdirSync(traceDir));
}

function toFileMap(files) {
  return (files || []).reduce((acc, file) => {
    acc[file.path] = file.content;
    return acc;
  }, {});
}

/** 只留下门槛会读的那些量，逐项比对 */
function metricFingerprint(report) {
  const m = report.metrics || {};
  return {
    virtualElapsedMs: m.virtualElapsedMs,
    maxConcurrency: m.maxConcurrency,
    requests: m.requests,
    counters: m.counters,
    passed: report.cases.filter((c) => c.passed).length,
    total: report.cases.length,
    gates: (report.gates || []).map((g) => ({ metric: g.metric, value: g.value, passed: g.passed })),
  };
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

async function main() {
  buildRuntime();
  const { runStage } = require(path.join(engineeringOutDir, 'runner.js'));
  const { createTranspiler } = require(path.join(engineeringOutDir, 'transpile.js'));
  const { instrumentSource } = require(path.join(traceOutDir, 'instrument.js'));
  const { createTraceRecorder } = require(path.join(traceOutDir, 'recorder.js'));

  const transpile = createTranspiler(ts);
  const projects = JSON.parse(fs.readFileSync(path.join(root, 'projects', 'projects.json'), 'utf8'));
  const only = process.argv[2];
  const selected = only ? projects.filter((p) => p.id === only) : projects;

  let checked = 0;
  let mismatches = 0;

  for (const project of selected) {
    console.log(`\n${project.id}`);
    for (const stage of project.stages) {
      // 参考实现 = 这一关的正确答案，指标应该稳定可复现
      const files = {
        ...toFileMap(project.files),
        ...toFileMap(stage.starterFiles),
        ...toFileMap(stage.referenceFiles),
      };
      const base = { files, specs: stage.specs, lab: stage.lab, gates: stage.gates, transpile };

      const plain = await runStage(base);
      const recorder = createTraceRecorder();
      const traced = await runStage({
        ...base,
        trace: {
          api: recorder.api,
          instrument: (code, filePath) => instrumentSource(ts, code, { filePath }),
        },
      });

      const a = stableStringify(metricFingerprint(plain));
      const b = stableStringify(metricFingerprint(traced));
      checked += 1;

      if (a === b) {
        console.log(`  ✓ ${stage.id.padEnd(22)} 指标一致（轨迹 ${recorder.trace.steps.length} 步）`);
      } else {
        mismatches += 1;
        console.log(`  ✗ ${stage.id.padEnd(22)} 指标被插桩改变了`);
        console.log(`      不带插桩: ${a}`);
        console.log(`      带插桩:   ${b}`);
      }
    }
  }

  console.log(
    `\n${mismatches === 0 ? '✓' : '✗'} ${checked} 关中 ${checked - mismatches} 关指标完全一致` +
      (mismatches ? `，${mismatches} 关被插桩影响` : '')
  );
  process.exit(mismatches === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
