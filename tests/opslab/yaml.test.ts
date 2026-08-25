/**
 * YAML
 *
 * 说了算的是最后那一组：同一份 manifest，走我们的解析器和走真 kubectl
 * （`apply --dry-run=client -o json`），结果必须一致。前面的单元测试
 * 只证明「我们以为 YAML 是这样」，那一组才证明「kubectl 也这么认为」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseYaml, parseYamlAll, stringifyYaml, YamlError } from '../../src/lib/opslab/yaml';
import { createVfs } from '../../src/lib/opslab/machine';
import { createCliRuntime, defaultKubeconfig, renderKubeconfig } from '../../src/lib/opslab/wasm';
import { createCluster } from '../../src/lib/opslab/controllers';

describe('标量', () => {
  it('数字、布尔、null 各归各的类型', () => {
    expect(parseYaml('a: 3\nb: true\nc: false\nd: null\ne: ~\nf: 1.5\n')).toEqual({
      a: 3, b: true, c: false, d: null, e: null, f: 1.5,
    });
  });

  it('引号里的东西保持字符串 —— 版本号不加引号会变成小数', () => {
    expect(parseYaml('a: "3"\nb: \'true\'\nc: 1.10\nd: "1.10"\n')).toEqual({
      a: '3', b: 'true', c: 1.1, d: '1.10',
    });
  });

  it('行尾注释去掉，但值里的 # 留着', () => {
    expect(parseYaml('a: nginx  # 用这个\nb: nginx#1\nc: "x # y"\n')).toEqual({
      a: 'nginx', b: 'nginx#1', c: 'x # y',
    });
  });

  it('冒号后面必须有空白才算分隔 —— URL 不会被切开', () => {
    expect(parseYaml('url: https://git.corp.internal/platform/apps\n')).toEqual({
      url: 'https://git.corp.internal/platform/apps',
    });
  });
});

describe('结构', () => {
  it('嵌套映射与列表', () => {
    expect(parseYaml([
      'spec:',
      '  replicas: 2',
      '  template:',
      '    spec:',
      '      containers:',
      '      - name: app',
      '        image: nginx:1.27',
      '        ports:',
      '        - containerPort: 8080',
      '',
    ].join('\n'))).toEqual({
      spec: {
        replicas: 2,
        template: {
          spec: { containers: [{ name: 'app', image: 'nginx:1.27', ports: [{ containerPort: 8080 }] }] },
        },
      },
    });
  });

  it('列表可以和它的键同缩进，也可以多缩进一层', () => {
    const flat = parseYaml('items:\n- a\n- b\n');
    const nested = parseYaml('items:\n  - a\n  - b\n');
    expect(flat).toEqual({ items: ['a', 'b'] });
    expect(nested).toEqual(flat);
  });

  it('流式写法：{} 与 []', () => {
    expect(parseYaml('a: {x: 1, y: two}\nb: [1, 2, "three"]\nc: {}\n')).toEqual({
      a: { x: 1, y: 'two' }, b: [1, 2, 'three'], c: {},
    });
  });

  it('块标量 | 保留换行，> 折成一行', () => {
    const parsed = parseYaml([
      'literal: |',
      '  line one',
      '  line two',
      'folded: >',
      '  line one',
      '  line two',
      'stripped: |-',
      '  no trailing newline',
      '',
    ].join('\n')) as Record<string, string>;
    expect(parsed.literal).toBe('line one\nline two\n');
    expect(parsed.folded).toBe('line one line two\n');
    expect(parsed.stripped).toBe('no trailing newline');
  });

  it('块标量里的 # 不是注释', () => {
    const parsed = parseYaml('script: |\n  # 这是脚本的一部分\n  echo hi\n') as Record<string, string>;
    expect(parsed.script).toBe('# 这是脚本的一部分\necho hi\n');
  });

  it('--- 分开的多份文档，空的丢掉', () => {
    const docs = parseYamlAll('---\nkind: A\n---\n# 只有注释\n---\nkind: B\n');
    expect(docs).toEqual([{ kind: 'A' }, { kind: 'B' }]);
  });

  it('tab 缩进照 YAML 的规矩报错', () => {
    expect(() => parseYaml('a:\n\tb: 1\n')).toThrow(YamlError);
  });
});

describe('序列化', () => {
  it('转回去再解析出来是同一个对象', () => {
    const object = {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'portal', labels: { app: 'portal' } },
      spec: {
        replicas: 2,
        template: { spec: { containers: [{ name: 'app', image: 'nginx:1.27', ports: [{ containerPort: 8080 }] }] } },
      },
    };
    expect(parseYaml(stringifyYaml(object))).toEqual(object);
  });

  it('会被读成别的类型的字符串要加引号', () => {
    const text = stringifyYaml({ version: '1.10', enabled: 'true', empty: '' });
    expect(text).toContain("version: '1.10'");
    expect(text).toContain("enabled: 'true'");
    expect(parseYaml(text)).toEqual({ version: '1.10', enabled: 'true', empty: '' });
  });

  it('同一个对象输出逐字节一致 —— 否则 diff 里全是噪声', () => {
    const object = { a: [1, 2], b: { c: 'd' } };
    expect(stringifyYaml(object)).toBe(stringifyYaml(object));
  });
});

/* ------------------------------------------------------------------ */
/* 和真 kubectl 对答案                                                 */
/* ------------------------------------------------------------------ */

