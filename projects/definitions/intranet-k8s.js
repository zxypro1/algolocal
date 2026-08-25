/**
 * 内网设施实战：接手一家公司的 Kubernetes 内网
 *
 * 和其它工程实战不同，这个项目的工作台是 ops 形态：终端 + IDE + 拓扑 + 任务。
 * 学员敲的是真 kubectl / helm / docker，打到内存里的 apiserver 上，
 * 控制器在虚拟时钟上把 Pod 真的调度起来。
 *
 * 世界（这家公司的内网长什么样）写在 workspace.world 上，全项目共用；
 * 每一关只写自己的增量。
 */
const { t, code, spec } = require('./_helpers');

/* ------------------------------------------------------------------ */
/* 这家公司的内网                                                      */
/* ------------------------------------------------------------------ */

const PORTAL_IMAGE = 'harbor.corp.internal/team/portal:1.4.0';

/**
 * 跳板机上那份 kubeconfig。
 *
 * 三个 context，current-context 指着一个**已经下线**的老集群 —— 交接时
 * 最常见的现场就是这样：文件还在，人已经走了。
 */
const KUBECONFIG = code`
  apiVersion: v1
  kind: Config
  clusters:
  - name: corp-legacy
    cluster:
      server: https://apiserver.legacy.corp.internal:6443
      insecure-skip-tls-verify: true
  - name: corp-prod
    cluster:
      server: https://apiserver.opslab:6443
      insecure-skip-tls-verify: true
  - name: corp-staging
    cluster:
      server: https://apiserver.staging.corp.internal:6443
      insecure-skip-tls-verify: true
  contexts:
  - name: legacy
    context:
      cluster: corp-legacy
      user: ops
      namespace: default
  - name: prod
    context:
      cluster: corp-prod
      user: ops
      namespace: payments
  - name: staging
    context:
      cluster: corp-staging
      user: ops
      namespace: default
  current-context: legacy
  users:
  - name: ops
    user:
      token: opslab-token
`;

const HANDOVER = code`
  # 交接说明（前任留下的）

  集群是 v1.36，三台节点，都在机房 A。
  跳板机上的 kubeconfig 里有三套环境，生产那套的名字我忘了，你自己看一下。
  legacy 那套上个月已经下线，别去连它。

  第一件事：确认三台节点都是 Ready，把结果记到 handover/nodes.txt 里。
`;

const WORLD = {
  seed: 1,
  startTime: '2026-03-02T09:00:00Z',
  nodes: [
    { name: 'node-a1', cpu: '4', memory: '8Gi', labels: { 'topology.kubernetes.io/zone': 'a' } },
    { name: 'node-a2', cpu: '4', memory: '8Gi', labels: { 'topology.kubernetes.io/zone': 'a' } },
    { name: 'node-b1', cpu: '4', memory: '8Gi', labels: { 'topology.kubernetes.io/zone': 'b' } },
  ],
  namespaces: ['default', 'kube-system', 'payments'],
  images: {
    [PORTAL_IMAGE]: {
      pullMs: 400, startupMs: 600, readyAfterMs: 300,
      // 这个镜像真正在做的事：听 8080，健康检查在 /healthz，常驻 180Mi
      listens: [8080],
      routes: { '/': 200, '/healthz': 200, '/readyz': 200 },
      memoryUsage: '180Mi',
      handlesSigterm: true,
      runAsUser: 10001,
    },
  },
  // 本地已经有的基础镜像，写 Dockerfile 时 FROM 得着
  baseImages: { 'node:22-alpine': 'node' },
  registries: [
    {
      host: 'harbor.corp.internal',
      users: { ci: 'Harbor@2026' },
      projects: ['team', 'library'],
      anonymousPull: false,
    },
  ],
  // 只有生产那套解析得到；legacy 与 staging 会像真的 DNS 失败一样连不上
  endpoints: ['apiserver.opslab'],
  machine: {
    hostname: 'jump-01',
    user: 'root',
    cwd: '/root',
    files: {
      '/root/.kube/config': KUBECONFIG,
      '/root/HANDOVER.md': HANDOVER,
    },
  },
};

