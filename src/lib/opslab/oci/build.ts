/**
 * docker build
 *
 * 真的按 Dockerfile 一条条执行：COPY 从构建上下文取文件，RUN 在当层的
 * 根文件系统上跑一个 shell，每条产生层的指令算出真的 sha256。
 * 所以「把密钥 COPY 进去再 rm 掉」这种事，在层里查得出来 —— 第 3 关
 * 要考的就是它。
 */
import { Vfs, createVfs, normalizePath } from '../../labkit/machine/vfs';
import { COREUTILS } from '../../labkit/machine/shell/coreutils';
import { CommandHandler, createShell } from '../../labkit/machine/shell/shell';
import { matchesGlob } from '../../labkit/machine/shell/shell';
import {
  Dockerfile, DockerfileError, DockerfileStage, Instruction,
  METADATA_INSTRUCTIONS, parseDockerfile, parseExecForm, parseKeyValues, tokenize, unquote,
} from './dockerfile';
import {
  Image, Layer, OciImageConfig, finalizeImage, flattenLayers, makeLayer, parseReference,
} from './image';
import { Credentials, ImageStore, RegistryError, RegistryNetwork } from './registry';

export interface BuildOptions {
  /** 构建上下文所在的文件系统与目录 */
  context: Vfs;
  contextRoot: string;
  /** 默认 `<contextRoot>/Dockerfile` */
  dockerfilePath?: string;
  tags?: string[];
  buildArgs?: Record<string, string>;
  /** `--target builder` */
  target?: string;
  store: ImageStore;
  network?: RegistryNetwork;
  credentialsFor?: (host: string) => Credentials | undefined;
  /**
   * 基础镜像自带的工具链：`node:22-alpine` 里有 `npm`，`python:3.13` 里有 `pip`。
   * RUN 的时候把它们装进那个临时 shell。
   */
  toolchains?: Record<string, Record<string, CommandHandler>>;
  /** ISO8601 的创建时间，从虚拟墙钟来 */
  created: string;
}

export interface BuildOutcome {
  image?: Image;
  log: string;
  code: number;
}

/** 每类指令的固定耗时，保证同一个 Dockerfile 每次构建日志都一样 */
const STEP_SECONDS: Record<string, number> = { FROM: 0.2, RUN: 0.4, COPY: 0.1, ADD: 0.1 };

export async function buildImage(options: BuildOptions): Promise<BuildOutcome> {
  const log = new BuildLog();
  const dockerfilePath = options.dockerfilePath ?? `${options.contextRoot}/Dockerfile`;

  if (!options.context.exists(dockerfilePath)) {
    return {
      log: `ERROR: failed to build: failed to read dockerfile: open ${dockerfilePath}: no such file or directory\n`,
      code: 1,
    };
  }

  let parsed: Dockerfile;
  try {
    parsed = parseDockerfile(options.context.readFile(dockerfilePath));
  } catch (error) {
    if (error instanceof DockerfileError) return { log: `ERROR: ${error.message}\n`, code: 1 };
    throw error;
  }

  log.step('[internal] load build definition from Dockerfile', 0.0);
  log.detail(`transferring dockerfile: ${options.context.readFile(dockerfilePath).length}B done`);
  log.done();

  const ignore = readDockerignore(options.context, options.contextRoot);
  const stageOutputs = new Map<string, StageResult>();
  let last: StageResult | undefined;

  try {
    const stages = selectStages(parsed.stages, options.target);
    for (const stage of stages) {
      last = await runStage(stage, parsed, options, log, stageOutputs, ignore);
      stageOutputs.set(String(stage.index), last);
      if (stage.name) stageOutputs.set(stage.name, last);
    }
  } catch (error) {
    if (error instanceof BuildFailure) return { log: log.text() + error.message, code: 1 };
    if (error instanceof RegistryError) return { log: `${log.text()}ERROR: ${error.message}\n`, code: 1 };
    throw error;
  }

  if (!last) return { log: `${log.text()}ERROR: no build stage\n`, code: 1 };

  const tags = (options.tags ?? []).map((tag) => parseReference(tag).canonical);
  const image = finalizeImage({
    config: last.config,
    layers: last.layers,
    history: last.history,
    architecture: 'amd64',
    os: 'linux',
    created: options.created,
    repoTags: tags,
  });

  log.step('exporting to image', 0.1);
  log.detail('exporting layers done');
  log.detail(`writing image ${image.id} done`);
  for (const tag of tags) log.detail(`naming to ${tag} done`);
  log.done();

  options.store.add(image);
  return { image, log: log.text(), code: 0 };
}

/* ------------------------------------------------------------------ */