const WASM_PATH = path.join(__dirname, '../../public/opslab/opslab-cli.wasm');
const WASM_EXEC = path.join(__dirname, '../../public/opslab/wasm_exec.js');
const HAS_ARTIFACT = fs.existsSync(WASM_PATH) && fs.existsSync(WASM_EXEC);
const describeIfBuilt = HAS_ARTIFACT ? describe : describe.skip;
const NOW = Date.parse('2026-03-02T09:00:00Z');

const MANIFESTS: Array<[string, string]> = [
  ['最普通的 Deployment', [
    'apiVersion: apps/v1',
    'kind: Deployment',
    'metadata:',
    '  name: portal',
    '  namespace: payments',
    '  labels:',
    '    app: portal',
    'spec:',
    '  replicas: 2',
    '  selector:',
    '    matchLabels:',
    '      app: portal',
    '  template:',
    '    metadata:',
    '      labels:',
    '        app: portal',
    '    spec:',
    '      containers:',
    '      - name: web',
    '        image: harbor.corp.internal/team/portal:1.4.0',
    '        ports:',
    '        - containerPort: 8080',
    '        env:',
    '        - name: TIER',
    '          value: "web"',
    '        - name: REPLICAS',
    '          value: "2"',
    '',
  ].join('\n')],
  ['带注释、引号与流式写法', [
    'apiVersion: v1   # 核心组',
    'kind: ConfigMap',
    'metadata:',
    '  name: settings',
    '  namespace: payments',
    '  annotations: {owner: platform, tier: "1"}',
    'data:',
    '  endpoint: https://portal.corp.internal/api',
    '  version: "1.10"',
    '  retries: "3"',
    '  banner: |',
    '    line one',
    '    line two',
    '',
  ].join('\n')],
  ['NetworkPolicy —— 嵌套列表套映射', [
    'apiVersion: networking.k8s.io/v1',
    'kind: NetworkPolicy',
    'metadata:',
    '  name: ledger',
    '  namespace: payments',
    'spec:',
    '  podSelector:',
    '    matchLabels:',
    '      app: ledger',
    '  policyTypes:',
    '  - Ingress',
    '  - Egress',
    '  ingress:',
    '  - from:',
    '    - podSelector:',
    '        matchLabels:',
    '          app: portal',
    '  egress:',
    '  - to:',
    '    - namespaceSelector:',
    '        matchLabels:',
    '          kubernetes.io/metadata.name: kube-system',
    '    ports:',
    '    - protocol: UDP',
    '      port: 53',
    '',
  ].join('\n')],
];

describeIfBuilt('和真 kubectl 对答案', () => {
  jest.setTimeout(120_000);

  let runtime: ReturnType<typeof createCliRuntime> | null = null;
  function cli() {
    if (!runtime) {
      if (!(globalThis as Record<string, unknown>).Go) createRequire(__filename)(WASM_EXEC);
      runtime = createCliRuntime({ bytes: new Uint8Array(fs.readFileSync(WASM_PATH)), cache: false });
    }
    return runtime;
  }

  it.each(MANIFESTS)('%s', async (_name, manifest) => {
    // 用一个真集群做 discovery —— kubectl 得先能把 kind 映射到资源上
    const cluster = createCluster();
    cluster.start();
    const vfs = createVfs(() => NOW);
    vfs.writeFile('/root/.kube/config', renderKubeconfig(defaultKubeconfig()));
    vfs.writeFile('/root/m.yaml', manifest);
    const result = await cli().run('kubectl', // 校验要向 apiserver 取 OpenAPI，这里没有真集群；关掉它，
      // 我们要的只是 kubectl 自己的 YAML 解析结果
      ['apply', '-f', 'm.yaml', '--dry-run=client', '--validate=false', '-o', 'json'], {
      vfs, cwd: '/root',
      fetch: (url, init) => cluster.apiServer.handle(url, init as never),
      now: () => NOW,
    });
    expect(result.stderr).toBe('');

    const fromKubectl = JSON.parse(result.stdout);
    // kubectl 会补上 apply 的注解与空 status，比对之前去掉
    delete fromKubectl.metadata.annotations?.['kubectl.kubernetes.io/last-applied-configuration'];
    if (fromKubectl.metadata.annotations && Object.keys(fromKubectl.metadata.annotations).length === 0) {
      delete fromKubectl.metadata.annotations;
    }
    delete fromKubectl.metadata.creationTimestamp;
    delete fromKubectl.status;

    expect(parseYaml(manifest)).toEqual(fromKubectl);
  });
});