/* ------------------------------------------------------------------ */
/* 第 1 关                                                             */
/* ------------------------------------------------------------------ */

const stage1 = {
  id: 'take-over-cluster',
  title: t('接手集群', 'Take over the cluster'),
  goal: t(
    code`
      前任把跳板机的账号给你就走了。终端里已经登好了，\`~/.kube/config\` 也在，
      但 \`current-context\` 指着一套**上个月就下线**的老集群 —— 敲什么都连不上。

      先把自己接进生产集群，再确认它是好的。

      ## 通关标准

      1. \`kubectl config get-contexts\` 看清楚有哪几套环境，把 current-context
         切到生产那一套（提示：\`HANDOVER.md\` 里说了怎么分辨）；
      2. 三台节点都是 \`Ready\`；
      3. 把 \`kubectl get nodes -o wide\` 的输出存到 \`~/handover/nodes.txt\`。

      ## 会用到的命令

      \`\`\`bash
      cat HANDOVER.md
      kubectl config get-contexts
      kubectl config use-context <name>
      kubectl get nodes -o wide
      mkdir -p handover && kubectl get nodes -o wide > handover/nodes.txt
      \`\`\`
    `,
    code`
      Your predecessor handed you the jump host and left. The terminal is already
      logged in and \`~/.kube/config\` is there, but \`current-context\` points at a
      cluster that was **decommissioned last month** — every command times out.

      Get yourself into the production cluster, then confirm it is healthy.

      ## Done when

      1. \`kubectl config get-contexts\` shows the environments and current-context
         is switched to production (\`HANDOVER.md\` says how to tell them apart);
      2. all three nodes report \`Ready\`;
      3. the output of \`kubectl get nodes -o wide\` is saved to \`~/handover/nodes.txt\`.

      ## Commands you will need

      \`\`\`bash
      cat HANDOVER.md
      kubectl config get-contexts
      kubectl config use-context <name>
      kubectl get nodes -o wide
      mkdir -p handover && kubectl get nodes -o wide > handover/nodes.txt
      \`\`\`
    `
  ),
  checklist: [
    t('current-context 指向生产集群', 'current-context points at production'),
    t('三台节点都是 Ready', 'All three nodes are Ready'),
    t('handover/nodes.txt 里有三台节点', 'handover/nodes.txt lists all three nodes'),
  ],
  hints: [
    t(
      '`kubectl config get-contexts` 会把三套环境列出来，带星号的是当前那套。',
      '`kubectl config get-contexts` lists all three; the starred one is current.'
    ),
    t(
      '连不上的时候 kubectl 报的是 `Unable to connect to the server` —— 这说明 server 地址解析不到，不是权限问题。',
      'When it cannot connect kubectl says `Unable to connect to the server` — that is name resolution, not permissions.'
    ),
    t(
      '`kubectl get nodes -o wide > handover/nodes.txt` 之前记得 `mkdir -p handover`。',
      'Run `mkdir -p handover` before redirecting into `handover/nodes.txt`.'
    ),
  ],
  pitfalls: [
    t(
      '直接 `kubectl config use-context prod` 之前先确认名字 —— 三个 context 的名字不是 legacy/prod/staging 就是集群名，猜错了照样连不上。',
      'Confirm the context name before switching — guessing wrong leaves you on an unreachable cluster.'
    ),
    t(
      '`kubectl get nodes` 报 `Unable to connect to the server` 时，去改 kubeconfig 里的 server 地址是错的方向：生产那套地址本来就是对的，你只是没切过去。',
      'When you see `Unable to connect to the server`, editing the server URL is the wrong move: production’s URL is already correct, you simply are not on it.'
    ),
  ],
  ops: {
    // 参考解：反向验证跑这串命令，跑完隐藏用例必须全绿；不跑必须挂
    referenceCommands: [
      'kubectl config use-context prod',
      'mkdir -p /root/handover',
      'kubectl get nodes -o wide > /root/handover/nodes.txt',
    ],
  },
  specs: [
    spec('take-over.spec.ts', code`
      import { sh, list, readFile, exists } from '@ops/lab';

      describe('接手集群', () => {
        it('current-context 切到了生产集群', async () => {
          const result = await sh('kubectl config current-context');
          expect(result.code).toBe(0);
          expect(result.stdout.trim()).toBe('prod');
        });

        it('三台节点都是 Ready', () => {
          const nodes = list('Node');
          expect(nodes.length).toBe(3);
          for (const node of nodes) {
            const ready = (node.status.conditions || []).find((c) => c.type === 'Ready');
            expect(ready && ready.status).toBe('True');
          }
        });

        it('handover/nodes.txt 里记着这三台', () => {
          expect(exists('/root/handover/nodes.txt')).toBe(true);
          const text = readFile('/root/handover/nodes.txt') || '';
          for (const name of ['node-a1', 'node-a2', 'node-b1']) {
            expect(text.includes(name)).toBe(true);
          }
        });
      });
    `),
  ],
  focus: ['correctness'],
  extension: t(
    code`
      真实世界里「接手一个集群」第一件事就是搞清楚自己连的是哪一套。
      \`kubectl config get-contexts\` 之外，值得养成的习惯是把当前 context
      放进 shell 提示符（kube-ps1、starship 都支持）——
      **在生产集群上敲了本该在测试环境跑的命令**，是这一行里最常见的事故类型。
    `,
    code`
      In the real world the first thing you do with an inherited cluster is
      work out which one you are actually talking to. Beyond
      \`kubectl config get-contexts\`, it is worth putting the current context in
      your shell prompt (kube-ps1, starship). **Running a staging command against
      production** is one of the most common incidents in this line of work.
    `
  ),
};

