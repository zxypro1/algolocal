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
const PORTAL_IMAGE_NEXT = 'harbor.corp.internal/team/portal:1.5.0';
const REPORTS_IMAGE = 'harbor.corp.internal/team/reports:2.1.0';
const ENVOY_IMAGE = 'registry.k8s.io/gateway-api/envoy-gateway:v1.6.2';
const CERT_MANAGER_IMAGE = 'quay.io/jetstack/cert-manager-controller:v1.19.1';
/** 已经从仓库里下架的镜像，拉不到 —— ingress-nginx 2026-03-24 退役 */
const RETIRED_NGINX_IMAGE = 'registry.k8s.io/ingress-nginx/controller:v1.13.0';
const LEDGER_IMAGE = 'harbor.corp.internal/team/ledger:3.2.1';
// 集群现在的 CNI。它不实现 NetworkPolicy —— 第 10 关整关都建立在这一点上。
const FLANNEL_IMAGE = 'docker.io/flannel/flannel:v0.28.0';
const CILIUM_IMAGE = 'quay.io/cilium/cilium:v1.19.2';

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
  namespaces: [
    'default', 'kube-system', 'payments', 'analytics',
    'envoy-gateway-system', 'ingress-nginx', 'cert-manager',
  ],
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
    // 平台组装的入口控制器与 PKI
    [ENVOY_IMAGE]: { pullMs: 300, startupMs: 400, readyAfterMs: 200, listens: [18000] },
    [CERT_MANAGER_IMAGE]: { pullMs: 300, startupMs: 400, readyAfterMs: 200, listens: [9402] },
    // 支付核心。安全评审要求它只对门户开放。
    [LEDGER_IMAGE]: {
      pullMs: 400, startupMs: 700, readyAfterMs: 300,
      listens: [8080],
      routes: { '/': 200, '/healthz': 200 },
      memoryUsage: '240Mi',
    },
    // CNI。flannel 收下 NetworkPolicy 但一个包都不拦，Cilium 才真的执行。
    [FLANNEL_IMAGE]: {
      pullMs: 200, startupMs: 300, readyAfterMs: 100,
      enforcesNetworkPolicy: false,
    },
    [CILIUM_IMAGE]: {
      pullMs: 600, startupMs: 900, readyAfterMs: 400,
      listens: [9962],
      enforcesNetworkPolicy: true,
    },
    // 财务的报表任务：吃 900Mi，limits 写小了就会被 OOMKill
    [REPORTS_IMAGE]: {
      pullMs: 500, startupMs: 800, readyAfterMs: 200,
      listens: [9090],
      routes: { '/healthz': 200 },
      memoryUsage: '900Mi',
    },
  },
  // 本地已经有的基础镜像，写 Dockerfile 时 FROM 得着
  baseImages: { 'node:22-alpine': 'node' },
  // 内网 PKI：根 CA + 签发用的中间 CA，外加前任手工造的那张只有叶子的证书
  pki: {
    roots: [{ name: 'corp-root-ca', namespace: 'cert-manager', commonName: 'Corp Root CA' }],
    intermediates: [{
      name: 'corp-issuing-ca', namespace: 'cert-manager',
      commonName: 'Corp Issuing CA', signedBy: 'corp-root-ca',
    }],
    serverCertificates: [{
      name: 'portal-tls-manual', namespace: 'payments',
      commonName: 'portal.corp.internal', dnsNames: ['portal.corp.internal'],
      signedBy: 'corp-issuing-ca',
      // 只放叶子，不接签发链 —— 第 9 关埋的就是这个
      leafOnly: true,
    }],
    // 跳板机只信根，不信中间
    trust: ['corp-root-ca'],
  },
  // 内网入口与公网入口用不同的地址池，这是「不能上公网」这条要求的落点
  addressPools: [
    { loadBalancerClass: 'corp.internal/office-lb', cidrPrefix: '10.10.8', zones: ['office'] },
    { loadBalancerClass: 'corp.internal/public-lb', cidrPrefix: '203.0.113', zones: ['office', 'internet'] },
  ],
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
/* 平台组已经装好的东西                                                */
/* ------------------------------------------------------------------ */

/** Envoy Gateway：控制器本身是集群里的一个工作负载 */
const GATEWAY_PLATFORM = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: {
      name: 'envoy-gateway', namespace: 'envoy-gateway-system',
      labels: { 'app.kubernetes.io/name': 'envoy-gateway' },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': 'envoy-gateway' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'envoy-gateway' } },
        spec: { containers: [{ name: 'controller', image: ENVOY_IMAGE }] },
      },
    },
  },
  {
    apiVersion: 'gateway.envoyproxy.io/v1alpha1', kind: 'EnvoyProxy',
    metadata: { name: 'internal', namespace: 'envoy-gateway-system' },
    spec: { provider: { kubernetes: { envoyService: { loadBalancerClass: 'corp.internal/office-lb' } } } },
  },
  {
    apiVersion: 'gateway.envoyproxy.io/v1alpha1', kind: 'EnvoyProxy',
    metadata: { name: 'public', namespace: 'envoy-gateway-system' },
    spec: { provider: { kubernetes: { envoyService: { loadBalancerClass: 'corp.internal/public-lb' } } } },
  },
  {
    apiVersion: 'gateway.networking.k8s.io/v1', kind: 'GatewayClass',
    metadata: { name: 'envoy-internal' },
    spec: {
      controllerName: 'gateway.envoyproxy.io/gatewayclass-controller',
      parametersRef: {
        group: 'gateway.envoyproxy.io', kind: 'EnvoyProxy',
        name: 'internal', namespace: 'envoy-gateway-system',
      },
    },
  },
  {
    apiVersion: 'gateway.networking.k8s.io/v1', kind: 'GatewayClass',
    metadata: { name: 'envoy-public' },
    spec: {
      controllerName: 'gateway.envoyproxy.io/gatewayclass-controller',
      parametersRef: {
        group: 'gateway.envoyproxy.io', kind: 'EnvoyProxy',
        name: 'public', namespace: 'envoy-gateway-system',
      },
    },
  },
];

/** cert-manager 与指向中间 CA 的 ClusterIssuer */
const CERT_MANAGER_PLATFORM = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: {
      name: 'cert-manager', namespace: 'cert-manager',
      labels: { 'app.kubernetes.io/name': 'cert-manager' },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': 'cert-manager' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'cert-manager' } },
        spec: { containers: [{ name: 'controller', image: CERT_MANAGER_IMAGE }] },
      },
    },
  },
  {
    apiVersion: 'cert-manager.io/v1', kind: 'ClusterIssuer',
    metadata: { name: 'corp-ca' },
    spec: { ca: { secretName: 'corp-issuing-ca' } },
  },
];

/** 上一关迁好的路由。第 9 关开局它已经在了。 */
const PORTAL_ROUTE = {
  apiVersion: 'gateway.networking.k8s.io/v1', kind: 'HTTPRoute',
  metadata: { name: 'portal', namespace: 'payments' },
  spec: {
    parentRefs: [{ name: 'corp-gw' }],
    hostnames: ['portal.corp.internal'],
    rules: [{
      matches: [{ path: { type: 'PathPrefix', value: '/' } }],
      backendRefs: [{ name: 'portal', port: 80 }],
    }],
  },
};

/** 门户本身 */
const PORTAL_WORKLOAD = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'portal', namespace: 'payments' },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: 'portal' } },
      template: {
        metadata: { labels: { app: 'portal' } },
        spec: { containers: [{ name: 'web', image: PORTAL_IMAGE, ports: [{ containerPort: 8080 }] }] },
      },
    },
  },
  {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name: 'portal', namespace: 'payments' },
    spec: { clusterIP: '10.96.1.10', selector: { app: 'portal' }, ports: [{ port: 80, targetPort: 8080 }] },
  },
];

/** 集群现在的 CNI。收下 NetworkPolicy，但从不执行。 */
const CNI_FLANNEL = {
  apiVersion: 'apps/v1', kind: 'DaemonSet',
  metadata: {
    name: 'kube-flannel-ds', namespace: 'kube-system',
    labels: { 'app.kubernetes.io/name': 'flannel' },
  },
  spec: {
    selector: { matchLabels: { 'app.kubernetes.io/name': 'flannel' } },
    template: {
      metadata: { labels: { 'app.kubernetes.io/name': 'flannel' } },
      spec: { containers: [{ name: 'kube-flannel', image: FLANNEL_IMAGE }] },
    },
  },
};

/** 上一关的结果：cert-manager 签的证书 + 用上它的 Gateway */
const TLS_PLATFORM = [
  {
    apiVersion: 'cert-manager.io/v1', kind: 'Certificate',
    metadata: { name: 'portal', namespace: 'payments' },
    spec: {
      secretName: 'portal-tls', duration: '2160h', renewBefore: '720h',
      commonName: 'portal.corp.internal', dnsNames: ['portal.corp.internal'],
      issuerRef: { name: 'corp-ca', kind: 'ClusterIssuer' },
    },
  },
  {
    apiVersion: 'gateway.networking.k8s.io/v1', kind: 'Gateway',
    metadata: { name: 'corp-gw', namespace: 'payments' },
    spec: {
      gatewayClassName: 'envoy-internal',
      listeners: [
        {
          name: 'https', port: 443, protocol: 'HTTPS', hostname: 'portal.corp.internal',
          tls: { mode: 'Terminate', certificateRefs: [{ name: 'portal-tls' }] },
        },
        { name: 'http', port: 80, protocol: 'HTTP', hostname: 'portal.corp.internal' },
      ],
    },
  },
];

/** 支付核心 */
const LEDGER_WORKLOAD = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'ledger', namespace: 'payments' },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: 'ledger' } },
      template: {
        metadata: { labels: { app: 'ledger' } },
        spec: { containers: [{ name: 'app', image: LEDGER_IMAGE, ports: [{ containerPort: 8080 }] }] },
      },
    },
  },
  {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name: 'ledger', namespace: 'payments' },
    spec: { selector: { app: 'ledger' }, ports: [{ port: 80, targetPort: 8080 }] },
  },
];

