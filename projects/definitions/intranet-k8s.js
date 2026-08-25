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
    [PORTAL_IMAGE]: { pullMs: 400, startupMs: 600, readyAfterMs: 300 },
  },
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
    files: {},
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
  stages: [stage1],
};