/**
 * 每一关开局时，前面几关的结果已经在了。
 *
 * 第 1 关教的是「先搞清楚自己连的是哪套集群」，之后的关卡不该再考一遍，
 * 所以从第 2 关起 context 已经切好。
 */
const PREVIOUS_STAGES = ['kubectl config use-context prod'];

/* ------------------------------------------------------------------ */
/* 第 2 关                                                             */
/* ------------------------------------------------------------------ */

const PORTAL_MANIFEST = code`
  apiVersion: apps/v1
  kind: Deployment
  metadata:
    name: portal
    namespace: payments
    labels:
      app: portal
  spec:
    replicas: 3
    selector:
      matchLabels:
        app: portal
    template:
      metadata:
        labels:
          app: portal
      spec:
        containers:
        - name: web
          image: ${PORTAL_IMAGE}
          ports:
          - containerPort: 8080
  ---
  apiVersion: v1
  kind: Service
  metadata:
    name: portal
    namespace: payments
  spec:
    selector:
      app: protal
    ports:
    - port: 80
      targetPort: 8080
`;

const stage2 = {
  id: 'first-workload',
  title: t('第一个工作负载', 'The first workload'),
  goal: t(
    code`
      前任在 \`infra/portal.yaml\` 里留了门户的部署清单，但从来没 apply 过。
      你的活儿是把它跑起来，并且**确认它真的能被访问到**。

      注意：三个副本 Running 不等于服务可用。Service 靠 \`selector\` 找 Pod，
      找不到就是一个指向空气的入口，而这件事在 \`kubectl get svc\` 里
      **完全看不出来**，它照样有 ClusterIP。

      ## 通关标准

      1. \`portal\` 这个 Deployment 三个副本全部 Ready；
      2. \`portal\` 这个 Service 的 Endpoints 里有三个地址；
      3. 修的是 \`infra/portal.yaml\` 这个文件，不是只在集群里改一把
         （下一关开始一切以文件为准）。

      ## 会用到的命令

      \`\`\`bash
      kubectl apply -f infra/portal.yaml
      kubectl get deploy,svc,endpoints -n payments
      kubectl get pods -n payments --show-labels
      kubectl describe svc portal -n payments
      \`\`\`
    `,
    code`
      Your predecessor left the portal manifest in \`infra/portal.yaml\` but never
      applied it. Your job is to bring it up and **confirm it can actually be reached**.

      Note: three Running replicas do not mean the service works. A Service finds
      pods through its \`selector\`; if it matches nothing you have an entrypoint
      pointing at thin air, and \`kubectl get svc\` **will not show it**. The
      ClusterIP is there either way.

      ## Done when

      1. the \`portal\` Deployment has three ready replicas;
      2. the \`portal\` Service has three endpoint addresses;
      3. you fixed \`infra/portal.yaml\` itself, not just the live object
         (from the next stage on, the file is the source of truth).

      ## Commands you will need

      \`\`\`bash
      kubectl apply -f infra/portal.yaml
      kubectl get deploy,svc,endpoints -n payments
      kubectl get pods -n payments --show-labels
      kubectl describe svc portal -n payments
      \`\`\`
    `
  ),
  checklist: [
    t('Deployment 三个副本 Ready', 'Deployment has three ready replicas'),
    t('Service 的 Endpoints 里有三个地址', 'The Service has three endpoints'),
    t('改的是文件，不是只改集群', 'The manifest file is fixed, not only the live object'),
  ],
  hints: [
    t(
      '\`kubectl get endpoints portal -n payments\` 如果显示 \`<none>\`，说明 selector 没匹配上任何 Pod。',
      'If \`kubectl get endpoints portal -n payments\` shows \`<none>\`, the selector matches no pods.'
    ),
    t(
      '把 \`kubectl get pods --show-labels\` 的输出和 Service 的 selector 逐字比一遍。',
      'Compare \`kubectl get pods --show-labels\` against the Service selector, character by character.'
    ),
  ],
  pitfalls: [
    t(
      '用 \`kubectl edit svc\` 改完就走：集群是好了，但文件还是错的，下一次 apply 又会把它改回去。',
      'Fixing it with \`kubectl edit svc\` leaves the file wrong, and the next apply undoes your fix.'
    ),
    t(
      'Deployment 的 \`spec.selector.matchLabels\` 和 Service 的 \`spec.selector\` 是两件不同的事，前者对了不代表后者也对。',
      'A Deployment\`s \`spec.selector.matchLabels\` and a Service\`s \`spec.selector\` are different things; getting one right says nothing about the other.'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    files: { '/root/infra/portal.yaml': PORTAL_MANIFEST },
    referenceCommands: [
      'sed -i s/protal/portal/ /root/infra/portal.yaml',
      'kubectl apply -f /root/infra/portal.yaml',
    ],
  },
  specs: [
    spec('first-workload.spec.ts', code`
      import { get, readFile } from '@ops/lab';

      describe('第一个工作负载', () => {
        it('Deployment 三个副本都 Ready', () => {
          const deployment = get('Deployment', 'portal', 'payments');
          expect(deployment).toBeTruthy();
          expect(deployment.status.readyReplicas).toBe(3);
        });

        it('Service 建出来了，端口对得上', () => {
          const service = get('Service', 'portal', 'payments');
          expect(service).toBeTruthy();
          expect(service.spec.ports[0].port).toBe(80);
          expect(service.spec.ports[0].targetPort).toBe(8080);
        });

        it('Endpoints 里有三个地址，说明 selector 真的匹配上了', () => {
          const endpoints = get('Endpoints', 'portal', 'payments');
          expect(endpoints).toBeTruthy();
          const addresses = (endpoints.subsets || []).flatMap((s) => s.addresses || []);
          expect(addresses.length).toBe(3);
        });

        it('文件里的 selector 也改对了，不是只在集群里改了一把', () => {
          const manifest = readFile('/root/infra/portal.yaml') || '';
          expect(manifest.includes('protal')).toBe(false);
        });
      });
    `),
  ],
  focus: ['correctness'],
  extension: t(
    code`
      「Pod 都在跑但服务不通」在生产里的第一诊断动作永远是
      \`kubectl get endpoints <svc>\`：它把「Service 认不认这些 Pod」这个问题
      从「网络通不通」里摘出来。Endpoints 为空是标签问题，Endpoints 有地址
      但访问不通才轮到网络策略、探针、端口。
    `,
    code`
      When pods are running but the service is unreachable, the first diagnostic in
      production is always \`kubectl get endpoints <svc>\`. It separates "does the
      Service recognise these pods" from "is the network working". Empty endpoints
      is a label problem; endpoints present but unreachable is when network policy,
      probes, and ports become suspects.
    `
  ),
};

/* ------------------------------------------------------------------ */
/* 第 3 关                                                             */
/* ------------------------------------------------------------------ */

const APP_SERVER = code`
  const http = require('http');

  const port = Number(process.env.PORT || 8080);
  const server = http.createServer((request, response) => {
    if (request.url === '/healthz' || request.url === '/readyz') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('portal');
  });

  server.listen(port);

  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
  });
`;

const APP_PACKAGE = code`
  {
    "name": "portal",
    "version": "1.5.0",
    "private": true,
    "main": "server.js",
    "scripts": { "start": "node server.js" },
    "dependencies": { "express": "^5.1.0" }
  }
`;

const NPMRC = code`
  //harbor.corp.internal/repository/npm/:_authToken=npm_9f3aQ2mKpL0xVt7RwEeYbN
  registry=https://harbor.corp.internal/repository/npm/
`;

const STARTER_DOCKERFILE = code`
  # 前任写的。能 build 出来，但有三个问题，你自己找。
  FROM node:22-alpine
  COPY . /app
  WORKDIR /app
  RUN npm install
  CMD npm start
`;

const REFERENCE_DOCKERFILE = code`
  FROM node:22-alpine AS deps
  WORKDIR /app
  COPY package.json package-lock.json ./
  RUN npm ci --omit=dev

  FROM node:22-alpine
  WORKDIR /app
  ENV NODE_ENV=production
  COPY --from=deps /app/node_modules /app/node_modules
  COPY server.js package.json ./
  EXPOSE 8080
  USER 10001
  CMD ["node", "server.js"]
`;

const REFERENCE_DOCKERIGNORE = code`
  .npmrc
  node_modules
  .git
`;

const stage3 = {
  id: 'containerize',
  title: t('把应用容器化', 'Containerise the application'),
  goal: t(
    code`
      门户的源码在 \`~/app\`。前任写过一个 Dockerfile，能 build 出来，
      但有三个问题。其中一个是**安全问题**：build 日志里看不出来，
      \`docker run\` 也看不出来，只有翻镜像层才发现。

      把它改好，build 成 \`harbor.corp.internal/team/portal:1.5.0\` 并推上去。

      ## 通关标准

      1. 镜像 build 出来了，tag 是 \`harbor.corp.internal/team/portal:1.5.0\`；
      2. **不以 root 运行**（\`USER\` 写了一个非 0 的 uid）；
      3. 声明了 \`EXPOSE 8080\`，\`CMD\` 用 exec form
         （\`["node","server.js"]\` 而不是 \`node server.js\`）；
      4. \`~/app/.npmrc\` 里那个 npm token **不在任何一层里**。
         注意「最终文件系统里没有」不等于「层里没有」；
      5. 推到了 Harbor（凭据：用户 \`ci\`，密码 \`Harbor@2026\`）。

      ## 会用到的命令

      \`\`\`bash
      cat app/Dockerfile app/.npmrc
      docker login harbor.corp.internal -u ci -p 'Harbor@2026'
      docker build -t harbor.corp.internal/team/portal:1.5.0 app
      docker history harbor.corp.internal/team/portal:1.5.0
      docker inspect harbor.corp.internal/team/portal:1.5.0
      docker push harbor.corp.internal/team/portal:1.5.0
      \`\`\`
    `,
    code`
      The portal source is in \`~/app\`. Your predecessor wrote a Dockerfile that
      builds, but it has three problems. One of them is a **security problem** that
      the build log will not show you, that \`docker run\` will not show you, and
      that only appears when you look inside the layers.

      Fix it, build \`harbor.corp.internal/team/portal:1.5.0\`, and push it.

      ## Done when

      1. the image is built and tagged \`harbor.corp.internal/team/portal:1.5.0\`;
      2. it **does not run as root** (\`USER\` set to a non-zero uid);
      3. it declares \`EXPOSE 8080\` and uses exec form for \`CMD\`
         (\`["node","server.js"]\`, not \`node server.js\`);
      4. the npm token in \`~/app/.npmrc\` is **in none of the layers**. Note that
         "absent from the final filesystem" is not the same as "absent from the layers";
      5. it is pushed to Harbor (user \`ci\`, password \`Harbor@2026\`).

      ## Commands you will need

      \`\`\`bash
      cat app/Dockerfile app/.npmrc
      docker login harbor.corp.internal -u ci -p 'Harbor@2026'
      docker build -t harbor.corp.internal/team/portal:1.5.0 app
      docker history harbor.corp.internal/team/portal:1.5.0
      docker inspect harbor.corp.internal/team/portal:1.5.0
      docker push harbor.corp.internal/team/portal:1.5.0
      \`\`\`
    `
  ),
  checklist: [
    t('镜像 build 出来并推上 Harbor', 'Image built and pushed to Harbor'),
    t('非 root 运行、EXPOSE 8080、exec form 的 CMD', 'Non-root, EXPOSE 8080, exec-form CMD'),
    t('npm token 不在任何一层里', 'The npm token is in none of the layers'),
  ],
  hints: [
    t(
      '\`docker history\` 一行一层，能看出哪条指令产生了多大的层。',
      '\`docker history\` shows one line per layer and which instruction produced it.'
    ),
    t(
      '\`COPY . /app\` 会把 \`.npmrc\` 一起拷进去。即使后面 \`RUN rm .npmrc\`，那一层里还留着。',
      '\`COPY . /app\` brings \`.npmrc\` along. Even a later \`RUN rm .npmrc\` leaves it in the earlier layer.'
    ),
    t(
      '\`.dockerignore\` 决定哪些文件根本不进构建上下文，这是唯一真正干净的做法。',
      '\`.dockerignore\` decides what never enters the build context. That is the only genuinely clean fix.'
    ),
  ],
  pitfalls: [
    t(
      '\`RUN rm -f .npmrc\` 看起来解决了问题：最终镜像里确实没有这个文件。但 \`docker history\` 里那一层还在，任何人 \`docker save\` 之后都能捞出来。',
      '\`RUN rm -f .npmrc\` looks like a fix: the final image really does not contain the file. But the earlier layer still holds it, and anyone who runs \`docker save\` can recover it.'
    ),
    t(
      '\`CMD npm start\` 是 shell form，进程树里 PID 1 是 \`/bin/sh\`，SIGTERM 不会传给 node，第 6 关会因此挂。',
      '\`CMD npm start\` is shell form: PID 1 becomes \`/bin/sh\` and SIGTERM never reaches node. Stage 6 will fail because of it.'
    ),
    t(
      '先 \`COPY . .\` 再 \`npm ci\`，任何一次源码改动都会让依赖重新装一遍。',
      'Copying everything before \`npm ci\` means any source change reinstalls all dependencies.'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    files: {
      '/root/app/Dockerfile': STARTER_DOCKERFILE,
      '/root/app/server.js': APP_SERVER,
      '/root/app/package.json': APP_PACKAGE,
      '/root/app/package-lock.json': '{"lockfileVersion":3,"name":"portal"}\n',
      '/root/app/.npmrc': NPMRC,
    },
    referenceFiles: {
      '/root/app/Dockerfile': REFERENCE_DOCKERFILE,
      '/root/app/.dockerignore': REFERENCE_DOCKERIGNORE,
    },
    referenceCommands: [
      "docker login harbor.corp.internal -u ci -p 'Harbor@2026'",
      'docker build -t harbor.corp.internal/team/portal:1.5.0 /root/app',
      'docker push harbor.corp.internal/team/portal:1.5.0',
    ],
  },
  specs: [
    spec('containerize.spec.ts', code`
      import { image, layerContents, imageFiles, sh } from '@ops/lab';

      const REFERENCE = 'harbor.corp.internal/team/portal:1.5.0';
      const TOKEN = 'npm_9f3aQ2mKpL0xVt7RwEeYbN';

      describe('把应用容器化', () => {
        it('镜像 build 出来了', () => {
          const built = image(REFERENCE);
          expect(built).toBeTruthy();
          expect(built.layers.length > 1).toBe(true);
        });

        it('不以 root 运行', () => {
          const user = image(REFERENCE).config.User || '';
          expect(user).not.toBe('');
          expect(user).not.toBe('0');
          expect(user).not.toBe('root');
        });

        it('声明了 EXPOSE 8080', () => {
          expect(Object.keys(image(REFERENCE).config.ExposedPorts || {})).toContain('8080/tcp');
        });

        it('CMD 用的是 exec form，否则 PID 1 是 sh，收不到 SIGTERM', () => {
          const config = image(REFERENCE).config;
          const command = config.Entrypoint || config.Cmd || [];
          expect(command.length > 0).toBe(true);
          expect(command[0]).not.toBe('/bin/sh');
        });

        it('npm token 不在最终文件系统里', () => {
          const files = imageFiles(REFERENCE);
          const leaked = Object.values(files).filter((content) => content.includes(TOKEN));
          expect(leaked.length).toBe(0);
        });

        it('npm token 也不在任何一层里，删掉不等于没进去过', () => {
          const leaked = layerContents(REFERENCE).filter((content) => content.includes(TOKEN));
          expect(leaked.length).toBe(0);
        });

        it('推到 Harbor 了', async () => {
          const result = await sh('docker pull ' + REFERENCE);
          expect(result.code).toBe(0);
        });
      });
    `),
  ],
  focus: ['correctness', 'encapsulation'],
  extension: t(
    code`
      「密钥进了镜像层」是容器化里最常见的一类事故，因为它在所有常规检查里都
      隐形：应用跑得好好的，最终文件系统是干净的，只有把镜像层导出来才看得见。
      现实里的对策有三层：\`.dockerignore\` 从源头拦住、多阶段构建让构建期
      产物不进最终镜像、以及 BuildKit 的 \`--mount=type=secret\`（挂载进单条
      RUN，不落层）。前两个这一关都用得上。
    `,
    code`
      "Secret baked into a layer" is one of the most common containerisation
      incidents, precisely because it is invisible to every routine check: the app
      runs fine and the final filesystem is clean. Only exporting the layers reveals
      it. Real defences come in three layers: \`.dockerignore\` keeps it out of the
      build context, multi-stage builds keep build-time artefacts out of the final
      image, and BuildKit\`s \`--mount=type=secret\` mounts a secret into a single
      RUN without ever creating a layer. The first two apply directly here.
    `
  ),
};

module.exports = {
  id: 'intranet-k8s',
  title: t('内网设施实战：接手一家公司的 Kubernetes', 'Intranet Infrastructure: Inheriting a Kubernetes Cluster'),
  summary: t(
    '在一台跳板机上接手真实规模的内网集群：真 kubectl、真 helm、真 docker，真的会坏。',
    'Take over a company intranet cluster from a jump host: real kubectl, real helm, real docker — and real breakage.'
  ),
  difficulty: 'Hard',
  domain: 'infrastructure',
  tags: ['kubernetes', 'sre', 'containers', 'gitops'],
  estimatedMinutes: 240,
  language: 'typescript',
  brief: t(
    code`
      你入职一家公司做基础设施。前任留下一台跳板机、一个 Kubernetes 集群，
      和一份不太靠谱的交接文档。

      这个项目里的东西都是真的：终端里的 shell 是 bash 语法（tree-sitter 解析），
      \`kubectl\` 与 \`helm\` 是官方二进制编译成 WebAssembly 的，
      \`docker build\` 真的按 Dockerfile 分层并算 sha256。
      集群是内存里的 apiserver + 控制器循环，Pod 会真的被调度、拉镜像、就绪、崩溃。

      **判定看的是集群的真实状态**，不是你敲了什么命令。
      怎么达成随你，达成了就算过。
    `,
    code`
      You have joined a company as an infrastructure engineer. Your predecessor
      left behind a jump host, a Kubernetes cluster, and a handover document of
      questionable accuracy.

      Everything here is real: the shell parses bash with tree-sitter, \`kubectl\`
      and \`helm\` are the upstream binaries compiled to WebAssembly, and
      \`docker build\` really layers your Dockerfile and computes sha256 digests.
      The cluster is an in-memory apiserver plus controller loops — pods really do
      get scheduled, pull images, become ready, and crash.

      **Grading looks at the cluster's actual state**, not at what you typed.
      How you get there is up to you.
    `
  ),
  workspace: { kind: 'ops', world: WORLD },
  files: [],
  stages: [stage1, stage2, stage3],
};