/** 财务的报表任务，跑在自己的命名空间里 */
const ANALYTICS_WORKLOAD = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'reports', namespace: 'analytics' },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'reports' } },
      template: {
        metadata: { labels: { app: 'reports' } },
        spec: {
          containers: [{
            name: 'app', image: REPORTS_IMAGE,
            ports: [{ containerPort: 9090 }],
            resources: { requests: { memory: '256Mi' }, limits: { memory: '1Gi' } },
          }],
        },
      },
    },
  },
];

/** 前任写的那条策略。粗到会把门户自己也关在外面。 */
const PREDECESSOR_POLICY = {
  apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
  metadata: { name: 'payments-lockdown', namespace: 'payments' },
  spec: {
    // 选中整个命名空间，包括门户自己
    podSelector: {},
    policyTypes: ['Ingress', 'Egress'],
    ingress: [{ from: [{ podSelector: { matchLabels: { app: 'portal' } } }] }],
    // egress 一条都没写 = 什么都出不去，连 DNS 都不行
    egress: [],
  },
};

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

/* ------------------------------------------------------------------ */
/* 第 4 关                                                             */
/* ------------------------------------------------------------------ */

const PORTAL_15_MANIFEST = code`
  apiVersion: apps/v1
  kind: Deployment
  metadata:
    name: portal
    namespace: payments
  spec:
    replicas: 2
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
          image: ${PORTAL_IMAGE_NEXT}
          ports:
          - containerPort: 8080
`;

/** 参考解：只多两行，密码一个字都没有 */
const PORTAL_15_WITH_SECRET = PORTAL_15_MANIFEST.replace(
  '      containers:',
  '      imagePullSecrets:\n      - name: harbor\n      containers:'
);

const stage4 = {
  id: 'pull-credentials',
  title: t('私有仓库与拉取凭据', 'Private registry and pull credentials'),
  goal: t(
    code`
      上一关你把 \`portal:1.5.0\` 推上了 Harbor，现在要把它部署下去。
      apply 之后你会看到 Pod 卡在 \`ImagePullBackOff\`。

      注意一件事：你在跳板机上 \`docker login\` 过，那份凭据存在
      \`~/.docker/config.json\` 里。但**拉镜像的不是跳板机，是节点上的 kubelet**，
      它不知道你登录过。

      ## 通关标准

      1. Pod 全部 Running；
      2. 集群里有一个 \`kubernetes.io/dockerconfigjson\` 类型的 Secret；
      3. Deployment 通过 \`imagePullSecrets\` 引用它；
      4. **Harbor 的密码不能明文出现在 \`~/infra\` 下的任何文件里**，
         那个目录是要进 Git 的。

      ## 会用到的命令

      \`\`\`bash
      kubectl apply -f infra/portal.yaml
      kubectl describe pod -n payments -l app=portal
      kubectl create secret docker-registry harbor \
        --docker-server=harbor.corp.internal \
        --docker-username=ci --docker-password='Harbor@2026' -n payments
      kubectl get secret harbor -n payments -o yaml
      \`\`\`
    `,
    code`
      In the previous stage you pushed \`portal:1.5.0\` to Harbor. Now deploy it.
      After you apply, the pods will sit in \`ImagePullBackOff\`.

      One thing to notice: you ran \`docker login\` on the jump host, and those
      credentials live in \`~/.docker/config.json\`. But **the thing pulling the
      image is not the jump host, it is the kubelet on each node**, and it has no
      idea you logged in.

      ## Done when

      1. all pods are Running;
      2. the cluster has a \`kubernetes.io/dockerconfigjson\` Secret;
      3. the Deployment references it through \`imagePullSecrets\`;
      4. **the Harbor password appears in plaintext in no file under \`~/infra\`**,
         because that directory is going into Git.

      ## Commands you will need

      \`\`\`bash
      kubectl apply -f infra/portal.yaml
      kubectl describe pod -n payments -l app=portal
      kubectl create secret docker-registry harbor \
        --docker-server=harbor.corp.internal \
        --docker-username=ci --docker-password='Harbor@2026' -n payments
      kubectl get secret harbor -n payments -o yaml
      \`\`\`
    `
  ),
  checklist: [
    t('Pod 全部 Running', 'All pods Running'),
    t('有 dockerconfigjson 类型的 Secret 并被引用', 'A dockerconfigjson Secret exists and is referenced'),
    t('密码不出现在要进 Git 的文件里', 'The password is in no file bound for Git'),
  ],
  hints: [
    t(
      '\`kubectl describe pod\` 最下面的 Events 会写清楚是 401 还是「镜像不存在」，两者查法不同。',
      'The Events at the bottom of \`kubectl describe pod\` distinguish a 401 from "image not found"; they are different investigations.'
    ),
    t(
      '\`kubectl create secret docker-registry\` 会替你生成 \`.dockerconfigjson\`，不用手写。',
      '\`kubectl create secret docker-registry\` generates the \`.dockerconfigjson\` for you.'
    ),
    t(
      'Secret 用命令创建、manifest 里只写 \`imagePullSecrets\`，密码就不会进 Git。',
      'Create the Secret with a command and keep only \`imagePullSecrets\` in the manifest; the password never enters Git.'
    ),
  ],
  pitfalls: [
    t(
      '把 Secret 的 YAML（含 base64 的密码）写进 \`infra/\` 提交上去。base64 不是加密，\`base64 -d\` 一下就出来了。',
      'Committing the Secret YAML with its base64 password into \`infra/\`. base64 is not encryption; one \`base64 -d\` reveals it.'
    ),
    t(
      'Secret 建在了错的命名空间。imagePullSecrets 只能引用**同一个命名空间**里的 Secret。',
      'Creating the Secret in the wrong namespace. imagePullSecrets can only reference a Secret in the **same namespace**.'
    ),
  ],
  ops: {
    setupCommands: [
      ...PREVIOUS_STAGES,
      // 上一关的成果：镜像已经在 Harbor 上了
      "docker login harbor.corp.internal -u ci -p 'Harbor@2026'",
      'docker build -t harbor.corp.internal/team/portal:1.5.0 /root/app',
      'docker push harbor.corp.internal/team/portal:1.5.0',
      // 跳板机上的登录态和集群无关，这一点正是本关要教的
      'docker logout harbor.corp.internal',
    ],
    files: {
      '/root/infra/portal.yaml': PORTAL_15_MANIFEST,
      '/root/app/Dockerfile': REFERENCE_DOCKERFILE,
      '/root/app/.dockerignore': REFERENCE_DOCKERIGNORE,
      '/root/app/server.js': APP_SERVER,
      '/root/app/package.json': APP_PACKAGE,
      '/root/app/package-lock.json': '{"lockfileVersion":3,"name":"portal"}\n',
    },
    referenceFiles: { '/root/infra/portal.yaml': PORTAL_15_WITH_SECRET },
    referenceCommands: [
      'kubectl create secret docker-registry harbor --docker-server=harbor.corp.internal '
        + "--docker-username=ci --docker-password='Harbor@2026' -n payments",
      'kubectl apply -f /root/infra/portal.yaml',
    ],
  },
  specs: [
    spec('pull-credentials.spec.ts', code`
      import { get, list, sh } from '@ops/lab';

      describe('私有仓库与拉取凭据', () => {
        it('Pod 全部 Running', () => {
          const pods = list('Pod', { namespace: 'payments', labels: { app: 'portal' } });
          expect(pods.length > 0).toBe(true);
          for (const pod of pods) expect(pod.status.phase).toBe('Running');
        });

        it('有一个 dockerconfigjson 类型的 Secret', () => {
          const secrets = list('Secret', { namespace: 'payments' })
            .filter((item) => item.type === 'kubernetes.io/dockerconfigjson');
          expect(secrets.length > 0).toBe(true);
        });

        it('Deployment 引用了它', () => {
          const deployment = get('Deployment', 'portal', 'payments');
          const references = deployment.spec.template.spec.imagePullSecrets || [];
          expect(references.length > 0).toBe(true);

          const names = list('Secret', { namespace: 'payments' })
            .filter((item) => item.type === 'kubernetes.io/dockerconfigjson')
            .map((item) => item.metadata.name);
          expect(names.includes(references[0].name)).toBe(true);
        });

        it('密码没写进要进 Git 的文件里', async () => {
          const found = await sh("grep -rl Harbor@2026 /root/infra");
          expect(found.stdout.trim()).toBe('');
        });
      });
    `),
  ],
  focus: ['correctness', 'resilience'],
  extension: t(
    code`
      「我明明 docker login 过了」是这一关最常见的困惑，它背后是一个值得记住的
      边界：**镜像是节点拉的，不是你拉的**。同理，\`imagePullSecrets\` 也可以挂在
      ServiceAccount 上（那样命名空间里所有 Pod 自动带上），生产里通常这么做，
      免得每个 Deployment 都写一遍。
    `,
    code`
      "But I already ran docker login" is the standard confusion here, and behind it
      is a boundary worth remembering: **the node pulls the image, not you**.
      For the same reason, \`imagePullSecrets\` can also be attached to a
      ServiceAccount so every pod in the namespace inherits it, which is what
      production usually does rather than repeating it in every Deployment.
    `
  ),
};

/* ------------------------------------------------------------------ */
/* 第 5 关                                                             */
/* ------------------------------------------------------------------ */

const PORTAL_CONFIG_MANIFEST = code`
  apiVersion: apps/v1
  kind: Deployment
  metadata:
    name: portal
    namespace: payments
  spec:
    replicas: 2
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
          env:
          - name: LOG_LEVEL
            valueFrom:
              configMapKeyRef:
                name: portal-config
                key: LOG_LEVEL
          - name: UPSTREAM_URL
            valueFrom:
              configMapKeyRef:
                name: portal-config
                key: UPSTREAM_URL
          - name: DB_PASSWORD
            valueFrom:
              secretKeyRef:
                name: portal-db
                key: password
`;