interface StageResult {
  config: OciImageConfig;
  layers: Layer[];
  history: Image['history'];
  rootfs: Record<string, string>;
  /** 这一阶段的基础镜像带来的工具 */
  tools: Record<string, CommandHandler>;
}

class BuildFailure extends Error {}

/** `--target` 只构建到指定阶段，但它依赖的前置阶段还是要跑 */
function selectStages(stages: DockerfileStage[], target?: string): DockerfileStage[] {
  if (!target) return stages;
  const index = stages.findIndex((stage) => stage.name === target);
  if (index < 0) throw new BuildFailure(`ERROR: failed to solve: target stage "${target}" could not be found\n`);
  return stages.slice(0, index + 1);
}

async function runStage(
  stage: DockerfileStage,
  dockerfile: Dockerfile,
  options: BuildOptions,
  log: BuildLog,
  previous: Map<string, StageResult>,
  ignore: string[]
): Promise<StageResult> {
  const args: Record<string, string> = {};
  for (const global of dockerfile.globalArgs) {
    for (const [key, value] of parseKeyValues(global.args)) args[key] = options.buildArgs?.[key] ?? value;
  }
  for (const [key, value] of Object.entries(options.buildArgs ?? {})) args[key] = value;

  const fromReference = expand(stage.from, args);
  const base = resolveBase(fromReference, options, previous, log);

  const result: StageResult = {
    config: { ...base.config, Env: [...(base.config.Env ?? [])], Labels: { ...(base.config.Labels ?? {}) } },
    layers: [...base.layers],
    history: [...base.history],
    rootfs: { ...base.rootfs },
    tools: base.tools,
  };

  const producing = stage.instructions.filter((i) => !METADATA_INSTRUCTIONS.has(i.name)).length;
  let step = 0;

  for (const instruction of stage.instructions) {
    const isMetadata = METADATA_INSTRUCTIONS.has(instruction.name);
    if (!isMetadata) step += 1;
    const label = isMetadata
      ? `${stageLabel(stage)}${instruction.name} ${instruction.args}`
      : `${stageLabel(stage)}[${step}/${producing}] ${instruction.name} ${instruction.args}`;

    if (isMetadata) {
      applyMetadata(instruction, result, args, options);
      result.history.push({
        created: options.created,
        created_by: `/bin/sh -c #(nop) ${instruction.name} ${instruction.args}`,
        empty_layer: true,
      });
      continue;
    }

    log.step(label.trim(), STEP_SECONDS[instruction.name] ?? 0.1);
    if (instruction.name === 'RUN') await applyRun(instruction, result, options, log);
    else applyCopy(instruction, result, options, previous, ignore, log);
    log.done();
  }

  return result;
}

function stageLabel(stage: DockerfileStage): string {
  return stage.name ? `${stage.name} ` : '';
}

/** FROM：先看前面的阶段，再看本地镜像库，最后才去 registry 拉 */
function resolveBase(
  reference: string,
  options: BuildOptions,
  previous: Map<string, StageResult>,
  log: BuildLog
): StageResult {
  const fromStage = previous.get(reference);
  if (fromStage) return { ...fromStage, layers: [...fromStage.layers], history: [...fromStage.history] };

  if (reference === 'scratch') {
    return { config: {}, layers: [], history: [], rootfs: {}, tools: {} };
  }

  const canonical = parseReference(reference).canonical;
  const tools = options.toolchains?.[canonical] ?? options.toolchains?.[reference] ?? {};

  let image = options.store.get(reference);
  if (!image) {
    log.step(`[internal] load metadata for ${canonical}`, 0.2);
    log.done();
    const parsedReference = parseReference(reference);
    const registry = options.network?.resolve(parsedReference.registry);
    if (!registry) {
      throw new BuildFailure(
        `ERROR: failed to solve: ${reference}: failed to resolve source metadata for ${canonical}\n`
      );
    }
    image = registry.pull(reference, options.credentialsFor?.(parsedReference.registry));
    options.store.add(image);
  }

  return {
    config: { ...image.config },
    layers: [...image.layers],
    history: [...image.history],
    rootfs: flattenLayers(image.layers),
    tools,
  };
}

