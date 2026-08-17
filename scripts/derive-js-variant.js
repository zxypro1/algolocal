/**
 * 从 TypeScript 源码派生 JavaScript 版本
 *
 * 工程题的内容只写一份 TS，JS 版在构建时自动生成——手写两份迟早会漂移。
 *
 * 转换做两件事：
 * 1. 用 tsc 剥掉类型（保留注释、保留 import/export 结构，读起来仍然像手写的）；
 * 2. 把被剥掉的 interface / type 以注释形式留在文件顶部。
 *    这一步很关键：starter 文件里的接口本身就是「契约说明」，
 *    直接删掉的话 JS 版就少了最重要的那部分信息。
 */
const ts = require('typescript');

/**
 * 从源码里原样抠出顶层的 interface / type 声明。
 *
 * 用 getText() 而不是带上前置 trivia：否则文件头部的说明注释会被算作
 * 第一个声明的 JSDoc，在输出里重复一遍。属性上的注释在花括号内，不受影响。
 */
function extractTypeDeclarations(source) {
  const file = ts.createSourceFile('x.ts', source, ts.ScriptTarget.ES2020, true);
  const blocks = [];

  for (const statement of file.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      blocks.push(statement.getText(file).trim());
    }
  }

  return blocks;
}

/**
 * 转成行注释。
 *
 * 必须用 // 而不是 块注释：类型声明里带着 JSDoc，里面的 `*∕` 会把外层块注释
 * 提前闭合，生成一个语法错误的 JS 文件。行注释没有这个问题。
 */
function commentOut(text) {
  return text
    .split('\n')
    .map((line) => (line.trim() ? `// ${line}` : '//'))
    .join('\n');
}

function stripTypes(source, fileName) {
  return ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      removeComments: false,
      // 让 tsc 不要因为「看起来没用到」就把值导入也删掉
      isolatedModules: true,
      verbatimModuleSyntax: false,
    },
  }).outputText;
}

function toJsPath(path) {
  return path.replace(/\.tsx?$/, '.js');
}

/**
 * @returns {{path: string, content: string} | null} 内容为空时返回 null，调用方应丢弃该文件
 */
function deriveFile(file, { commentLabel }) {
  if (!/\.tsx?$/.test(file.path)) return { ...file, content: file.content };

  const jsPath = toJsPath(file.path);

  // 定义里显式给了 JS 版就优先用它
  if (file.jsVariant) {
    return { ...file, path: jsPath, content: file.jsVariant, jsVariant: undefined };
  }

  // 纯类型文件转换后只剩注释和一个占位的 `export {};`，视同为空
  const stripped = stripTypes(file.content, file.path)
    .replace(/^\s*export\s*\{\s*\}\s*;?\s*$/gm, '')
    .trim();

  const hasCode = stripped.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').trim().length > 0;

  let content;
  if (!hasCode) {
    // 纯类型文件（契约文件就是这种）：整份原样注释掉，它本身就是「说明书」
    content = `${commentOut(`${commentLabel}\n\n${file.content.trim()}`)}`;
  } else {
    const declarations = extractTypeDeclarations(file.content);
    content = declarations.length
      ? `${commentOut(`${commentLabel}\n\n${declarations.join('\n\n')}`)}\n\n${stripped}`
      : stripped;
  }

  content = content.replace(/\n{3,}/g, '\n\n').trim();
  if (!content) return null;

  return { ...file, path: jsPath, content: `${content}\n`, jsVariant: undefined };
}

const LABELS = {
  zh: '本文件的类型契约（TypeScript 写法，供参考）：',
  en: 'Type contract for this file (TypeScript syntax, for reference):',
};

function deriveFiles(files, locale = 'zh') {
  return (files || [])
    .map((file) => deriveFile(file, { commentLabel: LABELS[locale] || LABELS.zh }))
    .filter(Boolean);
}

/** 把整个项目派生成 JavaScript 版本 */
function deriveJavaScriptVariant(project) {
  return {
    files: deriveFiles(project.files),
    stages: (project.stages || []).map((stage) => ({
      id: stage.id,
      starterFiles: deriveFiles(stage.starterFiles),
      referenceFiles: deriveFiles(stage.referenceFiles),
      specs: deriveFiles(stage.specs),
    })),
  };
}

module.exports = { deriveJavaScriptVariant, deriveFiles, deriveFile, stripTypes, toJsPath };
