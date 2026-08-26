/**
 * Dockerfile 解析
 *
 * 学员真的会写 Dockerfile，所以语法边角要认全：续行、注释、
 * `--from=builder`、exec form 与 shell form 的区别、多阶段构建。
 * 认不出来的指令要报错，报错文本照抄 BuildKit —— 学员搜错误信息时
 * 搜到的应该是真实世界的答案。
 */

export interface Instruction {
  /** 大写后的指令名 */
  name: string;
  /** 指令名之后、去掉 flag 的部分 */
  args: string;
  /** `--from=builder` 这类 */
  flags: Record<string, string>;
  /** 1 开始，报错要用 */
  line: number;
  raw: string;
}

export interface DockerfileStage {
  index: number;
  /** `FROM x AS builder` 里的 builder */
  name?: string;
  from: string;
  platform?: string;
  instructions: Instruction[];
}

export interface Dockerfile {
  stages: DockerfileStage[];
  /** 第一个 FROM 之前的 ARG，可以用在 FROM 里 */
  globalArgs: Instruction[];
}

export class DockerfileError extends Error {
  constructor(message: string, readonly line: number) {
    super(message);
    this.name = 'DockerfileError';
  }
}

const KNOWN = new Set([
  'FROM', 'RUN', 'CMD', 'LABEL', 'EXPOSE', 'ENV', 'ADD', 'COPY', 'ENTRYPOINT',
  'VOLUME', 'USER', 'WORKDIR', 'ARG', 'ONBUILD', 'STOPSIGNAL', 'HEALTHCHECK', 'SHELL', 'MAINTAINER',
]);

/** 元数据指令不产生层 */
export const METADATA_INSTRUCTIONS = new Set([
  'CMD', 'LABEL', 'EXPOSE', 'ENV', 'ENTRYPOINT', 'VOLUME', 'USER', 'WORKDIR',
  'ARG', 'STOPSIGNAL', 'HEALTHCHECK', 'SHELL', 'MAINTAINER',
]);

export function parseDockerfile(source: string): Dockerfile {
  const logical = joinContinuations(source);
  const stages: DockerfileStage[] = [];
  const globalArgs: Instruction[] = [];

  for (const { text, line } of logical) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const match = /^(\S+)\s*([\s\S]*)$/.exec(trimmed);
    if (!match) continue;
    const name = match[1].toUpperCase();
    if (!KNOWN.has(name)) {
      throw new DockerfileError(`dockerfile parse error on line ${line}: unknown instruction: ${match[1]}`, line);
    }
    if (name === 'ONBUILD') {
      throw new DockerfileError(`dockerfile parse error on line ${line}: ONBUILD is not supported by opslab`, line);
    }

    const { flags, rest } = extractFlags(match[2]);
    const instruction: Instruction = { name, args: rest.trim(), flags, line, raw: trimmed };

    if (name === 'FROM') {
      stages.push(parseFrom(instruction, stages.length));
      continue;
    }
    if (stages.length === 0) {
      if (name === 'ARG') { globalArgs.push(instruction); continue; }
      throw new DockerfileError(
        `dockerfile parse error on line ${line}: no build stage in current context`,
        line
      );
    }
    stages[stages.length - 1].instructions.push(instruction);
  }

  if (stages.length === 0) {
    throw new DockerfileError('dockerfile parse error: file with no instructions', 1);
  }
  return { stages, globalArgs };
}

/** `FROM node:22-alpine AS builder` */
function parseFrom(instruction: Instruction, index: number): DockerfileStage {
  const parts = instruction.args.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    throw new DockerfileError(
      `dockerfile parse error on line ${instruction.line}: FROM requires either one or three arguments`,
      instruction.line
    );
  }
  const [from, keyword, alias] = parts;
  if (keyword && keyword.toUpperCase() !== 'AS') {
    throw new DockerfileError(
      `dockerfile parse error on line ${instruction.line}: expected AS, got ${keyword}`,
      instruction.line
    );
  }
  return { index, from, name: alias, platform: instruction.flags.platform, instructions: [] };
}

/** 把续行接起来，同时记住它在原文件里的行号 */
function joinContinuations(source: string): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  const rawLines = source.split('\n');
  let buffer = '';
  let start = 1;

  for (let i = 0; i < rawLines.length; i += 1) {
    const raw = rawLines[i];
    // 续行中间的注释行按 Docker 的规矩直接丢掉
    if (buffer && /^\s*#/.test(raw)) continue;
    if (!buffer) start = i + 1;
    if (/\\\s*$/.test(raw)) {
      // 只去掉反斜杠和换行，原有的空白照留 —— Docker 就是这么拼的
      buffer += raw.replace(/\\\s*$/, '');
      continue;
    }
    out.push({ text: buffer + raw, line: start });
    buffer = '';
  }
  if (buffer) out.push({ text: buffer, line: start });
  return out;
}

/** `--from=builder --chown=1000:1000 src dst` */
function extractFlags(text: string): { flags: Record<string, string>; rest: string } {
  const flags: Record<string, string> = {};
  let rest = text.trimStart();
  for (;;) {
    const match = /^--([A-Za-z0-9-]+)(?:=(\S*))?\s*/.exec(rest);
    if (!match) break;
    flags[match[1]] = match[2] ?? 'true';
    rest = rest.slice(match[0].length);
  }
  return { flags, rest };
}

/**
 * exec form（`["node","server.js"]`）与 shell form（`node server.js`）
 * 是两回事：前者不经过 /bin/sh，信号能直达进程 —— 第 6 关整关就靠这个区别。
 */
export function parseExecForm(args: string): string[] | null {
  const trimmed = args.trim();
  if (!trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) return parsed;
  } catch {
    return null;
  }
  return null;
}

/** `KEY=value KEY2="v 2"` 或老式的 `KEY value` */
export function parseKeyValues(args: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const tokens = tokenize(args);
  if (tokens.length >= 2 && !tokens[0].includes('=')) {
    return [[tokens[0], tokens.slice(1).join(' ')]];
  }
  for (const token of tokens) {
    const index = token.indexOf('=');
    if (index < 0) continue;
    out.push([token.slice(0, index), unquote(token.slice(index + 1))]);
  }
  return out;
}

/** 按空白切词，但引号内的空白不算 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote) { quote = null; current += char; continue; }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; current += char; continue; }
    if (/\s/.test(char)) {
      if (current) out.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

export function unquote(text: string): string {
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]) {
    return text.slice(1, -1);
  }
  return text;
}
