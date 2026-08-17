#!/usr/bin/env node
/**
 * 验证工程实战题目：把每一关的参考实现放进工作区，跑该关的隐藏用例。
 *
 * 一道工程题的「答案」不只是能跑通，还要满足并发/延迟等工程门槛，
 * 所以这个脚本同时校验用例与 gates 全绿。任何一关不过就退出码 1。
 *
 * 用法：node scripts/verify-projects.js [projectId]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

const root = path.join(__dirname, '..');
const libDir = path.join(root, 'src', 'lib', 'engineering');
const buildDir = path.join(os.tmpdir(), 'algolocal-engineering-verify');

/** 用 transpileModule 把运行时库转成 CommonJS，避免依赖完整的 tsc 编译流程 */
function buildRuntime() {
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });

  for (const name of fs.readdirSync(libDir)) {
    if (!name.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(libDir, name), 'utf8');
    const output = ts.transpileModule(source, {
      fileName: name,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    }).outputText;
    fs.writeFileSync(path.join(buildDir, name.replace(/\.ts$/, '.js')), output, 'utf8');
  }
}

function toFileMap(files) {
  return files.reduce((acc, file) => {
    acc[file.path] = file.content;
    return acc;
  }, {});
}

/** 取某个语言版本的文件集；language 为 undefined 时用 TypeScript 原版 */
function viewOf(project, language) {
  if (!language || language === 'typescript') return project;
  const variant = project.variants?.[language];
  if (!variant) return null;
  return {
    files: variant.files,
    stages: project.stages.map((stage, index) => ({
      ...stage,
      starterFiles: variant.stages[index]?.starterFiles || [],
      referenceFiles: variant.stages[index]?.referenceFiles || [],
      specs: variant.stages[index]?.specs || [],
    })),
  };
}

/**
 * 第 stageIndex 关的工作区 = 基础文件 + 前几关解锁的文件 + 参考实现。
 * solved=false 时只覆盖到上一关的参考实现，模拟「本关还没开始写」的状态。
 */
function buildStageWorkspace(project, stageIndex, solved = true) {
  const files = {};
  Object.assign(files, toFileMap(project.files || []));
  for (let index = 0; index <= stageIndex; index += 1) {
    Object.assign(files, toFileMap(project.stages[index].starterFiles || []));
  }
  const lastReference = solved ? stageIndex : stageIndex - 1;
  for (let index = 0; index <= lastReference; index += 1) {
    Object.assign(files, toFileMap(project.stages[index].referenceFiles || []));
  }
  return files;
}

async function main() {
  buildRuntime();
  const { runStage } = require(path.join(buildDir, 'runner.js'));
  const { createTranspiler } = require(path.join(buildDir, 'transpile.js'));
  const { analyzeWorkspace } = require(path.join(buildDir, 'analysis.js'));
  const { computeScoreCard } = require(path.join(buildDir, 'scoring.js'));
  const transpile = createTranspiler(ts);

  const projectsPath = path.join(root, 'projects', 'projects.json');
  if (!fs.existsSync(projectsPath)) {
    console.error('✗ 找不到 projects/projects.json，请先运行 node scripts/build-projects.js');
    process.exit(1);
  }

  const filter = process.argv[2];
  const projects = JSON.parse(fs.readFileSync(projectsPath, 'utf8')).filter(
    (project) => !filter || project.id === filter
  );

  if (projects.length === 0) {
    console.error(`✗ 没有匹配的工程：${filter}`);
    process.exit(1);
  }

  let failures = 0;

  for (const rawProject of projects) {
    console.log(`\n${rawProject.id} — ${rawProject.title.zh}`);

    const languages = ['typescript', ...Object.keys(rawProject.variants || {})];

    for (const language of languages) {
    const project = viewOf(rawProject, language);
    if (!project) continue;
    if (languages.length > 1) console.log(`  · ${language}`);

    for (let index = 0; index < project.stages.length; index += 1) {
      const stage = project.stages[index];
      const files = buildStageWorkspace(project, index);

      if (!(stage.referenceFiles || []).length) {
        console.log(`  第 ${index + 1} 关没有参考实现，跳过验证`);
        continue;
      }

      const report = await runStage({
        files,
        specs: stage.specs,
        lab: stage.lab,
        gates: stage.gates,
        transpile,
      });

      const gatesPassed = report.gates.every((gate) => gate.passed);
      const ok = report.status === 'passed' && gatesPassed;
      if (!ok) failures += 1;

      const quality = analyzeWorkspace(files);
      const scoreCard = computeScoreCard({ report, quality, weights: project.weights });

      console.log(
        `  ${ok ? '✓' : '✗'} 第 ${index + 1} 关 ${stage.id}: ` +
          `${report.totals.passed}/${report.totals.total} 用例, ` +
          `${report.gates.filter((gate) => gate.passed).length}/${report.gates.length} 门槛, ` +
          `评分 ${scoreCard.total}`
      );

      if (report.error) console.log(`      运行错误: ${report.error}`);
      for (const testCase of report.cases) {
        if (!testCase.passed) {
          console.log(`      ✗ ${[...testCase.suite, testCase.name].join(' > ')}`);
          console.log(`        ${(testCase.error || '').split('\n').join('\n        ')}`);
        }
      }
      for (const gate of report.gates) {
        if (!gate.passed) {
          console.log(
            `      ✗ 门槛 ${gate.gate.metric} ${gate.gate.op} ${gate.gate.value}，实际 ${gate.actual}` +
              (gate.gate.scope ? ` (scope: ${gate.gate.scope})` : '')
          );
        }
      }

      // 反向验证：只有起始骨架时必须挂掉，否则说明这一关的用例形同虚设
      const starterReport = await runStage({
        files: buildStageWorkspace(project, index, false),
        specs: stage.specs,
        lab: stage.lab,
        gates: stage.gates,
        transpile,
      });
      if (starterReport.status === 'passed' && starterReport.gates.every((gate) => gate.passed)) {
        failures += 1;
        console.log(`      ✗ 起始骨架也能通过第 ${index + 1} 关，用例没有区分度`);
      }
    }
    }
  }

  console.log('');
  if (failures > 0) {
    console.error(`✗ ${failures} 关未通过`);
    process.exit(1);
  }
  console.log('✓ 全部关卡的参考实现都通过了用例与工程门槛');
}

main().catch((error) => {
  console.error('验证脚本异常:', error);
  process.exit(1);
});
