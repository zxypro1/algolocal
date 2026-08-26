/**
 * OCI：Dockerfile 解析、真构建、层与 digest、私有仓库与凭据
 *
 * 判定标准还是「跟真 docker 一致」：命令怎么敲、输出长什么样、
 * 报错说了什么、digest 是不是真算出来的。
 */
import { createMachine, Machine } from '../../src/lib/labkit/machine';
import {
  ImageStore, Registry, RegistryNetwork, buildImage, createDockerCommand,
  digestOf, flattenLayers, imageRootfs, normalizeReference, parseDockerfile, parseReference,
  finalizeImage, makeLayer,
} from '../../src/lib/opslab/oci';

const CREATED = '2026-01-01T00:00:00Z';
const NOW = Date.parse('2026-01-01T00:05:00Z');

/** 一个能当 FROM 用的基础镜像 */
function baseImage(reference: string, files: Record<string, string>, config = {}) {
  return finalizeImage({
    config: { Env: ['PATH=/usr/local/bin:/usr/bin:/bin'], Cmd: ['/bin/sh'], ...config },
    layers: [makeLayer(files, [], 'ADD file:base in /')],
    history: [{ created: CREATED, created_by: 'ADD file:base in /' }],
    architecture: 'amd64',
    os: 'linux',
    created: CREATED,
    repoTags: [normalizeReference(reference)],
  });
}

/** 一台装好 docker、连得上私有仓库的机器 */
function dockerMachine(files: Record<string, string>) {
  const store = new ImageStore();
  store.add(baseImage('node:22-alpine', {
    '/bin/sh': '#!/bin/sh\n',
    '/usr/local/bin/node': 'node binary\n',
  }));

  const harbor = new Registry({
    host: 'harbor.corp.internal',
    users: { ci: 'S3cret!' },
    projects: ['team'],
    anonymousPull: false,
  });
  const network = new RegistryNetwork();
  network.add(harbor);

  const machine = createMachine({ files, now: () => NOW });
  machine.install('docker', createDockerCommand({
    store,
    network,
    now: () => NOW,
    toolchains: {
      'docker.io/library/node:22-alpine': {
        // 简化的 npm：真的往 node_modules 写点东西，好让层里看得见
        npm: ({ argv, vfs, cwd }) => {
          if (argv[0] !== 'ci' && argv[0] !== 'install') {
            return { stderr: `Unknown command: "${argv[0]}"\n`, code: 1 };
          }
          if (!vfs.exists(`${cwd}/package.json`)) {
            return { stderr: 'npm error code ENOENT\nnpm error path package.json\n', code: 254 };
          }
          vfs.writeFile(`${cwd}/node_modules/.package-lock.json`, '{}\n');
          vfs.writeFile(`${cwd}/node_modules/express/index.js`, 'module.exports = {}\n');
          return { stdout: 'added 42 packages in 2s\n' };
        },
      },
    },
  }));
  return { machine, store, harbor, network };
}

describe('镜像引用解析', () => {
  it.each([
    ['nginx', 'docker.io/library/nginx:latest'],
    ['nginx:1.27', 'docker.io/library/nginx:1.27'],
    ['bitnami/redis:7', 'docker.io/bitnami/redis:7'],
    ['harbor.corp.internal/team/app:v1', 'harbor.corp.internal/team/app:v1'],
    ['localhost:5000/app', 'localhost:5000/app:latest'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeReference(input)).toBe(expected);
  });

  it('带 digest 的引用', () => {
    const parsed = parseReference('harbor.corp.internal/team/app@sha256:abcd');
    expect(parsed.digest).toBe('sha256:abcd');
    expect(parsed.canonical).toBe('harbor.corp.internal/team/app@sha256:abcd');
  });
});

describe('Dockerfile 解析', () => {
  it('续行、注释、多阶段、flag', () => {
    const parsed = parseDockerfile([
      '# 构建阶段',
      'ARG NODE_VERSION=22',
      'FROM node:${NODE_VERSION}-alpine AS builder',
      'WORKDIR /app',
      'RUN npm ci \\',
      '    --omit=dev',
      '',
      'FROM node:${NODE_VERSION}-alpine',
      'COPY --from=builder /app/node_modules /app/node_modules',
      'CMD ["node", "server.js"]',
    ].join('\n'));

    expect(parsed.globalArgs).toHaveLength(1);
    expect(parsed.stages).toHaveLength(2);
    expect(parsed.stages[0].name).toBe('builder');
    expect(parsed.stages[0].instructions[1].args).toBe('npm ci     --omit=dev');
    expect(parsed.stages[1].instructions[0].flags.from).toBe('builder');
  });

  it('不认识的指令报错，行号对得上', () => {
    expect(() => parseDockerfile('FROM alpine\nRUNN echo hi\n')).toThrow(
      'dockerfile parse error on line 2: unknown instruction: RUNN'
    );
  });

  it('第一条不是 FROM 也要报错', () => {
    expect(() => parseDockerfile('WORKDIR /app\n')).toThrow(/no build stage in current context/);
  });
});

