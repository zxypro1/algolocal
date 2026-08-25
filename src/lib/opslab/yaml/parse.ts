/**
 * YAML 的一个子集
 *
 * 只覆盖 Kubernetes manifest 会用到的部分：嵌套映射、列表、标量、引号、
 * 块标量（`|` 与 `>`）、注释、多文档（`---`）。不做锚点、别名、标签、
 * 流式映射之外的复杂结构。
 *
 * 为什么要自己写：Argo CD 那类控制器跑在宿主这一侧（TypeScript），
 * 得把仓库里的 YAML 变成对象才能 apply。kubectl 自己带 YAML 解析，
 * 但它在 wasm 里，控制器够不着。
 *
 * 正确性靠交叉验证：同一份 manifest 走这里和走真 kubectl
 * （`apply --dry-run=client -o json`），结果必须一致。见 tests/opslab/yaml.test.ts。
 */

export class YamlError extends Error {
  constructor(message: string, readonly line: number) {
    super(`${message} (line ${line + 1})`);
    this.name = 'YamlError';
  }
}

interface Line {
  indent: number;
  text: string;
  index: number;
}

/** 一份文档 */
export function parseYaml(source: string): unknown {
  const documents = parseYamlAll(source);
  return documents.length ? documents[0] : undefined;
}

