#!/usr/bin/env node
/**
 * 把 projects/definitions/*.js 编译成 projects/projects.json，
 * 并同步一份到 public/ 供运行时读取（与 problems.json 的做法保持一致）。
 *
 * 用法：node scripts/build-projects.js
 */
const fs = require('fs');
const path = require('path');
const { deriveJavaScriptVariant } = require('./derive-js-variant');

const root = path.join(__dirname, '..');
const definitionsDir = path.join(root, 'projects', 'definitions');
const outputFile = path.join(root, 'projects', 'projects.json');
const publicFile = path.join(root, 'public', 'projects.json');

function fail(message) {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}

function validate(project, source) {
  const required = ['id', 'title', 'summary', 'difficulty', 'brief', 'files', 'stages'];
  for (const field of required) {
    if (!project[field]) fail(`${source}: 缺少字段 ${field}`);
  }
  if (!Array.isArray(project.stages) || project.stages.length === 0) {
    fail(`${source}: stages 不能为空`);
    return;
  }
  project.stages.forEach((stage, index) => {
    if (!stage.id) fail(`${source}: 第 ${index + 1} 关缺少 id`);
    if (!stage.specs || stage.specs.length === 0) {
      fail(`${source}: 第 ${index + 1} 关没有验收用例`);
    }
  });
}

function main() {
  if (!fs.existsSync(definitionsDir)) {
    fail(`找不到目录 ${definitionsDir}`);
    return;
  }

  const files = fs
    .readdirSync(definitionsDir)
    .filter((name) => name.endsWith('.js') && !name.startsWith('_'))
    .sort();

  const projects = files.map((name) => {
    const modulePath = path.join(definitionsDir, name);
    delete require.cache[require.resolve(modulePath)];
    const project = require(modulePath);
    validate(project, name);

    // 题目只写一份 TypeScript，JS 版在这里自动派生，避免两份内容漂移
    if (project.language !== 'javascript') {
      project.variants = { javascript: deriveJavaScriptVariant(project) };
    }

    return project;
  });

  const ids = new Set();
  for (const project of projects) {
    if (ids.has(project.id)) fail(`工程 id 重复：${project.id}`);
    ids.add(project.id);
  }

  if (process.exitCode) return;

  const json = JSON.stringify(projects, null, 2);
  fs.writeFileSync(outputFile, json, 'utf8');

  fs.mkdirSync(path.dirname(publicFile), { recursive: true });
  fs.writeFileSync(publicFile, json, 'utf8');

  const stageCount = projects.reduce((sum, project) => sum + project.stages.length, 0);
  const withJs = projects.filter((project) => project.variants?.javascript).length;
  console.log(
    `✓ 已生成 ${projects.length} 个工程实战项目（共 ${stageCount} 关，其中 ${withJs} 个附带 JavaScript 版） ` +
      '-> projects/projects.json, public/projects.json'
  );
}

main();