function applyMetadata(
  instruction: Instruction,
  result: StageResult,
  args: Record<string, string>,
  options: BuildOptions
): void {
  const value = expand(instruction.args, { ...args, ...envMap(result.config.Env) });

  switch (instruction.name) {
    case 'ENV':
      for (const [key, item] of parseKeyValues(instruction.args)) {
        setEnv(result.config, key, expand(item, { ...args, ...envMap(result.config.Env) }));
      }
      break;

    case 'ARG':
      for (const [key, fallback] of parseKeyValues(instruction.args)) {
        args[key] = options.buildArgs?.[key] ?? args[key] ?? fallback;
      }
      break;

    case 'WORKDIR':
      result.config.WorkingDir = normalizePath(unquote(value), result.config.WorkingDir ?? '/');
      break;

    case 'USER':
      result.config.User = unquote(value);
      break;

    case 'EXPOSE':
      result.config.ExposedPorts = { ...(result.config.ExposedPorts ?? {}) };
      for (const port of tokenize(value)) {
        result.config.ExposedPorts[port.includes('/') ? port : `${port}/tcp`] = {};
      }
      break;

    case 'LABEL':
      result.config.Labels = { ...(result.config.Labels ?? {}) };
      for (const [key, item] of parseKeyValues(instruction.args)) {
        result.config.Labels[key] = expand(item, { ...args, ...envMap(result.config.Env) });
      }
      break;

    case 'VOLUME':
      result.config.Volumes = { ...(result.config.Volumes ?? {}) };
      for (const path of parseExecForm(value) ?? tokenize(value)) result.config.Volumes[unquote(path)] = {};
      break;

    case 'CMD':
      result.config.Cmd = parseExecForm(instruction.args) ?? ['/bin/sh', '-c', value];
      break;

    case 'ENTRYPOINT':
      result.config.Entrypoint = parseExecForm(instruction.args) ?? ['/bin/sh', '-c', value];
      break;

    case 'STOPSIGNAL':
      result.config.StopSignal = value;
      break;

    case 'HEALTHCHECK':
      result.config.Healthcheck = value.toUpperCase().startsWith('NONE')
        ? { Test: ['NONE'] }
        : { Test: ['CMD-SHELL', value.replace(/^CMD(-SHELL)?\s+/i, '')] };
      break;

    default:
      break;
  }
}

/** RUN：把当前 rootfs 铺进临时文件系统跑一遍，再 diff 出这一层 */
async function applyRun(
  instruction: Instruction,
  result: StageResult,
  options: BuildOptions,
  log: BuildLog
): Promise<void> {
  const vfs = createVfs(() => 0);
  vfs.populate(result.rootfs);
  const workdir = result.config.WorkingDir ?? '/';
  vfs.mkdirp(workdir);

  const shell = createShell({
    vfs,
    cwd: workdir,
    env: envMap(result.config.Env),
    commands: { ...COREUTILS, ...result.tools },
    user: result.config.User ?? 'root',
  });

  const script = (parseExecForm(instruction.args) ?? []).length
    ? (parseExecForm(instruction.args) as string[]).join(' ')
    : instruction.args;

  const outcome = await shell.run(script);
  const output = outcome.stdout + outcome.stderr;
  const code = outcome.code;

  for (const line of output.split('\n')) {
    if (line) log.detail(line, true);
  }
  if (code !== 0) {
    log.fail();
    throw new BuildFailure(
      `------\n > [${instruction.name} ${instruction.args}]:\n${output}------\n` +
      `ERROR: failed to solve: process "/bin/sh -c ${instruction.args}" did not complete successfully: exit code: ${code}\n`
    );
  }

  const after = vfs.toFileMap('/');
  const layer = diffLayer(result.rootfs, after, `/bin/sh -c ${instruction.args}`);
  commit(result, layer, options.created);
}

/** COPY / ADD */
function applyCopy(
  instruction: Instruction,
  result: StageResult,
  options: BuildOptions,
  previous: Map<string, StageResult>,
  ignore: string[],
  log: BuildLog
): void {
  const parts = tokenize(instruction.args).map(unquote);
  if (parts.length < 2) {
    throw new BuildFailure(
      `ERROR: failed to solve: ${instruction.name} requires at least two arguments\n`
    );
  }
  const destination = parts[parts.length - 1];
  const sources = parts.slice(0, -1);
  const workdir = result.config.WorkingDir ?? '/';

  // --from 可以指向前面的阶段，也可以指向一个镜像
  const from = instruction.flags.from;
  const sourceFiles = from !== undefined
    ? stageFiles(from, previous, options)
    : contextFiles(options, ignore);
  const sourceRoot = from !== undefined ? '/' : options.contextRoot;

  const collected: Record<string, string> = {};
  for (const source of sources) {
    const absolute = normalizePath(source, sourceRoot);
    const matched = Object.keys(sourceFiles).filter((path) =>
      path === absolute || path.startsWith(`${absolute}/`) || matchesGlob(absolute, path)
    );
    if (matched.length === 0) {
      log.fail();
      throw new BuildFailure(
        `ERROR: failed to solve: failed to compute cache key: "${source}" not found: not found\n`
      );
    }
    for (const path of matched) {
      collected[copyTarget({ path, absolute, matched, sources, destination, workdir })] = sourceFiles[path];
    }
  }

  const after = { ...result.rootfs, ...collected };
  const layer = diffLayer(result.rootfs, after, `${instruction.name} ${instruction.args}`);
  commit(result, layer, options.created);
}

