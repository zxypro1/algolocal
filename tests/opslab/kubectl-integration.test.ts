/**
 * 真 kubectl 打到我们的 apiserver 上
 *
 * 这是整条链路唯一说了算的验证：前面那些单元测试证明的是「我们以为 kubectl 想要什么」，
 * 这里证明的是「kubectl 真的接受」。spike 时手搓过一个 miniApiServer，
 * 这一版换成真正的 registry + HTTP 层。
 *
 * kubectl.wasm 约 115MB，不进仓库 —— 没有产物时整组跳过，
 * 先跑 `bash scripts/build-opslab-wasm.sh` 生成。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createStore } from '../../src/lib/opslab/store';
import {
  ApiServer,
  createApiServer,
  createScheme,
  Registry,
  ResourceDefinition,
} from '../../src/lib/opslab/apiserver';

const WASM_PATH = path.join(__dirname, '../../public/opslab/kubectl.wasm');
const WASM_EXEC = path.join(__dirname, '../../public/opslab/wasm_exec.js');
const HAS_ARTIFACT = fs.existsSync(WASM_PATH) && fs.existsSync(WASM_EXEC);

const describeIfBuilt = HAS_ARTIFACT ? describe : describe.skip;

const PODS: ResourceDefinition = {
  group: '', version: 'v1', resource: 'pods', singular: 'pod', kind: 'Pod',
  namespaced: true, shortNames: ['po'], subresources: ['status'],
};
const NAMESPACES: ResourceDefinition = {
  group: '', version: 'v1', resource: 'namespaces', singular: 'namespace',
  kind: 'Namespace', namespaced: false, shortNames: ['ns'],
};
const DEPLOYMENTS: ResourceDefinition = {
  group: 'apps', version: 'v1', resource: 'deployments', singular: 'deployment',
  kind: 'Deployment', namespaced: true, shortNames: ['deploy'], subresources: ['status', 'scale'],
};

const KUBECONFIG = `apiVersion: v1
kind: Config
clusters:
- name: opslab
  cluster:
    server: https://apiserver.opslab
contexts:
- name: opslab
  context:
    cluster: opslab
    user: ops
    namespace: default
current-context: opslab
users:
- name: ops
  user:
    token: opslab-token
`;

/** 虚拟世界的「现在」固定住，AGE 列才可复现 */
const VIRTUAL_NOW = Date.parse('2026-01-01T04:12:00Z');

function buildWorld() {
  const store = createStore();
  const scheme = createScheme([PODS, NAMESPACES, DEPLOYMENTS]);
  let uid = 0;
  const registry = new Registry({
    store, scheme,
    now: () => Date.parse('2026-01-01T00:00:00Z'),
    uid: () => `uid-${++uid}`,
  });
  const server = createApiServer({ registry, scheme, now: () => VIRTUAL_NOW });

  registry.create(NAMESPACES, undefined, {
    apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'default' }, status: { phase: 'Active' },
  });
  registry.create(PODS, 'default', {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name: 'payments-7f4-2xk', labels: { app: 'payments' } },
    spec: { nodeName: 'node-1', containers: [{ name: 'app', image: 'registry.corp.internal/payments:1.4' }] },
    status: { phase: 'Running', podIP: '10.42.1.7', containerStatuses: [{ name: 'app', ready: true, restartCount: 0 }] },
  });
  registry.create(PODS, 'default', {
    apiVersion: 'v1', kind: 'Pod',
    metadata: { name: 'portal-6c9-abc', labels: { app: 'portal' } },
    spec: { nodeName: 'node-2', containers: [{ name: 'app', image: 'registry.corp.internal/portal:2.1' }] },
    status: { phase: 'Running', podIP: '10.42.2.3', containerStatuses: [{ name: 'app', ready: true, restartCount: 2 }] },
  });
  return { registry, server, scheme };
}

