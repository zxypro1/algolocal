/**
 * 工程实战题目的编写辅助
 *
 * 题目里几乎每个字段都是双语的，代码片段又必须保留缩进和换行，
 * 直接手写 JSON 会变成一堆 \n 转义。所以题目源文件用 JS 编写，
 * 再由 scripts/build-projects.js 编译成 projects/projects.json。
 */

/** 双语文本 */
function t(zh, en) {
  return { zh, en };
}

/** 去掉模板字符串的公共缩进，并保证首尾干净 */
function code(strings, ...values) {
  const raw = String.raw({ raw: strings }, ...values);
  const lines = raw.replace(/^\n/, '').replace(/\s+$/, '').split('\n');
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => line.match(/^\s*/)[0].length);
  const shift = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(shift)).join('\n') + '\n';
}

function file(path, content, options = {}) {
  return { path, content, ...options };
}

function readonlyFile(path, content, options = {}) {
  return { path, content, readonly: true, ...options };
}

function spec(path, content) {
  return { path, content };
}

/**
 * @param {object} options
 * @param {string} options.metric  LabMetrics 上的路径
 * @param {'lte'|'lt'|'gte'|'gt'|'eq'} options.op
 */
function gate({ metric, op, value, zh, en, unit, dimension, scope }) {
  return { metric, op, value, label: t(zh, en), unit, dimension, scope };
}

module.exports = { t, code, file, readonlyFile, spec, gate };