/**
 * 一个来源文件该落到目标的哪个路径上。
 *
 * Docker 的规矩：**单个文件 + 目标不以 `/` 结尾** 时目标就是文件名本身
 * （`COPY app.js /srv/index.js` 会改名）；其它情况一律当成「拷进目录」，
 * 目录来源还要保留相对层级。
 */
function copyTarget(input: {
  path: string;
  absolute: string;
  matched: string[];
  sources: string[];
  destination: string;
  workdir: string;
}): string {
  const { path, absolute, matched, sources, destination, workdir } = input;
  const isSingleFile = matched.length === 1 && matched[0] === absolute;

  if (isSingleFile && sources.length === 1 && !destination.endsWith('/')) {
    return normalizePath(destination, workdir);
  }
  const relative = isSingleFile
    ? absolute.slice(absolute.lastIndexOf('/') + 1)
    : path.slice(absolute.length + 1);
  return normalizePath(`${destination}/${relative}`, workdir);
}

function stageFiles(
  from: string,
  previous: Map<string, StageResult>,
  options: BuildOptions
): Record<string, string> {
  const stage = previous.get(from);
  if (stage) return stage.rootfs;
  const image = options.store.get(from);
  if (image) return flattenLayers(image.layers);
  throw new BuildFailure(`ERROR: failed to solve: invalid from flag value ${from}: stage not found\n`);
}

function contextFiles(options: BuildOptions, ignore: string[]): Record<string, string> {
  const all = options.context.toFileMap(options.contextRoot);
  if (ignore.length === 0) return all;
  const kept: Record<string, string> = {};
  for (const [path, content] of Object.entries(all)) {
    const relative = path.slice(options.contextRoot.length + 1);
    if (ignore.some((pattern) => matchesGlob(pattern, relative) || relative.startsWith(`${pattern}/`))) continue;
    kept[path] = content;
  }
  return kept;
}

function readDockerignore(vfs: Vfs, root: string): string[] {
  const path = `${root}/.dockerignore`;
  if (!vfs.exists(path)) return [];
  return vfs
    .readFile(path)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function diffLayer(
  before: Record<string, string>,
  after: Record<string, string>,
  createdBy: string
): Layer {
  const files: Record<string, string> = {};
  for (const [path, content] of Object.entries(after)) {
    if (before[path] !== content) files[path] = content;
  }
  const removed = Object.keys(before).filter((path) => !(path in after));
  return makeLayer(files, removed, createdBy);
}

function commit(result: StageResult, layer: Layer, created: string): void {
  // 空层不留痕迹，和 Docker 一样
  if (Object.keys(layer.files).length === 0 && layer.removed.length === 0) return;
  result.layers.push(layer);
  result.history.push({ created, created_by: layer.createdBy });
  for (const path of layer.removed) delete result.rootfs[path];
  Object.assign(result.rootfs, layer.files);
}

function envMap(env?: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of env ?? []) {
    const index = entry.indexOf('=');
    if (index > 0) out[entry.slice(0, index)] = entry.slice(index + 1);
  }
  return out;
}

function setEnv(config: OciImageConfig, key: string, value: string): void {
  const env = [...(config.Env ?? [])];
  const index = env.findIndex((entry) => entry.startsWith(`${key}=`));
  if (index >= 0) env[index] = `${key}=${value}`;
  else env.push(`${key}=${value}`);
  config.Env = env;
}

/** `${VAR}` / `$VAR` —— Dockerfile 的展开规则比 shell 简单得多 */
function expand(text: string, values: Record<string, string>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (_, braced, bare) => values[braced ?? bare] ?? '');
}

/* ------------------------------------------------------------------ */

/** BuildKit 的进度输出 */
class BuildLog {
  private lines: string[] = [];
  private index = 0;
  private elapsed = 0;
  private current = 0;

  step(title: string, seconds: number): void {
    this.index += 1;
    this.current = this.index;
    this.elapsed += seconds;
    this.lines.push(`#${this.index} ${title}`);
  }

  detail(text: string, timed = false): void {
    this.lines.push(`#${this.current || 1} ${timed ? `${this.elapsed.toFixed(3)} ` : ''}${text}`);
  }

  done(): void {
    this.lines.push(`#${this.current} DONE ${this.elapsed.toFixed(1)}s`, '');
  }

  fail(): void {
    this.lines.push(`#${this.current} ERROR: process did not complete successfully`, '');
  }

  text(): string {
    return this.lines.length ? `${this.lines.join('\n')}\n` : '';
  }
}