/** `---` 分隔的多份文档。空文档会被丢掉，和 kubectl 一致。 */
export function parseYamlAll(source: string): unknown[] {
  const chunks: string[][] = [[]];
  for (const raw of source.split('\n')) {
    if (/^---\s*(#.*)?$/.test(raw)) { chunks.push([]); continue; }
    if (/^\.\.\.\s*$/.test(raw)) { chunks.push([]); continue; }
    chunks[chunks.length - 1].push(raw);
  }
  return chunks
    .map((chunk) => parseDocument(chunk))
    .filter((value) => value !== undefined && value !== null);
}

function parseDocument(rawLines: string[]): unknown {
  const lines: Line[] = [];
  let blockIndent: number | null = null;
  rawLines.forEach((raw, index) => {
    // 块标量内部原样保留，注释与缩进都不能动
    if (blockIndent !== null) {
      const indent = indentOf(raw);
      if (raw.trim() === '' || indent >= blockIndent) { lines.push({ indent, text: raw, index }); return; }
      blockIndent = null;
    }
    if (raw.trim() === '' || /^\s*#/.test(raw)) return;
    const indent = indentOf(raw);
    const text = stripComment(raw.slice(indent));
    if (text === '') return;
    lines.push({ indent, text, index });
    if (/[|>][-+]?\s*$/.test(text)) blockIndent = indent + 1;
  });
  if (lines.length === 0) return undefined;
  const [value, consumed] = parseBlock(lines, 0, lines[0].indent);
  if (consumed < lines.length) {
    throw new YamlError('unexpected content', lines[consumed].index);
  }
  return value;
}

function indentOf(raw: string): number {
  let count = 0;
  while (count < raw.length && raw[count] === ' ') count += 1;
  if (raw[count] === '\t') throw new YamlError('found character that cannot start any token (tab)', 0);
  return count;
}

/**
 * 去掉行尾注释。
 *
 * `#` 只有前面是空白时才算注释起点 —— `image: nginx#1` 里那个不是。
 * 引号里的也不算。
 */
function stripComment(text: string): string {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

/** 返回 [值, 消耗掉的行数] */
function parseBlock(lines: Line[], start: number, indent: number): [unknown, number] {
  if (start >= lines.length) return [null, start];
  if (lines[start].text.startsWith('- ') || lines[start].text === '-') {
    return parseSequence(lines, start, indent);
  }
  return parseMapping(lines, start, indent);
}

function parseSequence(lines: Line[], start: number, indent: number): [unknown[], number] {
  const out: unknown[] = [];
  let cursor = start;
  while (cursor < lines.length && lines[cursor].indent === indent
    && (lines[cursor].text === '-' || lines[cursor].text.startsWith('- '))) {
    const line = lines[cursor];
    const inline = line.text === '-' ? '' : line.text.slice(2).trim();
    cursor += 1;

    if (inline === '') {
      const [value, next] = childBlock(lines, cursor, indent);
      out.push(value);
      cursor = next;
      continue;
    }
    // `- name: app` 这种：这一项是个映射，第一个键就写在横杠后面
    if (isMappingEntry(inline)) {
      const childIndent = indent + 2;
      const virtual: Line[] = [{ indent: childIndent, text: inline, index: line.index }];
      while (cursor < lines.length && lines[cursor].indent >= childIndent) {
        virtual.push(lines[cursor]);
        cursor += 1;
      }
      const [value] = parseMapping(virtual, 0, childIndent);
      out.push(value);
      continue;
    }
    out.push(parseScalar(inline));
  }
  return [out, cursor];
}

function parseMapping(lines: Line[], start: number, indent: number): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  let cursor = start;
  while (cursor < lines.length && lines[cursor].indent === indent) {
    const line = lines[cursor];
    const split = splitKey(line.text);
    if (!split) throw new YamlError(`could not find expected ':'`, line.index);
    const [key, rest] = split;
    cursor += 1;

    if (rest === '') {
      const [value, next] = childBlock(lines, cursor, indent);
      out[key] = value;
      cursor = next;
      continue;
    }
    if (/^[|>][-+]?$/.test(rest)) {
      const [value, next] = parseBlockScalar(lines, cursor, indent, rest);
      out[key] = value;
      cursor = next;
      continue;
    }
    out[key] = parseScalar(rest);
  }
  return [out, cursor];
}

/** 下一层：可能是嵌套映射、列表，或者什么都没有（null） */
function childBlock(lines: Line[], cursor: number, indent: number): [unknown, number] {
  if (cursor >= lines.length) return [null, cursor];
  const next = lines[cursor];
  // YAML 允许列表和它的键同缩进
  if (next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) {
    return parseSequence(lines, cursor, indent);
  }
  if (next.indent <= indent) return [null, cursor];
  return parseBlock(lines, cursor, next.indent);
}

function parseBlockScalar(
  lines: Line[], cursor: number, indent: number, marker: string
): [string, number] {
  const folded = marker.startsWith('>');
  const chomp = marker.includes('-') ? 'strip' : marker.includes('+') ? 'keep' : 'clip';
  const body: string[] = [];
  let base: number | null = null;
  let end = cursor;
  while (end < lines.length) {
    const line = lines[end];
    if (line.text.trim() === '') { body.push(''); end += 1; continue; }
    const raw = line.text;
    const lineIndent = raw === line.text ? line.indent : 0;
    if (lineIndent <= indent) break;
    if (base === null) base = lineIndent;
    body.push(raw.slice(base).replace(/^\s+/, (spaces) => spaces));
    end += 1;
  }
  while (body.length && body[body.length - 1] === '') body.pop();
  let text = folded ? foldLines(body) : body.join('\n');
  if (chomp !== 'strip' && text !== '') text += '\n';
  return [text, end];
}

/** `>` 折叠：空行是段落分隔，其余的连成一行 */
function foldLines(body: string[]): string {
  const out: string[] = [];
  for (const line of body) {
    if (line === '') { out.push('\n'); continue; }
    if (out.length && out[out.length - 1] !== '\n') out.push(' ');
    out.push(line);
  }
  return out.join('').replace(/\n /g, '\n');
}

function isMappingEntry(text: string): boolean {
  return splitKey(text) !== undefined;
}

/** `key: value` 里的冒号 —— 引号里的不算，`http://x` 里的也不算 */
function splitKey(text: string): [string, string] | undefined {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"') i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{' || ch === '[') return undefined;
    if (ch === ':' && (i + 1 >= text.length || /\s/.test(text[i + 1]))) {
      return [unquote(text.slice(0, i).trim()), text.slice(i + 1).trim()];
    }
  }
  return undefined;
}

export function parseScalar(text: string): unknown {
  if (text === '') return null;
  if (text.startsWith('"') || text.startsWith("'")) return unquote(text);
  if (text.startsWith('{')) return parseFlowMap(text);
  if (text.startsWith('[')) return parseFlowSeq(text);
  if (text === 'null' || text === '~') return null;
  if (text === 'true' || text === 'True') return true;
  if (text === 'false' || text === 'False') return false;
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d*\.\d+$/.test(text)) return Number(text);
  return text;
}

function unquote(text: string): string {
  if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') {
    return text.slice(1, -1)
      .replace(/\\n/g, '\n').replace(/\\t/g, '\t')
      .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (text.length >= 2 && text[0] === "'" && text[text.length - 1] === "'") {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

function splitFlow(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '{' || ch === '[') depth += 1;
    if (ch === '}' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part !== '');
}

function parseFlowMap(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const part of splitFlow(text.slice(1, -1))) {
    const split = splitKey(part) ?? splitFlowKey(part);
    if (!split) continue;
    out[split[0]] = parseScalar(split[1]);
  }
  return out;
}

/** 流式映射里 `a: b` 的冒号后面可以没有空格 */
function splitFlowKey(part: string): [string, string] | undefined {
  const index = part.indexOf(':');
  return index < 0 ? undefined : [unquote(part.slice(0, index).trim()), part.slice(index + 1).trim()];
}

function parseFlowSeq(text: string): unknown[] {
  return splitFlow(text.slice(1, -1)).map((part) => parseScalar(part));
}