/** 极简内存 FS：kubectl 要读 kubeconfig 与 -f 指到的 manifest */
function createVFS(files: Record<string, string>, onOut: (s: string) => void, onErr: (s: string) => void) {
  const decoder = new TextDecoder();
  const tree = new Map<string, Uint8Array>();
  for (const [p, c] of Object.entries(files)) tree.set(p, new TextEncoder().encode(c));
  const fds = new Map<number, { path: string; pos: number }>();
  let nextFd = 3;
  const err = (code: string) => Object.assign(new Error(code), { code });
  const statOf = (p: string) => {
    const isDir = ![...tree.keys()].includes(p) && [...tree.keys()].some((k) => k.startsWith(`${p}/`));
    const size = tree.get(p)?.length ?? 0;
    return {
      dev: 1, ino: 1, mode: isDir ? 0o40755 : 0o100644, nlink: 1, uid: 0, gid: 0, rdev: 0,
      size, blksize: 4096, blocks: 1, atimeMs: 0, mtimeMs: 0, ctimeMs: 0, birthtimeMs: 0,
      isDirectory: () => isDir, isFile: () => !isDir, isSymbolicLink: () => false,
      isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
    };
  };
  return {
    constants: { O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_TRUNC: 512, O_APPEND: 1024, O_EXCL: 128 },
    writeSync(fd: number, buf: Uint8Array) {
      if (fd === 1) onOut(decoder.decode(buf));
      else if (fd === 2) onErr(decoder.decode(buf));
      return buf.length;
    },
    write(fd: number, buf: Uint8Array, offset: number, length: number, _pos: unknown, cb: Function) {
      cb(null, this.writeSync(fd, buf.subarray(offset, offset + length)));
    },
    open(p: string, _flags: number, _mode: number, cb: Function) {
      if (!tree.has(p)) return cb(err('ENOENT'));
      const fd = nextFd++;
      fds.set(fd, { path: p, pos: 0 });
      cb(null, fd);
    },
    close(fd: number, cb: Function) { fds.delete(fd); cb(null); },
    read(fd: number, buf: Uint8Array, offset: number, length: number, position: number | null, cb: Function) {
      const handle = fds.get(fd);
      if (!handle) return cb(err('EBADF'));
      const data = tree.get(handle.path) ?? new Uint8Array(0);
      const pos = position === null ? handle.pos : position;
      const n = Math.min(length, Math.max(0, data.length - pos));
      buf.set(data.subarray(pos, pos + n), offset);
      if (position === null) handle.pos += n;
      cb(null, n);
    },
    fsync(_fd: number, cb: Function) { cb(null); },
    stat(p: string, cb: Function) {
      if (!tree.has(p) && ![...tree.keys()].some((k) => k.startsWith(`${p}/`))) return cb(err('ENOENT'));
      cb(null, statOf(p));
    },
    lstat(p: string, cb: Function) { this.stat(p, cb); },
    fstat(fd: number, cb: Function) {
      const handle = fds.get(fd);
      if (!handle) return cb(err('EBADF'));
      cb(null, statOf(handle.path));
    },
    mkdir(_p: string, _m: number, cb: Function) { cb(null); },
    readdir(_p: string, cb: Function) { cb(null, []); },
    unlink(_p: string, cb: Function) { cb(null); },
    rmdir(_p: string, cb: Function) { cb(null); },
    rename(_a: string, _b: string, cb: Function) { cb(null); },
    chmod(_p: string, _m: number, cb: Function) { cb(null); },
    fchmod(_fd: number, _m: number, cb: Function) { cb(null); },
    chown(_p: string, _u: number, _g: number, cb: Function) { cb(null); },
    fchown(_fd: number, _u: number, _g: number, cb: Function) { cb(null); },
    lchown(_p: string, _u: number, _g: number, cb: Function) { cb(null); },
    utimes(_p: string, _a: number, _m: number, cb: Function) { cb(null); },
    truncate(_p: string, _l: number, cb: Function) { cb(null); },
    ftruncate(_fd: number, _l: number, cb: Function) { cb(null); },
    readlink(_p: string, cb: Function) { cb(err('EINVAL')); },
    symlink(_t: string, _p: string, cb: Function) { cb(null); },
    link(_a: string, _b: string, cb: Function) { cb(null); },
  };
}

let compiled: WebAssembly.Module | null = null;

async function runKubectl(
  server: ApiServer,
  args: string[],
  files: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  if (!compiled) compiled = await WebAssembly.compile(fs.readFileSync(WASM_PATH));

  let stdout = '';
  let stderr = '';
  const vfs = createVFS(
    { '/root/.kube/config': KUBECONFIG, ...files },
    (s) => { stdout += s; },
    (s) => { stderr += s; }
  );

  const g = globalThis as any;
  const saved = { fs: g.fs, fetch: g.fetch, process: g.process, path: g.path };
  g.fs = vfs;
  g.path = createRequire(__filename)('node:path');
  g.process = {
    getuid: () => 0, getgid: () => 0, geteuid: () => 0, getegid: () => 0, getgroups: () => [0],
    pid: 1, ppid: 0, umask: () => 0o22, cwd: () => '/root', chdir: () => {},
    env: { HOME: '/root', KUBECONFIG: '/root/.kube/config' },
    on: () => {},
  };
  g.fetch = (url: any, init: any) => server.handle(String(url), init);

  if (!g.Go) {
    // wasm_exec.js 是 Go 发行版带的，构建脚本拷到 public/opslab/
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require(WASM_EXEC);
  }
  const go = new g.Go();
  go.argv = ['kubectl', ...args];
  go.env = { HOME: '/root', KUBECONFIG: '/root/.kube/config' };
  let code = 0;
  go.exit = (c: number) => { code = c; };

  try {
    const instance = await WebAssembly.instantiate(compiled, go.importObject);
    await go.run(instance);
  } catch (error) {
    stderr += String((error as Error)?.message ?? error);
    code = code || 1;
  } finally {
    // 不清的话每条命令泄漏 68MB —— spike 时踩过，_scheduledTimeouts 是 Map，
    // 用 Object.values 清等于没清
    if (go._scheduledTimeouts instanceof Map) {
      for (const handle of go._scheduledTimeouts.values()) clearTimeout(handle as any);
      go._scheduledTimeouts.clear();
    }
    go._resume = () => {};
    go._inst = null; go.mem = null; go._values = null; go._goRefCounts = null; go._ids = null;
    g.fs = saved.fs; g.fetch = saved.fetch; g.process = saved.process; g.path = saved.path;
  }
  return { stdout, stderr, code };
}