const stage5 = {
  id: 'config-and-secrets',
  title: t('配置与机密', 'Configuration and secrets'),
  goal: t(
    code`
      门户要读三个配置：日志级别、上游地址、数据库密码。manifest 里已经写好了
      引用，但引用的 ConfigMap 和 Secret 都还不存在，apply 之后 Pod 会卡在
      \`CreateContainerConfigError\`。

      注意这个状态和 \`CrashLoopBackOff\` 的区别：容器**根本没起来**，
      所以 \`kubectl logs\` 里什么都没有。去看应用日志是白费功夫。

      建好之后还有第二件事：**改一个配置值，让它真的生效**。
      改 ConfigMap 不会自动重启 Pod，这是设计，不是 bug。

      ## 通关标准

      1. \`portal-config\` 有 \`LOG_LEVEL\` 与 \`UPSTREAM_URL\`；
      2. \`portal-db\` 是一个 Secret，有 \`password\`，而且**密码不在 ConfigMap 里**；
      3. Pod 全部 Running 且 Ready；
      4. 改过配置之后触发了一次滚动更新（这个 Deployment 下面不止一个 ReplicaSet）。

      ## 会用到的命令

      \`\`\`bash
      kubectl apply -f infra/portal.yaml
      kubectl describe pod -n payments -l app=portal
      kubectl create configmap portal-config -n payments \
        --from-literal=LOG_LEVEL=info --from-literal=UPSTREAM_URL=http://ledger.payments:8080
      kubectl create secret generic portal-db -n payments --from-literal=password='pg-9f3aQ2mK'
      kubectl rollout status deploy/portal -n payments
      kubectl get rs -n payments
      \`\`\`
    `,
    code`
      The portal reads three settings: log level, upstream URL, and a database
      password. The manifest already references them, but neither the ConfigMap nor
      the Secret exists, so after you apply the pods sit in
      \`CreateContainerConfigError\`.

      Note how that differs from \`CrashLoopBackOff\`: the container **never
      started**, so \`kubectl logs\` shows nothing. Reading application logs is
      wasted effort here.

      Once they exist there is a second task: **change one value and make it take
      effect**. Editing a ConfigMap does not restart pods. That is by design, not a bug.

      ## Done when

      1. \`portal-config\` holds \`LOG_LEVEL\` and \`UPSTREAM_URL\`;
      2. \`portal-db\` is a Secret holding \`password\`, and **the password is not
         in the ConfigMap**;
      3. all pods are Running and Ready;
      4. changing the config triggered a rollout (the Deployment owns more than one
         ReplicaSet).

      ## Commands you will need

      \`\`\`bash
      kubectl apply -f infra/portal.yaml
      kubectl describe pod -n payments -l app=portal
      kubectl create configmap portal-config -n payments \
        --from-literal=LOG_LEVEL=info --from-literal=UPSTREAM_URL=http://ledger.payments:8080
      kubectl create secret generic portal-db -n payments --from-literal=password='pg-9f3aQ2mK'
      kubectl rollout status deploy/portal -n payments
      kubectl get rs -n payments
      \`\`\`
    `
  ),
  checklist: [
    t('ConfigMap 与 Secret 都建好并被正确引用', 'ConfigMap and Secret created and referenced'),
    t('密码只在 Secret 里', 'The password lives only in the Secret'),
    t('改配置之后真的滚动更新了一次', 'Changing the config actually triggered a rollout'),
  ],
  hints: [
    t(
      '\`CreateContainerConfigError\` 的具体原因在 \`kubectl describe pod\` 的 Events 里，它会说是「ConfigMap 不存在」还是「key 不存在」。',
      'The reason behind \`CreateContainerConfigError\` is in the pod Events: it distinguishes "ConfigMap not found" from "key not found".'
    ),
    t(
      '让配置变更生效的通行做法是在 pod template 上加一个注解（比如配置内容的哈希）。模板变了，Deployment 才会建新的 ReplicaSet。',
      'The common way to make config changes take effect is an annotation on the pod template (a hash of the config). Only a changed template makes the Deployment create a new ReplicaSet.'
    ),
  ],
  pitfalls: [
    t(
      '把密码放进 ConfigMap。ConfigMap 没有任何访问控制上的特殊待遇，日志、事件、\`describe\` 里都可能带出来。',
      'Putting the password in a ConfigMap. ConfigMaps get no special access treatment and leak through logs, events, and \`describe\`.'
    ),
    t(
      '改完 ConfigMap 就以为完事了。已经在跑的 Pod 里那份环境变量是启动时注入的，不会自己更新，除非它是以卷挂载的形式读文件。',
      'Assuming the ConfigMap edit is enough. Environment variables are injected at container start and never update, unless the config is mounted as a volume and re-read.'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    files: { '/root/infra/portal.yaml': PORTAL_CONFIG_MANIFEST },
    referenceCommands: [
      'kubectl create configmap portal-config -n payments '
        + '--from-literal=LOG_LEVEL=info --from-literal=UPSTREAM_URL=http://ledger.payments:8080',
      "kubectl create secret generic portal-db -n payments --from-literal=password=pg-9f3aQ2mK",
      'kubectl apply -f /root/infra/portal.yaml',
      // 改一个配置值，并让它真的生效
      'kubectl create configmap portal-config -n payments '
        + '--from-literal=LOG_LEVEL=debug --from-literal=UPSTREAM_URL=http://ledger.payments:8080 '
        + '--dry-run=client -o yaml > /root/infra/portal-config.yaml',
      'kubectl apply -f /root/infra/portal-config.yaml',
      'kubectl patch deploy portal -n payments --type=merge -p '
        + '\'{"spec":{"template":{"metadata":{"annotations":{"checksum/config":"debug-7b3f"}}}}}\'',
    ],
  },
  specs: [
    spec('config-and-secrets.spec.ts', code`
      import { get, list } from '@ops/lab';

      describe('配置与机密', () => {
        it('ConfigMap 有那两个键', () => {
          const configMap = get('ConfigMap', 'portal-config', 'payments');
          expect(configMap).toBeTruthy();
          expect(typeof configMap.data.LOG_LEVEL).toBe('string');
          expect(typeof configMap.data.UPSTREAM_URL).toBe('string');
        });

        it('密码在 Secret 里，不在 ConfigMap 里', () => {
          const secret = get('Secret', 'portal-db', 'payments');
          expect(secret).toBeTruthy();
          const keys = Object.keys(secret.data || secret.stringData || {});
          expect(keys.includes('password')).toBe(true);

          const configMap = get('ConfigMap', 'portal-config', 'payments');
          const values = Object.values(configMap.data || {}).join(' ');
          expect(values.includes('pg-9f3aQ2mK')).toBe(false);
        });

        it('Pod 全部 Running 且 Ready', () => {
          const pods = list('Pod', { namespace: 'payments', labels: { app: 'portal' } });
          expect(pods.length > 0).toBe(true);
          for (const pod of pods) {
            expect(pod.status.phase).toBe('Running');
            const ready = (pod.status.conditions || []).find((c) => c.type === 'Ready');
            expect(ready && ready.status).toBe('True');
          }
        });

        it('改过配置之后滚动更新过一次', () => {
          const deployment = get('Deployment', 'portal', 'payments');
          const owned = list('ReplicaSet', { namespace: 'payments' }).filter((rs) =>
            (rs.metadata.ownerReferences || []).some((o) => o.uid === deployment.metadata.uid)
          );
          expect(owned.length >= 2).toBe(true);
        });
      });
    `),
  ],
  focus: ['correctness', 'resilience'],
  extension: t(
    code`
      「改了 ConfigMap 但没生效」几乎是每个团队都会踩一次的坑。行业里的标准解法
      是在 pod template 上放一个配置内容的校验和：Helm 里是
      \`checksum/config: {{ include ... | sha256sum }}\`，Kustomize 则用
      \`configMapGenerator\` 自动给 ConfigMap 名字加哈希后缀，名字变了，
      模板自然就变了。
    `,
    code`
      "I changed the ConfigMap and nothing happened" is a rite of passage. The
      industry answer is a checksum of the config on the pod template: in Helm,
      \`checksum/config: {{ include ... | sha256sum }}\`; in Kustomize,
      \`configMapGenerator\` appends a content hash to the ConfigMap name, so the
      name changes and therefore the template changes.
    `
  ),
};

/* ------------------------------------------------------------------ */
/* 第 6 关                                                             */
/* ------------------------------------------------------------------ */

const PORTAL_PROBE_MANIFEST = code`
  apiVersion: apps/v1
  kind: Deployment
  metadata:
    name: portal
    namespace: payments
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
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8081
            initialDelaySeconds: 2
            periodSeconds: 5
`;

const PORTAL_PROBE_FIXED = code`
  apiVersion: apps/v1
  kind: Deployment
  metadata:
    name: portal
    namespace: payments
  spec:
    replicas: 3
    strategy:
      type: RollingUpdate
      rollingUpdate:
        maxUnavailable: 0
        maxSurge: 1
    selector:
      matchLabels:
        app: portal
    template:
      metadata:
        labels:
          app: portal
      spec:
        terminationGracePeriodSeconds: 30
        containers:
        - name: web
          image: ${PORTAL_IMAGE}
          ports:
          - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8080
            initialDelaySeconds: 2
            periodSeconds: 5
          livenessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 10
            periodSeconds: 10
            failureThreshold: 3
          lifecycle:
            preStop:
              exec:
                command: ["sleep", "10"]
`;

const stage6 = {
  id: 'probes-and-shutdown',
  title: t('探针、优雅终止与自愈', 'Probes, graceful shutdown, and self-healing'),
  goal: t(
    code`
      前任给门户加了就绪探针，然后 Pod 就再也没 Ready 过 ——
      \`kubectl get pods\` 里三个 Pod 全是 \`Running\` 但 \`0/1\`，
      \`kubectl logs\` 里干干净净，应用一切正常。

      问题不在应用，在探针指错了地方。顺便说，这个 Deployment 现在滚动更新时
      会真的掉流量：默认策略允许同时下线 25% 的副本，而且没有给进程留退出时间。

      ## 通关标准

      1. 三个 Pod 全部 Ready；
      2. 就绪探针指向应用真正在听的端口和真正存在的路径；
      3. 配了存活探针（它和就绪探针管的不是一回事）；
      4. 滚动更新期间不掉可用副本：\`maxUnavailable: 0\`；
      5. 给进程留了退出时间：\`terminationGracePeriodSeconds\` 不小于 20，
         并且有 \`preStop\` 钩子先把流量摘掉。

      ## 会用到的命令

      \`\`\`bash
      kubectl get pods -n payments
      kubectl describe pod -n payments -l app=portal
      kubectl get events -n payments --sort-by=.metadata.creationTimestamp
      kubectl apply -f infra/portal.yaml
      kubectl rollout status deploy/portal -n payments
      \`\`\`
    `,
    code`
      Your predecessor added a readiness probe to the portal, and the pods have not
      been Ready since. \`kubectl get pods\` shows three pods that are \`Running\`
      but \`0/1\`, \`kubectl logs\` is clean, and the application is fine.

      The problem is not the application; the probe points at the wrong place.
      Separately, this Deployment currently drops traffic during a rollout: the
      default strategy allows a quarter of the replicas to go away at once, and the
      process is given no time to shut down.

      ## Done when

      1. all three pods are Ready;
      2. the readiness probe targets the port the app actually listens on and a path
         that actually exists;
      3. a liveness probe is configured (it answers a different question than readiness);
      4. rollouts never lose an available replica: \`maxUnavailable: 0\`;
      5. the process gets time to exit: \`terminationGracePeriodSeconds\` of at least
         20, plus a \`preStop\` hook that lets traffic drain first.

      ## Commands you will need

      \`\`\`bash
      kubectl get pods -n payments
      kubectl describe pod -n payments -l app=portal
      kubectl get events -n payments --sort-by=.metadata.creationTimestamp
      kubectl apply -f infra/portal.yaml
      kubectl rollout status deploy/portal -n payments
      \`\`\`
    `
  ),
  checklist: [
    t('三个 Pod 全部 Ready', 'All three pods Ready'),
    t('就绪探针与存活探针都配对了', 'Readiness and liveness probes both configured correctly'),
    t('maxUnavailable 为 0，并给了优雅退出的时间', 'maxUnavailable is 0 and shutdown has room to happen'),
  ],
  hints: [
    t(
      '\`kubectl describe pod\` 的 Events 里会有一条 \`Readiness probe failed\`，它把端口写出来了。',
      'The pod Events contain a \`Readiness probe failed\` line that names the port.'
    ),
    t(
      '容器 \`ports.containerPort\` 写的是 8080，探针写的是别的数字，这两处对不上。',
      'The container declares \`containerPort: 8080\` while the probe names a different number.'
    ),
    t(
      '就绪探针失败只是把这个 Pod 从 Endpoints 里摘掉；存活探针失败会重启容器。用错了会让一个只是暂时忙的进程被反复杀掉。',
      'A failing readiness probe only removes the pod from Endpoints; a failing liveness probe restarts the container. Confusing them gets a merely busy process killed over and over.'
    ),
  ],
  pitfalls: [
    t(
      '把存活探针配得和就绪探针一样激进。依赖的下游慢一点，整批 Pod 会被同时重启，把一次抖动放大成一次故障。',
      'Making the liveness probe as aggressive as the readiness probe. One slow dependency then restarts every pod at once, turning a blip into an outage.'
    ),
    t(
      '只把 \`terminationGracePeriodSeconds\` 调大而不加 \`preStop\`。收到 SIGTERM 的那一刻，Endpoints 的更新还没传播到所有节点，这段时间里的请求照样会打到正在退出的 Pod 上。',
      'Raising \`terminationGracePeriodSeconds\` without a \`preStop\` hook. At the moment SIGTERM arrives, the Endpoints removal has not propagated everywhere, and requests still land on the pod that is shutting down.'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    files: { '/root/infra/portal.yaml': PORTAL_PROBE_MANIFEST },
    referenceFiles: { '/root/infra/portal.yaml': PORTAL_PROBE_FIXED },
    referenceCommands: ['kubectl apply -f /root/infra/portal.yaml'],
  },
  specs: [
    spec('probes-and-shutdown.spec.ts', code`
      import { get, list } from '@ops/lab';

      describe('探针、优雅终止与自愈', () => {
        it('三个 Pod 全部 Ready', () => {
          const pods = list('Pod', { namespace: 'payments', labels: { app: 'portal' } });
          expect(pods.length).toBe(3);
          for (const pod of pods) {
            const ready = (pod.status.conditions || []).find((c) => c.type === 'Ready');
            expect(ready && ready.status).toBe('True');
          }
        });

        it('就绪探针指向应用真正在听的端口', () => {
          const container = get('Deployment', 'portal', 'payments').spec.template.spec.containers[0];
          const probe = container.readinessProbe;
          expect(probe).toBeTruthy();
          expect(probe.httpGet.port).toBe(8080);
          expect(['/healthz', '/readyz'].includes(probe.httpGet.path)).toBe(true);
        });

        it('配了存活探针', () => {
          const container = get('Deployment', 'portal', 'payments').spec.template.spec.containers[0];
          expect(container.livenessProbe).toBeTruthy();
          expect(container.livenessProbe.httpGet.port).toBe(8080);
        });

        it('滚动更新不掉可用副本', () => {
          const strategy = get('Deployment', 'portal', 'payments').spec.strategy || {};
          expect(strategy.type).toBe('RollingUpdate');
          expect(strategy.rollingUpdate.maxUnavailable).toBe(0);
        });

        it('给了优雅退出的时间，并且先摘流量', () => {
          const podSpec = get('Deployment', 'portal', 'payments').spec.template.spec;
          expect(podSpec.terminationGracePeriodSeconds >= 20).toBe(true);
          expect(podSpec.containers[0].lifecycle.preStop).toBeTruthy();
        });
      });
    `),
  ],
  focus: ['correctness', 'resilience'],
  extension: t(
    code`
      就绪探针和存活探针回答的是两个不同的问题：「现在能不能给我流量」和
      「这个进程还有没有救」。把它们配成一样，等于让一次下游变慢直接升级成
      全体重启。生产里还有第三种 \`startupProbe\`，专门给启动慢的应用用：
      它没通过之前，存活探针不生效，于是不用为了照顾冷启动而把存活探针
      调得很松。
    `,
    code`
      Readiness and liveness answer different questions: "can I take traffic right
      now" and "is this process beyond saving". Configuring them identically turns a
      slow dependency into a fleet-wide restart. Production adds a third,
      \`startupProbe\`, for slow-starting applications: until it passes, the liveness
      probe is suspended, so you no longer have to weaken liveness just to survive a
      cold start.
    `
  ),
};

/* ------------------------------------------------------------------ */
/* 第 7 关                                                             */
/* ------------------------------------------------------------------ */

const REPORTS_MANIFEST = code`
  apiVersion: apps/v1
  kind: Deployment
  metadata:
    name: reports
    namespace: payments
  spec:
    replicas: 1
    selector:
      matchLabels:
        app: reports
    template:
      metadata:
        labels:
          app: reports
      spec:
        containers:
        - name: batch
          image: ${REPORTS_IMAGE}
          resources:
            limits:
              memory: 256Mi
`;

const REPORTS_FIXED = code`
  apiVersion: apps/v1
  kind: Deployment
  metadata:
    name: reports
    namespace: payments
  spec:
    replicas: 1
    selector:
      matchLabels:
        app: reports
    template:
      metadata:
        labels:
          app: reports
      spec:
        containers:
        - name: batch
          image: ${REPORTS_IMAGE}
          resources:
            requests:
              cpu: 200m
              memory: 1Gi
            limits:
              cpu: 500m
              memory: 1Gi
`;

const PORTAL_SIZED = code`
  apiVersion: apps/v1
  kind: Deployment
  metadata:
    name: portal
    namespace: payments
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
          resources:
            requests:
              cpu: 250m
              memory: 256Mi
            limits:
              cpu: 250m
              memory: 256Mi
`;

const PORTAL_UNSIZED = code`
  apiVersion: apps/v1
  kind: Deployment
  metadata:
    name: portal
    namespace: payments
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
`;

const stage7 = {
  id: 'resources-and-qos',
  title: t('资源、QoS 与驱逐', 'Resources, QoS, and eviction'),
  goal: t(
    code`
      财务那边新上了一个报表任务 \`reports\`，前任给它配了 \`limits.memory: 256Mi\`。
      apply 之后它一直在重启，\`kubectl describe\` 里写着 \`OOMKilled\`，退出码 137。
      而门户 \`portal\` 一个资源声明都没写。

      这两件事是同一个问题的两面：**没量过就写数字**，和**根本不写**。

      不写 requests 的 Pod 是 \`BestEffort\`，节点内存紧张时它第一个被赶走；
      limits 写小了则会被内核直接杀掉，连日志都来不及打完。

      ## 通关标准

      1. 两个 Deployment 的每个容器都写了 cpu 与 memory 的 requests 和 limits；
      2. \`portal\` 是 \`Guaranteed\` 等级（requests 与 limits 完全相等），
         三个 Pod 全部 Ready；
      3. \`reports\` 不再 OOMKilled，Pod 处于 Running；
      4. 没有任何 Pod 被驱逐。

      ## 会用到的命令

      \`\`\`bash
      kubectl apply -f infra/portal.yaml -f infra/reports.yaml
      kubectl describe pod -n payments -l app=reports
      kubectl get pod -n payments -o custom-columns=NAME:.metadata.name,QOS:.status.qosClass
      kubectl get events -n payments --field-selector reason=Evicted
      \`\`\`
    `,
    code`
      Finance shipped a new reporting job, \`reports\`, and your predecessor gave it
      \`limits.memory: 256Mi\`. Since the apply it has been restarting, with
      \`OOMKilled\` and exit code 137 in \`kubectl describe\`. Meanwhile the portal
      declares no resources at all.

      These are two sides of one problem: **a number nobody measured**, and
      **no number at all**.

      A pod without requests is \`BestEffort\` and is the first thing evicted when a
      node runs short of memory. A limit set too low gets the process killed by the
      kernel before it can even finish a log line.

      ## Done when

      1. every container in both Deployments declares cpu and memory requests and limits;
      2. \`portal\` is \`Guaranteed\` (requests exactly equal to limits) and all three
         pods are Ready;
      3. \`reports\` is no longer OOMKilled and its pod is Running;
      4. no pod has been evicted.

      ## Commands you will need

      \`\`\`bash
      kubectl apply -f infra/portal.yaml -f infra/reports.yaml
      kubectl describe pod -n payments -l app=reports
      kubectl get pod -n payments -o custom-columns=NAME:.metadata.name,QOS:.status.qosClass
      kubectl get events -n payments --field-selector reason=Evicted
      \`\`\`
    `
  ),
  checklist: [
    t('两个负载都写全了 requests 与 limits', 'Both workloads declare requests and limits'),
    t('portal 是 Guaranteed 且全部 Ready', 'portal is Guaranteed and fully Ready'),
    t('reports 不再 OOMKilled，也没有 Pod 被驱逐', 'reports is no longer OOMKilled and nothing was evicted'),
  ],
  hints: [
    t(
      '退出码 137 是 128+9，也就是被 SIGKILL 杀的。容器里唯一会这么干的通常就是 cgroup 的内存上限。',
      'Exit code 137 is 128+9, meaning SIGKILL. Inside a container that is almost always the cgroup memory limit.'
    ),
    t(
      '\`kubectl describe pod\` 里的 \`Last State: Terminated / Reason: OOMKilled\` 是最直接的证据。',
      '\`Last State: Terminated / Reason: OOMKilled\` in \`kubectl describe pod\` is the most direct evidence.'
    ),
    t(
      'QoS 等级不是自己写的，是根据 requests 与 limits 算出来的：都写且相等是 Guaranteed，都不写是 BestEffort，其余是 Burstable。',
      'The QoS class is derived, not declared: requests equal to limits everywhere is Guaranteed, nothing declared is BestEffort, anything else is Burstable.'
    ),
  ],
  pitfalls: [
    t(
      '把 limits 删掉来「解决」OOM。确实不会被杀了，但这个 Pod 同时变成了 BestEffort，节点一紧张它第一个被驱逐 —— 从一种死法换成了另一种。',
      'Deleting the limit to "fix" the OOM. It stops being killed, but it also becomes BestEffort and is now first in line for eviction: one way of dying traded for another.'
    ),
    t(
      'requests 写得远小于实际用量。调度器按 requests 装箱，于是它会把远超节点容量的一堆 Pod 排到同一台机器上，然后集体触发驱逐。',
      'Setting requests far below actual usage. The scheduler bin-packs by requests, happily overcommits a node, and then everything on it gets evicted together.'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    files: {
      '/root/infra/portal.yaml': PORTAL_UNSIZED,
      '/root/infra/reports.yaml': REPORTS_MANIFEST,
    },
    referenceFiles: {
      '/root/infra/portal.yaml': PORTAL_SIZED,
      '/root/infra/reports.yaml': REPORTS_FIXED,
    },
    referenceCommands: [
      'kubectl apply -f /root/infra/portal.yaml',
      'kubectl apply -f /root/infra/reports.yaml',
    ],
  },
  specs: [
    spec('resources-and-qos.spec.ts', code`
      import { get, list } from '@ops/lab';

      function containersOf(name) {
        return get('Deployment', name, 'payments').spec.template.spec.containers;
      }

      describe('资源、QoS 与驱逐', () => {
        it('两个负载的每个容器都写全了 requests 与 limits', () => {
          for (const name of ['portal', 'reports']) {
            for (const container of containersOf(name)) {
              const resources = container.resources || {};
              expect(typeof (resources.requests || {}).cpu).toBe('string');
              expect(typeof (resources.requests || {}).memory).toBe('string');
              expect(typeof (resources.limits || {}).cpu).toBe('string');
              expect(typeof (resources.limits || {}).memory).toBe('string');
            }
          }
        });

        it('portal 是 Guaranteed，三个 Pod 全部 Ready', () => {
          const pods = list('Pod', { namespace: 'payments', labels: { app: 'portal' } });
          expect(pods.length).toBe(3);
          for (const pod of pods) {
            expect(pod.status.qosClass).toBe('Guaranteed');
            const ready = (pod.status.conditions || []).find((c) => c.type === 'Ready');
            expect(ready && ready.status).toBe('True');
          }
        });

        it('reports 不再被 OOMKilled', () => {
          const pods = list('Pod', { namespace: 'payments', labels: { app: 'reports' } });
          expect(pods.length > 0).toBe(true);
          for (const pod of pods) {
            expect(pod.status.phase).toBe('Running');
            for (const status of pod.status.containerStatuses || []) {
              const last = (status.lastState || {}).terminated;
              expect(last && last.reason).not.toBe('OOMKilled');
            }
          }
        });

        it('没有 Pod 被驱逐', () => {
          const evicted = list('Pod', { namespace: 'payments' })
            .filter((pod) => pod.status.reason === 'Evicted');
          expect(evicted.length).toBe(0);
        });
      });
    `),
  ],
  focus: ['correctness', 'resilience', 'latency'],
  extension: t(
    code`
      requests 和 limits 各管一件事，很多人把它们混为一谈：**requests 决定调度**
      （节点上还剩多少「已承诺」的容量），**limits 决定运行时约束**
      （cgroup 的上限）。内存 limit 超了直接 OOMKill，CPU limit 超了则是被限流
      （节流而不是杀死），表现为 P99 变差而不是进程消失。
      现实里的做法是先用监控量出实际用量，再据此设定，而不是拍脑袋。
      更进一步有 VPA 的 recommender 帮你算，以及 LimitRange
      给整个命名空间兜一个默认值。
    `,
    code`
      Requests and limits govern different things and are routinely confused:
      **requests drive scheduling** (how much promised capacity a node has left),
      **limits are runtime constraints** (the cgroup ceiling). Exceeding a memory
      limit gets the process OOM-killed; exceeding a CPU limit gets it throttled
      rather than killed, which shows up as a worse P99 instead of a missing process.
      Real practice is to measure actual usage first and set numbers from that. Going
      further, VPA's recommender computes them for you, and a LimitRange gives a
      namespace sane defaults.
    `
  ),
};

/* ------------------------------------------------------------------ */
/* 第 8 关                                                             */
/* ------------------------------------------------------------------ */

/** 前任留下的老入口。ingress-nginx 已经退役，这个镜像在仓库里根本拉不到了。 */
const LEGACY_INGRESS = code`
  apiVersion: networking.k8s.io/v1
  kind: Ingress
  metadata:
    name: portal
    namespace: payments
    annotations:
      nginx.ingress.kubernetes.io/rewrite-target: /
  spec:
    ingressClassName: nginx
    rules:
    - host: portal.corp.internal
      http:
        paths:
        - path: /
          pathType: Prefix
          backend:
            service:
              name: portal
              port:
                number: 80
`;

const GATEWAY_REFERENCE = code`
  apiVersion: gateway.networking.k8s.io/v1
  kind: Gateway
  metadata:
    name: corp-gw
    namespace: payments
  spec:
    gatewayClassName: envoy-internal
    listeners:
    - name: http
      port: 80
      protocol: HTTP
      hostname: portal.corp.internal
      allowedRoutes:
        namespaces:
          from: Same
  ---
  apiVersion: gateway.networking.k8s.io/v1
  kind: HTTPRoute
  metadata:
    name: portal
    namespace: payments
  spec:
    parentRefs:
    - name: corp-gw
    hostnames:
    - portal.corp.internal
    rules:
    - matches:
      - path:
          type: PathPrefix
          value: /
      backendRefs:
      - name: portal
        port: 80
`;

const stage8 = {
  id: 'gateway-migration',
  title: t('从 Ingress 迁到 Gateway API', 'Migrate from Ingress to Gateway API'),
  goal: t(
    code`
      门户的对外入口还挂在 ingress-nginx 上，而这个项目已经在 2026 年 3 月退役了 ——
      镜像从仓库里下架，控制器起不来，Ingress 一直没有地址，门户从办公网访问不了。

      平台组已经把 Envoy Gateway 装好了，也提供了两个 GatewayClass：
      \`envoy-internal\`（只暴露到办公网）和 \`envoy-public\`（暴露到公网）。
      **门户是内部系统，不能上公网。**

      ## 通关标准

      1. 建一个 Gateway（用对 class）和一条 HTTPRoute，把
         \`portal.corp.internal\` 指到 \`portal\` 这个 Service；
      2. Gateway 的 \`Programmed\` 是 True，拿到了地址；
      3. 从跳板机（办公网）访问得到，返回 200；
      4. **从公网访问不到**；
      5. 老的 Ingress 与 ingress-nginx 的 Deployment 都删掉 —— 留着不只是脏，
         还会让下一个人以为它还在起作用。

      ## 会用到的命令

      \`\`\`bash
      kubectl get ingress,pods -n payments
      kubectl get gatewayclass
      kubectl apply -f infra/gateway.yaml
      kubectl get gateway corp-gw -n payments -o yaml
      kubectl describe httproute portal -n payments
      curl -s -o /dev/null -w '%{http_code}\n' \\
        --resolve portal.corp.internal:80:<Gateway 的地址> http://portal.corp.internal/
      \`\`\`

      跳板机上没有配 \`portal.corp.internal\` 的解析，直接用 Gateway 拿到的
      地址访问就行。
    `,
    code`
      The portal's external entrypoint still runs on ingress-nginx, a project that
      was retired in March 2026. The image was pulled from the registry, the
      controller cannot start, the Ingress never got an address, and the portal is
      unreachable from the office network.

      The platform team has already installed Envoy Gateway and offers two
      GatewayClasses: \`envoy-internal\` (office network only) and \`envoy-public\`
      (public internet). **The portal is an internal system and must not be public.**

      ## Done when

      1. a Gateway (with the right class) and an HTTPRoute send
         \`portal.corp.internal\` to the \`portal\` Service;
      2. the Gateway reports \`Programmed\` True and has an address;
      3. it answers 200 from the jump host (office network);
      4. **it is not reachable from the internet**;
      5. the old Ingress and the ingress-nginx Deployment are both deleted. Leaving
         them is not just untidy: the next person will assume they still do something.

      ## Commands you will need

      \`\`\`bash
      kubectl get ingress,pods -n payments
      kubectl get gatewayclass
      kubectl apply -f infra/gateway.yaml
      kubectl get gateway corp-gw -n payments -o yaml
      kubectl describe httproute portal -n payments
      curl -s -o /dev/null -w '%{http_code}\n' \\
        --resolve portal.corp.internal:80:<gateway address> http://portal.corp.internal/
      \`\`\`
    `
  ),
  checklist: [
    t('Gateway 与 HTTPRoute 建好并生效', 'Gateway and HTTPRoute created and effective'),
    t('办公网访问得到、公网访问不到', 'Reachable from the office network, not from the internet'),
    t('老的 Ingress 与 ingress-nginx 都下线', 'The old Ingress and ingress-nginx are gone'),
  ],
  hints: [
    t(
      '\`kubectl get gatewayclass\` 会列出平台提供了哪几个 class，名字里就写着内外网。',
      '\`kubectl get gatewayclass\` lists what the platform offers; the names say internal or public.'
    ),
    t(
      'Gateway 的 \`status.addresses\` 里就是访问地址。\`kubectl get gateway -o wide\` 也看得到。',
      'The address is in the Gateway’s \`status.addresses\`; \`kubectl get gateway -o wide\` shows it too.'
    ),
    t(
      '路由不生效时先看 \`kubectl describe httproute\` 里的 \`ResolvedRefs\`，它会直接说是后端不存在还是别的。',
      'When a route does not work, check \`ResolvedRefs\` in \`kubectl describe httproute\`; it names the actual problem.'
    ),
  ],
  pitfalls: [
    t(
      '用了 \`envoy-public\` 那个 class。门户能访问了，但同时也暴露到了公网上 —— 判定会挂在这一条，现实里则是一次事故。',
      'Using the \`envoy-public\` class. The portal works, and is also on the public internet. The grader catches it; production would not.'
    ),
    t(
      '只删 Ingress 不删 ingress-nginx 的 Deployment。那个 Pod 还在那儿 CrashLoop，占着资源，还会让下一个人以为入口是它在管。',
      'Deleting the Ingress but not the ingress-nginx Deployment. The pod keeps crash-looping, burning resources and misleading the next person.'
    ),
    t(
      'HTTPRoute 的 \`hostnames\` 和 Gateway listener 的 \`hostname\` 对不上，两边都写了但不一样，结果是永远 404。',
      'Mismatched \`hostnames\` between the HTTPRoute and the Gateway listener: both set, both different, permanent 404.'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    objects: [
      ...GATEWAY_PLATFORM,
      // 已经退役的 ingress-nginx：镜像下架了，控制器起不来
      {
        apiVersion: 'apps/v1', kind: 'Deployment',
        metadata: {
          name: 'ingress-nginx-controller', namespace: 'ingress-nginx',
          labels: { 'app.kubernetes.io/name': 'ingress-nginx' },
        },
        spec: {
          replicas: 1,
          selector: { matchLabels: { 'app.kubernetes.io/name': 'ingress-nginx' } },
          template: {
            metadata: { labels: { 'app.kubernetes.io/name': 'ingress-nginx' } },
            spec: { containers: [{ name: 'controller', image: RETIRED_NGINX_IMAGE }] },
          },
        },
      },
      ...PORTAL_WORKLOAD,
    ],
    files: {
      '/root/infra/ingress.yaml': LEGACY_INGRESS,
      '/root/infra/gateway.yaml': '# 在这里写 Gateway 与 HTTPRoute\n',
    },
    referenceFiles: { '/root/infra/gateway.yaml': GATEWAY_REFERENCE },
    referenceCommands: [
      'kubectl apply -f /root/infra/ingress.yaml',
      'kubectl apply -f /root/infra/gateway.yaml',
      'kubectl delete ingress portal -n payments',
      'kubectl delete deployment ingress-nginx-controller -n ingress-nginx',
      'rm -f /root/infra/ingress.yaml',
    ],
  },
  specs: [
    spec('gateway-migration.spec.ts', code`
      import { get, list, sh, world } from '@ops/lab';

      function conditionOf(object, type) {
        return ((object.status || {}).conditions || []).find((entry) => entry.type === type);
      }

      describe('从 Ingress 迁到 Gateway API', () => {
        it('Gateway 建出来了，而且被 program 了', () => {
          const gateways = list('Gateway', { namespace: 'payments' });
          expect(gateways.length).toBe(1);
          expect(conditionOf(gateways[0], 'Programmed').status).toBe('True');
          expect(gateways[0].status.addresses.length).toBe(1);
        });

        it('用的是内网 class，不是公网那个', () => {
          const gateway = list('Gateway', { namespace: 'payments' })[0];
          expect(gateway.spec.gatewayClassName).toBe('envoy-internal');
        });

        it('HTTPRoute 的后端解析得到', () => {
          const routes = list('HTTPRoute', { namespace: 'payments' });
          expect(routes.length).toBe(1);
          const parent = routes[0].status.parents[0];
          const resolved = parent.conditions.find((entry) => entry.type === 'ResolvedRefs');
          expect(resolved.status).toBe('True');
        });

        it('办公网访问得到，返回 200', async () => {
          const gateway = list('Gateway', { namespace: 'payments' })[0];
          const address = gateway.status.addresses[0].value;
          // DNS 还没改过来，用 --resolve 直连 Gateway 的地址
          const result = await sh(
            'curl -s -o /dev/null -w %{http_code} --resolve portal.corp.internal:80:' + address
            + ' http://portal.corp.internal/'
          );
          expect(result.code).toBe(0);
          expect(result.stdout).toBe('200');
        });

        it('公网访问不到', () => {
          const gateway = list('Gateway', { namespace: 'payments' })[0];
          const address = gateway.status.addresses[0].value;
          const outcome = world.cluster.network.connect(
            { zone: 'internet', label: 'outside', ip: '203.0.113.9' },
            { host: 'portal.corp.internal', address, headerHost: 'portal.corp.internal', port: 80, path: '/' }
          );
          expect(outcome.kind).toBe('no-route');
        });

        it('老的 Ingress 下线了', () => {
          expect(list('Ingress', { namespace: 'payments' }).length).toBe(0);
        });

        it('ingress-nginx 的控制器也下线了', () => {
          const left = list('Deployment', { namespace: 'ingress-nginx' });
          expect(left.length).toBe(0);
        });
      });
    `),
  ],
  focus: ['correctness', 'resilience'],
  extension: t(
    code`
      Gateway API 相对 Ingress 最大的改进是**角色分离**：GatewayClass 归平台，
      Gateway 归集群管理员（决定端口、证书、暴露到哪个网段），HTTPRoute 归应用
      团队。Ingress 时代所有这些都挤在一个对象和一堆 annotation 里，
      于是「谁能改什么」根本没法划清。

      这一关里「内网还是公网」由 GatewayClass 背后的 EnvoyProxy 参数决定，
      应用团队写 HTTPRoute 时碰不到它 —— 这正是分离的价值：
      应用团队不可能不小心把自己暴露到公网上。
    `,
    code`
      The biggest improvement Gateway API makes over Ingress is **role separation**:
      GatewayClass belongs to the platform, Gateway to the cluster administrator
      (ports, certificates, which network it is exposed on), and HTTPRoute to the
      application team. Under Ingress all of that was crammed into one object and a
      pile of annotations, so "who may change what" could not be drawn at all.

      Here, internal-versus-public is decided by the EnvoyProxy parameters behind the
      GatewayClass, and the application team never touches it while writing an
      HTTPRoute. That is the point of the separation: an application team cannot
      accidentally publish itself to the internet.
    `
  ),
};

/* ------------------------------------------------------------------ */
/* 第 9 关                                                             */
/* ------------------------------------------------------------------ */

/** 前任手工造的证书，只放了叶子 —— 这是「链不完整」那个坑 */
const TLS_STARTER = code`
  apiVersion: gateway.networking.k8s.io/v1
  kind: Gateway
  metadata:
    name: corp-gw
    namespace: payments
  spec:
    gatewayClassName: envoy-internal
    listeners:
    - name: https
      port: 443
      protocol: HTTPS
      hostname: portal.corp.internal
      tls:
        mode: Terminate
        certificateRefs:
        - name: portal-tls-manual
    - name: http
      port: 80
      protocol: HTTP
      hostname: portal.corp.internal
`;

const TLS_REFERENCE = code`
  apiVersion: cert-manager.io/v1
  kind: Certificate
  metadata:
    name: portal
    namespace: payments
  spec:
    secretName: portal-tls
    duration: 2160h
    renewBefore: 720h
    commonName: portal.corp.internal
    dnsNames:
    - portal.corp.internal
    issuerRef:
      name: corp-ca
      kind: ClusterIssuer
  ---
  apiVersion: gateway.networking.k8s.io/v1
  kind: Gateway
  metadata:
    name: corp-gw
    namespace: payments
  spec:
    gatewayClassName: envoy-internal
    listeners:
    - name: https
      port: 443
      protocol: HTTPS
      hostname: portal.corp.internal
      tls:
        mode: Terminate
        certificateRefs:
        - name: portal-tls
    - name: http
      port: 80
      protocol: HTTP
      hostname: portal.corp.internal
`;

const stage9 = {
  id: 'certificates-and-pki',
  title: t('证书与 PKI', 'Certificates and PKI'),
  goal: t(
    code`
      门户要上 HTTPS。前任已经在 Gateway 上配了 443，用的是他手工造的一张证书
      （Secret \`portal-tls-manual\`）。但从跳板机访问的时候 curl 直接失败了，
      而他坚称「证书是对的，浏览器里能打开」。

      公司有自己的 PKI：一个根 CA \`Corp Root CA\`，下面一个签发用的中间 CA
      \`Corp Issuing CA\`。cert-manager 已经装好，ClusterIssuer \`corp-ca\`
      指向那个中间 CA。根 CA 已经装进这台跳板机的信任库了。

      ## 通关标准

      1. 先搞清楚手工那张证书到底哪里不对（\`openssl x509\` 与 \`openssl verify\`
         能把话说明白）；
      2. 用 cert-manager 签一张，Certificate 的 \`Ready\` 是 True；
      3. Gateway 的 443 用上新证书；
      4. **不加 \`-k\`** 的 \`curl https://portal.corp.internal/\` 返回 200；
      5. 证书有效期至少还剩 60 天。

      ## 会用到的命令

      \`\`\`bash
      kubectl get secret portal-tls-manual -n payments -o jsonpath='{.data.tls\.crt}' | base64 -d > /tmp/manual.pem
      openssl x509 -in /tmp/manual.pem -noout -text
      openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt /tmp/manual.pem
      kubectl get clusterissuer
      kubectl apply -f infra/tls.yaml
      kubectl describe certificate portal -n payments
      curl -v --resolve portal.corp.internal:443:<Gateway 地址> https://portal.corp.internal/
      \`\`\`
    `,
    code`
      The portal needs HTTPS. Your predecessor already configured port 443 on the
      Gateway using a certificate he made by hand (Secret \`portal-tls-manual\`).
      curl from the jump host fails outright, and he insists the certificate is fine
      because "it opens in the browser".

      The company runs its own PKI: a root CA \`Corp Root CA\` with an issuing
      intermediate \`Corp Issuing CA\` under it. cert-manager is installed and the
      ClusterIssuer \`corp-ca\` points at that intermediate. The root is already in
      this jump host's trust store.

      ## Done when

      1. you work out what is actually wrong with the hand-made certificate
         (\`openssl x509\` and \`openssl verify\` will say it plainly);
      2. cert-manager issues a replacement and the Certificate reports \`Ready\` True;
      3. the Gateway's port 443 uses the new certificate;
      4. \`curl https://portal.corp.internal/\` returns 200 **without \`-k\`**;
      5. the certificate has at least 60 days of validity left.

      ## Commands you will need

      \`\`\`bash
      kubectl get secret portal-tls-manual -n payments -o jsonpath='{.data.tls\.crt}' | base64 -d > /tmp/manual.pem
      openssl x509 -in /tmp/manual.pem -noout -text
      openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt /tmp/manual.pem
      kubectl get clusterissuer
      kubectl apply -f infra/tls.yaml
      kubectl describe certificate portal -n payments
      curl -v --resolve portal.corp.internal:443:<gateway address> https://portal.corp.internal/
      \`\`\`
    `
  ),
  checklist: [
    t('看懂手工证书哪里不对', 'Diagnose the hand-made certificate'),
    t('cert-manager 签出新证书并被 Gateway 用上', 'cert-manager issues one and the Gateway uses it'),
    t('不加 -k 也能通，有效期充足', 'Works without -k, with plenty of validity left'),
  ],
  hints: [
    t(
      '\`openssl verify\` 会直接说 \`unable to get local issuer certificate\` —— 意思是「顺着这张证书往上找不到签它的那一级」。',
      '\`openssl verify\` says \`unable to get local issuer certificate\` outright: it cannot find the certificate that signed this one.'
    ),
    t(
      '根 CA 在信任库里，签这张证书的却是中间 CA。\`tls.crt\` 里应该是**叶子 + 中间**两张，前任只放了一张。',
      'The root is trusted, but this certificate was signed by the intermediate. \`tls.crt\` should hold **leaf + intermediate**; your predecessor put in only one.'
    ),
    t(
      'cert-manager 签发时会自动把签发链接在叶子后面，所以用它就不会犯这个错。',
      'cert-manager appends the issuing chain after the leaf automatically, so using it avoids the mistake entirely.'
    ),
  ],
  pitfalls: [
    t(
      '「浏览器里能打开」不能作为证据。浏览器可能缓存过那张中间证书，或者会主动去补齐（AIA chasing）；curl、Go 写的服务、Java 写的服务都不会。这类「我这儿好好的」正是链不完整最典型的表现。',
      '"It opens in my browser" is not evidence. Browsers may have cached the intermediate or fetch it themselves (AIA chasing); curl, Go services, and Java services will not. "Works on my machine" is the signature symptom of an incomplete chain.'
    ),
    t(
      '加 \`-k\` 让它通过。那不是修好了，是把校验关掉了 —— 中间人攻击也一起放进来了。判定明确要求不加 \`-k\`。',
      'Adding \`-k\` makes it pass. That is not a fix, it is disabling verification, and it lets a man-in-the-middle in too. The grader requires no \`-k\`.'
    ),
    t(
      '把中间 CA 也塞进跳板机的信任库。这样确实能通，但你只修好了自己这一台 —— 集群里的服务、别人的机器全都还是坏的。证书链应该由服务端提供完整。',
      'Adding the intermediate to this jump host’s trust store. It works here and nowhere else: other machines and in-cluster callers still fail. The server is responsible for presenting a complete chain.'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    objects: [...GATEWAY_PLATFORM, ...CERT_MANAGER_PLATFORM, ...PORTAL_WORKLOAD, PORTAL_ROUTE],
    files: {
      '/root/infra/tls.yaml': TLS_STARTER,
    },
    referenceFiles: { '/root/infra/tls.yaml': TLS_REFERENCE },
    referenceCommands: [
      'kubectl apply -f /root/infra/tls.yaml',
    ],
  },
  specs: [
    spec('certificates-and-pki.spec.ts', code`
      import { get, list, sh } from '@ops/lab';

      const DAY = 24 * 60 * 60 * 1000;

      describe('证书与 PKI', () => {
        it('cert-manager 签出了证书，Ready 是 True', () => {
          const certificates = list('Certificate', { namespace: 'payments' });
          expect(certificates.length).toBe(1);
          const ready = certificates[0].status.conditions
            .find((entry) => entry.type === 'Ready');
          expect(ready.status).toBe('True');
        });

        it('Gateway 的 443 用的是 cert-manager 签的那张', () => {
          const gateway = list('Gateway', { namespace: 'payments' })[0];
          const https = gateway.spec.listeners.find((entry) => entry.protocol === 'HTTPS');
          expect(https).toBeTruthy();

          const reference = https.tls.certificateRefs[0].name;
          const certificate = list('Certificate', { namespace: 'payments' })[0];
          expect(reference).toBe(certificate.spec.secretName);
        });

        it('不加 -k 也能通，返回 200', async () => {
          const gateway = list('Gateway', { namespace: 'payments' })[0];
          const address = gateway.status.addresses[0].value;
          const result = await sh(
            'curl -s -o /dev/null -w %{http_code} --resolve portal.corp.internal:443:' + address
            + ' https://portal.corp.internal/'
          );
          expect(result.code).toBe(0);
          expect(result.stdout).toBe('200');
        });

        it('证书有效期至少还剩 60 天', () => {
          const certificate = list('Certificate', { namespace: 'payments' })[0];
          const notAfter = Date.parse(certificate.status.notAfter);
          const remaining = (notAfter - Date.parse('2026-03-02T09:00:00Z')) / DAY;
          expect(remaining >= 60).toBe(true);
        });

        it('没有靠把中间 CA 塞进本机信任库来蒙过去', async () => {
          // 信任库里只该有根，多出来的中间 CA 说明修的是自己这一台
          const bundle = await sh('grep -c BEGIN /etc/ssl/certs/ca-certificates.crt');
          expect(bundle.stdout.trim()).toBe('1');
        });
      });
    `),
  ],
  focus: ['correctness', 'resilience'],
  extension: t(
    code`
      「链不完整」之所以难查，是因为它**不是必然失败**。浏览器缓存过那张中间
      证书、或者按证书里的 AIA 扩展自己去下载，都会让它看起来是好的；而 curl、
      Go 与 Java 写的服务不会做这些事。于是现象是「我这儿好好的，你那儿不行」。

      判断的办法只有一个：把服务端实际发出来的那串证书拿出来看。
      \`openssl s_client -connect host:443 -showcerts\` 会把它们全打出来，
      数一数有几张，就知道链有没有断。
    `,
    code`
      An incomplete chain is hard to diagnose precisely because it does not always
      fail. A browser may have cached the intermediate, or fetch it itself through the
      AIA extension; curl, Go services, and Java services do neither. The result is
      "it works here and not there".

      There is only one reliable check: look at the certificates the server actually
      sends. \`openssl s_client -connect host:443 -showcerts\` prints all of them, and
      counting them tells you whether the chain is complete.
    `
  ),
};


/* ------------------------------------------------------------------ */
/* 第 10 关                                                            */
/* ------------------------------------------------------------------ */

/** 平台组准备好的 Cilium。装上它，NetworkPolicy 才真的拦包。 */
const CILIUM_MANIFEST = code`
  apiVersion: apps/v1
  kind: DaemonSet
  metadata:
    name: cilium
    namespace: kube-system
    labels:
      app.kubernetes.io/name: cilium
  spec:
    selector:
      matchLabels:
        app.kubernetes.io/name: cilium
    template:
      metadata:
        labels:
          app.kubernetes.io/name: cilium
      spec:
        containers:
        - name: cilium-agent
          image: ${CILIUM_IMAGE}
          ports:
          - containerPort: 9962
`;

/** 前任那条策略，原样导出来放在这里给你改 */
const NETPOL_STARTER = code`
  apiVersion: networking.k8s.io/v1
  kind: NetworkPolicy
  metadata:
    name: payments-lockdown
    namespace: payments
  spec:
    podSelector: {}
    policyTypes:
    - Ingress
    - Egress
    ingress:
    - from:
      - podSelector:
          matchLabels:
            app: portal
    egress: []
`;

const NETPOL_REFERENCE = code`
  apiVersion: networking.k8s.io/v1
  kind: NetworkPolicy
  metadata:
    name: portal
    namespace: payments
  spec:
    podSelector:
      matchLabels:
        app: portal
    policyTypes:
    - Ingress
    - Egress
    ingress:
    - from:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: envoy-gateway-system
    egress:
    - to:
      - podSelector:
          matchLabels:
            app: ledger
    - to:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: kube-system
      ports:
      - protocol: UDP
        port: 53
  ---
  apiVersion: networking.k8s.io/v1
  kind: NetworkPolicy
  metadata:
    name: ledger
    namespace: payments
  spec:
    podSelector:
      matchLabels:
        app: ledger
    policyTypes:
    - Ingress
    - Egress
    ingress:
    - from:
      - podSelector:
          matchLabels:
            app: portal
    egress:
    - to:
      - namespaceSelector:
          matchLabels:
            kubernetes.io/metadata.name: kube-system
      ports:
      - protocol: UDP
        port: 53
`;

const stage10 = {
  id: 'network-policy',
  title: t('网络策略：让它真的生效', 'Network Policy: Make It Actually Apply'),
  goal: t(
    code`
      安全评审提了一条：支付核心 \`ledger\` 只能被门户访问。前任在交接里写着
      「已加 NetworkPolicy」，\`kubectl get netpol -n payments\` 也确实看得见一条
      \`payments-lockdown\`。但审计的人从 \`analytics\` 命名空间的报表机上
      curl 了一下 ledger，通了。

      集群现在的 CNI 是 flannel。平台组把 Cilium 的清单放在
      \`/root/infra/cilium.yaml\` 了。

      **先把话说在前面**：策略一旦真的开始执行，前任那条会立刻生效 ——
      而它选中的是整个命名空间。装之前先读一遍它写了什么。

      ## 通关标准

      1. Cilium 装上，每个节点一份，全部 Ready；
      2. 从跳板机 \`curl https://portal.corp.internal/\` 仍然返回 200；
      3. 从门户的 Pod 里访问 \`http://ledger\` 通；
      4. 从 analytics 的报表 Pod 里访问 ledger **连不上**；
      5. ledger 的 Pod 里 DNS 还能用。

      ## 会用到的命令

      \`\`\`bash
      kubectl get netpol -A
      kubectl get ds -n kube-system
      kubectl apply -f /root/infra/cilium.yaml
      kubectl exec -n payments deploy/portal -- curl -s -m 5 http://ledger
      kubectl exec -n analytics deploy/reports -- curl -s -m 5 http://ledger.payments.svc.cluster.local
      kubectl exec -n payments deploy/ledger -- nslookup portal
      \`\`\`
    `,
    code`
      A security review says the payment core \`ledger\` must only be reachable from
      the portal. The handover claims "NetworkPolicy added", and
      \`kubectl get netpol -n payments\` does show a \`payments-lockdown\`. Yet the
      auditor curled ledger from the reports machine in the \`analytics\` namespace
      and it answered.

      The cluster currently runs flannel as its CNI. The platform team left a Cilium
      manifest at \`/root/infra/cilium.yaml\`.

      **Fair warning**: the moment policies actually get enforced, your predecessor's
      policy takes effect too, and it selects the whole namespace. Read it before you
      install anything.

      ## Done when

      1. Cilium is installed, one pod per node, all Ready;
      2. \`curl https://portal.corp.internal/\` from the jump host still returns 200;
      3. the portal's pods can reach \`http://ledger\`;
      4. the reports pod in analytics **cannot** reach ledger;
      5. DNS still works from ledger's pods.

      ## Commands you will need

      \`\`\`bash
      kubectl get netpol -A
      kubectl get ds -n kube-system
      kubectl apply -f /root/infra/cilium.yaml
      kubectl exec -n payments deploy/portal -- curl -s -m 5 http://ledger
      kubectl exec -n analytics deploy/reports -- curl -s -m 5 http://ledger.payments.svc.cluster.local
      kubectl exec -n payments deploy/ledger -- nslookup portal
      \`\`\`
    `
  ),
  checklist: [
    t('Cilium 装上，策略开始被执行', 'Cilium installed and policies enforced'),
    t('门户对外照常，ledger 只对门户开放', 'Portal still serves; ledger only accepts the portal'),
    t('DNS 没被 egress 规则误伤', 'DNS survives the egress rules'),
  ],
  hints: [
    t(
      '策略没生效不代表策略写错了。NetworkPolicy 是 apiserver 收下就完事的对象，拦不拦包看 CNI —— flannel 不做这件事，所以那条策略从写下去那天起就是一张废纸。',
      'A policy that does nothing is not necessarily a wrong policy. NetworkPolicy is just an object the apiserver accepts; whether packets get dropped is up to the CNI, and flannel does not implement it. That policy has been inert since the day it was written.'
    ),
    t(
      '`podSelector: {}` 选中的是命名空间里的**每一个** Pod，门户也在里面。门户的入向流量来自 Gateway 的数据面 Pod（在 \`envoy-gateway-system\` 里），不是 app=portal 的 Pod。',
      '`podSelector: {}` selects **every** pod in the namespace, the portal included. The portal’s inbound traffic comes from the Gateway’s data plane pods in \`envoy-gateway-system\`, not from pods labelled app=portal.'
    ),
    t(
      '一旦某个 Pod 被带 Egress 的策略选中，它的出向就变成默认拒绝 —— 包括查 DNS。放行 kube-system 的 53/UDP 几乎是每条 egress 策略都要写的一行。',
      'Once a pod is selected by any policy with Egress, its egress becomes default-deny, DNS included. Allowing UDP/53 to kube-system is a line almost every egress policy needs.'
    ),
  ],
  pitfalls: [
    t(
      '被拒绝的连接表现为**超时**，不是拒绝。策略是丢包，对面不会回 RST，所以 curl 会卡到超时才报错。看到 `Connection refused` 说明包到了对端而对端没在听，那是另一回事 —— 别拿它去查策略。',
      'A denied connection shows up as a **timeout**, not a refusal. Policies drop packets, so nothing sends an RST and curl hangs until it gives up. `Connection refused` means the packet arrived and nobody was listening, which is a different problem entirely; do not go looking at policies for it.'
    ),
    t(
      '为了让门户能通就把 `payments-lockdown` 的 ingress 加成 `from: []`（或者干脆删掉 policyTypes 里的 Ingress）。那等于把整个命名空间重新打开，ledger 又回到评审之前的样子。',
      'Opening the portal back up by giving `payments-lockdown` an empty `from` (or dropping Ingress from policyTypes). That reopens the entire namespace and puts ledger back where it was before the review.'
    ),
    t(
      '在 `analytics` 那边加一条 egress 策略来「禁止访问 ledger」。方向反了：那台机器不归你管，也随时可以被绕过。拒绝要写在**被保护的一侧**，ingress 上。',
      'Adding an egress policy in `analytics` to "forbid access to ledger". That is the wrong side: you do not control that namespace and the rule is trivially bypassed. Denial belongs on the **protected** side, in ingress.'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    objects: [
      CNI_FLANNEL,
      ...GATEWAY_PLATFORM, ...CERT_MANAGER_PLATFORM, ...TLS_PLATFORM,
      ...PORTAL_WORKLOAD, PORTAL_ROUTE,
      ...LEDGER_WORKLOAD, ...ANALYTICS_WORKLOAD,
      PREDECESSOR_POLICY,
    ],
    files: {
      '/root/infra/cilium.yaml': CILIUM_MANIFEST,
      '/root/infra/netpol.yaml': NETPOL_STARTER,
    },
    referenceFiles: { '/root/infra/netpol.yaml': NETPOL_REFERENCE },
    referenceCommands: [
      'kubectl apply -f /root/infra/cilium.yaml',
      'kubectl delete netpol payments-lockdown -n payments',
      'kubectl apply -f /root/infra/netpol.yaml',
    ],
  },
  specs: [
    spec('network-policy.spec.ts', code`
      import { list, sh } from '@ops/lab';

      describe('网络策略', () => {
        it('Cilium 每个节点一份，全部 Ready', () => {
          const nodes = list('Node').length;
          const enforcing = list('DaemonSet', { namespace: 'kube-system' })
            .filter((item) => item.spec.template.spec.containers
              .some((container) => container.image.includes('cilium')));
          expect(enforcing.length).toBe(1);
          expect(enforcing[0].status.desiredNumberScheduled).toBe(nodes);
          expect(enforcing[0].status.numberReady).toBe(nodes);
        });

        it('门户对外照常 —— 策略没把入口打死', async () => {
          const gateway = list('Gateway', { namespace: 'payments' })[0];
          const address = gateway.status.addresses[0].value;
          const result = await sh(
            'curl -s -o /dev/null -w %{http_code} --resolve portal.corp.internal:443:' + address
            + ' https://portal.corp.internal/'
          );
          expect(result.stdout).toBe('200');
        });

        it('门户访问得到 ledger', async () => {
          const result = await sh(
            'kubectl exec -n payments deploy/portal -- curl -s -m 5 -o /dev/null -w %{http_code} http://ledger'
          );
          expect(result.stdout).toBe('200');
        });

        it('analytics 的报表机访问不到 ledger', async () => {
          const result = await sh(
            'kubectl exec -n analytics deploy/reports -- '
            + 'curl -s -m 5 -o /dev/null -w %{http_code} http://ledger.payments.svc.cluster.local'
          );
          expect(result.stdout).not.toBe('200');
          // 策略是丢包：应该卡到超时（28），而不是被拒绝（7）
          expect(result.stderr).toContain('curl: (28)');
        });

        it('ledger 的 DNS 还能用', async () => {
          const result = await sh('kubectl exec -n payments deploy/ledger -- nslookup portal');
          expect(result.code).toBe(0);
        });

        it('拦住 analytics 靠的是策略，不是把两边拆了', () => {
          // 把报表机停掉、或者把 ledger 的后端摘空，上一条也会「通过」
          const reports = list('Deployment', { namespace: 'analytics' })
            .find((item) => item.metadata.name === 'reports');
          expect(reports.status.readyReplicas).toBeGreaterThan(0);

          const endpoints = list('Endpoints', { namespace: 'payments' })
            .find((item) => item.metadata.name === 'ledger');
          const addresses = (endpoints.subsets || [])
            .flatMap((subset) => subset.addresses || []);
          expect(addresses.length).toBe(2);
        });
      });
    `),
  ],
  focus: ['correctness', 'resilience'],
  extension: t(
    code`
      「加了策略但什么都没变」在真集群里非常常见，而且极难自查 ——
      apiserver 收下了对象，\`kubectl get netpol\` 看得见，\`describe\` 也漂亮，
      唯一缺的是那个会执行它的东西。判断的办法不是读策略，是发一个包：
      从一个**本该被拒绝**的地方连一次，看它是超时还是通。通了就说明没人执行。

      反过来，策略真的生效之后，第一个被打挂的往往不是攻击者而是自己。
      \`podSelector: {}\` 加 \`policyTypes: [Egress]\` 是一条能让整个命名空间
      连不上 DNS 的策略，而它看起来只是「先默认拒绝，再慢慢放行」。
      所以上线顺序应该反过来：先写放行规则，确认业务正常，最后才收紧默认。
    `,
    code`
      "We added a policy and nothing changed" is common in real clusters and very hard
      to self-diagnose: the apiserver accepted the object, \`kubectl get netpol\` shows
      it, \`describe\` looks fine, and the only missing piece is something that
      enforces it. The way to check is not to read the policy but to send a packet:
      connect from somewhere that **should** be denied and see whether it times out or
      answers. If it answers, nobody is enforcing.

      Conversely, once policies do take effect, the first thing they break is usually
      you. \`podSelector: {}\` with \`policyTypes: [Egress]\` is a policy that cuts an
      entire namespace off from DNS, and it reads like a reasonable "deny by default,
      allow later". So reverse the rollout order: write the allow rules first, confirm
      the workloads still work, and tighten the default last.
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
  stages: [stage1, stage2, stage3, stage4, stage5, stage6, stage7, stage8, stage9, stage10],
};
