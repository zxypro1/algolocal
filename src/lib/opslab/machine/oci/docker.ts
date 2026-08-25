/**
 * docker CLI
 *
 * 输出格式照抄真 docker：列宽、`Pushed` / `Pull complete` 这些字样、
 * 报错前缀 `Error response from daemon:`。学员把报错贴进搜索引擎，
 * 应该能搜到现实世界的答案。
 */
import { Vfs, normalizePath } from '../vfs';
import type { CommandContext, CommandHandler, CommandResult } from '../shell/shell';
import { shortId } from './digest';
import { buildImage } from './build';
import { Image, flattenLayers, imageManifest, manifestDigest, parseReference } from './image';
import { Credentials, ImageStore, RegistryError, RegistryNetwork } from './registry';

export interface DockerOptions {
  store: ImageStore;
  network: RegistryNetwork;
  /** 基础镜像自带的工具链，构建时 RUN 用得到 */
  toolchains?: Record<string, Record<string, CommandHandler>>;
  /** 虚拟墙钟（毫秒） */
  now: () => number;
  /** 凭据文件，默认 `~/.docker/config.json` */
  configPath?: string;
}

export function createDockerCommand(options: DockerOptions): CommandHandler {
  return async (context) => {
    const [subcommand, ...rest] = context.argv;
    if (!subcommand) return usage();

    try {
      switch (subcommand) {
        case 'build': return await build(rest, context, options);
        case 'images': case 'image': return images(rest, options);
        case 'tag': return tag(rest, options);
        case 'push': return push(rest, context, options);
        case 'pull': return pull(rest, context, options);
        case 'login': return login(rest, context, options);
        case 'logout': return logout(rest, context, options);
        case 'rmi': return rmi(rest, options);
        case 'inspect': return inspect(rest, options);
        case 'history': return history(rest, options);
        case 'version': return { stdout: VERSION };
        default:
          return {
            stderr: `docker: '${subcommand}' is not a docker command.\nSee 'docker --help'\n`,
            code: 125,
          };
      }
    } catch (error) {
      if (error instanceof RegistryError) {
        return { stderr: `Error response from daemon: ${error.message}\n`, code: 1 };
      }
      throw error;
    }
  };
}

/* ------------------------------------------------------------------ */

interface Flags {
  values: string[];
  single: Record<string, string>;
  repeated: Record<string, string[]>;
  bools: Set<string>;
}

/** docker 的 flag：`-t x`、`--tag=x`、`--build-arg k=v`（可重复）、`-q` */
function parseFlags(argv: string[], valueFlags: string[], boolFlags: string[]): Flags {
  const flags: Flags = { values: [], single: {}, repeated: {}, bools: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('-') || arg === '-') { flags.values.push(arg); continue; }

    const equals = arg.indexOf('=');
    const name = (equals > 0 ? arg.slice(0, equals) : arg).replace(/^--?/, '');
    if (boolFlags.includes(name)) { flags.bools.add(name); continue; }
    if (!valueFlags.includes(name)) { flags.bools.add(name); continue; }

    const value = equals > 0 ? arg.slice(equals + 1) : argv[++i] ?? '';
    flags.single[name] = value;
    flags.repeated[name] = [...(flags.repeated[name] ?? []), value];
  }
  return flags;
}