describe('docker build', () => {
  const DOCKERFILE = [
    'FROM node:22-alpine',
    'WORKDIR /app',
    'COPY package.json ./',
    'RUN npm ci --omit=dev',
    'COPY server.js ./',
    'ENV NODE_ENV=production',
    'EXPOSE 8080',
    'USER 10001',
    'CMD ["node", "server.js"]',
  ].join('\n');

  const CONTEXT = {
    '/root/app/Dockerfile': DOCKERFILE,
    '/root/app/package.json': '{"name":"app"}\n',
    '/root/app/server.js': 'require("http")\n',
  };

  it('构建出来的镜像有层、有配置、有真 digest', async () => {
    const { machine, store } = dockerMachine(CONTEXT);
    const result = await machine.exec('docker build -t harbor.corp.internal/team/app:v1 app');
    expect(result.code).toBe(0);

    const image = store.get('harbor.corp.internal/team/app:v1');
    expect(image).toBeDefined();
    expect(image!.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(image!.config.User).toBe('10001');
    expect(image!.config.WorkingDir).toBe('/app');
    expect(image!.config.Cmd).toEqual(['node', 'server.js']);
    expect(image!.config.Env).toContain('NODE_ENV=production');
    expect(image!.config.ExposedPorts).toEqual({ '8080/tcp': {} });
    // 基础层 + COPY package.json + RUN npm ci + COPY server.js
    expect(image!.layers).toHaveLength(4);
    expect(image!.layers.every((layer) => /^sha256:[0-9a-f]{64}$/.test(layer.digest))).toBe(true);
  });

  it('RUN 真的跑了 —— node_modules 出现在它自己那一层里', async () => {
    const { machine, store } = dockerMachine(CONTEXT);
    await machine.exec('docker build -t app:v1 app');
    const image = store.get('app:v1')!;
    const runLayer = image.layers.find((layer) => layer.createdBy.includes('npm ci'))!;
    expect(Object.keys(runLayer.files)).toContain('/app/node_modules/express/index.js');
    expect(imageRootfs(image)['/app/server.js']).toBe('require("http")\n');
  });

  it('构建日志是 BuildKit 那个样子', async () => {
    const { machine } = dockerMachine(CONTEXT);
    const result = await machine.exec('docker build -t app:v1 app');
    expect(result.stdout).toContain('#1 [internal] load build definition from Dockerfile');
    expect(result.stdout).toContain('[3/3] COPY server.js ./');
    expect(result.stdout).toMatch(/added 42 packages in 2s/);
    expect(result.stdout).toMatch(/writing image sha256:[0-9a-f]{64} done/);
    expect(result.stdout).toContain('naming to docker.io/library/app:v1 done');
  });

  it('RUN 失败时构建失败，报错文本跟 BuildKit 一致', async () => {
    const { machine } = dockerMachine({
      '/root/app/Dockerfile': 'FROM node:22-alpine\nWORKDIR /app\nRUN npm ci\n',
    });
    const result = await machine.exec('docker build -t app:v1 app');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('npm error code ENOENT');
    expect(result.stderr).toMatch(
      /ERROR: failed to solve: process "\/bin\/sh -c npm ci" did not complete successfully: exit code: 254/
    );
  });

  it('同一份上下文构建两次，镜像 ID 一模一样', async () => {
    const first = dockerMachine(CONTEXT);
    const second = dockerMachine(CONTEXT);
    await first.machine.exec('docker build -t app:v1 app');
    await second.machine.exec('docker build -t app:v1 app');
    expect(first.store.get('app:v1')!.id).toBe(second.store.get('app:v1')!.id);
  });

  it('改一个字节，镜像 ID 就变 —— digest 是真算的', async () => {
    const first = dockerMachine(CONTEXT);
    const second = dockerMachine({ ...CONTEXT, '/root/app/server.js': 'require("http") // v2\n' });
    await first.machine.exec('docker build -t app:v1 app');
    await second.machine.exec('docker build -t app:v1 app');
    expect(first.store.get('app:v1')!.id).not.toBe(second.store.get('app:v1')!.id);
  });

  it('多阶段构建：产物层来自 builder，工具链留在 builder 里', async () => {
    const { machine, store } = dockerMachine({
      '/root/app/Dockerfile': [
        'FROM node:22-alpine AS builder',
        'WORKDIR /app',
        'COPY package.json ./',
        'RUN npm ci',
        'FROM node:22-alpine',
        'WORKDIR /srv',
        'COPY --from=builder /app/node_modules /srv/node_modules',
        'USER 10001',
        'CMD ["node", "index.js"]',
      ].join('\n'),
      '/root/app/package.json': '{"name":"app"}\n',
    });
    const result = await machine.exec('docker build -t app:slim app');
    expect(result.code).toBe(0);

    const rootfs = imageRootfs(store.get('app:slim')!);
    expect(rootfs['/srv/node_modules/express/index.js']).toBe('module.exports = {}\n');
    // builder 阶段的 /app 不该出现在最终镜像里
    expect(Object.keys(rootfs).some((path) => path.startsWith('/app/'))).toBe(false);
  });

  it('把密钥 COPY 进去再 rm 掉，层里还是查得到', async () => {
    const { machine, store } = dockerMachine({
      '/root/app/Dockerfile': [
        'FROM node:22-alpine',
        'WORKDIR /app',
        'COPY .npmrc ./',
        'RUN rm -f .npmrc',
      ].join('\n'),
      '/root/app/.npmrc': '//registry:_authToken=super-secret\n',
    });
    await machine.exec('docker build -t app:leaky app');
    const image = store.get('app:leaky')!;

    // 最终 rootfs 里没有 —— 看起来很干净
    expect(imageRootfs(image)['/app/.npmrc']).toBeUndefined();
    // 但历史层里还在，这正是第 3 关要考的点
    const leaked = image.layers.some((layer) =>
      Object.values(layer.files).some((content) => content.includes('super-secret'))
    );
    expect(leaked).toBe(true);
  });

  it('.dockerignore 里的东西不进上下文', async () => {
    const { machine, store } = dockerMachine({
      '/root/app/Dockerfile': 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\n',
      '/root/app/index.js': 'ok\n',
      '/root/app/.env': 'SECRET=1\n',
      '/root/app/.dockerignore': '.env\nnode_modules\n',
    });
    await machine.exec('docker build -t app:clean app');
    const rootfs = imageRootfs(store.get('app:clean')!);
    expect(rootfs['/app/index.js']).toBe('ok\n');
    expect(rootfs['/app/.env']).toBeUndefined();
  });

  it('--build-arg 与 --target', async () => {
    const { machine, store } = dockerMachine({
      '/root/app/Dockerfile': [
        'ARG TAG=22-alpine',
        'FROM node:${TAG} AS builder',
        'ARG APP_VERSION=dev',
        'LABEL version=$APP_VERSION',
        'FROM node:${TAG}',
        'LABEL stage=final',
      ].join('\n'),
    });
    const result = await machine.exec('docker build --build-arg APP_VERSION=1.4.0 --target builder -t app:b app');
    expect(result.code).toBe(0);
    expect(store.get('app:b')!.config.Labels).toEqual({ version: '1.4.0' });
  });

  it('找不到 Dockerfile 的报错', async () => {
    const { machine } = dockerMachine({ '/root/app/keep': '' });
    const result = await machine.exec('docker build -t app:v1 app');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('failed to read dockerfile');
  });
});

describe('私有仓库', () => {
  const CONTEXT = {
    '/root/app/Dockerfile': 'FROM node:22-alpine\nWORKDIR /app\nCOPY index.js ./\n',
    '/root/app/index.js': 'ok\n',
  };

  it('没登录推不上去', async () => {
    const { machine } = dockerMachine(CONTEXT);
    await machine.exec('docker build -t harbor.corp.internal/team/app:v1 app');
    const result = await machine.exec('docker push harbor.corp.internal/team/app:v1');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unauthorized: authentication required');
  });

  it('密码错了报 401', async () => {
    const { machine } = dockerMachine(CONTEXT);
    const result = await machine.exec('docker login harbor.corp.internal -u ci -p wrong');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('401 Unauthorized');
  });

  it('登录之后能推能拉，凭据落在 ~/.docker/config.json', async () => {
    const { machine, harbor } = dockerMachine(CONTEXT);
    const loggedIn = await machine.exec('docker login harbor.corp.internal -u ci -p "S3cret!"');
    expect(loggedIn.stdout).toContain('Login Succeeded');
    expect(loggedIn.stdout).toContain('WARNING! Using --password via the CLI is insecure.');

    const config = JSON.parse(machine.vfs.readFile('/root/.docker/config.json'));
    expect(atob(config.auths['harbor.corp.internal'].auth)).toBe('ci:S3cret!');

    await machine.exec('docker build -t harbor.corp.internal/team/app:v1 app');
    const pushed = await machine.exec('docker push harbor.corp.internal/team/app:v1');
    expect(pushed.code).toBe(0);
    expect(pushed.stdout).toContain('The push refers to repository [harbor.corp.internal/team/app]');
    expect(pushed.stdout).toMatch(/v1: digest: sha256:[0-9a-f]{64} size: \d+/);
    expect(harbor.listTags('team/app')).toEqual(['v1']);
  });

  it('COPY 单个文件到不带斜杠的目标会改名，目录来源保留层级', async () => {
    const { machine, store } = dockerMachine({
      '/root/app/Dockerfile': [
        'FROM node:22-alpine',
        'COPY index.js /srv/server.js',
        'COPY assets /srv/assets',
      ].join('\n'),
      '/root/app/index.js': 'ok\n',
      '/root/app/assets/css/site.css': 'body{}\n',
      '/root/app/assets/logo.svg': '<svg/>\n',
    });
    expect((await machine.exec('docker build -t app:copy app')).code).toBe(0);
    const rootfs = imageRootfs(store.get('app:copy')!);
    expect(rootfs['/srv/server.js']).toBe('ok\n');
    expect(rootfs['/srv/assets/css/site.css']).toBe('body{}\n');
    expect(rootfs['/srv/assets/logo.svg']).toBe('<svg/>\n');
  });

  it('登录了但推到没权限的项目，报的是 denied 不是 unauthorized', async () => {
    const { machine } = dockerMachine(CONTEXT);
    await machine.exec('docker login harbor.corp.internal -u ci -p "S3cret!"');
    await machine.exec('docker build -t harbor.corp.internal/other/app:v1 app');
    const result = await machine.exec('docker push harbor.corp.internal/other/app:v1');
    expect(result.stderr).toContain('denied: requested access to the resource is denied');
  });

  it('push -a 把同一个仓库的所有 tag 都推上去', async () => {
    const { machine, harbor } = dockerMachine(CONTEXT);
    await machine.exec('docker login harbor.corp.internal -u ci -p "S3cret!"');
    await machine.exec('docker build -t harbor.corp.internal/team/app:v1 app');
    await machine.exec('docker tag harbor.corp.internal/team/app:v1 harbor.corp.internal/team/app:latest');
    const pushed = await machine.exec('docker push -a harbor.corp.internal/team/app:v1');
    expect(pushed.code).toBe(0);
    expect(harbor.listTags('team/app')).toEqual(['latest', 'v1']);
  });

  it('解析不了的主机名报 DNS 错误', async () => {
    const { machine } = dockerMachine(CONTEXT);
    await machine.exec('docker build -t registry.invalid/team/app:v1 app');
    const result = await machine.exec('docker push registry.invalid/team/app:v1');
    expect(result.stderr).toContain('dial tcp: lookup registry.invalid: no such host');
  });

  it('tag 不存在报 manifest unknown', async () => {
    const { machine } = dockerMachine(CONTEXT);
    await machine.exec('docker login harbor.corp.internal -u ci -p "S3cret!"');
    await machine.exec('docker build -t harbor.corp.internal/team/app:v1 app');
    await machine.exec('docker push harbor.corp.internal/team/app:v1');
    const result = await machine.exec('docker pull harbor.corp.internal/team/app:v9');
    expect(result.stderr).toContain('manifest unknown');
  });

  it('推上去再从另一台机器拉下来，内容一致', async () => {
    const first = dockerMachine(CONTEXT);
    await first.machine.exec('docker login harbor.corp.internal -u ci -p "S3cret!"');
    await first.machine.exec('docker build -t harbor.corp.internal/team/app:v1 app');
    await first.machine.exec('docker push harbor.corp.internal/team/app:v1');

    const second = createMachine({ now: () => NOW });
    const store = new ImageStore();
    second.install('docker', createDockerCommand({ store, network: first.network, now: () => NOW }));
    await second.exec('docker login harbor.corp.internal -u ci -p "S3cret!"');
    const pulled = await second.exec('docker pull harbor.corp.internal/team/app:v1');

    expect(pulled.code).toBe(0);
    expect(pulled.stdout).toContain('Status: Downloaded newer image for harbor.corp.internal/team/app:v1');
    expect(store.get('harbor.corp.internal/team/app:v1')!.id)
      .toBe(first.store.get('harbor.corp.internal/team/app:v1')!.id);
  });
});

describe('docker 的其它子命令', () => {
  const CONTEXT = {
    '/root/app/Dockerfile': 'FROM node:22-alpine\nWORKDIR /app\nCOPY index.js ./\nCMD ["node","index.js"]\n',
    '/root/app/index.js': 'ok\n',
  };

  it('images 的表头与列', async () => {
    const { machine } = dockerMachine(CONTEXT);
    await machine.exec('docker build -t harbor.corp.internal/team/app:v1 app');
    const result = await machine.exec('docker images');
    expect(result.stdout.split('\n')[0]).toBe('REPOSITORY                      TAG         IMAGE ID       CREATED         SIZE');
    expect(result.stdout).toContain('harbor.corp.internal/team/app');
    expect(result.stdout).toContain('5 minutes ago');
    // 短名字不显示 docker.io/library/ 前缀
    expect(result.stdout).toContain('node ');
  });

  it('tag / rmi', async () => {
    const { machine } = dockerMachine(CONTEXT);
    await machine.exec('docker build -t app:v1 app');
    await machine.exec('docker tag app:v1 app:latest');
    expect((await machine.exec('docker images')).stdout).toContain('latest');
    const removed = await machine.exec('docker rmi app:latest');
    expect(removed.stdout).toContain('Untagged: docker.io/library/app:latest');
  });

  it('inspect 打的是 OCI 的字段名', async () => {
    const { machine } = dockerMachine(CONTEXT);
    await machine.exec('docker build -t app:v1 app');
    const parsed = JSON.parse((await machine.exec('docker inspect app:v1')).stdout);
    expect(parsed[0].Config.Cmd).toEqual(['node', 'index.js']);
    expect(parsed[0].Config.WorkingDir).toBe('/app');
    expect(parsed[0].RootFS.Type).toBe('layers');
    expect(parsed[0].Id).toMatch(/^sha256:/);
  });

  it('history 反着列，元数据指令没有层', async () => {
    const { machine } = dockerMachine(CONTEXT);
    await machine.exec('docker build -t app:v1 app');
    const lines = (await machine.exec('docker history app:v1')).stdout.trim().split('\n');
    expect(lines[0]).toMatch(/^IMAGE\s+CREATED\s+CREATED BY\s+SIZE$/);
    expect(lines[1]).toContain('#(nop) CMD ["node","index.js"]');
    expect(lines[1]).toContain('<missing>');
  });

  it('不认识的子命令', async () => {
    const { machine } = dockerMachine(CONTEXT);
    const result = await machine.exec('docker compose up');
    expect(result.code).toBe(125);
    expect(result.stderr).toContain("docker: 'compose' is not a docker command.");
  });
});

describe('层与摘要', () => {
  it('层的 digest 只由内容决定，与顺序无关', () => {
    const a = makeLayer({ '/b': '2', '/a': '1' }, [], 'x');
    const b = makeLayer({ '/a': '1', '/b': '2' }, [], 'y');
    expect(a.digest).toBe(b.digest);
  });

  it('删除会在叠加时生效，连子树一起', () => {
    const rootfs = flattenLayers([
      makeLayer({ '/app/a': '1', '/app/deep/b': '2', '/keep': '3' }, [], 'add'),
      makeLayer({}, ['/app'], 'remove'),
    ]);
    expect(rootfs).toEqual({ '/keep': '3' });
  });

  it('digestOf 带 sha256: 前缀', () => {
    expect(digestOf('abc')).toBe('sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('buildImage 可以脱离 CLI 直接调用（出题脚本要用）', async () => {
    const machine: Machine = createMachine({
      files: { '/ctx/Dockerfile': 'FROM scratch\nCOPY a.txt /a.txt\n', '/ctx/a.txt': 'hello\n' },
    });
    const store = new ImageStore();
    const outcome = await buildImage({
      context: machine.vfs,
      contextRoot: '/ctx',
      tags: ['demo:1'],
      store,
      created: CREATED,
    });
    expect(outcome.code).toBe(0);
    expect(imageRootfs(outcome.image!)).toEqual({ '/a.txt': 'hello\n' });
  });
});