describeIfBuilt('真 kubectl 打到我们的 apiserver', () => {
  jest.setTimeout(120_000);

  it('kubectl get pods —— 服务端渲染的表格', async () => {
    const { server } = buildWorld();
    const result = await runKubectl(server, ['get', 'pods']);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      'NAME               READY   STATUS    RESTARTS   AGE\n' +
      'payments-7f4-2xk   1/1     Running   0          4h12m\n' +
      'portal-6c9-abc     1/1     Running   2          4h12m\n'
    );
  });

  it('kubectl get pods -o wide —— priority 1 的列出现', async () => {
    const { server } = buildWorld();
    const result = await runKubectl(server, ['get', 'pods', '-o', 'wide']);
    expect(result.stdout).toContain('IP          NODE     NOMINATED NODE   READINESS GATES');
    expect(result.stdout).toContain('10.42.1.7   node-1   <none>           <none>');
  });

  it('简称经 discovery 解析：po == pods', async () => {
    const { server } = buildWorld();
    const result = await runKubectl(server, ['get', 'po', '-o', 'name']);
    expect(result.stdout).toBe('pod/payments-7f4-2xk\npod/portal-6c9-abc\n');
  });

  it('kubectl api-resources 列出 discovery 的内容', async () => {
    const { server } = buildWorld();
    const result = await runKubectl(server, ['api-resources']);
    expect(result.stdout).toContain('NAME          SHORTNAMES   APIVERSION   NAMESPACED   KIND');
    expect(result.stdout).toContain('pods          po           v1           true         Pod');
    expect(result.stdout).toContain('deployments   deploy       apps/v1      true         Deployment');
  });

  it('找不到的报错是 apiserver 发的那一句', async () => {
    const { server } = buildWorld();
    const result = await runKubectl(server, ['get', 'pod', 'nope']);
    expect(result.stderr.trim()).toBe('Error from server (NotFound): pods "nope" not found');
    expect(result.code).not.toBe(0);
  });

  it('kubectl apply 建出对象，并写上 last-applied-configuration', async () => {
    const { server, registry, scheme } = buildWorld();
    const manifest = [
      'apiVersion: apps/v1', 'kind: Deployment',
      'metadata:', '  name: ledger', '  namespace: default',
      'spec:', '  replicas: 3',
      '  selector:', '    matchLabels:', '      app: ledger',
      '  template:', '    metadata:', '      labels:', '        app: ledger',
      '    spec:', '      containers:', '      - name: app',
      '        image: registry.corp.internal/ledger:0.9', '',
    ].join('\n');

    const result = await runKubectl(
      server,
      ['apply', '-f', '/root/infra/ledger.yaml', '--validate=false'],
      { '/root/infra/ledger.yaml': manifest }
    );
    expect(result.stdout.trim()).toBe('deployment.apps/ledger created');

    const stored = registry.get(scheme.mustGet({ group: 'apps', version: 'v1', resource: 'deployments' }), 'default', 'ledger');
    expect(stored.metadata.annotations?.['kubectl.kubernetes.io/last-applied-configuration']).toBeDefined();
    expect((stored.spec as any).replicas).toBe(3);
  });

  it('-o jsonpath 与 custom-columns 都是 kubectl 自己算的', async () => {
    const { server } = buildWorld();
    const jsonpath = await runKubectl(server, [
      'get', 'pod', 'payments-7f4-2xk', '-o', 'jsonpath={.spec.containers[0].image}',
    ]);
    expect(jsonpath.stdout).toBe('registry.corp.internal/payments:1.4');

    const columns = await runKubectl(server, [
      'get', 'pods', '--sort-by', '.metadata.name',
      '-o', 'custom-columns=NAME:.metadata.name,NODE:.spec.nodeName',
    ]);
    expect(columns.stdout).toBe(
      'NAME               NODE\n' +
      'payments-7f4-2xk   node-1\n' +
      'portal-6c9-abc     node-2\n'
    );
  });

  it('同一串命令重放 5 次，输出逐字节一致', async () => {
    const transcript = async () => {
      const { server } = buildWorld();
      const out: string[] = [];
      for (const args of [['get', 'pods'], ['get', 'ns'], ['api-resources'], ['get', 'pod', 'nope']]) {
        const result = await runKubectl(server, args);
        out.push(`$ kubectl ${args.join(' ')}\n${result.stdout}${result.stderr}[exit ${result.code}]`);
      }
      return out.join('\n');
    };
    const first = await transcript();
    for (let i = 0; i < 4; i += 1) expect(await transcript()).toBe(first);
  });
});

describe('kubectl 集成测试的前提', () => {
  it(HAS_ARTIFACT ? '产物已就绪' : '产物缺失，整组跳过（先跑 scripts/build-opslab-wasm.sh）', () => {
    // 这一条永远通过，只是把跳过的原因写进测试报告，免得「没跑」被误读成「跑过了」
    expect(true).toBe(true);
  });
});