async function build(argv: string[], context: CommandContext, options: DockerOptions): Promise<CommandResult> {
  const flags = parseFlags(argv, ['t', 'tag', 'f', 'file', 'build-arg', 'target', 'platform'], ['no-cache', 'pull', 'q', 'quiet']);
  const path = flags.values[0];
  if (!path) {
    return { stderr: '"docker build" requires exactly 1 argument.\nSee \'docker build --help\'\n', code: 1 };
  }
  const contextRoot = normalizePath(path, context.cwd);
  if (!context.vfs.isDir(contextRoot)) {
    return { stderr: `ERROR: unable to prepare context: path "${path}" not found\n`, code: 1 };
  }

  const buildArgs: Record<string, string> = {};
  for (const entry of flags.repeated['build-arg'] ?? []) {
    const index = entry.indexOf('=');
    if (index > 0) buildArgs[entry.slice(0, index)] = entry.slice(index + 1);
  }

  const dockerfile = flags.single.f ?? flags.single.file;
  const outcome = await buildImage({
    context: context.vfs,
    contextRoot,
    dockerfilePath: dockerfile ? normalizePath(dockerfile, context.cwd) : undefined,
    tags: [...(flags.repeated.t ?? []), ...(flags.repeated.tag ?? [])],
    buildArgs,
    target: flags.single.target,
    store: options.store,
    network: options.network,
    credentialsFor: (host) => readCredentials(context.vfs, configPath(context, options))[host],
    toolchains: options.toolchains,
    created: new Date(options.now()).toISOString(),
  });

  return outcome.code === 0
    ? { stdout: outcome.log }
    : { stdout: '', stderr: outcome.log, code: outcome.code };
}

function images(argv: string[], options: DockerOptions): CommandResult {
  const flags = parseFlags(argv, [], ['q', 'quiet', 'digests', 'a', 'all']);
  const all = options.store.list();
  if (flags.bools.has('q') || flags.bools.has('quiet')) {
    return { stdout: all.map((image) => shortId(image.id)).join('\n') + (all.length ? '\n' : '') };
  }

  const digests = flags.bools.has('digests');
  const rows: string[][] = [];
  for (const image of all) {
    const tags = image.repoTags.length ? image.repoTags : ['<none>:<none>'];
    for (const reference of tags) {
      const parsed = parseReference(reference);
      const repository = parsed.registry === 'docker.io'
        ? parsed.repository.replace(/^library\//, '')
        : `${parsed.registry}/${parsed.repository}`;
      const row = [repository, parsed.tag || '<none>'];
      if (digests) row.push(manifestDigest(image));
      row.push(shortId(image.id), age(image.created, options.now()), size(image.size));
      rows.push(row);
    }
  }
  const header = ['REPOSITORY', 'TAG', ...(digests ? ['DIGEST'] : []), 'IMAGE ID', 'CREATED', 'SIZE'];
  return { stdout: table(header, rows) };
}

function tag(argv: string[], options: DockerOptions): CommandResult {
  const [source, target] = argv;
  if (!source || !target) {
    return { stderr: '"docker tag" requires exactly 2 arguments.\n', code: 1 };
  }
  options.store.tag(source, target);
  return { code: 0 };
}

function push(argv: string[], context: CommandContext, options: DockerOptions): CommandResult {
  const flags = parseFlags(argv, [], ['a', 'all-tags', 'q', 'quiet']);
  const reference = flags.values[0];
  if (!reference) return { stderr: '"docker push" requires exactly 1 argument.\n', code: 1 };

  const image = options.store.get(reference);
  if (!image) {
    return {
      stderr: `An image does not exist locally with the tag: ${parseReference(reference).canonical}\n`,
      code: 1,
    };
  }
  const parsed = parseReference(reference);
  const registry = options.network.resolve(parsed.registry);
  const credentials = readCredentials(context.vfs, configPath(context, options))[parsed.registry];

  // -a / --all-tags：把这个仓库下该镜像的所有 tag 都推上去
  const allTags = flags.bools.has('a') || flags.bools.has('all-tags');
  const targets = allTags
    ? image.repoTags
      .map((tag) => parseReference(tag))
      .filter((tag) => tag.registry === parsed.registry && tag.repository === parsed.repository)
    : [parsed];

  const lines = [`The push refers to repository [${parsed.registry}/${parsed.repository}]`];
  for (const layer of image.layers) lines.push(`${shortId(layer.digest)}: Pushed`);
  for (const target of targets) {
    const { digest } = registry.push(target.canonical, image, credentials);
    lines.push(`${target.tag}: digest: ${digest} size: ${imageManifest(image).length}`);
  }
  return { stdout: `${lines.join('\n')}\n` };
}

function pull(argv: string[], context: CommandContext, options: DockerOptions): CommandResult {
  const reference = parseFlags(argv, [], ['q', 'quiet']).values[0];
  if (!reference) return { stderr: '"docker pull" requires exactly 1 argument.\n', code: 1 };

  const parsed = parseReference(reference);
  const registry = options.network.resolve(parsed.registry);
  const credentials = readCredentials(context.vfs, configPath(context, options))[parsed.registry];
  const image = registry.pull(reference, credentials);
  options.store.add(image);

  const lines = [`${parsed.tag}: Pulling from ${parsed.repository}`];
  for (const layer of image.layers) lines.push(`${shortId(layer.digest)}: Pull complete`);
  lines.push(
    `Digest: ${manifestDigest(image)}`,
    `Status: Downloaded newer image for ${parsed.canonical}`,
    parsed.canonical
  );
  return { stdout: `${lines.join('\n')}\n` };
}

function login(argv: string[], context: CommandContext, options: DockerOptions): CommandResult {
  const flags = parseFlags(argv, ['u', 'username', 'p', 'password'], ['password-stdin']);
  const host = flags.values[0] ?? 'docker.io';
  const username = flags.single.u ?? flags.single.username;
  const password = flags.bools.has('password-stdin')
    ? context.stdin.replace(/\n$/, '')
    : flags.single.p ?? flags.single.password;

  if (!username || password === undefined) {
    return { stderr: 'Error: Cannot perform an interactive login from a non TTY device\n', code: 1 };
  }

  const registry = options.network.resolve(host);
  if (!registry.authenticate({ username, password })) {
    return {
      stderr: `Error response from daemon: login attempt to https://${host}/v2/ failed with status: 401 Unauthorized\n`,
      code: 1,
    };
  }

  const path = configPath(context, options);
  const config = readConfig(context.vfs, path);
  config.auths = { ...(config.auths ?? {}), [host]: { auth: base64(`${username}:${password}`) } };
  context.vfs.writeFile(path, `${JSON.stringify(config, null, 4)}\n`);

  const warning = flags.bools.has('password-stdin')
    ? ''
    : 'WARNING! Using --password via the CLI is insecure. Use --password-stdin.\n';
  return { stdout: `${warning}Login Succeeded\n` };
}

function logout(argv: string[], context: CommandContext, options: DockerOptions): CommandResult {
  const host = argv[0] ?? 'docker.io';
  const path = configPath(context, options);
  const config = readConfig(context.vfs, path);
  if (config.auths?.[host]) {
    delete config.auths[host];
    context.vfs.writeFile(path, `${JSON.stringify(config, null, 4)}\n`);
  }
  return { stdout: `Removing login credentials for ${host}\n` };
}

function rmi(argv: string[], options: DockerOptions): CommandResult {
  const lines: string[] = [];
  for (const reference of parseFlags(argv, [], ['f', 'force']).values) {
    const result = options.store.remove(reference);
    if (result.untagged) lines.push(`Untagged: ${result.untagged}`);
    if (result.deleted) lines.push(`Deleted: ${result.deleted}`);
  }
  return { stdout: lines.length ? `${lines.join('\n')}\n` : '' };
}

function inspect(argv: string[], options: DockerOptions): CommandResult {
  const found: unknown[] = [];
  for (const reference of parseFlags(argv, ['f', 'format'], []).values) {
    const image = options.store.get(reference);
    if (!image) {
      return { stderr: `Error: No such object: ${reference}\n`, code: 1 };
    }
    found.push({
      Id: image.id,
      RepoTags: image.repoTags,
      RepoDigests: image.repoTags.map((tag) => {
        const ref = parseReference(tag);
        return `${ref.registry}/${ref.repository}@${manifestDigest(image)}`;
      }),
      Created: image.created,
      Architecture: image.architecture,
      Os: image.os,
      Size: image.size,
      Config: image.config,
      RootFS: { Type: 'layers', Layers: image.layers.map((layer) => layer.digest) },
    });
  }
  return { stdout: `${JSON.stringify(found, null, 4)}\n` };
}

function history(argv: string[], options: DockerOptions): CommandResult {
  const reference = parseFlags(argv, [], ['no-trunc']).values[0];
  const image = reference ? options.store.get(reference) : undefined;
  if (!image) return { stderr: `Error response from daemon: No such image: ${reference ?? ''}\n`, code: 1 };

  // 每条 history 对上它的层；元数据指令没有层，SIZE 是 0B
  let layerIndex = 0;
  const rows = image.history.map((entry) => {
    const layer = entry.empty_layer ? undefined : image.layers[layerIndex++];
    return [
      layer ? shortId(layer.digest) : '<missing>',
      age(entry.created, options.now()),
      truncate(entry.created_by, 45),
      size(layer?.size ?? 0),
    ];
  }).reverse();
  return { stdout: table(['IMAGE', 'CREATED', 'CREATED BY', 'SIZE'], rows) };
}

/* ------------------------------------------------------------------ */

interface DockerConfig {
  auths?: Record<string, { auth: string }>;
}

function configPath(context: CommandContext, options: DockerOptions): string {
  return options.configPath ?? `${context.env.HOME ?? '/root'}/.docker/config.json`;
}

function readConfig(vfs: Vfs, path: string): DockerConfig {
  if (!vfs.exists(path)) return {};
  try {
    return JSON.parse(vfs.readFile(path)) as DockerConfig;
  } catch {
    return {};
  }
}

/** 从 `~/.docker/config.json` 里读出每个 registry 的凭据 */
export function readCredentials(vfs: Vfs, path: string): Record<string, Credentials> {
  const out: Record<string, Credentials> = {};
  for (const [host, entry] of Object.entries(readConfig(vfs, path).auths ?? {})) {
    const decoded = unbase64(entry.auth);
    const index = decoded.indexOf(':');
    if (index > 0) out[host] = { username: decoded.slice(0, index), password: decoded.slice(index + 1) };
  }
  return out;
}

/** 浏览器里没有 Buffer，用 btoa/atob */
function base64(text: string): string {
  return btoa(text);
}

function unbase64(text: string): string {
  try {
    return atob(text);
  } catch {
    return '';
  }
}

function truncate(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

/** docker 的 SIZE 列 */
function size(bytes: number): string {
  if (bytes < 1000) return `${bytes}B`;
  if (bytes < 1000 * 1000) return `${(bytes / 1000).toFixed(2)}kB`;
  return `${(bytes / 1000 / 1000).toFixed(2)}MB`;
}

/** docker 的 CREATED 列：`2 minutes ago` */
function age(created: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(created)) / 1000));
  if (seconds < 45) return `${seconds} seconds ago`;
  if (seconds < 90) return 'About a minute ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 45) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.round(days / 7)} weeks ago`;
  if (days < 365) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

/** docker 的列表：列之间至少 3 个空格 */
function table(header: string[], rows: string[][]): string {
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => (row[index] ?? '').length))
  );
  const render = (row: string[]) =>
    row.map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] + 3))).join('').trimEnd();
  return [render(header), ...rows.map(render)].join('\n') + '\n';
}

function usage(): CommandResult {
  return {
    stderr: [
      'Usage:  docker [OPTIONS] COMMAND',
      '',
      'Common Commands:',
      '  build       Build an image from a Dockerfile',
      '  images      List images',
      '  push        Upload an image to a registry',
      '  pull        Download an image from a registry',
      '  login       Authenticate to a registry',
      '  tag         Create a tag that refers to a source image',
      '  inspect     Return low-level information on Docker objects',
      '  history     Show the history of an image',
      '',
    ].join('\n'),
    code: 1,
  };
}

const VERSION = [
  'Client: Docker Engine - Community',
  ' Version:           27.5.1',
  ' API version:       1.47',
  '',
  'Server: Docker Engine - Community',
  ' Engine:',
  '  Version:          27.5.1',
  '  API version:      1.47 (minimum version 1.24)',
  '',
].join('\n');

/** 把镜像摊平成根文件系统 —— 判分时要看「密钥有没有进层」 */
export function imageRootfs(image: Image): Record<string, string> {
  return flattenLayers(image.layers);
}
