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
const ARGOCD_IMAGE = 'quay.io/argoproj/argocd:v3.2.4';
const REPORTS_IMAGE_RC = 'harbor.corp.internal/team/reports:2.2.0-rc1';
// 第三方的对账 exporter。上游那个地址内网拉不到，只有 harbor 上的镜像能用。
const EXPORTER_UPSTREAM = 'quay.io/acme/settlement-exporter:1.4.2';
const EXPORTER_MIRROR = 'harbor.corp.internal/mirror/settlement-exporter:1.4.2';
const SESSIONS_IMAGE = 'harbor.corp.internal/team/sessions:1.8.0';
const ISTIOD_IMAGE = 'docker.io/istio/pilot:1.28.1';
const ZTUNNEL_IMAGE = 'docker.io/istio/ztunnel:1.28.1';
const KYVERNO_IMAGE = 'ghcr.io/kyverno/kyverno:v1.16.0';
// 一个从公网直接拿来的镜像，没人签过
const UNSIGNED_IMAGE = 'docker.io/library/redis:7.4';
const ESO_IMAGE = 'ghcr.io/external-secrets/external-secrets:v0.21.0';
const PROMETHEUS_IMAGE = 'quay.io/prometheus/prometheus:v3.9.1';
// 报表服务的一个坏版本：五分之一的请求 500
const REPORTS_IMAGE_BAD = 'harbor.corp.internal/team/reports:2.3.0';
const ROLLOUTS_IMAGE = 'quay.io/argoproj/argo-rollouts:v1.8.3';
// 门户的一个坏版本：进程活着、探针照过，六成请求 500
const PORTAL_IMAGE_BAD = 'harbor.corp.internal/team/portal:1.6.0';
const CSI_IMAGE = 'registry.k8s.io/sig-storage/csi-provisioner:v5.1.0';
const SNAPSHOT_IMAGE = 'registry.k8s.io/sig-storage/snapshot-controller:v8.2.0';
const VELERO_IMAGE = 'velero/velero:v1.16.1';
// 对账库。数据在盘上，不在镜像里 —— 这一关整关都建立在这个区别上。
const LEDGERDB_IMAGE = 'harbor.corp.internal/team/ledgerdb:14.2';
const CAPI_IMAGE = 'registry.k8s.io/cluster-api/cluster-api-controller:v1.9.4';
const AUTOSCALER_IMAGE = 'registry.k8s.io/autoscaling/cluster-autoscaler:v1.32.0';
// 月末结算：一批算得很重的活，跑完就散
const SETTLEMENT_IMAGE = 'harbor.corp.internal/team/settlement:2.1';
// 平台组自己写的 Operator。镜像里装的就是学员写的那段 reconcile。
const SITE_OPERATOR_IMAGE = 'harbor.corp.internal/platform/site-operator:0.1';

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

/** 平台仓库里门户的那份 manifest。集群里跑的应该和它一致。 */
const PORTAL_GITOPS_MANIFEST = code`
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
`;

const PORTAL_GITOPS_SERVICE = code`
  apiVersion: v1
  kind: Service
  metadata:
    name: portal
    namespace: payments
  spec:
    clusterIP: 10.96.1.10
    selector:
      app: portal
    ports:
    - port: 80
      targetPort: 8080
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
    'envoy-gateway-system', 'ingress-nginx', 'cert-manager', 'argocd', 'istio-system',
    'kyverno', 'external-secrets', 'monitoring', 'velero', 'capi-system', 'platform-system',
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
      requestsPerSecond: 40,
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
    [ARGOCD_IMAGE]: { pullMs: 500, startupMs: 700, readyAfterMs: 300, listens: [8080] },
    // 内网镜像仓库上的那份拷贝。上游的 quay.io 地址故意不在这张表里 ——
    // 内网拉不到外网，第 13 关整关就建立在这一点上。
    [EXPORTER_MIRROR]: {
      pullMs: 300, startupMs: 400, readyAfterMs: 200,
      listens: [9100], routes: { '/metrics': 200 }, memoryUsage: '120Mi',
    },
    // 服务网格的控制面与数据面
    [ISTIOD_IMAGE]: { pullMs: 600, startupMs: 900, readyAfterMs: 400, listens: [15012] },
    [ZTUNNEL_IMAGE]: { pullMs: 400, startupMs: 500, readyAfterMs: 200, listens: [15008] },
    [KYVERNO_IMAGE]: { pullMs: 500, startupMs: 700, readyAfterMs: 300, listens: [9443] },
    [ESO_IMAGE]: { pullMs: 400, startupMs: 600, readyAfterMs: 300, listens: [8080] },
    [PROMETHEUS_IMAGE]: { pullMs: 600, startupMs: 900, readyAfterMs: 400, listens: [9090] },
    [ROLLOUTS_IMAGE]: { pullMs: 400, startupMs: 600, readyAfterMs: 300 },
    [CSI_IMAGE]: { pullMs: 300, startupMs: 400, readyAfterMs: 200 },
    [SNAPSHOT_IMAGE]: { pullMs: 300, startupMs: 400, readyAfterMs: 200 },
    [VELERO_IMAGE]: { pullMs: 700, startupMs: 900, readyAfterMs: 400 },
    [CAPI_IMAGE]: { pullMs: 400, startupMs: 600, readyAfterMs: 300 },
    [AUTOSCALER_IMAGE]: { pullMs: 400, startupMs: 600, readyAfterMs: 300 },
    [SETTLEMENT_IMAGE]: { pullMs: 300, startupMs: 500, readyAfterMs: 200, memoryUsage: '256Mi' },
    [SITE_OPERATOR_IMAGE]: { pullMs: 300, startupMs: 400, readyAfterMs: 200, memoryUsage: '128Mi' },
    [LEDGERDB_IMAGE]: {
      pullMs: 800, startupMs: 1200, readyAfterMs: 600,
      listens: [5432], memoryUsage: '512Mi', handlesSigterm: true,
    },
    // 门户的下一个版本，好的那个
    [PORTAL_IMAGE_NEXT]: {
      pullMs: 400, startupMs: 600, readyAfterMs: 300,
      listens: [8080], routes: { '/': 200, '/healthz': 200, '/readyz': 200 },
      memoryUsage: '180Mi', handlesSigterm: true, runAsUser: 10001,
      requestsPerSecond: 40,
    },
    [PORTAL_IMAGE_BAD]: {
      pullMs: 400, startupMs: 600, readyAfterMs: 300,
      listens: [8080], routes: { '/': 200, '/healthz': 200, '/readyz': 200 },
      memoryUsage: '180Mi', handlesSigterm: true, runAsUser: 10001,
      // 坏在这里：探针全过，但六成请求 500。
      // 注意分析看到的是**混进去之后**的整体错误率：金丝雀只占一小部分流量，
      // 六成打到分母上摊完只剩不到一成 —— 这就是判据要写得比直觉严的原因。
      requestsPerSecond: 40, errorRatio: 0.6,
    },
    [REPORTS_IMAGE_BAD]: {
      pullMs: 500, startupMs: 800, readyAfterMs: 200,
      listens: [9090], routes: { '/healthz': 200, '/metrics': 200 },
      memoryUsage: '300Mi',
      // 坏就坏在这里：五分之一的请求返回 5xx，但进程活着、探针照过
      requestsPerSecond: 25, errorRatio: 0.2,
    },
    [UNSIGNED_IMAGE]: { pullMs: 300, startupMs: 400, readyAfterMs: 200, listens: [6379] },
    // 会话存储
    [SESSIONS_IMAGE]: {
      pullMs: 300, startupMs: 500, readyAfterMs: 200,
      listens: [8080], routes: { '/': 200, '/healthz': 200 }, memoryUsage: '160Mi',
    },
    // 报表服务的预发版本
    [REPORTS_IMAGE_RC]: {
      pullMs: 500, startupMs: 800, readyAfterMs: 200,
      listens: [9090], routes: { '/healthz': 200 }, memoryUsage: '300Mi',
    },
    // 财务的报表任务：吃 900Mi，limits 写小了就会被 OOMKill
    [REPORTS_IMAGE]: {
      pullMs: 500, startupMs: 800, readyAfterMs: 200,
      listens: [9090],
      routes: { '/healthz': 200, '/metrics': 200 },
      memoryUsage: '900Mi',
      requestsPerSecond: 25,
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
      projects: ['team', 'library', 'mirror'],
      anonymousPull: false,
    },
  ],
  /**
   * 集群认哪些身份。
   *
   * key 是 kubeconfig 里的 token。一旦声明了这张表，集群就开始按 RBAC 鉴权。
   * 前面十几关的 kubeconfig 用的是 admin 那把，所以行为不变。
   */
  users: {
    'admin-token': { username: 'kubernetes-admin', groups: ['system:masters'] },
    'opslab-token': { username: 'kubernetes-admin', groups: ['system:masters'] },
    // OIDC 发下来的：用户名带 issuer 前缀，组来自 id_token 里的 groups claim
    'oidc-liu': { username: 'oidc:liu@corp.internal', groups: ['oidc:developers'] },
    'oidc-chen': { username: 'oidc:chen@corp.internal', groups: ['oidc:sre'] },
    'ci-token': { username: 'system:serviceaccount:argocd:deployer', groups: ['system:serviceaccounts'] },
  },
  /**
   * 内网的密钥库。
   *
   * 真正的密钥住在这儿 —— 不在集群里，也不在 Git 仓库里。
   * 平台组已经把数据库口令放进去了，Kubernetes 认证还没开。
   */
  secretStore: {
    address: 'https://openbao.corp.internal:8200',
    data: {
      'kv/payments/db': {
        username: 'payments_app',
        password: 'Ph4i-Quee0oh',
        host: 'pg.corp.internal',
      },
    },
    policies: {
      'payments-read': { 'kv/payments/*': ['read', 'list'] },
    },
    // 平台组给运维发的 root 令牌。Kubernetes 认证还没开。
    tokens: { 'bao-root-token': 'root' },
  },
  // 内网的 Git 服务。平台仓库是「本来就在」的东西，第 11 关往后都从它来。
  gitRepositories: [
    {
      url: 'https://git.corp.internal/platform/apps',
      branch: 'main',
      message: 'bootstrap platform repo',
      files: {
        'README.md': [
          '# platform/apps',
          '',
          '集群里跑什么，以这个仓库为准。',
          '手工 kubectl apply 出来的东西迟早会被同步回来。',
          '',
        ].join('\n'),
        'apps/portal/deployment.yaml': PORTAL_GITOPS_MANIFEST,
        'apps/portal/service.yaml': PORTAL_GITOPS_SERVICE,
      },
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
    // Service 自己也带上 app 标签：ServiceMonitor 是按 Service 的标签选的，
    // 只在 spec.selector 里写 app 是选不中它的
    metadata: { name: 'portal', namespace: 'payments', labels: { app: 'portal' } },
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

/** 第 10 关之后集群里跑的是 Cilium */
const CNI_CILIUM = {
  apiVersion: 'apps/v1', kind: 'DaemonSet',
  metadata: {
    name: 'cilium', namespace: 'kube-system',
    labels: { 'app.kubernetes.io/name': 'cilium' },
  },
  spec: {
    selector: { matchLabels: { 'app.kubernetes.io/name': 'cilium' } },
    template: {
      metadata: { labels: { 'app.kubernetes.io/name': 'cilium' } },
      spec: { containers: [{ name: 'cilium-agent', image: CILIUM_IMAGE, ports: [{ containerPort: 9962 }] }] },
    },
  },
};

/** Argo CD：application controller 同样是集群里的一个工作负载 */
const ARGOCD_PLATFORM = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: {
      name: 'argocd-application-controller', namespace: 'argocd',
      labels: { 'app.kubernetes.io/name': 'argocd-application-controller' },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': 'argocd-application-controller' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'argocd-application-controller' } },
        spec: { containers: [{ name: 'controller', image: ARGOCD_IMAGE, ports: [{ containerPort: 8080 }] }] },
      },
    },
  },
  {
    apiVersion: 'argoproj.io/v1alpha1', kind: 'AppProject',
    metadata: { name: 'default', namespace: 'argocd' },
    spec: {
      sourceRepos: ['*'],
      destinations: [{ namespace: '*', server: 'https://kubernetes.default.svc' }],
    },
  },
];

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


/* ------------------------------------------------------------------ */
/* 第 11 关                                                            */
/* ------------------------------------------------------------------ */

/** 前任手工改的那份：副本数被临时调到 5，从来没回写仓库 */
const DRIFTED_PORTAL = {
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: { name: 'portal', namespace: 'payments' },
  spec: {
    replicas: 5,
    selector: { matchLabels: { app: 'portal' } },
    template: {
      metadata: { labels: { app: 'portal' } },
      spec: { containers: [{ name: 'web', image: PORTAL_IMAGE, ports: [{ containerPort: 8080 }] }] },
    },
  },
};

const APPLICATION_STARTER = code`
  apiVersion: argoproj.io/v1alpha1
  kind: Application
  metadata:
    name: portal
    namespace: argocd
  spec:
    project: default
    source:
      repoURL: https://git.corp.internal/platform/apps
      path: apps/portal
      targetRevision: main
    destination:
      server: https://kubernetes.default.svc
      namespace: payments
`;

const APPLICATION_REFERENCE = code`
  apiVersion: argoproj.io/v1alpha1
  kind: Application
  metadata:
    name: portal
    namespace: argocd
  spec:
    project: default
    source:
      repoURL: https://git.corp.internal/platform/apps
      path: apps/portal
      targetRevision: main
    destination:
      server: https://kubernetes.default.svc
      namespace: payments
    syncPolicy:
      automated:
        prune: true
        selfHeal: true
`;

const stage11 = {
  id: 'gitops-with-argocd',
  title: t('GitOps：让仓库说了算', 'GitOps: Let the Repository Decide'),
  goal: t(
    code`
      平台组要求所有服务改走 GitOps：集群里跑什么，以仓库
      \`https://git.corp.internal/platform/apps\` 为准。Argo CD 已经装好了。

      现在的状况是：仓库里门户写的是 2 个副本，集群里跑着 5 个 ——
      某次大促前任手工 \`kubectl scale\` 上去的，没回写仓库。谁也说不清
      还有多少这种改动。

      \`/root/infra/application.yaml\` 里是一份 Application 的草稿。

      ## 通关标准

      1. 门户由 Argo CD 管起来，\`kubectl get app -n argocd\` 里 \`Synced\` + \`Healthy\`；
      2. 集群里的副本数回到仓库写的那个；
      3. 之后再有人手工改，会被自己改回来（不需要人介入）；
      4. 想把副本数改成 3，得**通过仓库**改 —— 直接 kubectl 不算；
      5. 仓库里删掉的东西，集群里也要跟着消失。

      ## 会用到的命令

      \`\`\`bash
      git clone https://git.corp.internal/platform/apps
      kubectl apply -f /root/infra/application.yaml
      kubectl get app -n argocd
      kubectl describe app portal -n argocd
      kubectl patch app portal -n argocd --type merge -p '{"operation":{"sync":{}}}'
      \`\`\`
    `,
    code`
      The platform team wants every service on GitOps: what runs in the cluster is
      whatever \`https://git.corp.internal/platform/apps\` says. Argo CD is already
      installed.

      Right now the repository says two replicas for the portal and the cluster runs
      five, hand-scaled before a sale and never written back. Nobody knows how many
      other changes like that are out there.

      \`/root/infra/application.yaml\` holds a draft Application.

      ## Done when

      1. the portal is managed by Argo CD and \`kubectl get app -n argocd\` shows
         \`Synced\` and \`Healthy\`;
      2. the live replica count matches what the repository says;
      3. later hand edits get reverted automatically, with nobody in the loop;
      4. changing the count to three happens **through the repository**, not with
         kubectl;
      5. what is deleted from the repository disappears from the cluster.

      ## Commands you will need

      \`\`\`bash
      git clone https://git.corp.internal/platform/apps
      kubectl apply -f /root/infra/application.yaml
      kubectl get app -n argocd
      kubectl describe app portal -n argocd
      kubectl patch app portal -n argocd --type merge -p '{"operation":{"sync":{}}}'
      \`\`\`
    `
  ),
  checklist: [
    t('Application 建起来，Synced + Healthy', 'Application created, Synced and Healthy'),
    t('漂移被纠正，而且以后会自己纠正', 'Drift corrected, and stays corrected on its own'),
    t('改配置走仓库这条路', 'Configuration changes go through the repository'),
  ],
  hints: [
    t(
      '光建一个 Application 只会让它去**比对**，不会动手。\`kubectl get app\` 会显示 OutOfSync —— 那说明它看见了差异，在等你发话。',
      'Creating an Application only makes Argo CD **compare**; it will not act. `kubectl get app` shows OutOfSync, meaning it sees the difference and is waiting for you.'
    ),
    t(
      '自动同步分两层：\`syncPolicy.automated\` 让它在仓库变化时自己 apply；再加 \`selfHeal: true\` 才会把集群里的手改拉回来；\`prune: true\` 才会删掉仓库里已经没有的对象。三个开关管三件事。',
      'Automated sync has layers: `syncPolicy.automated` applies repository changes; `selfHeal: true` also pulls hand edits back; `prune: true` deletes objects that no longer exist in the repository. Three switches, three behaviours.'
    ),
    t(
      'Argo CD 看的是**远端仓库**。在跳板机上改完不 push，它什么都看不到。',
      'Argo CD reads the **remote** repository. Edits on the jump host that are not pushed are invisible to it.'
    ),
  ],
  pitfalls: [
    t(
      '把副本数用 \`kubectl scale\` 改成 3 就交差。开了 selfHeal 之后这个改动活不过一轮同步；没开的话它会一直挂着 OutOfSync，下一个人看到的仍然是「仓库和现实不一致」。GitOps 的意思就是这条路被堵死了。',
      'Scaling to three with `kubectl scale` and calling it done. With selfHeal on, the change does not survive one sync; with it off, the app sits OutOfSync and the next person still sees "repository and reality disagree". GitOps means that path is closed.'
    ),
    t(
      '在本地 commit 了但没 push。Argo CD 连的是远端 —— 本地仓库里的提交对它不存在。这个错很难自查，因为 \`git log\` 看起来一切正常。',
      'Committing locally without pushing. Argo CD talks to the remote, so a local commit does not exist as far as it is concerned. It is hard to spot because `git log` looks perfectly fine.'
    ),
    t(
      '看到 OutOfSync 就当成故障。它只说明现状和仓库不一致，服务可能好好的 —— 健康与否是 \`status.health\` 那一栏。两栏分别代表两件事，混在一起看会把「配置漂移」当成「服务挂了」。',
      'Treating OutOfSync as an outage. It only means live state differs from the repository; the service may be perfectly fine. Health is a separate column, and conflating the two turns "configuration drift" into "the service is down".'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    objects: [
      CNI_CILIUM,
      ...GATEWAY_PLATFORM, ...CERT_MANAGER_PLATFORM, ...TLS_PLATFORM, ...ARGOCD_PLATFORM,
      DRIFTED_PORTAL,
      {
        apiVersion: 'v1', kind: 'Service',
        metadata: { name: 'portal', namespace: 'payments' },
        spec: { clusterIP: '10.96.1.10', selector: { app: 'portal' }, ports: [{ port: 80, targetPort: 8080 }] },
      },
      PORTAL_ROUTE,
    ],
    files: {
      '/root/infra/application.yaml': APPLICATION_STARTER,
    },
    referenceFiles: { '/root/infra/application.yaml': APPLICATION_REFERENCE },
    referenceCommands: [
      'kubectl apply -f /root/infra/application.yaml',
    ],
  },
  specs: [
    spec('gitops-with-argocd.spec.ts', code`
      import { get, list, sh } from '@ops/lab';

      const REPO = 'https://git.corp.internal/platform/apps';

      describe('GitOps', () => {
        it('门户归 Argo CD 管，Synced + Healthy', () => {
          const application = get('Application', 'portal', 'argocd');
          expect(application).toBeTruthy();
          expect(application.status.sync.status).toBe('Synced');
          expect(application.status.health.status).toBe('Healthy');
        });

        it('集群里的副本数和仓库一致', async () => {
          const cloned = await sh('rm -rf /tmp/check && git clone ' + REPO + ' /tmp/check');
          expect(cloned.code).toBe(0);
          const manifest = await sh('grep -E "^  replicas:" /tmp/check/apps/portal/deployment.yaml');
          const wanted = Number(manifest.stdout.split(':')[1].trim());

          const deployment = get('Deployment', 'portal', 'payments');
          expect(deployment.spec.replicas).toBe(wanted);
        });

        it('手改会被改回去 —— 不需要人介入', async () => {
          await sh('kubectl scale deploy/portal -n payments --replicas=11');
          const deployment = get('Deployment', 'portal', 'payments');
          expect(deployment.spec.replicas).not.toBe(11);
        });

        it('仓库里删掉的对象，集群里也会消失', async () => {
          await sh('rm -rf /tmp/prune && git clone ' + REPO + ' /tmp/prune');
          await sh('cd /tmp/prune && rm apps/portal/service.yaml && git add -A'
            + ' && git commit -m "drop the service" && git push origin main');

          const services = list('Service', { namespace: 'payments' })
            .map((item) => item.metadata.name);
          expect(services).not.toContain('portal');
        });

        it('Argo CD 认的是远端仓库，不是跳板机上那个克隆', () => {
          const application = get('Application', 'portal', 'argocd');
          expect(application.spec.source.repoURL).toBe(REPO);
          // revision 是一个真的 commit sha，不是分支名
          expect(application.status.sync.revision).toMatch(/^[0-9a-f]{40}$/);
        });
      });
    `),
  ],
  focus: ['correctness', 'maintainability'],
  extension: t(
    code`
      GitOps 真正改变的不是部署方式，是**「现在到底跑着什么」这个问题的答案从哪里来**。
      在此之前答案只能从集群里问，而集群会被任何一个有权限的人改动，改动不留痕；
      之后答案在仓库里，有历史、有审核、能回滚。

      代价是那条手工通道被堵死了。开了 selfHeal 之后，\`kubectl edit\` 改的东西
      活不过一轮同步 —— 这对救火的人是个不小的调整。真集群里的做法是给
      Application 加 \`ignoreDifferences\`（哪些字段不比对，比如 HPA 管的副本数），
      而不是把 selfHeal 关掉。

      还有一个容易忽略的点：Argo CD 自己也应该由 Argo CD 管（app-of-apps）。
      不然升级 Argo CD 这件事本身就还是手工的，而它恰恰是最不该漂移的组件。
    `,
    code`
      What GitOps really changes is not how you deploy but **where the answer to
      "what is running right now" comes from**. Before, you could only ask the
      cluster, and the cluster can be changed by anyone with access, leaving no trace.
      After, the answer lives in a repository with history, review, and rollback.

      The price is that the manual path is closed. With selfHeal on, anything
      \`kubectl edit\` changes does not survive a sync, which is a real adjustment for
      whoever is firefighting. The production answer is to add
      \`ignoreDifferences\` to the Application for fields owned by something else
      (replica counts managed by an HPA, for instance) rather than turning selfHeal
      off.

      One more thing that is easy to miss: Argo CD should manage Argo CD (app of
      apps). Otherwise upgrading it stays a manual operation, and it is exactly the
      component that should never drift.
    `
  ),
};


/* ------------------------------------------------------------------ */
/* 第 12 关                                                            */
/* ------------------------------------------------------------------ */

/** 三份互相复制粘贴、已经漂了的 manifest */
const REPORTS_DEV = code`
  apiVersion: apps/v1
  kind: Deployment
  metadata:
    name: reports
    namespace: analytics
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
        - name: reports
          image: ${REPORTS_IMAGE_RC}
          ports:
          - containerPort: 9090
          resources:
            requests:
              memory: 256Mi
            limits:
              memory: 512Mi
`;

const REPORTS_STAGING = code`
  # 从 dev.yaml 复制过来的，改了副本数
  apiVersion: apps/v1
  kind: Deployment
  metadata:
    name: reports
    namespace: analytics
  spec:
    replicas: 2
    selector:
      matchLabels:
        app: reports
    template:
      metadata:
        labels:
          app: reports
      spec:
        containers:
        - name: reports
          image: ${REPORTS_IMAGE_RC}
          ports:
          - containerPort: 9090
          resources:
            requests:
              memory: 256Mi
            limits:
              memory: 512Mi
`;

const REPORTS_PROD = code`
  # 从 staging.yaml 复制过来的。资源忘了跟着调，镜像也还是老的。
  apiVersion: apps/v1
  kind: Deployment
  metadata:
    name: reports
    namespace: payments
  spec:
    replicas: 3
    selector:
      matchLabels:
        app: reports
    template:
      metadata:
        labels:
          app: reports
      spec:
        containers:
        - name: reports
          image: ${REPORTS_IMAGE}
          ports:
          - containerPort: 9090
          resources:
            requests:
              memory: 256Mi
            limits:
              memory: 512Mi
`;

/* 参考解：一个 chart + 两份 values */

const CHART_YAML = code`
  apiVersion: v2
  name: reports
  description: 财务报表服务
  type: application
  version: 0.1.0
  appVersion: "2.1.0"
`;

const CHART_VALUES = code`
  replicaCount: 1

  image:
    repository: harbor.corp.internal/team/reports
    tag: "2.1.0"

  service:
    port: 80
    targetPort: 9090

  resources:
    requests:
      memory: 512Mi
    limits:
      memory: 1Gi
`;

const CHART_HELPERS = code`
  {{/*
  名字跟着 release 走。写死的话同一个 chart 装两次就会互相覆盖。
  */}}
  {{- define "reports.fullname" -}}
  {{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
  {{- end -}}

  {{- define "reports.labels" -}}
  app.kubernetes.io/name: {{ .Chart.Name }}
  app.kubernetes.io/instance: {{ .Release.Name }}
  app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
  app.kubernetes.io/managed-by: {{ .Release.Service }}
  {{- end -}}

  {{- define "reports.selectorLabels" -}}
  app.kubernetes.io/name: {{ .Chart.Name }}
  app.kubernetes.io/instance: {{ .Release.Name }}
  {{- end -}}
`;

const CHART_DEPLOYMENT = code`
  apiVersion: apps/v1
  kind: Deployment
  metadata:
    name: {{ include "reports.fullname" . }}
    labels:
      {{- include "reports.labels" . | nindent 4 }}
  spec:
    replicas: {{ .Values.replicaCount }}
    selector:
      matchLabels:
        {{- include "reports.selectorLabels" . | nindent 6 }}
    template:
      metadata:
        labels:
          {{- include "reports.selectorLabels" . | nindent 8 }}
      spec:
        containers:
        - name: reports
          image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
          ports:
          - containerPort: {{ .Values.service.targetPort }}
          resources:
            {{- toYaml .Values.resources | nindent 10 }}
`;

const CHART_SERVICE = code`
  apiVersion: v1
  kind: Service
  metadata:
    name: {{ include "reports.fullname" . }}
    labels:
      {{- include "reports.labels" . | nindent 4 }}
  spec:
    selector:
      {{- include "reports.selectorLabels" . | nindent 4 }}
    ports:
    - port: {{ .Values.service.port }}
      targetPort: {{ .Values.service.targetPort }}
`;

const VALUES_STAGING = code`
  replicaCount: 1
  image:
    tag: "2.2.0-rc1"
  resources:
    requests:
      memory: 256Mi
    limits:
      memory: 512Mi
`;

const VALUES_PROD = code`
  replicaCount: 3
  image:
    tag: "2.1.0"
  resources:
    requests:
      memory: 1Gi
    limits:
      memory: 2Gi
`;

const stage12 = {
  id: 'helm-chart',
  title: t('把三份复制粘贴收成一个 chart', 'Fold Three Copies Into One Chart'),
  goal: t(
    code`
      报表服务现在有三份 manifest：\`/root/manifests/\` 下的 dev、staging、prod。
      它们是互相复制粘贴出来的，已经漂了 —— prod 的资源限制没跟着调，
      镜像也还停在老版本。每加一个环境就再复制一份，这条路走不下去了。

      把它做成一个 Helm chart：一份模板，环境差异全部落在 values 里。

      ## 通关标准

      1. \`/root/charts/reports\` 是个能过 \`helm lint\` 的 chart；
      2. 用它装两个 release：\`reports-staging\`（analytics 命名空间）和
         \`reports-prod\`（payments 命名空间），两个都 deployed、Pod 都起来；
      3. 两个 release 的对象**不能撞名字** —— 名字要跟着 release 走；
      4. 副本数、镜像 tag、资源都从 values 来，模板里不许写死
         （判定会用别的 values 渲染一遍，看值有没有跟着变）；
      5. prod 3 个副本 / 2Gi 上限，staging 1 个副本 / 512Mi 上限。

      ## 会用到的命令

      \`\`\`bash
      helm create reports                # 想从脚手架开始的话
      helm lint ./charts/reports
      helm template reports-prod ./charts/reports -f ./charts/values-prod.yaml
      helm install reports-prod ./charts/reports -n payments -f ./charts/values-prod.yaml
      helm list -A
      \`\`\`
    `,
    code`
      The reports service has three manifests today: dev, staging, and prod under
      \`/root/manifests/\`. They were copied from one another and have drifted: prod
      never got its resource limits updated and still runs an older image. Adding an
      environment means copying again, and that road ends here.

      Turn it into a Helm chart: one template, with every environment difference
      living in values.

      ## Done when

      1. \`/root/charts/reports\` is a chart that passes \`helm lint\`;
      2. two releases are installed from it: \`reports-staging\` in the analytics
         namespace and \`reports-prod\` in payments, both deployed with running pods;
      3. the two releases' objects **do not collide**: names follow the release;
      4. replica count, image tag, and resources all come from values, with nothing
         hardcoded in the templates (the grader renders with different values and
         checks the output follows);
      5. prod runs 3 replicas with a 2Gi limit, staging 1 replica with 512Mi.

      ## Commands you will need

      \`\`\`bash
      helm create reports                # if you want the scaffold
      helm lint ./charts/reports
      helm template reports-prod ./charts/reports -f ./charts/values-prod.yaml
      helm install reports-prod ./charts/reports -n payments -f ./charts/values-prod.yaml
      helm list -A
      \`\`\`
    `
  ),
  checklist: [
    t('chart 能过 lint，渲染得出正确的对象', 'Chart lints clean and renders correct objects'),
    t('两个环境各一个 release，互不干扰', 'One release per environment, no interference'),
    t('环境差异全在 values 里', 'Every environment difference lives in values'),
  ],
  hints: [
    t(
      '\`helm template <release> <chart> -f <values>\` 只渲染不安装，先用它把模板调对，再去 install。渲染出来的 YAML 直接读就行。',
      '`helm template <release> <chart> -f <values>` renders without installing. Get the template right with it first, then install. The rendered YAML is meant to be read.'
    ),
    t(
      '对象名字里要带 \`.Release.Name\`。写死成 \`reports\` 的话，第二个 release 会把第一个的对象改掉 —— 而且 helm 不会拦你。',
      'Object names must include `.Release.Name`. Hardcode `reports` and the second release rewrites the first release’s objects, and Helm will not stop you.'
    ),
    t(
      '\`{{- \` 和 \` -}}\` 是空白控制。\`nindent N\` 会先换行再按 N 空格缩进，套在 \`include\` 或 \`toYaml\` 外面正好。缩进错了 \`helm template\` 会直接报 YAML 解析失败，那反而是好事。',
      '`{{- ` and ` -}}` control whitespace. `nindent N` inserts a newline then indents by N, which is exactly what you want around `include` or `toYaml`. Wrong indentation makes `helm template` fail to parse, which is the good outcome.'
    ),
  ],
  pitfalls: [
    t(
      '把两个环境做成两个 chart。那只是把复制粘贴换了个地方 —— 模板还是两份，还是会漂。差异应该只存在于 values 里。',
      'Making two charts, one per environment. That just relocates the copy-paste: still two templates, still drifting. The difference belongs in values only.'
    ),
    t(
      '名字写死。两个 release 装进同一个命名空间时会互相覆盖，装进不同命名空间时看起来没事 —— 直到有人把它们放到一起。判定会用两个不同的 release 名渲染，比较对象名。',
      'Hardcoded names. Two releases in the same namespace overwrite each other; in different namespaces it looks fine until someone colocates them. The grader renders with two release names and compares.'
    ),
    t(
      '把值写进模板、只把 \`values.yaml\` 当摆设。\`helm template ... --set replicaCount=7\` 出来的还是原来那个数，就说明这条路没通。',
      'Baking values into the template and leaving `values.yaml` decorative. If `helm template ... --set replicaCount=7` still prints the old number, the wiring is not there.'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    objects: [
      CNI_CILIUM,
      ...GATEWAY_PLATFORM, ...CERT_MANAGER_PLATFORM, ...TLS_PLATFORM,
      ...PORTAL_WORKLOAD, PORTAL_ROUTE,
    ],
    files: {
      '/root/manifests/dev.yaml': REPORTS_DEV,
      '/root/manifests/staging.yaml': REPORTS_STAGING,
      '/root/manifests/prod.yaml': REPORTS_PROD,
    },
    referenceFiles: {
      '/root/charts/reports/Chart.yaml': CHART_YAML,
      '/root/charts/reports/values.yaml': CHART_VALUES,
      '/root/charts/reports/templates/_helpers.tpl': CHART_HELPERS,
      '/root/charts/reports/templates/deployment.yaml': CHART_DEPLOYMENT,
      '/root/charts/reports/templates/service.yaml': CHART_SERVICE,
      '/root/charts/values-staging.yaml': VALUES_STAGING,
      '/root/charts/values-prod.yaml': VALUES_PROD,
    },
    referenceCommands: [
      'helm install reports-staging /root/charts/reports -n analytics -f /root/charts/values-staging.yaml',
      'helm install reports-prod /root/charts/reports -n payments -f /root/charts/values-prod.yaml',
    ],
  },
  specs: [
    spec('helm-chart.spec.ts', code`
      import { list, sh } from '@ops/lab';

      const CHART = '/root/charts/reports';

      describe('Helm chart', () => {
        it('chart 过 lint', async () => {
          const result = await sh('helm lint ' + CHART);
          expect(result.code).toBe(0);
          expect(result.stdout).toContain('0 chart(s) failed');
        });

        it('两个 release 都装上了', async () => {
          const result = await sh('helm list -A');
          expect(result.stdout).toContain('reports-staging');
          expect(result.stdout).toContain('reports-prod');
          // 两行都得是 deployed，failed 不算
          expect(result.stdout.split('\\n').filter((line) => line.includes('reports-')).length).toBe(2);
          expect(result.stdout).not.toContain('failed');
        });

        it('两个环境的 Pod 都跑起来了', () => {
          const running = (namespace) => list('Pod', { namespace })
            .filter((pod) => pod.status.phase === 'Running'
              && (pod.metadata.labels || {})['app.kubernetes.io/name'] === 'reports');
          expect(running('analytics').length).toBe(1);
          expect(running('payments').length).toBe(3);
        });

        it('prod 与 staging 的资源上限来自各自的 values', () => {
          const limitOf = (namespace) => {
            const deployment = list('Deployment', { namespace })
              .find((item) => (item.spec.template.metadata.labels || {})['app.kubernetes.io/name'] === 'reports');
            return deployment.spec.template.spec.containers[0].resources.limits.memory;
          };
          expect(limitOf('payments')).toBe('2Gi');
          expect(limitOf('analytics')).toBe('512Mi');
        });

        it('对象名字跟着 release 走，两个 release 不撞', async () => {
          const one = await sh('helm template alpha ' + CHART);
          const two = await sh('helm template beta ' + CHART);
          expect(one.code).toBe(0);
          expect(two.code).toBe(0);
          const names = (text) => text.split('\\n')
            .filter((line) => line.startsWith('  name:'))
            .map((line) => line.slice('  name:'.length).trim());
          const first = names(one.stdout);
          const second = names(two.stdout);
          expect(first.length).toBeGreaterThan(0);
          for (const name of first) expect(second).not.toContain(name);
        });

        it('值确实从 values 来，不是写死在模板里', async () => {
          const rendered = await sh(
            'helm template probe ' + CHART
            + ' --set replicaCount=7 --set image.tag=9.9.9-probe'
          );
          expect(rendered.code).toBe(0);
          expect(rendered.stdout).toContain('replicas: 7');
          expect(rendered.stdout).toContain(':9.9.9-probe');
        });

        it('没有靠三份 chart 蒙过去 —— 只能有一个', async () => {
          const found = await sh('find /root/charts -name Chart.yaml');
          expect(found.stdout.trim().split('\\n').filter(Boolean).length).toBe(1);
        });
      });
    `),
  ],
  focus: ['maintainability', 'correctness'],
  extension: t(
    code`
      Helm 最容易被误解的一点：它不是「模板引擎 + kubectl apply」，
      它还记着**这一次 release 渲染出了哪些对象**。所以 \`helm upgrade\` 之后
      上一版有、这一版没有的对象会被删掉，\`helm uninstall\` 能把一整套收干净。
      这份记录存在集群里（一个 Secret），不在你的机器上 —— 换台机器接着管同一个
      release 是可以的。

      另一点是**渲染发生在客户端**。\`helm template\` 出来的 YAML 就是最终会被
      apply 的东西，没有任何服务端魔法。所以排查模板问题永远从 \`helm template\`
      开始，而不是装上去再看集群 —— 后者把「模板错了」和「集群拒绝了」混在了一起。
    `,
    code`
      The most misunderstood thing about Helm: it is not "a template engine plus
      kubectl apply". It also records **which objects this release rendered**. That is
      why \`helm upgrade\` deletes objects the previous revision had and this one does
      not, and why \`helm uninstall\` can clean up a whole set. The record lives in the
      cluster (a Secret), not on your machine, so someone else can manage the same
      release from another laptop.

      The other point is that **rendering happens client-side**. The YAML from
      \`helm template\` is exactly what gets applied; there is no server-side magic.
      So template debugging always starts at \`helm template\`, never at installing and
      then inspecting the cluster, which conflates "the template is wrong" with "the
      cluster rejected it".
    `
  ),
};


/* ------------------------------------------------------------------ */
/* 第 13 关                                                            */
/* ------------------------------------------------------------------ */

/** 供应商给的原样 manifest。这两个文件不许改。 */
const EXPORTER_BASE_KUSTOMIZATION = code`
  resources:
  - deployment.yaml
  - service.yaml
`;

const EXPORTER_BASE_DEPLOYMENT = code`
  # 由 ACME 提供，随产品升级一起替换。不要在这里改任何东西。
  apiVersion: apps/v1
  kind: Deployment
  metadata:
    name: settlement-exporter
    labels:
      app: settlement-exporter
  spec:
    replicas: 1
    selector:
      matchLabels:
        app: settlement-exporter
    template:
      metadata:
        labels:
          app: settlement-exporter
      spec:
        containers:
        - name: exporter
          image: ${EXPORTER_UPSTREAM}
          ports:
          - containerPort: 9100
          resources:
            requests:
              memory: 128Mi
            limits:
              memory: 256Mi
`;

const EXPORTER_BASE_SERVICE = code`
  # 由 ACME 提供，随产品升级一起替换。不要在这里改任何东西。
  apiVersion: v1
  kind: Service
  metadata:
    name: settlement-exporter
  spec:
    selector:
      app: settlement-exporter
    ports:
    - port: 9100
      targetPort: 9100
`;

const OVERLAY_STARTER = code`
  # 把公司的要求写在这里，别去动 base/
  resources:
  - ../../base
`;

const OVERLAY_REFERENCE = code`
  namespace: analytics

  resources:
  - ../../base

  # 公司要求所有平台维护的东西都带上归属标签
  labels:
  - pairs:
      corp.internal/owner: platform
    includeSelectors: false

  # 内网拉不到 quay.io，换成 harbor 上的那份拷贝
  images:
  - name: quay.io/acme/settlement-exporter
    newName: harbor.corp.internal/mirror/settlement-exporter

  replicas:
  - name: settlement-exporter
    count: 2

  patches:
  - path: proxy-env.yaml
`;

const OVERLAY_PATCH_REFERENCE = code`
  apiVersion: apps/v1
  kind: Deployment
  metadata:
    name: settlement-exporter
  spec:
    template:
      spec:
        containers:
        # name 是这个列表的 merge key。漏了它，整个 containers 会被替换成
        # 只有这一项的新列表 —— 镜像、端口、资源全没了，而且不报错。
        - name: exporter
          env:
          - name: HTTPS_PROXY
            value: http://proxy.corp.internal:3128
`;

const stage13 = {
  id: 'kustomize-overlays',
  title: t('改别人的 manifest，但不动它', 'Change Someone Else’s Manifest Without Touching It'),
  goal: t(
    code`
      财务上了一套第三方的对账 exporter，供应商给的 manifest 在
      \`/root/k8s/base/\`。这份东西会随产品升级整体替换，**你在里面改的任何
      东西下次升级都会没**。

      公司这边有四条要求：

      - 跑在 \`analytics\` 命名空间；
      - 所有对象带上 \`corp.internal/owner: platform\` 标签；
      - 镜像换成内网 harbor 上的那份拷贝（\`quay.io\` 内网根本拉不到）；
      - 副本数 2，并且容器要带上 \`HTTPS_PROXY=http://proxy.corp.internal:3128\`。

      \`/root/k8s/overlays/prod/\` 下有一个空壳 kustomization。

      ## 通关标准

      1. \`kubectl kustomize k8s/overlays/prod\` 渲染得出来；
      2. \`k8s/base/\` 下的文件**一个字都没改**；
      3. apply 之后 Pod 真的跑起来（说明镜像换对了）；
      4. 四条要求都落到了集群里的对象上；
      5. base 里原有的端口与资源限制还在。

      ## 会用到的命令

      \`\`\`bash
      kubectl kustomize k8s/overlays/prod
      kubectl apply -k k8s/overlays/prod
      kubectl get deploy -n analytics -o yaml
      \`\`\`
    `,
    code`
      Finance brought in a third-party settlement exporter. The vendor's manifests are
      in \`/root/k8s/base/\`. That directory gets replaced wholesale on every product
      upgrade, so **anything you edit inside it disappears next time**.

      Four company requirements:

      - run in the \`analytics\` namespace;
      - every object carries the \`corp.internal/owner: platform\` label;
      - the image comes from the internal harbor mirror (\`quay.io\` is unreachable
        from the intranet);
      - two replicas, and the container gets
        \`HTTPS_PROXY=http://proxy.corp.internal:3128\`.

      There is an empty kustomization under \`/root/k8s/overlays/prod/\`.

      ## Done when

      1. \`kubectl kustomize k8s/overlays/prod\` renders;
      2. nothing under \`k8s/base/\` has been edited, not one character;
      3. the pods actually run after you apply (which proves the image was rewritten);
      4. all four requirements show up on the live objects;
      5. the ports and resource limits from the base are still there.

      ## Commands you will need

      \`\`\`bash
      kubectl kustomize k8s/overlays/prod
      kubectl apply -k k8s/overlays/prod
      kubectl get deploy -n analytics -o yaml
      \`\`\`
    `
  ),
  checklist: [
    t('overlay 渲染得出来，base 一个字没改', 'The overlay renders and the base is untouched'),
    t('四条要求都落到了集群里', 'All four requirements land on the live objects'),
    t('base 原有的字段没被冲掉', 'Fields from the base survive the patch'),
  ],
  hints: [
    t(
      'kustomize 不是模板引擎，它是对 YAML 做结构化修改。所以 base 本身就是能直接 apply 的合法 manifest —— 这也是它能改第三方东西的原因：你不需要对方配合。',
      'Kustomize is not a template engine; it edits YAML structurally. That is why a base is a valid, directly appliable manifest, and why it can modify third-party content: the other side does not have to cooperate.'
    ),
    t(
      '有些改动不用写 patch：\`namespace\`、\`labels\`、\`images\`、\`replicas\` 都是 kustomization 里的一行声明。只有它们表达不了的（比如往容器里加 env）才需要 \`patches\`。',
      'Several changes need no patch at all: `namespace`, `labels`, `images`, and `replicas` are one-line declarations in the kustomization. Reach for `patches` only for what they cannot express, such as adding an env var to a container.'
    ),
    t(
      'patch 一个列表里的元素时，必须带上它的 merge key。容器列表的 merge key 是 \`name\`。渲染完先自己看一眼 \`containers\` 还剩什么。',
      'When patching an element inside a list you must include its merge key. For containers that key is `name`. After rendering, look at what is left under `containers`.'
    ),
  ],
  pitfalls: [
    t(
      '直接改 \`base/deployment.yaml\`。这一关确实会因此「通过」大部分检查，但判定专门查了 base 有没有被动过 —— 因为下次供应商升级，你的改动会连同整个目录一起被替换掉，而没有人会记得。',
      'Editing `base/deployment.yaml` directly. It would satisfy most checks, and the grader specifically looks at whether the base changed, because the next vendor upgrade replaces that whole directory and nobody will remember your edit.'
    ),
    t(
      'patch 容器时漏写 \`name\`。kustomize 不会报错，它会把整个 \`containers\` 列表替换成你写的那一项 —— 渲染出来 \`containers: []\` 或者只剩一个没有镜像的容器。这是 kustomize 最经典的一个坑。',
      'Omitting `name` when patching a container. Kustomize does not complain; it replaces the entire `containers` list with what you wrote, so the render ends up with `containers: []` or a single container with no image. This is the classic kustomize trap.'
    ),
    t(
      '把 base 整个复制一份到 overlay 里再改。那样 overlay 就不再跟着上游走了，供应商修了 bug 你也拿不到。overlay 应该只写差异。',
      'Copying the whole base into the overlay and editing the copy. The overlay then stops tracking upstream, so vendor bug fixes never reach you. An overlay should contain only the difference.'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    objects: [
      CNI_CILIUM,
      ...GATEWAY_PLATFORM, ...CERT_MANAGER_PLATFORM, ...TLS_PLATFORM,
      ...PORTAL_WORKLOAD, PORTAL_ROUTE,
    ],
    files: {
      '/root/k8s/base/kustomization.yaml': EXPORTER_BASE_KUSTOMIZATION,
      '/root/k8s/base/deployment.yaml': EXPORTER_BASE_DEPLOYMENT,
      '/root/k8s/base/service.yaml': EXPORTER_BASE_SERVICE,
      '/root/k8s/overlays/prod/kustomization.yaml': OVERLAY_STARTER,
    },
    referenceFiles: {
      '/root/k8s/overlays/prod/kustomization.yaml': OVERLAY_REFERENCE,
      '/root/k8s/overlays/prod/proxy-env.yaml': OVERLAY_PATCH_REFERENCE,
    },
    referenceCommands: [
      'kubectl apply -k /root/k8s/overlays/prod',
    ],
  },
  specs: [
    spec('kustomize-overlays.spec.ts', code`
      import { list, readFile, sh } from '@ops/lab';

      describe('kustomize overlay', () => {
        it('overlay 渲染得出来', async () => {
          const result = await sh('kubectl kustomize /root/k8s/overlays/prod');
          expect(result.code).toBe(0);
          expect(result.stdout).toContain('kind: Deployment');
        });

        it('base 一个字都没改', () => {
          const deployment = readFile('/root/k8s/base/deployment.yaml');
          // 上游的镜像地址与副本数还是原来的
          expect(deployment).toContain('image: quay.io/acme/settlement-exporter:1.4.2');
          expect(deployment).toContain('replicas: 1');
          // 公司的要求一条都不该出现在 base 里
          expect(deployment).not.toContain('harbor.corp.internal');
          expect(deployment).not.toContain('HTTPS_PROXY');
          expect(deployment).not.toContain('corp.internal/owner');
          expect(readFile('/root/k8s/base/service.yaml')).not.toContain('corp.internal/owner');
        });

        it('Pod 真的跑起来了 —— 镜像换对了', () => {
          const running = list('Pod', { namespace: 'analytics' })
            .filter((pod) => pod.status.phase === 'Running'
              && (pod.metadata.labels || {}).app === 'settlement-exporter');
          expect(running.length).toBe(2);
        });

        it('四条要求都落到了集群里', () => {
          const deployment = list('Deployment', { namespace: 'analytics' })
            .find((item) => item.metadata.name.includes('settlement-exporter'));
          expect(deployment).toBeTruthy();
          expect(deployment.metadata.labels['corp.internal/owner']).toBe('platform');
          expect(deployment.spec.replicas).toBe(2);

          const container = deployment.spec.template.spec.containers[0];
          expect(container.image).toContain('harbor.corp.internal/mirror/settlement-exporter');
          const proxy = (container.env || []).find((entry) => entry.name === 'HTTPS_PROXY');
          expect(proxy.value).toBe('http://proxy.corp.internal:3128');
        });

        it('base 里原有的端口与资源还在 —— patch 没把容器列表冲掉', () => {
          const deployment = list('Deployment', { namespace: 'analytics' })
            .find((item) => item.metadata.name.includes('settlement-exporter'));
          const container = deployment.spec.template.spec.containers[0];
          expect(container.ports[0].containerPort).toBe(9100);
          expect(container.resources.limits.memory).toBe('256Mi');
        });

        it('overlay 里没有把 base 复制一份', () => {
          const overlay = readFile('/root/k8s/overlays/prod/kustomization.yaml');
          expect(overlay).toContain('../../base');
        });
      });
    `),
  ],
  focus: ['maintainability', 'correctness'],
  extension: t(
    code`
      Helm 和 kustomize 常被拿来比，但它们解决的其实不是同一个问题。
      Helm 要求**被打包的一方**先把参数挖好（\`{{ .Values.x }}\`），你只能改
      对方想到的那些点；kustomize 不需要对方配合，任何一份 YAML 都能被 patch。
      所以「自己的服务」适合 chart，「别人的东西」适合 overlay。

      真集群里两者常常叠着用：\`helm template\` 渲染出 YAML，再交给 kustomize
      加一层公司的规矩（统一标签、镜像仓库改写、注入 sidecar）。Argo CD 直接
      支持这种组合。

      另外值得记住的是 kustomize 的 patch 有两种：strategic merge patch
      （像上面那样写一份不完整的 YAML）和 JSON patch（\`op/path/value\`，
      \`patches\` 里带 \`target\` 与 \`patch\`）。前者读起来自然，但列表的行为
      取决于 merge key；后者啰嗦，但对列表的操作是精确的 ——
      \`/spec/template/spec/containers/0/env/-\` 明确说了「追加到第 0 个容器的
      env 末尾」，不存在猜的余地。
    `,
    code`
      Helm and kustomize get compared constantly, but they solve different problems.
      Helm requires **the packager** to have anticipated the parameter
      (\`{{ .Values.x }}\`); you can only change what they thought of. Kustomize needs
      no cooperation: any YAML can be patched. So charts suit your own services, and
      overlays suit other people's.

      Real clusters often stack both: \`helm template\` renders YAML, then kustomize
      layers on company rules (standard labels, registry rewriting, sidecar
      injection). Argo CD supports that combination directly.

      Worth remembering too: kustomize has two kinds of patch. A strategic merge patch
      is the partial YAML shown above, natural to read but with list behaviour that
      depends on merge keys. A JSON patch (\`op\`/\`path\`/\`value\`, written with
      \`target\` and \`patch\`) is more verbose but precise about lists:
      \`/spec/template/spec/containers/0/env/-\` says exactly "append to the env of
      container zero", with nothing left to infer.
    `
  ),
};


/* ------------------------------------------------------------------ */
/* 第 14 关                                                            */
/* ------------------------------------------------------------------ */

/** 会话存储。Service 的 selector 打错了，于是没有后端。 */
const SESSIONS_WORKLOAD = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'sessions', namespace: 'payments' },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: 'sessions' } },
      template: {
        metadata: { labels: { app: 'sessions' } },
        spec: { containers: [{ name: 'app', image: SESSIONS_IMAGE, ports: [{ containerPort: 8080 }] }] },
      },
    },
  },
  {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name: 'sessions', namespace: 'payments' },
    // 上一次重构把 Deployment 的标签从 session-store 改成了 sessions，
    // Service 这边忘了跟着改
    spec: { selector: { app: 'session-store' }, ports: [{ port: 80, targetPort: 8080 }] },
  },
];

/** 路由的 hostname 写反了：portal.internal.corp */
const BROKEN_ROUTE = {
  apiVersion: 'gateway.networking.k8s.io/v1', kind: 'HTTPRoute',
  metadata: { name: 'portal', namespace: 'payments' },
  spec: {
    parentRefs: [{ name: 'corp-gw' }],
    hostnames: ['portal.internal.corp'],
    rules: [{
      matches: [{ path: { type: 'PathPrefix', value: '/' } }],
      backendRefs: [{ name: 'portal', port: 80 }],
    }],
  },
};

/** 只放行 reports —— 但门户的标签是 portal */
const LEDGER_POLICY = {
  apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
  metadata: { name: 'ledger', namespace: 'payments' },
  spec: {
    podSelector: { matchLabels: { app: 'ledger' } },
    policyTypes: ['Ingress'],
    ingress: [{ from: [{ podSelector: { matchLabels: { app: 'reports' } } }] }],
  },
};

const TRIAGE_REFERENCE = code`
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
    ingress:
    - from:
      - podSelector:
          matchLabels:
            app: portal
  ---
  apiVersion: v1
  kind: Service
  metadata:
    name: sessions
    namespace: payments
  spec:
    selector:
      app: sessions
    ports:
    - port: 80
      targetPort: 8080
`;

const stage14 = {
  id: 'follow-the-packet',
  title: t('顺着包走一遍', 'Follow the Packet'),
  goal: t(
    code`
      周一早上三件事一起报过来，\`kubectl get\` 看下去却哪儿都正常：
      Gateway 是 Programmed，Pod 全 Running，Service 都在。

      - 从跳板机访问 \`https://portal.corp.internal/\` 返回 **404**；
      - 门户访问 \`http://ledger\` **卡住不动，最后超时**；
      - 门户访问 \`http://sessions\` **立刻被拒**。

      三种现象指向三个不同的层。右边的「包路径」面板会把每一次连接
      逐跳列出来 —— 哪一跳被丢掉、哪一跳被拒绝，上面写着。

      ## 通关标准

      1. 从跳板机不加 \`-k\` 访问门户返回 200；
      2. 门户访问得到 \`http://ledger\`；
      3. 门户访问得到 \`http://sessions\`；
      4. **修的方式要对**：Gateway 的 listener 不许放宽成通配、
         ledger 的入向策略不许删掉、sessions 这个 Service 不许换名字。

      ## 会用到的命令

      \`\`\`bash
      curl -sv --resolve portal.corp.internal:443:<Gateway 地址> https://portal.corp.internal/
      kubectl exec -n payments deploy/portal -- curl -s -m 5 -o /dev/null -w '%{http_code}' http://ledger
      kubectl exec -n payments deploy/portal -- curl -s -m 5 http://sessions
      kubectl get httproute portal -n payments -o yaml
      kubectl get endpoints -n payments
      kubectl get netpol -n payments -o yaml
      \`\`\`
    `,
    code`
      Three reports land on Monday morning, and \`kubectl get\` shows nothing wrong:
      the Gateway is Programmed, every pod is Running, the Services are all there.

      - \`https://portal.corp.internal/\` from the jump host returns **404**;
      - the portal reaching \`http://ledger\` **hangs and eventually times out**;
      - the portal reaching \`http://sessions\` is **refused immediately**.

      Three symptoms, three different layers. The packet path panel on the right lists
      every hop of every connection, and says which hop dropped or rejected it.

      ## Done when

      1. the portal returns 200 from the jump host, without \`-k\`;
      2. the portal can reach \`http://ledger\`;
      3. the portal can reach \`http://sessions\`;
      4. **and the fixes are the right ones**: the Gateway listener is not widened to a
         wildcard, ledger's ingress policy is not deleted, and the sessions Service
         keeps its name.

      ## Commands you will need

      \`\`\`bash
      curl -sv --resolve portal.corp.internal:443:<gateway address> https://portal.corp.internal/
      kubectl exec -n payments deploy/portal -- curl -s -m 5 -o /dev/null -w '%{http_code}' http://ledger
      kubectl exec -n payments deploy/portal -- curl -s -m 5 http://sessions
      kubectl get httproute portal -n payments -o yaml
      kubectl get endpoints -n payments
      kubectl get netpol -n payments -o yaml
      \`\`\`
    `
  ),
  checklist: [
    t('三种现象分别定位到正确的那一层', 'Each symptom traced to the right layer'),
    t('三条路都通了', 'All three paths work'),
    t('修的是根因，不是把防护拆掉', 'Root causes fixed, not protections removed'),
  ],
  hints: [
    t(
      '**404 说明 Gateway 是活的**。连不上才是 Gateway 的问题；404 是「进来了但没有路由认领这个请求」，去看 HTTPRoute 的 hostnames 与 rules。',
      '**A 404 means the Gateway is alive.** A dead Gateway refuses the connection. A 404 means the request got in and no route claimed it, so look at the HTTPRoute hostnames and rules.'
    ),
    t(
      '**超时和拒绝是两件事**。拒绝说明包到了对端而没人听（或者 Service 没有后端，kube-proxy 直接回 RST）；超时说明包被丢了 —— NetworkPolicy 丢包，不回任何东西。',
      '**Timeout and refusal are different.** Refusal means the packet arrived and nobody was listening (or the Service has no endpoints and kube-proxy resets). A timeout means the packet was dropped, and dropping is what NetworkPolicy does.'
    ),
    t(
      '\`kubectl get endpoints\` 是 Service 这一层最直接的体检：Endpoints 为空说明 selector 一个 Pod 都没选中，而 \`kubectl get svc\` 看上去完全正常。',
      '`kubectl get endpoints` is the direct check at the Service layer: an empty Endpoints means the selector matched no pods, while `kubectl get svc` looks perfectly healthy.'
    ),
  ],
  pitfalls: [
    t(
      '把 Gateway listener 的 hostname 删掉，让它接受所有域名。404 确实没了，但这台 Gateway 从此会把任何域名的请求都往门户转 —— 判定检查 listener 还在不在。',
      'Removing the hostname from the Gateway listener so it accepts everything. The 404 goes away, and now that Gateway forwards requests for any hostname to the portal. The grader checks the listener is still scoped.'
    ),
    t(
      '把 ledger 的 NetworkPolicy 删了。超时确实没了 —— 因为 ledger 重新对整个集群开放了，而它正是上一关刚关起来的东西。',
      'Deleting ledger’s NetworkPolicy. The timeout goes away because ledger is open to the whole cluster again, which is exactly what the previous stage closed.'
    ),
    t(
      '看到 Endpoints 为空就重建 Service。名字一换，所有引用它的地方（HTTPRoute、其他服务的配置）都得跟着改，而问题只是 selector 里的一个词。',
      'Recreating the Service because its Endpoints are empty. Renaming it means every reference (HTTPRoutes, other services’ config) has to change too, when the actual problem is one word in the selector.'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    objects: [
      CNI_CILIUM,
      ...GATEWAY_PLATFORM, ...CERT_MANAGER_PLATFORM, ...TLS_PLATFORM,
      ...PORTAL_WORKLOAD, ...LEDGER_WORKLOAD, ...SESSIONS_WORKLOAD,
      BROKEN_ROUTE, LEDGER_POLICY,
    ],
    files: {},
    referenceFiles: { '/root/infra/triage.yaml': TRIAGE_REFERENCE },
    referenceCommands: [
      'kubectl apply -f /root/infra/triage.yaml',
    ],
  },
  specs: [
    spec('follow-the-packet.spec.ts', code`
      import { get, list, sh } from '@ops/lab';

      const EXEC = 'kubectl exec -n payments deploy/portal -- curl -s -m 5 -o /dev/null -w %{http_code} ';

      describe('顺着包走一遍', () => {
        it('从跳板机访问门户返回 200', async () => {
          const gateway = list('Gateway', { namespace: 'payments' })[0];
          const address = gateway.status.addresses[0].value;
          const result = await sh(
            'curl -s -o /dev/null -w %{http_code} --resolve portal.corp.internal:443:' + address
            + ' https://portal.corp.internal/'
          );
          expect(result.stdout).toBe('200');
        });

        it('门户访问得到 ledger', async () => {
          const result = await sh(EXEC + 'http://ledger');
          expect(result.stdout).toBe('200');
        });

        it('门户访问得到 sessions', async () => {
          const result = await sh(EXEC + 'http://sessions');
          expect(result.stdout).toBe('200');
        });

        it('Gateway 的 listener 没有被放宽成通配', () => {
          const gateway = list('Gateway', { namespace: 'payments' })[0];
          for (const listener of gateway.spec.listeners) {
            expect(listener.hostname).toBeTruthy();
            expect(listener.hostname).not.toContain('*');
          }
        });

        it('ledger 还被入向策略保护着', () => {
          const policies = list('NetworkPolicy', { namespace: 'payments' })
            .filter((policy) => (policy.spec.podSelector.matchLabels || {}).app === 'ledger'
              && (policy.spec.policyTypes || []).includes('Ingress'));
          expect(policies.length).toBeGreaterThan(0);
          // 而且不是靠 from 留空重新对全集群开放
          for (const policy of policies) {
            for (const rule of policy.spec.ingress || []) {
              expect((rule.from || []).length).toBeGreaterThan(0);
            }
          }
        });

        it('sessions 这个 Service 还在，而且是靠 selector 修好的', () => {
          const service = get('Service', 'sessions', 'payments');
          expect(service).toBeTruthy();
          const endpoints = get('Endpoints', 'sessions', 'payments');
          const addresses = (endpoints.subsets || []).flatMap((subset) => subset.addresses || []);
          expect(addresses.length).toBe(2);
        });
      });
    `),
  ],
  focus: ['correctness', 'resilience'],
  extension: t(
    code`
      这一关真正要练的是**从现象反推层次**，而不是三个具体的 bug。把它记成一张表：

      - \`Connection refused\`：包到了对端，那里没人听。Service 没有 Endpoints
        （kube-proxy 直接 RST）、进程没起来、端口写错，都长这样。
      - \`timeout\`：包被丢了，没有任何回应。防火墙、NetworkPolicy、
        路由不通、安全组，都长这样。**看到超时先想「谁在丢包」**。
      - \`connection reset\`：连上了又被断开。TLS 握手失败、协议对不上
        （拿 HTTP 打 HTTPS 端口）常见。
      - \`404 / 502 / 503\`：**连接是成功的**。这是应用层或者代理层的回答，
        说明前面每一层都通了，问题在最后那一段。
      - DNS 失败：连尝试都没发生。名字错了、search domain 不对、
        CoreDNS 挂了。

      这张表的价值在于它**排除**掉的东西：看到 404 就不用再查网络策略，
      看到 timeout 就不用再查 HTTPRoute。真集群里排查最费时间的从来不是修，
      是在错误的层里找。
    `,
    code`
      What this stage actually trains is **reasoning from symptom to layer**, not three
      specific bugs. Keep the table:

      - \`Connection refused\`: the packet arrived and nobody was listening. A Service
        with no Endpoints (kube-proxy resets), a process that never started, a wrong
        port all look like this.
      - \`timeout\`: the packet was dropped with no reply at all. Firewalls, network
        policies, missing routes, security groups. **A timeout means asking who is
        dropping packets.**
      - \`connection reset\`: connected, then torn down. Typically a failed TLS
        handshake or a protocol mismatch such as plain HTTP against an HTTPS port.
      - \`404 / 502 / 503\`: **the connection succeeded**. This is an answer from the
        application or the proxy, which means every layer below it worked and the
        problem is in the last hop.
      - DNS failure: no connection was even attempted. Wrong name, wrong search
        domain, or CoreDNS is down.

      The value of the table is what it **rules out**: a 404 means you can stop looking
      at network policies, and a timeout means you can stop reading HTTPRoutes. The
      expensive part of real debugging is never the fix, it is searching in the wrong
      layer.
    `
  ),
};


/* ------------------------------------------------------------------ */
/* 第 15 关                                                            */
/* ------------------------------------------------------------------ */

/** 网格的控制面与数据面，平台组已经装好 */
const MESH_PLATFORM = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'istiod', namespace: 'istio-system', labels: { app: 'istiod' } },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'istiod' } },
      template: {
        metadata: { labels: { app: 'istiod' } },
        spec: { containers: [{ name: 'discovery', image: ISTIOD_IMAGE, ports: [{ containerPort: 15012 }] }] },
      },
    },
  },
  {
    apiVersion: 'apps/v1', kind: 'DaemonSet',
    metadata: { name: 'ztunnel', namespace: 'istio-system', labels: { app: 'ztunnel' } },
    spec: {
      selector: { matchLabels: { app: 'ztunnel' } },
      template: {
        metadata: { labels: { app: 'ztunnel' } },
        spec: { containers: [{ name: 'ztunnel', image: ZTUNNEL_IMAGE, ports: [{ containerPort: 15008 }] }] },
      },
    },
  },
  {
    apiVersion: 'gateway.networking.k8s.io/v1', kind: 'GatewayClass',
    metadata: { name: 'istio-waypoint' },
    spec: { controllerName: 'istio.io/mesh-controller' },
  },
];

/** 支付核心，跑在自己的 ServiceAccount 上 */
const MESH_LEDGER = [
  {
    apiVersion: 'v1', kind: 'ServiceAccount',
    metadata: { name: 'ledger', namespace: 'payments' },
  },
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'ledger', namespace: 'payments' },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: 'ledger' } },
      template: {
        metadata: { labels: { app: 'ledger' } },
        spec: {
          serviceAccountName: 'ledger',
          containers: [{ name: 'app', image: LEDGER_IMAGE, ports: [{ containerPort: 8080 }] }],
        },
      },
    },
  },
  {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name: 'ledger', namespace: 'payments' },
    spec: { selector: { app: 'ledger' }, ports: [{ port: 80, targetPort: 8080 }] },
  },
];

/** 门户也换成自己的身份 */
const MESH_PORTAL = [
  { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'portal', namespace: 'payments' } },
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'portal', namespace: 'payments' },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: 'portal' } },
      template: {
        metadata: { labels: { app: 'portal' } },
        spec: {
          serviceAccountName: 'portal',
          containers: [{ name: 'web', image: PORTAL_IMAGE, ports: [{ containerPort: 8080 }] }],
        },
      },
    },
  },
  {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name: 'portal', namespace: 'payments' },
    spec: { clusterIP: '10.96.1.10', selector: { app: 'portal' }, ports: [{ port: 80, targetPort: 8080 }] },
  },
];

/** analytics 里的报表机 —— 它不该访问得到 ledger */
const MESH_REPORTS = {
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: { name: 'reports', namespace: 'analytics' },
  spec: {
    replicas: 1,
    selector: { matchLabels: { app: 'reports' } },
    template: {
      metadata: { labels: { app: 'reports' } },
      spec: {
        containers: [{
          name: 'app', image: REPORTS_IMAGE, ports: [{ containerPort: 9090 }],
          resources: { requests: { memory: '256Mi' }, limits: { memory: '1Gi' } },
        }],
      },
    },
  },
};

const MESH_STARTER = code`
  # 前任写到一半的东西。装上去之前先想清楚它会不会生效。
  apiVersion: security.istio.io/v1
  kind: AuthorizationPolicy
  metadata:
    name: ledger
    namespace: payments
  spec:
    selector:
      matchLabels:
        app: ledger
    action: ALLOW
    rules:
    - from:
      - source:
          principals:
          - cluster.local/ns/payments/sa/portal
      to:
      - operation:
          methods:
          - GET
          paths:
          - /balance*
`;

const MESH_REFERENCE = code`
  apiVersion: v1
  kind: Namespace
  metadata:
    name: payments
    labels:
      istio.io/dataplane-mode: ambient
  ---
  # 入口的数据面也得有身份，否则 STRICT 之后它自己就被挡在外面了
  apiVersion: v1
  kind: Namespace
  metadata:
    name: envoy-gateway-system
    labels:
      istio.io/dataplane-mode: ambient
  ---
  apiVersion: security.istio.io/v1
  kind: PeerAuthentication
  metadata:
    name: default
    namespace: payments
  spec:
    mtls:
      mode: STRICT
  ---
  apiVersion: gateway.networking.k8s.io/v1
  kind: Gateway
  metadata:
    name: waypoint
    namespace: payments
  spec:
    gatewayClassName: istio-waypoint
    listeners:
    - name: mesh
      port: 15008
      protocol: HBONE
  ---
  apiVersion: security.istio.io/v1
  kind: AuthorizationPolicy
  metadata:
    name: ledger
    namespace: payments
  spec:
    selector:
      matchLabels:
        app: ledger
    action: ALLOW
    rules:
    - from:
      - source:
          principals:
          - spiffe://cluster.local/ns/payments/sa/portal
      to:
      - operation:
          methods:
          - GET
          paths:
          - /*
`;

const stage15 = {
  id: 'service-mesh-ambient',
  title: t('服务网格：谁在用什么身份访问谁', 'Service Mesh: Who Is Calling Whom, As Whom'),
  goal: t(
    code`
      安全评审又提了一条，这次是关于**身份**的：\`ledger\` 只允许门户访问，
      而且要能证明「访问它的确实是门户」，不是谁都能伪造的 IP 或标签。
      NetworkPolicy 按 IP 与标签判，标签是能改的；网格按**证书身份**判。

      平台组已经把 Istio ambient 装好了（istiod + ztunnel），命名空间还没接进去。
      \`/root/infra/mesh.yaml\` 里是前任写到一半的一条授权策略。

      ## 通关标准

      1. \`payments\` 接进网格，里面的工作负载走 mTLS；
      2. 明文直连被拒 —— \`analytics\` 的报表机连不上 \`ledger\`；
      3. 门户访问得到 \`ledger\`，而且判定看的是 SPIFFE 身份不是 IP；
      4. \`istioctl analyze\` 干净（没有「策略写了但不生效」这类告警）；
      5. 网格外的入口照常：从跳板机访问门户仍然 200。

      ## 会用到的命令

      \`\`\`bash
      kubectl label namespace payments istio.io/dataplane-mode=ambient
      istioctl ztunnel-config workload
      istioctl x describe pod <pod> -n payments
      istioctl analyze -n payments
      kubectl apply -f /root/infra/mesh.yaml
      kubectl exec -n analytics deploy/reports -- curl -s -m 5 http://ledger.payments.svc.cluster.local
      \`\`\`
    `,
    code`
      Another security review, this time about **identity**: only the portal may reach
      \`ledger\`, and it must be provable that the caller really is the portal, not
      something that borrowed an IP or a label. NetworkPolicy judges by IP and labels,
      and labels can be edited. A mesh judges by **certificate identity**.

      The platform team already installed Istio ambient (istiod plus ztunnel); no
      namespace is enrolled yet. \`/root/infra/mesh.yaml\` holds a half-written
      authorization policy your predecessor left behind.

      ## Done when

      1. \`payments\` is enrolled and its workloads talk over mTLS;
      2. plaintext is refused: the reports pod in \`analytics\` cannot reach \`ledger\`;
      3. the portal can reach \`ledger\`, and the decision is based on SPIFFE identity
         rather than an IP;
      4. \`istioctl analyze\` is clean, with no "written but not enforced" warnings;
      5. the outside entrance still works: the portal answers 200 from the jump host.

      ## Commands you will need

      \`\`\`bash
      kubectl label namespace payments istio.io/dataplane-mode=ambient
      istioctl ztunnel-config workload
      istioctl x describe pod <pod> -n payments
      istioctl analyze -n payments
      kubectl apply -f /root/infra/mesh.yaml
      kubectl exec -n analytics deploy/reports -- curl -s -m 5 http://ledger.payments.svc.cluster.local
      \`\`\`
    `
  ),
  checklist: [
    t('命名空间接进网格，mTLS 生效', 'Namespace enrolled, mTLS in effect'),
    t('按身份授权，明文被拒', 'Authorization by identity, plaintext refused'),
    t('L7 规则真的被求值', 'The L7 rules are actually evaluated'),
  ],
  hints: [
    t(
      'ambient 靠命名空间上的一个标签接管：\`istio.io/dataplane-mode=ambient\`。接没接进去用 \`istioctl ztunnel-config workload\` 看 PROTOCOL 那一列，HBONE 才算数。',
      'Ambient enrolls by a namespace label: `istio.io/dataplane-mode=ambient`. Check with `istioctl ztunnel-config workload` and read the PROTOCOL column: HBONE means enrolled.'
    ),
    t(
      'ztunnel 只做 L4 —— 身份、端口。要按 HTTP 方法或路径授权，得给命名空间挂一个 waypoint（一个 \`gatewayClassName: istio-waypoint\` 的 Gateway）。没有它，那些规则不会被求值，\`istioctl analyze\` 会直说。',
      'ztunnel only does L4: identity and ports. Authorizing by HTTP method or path needs a waypoint for the namespace (a Gateway with `gatewayClassName: istio-waypoint`). Without one those rules are never evaluated, and `istioctl analyze` says so.'
    ),
    t(
      'principal 的写法是完整的 SPIFFE ID：\`spiffe://cluster.local/ns/<ns>/sa/<sa>\`。写成 \`cluster.local/ns/...\`（少了 scheme）不会报错，只会永远匹配不上。',
      'A principal is a full SPIFFE ID: `spiffe://cluster.local/ns/<ns>/sa/<sa>`. Writing `cluster.local/ns/...` without the scheme raises no error and simply never matches.'
    ),
  ],
  pitfalls: [
    t(
      '以为加了一条 ALLOW 就只是「多放行一个来源」。恰恰相反：一旦有 ALLOW 策略选中某个工作负载，**没被任何一条 rule 命中的访问全部被拒**。上线前先确认自己知道有哪些调用方。',
      'Assuming an ALLOW policy merely permits one more caller. The opposite is true: once any ALLOW policy selects a workload, **everything not matched by some rule is denied**. Know your callers before shipping one.'
    ),
    t(
      '把 NetworkPolicy 删掉，觉得「有网格了就不需要它」。两者判的不是一回事：网格判身份，NetworkPolicy 判网络可达性，而且网格只覆盖接进来的命名空间。它们是叠加的，不是替代的。',
      'Deleting NetworkPolicies because "the mesh handles it now". They answer different questions: the mesh judges identity, NetworkPolicy judges reachability, and the mesh only covers enrolled namespaces. They stack, they do not replace each other.'
    ),
    t(
      '被网格拒绝表现为**连接被重置**，不是超时。ztunnel 会明确回一个 RST。看到超时该去查 NetworkPolicy，看到 reset 才该来查网格 —— 两者指向不同的层。',
      'A mesh denial shows up as a **connection reset**, not a timeout: ztunnel answers with an RST. A timeout points at NetworkPolicy; a reset points at the mesh. Different layers.'
    ),
    t(
      '只把业务的命名空间接进网格，忘了入口。开了 STRICT 之后，Gateway 的数据面是从网格外发起明文连接的，于是它自己第一个被挡在外面 —— 门户对外直接不可用。入口所在的命名空间也要有身份。',
      'Enrolling only the application namespace and forgetting the entrance. Once STRICT is on, the Gateway data plane is calling in as plaintext from outside the mesh, so it is the first thing refused and the portal goes dark from outside. The entrance namespace needs an identity too.'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    objects: [
      CNI_CILIUM,
      ...GATEWAY_PLATFORM, ...CERT_MANAGER_PLATFORM, ...TLS_PLATFORM, ...MESH_PLATFORM,
      ...MESH_PORTAL, PORTAL_ROUTE, ...MESH_LEDGER, MESH_REPORTS,
    ],
    files: { '/root/infra/mesh.yaml': MESH_STARTER },
    referenceFiles: { '/root/infra/mesh.yaml': MESH_REFERENCE },
    referenceCommands: [
      'kubectl apply -f /root/infra/mesh.yaml',
    ],
  },
  specs: [
    spec('service-mesh-ambient.spec.ts', code`
      import { get, list, sh } from '@ops/lab';

      const LEDGER = 'http://ledger.payments.svc.cluster.local';

      describe('服务网格', () => {
        it('payments 接进了网格', async () => {
          const result = await sh('istioctl ztunnel-config workload');
          expect(result.code).toBe(0);
          // 按 NAMESPACE 那一列判断 —— envoy-payments-corp-gw-... 在别的命名空间里
          const rows = result.stdout.split('\\n').filter((line) => line.startsWith('payments '));
          expect(rows.length).toBeGreaterThan(0);
          for (const row of rows) expect(row).toContain('HBONE');
        });

        it('门户访问得到 ledger', async () => {
          const result = await sh(
            'kubectl exec -n payments deploy/portal -- curl -s -m 5 -o /dev/null -w %{http_code} ' + LEDGER
          );
          expect(result.stdout).toBe('200');
        });

        it('网格外的明文直连被拒 —— 而且是 reset 不是超时', async () => {
          const result = await sh('kubectl exec -n analytics deploy/reports -- curl -s -m 5 ' + LEDGER);
          expect(result.stdout).toBe('');
          // 56 = 收到 RST；28 才是超时，那说明拦它的是 NetworkPolicy 不是网格
          expect(result.stderr).toContain('curl: (56)');
        });

        it('判的是 SPIFFE 身份，不是 IP 或标签', () => {
          const policies = list('AuthorizationPolicy', { namespace: 'payments' });
          expect(policies.length).toBeGreaterThan(0);
          const principals = policies.flatMap((policy) => (policy.spec.rules || [])
            .flatMap((rule) => (rule.from || [])
              .flatMap((entry) => (entry.source || {}).principals || [])));
          expect(principals.length).toBeGreaterThan(0);
          for (const principal of principals) {
            expect(principal.startsWith('spiffe://')).toBe(true);
          }
        });

        it('mTLS 是 STRICT', () => {
          const policies = list('PeerAuthentication', { namespace: 'payments' });
          expect(policies.some((policy) => policy.spec.mtls.mode === 'STRICT')).toBe(true);
        });

        it('istioctl analyze 是干净的 —— 没有「写了但不生效」', async () => {
          const result = await sh('istioctl analyze -n payments');
          expect(result.stdout).toContain('No validation issues found');
          expect(result.code).toBe(0);
        });

        it('网格外的入口照常', async () => {
          const gateway = list('Gateway', { namespace: 'payments' })
            .find((item) => item.spec.gatewayClassName !== 'istio-waypoint');
          const address = gateway.status.addresses[0].value;
          const result = await sh(
            'curl -s -o /dev/null -w %{http_code} --resolve portal.corp.internal:443:' + address
            + ' https://portal.corp.internal/'
          );
          expect(result.stdout).toBe('200');
        });

        it('没有靠删掉报表机来蒙过去', () => {
          const reports = get('Deployment', 'reports', 'analytics');
          expect(reports.status.readyReplicas).toBeGreaterThan(0);
        });
      });
    `),
  ],
  focus: ['correctness', 'resilience'],
  extension: t(
    code`
      网格解决的是 NetworkPolicy 解决不了的那一类问题：**证明调用方是谁**。
      NetworkPolicy 判的是「这个 IP 属于一个带某某标签的 Pod」，而标签是
      apiserver 里的一个字段，有权限的人随时能改；网格判的是「对面出示的证书
      属于哪个 ServiceAccount」，那是一次真的 mTLS 双向验证。所以两者不是替代
      关系：一个管网络可达性，一个管身份，叠着用。

      ambient 相对 sidecar 的变化值得记住：数据面从「每个 Pod 一个 Envoy」变成
      「每个节点一个 ztunnel + 按需的 waypoint」。代价是**分层**：ztunnel 只看
      得到 L4，所以按方法、按路径的授权、重试、熔断这些都需要 waypoint。
      这条分层是 ambient 里最常见的困惑来源 —— 策略写得没错，只是没有人求值。

      还有一个容易忽略的点：SPIFFE 身份来自 **ServiceAccount**，不是 Pod 名也
      不是标签。所有工作负载都用 \`default\` 这个 SA 的集群，网格给不出任何有用的
      区分 —— 上网格之前，先把 ServiceAccount 分开。
    `,
    code`
      A mesh solves the problem NetworkPolicy cannot: **proving who the caller is**.
      NetworkPolicy says "this IP belongs to a pod carrying that label", and a label is
      a field in the apiserver that anyone with access can change. A mesh says "the
      certificate the peer presented belongs to that ServiceAccount", established by a
      real mutual TLS handshake. They are not alternatives: one governs reachability,
      the other identity, and they stack.

      The ambient change worth remembering: the data plane moves from "an Envoy beside
      every pod" to "one ztunnel per node plus waypoints where needed". The price is
      **layering**: ztunnel only sees L4, so per-method and per-path authorization,
      retries, and circuit breaking all require a waypoint. That layering is the most
      common source of confusion in ambient, because the policy is not wrong, it simply
      has nobody evaluating it.

      One more thing that is easy to miss: SPIFFE identity comes from the
      **ServiceAccount**, not the pod name or its labels. A cluster where everything
      runs as \`default\` gets no useful distinction out of a mesh. Split the
      ServiceAccounts before you enroll.
    `
  ),
};


/* ------------------------------------------------------------------ */
/* 第 16 关                                                            */
/* ------------------------------------------------------------------ */

/** 前任图省事，把 CI 的 ServiceAccount 直接绑了 cluster-admin */
const CI_ADMIN_BINDING = {
  apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRoleBinding',
  metadata: { name: 'ci-admin' },
  subjects: [{ kind: 'ServiceAccount', name: 'deployer', namespace: 'argocd' }],
  roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' },
};

/** 集群自带的那几个角色，真集群里也是预置的 */
const BUILTIN_ROLES = [
  {
    apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole',
    metadata: { name: 'cluster-admin' },
    rules: [{ apiGroups: ['*'], resources: ['*'], verbs: ['*'] }],
  },
  {
    apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole',
    metadata: { name: 'view' },
    rules: [
      {
        apiGroups: ['', 'apps', 'networking.k8s.io', 'gateway.networking.k8s.io'],
        resources: ['pods', 'services', 'endpoints', 'configmaps', 'deployments', 'replicasets',
          'daemonsets', 'networkpolicies', 'gateways', 'httproutes'],
        verbs: ['get', 'list', 'watch'],
      },
    ],
  },
  { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'deployer', namespace: 'argocd' } },
];

const RBAC_STARTER = code`
  # 这里什么都还没有。想清楚每个人到底需要什么，再写。
  #
  #   liu  —— 开发，组 oidc:developers
  #   chen —— SRE，组 oidc:sre
  #   argocd/deployer —— CI 用的 ServiceAccount
`;

const RBAC_REFERENCE = code`
  # 开发：payments 里只读 + 看日志 + 进容器排查
  apiVersion: rbac.authorization.k8s.io/v1
  kind: Role
  metadata:
    name: developer
    namespace: payments
  rules:
  - apiGroups: [""]
    resources: ["pods", "services", "configmaps", "endpoints"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
  - apiGroups: [""]
    resources: ["pods/exec"]
    verbs: ["create"]
  ---
  apiVersion: rbac.authorization.k8s.io/v1
  kind: RoleBinding
  metadata:
    name: developers
    namespace: payments
  subjects:
  - kind: Group
    name: oidc:developers
    apiGroup: rbac.authorization.k8s.io
  roleRef:
    apiGroup: rbac.authorization.k8s.io
    kind: Role
    name: developer
  ---
  # SRE：全集群只读
  apiVersion: rbac.authorization.k8s.io/v1
  kind: ClusterRoleBinding
  metadata:
    name: sre-view
  subjects:
  - kind: Group
    name: oidc:sre
    apiGroup: rbac.authorization.k8s.io
  roleRef:
    apiGroup: rbac.authorization.k8s.io
    kind: ClusterRole
    name: view
  ---
  # SRE：payments 里还能动工作负载
  apiVersion: rbac.authorization.k8s.io/v1
  kind: Role
  metadata:
    name: workload-operator
    namespace: payments
  rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "deployments/scale", "statefulsets"]
    verbs: ["get", "list", "watch", "update", "patch"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch", "delete"]
  ---
  apiVersion: rbac.authorization.k8s.io/v1
  kind: RoleBinding
  metadata:
    name: sre-operator
    namespace: payments
  subjects:
  - kind: Group
    name: oidc:sre
    apiGroup: rbac.authorization.k8s.io
  roleRef:
    apiGroup: rbac.authorization.k8s.io
    kind: Role
    name: workload-operator
  ---
  # CI：只在 payments 里发布工作负载，碰不到 RBAC 与 Secret
  apiVersion: rbac.authorization.k8s.io/v1
  kind: Role
  metadata:
    name: deployer
    namespace: payments
  rules:
  - apiGroups: ["apps"]
    resources: ["deployments", "replicasets", "daemonsets", "statefulsets"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  - apiGroups: [""]
    resources: ["services", "configmaps"]
    verbs: ["get", "list", "watch", "create", "update", "patch"]
  ---
  apiVersion: rbac.authorization.k8s.io/v1
  kind: RoleBinding
  metadata:
    name: ci-deployer
    namespace: payments
  subjects:
  - kind: ServiceAccount
    name: deployer
    namespace: argocd
  roleRef:
    apiGroup: rbac.authorization.k8s.io
    kind: Role
    name: deployer
`;

const stage16 = {
  id: 'identity-and-rbac',
  title: t('把 cluster-admin 收回来', 'Take cluster-admin Back'),
  goal: t(
    code`
      公司接了 OIDC，两个人已经能登录集群了：\`liu\`（开发，组
      \`oidc:developers\`）和 \`chen\`（SRE，组 \`oidc:sre\`）。但集群这边一个
      角色都没配 —— 他们登录之后什么都干不了。

      与此同时，前任把 CI 用的 ServiceAccount \`argocd/deployer\` 直接绑了
      \`cluster-admin\`。也就是说，一条流水线拿到的权限比任何一个人都大。

      按最小权限把这三个主体配好。

      ## 通关标准

      1. \`liu\`：在 \`payments\` 里读得到工作负载、看得了日志、进得去容器排查；
         **改不动任何东西**，也读不到 Secret；
      2. \`chen\`：全集群只读，另外在 \`payments\` 里能改 Deployment 与删 Pod；
         但删不掉命名空间；
      3. \`argocd/deployer\`：只在 \`payments\` 里发布工作负载；碰不到 RBAC，
         也读不到 Secret；
      4. \`cluster-admin\` 不再绑给这三个主体里的任何一个。

      ## 会用到的命令

      \`\`\`bash
      kubectl auth can-i --list --as=oidc:liu@corp.internal --as-group=oidc:developers -n payments
      kubectl auth can-i create pods --subresource=exec -n payments --as=oidc:liu@corp.internal --as-group=oidc:developers
      kubectl get clusterrolebindings
      kubectl apply -f /root/infra/rbac.yaml
      \`\`\`
    `,
    code`
      The company wired up OIDC and two people can now log in: \`liu\` (a developer in
      group \`oidc:developers\`) and \`chen\` (an SRE in \`oidc:sre\`). No roles exist on
      the cluster side, so once logged in they can do nothing at all.

      Meanwhile your predecessor bound the CI ServiceAccount \`argocd/deployer\`
      straight to \`cluster-admin\`. A pipeline therefore holds more power than any
      human does.

      Give all three least privilege.

      ## Done when

      1. \`liu\` can read workloads in \`payments\`, read logs, and exec into containers
         to debug, but **cannot change anything** and cannot read Secrets;
      2. \`chen\` has cluster-wide read plus the ability to modify Deployments and
         delete Pods in \`payments\`, but cannot delete namespaces;
      3. \`argocd/deployer\` can ship workloads in \`payments\` only, cannot touch RBAC,
         and cannot read Secrets;
      4. \`cluster-admin\` is no longer bound to any of the three.

      ## Commands you will need

      \`\`\`bash
      kubectl auth can-i --list --as=oidc:liu@corp.internal --as-group=oidc:developers -n payments
      kubectl auth can-i create pods --subresource=exec -n payments --as=oidc:liu@corp.internal --as-group=oidc:developers
      kubectl get clusterrolebindings
      kubectl apply -f /root/infra/rbac.yaml
      \`\`\`
    `
  ),
  checklist: [
    t('三个主体各自拿到该有的权限', 'Each of the three gets what it needs'),
    t('都拿不到不该有的', 'And none of them gets what it should not'),
    t('cluster-admin 收回来了', 'cluster-admin taken back'),
  ],
  hints: [
    t(
      '\`kubectl auth can-i ... --as=<user> --as-group=<group>\` 是检查别人权限的标准做法 —— 不需要拿到对方的凭据。\`--list\` 会把这个身份在这个命名空间里能做的事全列出来。',
      '`kubectl auth can-i ... --as=<user> --as-group=<group>` is how you check someone else’s permissions without holding their credentials. `--list` prints everything that identity can do in that namespace.'
    ),
    t(
      '\`RoleBinding\` 可以引用 \`ClusterRole\`。权限的范围由 **Binding** 决定 —— 这就是「一套只读角色，绑到每个需要的命名空间」的标准写法，不用给每个命名空间各写一份 Role。',
      'A `RoleBinding` may reference a `ClusterRole`. Scope comes from the **binding**, which is the standard way to reuse one read-only role across namespaces without writing a Role in each.'
    ),
    t(
      '看日志和进容器是两个**子资源**：\`pods/log\` 的 \`get\`、\`pods/exec\` 的 \`create\`。只写 \`pods\` 是不够的，而且 exec 的动词是 create 不是 get。问的时候要用 \`--subresource=log\`：写成 \`can-i get pods/log\` 的话，kubectl 会把 log 当成 Pod 的**名字**。',
      'Logs and exec are **subresources**: `get` on `pods/log`, `create` on `pods/exec`. Listing `pods` alone is not enough, and the verb for exec is create, not get. Ask with `--subresource=log`: written as `can-i get pods/log`, kubectl reads log as the pod **name** instead.'
    ),
  ],
  pitfalls: [
    t(
      '给开发绑 \`edit\` 或 \`admin\` 这种内置角色图省事。它们包含对 Secret 的读权限 —— 而「只读」的要求里，最要紧的恰恰是读不到 Secret。判定专门查了这一条。',
      'Reaching for built-in roles like `edit` or `admin`. They include read access to Secrets, and not reading Secrets is the most important half of "read only". The grader checks exactly that.'
    ),
    t(
      '把 \`ci-admin\` 那条 ClusterRoleBinding 留着，另外再加一条小权限。多加的那条不会削减已有的 —— RBAC 是取并集的，只要还有一条给了 cluster-admin，前面写的全部白搭。',
      'Leaving the `ci-admin` ClusterRoleBinding in place and adding a smaller role next to it. Adding never subtracts: RBAC unions its rules, so one remaining cluster-admin binding voids everything else you wrote.'
    ),
    t(
      '用 \`resourceNames\` 去限制 list。它只对指名道姓的请求生效，list 与 watch 没有名字，带 \`resourceNames\` 的规则对它们一律不匹配 —— 于是「我明明允许了这个 Secret」但列不出来。',
      'Using `resourceNames` to scope a list. It only applies to requests that name an object; list and watch carry no name, so such rules never match them, which is why "I clearly allowed that Secret" still cannot be listed.'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    objects: [
      CNI_CILIUM,
      ...GATEWAY_PLATFORM, ...CERT_MANAGER_PLATFORM, ...TLS_PLATFORM,
      ...PORTAL_WORKLOAD, PORTAL_ROUTE,
      ...BUILTIN_ROLES, CI_ADMIN_BINDING,
    ],
    files: { '/root/infra/rbac.yaml': RBAC_STARTER },
    referenceFiles: { '/root/infra/rbac.yaml': RBAC_REFERENCE },
    referenceCommands: [
      'kubectl apply -f /root/infra/rbac.yaml',
      'kubectl delete clusterrolebinding ci-admin',
    ],
  },
  specs: [
    spec('identity-and-rbac.spec.ts', code`
      import { list, sh } from '@ops/lab';

      const LIU = '--as=oidc:liu@corp.internal --as-group=oidc:developers';
      const CHEN = '--as=oidc:chen@corp.internal --as-group=oidc:sre';
      const CI = '--as=system:serviceaccount:argocd:deployer';

      const canI = async (what, who) => {
        const result = await sh('kubectl auth can-i ' + what + ' ' + who);
        return result.stdout.trim();
      };

      describe('身份与 RBAC', () => {
        it('开发在 payments 里读得到工作负载', async () => {
          expect(await canI('list pods -n payments', LIU)).toBe('yes');
          expect(await canI('list deployments -n payments', LIU)).toBe('yes');
        });

        it('开发看得了日志、进得去容器', async () => {
          // 子资源要用 --subresource 问；写成 pods/log 的话 kubectl 会把 log
          // 当成 Pod 的**名字**，问的就完全是另一件事了
          expect(await canI('get pods --subresource=log -n payments', LIU)).toBe('yes');
          expect(await canI('create pods --subresource=exec -n payments', LIU)).toBe('yes');
        });

        it('开发改不动东西，也读不到 Secret', async () => {
          expect(await canI('delete pods -n payments', LIU)).toBe('no');
          expect(await canI('patch deployments -n payments', LIU)).toBe('no');
          expect(await canI('create deployments -n payments', LIU)).toBe('no');
          expect(await canI('get secrets -n payments', LIU)).toBe('no');
        });

        it('开发的权限没有溢出到别的命名空间', async () => {
          expect(await canI('list pods -n argocd', LIU)).toBe('no');
        });

        it('SRE 全集群只读', async () => {
          expect(await canI('list pods --all-namespaces', CHEN)).toBe('yes');
          expect(await canI('list deployments -n argocd', CHEN)).toBe('yes');
        });

        it('SRE 在 payments 里动得了工作负载，但删不掉命名空间', async () => {
          expect(await canI('patch deployments -n payments', CHEN)).toBe('yes');
          expect(await canI('delete pods -n payments', CHEN)).toBe('yes');
          expect(await canI('delete namespaces', CHEN)).toBe('no');
        });

        it('CI 只能在 payments 里发布，碰不到 RBAC 与 Secret', async () => {
          expect(await canI('create deployments -n payments', CI)).toBe('yes');
          expect(await canI('create deployments -n argocd', CI)).toBe('no');
          expect(await canI('create rolebindings -n payments', CI)).toBe('no');
          expect(await canI('get secrets -n payments', CI)).toBe('no');
        });

        it('cluster-admin 不再绑给这三个主体', () => {
          const bindings = list('ClusterRoleBinding')
            .filter((binding) => binding.roleRef.name === 'cluster-admin');
          const risky = bindings.flatMap((binding) => binding.subjects || [])
            .filter((subject) => subject.kind !== 'Group' || !subject.name.startsWith('system:'));
          expect(risky).toEqual([]);
        });

        it('管理员自己还进得去 —— 别把自己锁在外面', async () => {
          const result = await sh('kubectl get pods -n payments');
          expect(result.code).toBe(0);
        });
      });
    `),
  ],
  focus: ['correctness', 'maintainability'],
  extension: t(
    code`
      RBAC 和前面几关的策略有一个根本区别：**它只有允许，没有拒绝**。
      写不出「除了 Secret 之外都可以」这种规则 —— 想表达它，只能把 Secret 之外
      的都列出来。所以「加一条规则」永远只会让权限变大，收权限的唯一办法是
      **改或删已有的绑定**。前任那条 \`ci-admin\` 就是这个道理：在旁边再写一个
      小角色，一点用都没有。

      另一个值得记住的是**认证与鉴权是两件事**。OIDC 只负责回答「你是谁」——
      它给出一个用户名和一组 group，之后集群里发生什么，全看 RBAC。
      所以「接了 OIDC 之后大家还是什么都干不了」是完全正常的中间状态，
      不是接错了。反过来，OIDC 那边改了 group claim 的映射，集群这边的
      绑定会突然对不上 —— 这类故障查起来很费劲，因为两边都「没改过」。

      最后一条实践：\`kubectl auth can-i --list --as=<user>\` 应该成为交付前的
      固定动作。人对自己写的 RBAC 的判断准确率相当低，而这条命令是直接问
      服务端要答案，不是猜。
    `,
    code`
      RBAC differs from the policies in earlier stages in one fundamental way: **it
      only allows, it never denies**. There is no way to write "anything except
      Secrets"; you must enumerate everything else. So adding a rule can only widen
      access, and the only way to reduce it is to **change or delete an existing
      binding**. That is why the leftover \`ci-admin\` matters: writing a smaller role
      beside it accomplishes nothing.

      The other thing worth internalising is that **authentication and authorization
      are separate**. OIDC only answers "who are you", producing a username and a set
      of groups; what happens next is entirely RBAC. "Everyone can log in and still do
      nothing" is therefore a perfectly normal intermediate state, not a broken
      integration. Conversely, when the identity provider changes how it maps group
      claims, cluster bindings silently stop matching, and that is painful to diagnose
      because neither side "changed anything".

      One practice worth adopting: run \`kubectl auth can-i --list --as=<user>\` before
      calling an RBAC change done. People are remarkably bad at predicting what their
      own rules permit, and this asks the server instead of guessing.
    `
  ),
};


/* ------------------------------------------------------------------ */
/* 第 17 关                                                            */
/* ------------------------------------------------------------------ */

const KYVERNO_PLATFORM = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'kyverno-admission-controller', namespace: 'kyverno',
      labels: { 'app.kubernetes.io/name': 'kyverno' } },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': 'kyverno' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'kyverno' } },
        spec: { containers: [{ name: 'kyverno', image: KYVERNO_IMAGE, ports: [{ containerPort: 9443 }] }] },
      },
    },
  },
];

/** 前任图省事跑起来的一个缓存，特权容器 + hostPath */
const SLOPPY_CACHE = {
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: { name: 'cache', namespace: 'payments' },
  spec: {
    replicas: 1,
    selector: { matchLabels: { app: 'cache' } },
    template: {
      metadata: { labels: { app: 'cache' } },
      spec: {
        containers: [{
          name: 'redis', image: UNSIGNED_IMAGE,
          ports: [{ containerPort: 6379 }],
          securityContext: { privileged: true },
        }],
        volumes: [{ name: 'data', hostPath: { path: '/var/lib/redis' } }],
      },
    },
  },
};

const POLICY_STARTER = code`
  # 三条规矩要落成策略。想清楚哪一条该交给 PSA，哪一条只能靠 Kyverno。
  #
  #   1. 不许特权容器、不许 hostPath
  #   2. 每个工作负载都要有 owner 标签
  #   3. 镜像只能来自内网仓库，而且必须签过名
`;

const POLICY_REFERENCE = code`
  # 第 2、3 条：PSA 表达不了，交给 Kyverno
  apiVersion: kyverno.io/v1
  kind: ClusterPolicy
  metadata:
    name: require-owner
  spec:
    validationFailureAction: Enforce
    rules:
    - name: owner-label
      match:
        any:
        - resources:
            kinds:
            - Pod
            namespaces:
            - payments
      validate:
        message: "每个工作负载都要带 owner 标签"
        pattern:
          metadata:
            labels:
              owner: "?*"
  ---
  apiVersion: kyverno.io/v1
  kind: ClusterPolicy
  metadata:
    name: internal-registry-only
  spec:
    validationFailureAction: Enforce
    rules:
    - name: registry
      match:
        any:
        - resources:
            kinds:
            - Pod
            namespaces:
            - payments
      validate:
        message: "镜像只能来自 harbor.corp.internal"
        pattern:
          spec:
            containers:
            - image: "harbor.corp.internal/*"
`;

/**
 * 验签策略要把公钥现填进去。
 *
 * `cosign generate-key-pair` 每次生成的密钥不一样，所以公钥不能写死在文件里。
 * heredoc 里的 `$(sed ...)` 负责把 PEM 按 YAML 的块标量缩进补齐。
 */
const VERIFY_POLICY_COMMAND = [
  'cat > /root/infra/verify.yaml <<EOF',
  'apiVersion: kyverno.io/v1',
  'kind: ClusterPolicy',
  'metadata:',
  '  name: verify-images',
  'spec:',
  '  validationFailureAction: Enforce',
  '  rules:',
  '  - name: signed',
  '    match:',
  '      any:',
  '      - resources:',
  '          kinds:',
  '          - Pod',
  '          namespaces:',
  '          - payments',
  '    verifyImages:',
  '    - imageReferences:',
  '      - "harbor.corp.internal/*"',
  '      attestors:',
  '      - entries:',
  '        - keys:',
  '            publicKeys: |',
  "$(sed 's/^/              /' /root/cosign.pub)",
  'EOF',
].join('\n');

/** 前任那个缓存改好之后的样子：内网镜像、非特权、带 owner */
const CACHE_FIXED = code`
  apiVersion: apps/v1
  kind: Deployment
  metadata:
    name: cache
    namespace: payments
  spec:
    replicas: 1
    selector:
      matchLabels:
        app: cache
    template:
      metadata:
        labels:
          app: cache
          owner: payments
      spec:
        securityContext:
          runAsNonRoot: true
          seccompProfile:
            type: RuntimeDefault
        containers:
        - name: redis
          image: harbor.corp.internal/team/sessions:1.8.0
          ports:
          - containerPort: 8080
          securityContext:
            allowPrivilegeEscalation: false
            runAsNonRoot: true
            capabilities:
              drop:
              - ALL
`;

const stage17 = {
  id: 'policy-as-code',
  title: t('把规矩写成策略', 'Turn the Rules Into Policy'),
  goal: t(
    code`
      安全评审给了三条规矩，从今往后由集群自己把关，不靠人 review：

      1. \`payments\` 里不许跑特权容器，不许挂 hostPath；
      2. 每个工作负载都要带 \`owner\` 标签；
      3. 镜像只能来自 \`harbor.corp.internal\`，而且必须**签过名**。

      现场有个反面教材：前任跑起来的 \`cache\`，用的是公网拉的 redis、
      开了特权、挂了宿主机目录、没有 owner 标签 —— 四条全占。

      Kyverno 已经装好。签名用 \`cosign\`，密钥自己生成。

      ## 通关标准

      1. 三条规矩都落成策略并且真的拦得住；
      2. \`cache\` 改好并跑起来（不是删掉了事）；
      3. 违规的东西 apply 上去会被拒，报错能看懂；
      4. 第 1 条用 PSA 的档位做，不是自己写 Kyverno 规则重复造一遍。

      ## 会用到的命令

      \`\`\`bash
      kubectl label namespace payments pod-security.kubernetes.io/enforce=restricted
      cosign generate-key-pair
      cosign sign --key cosign.key harbor.corp.internal/team/sessions:1.8.0
      kubectl apply -f /root/infra/policy.yaml
      kubectl get cpol
      kubectl apply -f /root/infra/cache.yaml
      \`\`\`
    `,
    code`
      The security review handed down three rules, to be enforced by the cluster from
      now on rather than by human review:

      1. no privileged containers and no hostPath volumes in \`payments\`;
      2. every workload carries an \`owner\` label;
      3. images come only from \`harbor.corp.internal\`, and must be **signed**.

      There is a live counter-example: the \`cache\` your predecessor started runs a
      redis pulled from the public internet, privileged, with a host directory mounted,
      and no owner label. All four at once.

      Kyverno is installed. Use \`cosign\` for signatures and generate your own key.

      ## Done when

      1. all three rules exist as policy and actually block;
      2. \`cache\` is fixed and running, not deleted;
      3. a violating manifest is rejected with a message you can act on;
      4. rule 1 uses PSA levels rather than a hand-written Kyverno rule reimplementing
         them.

      ## Commands you will need

      \`\`\`bash
      kubectl label namespace payments pod-security.kubernetes.io/enforce=restricted
      cosign generate-key-pair
      cosign sign --key cosign.key harbor.corp.internal/team/sessions:1.8.0
      kubectl apply -f /root/infra/policy.yaml
      kubectl get cpol
      kubectl apply -f /root/infra/cache.yaml
      \`\`\`
    `
  ),
  checklist: [
    t('三条规矩都由集群自己把关', 'All three rules enforced by the cluster'),
    t('反面教材改好了，不是删掉了事', 'The counter-example is fixed, not deleted'),
    t('该用 PSA 的用 PSA', 'PSA where PSA belongs'),
  ],
  hints: [
    t(
      'PSA 是三档预置标准，靠命名空间标签开启，不写规则：\`restricted\` 已经包含「不许特权、不许 hostPath」以及更多。它挡不住的是「必须有 owner 标签」这种公司自定义的规矩 —— 那才是 Kyverno 的活。',
      'PSA offers three preset levels switched on by a namespace label, with no rules to write: `restricted` already covers "no privileged, no hostPath" and more. What it cannot express is a company-specific rule like "must carry an owner label", and that is what Kyverno is for.'
    ),
    t(
      'PSA 只看 **Pod**。给命名空间打上 \`enforce=restricted\` 之后，违规的 Deployment 照样 apply 得进去 —— 然后一个 Pod 都起不来，原因在 ReplicaSet 的事件里（\`kubectl describe rs\`）。',
      'PSA only inspects **Pods**. After labelling the namespace `enforce=restricted`, a violating Deployment still applies cleanly and then produces no pods at all; the reason sits in the ReplicaSet events (`kubectl describe rs`).'
    ),
    t(
      '签名签的是镜像的 **digest**，不是 tag。所以先把镜像推进内网仓库、再签，顺序反了签的就是另一个东西。Kyverno 的 \`verifyImages\` 里填的是公钥，不是私钥。',
      'A signature covers the image **digest**, not the tag. Push to the internal registry first and sign after; the other order signs something else. The `publicKeys` field in Kyverno `verifyImages` takes the public key, not the private one.'
    ),
  ],
  pitfalls: [
    t(
      '用 Kyverno 再写一遍「不许特权容器」。能用，但那是在维护一份和上游 PSA 并行的实现 —— 上游加了新的提权途径，你的规则不会跟着更新。能交给 PSA 的就交给它。',
      'Reimplementing "no privileged containers" as a Kyverno rule. It works, but it means maintaining a parallel copy of upstream PSA: when upstream adds a newly discovered escalation path, your rule does not follow. Hand to PSA what PSA covers.'
    ),
    t(
      '把 \`validationFailureAction\` 写成 \`Audit\` 就以为拦住了。Audit 只记录，对象照样进集群 —— 和 PSA 那边只打 \`warn\` 标签是同一个误会。',
      'Setting `validationFailureAction: Audit` and believing it blocks. Audit only records; the object still lands. It is the same misunderstanding as labelling a namespace with only `warn` on the PSA side.'
    ),
    t(
      '把违规的 \`cache\` 删掉交差。删掉当然不违规了，但业务也没了 —— 判定要求它跑着。策略的意义是让人把东西改对，不是把东西删光。',
      'Deleting the offending `cache` and calling it done. Nothing violates once nothing runs, but the workload is gone too, and the grader requires it running. Policy exists to make things correct, not to make them disappear.'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    objects: [
      CNI_CILIUM,
      ...GATEWAY_PLATFORM, ...CERT_MANAGER_PLATFORM, ...TLS_PLATFORM, ...KYVERNO_PLATFORM,
      ...PORTAL_WORKLOAD, PORTAL_ROUTE, SLOPPY_CACHE,
    ],
    files: {
      '/root/infra/policy.yaml': POLICY_STARTER,
      '/root/infra/cache.yaml': CACHE_FIXED,
    },
    referenceFiles: { '/root/infra/policy.yaml': POLICY_REFERENCE },
    referenceCommands: [
      'cosign generate-key-pair',
      'cosign sign --key cosign.key harbor.corp.internal/team/sessions:1.8.0',
      // 公钥要现填 —— 每次生成的密钥都不一样，写死在文件里没有意义
      VERIFY_POLICY_COMMAND,
      'kubectl label namespace payments pod-security.kubernetes.io/enforce=restricted',
      'kubectl apply -f /root/infra/policy.yaml',
      'kubectl apply -f /root/infra/verify.yaml',
      /**
       * 这里是 replace 不是 apply。
       *
       * `cache` 最初不是 apply 建出来的（没有 last-applied 注解），
       * 这时候 apply 走的是两路合并：新清单里没写的字段（privileged、
       * hostPath 卷）会**原样留着**。kubectl 自己会警告这一点。
       * replace 是整体替换，对象变成清单里的样子。
       */
      'kubectl replace -f /root/infra/cache.yaml',
    ],
  },
  specs: [
    spec('policy-as-code.spec.ts', code`
      import { get, list, sh } from '@ops/lab';

      const violating = (name, patch) => JSON.stringify({
        apiVersion: 'v1', kind: 'Pod',
        metadata: { name, namespace: 'payments', labels: { owner: 'payments' } },
        spec: {
          securityContext: { runAsNonRoot: true, seccompProfile: { type: 'RuntimeDefault' } },
          containers: [{
            name: 'app', image: 'harbor.corp.internal/team/sessions:1.8.0',
            securityContext: {
              allowPrivilegeEscalation: false, runAsNonRoot: true,
              capabilities: { drop: ['ALL'] },
            },
          }],
          ...patch,
        },
      });

      const apply = async (json) => sh("echo '" + json + "' | kubectl apply -f -");

      describe('策略即代码', () => {
        it('特权容器进不来', async () => {
          const result = await apply(violating('privileged-probe', {
            containers: [{
              name: 'app', image: 'harbor.corp.internal/team/sessions:1.8.0',
              securityContext: { privileged: true },
            }],
          }));
          expect(result.code).not.toBe(0);
          expect(result.stderr).toContain('PodSecurity');
        });

        it('hostPath 进不来', async () => {
          const result = await apply(violating('hostpath-probe', {
            volumes: [{ name: 'root', hostPath: { path: '/' } }],
          }));
          expect(result.code).not.toBe(0);
        });

        it('没有 owner 标签进不来', async () => {
          const json = violating('no-owner', {}).replace('"owner":"payments"', '"tier":"cache"');
          const result = await apply(json);
          expect(result.code).not.toBe(0);
          expect(result.stderr).toContain('owner');
        });

        it('公网镜像进不来', async () => {
          const json = violating('public-image', {})
            .replace(/harbor.corp.internal\\/team\\/sessions:1.8.0/g, 'docker.io/library/redis:7.4');
          const result = await apply(json);
          expect(result.code).not.toBe(0);
        });

        it('没签名的内网镜像也进不来', async () => {
          const json = violating('unsigned', {})
            .replace(/harbor.corp.internal\\/team\\/sessions:1.8.0/g, 'harbor.corp.internal/team/reports:2.1.0');
          const result = await apply(json);
          expect(result.code).not.toBe(0);
          expect(result.stderr).toContain('not signed');
        });

        it('规规矩矩的 Pod 进得来', async () => {
          const result = await apply(violating('good-probe', {}));
          expect(result.code).toBe(0);
        });

        it('cache 改好了并且跑着 —— 不是删掉了事', () => {
          const deployment = get('Deployment', 'cache', 'payments');
          expect(deployment).toBeTruthy();
          expect(deployment.status.readyReplicas).toBeGreaterThan(0);
        });

        it('第 1 条交给了 PSA，不是自己写一遍', () => {
          const namespace = get('Namespace', 'payments');
          const level = namespace.metadata.labels['pod-security.kubernetes.io/enforce'];
          expect(['baseline', 'restricted']).toContain(level);
        });

        it('策略是 Enforce 不是 Audit', () => {
          const policies = list('ClusterPolicy');
          expect(policies.length).toBeGreaterThan(0);
          for (const policy of policies) {
            expect(policy.spec.validationFailureAction || 'Enforce').toBe('Enforce');
          }
        });
      });
    `),
  ],
  focus: ['correctness', 'maintainability'],
  extension: t(
    code`
      两层策略的分工值得记清楚。**PSA** 是 Kubernetes 内置的，三档预置标准，
      靠命名空间标签开关，卸不掉也改不了 —— 它的价值恰恰在这里：上游发现了
      新的提权途径，你升级集群就自动跟上，不需要维护任何规则。
      **Kyverno**（以及 ValidatingAdmissionPolicy）管的是公司自己的规矩：
      标签、镜像来源、命名约定、成本归属。能交给 PSA 的别自己写。

      供应链那条最容易被做成摆设。签名签的是 **digest**，所以它保证的是
      「这一坨字节被某把私钥认过」，不多也不少。它**不**保证镜像里没有漏洞，
      也不保证签它的人有资格签。真正要配套的是：谁持有私钥、密钥怎么轮转、
      以及验签之外还要看 SBOM 与来源证明（SLSA provenance）。
      只做验签而不管密钥归属，安全性等于「有人签过」这四个字。

      最后一点关于推行：策略上线永远从 \`Audit\` 开始，看几天报表，
      把存量违规改完，再切 \`Enforce\`。直接 Enforce 的后果不是策略被绕过，
      是有人半夜把策略删了 —— 那比没有策略更糟，因为没人知道它被删了。
    `,
    code`
      The division of labour between the two layers is worth internalising. **PSA** is
      built into Kubernetes: three preset levels toggled by a namespace label, neither
      removable nor customisable, and that rigidity is the point. When upstream learns
      of a new escalation path, upgrading the cluster picks it up with no rules for you
      to maintain. **Kyverno** (and ValidatingAdmissionPolicy) covers company-specific
      rules: labels, image provenance, naming conventions, cost attribution. Hand to
      PSA what PSA covers.

      The supply-chain rule is the easiest to turn into theatre. A signature covers the
      **digest**, so it guarantees exactly one thing: these bytes were vouched for by
      some private key. It does **not** say the image is free of vulnerabilities, nor
      that whoever signed was entitled to. What has to come with it is key custody, a
      rotation story, and looking beyond signatures at SBOMs and build provenance
      (SLSA). Verifying signatures without governing the keys means the guarantee is
      literally "somebody signed this".

      One note on rollout: ship policies as \`Audit\` first, watch the reports for a few
      days, fix the existing violations, then switch to \`Enforce\`. Going straight to
      Enforce does not get the policy bypassed; it gets the policy deleted at 2am,
      which is worse than having none, because nobody knows it is gone.
    `
  ),
};


/* ------------------------------------------------------------------ */
/* 第 18 关                                                            */
/* ------------------------------------------------------------------ */

const ESO_PLATFORM = [
  { apiVersion: 'v1', kind: 'ServiceAccount', metadata: { name: 'eso', namespace: 'payments' } },
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: {
      name: 'external-secrets', namespace: 'external-secrets',
      labels: { 'app.kubernetes.io/name': 'external-secrets' },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': 'external-secrets' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'external-secrets' } },
        spec: { containers: [{ name: 'controller', image: ESO_IMAGE, ports: [{ containerPort: 8080 }] }] },
      },
    },
  },
];

/** 前任把口令直接写进了 Secret，还提交进了 Git */
const HARDCODED_SECRET = {
  apiVersion: 'v1', kind: 'Secret',
  metadata: { name: 'db-credentials', namespace: 'payments' },
  type: 'Opaque',
  data: {
    username: 'cGF5bWVudHNfYXBw',
    // Ph4i-Quee0oh，base64 不是加密
    password: 'UGg0aS1RdWVlMG9o',
  },
};

/** 门户从这个 Secret 里拿数据库口令 */
const PORTAL_WITH_DB = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'portal', namespace: 'payments' },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: 'portal' } },
      template: {
        metadata: { labels: { app: 'portal' } },
        spec: {
          containers: [{
            name: 'web', image: PORTAL_IMAGE, ports: [{ containerPort: 8080 }],
            env: [
              { name: 'DB_USER', valueFrom: { secretKeyRef: { name: 'db-credentials', key: 'username' } } },
              { name: 'DB_PASSWORD', valueFrom: { secretKeyRef: { name: 'db-credentials', key: 'password' } } },
            ],
          }],
        },
      },
    },
  },
  {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name: 'portal', namespace: 'payments' },
    spec: { clusterIP: '10.96.1.10', selector: { app: 'portal' }, ports: [{ port: 80, targetPort: 8080 }] },
  },
];

const ESO_STARTER = code`
  # 目标：让 db-credentials 由 ESO 从 OpenBao 同步出来，
  # 而不是有人手工创建、再提交进 Git。
  #
  # 口令在 kv/payments/db 下面，策略 payments-read 已经写好了。
  # Kubernetes 认证还没开。
`;

const ESO_REFERENCE = code`
  apiVersion: external-secrets.io/v1
  kind: SecretStore
  metadata:
    name: openbao
    namespace: payments
  spec:
    provider:
      vault:
        server: https://openbao.corp.internal:8200
        path: kv
        auth:
          kubernetes:
            role: payments
            serviceAccountRef:
              name: eso
  ---
  apiVersion: external-secrets.io/v1
  kind: ExternalSecret
  metadata:
    name: db-credentials
    namespace: payments
  spec:
    refreshInterval: 1m
    secretStoreRef:
      name: openbao
      kind: SecretStore
    target:
      name: db-credentials
    data:
    - secretKey: username
      remoteRef:
        key: payments/db
        property: username
    - secretKey: password
      remoteRef:
        key: payments/db
        property: password
`;

const stage18 = {
  id: 'external-secrets',
  title: t('把密钥搬出集群', 'Move the Secrets Out of the Cluster'),
  goal: t(
    code`
      安全评审第四条：数据库口令不该以任何形式存在于集群和 Git 仓库里。
      现状是前任手工建了一个 Secret \`db-credentials\`，门户从它取值 ——
      而那份 YAML 就躺在平台仓库里。**Kubernetes 的 Secret 只是 base64，
      不是加密**，谁能 \`get secret\` 谁就看得到明文。

      内网有一台 OpenBao（\`https://openbao.corp.internal:8200\`），口令已经放在
      \`kv/payments/db\` 下面了，读它的策略 \`payments-read\` 也写好了。
      External Secrets Operator 装好了。缺的是把这条路打通。

      运维手上的 root 令牌是 \`bao-root-token\`。

      ## 通关标准

      1. \`db-credentials\` 由 ESO 同步出来，值和 OpenBao 里的一致；
      2. 门户照常跑着，能从这个 Secret 取到口令；
      3. ESO 用 **Kubernetes 认证**去 OpenBao 换令牌，不是拿一把静态令牌
         （那把令牌本身又是一个要保管的密钥）；
      4. 有人在 OpenBao 里轮转了口令之后，集群里会自己跟上；
      5. 集群里不再有手工维护的那份明文。

      ## 会用到的命令

      \`\`\`bash
      export BAO_ADDR=https://openbao.corp.internal:8200
      export BAO_TOKEN=bao-root-token
      bao kv get kv/payments/db
      bao auth enable kubernetes
      bao write auth/kubernetes/role/payments \\
        bound_service_account_names=eso \\
        bound_service_account_namespaces=payments \\
        policies=payments-read
      kubectl apply -f /root/infra/eso.yaml
      kubectl describe externalsecret db-credentials -n payments
      \`\`\`
    `,
    code`
      Fourth item from the security review: the database password must not exist in
      the cluster or in Git in any form. Today your predecessor hand-created a Secret
      called \`db-credentials\` that the portal reads from, and that YAML sits in the
      platform repository. **A Kubernetes Secret is base64, not encryption**: anyone
      who can \`get secret\` reads the plaintext.

      The intranet runs an OpenBao at \`https://openbao.corp.internal:8200\`. The
      password already lives under \`kv/payments/db\` and a \`payments-read\` policy
      exists. External Secrets Operator is installed. What is missing is the wiring.

      The operator root token is \`bao-root-token\`.

      ## Done when

      1. \`db-credentials\` is produced by ESO and matches what OpenBao holds;
      2. the portal still runs and still reads the password from that Secret;
      3. ESO authenticates to OpenBao with **Kubernetes auth**, not a static token
         (a static token is itself one more secret to look after);
      4. rotating the password in OpenBao propagates into the cluster on its own;
      5. no hand-maintained plaintext copy is left in the cluster.

      ## Commands you will need

      \`\`\`bash
      export BAO_ADDR=https://openbao.corp.internal:8200
      export BAO_TOKEN=bao-root-token
      bao kv get kv/payments/db
      bao auth enable kubernetes
      bao write auth/kubernetes/role/payments \\
        bound_service_account_names=eso \\
        bound_service_account_namespaces=payments \\
        policies=payments-read
      kubectl apply -f /root/infra/eso.yaml
      kubectl describe externalsecret db-credentials -n payments
      \`\`\`
    `
  ),
  checklist: [
    t('Secret 由 ESO 同步，不是手工建的', 'The Secret is synced by ESO, not hand-made'),
    t('认证用 ServiceAccount，不是静态令牌', 'Authentication uses a ServiceAccount, not a static token'),
    t('外部轮转之后集群自己跟上', 'Rotation outside propagates in on its own'),
  ],
  hints: [
    t(
      'KV v2 有一处容易绊人：挂载路径和读写路径不是一回事。引擎挂在 \`kv/\` 上，\`bao kv get kv/payments/db\` 实际读的是 \`kv/data/payments/db\`。SecretStore 里 \`path: kv\` 指的是挂载路径，\`remoteRef.key\` 里就不要再带 \`kv/\` 了。',
      'KV v2 trips people on paths: the mount path and the read path differ. With the engine mounted at `kv/`, `bao kv get kv/payments/db` actually reads `kv/data/payments/db`. In a SecretStore, `path: kv` is the mount, so `remoteRef.key` should not repeat `kv/`.'
    ),
    t(
      'Kubernetes 认证要两步：先 \`bao auth enable kubernetes\` 打开这个方法，再写一个角色说明「哪些 ServiceAccount 能登录、登录后拿哪个策略」。三个参数缺一不可，最容易漏的是命名空间那个。',
      'Kubernetes auth takes two steps: `bao auth enable kubernetes` turns the method on, then a role states which ServiceAccounts may log in and which policy they receive. All three parameters are required, and the namespaces one is the usual omission.'
    ),
    t(
      'ESO 同步出来的 Secret 归控制器管。手改它没有意义 —— 下一轮同步会盖回去。同理，删掉 ExternalSecret，那份投影也跟着走。',
      'The Secret ESO produces belongs to the controller. Editing it by hand is pointless because the next sync overwrites it, and deleting the ExternalSecret takes the projection with it.'
    ),
  ],
  pitfalls: [
    t(
      '用静态令牌图省事：把 root 令牌塞进一个 Secret，让 SecretStore 从那儿读。这样一来集群里存的是一把**能读所有密钥的**令牌 —— 比原来那个只泄露一个口令的 Secret 更糟。判定检查 SecretStore 用的是哪种认证。',
      'Reaching for a static token: putting the root token in a Secret and pointing the SecretStore at it. Now the cluster stores a credential that reads **every** secret, which is worse than the single leaked password you started with. The grader checks which auth method the SecretStore uses.'
    ),
    t(
      '以为 Secret 是加密的。它只是 base64，\`kubectl get secret -o yaml\` 加一句 \`base64 -d\` 就是明文。集群里的 Secret 唯一的保护是 RBAC —— 这也是为什么第 16 关那些角色不能给出 Secret 的读权限。',
      'Believing a Secret is encrypted. It is base64, and `kubectl get secret -o yaml` piped through `base64 -d` prints the plaintext. RBAC is the only protection a Secret has in the cluster, which is why the roles in the RBAC stage must not grant Secret reads.'
    ),
    t(
      '把 \`refreshInterval\` 当成实时。轮转之后集群里不会立刻变，要等下一轮同步。真出事要立刻生效时，得主动触发一次（改一下 ExternalSecret 让它重新 reconcile），别干等。',
      'Treating `refreshInterval` as realtime. After rotation the cluster lags until the next sync. When an incident needs it now, force a reconcile (touch the ExternalSecret) instead of waiting.'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    objects: [
      CNI_CILIUM,
      ...GATEWAY_PLATFORM, ...CERT_MANAGER_PLATFORM, ...TLS_PLATFORM, ...ESO_PLATFORM,
      HARDCODED_SECRET, ...PORTAL_WITH_DB, PORTAL_ROUTE,
    ],
    files: { '/root/infra/eso.yaml': ESO_STARTER },
    referenceFiles: { '/root/infra/eso.yaml': ESO_REFERENCE },
    referenceCommands: [
      'BAO_ADDR=https://openbao.corp.internal:8200 BAO_TOKEN=bao-root-token bao auth enable kubernetes',
      'BAO_ADDR=https://openbao.corp.internal:8200 BAO_TOKEN=bao-root-token bao write'
        + ' auth/kubernetes/role/payments bound_service_account_names=eso'
        + ' bound_service_account_namespaces=payments policies=payments-read',
      // 先把手工那份删掉，ESO 才好把自己那份建出来
      'kubectl delete secret db-credentials -n payments',
      'kubectl apply -f /root/infra/eso.yaml',
    ],
  },
  specs: [
    spec('external-secrets.spec.ts', code`
      import { advance, get, list, sh } from '@ops/lab';

      describe('把密钥搬出集群', () => {
        it('Secret 由 ESO 同步出来', () => {
          const external = get('ExternalSecret', 'db-credentials', 'payments');
          expect(external).toBeTruthy();
          const ready = external.status.conditions.find((entry) => entry.type === 'Ready');
          expect(ready.status).toBe('True');

          const secret = get('Secret', 'db-credentials', 'payments');
          expect(secret).toBeTruthy();
          const owner = (secret.metadata.ownerReferences || [])[0];
          expect(owner.kind).toBe('ExternalSecret');
        });

        it('值和 OpenBao 里的一致', async () => {
          const result = await sh(
            'kubectl get secret db-credentials -n payments'
            + " -o jsonpath='{.data.password}' | base64 -d"
          );
          expect(result.stdout.trim()).toBe('Ph4i-Quee0oh');
        });

        it('门户照常跑着', () => {
          const deployment = get('Deployment', 'portal', 'payments');
          expect(deployment.status.readyReplicas).toBe(2);
        });

        it('认证用的是 ServiceAccount，不是静态令牌', () => {
          const stores = list('SecretStore', { namespace: 'payments' });
          expect(stores.length).toBeGreaterThan(0);
          for (const store of stores) {
            const auth = store.spec.provider.vault.auth || {};
            expect(auth.kubernetes).toBeTruthy();
            expect(auth.tokenSecretRef).toBeFalsy();
          }
        });

        it('集群里没有另一份手工维护的明文', () => {
          const managed = list('Secret', { namespace: 'payments' })
            .filter((secret) => (secret.data || {}).password !== undefined)
            .filter((secret) => !(secret.metadata.ownerReferences || [])
              .some((owner) => owner.kind === 'ExternalSecret'));
          expect(managed).toEqual([]);
        });

        it('OpenBao 里轮转之后，集群自己跟上', async () => {
          await sh(
            'BAO_ADDR=https://openbao.corp.internal:8200 BAO_TOKEN=bao-root-token'
            + ' bao kv put kv/payments/db username=payments_app password=R0tated-N0w host=pg.corp.internal'
          );
          // 等一轮同步。ESO 是按 refreshInterval 拉的，不是实时的。
          await advance(120000);
          const result = await sh(
            'kubectl get secret db-credentials -n payments'
            + " -o jsonpath='{.data.password}' | base64 -d"
          );
          expect(result.stdout.trim()).toBe('R0tated-N0w');
        });
      });
    `),
  ],
  focus: ['correctness', 'maintainability'],
  extension: t(
    code`
      这一关解决的是 GitOps 与密钥管理的矛盾：**仓库要能被所有人读，密钥不能**。
      External Secrets 的答案是让仓库里只放「去哪儿取」的说明，取到的东西
      由控制器写进集群，谁都不用把明文提交上去。

      要清楚它**没有**解决什么：同步出来的 Secret 在集群里仍然是 base64。
      能 \`get secret\` 的人照样看得到明文。所以这一层必须和 RBAC 叠着用 ——
      密钥搬出集群解决的是「不要泄露在 Git 里」，不是「集群里也看不到」。
      再往上一层是 etcd 静态加密（EncryptionConfiguration），那管的是磁盘被
      拷走的场景。三层各管一段，缺一不可。

      认证方式的选择比工具选择更重要。静态令牌是个死循环：为了保护密钥，
      你先得保护一把能读所有密钥的令牌。Kubernetes 认证跳出了这个循环 ——
      身份由集群签发、短期有效、绑定到具体的 ServiceAccount，泄露一份
      Pod 的 token 也只能拿到那个 SA 的权限。云上的 IRSA / Workload Identity
      是同一个思路的不同实现。
    `,
    code`
      This stage resolves the tension between GitOps and secret management:
      **the repository must be readable by everyone, and secrets must not be.**
      External Secrets answers it by keeping only "where to fetch it from" in Git,
      with the controller writing the fetched value into the cluster, so nobody ever
      commits plaintext.

      Be clear about what it does **not** solve: the synced Secret is still base64
      inside the cluster, and anyone who can \`get secret\` still reads it. So this
      layer stacks with RBAC. Moving secrets out of the cluster addresses "do not leak
      them through Git", not "nobody in the cluster can see them". One layer further up
      is etcd encryption at rest (EncryptionConfiguration), which addresses a stolen
      disk. Three layers, each covering a different exposure.

      Choosing the authentication method matters more than choosing the tool. A static
      token is circular: to protect your secrets you first have to protect a token that
      reads all of them. Kubernetes auth breaks the circle, because identity is issued
      by the cluster, short lived, and bound to a specific ServiceAccount, so a leaked
      pod token buys only that ServiceAccount permissions. IRSA and Workload Identity
      in the clouds are the same idea with different plumbing.
    `
  ),
};


/* ------------------------------------------------------------------ */
/* 第 19 关                                                            */
/* ------------------------------------------------------------------ */

const MONITORING_PLATFORM = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: {
      name: 'prometheus', namespace: 'monitoring',
      labels: { 'app.kubernetes.io/name': 'prometheus' },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': 'prometheus' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'prometheus' } },
        spec: { containers: [{ name: 'prometheus', image: PROMETHEUS_IMAGE, ports: [{ containerPort: 9090 }] }] },
      },
    },
  },
  {
    apiVersion: 'monitoring.coreos.com/v1', kind: 'Prometheus',
    metadata: { name: 'main', namespace: 'monitoring' },
    spec: {
      // 平台组的约定：只采带这个标签的 ServiceMonitor
      serviceMonitorSelector: { matchLabels: { release: 'kube-prom' } },
      replicas: 1,
    },
  },
];

/** 报表服务上了一个坏版本：进程活着、探针照过，但五分之一的请求 500 */
const REPORTS_DEGRADED = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'reports', namespace: 'payments' },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: 'reports' } },
      template: {
        metadata: { labels: { app: 'reports' } },
        spec: {
          containers: [{
            name: 'app', image: REPORTS_IMAGE_BAD,
            ports: [{ containerPort: 9090 }],
            resources: { requests: { memory: '256Mi' }, limits: { memory: '1Gi' } },
          }],
        },
      },
    },
  },
  {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name: 'reports', namespace: 'payments', labels: { app: 'reports' } },
    spec: { selector: { app: 'reports' }, ports: [{ port: 80, targetPort: 9090 }] },
  },
];

const MONITORING_STARTER = code`
  # 采集与告警都还没配。
  #
  # 提示：Prometheus 实例上写着 serviceMonitorSelector，
  #      去看看它要求 ServiceMonitor 带什么标签。
`;

const MONITORING_REFERENCE = code`
  apiVersion: monitoring.coreos.com/v1
  kind: ServiceMonitor
  metadata:
    name: reports
    namespace: payments
    labels:
      release: kube-prom
  spec:
    selector:
      matchLabels:
        app: reports
    endpoints:
    - port: http
  ---
  apiVersion: monitoring.coreos.com/v1
  kind: ServiceMonitor
  metadata:
    name: portal
    namespace: payments
    labels:
      release: kube-prom
  spec:
    selector:
      matchLabels:
        app: portal
    endpoints:
    - port: http
  ---
  apiVersion: monitoring.coreos.com/v1
  kind: PrometheusRule
  metadata:
    name: payments
    namespace: payments
    labels:
      release: kube-prom
  spec:
    groups:
    - name: payments.rules
      rules:
      - alert: TargetDown
        expr: up == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "{{ $labels.job }} 的 {{ $labels.pod }} 采不到了"
      - alert: HighErrorRate
        expr: sum(rate(http_requests_total{code=~"5.."}[5m])) by (job)
          / sum(rate(http_requests_total[5m])) by (job) > 0.05
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "{{ $labels.job }} 的 5xx 比例是 {{ $value }}"
`;

const stage19 = {
  id: 'metrics-and-alerts',
  title: t('让集群自己说出哪儿不对', 'Let the Cluster Say What Is Wrong'),
  goal: t(
    code`
      财务报了一个说不清的问题：「报表有时候打不开，刷新几次又好了」。
      \`kubectl get pods\` 全是 Running，探针全过，日志里也没有异常堆栈 ——
      因为进程确实活着，只是**一部分请求返回了 5xx**。

      这类问题不看指标是查不出来的。Prometheus 装好了，但集群里一个
      \`ServiceMonitor\` 都没有，一条告警规则也没有。

      ## 通关标准

      1. 门户与报表的指标都采得到（\`up\` 有它们的序列）；
      2. 有一条按 **PromQL 求值**的错误率告警，能真的触发；
      3. 有一条目标掉线的告警；
      4. 两条都带 \`for\`，抖动不会立刻变成告警；
      5. 规则文件过 \`promtool check rules\`。

      ## 会用到的命令

      \`\`\`bash
      kubectl get prometheus -n monitoring -o yaml
      kubectl apply -f /root/infra/monitoring.yaml
      promtool check rules /root/infra/monitoring.yaml
      promtool query instant http://localhost:9090 'up'
      promtool query instant http://localhost:9090 'sum(rate(http_requests_total{code=~"5.."}[5m])) by (job)'
      \`\`\`
    `,
    code`
      Finance reports something vague: "the reports page sometimes fails, refreshing a
      few times fixes it". \`kubectl get pods\` shows everything Running, probes pass,
      and the logs hold no stack traces, because the process really is alive and only
      **some requests return 5xx**.

      Problems like this are invisible without metrics. Prometheus is installed, but
      the cluster has no \`ServiceMonitor\` and no alerting rules at all.

      ## Done when

      1. metrics from the portal and reports are being collected (\`up\` has series for
         both);
      2. an error-rate alert exists, evaluated as real **PromQL**, and it fires;
      3. a target-down alert exists;
      4. both carry \`for\`, so a blip does not become a page;
      5. the rule file passes \`promtool check rules\`.

      ## Commands you will need

      \`\`\`bash
      kubectl get prometheus -n monitoring -o yaml
      kubectl apply -f /root/infra/monitoring.yaml
      promtool check rules /root/infra/monitoring.yaml
      promtool query instant http://localhost:9090 'up'
      promtool query instant http://localhost:9090 'sum(rate(http_requests_total{code=~"5.."}[5m])) by (job)'
      \`\`\`
    `
  ),
  checklist: [
    t('指标采得到', 'Metrics are being collected'),
    t('告警按 PromQL 求值并真的触发', 'Alerts evaluate as PromQL and fire'),
    t('带 for，抖动不会变成告警', 'They carry for, so blips do not page'),
  ],
  hints: [
    t(
      '采集要过**两层**选择器：Prometheus 实例的 \`serviceMonitorSelector\` 先选中 ServiceMonitor，ServiceMonitor 的 \`selector\` 再选中 Service。少配哪一层都是一条指标都采不到，而两边看起来都很正常。',
      'Collection passes **two** selectors: the Prometheus instance `serviceMonitorSelector` picks ServiceMonitors, and the ServiceMonitor `selector` picks Services. Miss either and nothing is collected, while both objects look perfectly fine.'
    ),
    t(
      '错误率是**两个 rate 相除**，不是一个计数。分子分母都要先 \`sum ... by (job)\` 聚合到同一组标签上，否则两边配不上，表达式返回空 —— 而返回空的告警永远不会触发，也不会报错。',
      'An error rate is **one rate divided by another**, not a count. Aggregate both sides with `sum ... by (job)` onto the same label set, or they will not match and the expression returns nothing. An alert whose expression returns nothing never fires and never complains.'
    ),
    t(
      '写完先 \`promtool check rules\` 跑一遍，再 \`promtool query instant\` 把表达式单独查一次。apiserver 收 PrometheusRule 的时候**不校验表达式**，写错了照样收下。',
      'Run `promtool check rules` first, then query the expression alone with `promtool query instant`. The apiserver does **not validate expressions** when accepting a PrometheusRule; a broken one is stored happily.'
    ),
  ],
  pitfalls: [
    t(
      '用 \`http_requests_total{code=~"5.."} > 0\` 当告警。counter 只会涨，这条从第一个 5xx 起就永远成立 —— 而且它衡量的是「历史上出过多少错」，不是「现在错得多不多」。错误率永远要用 \`rate\` 加除法。',
      'Alerting on `http_requests_total{code=~"5.."} > 0`. A counter only grows, so this is true forever after the first 5xx, and it measures how many errors ever happened rather than how bad things are now. Error rates always need `rate` and a division.'
    ),
    t(
      '不写 \`for\`。一次采集抖动就会发一条告警，收告警的人很快就不看了 —— 而这比没有告警更糟，因为大家会以为「有人在盯着」。',
      'Omitting `for`. A single scrape blip pages someone, and people stop reading alerts, which is worse than having none because everyone assumes somebody is watching.'
    ),
    t(
      '以为指标里能看到一切。采集是**定时拉**的（默认 15 秒一次），只活了十秒的 Pod 很可能一个点都没采到。指标回答的是「持续的、按比例的」问题；一次性的、短暂的事件要看 Event 与日志。',
      'Expecting metrics to show everything. Scraping is **periodic pull** (15s by default), so a pod that lived ten seconds may contribute no samples at all. Metrics answer sustained, proportional questions; one-off short events live in Events and logs.'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    objects: [
      CNI_CILIUM,
      ...GATEWAY_PLATFORM, ...CERT_MANAGER_PLATFORM, ...TLS_PLATFORM, ...MONITORING_PLATFORM,
      ...PORTAL_WORKLOAD, PORTAL_ROUTE, ...REPORTS_DEGRADED,
    ],
    files: { '/root/infra/monitoring.yaml': MONITORING_STARTER },
    referenceFiles: { '/root/infra/monitoring.yaml': MONITORING_REFERENCE },
    referenceCommands: [
      'kubectl apply -f /root/infra/monitoring.yaml',
    ],
  },
  specs: [
    spec('metrics-and-alerts.spec.ts', code`
      import { advance, list, sh } from '@ops/lab';

      const PROM = 'http://localhost:9090';

      describe('指标与告警', () => {
        it('门户与报表的指标都采得到', async () => {
          await advance(300000);
          const result = await sh("promtool query instant " + PROM + " 'up'");
          expect(result.code).toBe(0);
          expect(result.stdout).toContain('payments/reports');
          expect(result.stdout).toContain('payments/portal');
        });

        it('规则文件是干净的', async () => {
          const result = await sh('promtool check rules /root/infra/monitoring.yaml');
          expect(result.code).toBe(0);
          expect(result.stdout).toContain('SUCCESS');
        });

        it('错误率告警真的触发了', async () => {
          await advance(1200000);
          const rules = list('PrometheusRule', { namespace: 'payments' });
          expect(rules.length).toBeGreaterThan(0);

          const firing = list('Pod', { namespace: 'monitoring' });
          expect(firing.length).toBeGreaterThan(0);

          const result = await sh(
            "promtool query instant " + PROM
            + " 'sum(rate(http_requests_total{code=~\\"5..\\"}[5m])) by (job)"
            + " / sum(rate(http_requests_total[5m])) by (job) > 0.05'"
          );
          expect(result.stdout).toContain('payments/reports');
          // 门户没坏，不该出现在结果里
          expect(result.stdout).not.toContain('payments/portal');
        });

        it('告警是按 PromQL 写的，而且带 for', () => {
          const rules = list('PrometheusRule', { namespace: 'payments' })
            .flatMap((rule) => (rule.spec.groups || []).flatMap((group) => group.rules || []))
            .filter((rule) => rule.alert);
          expect(rules.length).toBeGreaterThanOrEqual(2);
          for (const rule of rules) {
            expect(rule.for).toBeTruthy();
          }
          // 错误率那条必须是比率，不能是裸计数
          const rate = rules.find((rule) => /rate\\(/.test(rule.expr) && rule.expr.includes('/'));
          expect(rate).toBeTruthy();
        });

        it('有一条目标掉线的告警', () => {
          const rules = list('PrometheusRule', { namespace: 'payments' })
            .flatMap((rule) => (rule.spec.groups || []).flatMap((group) => group.rules || []));
          expect(rules.some((rule) => /\\bup\\b/.test(rule.expr || ''))).toBe(true);
        });

        it('ServiceMonitor 带上了 Prometheus 要求的标签', () => {
          const monitors = list('ServiceMonitor', { namespace: 'payments' });
          expect(monitors.length).toBeGreaterThanOrEqual(2);
          for (const monitor of monitors) {
            expect(monitor.metadata.labels.release).toBe('kube-prom');
          }
        });
      });
    `),
  ],
  focus: ['observability', 'correctness'],
  extension: t(
    code`
      这一关的场景之所以值得单独练，是因为它落在**监控的盲区之间**：
      进程活着（探针过）、日志没异常（5xx 是正常返回不是崩溃）、
      Pod 没重启（\`kubectl get\` 一片绿）。三个最常用的信号全说「没事」，
      只有比例型指标看得出来。

      三类信号各管一段，混着用才完整：**指标**回答「持续的、按比例的」问题
      （错误率、延迟分位数、饱和度），代价是采样间隔之间的事看不见；
      **日志**回答「这一次具体发生了什么」，代价是量大且没有聚合；
      **链路追踪**回答「这一次请求在哪一跳慢了」，代价是采样率与埋点成本。
      拿指标去查单次请求、拿日志去算错误率，都是用错了工具。

      告警上有一条经验值得记：**告的应该是症状，不是原因**。
      「错误率超过 5%」是症状，用户感受得到；「某个 Pod 内存高」是原因，
      而且高内存不一定有影响。按原因告警的系统会在半夜叫醒一个人，
      让他去看一个用户根本没感觉的指标 —— 几次之后就没人看告警了。
    `,
    code`
      This scenario is worth practising because it falls **between the blind spots**:
      the process is alive (probes pass), the logs are clean (a 5xx is a normal
      response, not a crash), and no pod restarted (\`kubectl get\` is all green). The
      three signals people reach for first all say "fine", and only a proportional
      metric shows the problem.

      Three signal types cover different ground and only work together. **Metrics**
      answer sustained, proportional questions (error rate, latency quantiles,
      saturation) at the cost of blindness between scrapes. **Logs** answer what
      happened in one specific case, at the cost of volume and no aggregation.
      **Traces** answer which hop was slow for one request, at the cost of sampling and
      instrumentation. Using metrics to investigate a single request, or logs to
      compute an error rate, is using the wrong tool.

      One rule of thumb about alerting: **alert on symptoms, not causes**. "Error rate
      above 5%" is a symptom users feel; "this pod uses a lot of memory" is a cause,
      and high memory may have no effect at all. Alerting on causes wakes someone at
      3am to look at a number no user noticed, and after a few of those nobody reads
      the alerts any more.
    `
  ),
};


/* ------------------------------------------------------------------ */
/* 第 20 关                                                            */
/* ------------------------------------------------------------------ */

const ROLLOUTS_PLATFORM = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: {
      name: 'argo-rollouts', namespace: 'argocd',
      labels: { 'app.kubernetes.io/name': 'argo-rollouts' },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': 'argo-rollouts' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'argo-rollouts' } },
        spec: { containers: [{ name: 'controller', image: ROLLOUTS_IMAGE }] },
      },
    },
  },
];

/** 第 19 关配好的监控，这一关还要用 —— 金丝雀的判据就是它 */
const MONITORING_CARRIED = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: {
      name: 'prometheus', namespace: 'monitoring',
      labels: { 'app.kubernetes.io/name': 'prometheus' },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': 'prometheus' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'prometheus' } },
        spec: { containers: [{ name: 'prometheus', image: PROMETHEUS_IMAGE, ports: [{ containerPort: 9090 }] }] },
      },
    },
  },
  {
    apiVersion: 'monitoring.coreos.com/v1', kind: 'ServiceMonitor',
    metadata: { name: 'portal', namespace: 'payments', labels: { release: 'kube-prom' } },
    spec: { selector: { matchLabels: { app: 'portal' } }, endpoints: [{ port: 'http' }] },
  },
];

/** 门户已经从 Deployment 换成 Rollout 了，跑的是好版本 */
const PORTAL_ROLLOUT = [
  {
    apiVersion: 'argoproj.io/v1alpha1', kind: 'Rollout',
    metadata: { name: 'portal', namespace: 'payments' },
    spec: {
      replicas: 4,
      selector: { matchLabels: { app: 'portal' } },
      strategy: { canary: { steps: [{ setWeight: 25 }, { setWeight: 100 }] } },
      template: {
        metadata: { labels: { app: 'portal' } },
        spec: { containers: [{ name: 'web', image: PORTAL_IMAGE, ports: [{ containerPort: 8080 }] }] },
      },
    },
  },
  {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name: 'portal', namespace: 'payments', labels: { app: 'portal' } },
    spec: { clusterIP: '10.96.1.10', selector: { app: 'portal' }, ports: [{ port: 80, targetPort: 8080 }] },
  },
];

const CANARY_STARTER = code`
  # 现在这个 Rollout 只会「分两步把新版本铺满」，不看任何指标。
  # 换句话说：坏版本照样能一路铺到 100%。
  #
  # 要加的是：分析这一步，以及它依据的判据。
  apiVersion: argoproj.io/v1alpha1
  kind: Rollout
  metadata:
    name: portal
    namespace: payments
  spec:
    replicas: 4
    selector:
      matchLabels:
        app: portal
    strategy:
      canary:
        steps:
        - setWeight: 25
        - setWeight: 100
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

const CANARY_REFERENCE = code`
  apiVersion: argoproj.io/v1alpha1
  kind: AnalysisTemplate
  metadata:
    name: error-rate
    namespace: payments
  spec:
    metrics:
    - name: error-rate
      # 先等两分钟再量：金丝雀刚起来时采样点还不够两个，算出来的是稳定版的错误率
      initialDelay: 2m
      successCondition: result < 0.05
      provider:
        prometheus:
          address: http://prometheus.monitoring.svc:9090
          query: |
            sum(rate(http_requests_total{code=~"5.."}[5m]))
            / sum(rate(http_requests_total[5m]))
  ---
  apiVersion: policy/v1
  kind: PodDisruptionBudget
  metadata:
    name: portal
    namespace: payments
  spec:
    minAvailable: 3
    selector:
      matchLabels:
        app: portal
  ---
  apiVersion: argoproj.io/v1alpha1
  kind: Rollout
  metadata:
    name: portal
    namespace: payments
  spec:
    replicas: 4
    selector:
      matchLabels:
        app: portal
    strategy:
      canary:
        steps:
        - setWeight: 25
        - analysis:
            templates:
            - templateName: error-rate
        - setWeight: 50
        - analysis:
            templates:
            - templateName: error-rate
        - setWeight: 100
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

const stage20 = {
  id: 'progressive-delivery',
  title: t('让坏版本自己退回去', 'Make a Bad Release Roll Itself Back'),
  goal: t(
    code`
      上周那个坏版本是人肉发现的：先有人报「打不开」，再有人去看指标，
      最后手工回滚 —— 中间隔了四十分钟。

      门户已经从 Deployment 换成了 \`Rollout\`，但它现在的策略只是
      「分两步把新版本铺满」，不看任何指标。也就是说坏版本照样能一路铺到 100%。

      要做两件事：把**分析**加进发布流程，让坏版本自己退回去；
      以及给门户配一个 \`PodDisruptionBudget\`，让节点维护不至于把服务打空。

      ## 通关标准

      1. 发一个好版本（\`${PORTAL_IMAGE_NEXT}\`）能走完全流程，最终 Healthy；
      2. 发一个坏版本（\`${PORTAL_IMAGE_BAD}\`）会在分析那一步被拦下，
         **自动回到稳定版**，而且稳定版的副本数是满的；
      3. 判据用的是**错误率**（rate 相除），不是裸计数；
      4. 有 PDB，且 \`kubectl drain\` 一个节点时不会把可用副本打到 3 以下。

      ## 会用到的命令

      \`\`\`bash
      kubectl apply -f /root/infra/canary.yaml
      kubectl get rollout portal -n payments
      kubectl describe rollout portal -n payments
      kubectl get analysisrun -n payments
      kubectl get pdb -n payments
      kubectl drain node-a1 --ignore-daemonsets --delete-emptydir-data --timeout=60s
      \`\`\`
    `,
    code`
      Last week's bad release was found by a human: someone reported "it will not
      load", someone else looked at the metrics, and someone rolled it back by hand.
      Forty minutes in total.

      The portal is already a \`Rollout\` rather than a Deployment, but its current
      strategy only spreads the new version in two steps without looking at any
      metric. A bad version therefore reaches 100% just as happily as a good one.

      Two things to do: add **analysis** to the release process so a bad version rolls
      itself back, and give the portal a \`PodDisruptionBudget\` so node maintenance
      cannot drain the service to nothing.

      ## Done when

      1. a good release (\`${PORTAL_IMAGE_NEXT}\`) completes and ends Healthy;
      2. a bad release (\`${PORTAL_IMAGE_BAD}\`) is stopped at the analysis step and
         **rolls back to the stable version** with a full replica count;
      3. the criterion is an **error rate** (one rate divided by another), not a raw
         counter;
      4. a PDB exists, and draining a node cannot take available replicas below three.

      ## Commands you will need

      \`\`\`bash
      kubectl apply -f /root/infra/canary.yaml
      kubectl get rollout portal -n payments
      kubectl describe rollout portal -n payments
      kubectl get analysisrun -n payments
      kubectl get pdb -n payments
      kubectl drain node-a1 --ignore-daemonsets --delete-emptydir-data --timeout=60s
      \`\`\`
    `
  ),
  checklist: [
    t('好版本走得完', 'A good release completes'),
    t('坏版本自己退回去', 'A bad release rolls itself back'),
    t('节点维护打不空服务', 'Node maintenance cannot empty the service'),
  ],
  hints: [
    t(
      '金丝雀的判据和告警的判据应该是同一个表达式。不然会出现「发布时看着没事、上线后告警响」—— 那说明你在两个地方定义了两套「什么叫坏」。',
      'The canary criterion and the alerting criterion should be the same expression. Otherwise you get "looked fine during rollout, paged after", which means you defined "bad" twice, differently.'
    ),
    t(
      '\`initialDelay\` 不是可选的。金丝雀刚起来的那几秒，它的计数器还是 0、采样点还不够两个，这时候算出来的是**稳定版的**错误率 —— 看着很好，然后就把坏版本放行了。',
      '`initialDelay` is not optional. In the first seconds a canary counter is still zero with fewer than two samples, so what you compute is the **stable** version error rate. It looks great, and the bad version sails through.'
    ),
    t(
      '中止不是「停在原地」，是回到稳定版：金丝雀缩到 0、稳定版拉回满副本。判定会检查回滚之后副本数是满的 —— 停在半路的服务只有一半容量。',
      'Aborting does not mean stopping in place, it means returning to stable: the canary scales to zero and stable goes back to full. The grader checks the replica count after rollback, because a rollout stopped halfway leaves half the capacity.'
    ),
  ],
  pitfalls: [
    t(
      '判据写成 \`sum(rate(http_requests_total{code=~"5.."}[5m])) > 0\`。任何一个 5xx 都会让发布失败 —— 而真实系统永远有零星的 5xx，于是没有任何版本发得出去，最后大家把分析这一步删了。判据要用**比例**。',
      'Writing the criterion as `sum(rate(http_requests_total{code=~"5.."}[5m])) > 0`. Any single 5xx fails the release, real systems always have a few, so nothing ever ships and eventually somebody deletes the analysis step. Use a **ratio**.'
    ),
    t(
      '配了 PDB 就以为副本数不会掉下来。PDB 只管**自愿中断**（维护、缩容、驱逐），管不了节点掉电、OOMKill、被抢占。它保证的是「不会被人为打空」，不是「永远有 N 个」。',
      'Assuming a PDB keeps the replica count up. It governs **voluntary** disruptions (maintenance, scale-down, eviction) and does nothing about a node losing power, an OOMKill, or preemption. It guarantees nobody drains you to zero, not that N always exist.'
    ),
    t(
      '\`minAvailable\` 写成和副本数一样大。这样任何驱逐都会被拒，节点永远维护不了 —— drain 会一直重试到超时。留出至少一个可中断的名额，否则 PDB 从「保护」变成「阻塞」。',
      'Setting `minAvailable` equal to the replica count. Every eviction is then refused and the node can never be maintained: drain retries until it times out. Leave at least one disruptable slot, or the PDB stops protecting and starts blocking.'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    objects: [
      CNI_CILIUM,
      ...GATEWAY_PLATFORM, ...CERT_MANAGER_PLATFORM, ...TLS_PLATFORM,
      ...ROLLOUTS_PLATFORM, ...MONITORING_CARRIED,
      ...PORTAL_ROLLOUT, PORTAL_ROUTE,
    ],
    files: { '/root/infra/canary.yaml': CANARY_STARTER },
    referenceFiles: { '/root/infra/canary.yaml': CANARY_REFERENCE },
    referenceCommands: [
      'kubectl apply -f /root/infra/canary.yaml',
    ],
  },
  specs: [
    spec('progressive-delivery.spec.ts', code`
      import { advance, get, list, sh } from '@ops/lab';

      const ROLLOUT = () => get('Rollout', 'portal', 'payments');

      const release = async (image) => {
        await sh(
          "kubectl patch rollout portal -n payments --type=json -p "
          + "'[{\\"op\\":\\"replace\\",\\"path\\":\\"/spec/template/spec/containers/0/image\\","
          + "\\"value\\":\\"" + image + "\\"}]'"
        );
        await advance(1200000);
      };

      describe('渐进式发布', () => {
        it('判据是错误率，不是裸计数', () => {
          const templates = list('AnalysisTemplate', { namespace: 'payments' });
          expect(templates.length).toBeGreaterThan(0);
          const queries = templates.flatMap((template) => (template.spec.metrics || [])
            .map((metric) => (metric.provider || {}).prometheus?.query || ''));
          expect(queries.some((query) => /rate\\(/.test(query) && query.includes('/'))).toBe(true);
        });

        it('发布流程里有分析这一步', () => {
          const steps = ROLLOUT().spec.strategy.canary.steps || [];
          expect(steps.some((step) => step.analysis)).toBe(true);
        });

        it('好版本走得完', async () => {
          await release('${PORTAL_IMAGE_NEXT}');
          const status = ROLLOUT().status;
          expect(status.phase).toBe('Healthy');
          expect(status.currentPodHash).toBeTruthy();

          const running = list('Pod', { namespace: 'payments' })
            .filter((pod) => (pod.metadata.labels || {}).app === 'portal')
            .filter((pod) => pod.status.phase === 'Running');
          expect(running.length).toBe(4);
          for (const pod of running) {
            expect(pod.spec.containers[0].image).toBe('${PORTAL_IMAGE_NEXT}');
          }
        });

        it('坏版本被拦下并自动回到稳定版', async () => {
          await release('${PORTAL_IMAGE_BAD}');
          const status = ROLLOUT().status;
          expect(status.abort).toBe(true);
          expect(status.phase).toBe('Degraded');

          const running = list('Pod', { namespace: 'payments' })
            .filter((pod) => (pod.metadata.labels || {}).app === 'portal')
            .filter((pod) => pod.status.phase === 'Running');
          // 回滚之后容量是满的，不是停在半路
          expect(running.length).toBe(4);
          for (const pod of running) {
            expect(pod.spec.containers[0].image).not.toBe('${PORTAL_IMAGE_BAD}');
          }
        });

        it('分析的结果查得到，看得出是哪条没过', () => {
          const runs = list('AnalysisRun', { namespace: 'payments' });
          const failed = runs.filter((run) => run.status.phase === 'Failed');
          expect(failed.length).toBeGreaterThan(0);
          expect(failed[0].status.metricResults[0].value).toBeGreaterThan(0.05);
        });

        it('PDB 留了可中断的名额，不至于把维护堵死', () => {
          const pdbs = list('PodDisruptionBudget', { namespace: 'payments' });
          expect(pdbs.length).toBeGreaterThan(0);
          const pdb = pdbs[0];
          expect(pdb.status.disruptionsAllowed).toBeGreaterThan(0);
          expect(pdb.status.desiredHealthy).toBeGreaterThanOrEqual(3);
        });

        it('节点维护打不空服务', async () => {
          const before = list('Pod', { namespace: 'payments' })
            .filter((pod) => (pod.metadata.labels || {}).app === 'portal').length;
          expect(before).toBe(4);

          await sh('kubectl drain node-a1 --ignore-daemonsets --force --timeout=30s');
          await advance(300000);

          const healthy = list('Pod', { namespace: 'payments' })
            .filter((pod) => (pod.metadata.labels || {}).app === 'portal')
            .filter((pod) => pod.status.phase === 'Running').length;
          expect(healthy).toBeGreaterThanOrEqual(3);
        });
      });
    `),
  ],
  focus: ['resilience', 'observability'],
  extension: t(
    code`
      渐进式发布真正改变的是**谁来发现问题**。滚动更新只回答「新的 Pod 起来了
      没有」，而「起来了」和「好用」是两回事 —— 上周那个坏版本探针全过、
      日志干净、Pod 全 Running，只是大半请求返回 500。把判据写进发布流程之后，
      发现问题的是系统而不是用户，而且回滚是自动的。

      有一条很容易被忽略：**金丝雀的判据应该和告警的判据是同一个表达式**。
      两边写不一样的话，会出现「发布时看着没事、上线后告警响」，
      或者反过来「发布一直失败但线上其实好好的」。同一个定义只写一遍，
      放在 AnalysisTemplate 里、告警规则里引用同一段 PromQL。

      PDB 那一半也值得多说一句。它管的是**自愿中断**，也就是有人主动发起的
      那些：节点维护、缩容、驱逐。节点掉电、OOMKill、被抢占都不在它管辖之内。
      所以 PDB 保证的是「不会被人为打空」，不是「永远有 N 个副本」——
      后者要靠副本数、反亲和、跨可用区分布一起来做。而且 \`minAvailable\`
      写得太紧会让节点永远维护不了：留不出可中断的名额，drain 就只能重试到
      超时，最后有人一怒之下 \`--disable-eviction\`，PDB 白配。
    `,
    code`
      What progressive delivery really changes is **who finds the problem**. A rolling
      update only answers "did the new pods start", and starting is not the same as
      working: last week's bad version passed every probe, logged nothing unusual, and
      showed all pods Running while returning 500 to three requests in ten. Once the
      criterion is part of the release process, the system finds the problem instead of
      a user, and the rollback is automatic.

      One thing that is easy to overlook: **the canary criterion and the alerting
      criterion should be the same expression**. Write them differently and you get
      either "looked fine during rollout, paged afterwards" or "releases keep failing
      while production is perfectly healthy". Define "bad" once, and reference the same
      PromQL from the AnalysisTemplate and the alerting rule.

      The PDB half deserves a note too. It governs **voluntary** disruptions, the ones
      somebody initiates: node maintenance, scale-down, eviction. A node losing power,
      an OOMKill, or preemption are all outside its remit. So a PDB guarantees nobody
      drains you to zero, not that N replicas always exist; that needs replica counts,
      anti-affinity, and zone spread together. And a \`minAvailable\` set too tightly
      makes nodes impossible to maintain: with no disruptable slot, drain retries until
      it times out, and eventually somebody reaches for \`--disable-eviction\` and the
      PDB may as well not exist.
    `
  ),
};

/* ------------------------------------------------------------------ */
/* 第 21 关：灾难恢复                                                  */
/* ------------------------------------------------------------------ */

/**
 * 存储那一套。
 *
 * 三个东西分属三个组件：CSI 驱动造盘、snapshot-controller 拍快照、
 * StorageClass 说怎么造。快照类是有的 —— 只是没打让 Velero 认得的标签，
 * 这一关的核心失效就藏在这一行里。
 */
const STORAGE_PLATFORM = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: {
      name: 'csi-provisioner', namespace: 'kube-system',
      labels: { 'app.kubernetes.io/name': 'csi-driver' },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': 'csi-driver' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'csi-driver' } },
        spec: { containers: [{ name: 'provisioner', image: CSI_IMAGE }] },
      },
    },
  },
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: {
      name: 'snapshot-controller', namespace: 'kube-system',
      labels: { 'app.kubernetes.io/name': 'snapshot-controller' },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': 'snapshot-controller' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'snapshot-controller' } },
        spec: { containers: [{ name: 'controller', image: SNAPSHOT_IMAGE }] },
      },
    },
  },
  {
    apiVersion: 'storage.k8s.io/v1', kind: 'StorageClass',
    metadata: {
      name: 'standard',
      annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' },
    },
    provisioner: 'csi.corp.internal',
    reclaimPolicy: 'Delete',
    volumeBindingMode: 'Immediate',
  },
  {
    apiVersion: 'snapshot.storage.k8s.io/v1', kind: 'VolumeSnapshotClass',
    metadata: { name: 'csi-standard' },
    driver: 'csi.corp.internal',
    deletionPolicy: 'Delete',
  },
];

/** Velero 和它的桶。装是装上了，没人配过备份。 */
const VELERO_PLATFORM = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: {
      name: 'velero', namespace: 'velero',
      labels: { 'app.kubernetes.io/name': 'velero' },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': 'velero' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'velero' } },
        spec: { containers: [{ name: 'velero', image: VELERO_IMAGE }] },
      },
    },
  },
  {
    apiVersion: 'velero.io/v1', kind: 'BackupStorageLocation',
    metadata: { name: 'default', namespace: 'velero' },
    spec: {
      provider: 'aws',
      default: true,
      objectStorage: { bucket: 'corp-backups' },
      config: { region: 'internal', s3Url: 'http://minio.storage.svc:9000' },
    },
  },
];

/** 对账库。它的数据在盘上，不在镜像里。 */
const LEDGERDB_WORKLOAD = [
  {
    apiVersion: 'v1', kind: 'PersistentVolumeClaim',
    metadata: { name: 'ledger-data', namespace: 'payments' },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: { requests: { storage: '20Gi' } },
    },
  },
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'ledgerdb', namespace: 'payments' },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'ledgerdb' } },
      template: {
        metadata: { labels: { app: 'ledgerdb' } },
        spec: {
          containers: [{
            name: 'db', image: LEDGERDB_IMAGE,
            ports: [{ containerPort: 5432 }],
            volumeMounts: [{ name: 'data', mountPath: '/var/lib/ledger' }],
          }],
          volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'ledger-data' } }],
        },
      },
    },
  },
  {
    apiVersion: 'v1', kind: 'Service',
    metadata: { name: 'ledgerdb', namespace: 'payments' },
    spec: { selector: { app: 'ledgerdb' }, ports: [{ port: 5432, targetPort: 5432 }] },
  },
];

/** 库里已经有的数据。恢复出来必须一字不差。 */
const LEDGER_ROWS = [
  'date,id,amount',
  '2026-08-01,pay-100317,42.00',
  '2026-08-02,pay-100318,128.50',
  '2026-08-03,pay-100319,7.25',
  '',
].join('\n');

const BACKUP_STARTER = code`
  # 备份还没配过。
  #
  # 这里需要一个 Backup 对象，把 payments 整个命名空间备下来。
  # 光把对象备下来是不够的 —— 想清楚盘上的字节靠什么进备份。
`;

const BACKUP_REFERENCE = code`
  apiVersion: velero.io/v1
  kind: Backup
  metadata:
    name: payments-daily
    namespace: velero
  spec:
    includedNamespaces:
    - payments
    storageLocation: default
    # 不写 snapshotVolumes 就是「要拍快照」。但拍不拍得成，取决于有没有一个
    # 打了 velero.io/csi-volumesnapshot-class 标签的 VolumeSnapshotClass。
    ttl: 720h
`;

const stage21 = {
  id: 'disaster-recovery',
  title: t('把删掉的东西连数据一起找回来', 'Get It Back, Data and All'),
  goal: t(
    code`
      对账库 \`ledgerdb\` 的数据在一块 20Gi 的盘上。集群装了 Velero，
      也配好了桶 —— 但从来没有人跑过一次备份，更没有人恢复过。

      「我们有备份」和「我们能恢复」是两句话。这一关要把后一句变成真的。

      要做三件事：

      1. 让 Velero 备份**连卷数据一起**备走；
      2. 把 payments 整个命名空间备下来；
      3. 做一次恢复演练，恢复到**另一个命名空间**，证明这份备份真的能用。

      做完之后判定会真的删掉 payments 命名空间，再从你的备份把它恢复回来。

      ## 通关标准

      1. 备份是 \`Completed\`，而且 \`volumeSnapshotsCompleted\` 大于 0；
      2. 有一次恢复演练，落在别的命名空间里，且演练出来的数据是对的；
      3. \`kubectl delete namespace payments\` 之后，从这份备份能把库和数据
         一起恢复回来，一行不差。

      ## 会用到的命令

      \`\`\`bash
      kubectl get volumesnapshotclass
      kubectl label volumesnapshotclass <name> <key>=<value>
      kubectl apply -f /root/infra/backup.yaml
      velero backup get
      velero backup describe <name>
      velero restore create <name> --from-backup <backup> --namespace-mappings a:b
      velero restore get
      kubectl get pvc,volumesnapshot -n payments
      \`\`\`
    `,
    code`
      The ledger database \`ledgerdb\` keeps its data on a 20Gi volume. The cluster has
      Velero installed and a bucket configured, but nobody has ever run a backup, let
      alone restored one.

      "We have backups" and "we can restore" are two different sentences. This stage is
      about making the second one true.

      Three things to do:

      1. make Velero back up the **volume data**, not just the objects;
      2. back up the whole payments namespace;
      3. run a restore drill into **another namespace** to prove the backup works.

      When you are done, the grader really does delete the payments namespace and
      restores it from your backup.

      ## Done when

      1. the backup is \`Completed\` and \`volumeSnapshotsCompleted\` is above zero;
      2. a restore drill exists, landing in a different namespace, with correct data;
      3. after \`kubectl delete namespace payments\`, your backup brings the database
         and every row back.

      ## Commands you will need

      \`\`\`bash
      kubectl get volumesnapshotclass
      kubectl label volumesnapshotclass <name> <key>=<value>
      kubectl apply -f /root/infra/backup.yaml
      velero backup get
      velero backup describe <name>
      velero restore create <name> --from-backup <backup> --namespace-mappings a:b
      velero restore get
      kubectl get pvc,volumesnapshot -n payments
      \`\`\`
    `
  ),
  checklist: [
    t('备份里有卷数据', 'The backup contains volume data'),
    t('恢复演练做过', 'A restore drill has been run'),
    t('删了也回得来', 'Deleted and brought back'),
  ],
  hints: [
    t(
      'Velero 挑卷快照类靠的是一个标签：\`velero.io/csi-volumesnapshot-class: "true"\`。没有任何一个快照类打这个标签时，备份**不报错** —— 它照样 Completed，只是 warnings 加一，卷数据一个字节都没进去。\`velero backup describe\` 里那两行 Attempted / Completed 就是拿来看这个的。',
      'Velero picks a snapshot class by a label: `velero.io/csi-volumesnapshot-class: "true"`. When no class carries it the backup does **not** fail. It still says Completed, just with one more warning, and not a byte of volume data goes in. Those Attempted / Completed lines in `velero backup describe` are exactly what to read.'
    ),
    t(
      '恢复演练不要在生产命名空间上做。Velero 默认**跳过**已经存在的对象，所以往原地恢复多半是「跑完了，什么都没变」—— 而你会以为验证过了。用 \`--namespace-mappings\` 恢复到一个新命名空间。',
      'Do not drill in the production namespace. Velero **skips** resources that already exist, so restoring in place usually means "it ran and nothing changed", and you walk away thinking you verified something. Restore into a fresh namespace with `--namespace-mappings`.'
    ),
    t(
      '恢复出来的 PVC 是不是有数据，看不出来 —— Bound 就是 Bound。要证明，只能进去读一行：\`kubectl exec\` 进 Pod \`cat\` 一下。',
      'You cannot tell whether a restored PVC has data by looking at it: Bound is Bound. The only proof is reading a row, so `kubectl exec` into the pod and `cat` the file.'
    ),
  ],
  pitfalls: [
    t(
      '把「备份任务是绿的」当成「数据备下来了」。没有可用的卷快照类时，Velero 照样报 Completed。这类失效只会在恢复那天暴露，而那天恰好是最不能出错的一天。判据要看 \`volumeSnapshotsCompleted\`，不是 \`phase\`。',
      'Treating "the backup job is green" as "the data is backed up". With no usable volume snapshot class Velero still reports Completed. This failure only surfaces on the day you restore, which is exactly the day it must not. Check `volumeSnapshotsCompleted`, not `phase`.'
    ),
    t(
      '原地恢复。Velero 默认跳过已经存在的对象，恢复完 phase 是 PartiallyFailed，而集群一点没变 —— 很容易读成「恢复成功，只是有点小问题」。',
      'Restoring in place. Velero skips resources that already exist, the restore ends PartiallyFailed, and nothing in the cluster changed. That reads a lot like "restored, with minor issues".'
    ),
    t(
      '以为删掉命名空间只是删掉一堆对象。它会一起带走 PVC，而回收策略是 \`Delete\` 的话，盘和盘上的字节跟着一起消失，apiserver 里再也查不到它存在过。',
      'Assuming deleting a namespace only deletes some objects. It takes the PVCs with it, and with a `Delete` reclaim policy the volume and every byte on it go too, with no record left in the apiserver that they ever existed.'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    objects: [
      CNI_CILIUM,
      ...GATEWAY_PLATFORM, ...CERT_MANAGER_PLATFORM, ...TLS_PLATFORM,
      ...ROLLOUTS_PLATFORM, ...MONITORING_CARRIED,
      ...PORTAL_ROLLOUT, PORTAL_ROUTE,
      ...STORAGE_PLATFORM, ...VELERO_PLATFORM, ...LEDGERDB_WORKLOAD,
    ],
    volumes: { 'payments/ledger-data': { 'ledger.csv': LEDGER_ROWS } },
    files: { '/root/infra/backup.yaml': BACKUP_STARTER },
    referenceFiles: { '/root/infra/backup.yaml': BACKUP_REFERENCE },
    referenceCommands: [
      'kubectl label volumesnapshotclass csi-standard velero.io/csi-volumesnapshot-class=true',
      'kubectl apply -f /root/infra/backup.yaml',
      'velero backup get',
      'velero restore create drill --from-backup payments-daily --namespace-mappings payments:payments-drill',
    ],
  },
  specs: [
    spec('disaster-recovery.spec.ts', code`
      import { advance, get, list, sh } from '@ops/lab';

      const COMPLETED = () => list('Backup', { namespace: 'velero' })
        .filter((backup) => (backup.status || {}).phase === 'Completed');

      const rowsIn = async (namespace) => {
        const pod = list('Pod', { namespace })
          .filter((item) => (item.metadata.labels || {}).app === 'ledgerdb')
          .filter((item) => item.status.phase === 'Running')[0];
        if (!pod) return '';
        const result = await sh(
          'kubectl exec ' + pod.metadata.name + ' -n ' + namespace
          + ' -- cat /var/lib/ledger/ledger.csv'
        );
        return result.stdout;
      };

      describe('灾难恢复', () => {
        it('卷快照类是 Velero 认得的', () => {
          const classes = list('VolumeSnapshotClass');
          expect(classes.length).toBeGreaterThan(0);
          const usable = classes.filter(
            (item) => (item.metadata.labels || {})['velero.io/csi-volumesnapshot-class'] === 'true'
          );
          expect(usable.length).toBeGreaterThan(0);
        });

        it('备份完成了，而且卷数据在里面', () => {
          const backups = COMPLETED();
          expect(backups.length).toBeGreaterThan(0);
          const backup = backups[0];
          // Completed 只说明任务跑完了。数据在不在，看这一行。
          expect(backup.status.volumeSnapshotsCompleted).toBeGreaterThan(0);
          expect(backup.status.warnings || 0).toBe(0);
          expect((backup.spec.includedNamespaces || []).includes('payments')).toBe(true);
        });

        it('恢复演练做过，而且不是在生产上做的', async () => {
          const drills = list('Restore', { namespace: 'velero' }).filter((restore) => {
            const mapping = (restore.spec || {}).namespaceMapping || {};
            return Object.keys(mapping).length > 0 && mapping.payments !== 'payments';
          });
          expect(drills.length).toBeGreaterThan(0);

          const target = drills[0].spec.namespaceMapping.payments;
          expect(drills[0].status.phase).toBe('Completed');

          await advance(120000);
          const rows = await rowsIn(target);
          expect(rows).toContain('pay-100317');
          expect(rows).toContain('pay-100319');
        });

        it('真出事了也回得来：整个命名空间删掉，数据照样一行不差', async () => {
          const name = COMPLETED()[0].metadata.name;

          await sh('kubectl delete namespace payments');
          await advance(60000);
          expect(list('PersistentVolumeClaim', { namespace: 'payments' }).length).toBe(0);
          expect(list('Deployment', { namespace: 'payments' }).length).toBe(0);

          await sh('velero restore create rescue --from-backup ' + name);
          await advance(600000);

          const claim = get('PersistentVolumeClaim', 'ledger-data', 'payments');
          expect(claim.status.phase).toBe('Bound');
          expect(get('Deployment', 'ledgerdb', 'payments')).toBeTruthy();

          const rows = await rowsIn('payments');
          expect(rows).toContain('pay-100317');
          expect(rows).toContain('pay-100318');
          expect(rows).toContain('pay-100319');
        });
      });
    `),
  ],
  focus: ['resilience'],
  extension: t(
    code`
      备份这件事上，绝大多数团队真正缺的不是备份，是**恢复**。备份任务天天绿，
      没有人试过从它恢复；等到需要的那天才发现里面只有对象图没有数据，
      或者恢复流程要三个人商量两小时。所以「多久备份一次」远不如
      「多久演练一次恢复」重要，后者才是真正被验证过的那个数字。

      演练一定要恢复到一个新的地方。Velero 默认跳过已经存在的对象，
      往原地恢复的结果往往是「跑完了，什么都没变」—— 你验证了个寂寞，
      还得到一份虚假的信心。用 \`--namespace-mappings\` 恢复到一个临时命名空间，
      读一行数据出来对一下，然后把临时命名空间删掉。

      还有一层是**备份的边界**。这一关备的是一个命名空间，
      但恢复一个真实系统往往还需要命名空间之外的东西：CRD、集群角色、
      StorageClass、Secret 里那把只存在于集群里的密钥。
      备份策略里最该问的一句话是：如果整个集群没了，
      光靠这个桶里的东西，能不能从零把服务拉起来。
    `,
    code`
      What most teams are missing is not backups, it is **restores**. The backup job is
      green every day and nobody has ever restored from it, so the day it matters is the
      day you learn it holds objects but no data, or that the procedure takes three
      people and two hours to agree on. How often you back up matters far less than how
      often you rehearse a restore, because only the second number has been verified.

      Always drill into a new place. Velero skips resources that already exist, so an
      in-place restore usually means "it ran and nothing changed": you verified nothing
      and walked away with false confidence. Restore into a temporary namespace with
      \`--namespace-mappings\`, read a row of real data out of it, then delete the
      temporary namespace.

      There is also the question of **what the backup's edge is**. This stage backs up a
      namespace, but restoring a real system usually needs things outside it: CRDs,
      cluster roles, StorageClasses, the key that only ever existed inside a Secret in
      that cluster. The question worth asking of any backup strategy is whether, with
      the whole cluster gone, the contents of that bucket alone are enough to bring the
      service back from nothing.
    `
  ),
};

/* ------------------------------------------------------------------ */
/* 第 22 关：弹性                                                      */
/* ------------------------------------------------------------------ */

/**
 * 机器那一套。
 *
 * Cluster API 装了，机器组也建了，但 MachineDeployment 上**没有 min/max 注解** ——
 * 伸缩器因此看都不看它。这是「伸缩器装了但不工作」最常见的原因。
 */
const CAPACITY_PLATFORM = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: {
      name: 'capi-controller-manager', namespace: 'capi-system',
      labels: { 'app.kubernetes.io/name': 'cluster-api' },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': 'cluster-api' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'cluster-api' } },
        spec: { containers: [{ name: 'manager', image: CAPI_IMAGE }] },
      },
    },
  },
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: {
      name: 'cluster-autoscaler', namespace: 'capi-system',
      labels: { 'app.kubernetes.io/name': 'cluster-autoscaler' },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { 'app.kubernetes.io/name': 'cluster-autoscaler' } },
      template: {
        metadata: { labels: { 'app.kubernetes.io/name': 'cluster-autoscaler' } },
        spec: { containers: [{ name: 'autoscaler', image: AUTOSCALER_IMAGE }] },
      },
    },
  },
  {
    apiVersion: 'infrastructure.cluster.x-k8s.io/v1beta1', kind: 'VSphereMachineTemplate',
    metadata: { name: 'worker-8c', namespace: 'capi-system' },
    spec: { template: { spec: { numCPUs: 8, memoryMiB: 16384, diskGiB: 120 } } },
  },
  {
    apiVersion: 'cluster.x-k8s.io/v1beta1', kind: 'MachineDeployment',
    metadata: { name: 'workers', namespace: 'capi-system' },
    spec: {
      clusterName: 'corp',
      replicas: 1,
      selector: { matchLabels: { pool: 'workers' } },
      template: {
        metadata: { labels: { pool: 'workers' } },
        spec: {
          clusterName: 'corp',
          version: 'v1.36.0',
          infrastructureRef: {
            apiVersion: 'infrastructure.cluster.x-k8s.io/v1beta1',
            kind: 'VSphereMachineTemplate', name: 'worker-8c',
          },
        },
      },
    },
  },
];

/**
 * 月末结算。
 *
 * 六个算得很重的分片，外加一个协调器 —— 协调器的 CPU 请求写成了 32 核，
 * 而池子里最大的机器是 8 核。它会永远 Pending，而伸缩器一台机器都不会加：
 * 加了也装不下。这不是伸缩器坏了，是它算出来「加了没用」。
 */
const SETTLEMENT_WORKLOAD = [
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'settlement', namespace: 'payments' },
    spec: {
      replicas: 6,
      selector: { matchLabels: { app: 'settlement' } },
      template: {
        metadata: { labels: { app: 'settlement' } },
        spec: {
          containers: [{
            name: 'shard', image: SETTLEMENT_IMAGE,
            resources: { requests: { cpu: '3', memory: '256Mi' } },
          }],
        },
      },
    },
  },
  {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name: 'settlement-reconciler', namespace: 'payments' },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'settlement-reconciler' } },
      template: {
        metadata: { labels: { app: 'settlement-reconciler' } },
        spec: {
          containers: [{
            name: 'reconciler', image: SETTLEMENT_IMAGE,
            // 有人把 32 核当成了「给它多一点」。池子里最大的机器就是 8 核。
            resources: { requests: { cpu: '32', memory: '256Mi' } },
          }],
        },
      },
    },
  },
];

const stage22 = {
  id: 'elastic-capacity',
  title: t('让机器按需出现，也按需消失', 'Capacity That Comes and Goes'),
  goal: t(
    code`
      月末结算今天要跑。六个分片，每个要 3 核；集群里手工装的那三台各 4 核，
      装不下。运维的做法一直是提前一天手工加机器，跑完再手工删掉 ——
      有一次忘了删，多花了两个月的钱。

      集群里已经有 Cluster API 和 cluster-autoscaler，机器组 \`workers\` 也建好了，
      但从来没生效过：伸缩器**看都不看**它。

      还有一件事：那个协调器 \`settlement-reconciler\` 一直 Pending，
      而伸缩器一台机器都不给它加。先搞清楚为什么，再让它跑起来。

      ## 通关标准

      1. 机器组 \`workers\` 归伸缩器管，而且有上限（无上限的弹性是账单事故）；
      2. 结算的六个分片全部 Running，扩出来的机器是 Cluster API 造的；
      3. 协调器也跑起来了；
      4. 活干完之后机器要还回去 —— 判定会删掉结算负载并等一段时间，
         机器组要缩回下限。

      ## 会用到的命令

      \`\`\`bash
      kubectl get machinedeployment,machine -n capi-system
      kubectl get nodes
      kubectl describe pod -n payments <pod>
      kubectl annotate machinedeployment workers -n capi-system <key>=<value>
      kubectl set resources deployment <name> -n payments --requests=cpu=<n>
      \`\`\`
    `,
    code`
      Month-end settlement runs today. Six shards, three cores each; the three
      hand-installed nodes have four cores apiece and cannot take them. Ops has always
      added machines by hand the day before and removed them afterwards, except for the
      time somebody forgot and the bill ran for two extra months.

      The cluster already has Cluster API and cluster-autoscaler, and the \`workers\`
      node group exists, but it has never done anything: the autoscaler does not even
      look at it.

      There is one more thing. The \`settlement-reconciler\` pod stays Pending and the
      autoscaler adds nothing for it. Work out why before you make it run.

      ## Done when

      1. the \`workers\` group is managed by the autoscaler and has an upper bound
         (elasticity without a ceiling is a billing incident);
      2. all six settlement shards are Running on machines created by Cluster API;
      3. the reconciler runs too;
      4. the capacity goes away afterwards: the grader deletes the settlement workloads,
         waits, and expects the group back at its lower bound.

      ## Commands you will need

      \`\`\`bash
      kubectl get machinedeployment,machine -n capi-system
      kubectl get nodes
      kubectl describe pod -n payments <pod>
      kubectl annotate machinedeployment workers -n capi-system <key>=<value>
      kubectl set resources deployment <name> -n payments --requests=cpu=<n>
      \`\`\`
    `
  ),
  checklist: [
    t('机器组归伸缩器管', 'The node group is managed'),
    t('结算跑得完', 'Settlement completes'),
    t('机器会还回去', 'Capacity is returned'),
  ],
  hints: [
    t(
      '伸缩器怎么知道哪些机器组归它管？靠 MachineDeployment 上的两个注解：\`cluster.x-k8s.io/cluster-api-autoscaler-node-group-min-size\` 和 \`...-max-size\`。没打注解的机器组它看都不看 —— 这就是「装了但不工作」。',
      'How does the autoscaler know which node groups are its business? Two annotations on the MachineDeployment: `cluster.x-k8s.io/cluster-api-autoscaler-node-group-min-size` and `...-max-size`. A group without them is invisible to it, which is exactly what "installed but does nothing" looks like.'
    ),
    t(
      '协调器的问题不在伸缩器上。伸缩器每次都会问一句「加一台这种机器，这个 Pod 能落上去吗」—— 请求 32 核而池子里最大的机器是 8 核，答案是不能，所以它一台都不加。`kubectl describe pod` 里那条 NotTriggerScaleUp 事件写着原因。',
      'The reconciler problem is not in the autoscaler. It asks one question every time: would this pod fit on a new machine of this shape? Requesting 32 cores when the biggest machine is 8 means no, so it adds nothing. The reason is in the NotTriggerScaleUp event on the pod.'
    ),
    t(
      '缩容不是立刻发生的。一台机器要「闲得够久」才会被回收（默认十分钟），这是为了避免抖一下就还机器、下一批活来了又得等装机。判定会自己把时间推过去。',
      'Scale-down is not immediate. A machine must be idle for long enough (ten minutes by default) before it is reclaimed, so that a brief lull does not cost you a full provisioning wait when the next batch arrives. The grader advances time for you.'
    ),
  ],
  pitfalls: [
    t(
      '以为伸缩器会看「CPU 使用率」。它不看负载，只看**调度器的结论**：有 Pod 调度不上就加机器，没有就不加。CPU 用满而 Pod 都调度得上，它一台都不会加 —— 那是 HPA 的活。',
      'Expecting the autoscaler to watch CPU usage. It does not look at load at all, only at the scheduler verdict: pods that cannot be scheduled mean add machines, nothing else does. A cluster pegged at 100% CPU with everything scheduled gets no new machines, because that is HPA territory.'
    ),
    t(
      '上限设成一个很大的数「以防万一」。一个写错的副本数或者一段死循环的重试，能在一夜之间把机器开到上限 —— 上限就是这类事故的最后一道闸。',
      'Setting the maximum to something huge "just in case". A wrong replica count or a retry loop can run the group to the ceiling overnight, and the ceiling is the last thing standing between that and the invoice.'
    ),
    t(
      '给关键负载加 \`cluster-autoscaler.kubernetes.io/safe-to-evict: "false"\`，然后忘了。这个注解会把它所在的整台机器**永远**钉住，缩容再也发生不了。「为什么半夜三点还有十台空机器」十次有八次是它。',
      'Annotating something important with `cluster-autoscaler.kubernetes.io/safe-to-evict: "false"` and forgetting. That annotation pins the entire machine it lands on, permanently, and scale-down never happens again. It is the usual answer to "why are ten empty machines still running at 3am".'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    objects: [
      CNI_CILIUM,
      ...GATEWAY_PLATFORM, ...CERT_MANAGER_PLATFORM, ...TLS_PLATFORM,
      ...ROLLOUTS_PLATFORM, ...MONITORING_CARRIED,
      ...PORTAL_ROLLOUT, PORTAL_ROUTE,
      ...CAPACITY_PLATFORM, ...SETTLEMENT_WORKLOAD,
    ],
    referenceCommands: [
      'kubectl annotate machinedeployment workers -n capi-system'
        + ' cluster.x-k8s.io/cluster-api-autoscaler-node-group-min-size=1'
        + ' cluster.x-k8s.io/cluster-api-autoscaler-node-group-max-size=6',
      'kubectl set resources deployment settlement-reconciler -n payments --requests=cpu=4',
    ],
  },
  specs: [
    spec('elastic-capacity.spec.ts', code`
      import { advance, get, list, sh } from '@ops/lab';

      const MIN = 'cluster.x-k8s.io/cluster-api-autoscaler-node-group-min-size';
      const MAX = 'cluster.x-k8s.io/cluster-api-autoscaler-node-group-max-size';
      const POOL = () => get('MachineDeployment', 'workers', 'capi-system');

      const runningIn = (namespace, app) => list('Pod', { namespace })
        .filter((pod) => (pod.metadata.labels || {}).app === app)
        .filter((pod) => pod.status.phase === 'Running');

      describe('弹性', () => {
        it('机器组归伸缩器管，而且有上限', () => {
          const annotations = POOL().metadata.annotations || {};
          const min = Number(annotations[MIN]);
          const max = Number(annotations[MAX]);
          expect(Number.isFinite(min)).toBe(true);
          expect(Number.isFinite(max)).toBe(true);
          expect(max).toBeGreaterThan(min);
        });

        it('结算的六个分片都跑起来了', () => {
          expect(runningIn('payments', 'settlement').length).toBe(6);
        });

        it('多出来的机器是 Cluster API 造的，不是手工加的', () => {
          const machines = list('Machine', { namespace: 'capi-system' });
          expect(machines.length).toBeGreaterThan(1);

          const nodeNames = machines
            .map((machine) => (machine.status.nodeRef || {}).name)
            .filter(Boolean);
          const shards = runningIn('payments', 'settlement');
          // 分片确实落在新机器上，而不是全挤在原来那三台上
          expect(shards.some((pod) => nodeNames.includes(pod.spec.nodeName))).toBe(true);

          const max = Number(POOL().metadata.annotations[MAX]);
          expect(POOL().spec.replicas).toBeLessThanOrEqual(max);
        });

        it('那个要 32 核的协调器也跑起来了', () => {
          expect(runningIn('payments', 'settlement-reconciler').length).toBe(1);
        });

        it('活干完了机器要还回去', async () => {
          const peak = POOL().spec.replicas;
          expect(peak).toBeGreaterThan(1);

          await sh('kubectl delete deployment settlement settlement-reconciler -n payments');
          await advance(60000);
          // 刚闲下来不缩：抖一下就还机器，下一批活来了又得等装机
          expect(POOL().spec.replicas).toBe(peak);

          await advance(900000);
          const min = Number(POOL().metadata.annotations[MIN]);
          expect(POOL().spec.replicas).toBe(min);
          expect(list('Machine', { namespace: 'capi-system' }).length).toBe(min);
        });
      });
    `),
  ],
  focus: ['resilience', 'operations'],
  extension: t(
    code`
      弹性伸缩最容易被误解的一点是**它不看负载**。cluster-autoscaler 只认调度器的
      结论：有 Pod 调度不上就加机器，没有就不加。一个 CPU 跑满但所有 Pod 都调度
      得上的集群，它一台机器都不会加 —— 那是 HPA 的事。两个东西经常被混着说成
      「自动扩容」，但它们工作在完全不同的层：HPA 加的是副本，伸缩器加的是机器，
      而且伸缩器是被 HPA 加出来的那些 Pod 触发的。

      第二点是**扩容有代价而缩容有风险**。扩容的代价是时间：装机几分钟，
      这几分钟里请求是排队的，所以真要扛突发流量得靠预留容量，不能指望伸缩器。
      缩容的风险是打断：机器上的 Pod 要挪走，挪的过程中就是有一段服务能力
      的缺口 —— 这也是为什么缩容要等「闲够十分钟」，以及为什么 PDB 在这里
      同样管用。

      第三点是**上限就是闸**。弹性系统最贵的故障不是不扩容，是扩容失控：
      一个写错的副本数、一段死循环的重试、一个刷不出来的镜像导致 Pod 一直
      Pending，都能让机器一台台加下去。上限不是「性能调优参数」，
      它和 ResourceQuota、LimitRange 一样，是防止一个错误变成一场事故的东西。
    `,
    code`
      The most misunderstood thing about the cluster autoscaler is that **it does not
      watch load**. It reads one signal: the scheduler's verdict. Pods that cannot be
      scheduled mean add machines; anything else means do nothing. A cluster pegged at
      100% CPU with everything scheduled gets no new machines, because that is HPA
      territory. The two are often lumped together as "autoscaling" while working at
      completely different layers: HPA adds replicas, the autoscaler adds machines, and
      it is the pods HPA created that trigger it.

      The second thing is that **scaling up costs time and scaling down carries risk**.
      Provisioning takes minutes, and requests queue during those minutes, so real burst
      traffic is absorbed by headroom you kept, not by the autoscaler. Scaling down
      moves pods off a machine, and that movement is a real gap in capacity, which is
      why a node must be idle for ten minutes first and why PDBs matter here too.

      The third is that **the ceiling is the brake**. The expensive failure in an elastic
      system is not failing to scale up, it is scaling without end: a wrong replica
      count, a retry loop, an image that never pulls leaving pods Pending forever, each
      one can walk the group up machine by machine. The maximum is not a tuning
      parameter. Like ResourceQuota and LimitRange, it is there so one mistake does not
      become an incident.
    `
  ),
};

/* ------------------------------------------------------------------ */
/* 第 23 关：写一个 Operator                                           */
/* ------------------------------------------------------------------ */

/** 平台组的自助入口网关：hostname 是通配的，任何一个 Site 都能挂上来 */
const SELF_SERVICE_GATEWAY = {
  apiVersion: 'gateway.networking.k8s.io/v1', kind: 'Gateway',
  metadata: { name: 'self-service', namespace: 'payments' },
  spec: {
    gatewayClassName: 'envoy-internal',
    listeners: [
      { name: 'http', port: 80, protocol: 'HTTP', hostname: '*.corp.internal' },
    ],
  },
};

/**
 * Operator 自己。
 *
 * 它和别的平台组件没有任何区别：一个 Deployment。把它缩到 0，
 * Site 还在、`kubectl get sites` 照样查得到，只是没有人再让它们成真 ——
 * 「CRD 是数据结构，Operator 才是行为」在这里是能动手验证的。
 */
const SITE_OPERATOR = {
  apiVersion: 'apps/v1', kind: 'Deployment',
  metadata: {
    name: 'site-operator', namespace: 'platform-system',
    labels: { 'app.kubernetes.io/name': 'site-operator' },
  },
  spec: {
    replicas: 1,
    selector: { matchLabels: { 'app.kubernetes.io/name': 'site-operator' } },
    template: {
      metadata: { labels: { 'app.kubernetes.io/name': 'site-operator' } },
      spec: { containers: [{ name: 'manager', image: SITE_OPERATOR_IMAGE }] },
    },
  },
};

const SITE_CRD_STARTER = code`
  # 待补：Site 这个类型还不存在。
  #
  # 需要一个 CustomResourceDefinition，让 apiserver 认识 platform.corp.internal/v1
  # 下面的 Site。业务方提交的东西长这样（见 /root/sites/shop.yaml）：
  #
  #   spec:
  #     host: shop.corp.internal
  #     service:
  #       name: portal
  #       port: 80
  #
  # 两件容易漏的：Operator 要往 status 里写东西，以及
  # \`kubectl get sites\` 应该一眼看得出 host —— 这两样都在 CRD 上声明。
`;

const SITE_CRD_REFERENCE = code`
  apiVersion: apiextensions.k8s.io/v1
  kind: CustomResourceDefinition
  metadata:
    name: sites.platform.corp.internal
  spec:
    group: platform.corp.internal
    scope: Namespaced
    names:
      plural: sites
      singular: site
      kind: Site
      shortNames:
      - st
    versions:
    - name: v1
      served: true
      storage: true
      # 不声明的话 status 就不是子资源，写 status 会连带改到 spec
      subresources:
        status: {}
      # kubectl get sites 打出来的列。平台的自助入口，好不好用就看这几列。
      additionalPrinterColumns:
      - name: Host
        type: string
        jsonPath: .spec.host
      - name: Ready
        type: string
        jsonPath: .status.ready
`;

const OPERATOR_STARTER = code`
  /**
   * Site Operator —— 待补
   *
   * 这个文件就是控制器本身。世界会 watch 你在 \`exports.watches\` 里声明的类型，
   * 每次变化调一次 \`reconcile\`。CommonJS 写法，改完立刻生效
   * （真集群里这一步是重新构建镜像再发布）。
   *
   * ctx 上有这些：
   *
   *   ctx.object                       触发这次 reconcile 的 Site
   *   ctx.name / ctx.namespace
   *   ctx.owner()                      属主引用，挂在你造出来的东西上
   *   ctx.get(kind, name, namespace)   读不到返回 undefined
   *   ctx.list(kind, namespace)
   *   ctx.apply(object)                有就改，没有就建
   *   ctx.delete(kind, name, namespace)
   *   ctx.setStatus(patch)             只在真的变了的时候才写回
   *   ctx.event(reason, message)       记一条事件
   *   ctx.log(...)
   *
   * 要造的是一条 HTTPRoute：挂在 payments 命名空间里那个叫 self-service 的
   * Gateway 上，hostname 用 Site 的 host，后端指向 Site 里写的 service。
   */
  exports.watches = ['Site'];

  exports.reconcile = (ctx) => {
    // TODO
  };
`;

const OPERATOR_REFERENCE = code`
  /**
   * Site Operator
   *
   * 一个 Site 进来，保证有一条对应的 HTTPRoute 出去。
   *
   * 三件事是这段代码真正在做的：
   *   1. 照着**现在**的 spec 收敛，而不是「创建时做一次」
   *   2. 属主引用挂上，Site 没了路由跟着没
   *   3. watch 自己造出来的类型，别人改坏了下一轮能改回去
   */
  exports.watches = ['Site', 'HTTPRoute'];

  exports.reconcile = (ctx) => {
    const site = ctx.object;
    const backend = (site.spec || {}).service || {};

    if (!site.spec || !site.spec.host || !backend.name) {
      ctx.setStatus({ ready: false, reason: 'spec.host 和 spec.service.name 都是必填' });
      ctx.event('InvalidSpec', 'host 或者 service 没写全', 'Warning');
      return;
    }

    ctx.apply({
      apiVersion: 'gateway.networking.k8s.io/v1',
      kind: 'HTTPRoute',
      metadata: {
        name: site.metadata.name,
        namespace: site.metadata.namespace,
        // 不挂这个的话，Site 删了路由还在，变成没人管的孤儿
        ownerReferences: [ctx.owner()],
      },
      spec: {
        parentRefs: [{ name: 'self-service' }],
        hostnames: [site.spec.host],
        rules: [{
          matches: [{ path: { type: 'PathPrefix', value: '/' } }],
          backendRefs: [{ name: backend.name, port: backend.port || 80 }],
        }],
      },
    });

    // 只写观察到的事实，不写期望 —— 期望在 spec 里
    ctx.setStatus({
      ready: true,
      url: 'http://' + site.spec.host,
      observedGeneration: site.metadata.generation,
    });
  };
`;

const SHOP_SITE = code`
  apiVersion: platform.corp.internal/v1
  kind: Site
  metadata:
    name: shop
    namespace: payments
  spec:
    host: shop.corp.internal
    service:
      name: portal
      port: 80
`;

const SHOP_SITE_MOVED = code`
  apiVersion: platform.corp.internal/v1
  kind: Site
  metadata:
    name: shop
    namespace: payments
  spec:
    host: shop2.corp.internal
    service:
      name: portal
      port: 80
`;

const stage23 = {
  id: 'write-an-operator',
  title: t('写一个 Operator', 'Write an Operator'),
  goal: t(
    code`
      业务方要一个对外入口，现在的流程是提工单：平台组手写一条 HTTPRoute，
      改一次 host 再提一次工单。一周三四次，而且每次都有人写错后端端口。

      这一关把这件事变成自助的：业务方提交一个 \`Site\`，平台负责让它成真。

      两半：一半是 \`CustomResourceDefinition\`，让 apiserver 认识 Site 这个类型；
      另一半是 \`/root/operator/site.js\` 里那个 \`reconcile\` —— 它就是控制器本身，
      世界会 watch 你声明的类型，每次变化调它一次。

      Site 长这样（\`/root/sites/shop.yaml\`）：

      \`\`\`yaml
      spec:
        host: shop.corp.internal
        service:
          name: portal
          port: 80
      \`\`\`

      要造出来的是一条挂在 \`self-service\` 这个 Gateway 上的 HTTPRoute。

      ## 通关标准

      1. \`kubectl get sites\` 查得到，而且一眼看得出 host；
      2. 提交一个 Site，路由自动出现，而且**真的通** —— 从跳板机上 curl 得到 200；
      3. 改了 Site 的 host，路由跟着改（声明式，不是「创建时做一次」）；
      4. 有人手工把路由改坏，下一轮要改回去；
      5. 删掉 Site，路由跟着没；
      6. Site 的 status 里写得出它现在好不好。

      ## 会用到的命令

      \`\`\`bash
      kubectl apply -f /root/operator/site-crd.yaml
      kubectl apply -f /root/sites/shop.yaml
      kubectl get sites -n payments
      kubectl describe site shop -n payments
      kubectl get httproute -n payments
      \`\`\`
    `,
    code`
      Teams that want a public entry point file a ticket, someone on the platform team
      hand-writes an HTTPRoute, and changing a hostname means another ticket. Three or
      four a week, and somebody always gets the backend port wrong.

      This stage turns that into self-service: a team submits a \`Site\`, and the
      platform makes it real.

      Two halves. One is a \`CustomResourceDefinition\` that teaches the apiserver about
      Site. The other is the \`reconcile\` function in \`/root/operator/site.js\`, which
      *is* the controller: the world watches the kinds you declare and calls it on
      every change.

      A Site looks like this (\`/root/sites/shop.yaml\`):

      \`\`\`yaml
      spec:
        host: shop.corp.internal
        service:
          name: portal
          port: 80
      \`\`\`

      What it should produce is an HTTPRoute attached to the \`self-service\` Gateway.

      ## Done when

      1. \`kubectl get sites\` works and shows the host at a glance;
      2. submitting a Site produces a route that **actually serves**: curl from the jump
         host returns 200;
      3. changing the host changes the route (declarative, not create-once);
      4. if somebody edits the route by hand, the next reconcile puts it back;
      5. deleting the Site removes the route;
      6. the Site's status says whether it is working.

      ## Commands you will need

      \`\`\`bash
      kubectl apply -f /root/operator/site-crd.yaml
      kubectl apply -f /root/sites/shop.yaml
      kubectl get sites -n payments
      kubectl describe site shop -n payments
      kubectl get httproute -n payments
      \`\`\`
    `
  ),
  checklist: [
    t('新类型注册得上', 'The new kind is registered'),
    t('路由自动出现而且通', 'The route appears and serves'),
    t('改坏了能自己修回去', 'Drift is repaired'),
  ],
  hints: [
    t(
      'reconcile 不是「事件处理器」。它收到的只有「这个对象该看一眼了」，不告诉你变的是什么 —— 所以正确的写法永远是「照着**现在**的 spec，把世界收敛过去」，而不是「根据这次的变化做个增量」。这也是它必须可以被重复调用而不出错的原因。',
      'Reconcile is not an event handler. All it gets is "look at this object again", never what changed, so the correct shape is always "converge the world to the spec as it is now", not "apply a delta for this change". That is also why it must be safe to call repeatedly.'
    ),
    t(
      '想修偏差，就得 watch 自己造出来的那个类型。只 watch 主类型的话，别人手工改坏了路由，你要等到下一次有人动 Site 才会发现 —— 那不叫「持续收敛」，那叫「碰巧修好」。',
      'To repair drift you must watch the kind you create. Watching only the primary kind means a hand-edited route stays broken until somebody happens to touch the Site again, which is not continuous convergence, it is coincidence.'
    ),
    t(
      '删除不用你写代码。属主引用挂对了，Site 一删，垃圾回收会把路由一起带走。真正需要写删除逻辑的是「外部状态」—— 比如你在集群外面开了一个 DNS 记录，那才要 finalizer。',
      'You do not write deletion logic. With the owner reference attached, garbage collection takes the route away with the Site. What actually needs a finalizer is **external** state, like a DNS record you created outside the cluster.'
    ),
  ],
  pitfalls: [
    t(
      'status 里每次都写一个新时间戳。写 status 会触发一次新的 watch 事件，事件又触发 reconcile，reconcile 又写 status —— 控制器把自己吵醒，CPU 跑满而且什么都没做。只在**真的变了**的时候才写。',
      'Writing a fresh timestamp into status every pass. Writing status produces a watch event, the event triggers reconcile, reconcile writes status: the controller wakes itself up forever, burning CPU and achieving nothing. Write only when something actually changed.'
    ),
    t(
      '把期望状态放进 status。status 是**观察到的事实**，随时可以被重新算出来；spec 是期望，只有人能改。放反了的后果是：备份恢复之后、或者 status 被清掉之后，控制器不知道该收敛到哪儿去。',
      'Putting desired state into status. Status is observed fact and must be recomputable at any moment; spec is desire and only humans change it. Get it backwards and the controller no longer knows what to converge to after a restore, or after status is cleared.'
    ),
    t(
      '整体替换自己造出来的对象。apiserver 会往对象上补字段（resourceVersion、集群分配的那些），整体覆盖会把它们抹掉，于是每一轮 reconcile 都「发现不一样」再写一次，无限重写。只改你负责的那部分。',
      'Replacing the object you create wholesale. The apiserver adds fields of its own (resourceVersion, cluster-assigned values); overwriting them means every reconcile "finds a difference" and writes again, forever. Touch only the parts you own.'
    ),
  ],
  ops: {
    setupCommands: [...PREVIOUS_STAGES],
    objects: [
      CNI_CILIUM,
      ...GATEWAY_PLATFORM, ...CERT_MANAGER_PLATFORM, ...TLS_PLATFORM,
      ...ROLLOUTS_PLATFORM, ...MONITORING_CARRIED,
      ...PORTAL_ROLLOUT, PORTAL_ROUTE,
      SELF_SERVICE_GATEWAY, SITE_OPERATOR,
    ],
    operator: { path: '/root/operator/site.js', kind: 'Site', name: 'site-operator' },
    files: {
      '/root/operator/site-crd.yaml': SITE_CRD_STARTER,
      '/root/operator/site.js': OPERATOR_STARTER,
      '/root/sites/shop.yaml': SHOP_SITE,
      '/root/sites/shop-moved.yaml': SHOP_SITE_MOVED,
    },
    referenceFiles: {
      '/root/operator/site-crd.yaml': SITE_CRD_REFERENCE,
      '/root/operator/site.js': OPERATOR_REFERENCE,
    },
    referenceCommands: [
      'kubectl apply -f /root/operator/site-crd.yaml',
    ],
  },
  specs: [
    spec('write-an-operator.spec.ts', code`
      import { advance, get, list, sh } from '@ops/lab';

      const SITE = () => get('Site', 'shop', 'payments');
      const ROUTE = () => list('HTTPRoute', { namespace: 'payments' })
        .filter((route) => route.metadata.name === 'shop')[0];

      const gatewayAddress = () => {
        const gateway = get('Gateway', 'self-service', 'payments');
        return ((gateway.status || {}).addresses || [])[0].value;
      };

      describe('写一个 Operator', () => {
        it('新类型注册得上，而且一眼看得出 host', async () => {
          const crds = list('CustomResourceDefinition')
            .filter((crd) => crd.spec.names.kind === 'Site');
          expect(crds.length).toBe(1);
          const established = (crds[0].status.conditions || [])
            .filter((condition) => condition.type === 'Established');
          expect(established[0].status).toBe('True');

          await sh('kubectl apply -f /root/sites/shop.yaml');
          await advance(30000);

          const listed = await sh('kubectl get sites -n payments');
          expect(listed.code).toBe(0);
          expect(listed.stdout).toContain('shop.corp.internal');
        });

        it('路由自动出现，而且指向对的后端', () => {
          const route = ROUTE();
          expect(route).toBeTruthy();
          expect(route.spec.hostnames).toEqual(['shop.corp.internal']);
          const backend = route.spec.rules[0].backendRefs[0];
          expect(backend.name).toBe('portal');
          expect(backend.port).toBe(80);
          // 属主引用要挂上，不然删了 Site 会留下孤儿
          const owners = route.metadata.ownerReferences || [];
          expect(owners.some((owner) => owner.kind === 'Site' && owner.name === 'shop')).toBe(true);
        });

        it('真的通：从跳板机上 curl 得到 200', async () => {
          const result = await sh(
            "curl -s -o /dev/null -w '%{http_code}' -H 'Host: shop.corp.internal' http://"
            + gatewayAddress()
          );
          expect(result.stdout).toBe('200');
        });

        it('status 写得出它现在好不好', () => {
          const status = SITE().status || {};
          expect(status.ready).toBe(true);
          expect(status.observedGeneration).toBe(SITE().metadata.generation);
        });

        it('改了 Site，路由跟着改', async () => {
          await sh('kubectl apply -f /root/sites/shop-moved.yaml');
          await advance(30000);
          expect(ROUTE().spec.hostnames).toEqual(['shop2.corp.internal']);

          const result = await sh(
            "curl -s -o /dev/null -w '%{http_code}' -H 'Host: shop2.corp.internal' http://"
            + gatewayAddress()
          );
          expect(result.stdout).toBe('200');
        });

        it('有人手工改坏了路由，下一轮改回去', async () => {
          await sh(
            'kubectl patch httproute shop -n payments --type=json -p '
            + '\\'[{"op":"replace","path":"/spec/hostnames","value":["oops.corp.internal"]}]\\''
          );
          await advance(30000);
          expect(ROUTE().spec.hostnames).toEqual(['shop2.corp.internal']);
        });

        it('删掉 Site，路由跟着没', async () => {
          await sh('kubectl delete site shop -n payments');
          await advance(30000);
          expect(ROUTE()).toBeUndefined();
        });
      });
    `),
  ],
  focus: ['architecture', 'operations'],
  extension: t(
    code`
      写完这一关，值得回头看一眼整个项目：从第 1 关那条 \`kubectl get nodes\`
      到这里，你一路见到的所有东西 —— Deployment、Gateway、Certificate、
      Rollout、Backup、MachineDeployment —— 都是同一个形状：一个描述期望的对象，
      加一个把期望变成现实的控制器。你刚才写的那三十行，和它们没有本质区别。

      这就是 Kubernetes 真正的产品：不是容器编排，是一个**通用的声明式 API
      服务器**加一套控制器模式。容器编排只是这套东西的第一个应用。
      所以「用 CRD 管数据库」「用 CRD 管 DNS 记录」「用 CRD 管办公室门禁」
      听起来离谱，但在架构上完全成立 —— 存储、鉴权、watch、审计、
      kubectl 全套白送，你只要写那个 reconcile。

      有两条边界值得记住。一是**不是所有东西都该做成 CRD**：一个只在部署时
      跑一次的动作，写成 Job 或者 CI 的一步更合适 —— 控制器的成本是它要
      永远活着、永远正确。二是**reconcile 一定要幂等且可重入**：它会在你
      意料之外的时刻被调用（重启之后的全量 resync、别人改坏了、
      你自己写 status 触发的那一次），任何「只能执行一次」的逻辑迟早会出事。
    `,
    code`
      Now that this one is done, look back across the whole project. Everything you met
      from that first \`kubectl get nodes\` onwards — Deployment, Gateway, Certificate,
      Rollout, Backup, MachineDeployment — has the same shape: an object describing
      desired state, plus a controller that makes it real. The thirty lines you just
      wrote are not different in kind from any of them.

      That is what Kubernetes actually is: not container orchestration, but a **general
      declarative API server** plus a controller pattern. Container orchestration was
      simply its first application. Which is why "manage databases with a CRD", "manage
      DNS records with a CRD", or "manage office door badges with a CRD" sound absurd
      and are architecturally sound: storage, authorization, watch, audit, and kubectl
      all come for free, and you only write the reconcile.

      Two boundaries are worth keeping. First, **not everything should be a CRD**: an
      action that runs once at deploy time is better as a Job or a CI step, because a
      controller costs you something that must stay alive and stay correct forever.
      Second, **reconcile must be idempotent and re-entrant**: it will be called at
      moments you did not plan for, including the full resync after a restart, after
      somebody edits your output, and on the pass your own status write triggered.
      Any logic that can only run once will eventually run twice.
    `
  ),
};

module.exports = {
  id: 'intranet-k8s',
  title: t('内网设施实战：接手一家公司的 Kubernetes', 'Intranet Infrastructure: Inheriting a Kubernetes Cluster'),
  summary: t(
    '从一台跳板机接手公司的 Kubernetes 集群。你要排查故障、交付应用、收紧权限、恢复数据，最后写出自己的 Operator。',
    'Take over a company Kubernetes cluster from a jump host. Diagnose failures, ship workloads, tighten access, restore data, and finish by writing an Operator.'
  ),
  difficulty: 'Hard',
  domain: 'infrastructure',
  tags: ['kubernetes', 'sre', 'containers', 'gitops'],
  estimatedMinutes: 240,
  language: 'typescript',
  brief: t(
    code`
      ## 你接手的是什么

      你刚加入公司的基础设施团队。前任只留下一台跳板机、一个 Kubernetes 集群，
      还有一份不能完全相信的交接文档。第一关不会告诉你故障答案，你得先用
      \`kubectl\` 查看节点、工作负载和事件，判断集群现在是什么状态。

      后面的任务沿着真实的运维路径展开。你会把应用容器化并推到私有仓库，处理配置、
      Secret、探针和资源限制；然后接管入口流量、证书、网络策略与 GitOps。项目后半段会
      收紧 RBAC，把规则写成准入策略，补上可观测性、自动回滚、备份恢复和容量伸缩。
      第 23 关要求你写一个 Operator，让自定义资源持续收敛到期望状态。

      ## 二十三关的工作范围

      | 阶段 | 关卡 | 你会处理的事情 |
      | --- | --- | --- |
      | 接管与上线 | 1-7 | 集群排障、Deployment、镜像构建、私有仓库、配置、探针、资源与驱逐 |
      | 交付与流量 | 8-13 | Gateway API、证书、网络策略、GitOps、Helm 与清单定制 |
      | 网络与安全 | 14-18 | 包路径、服务网格身份、RBAC、策略和集群外密钥 |
      | 运行与恢复 | 19-23 | 可观测性、自动回滚、备份恢复、弹性容量和 Operator |

      各关共用同一个集群世界。前面留下的对象、仓库提交、证书和策略会继续存在，
      所以后续任务不是一组互不相干的命令练习。你需要在已有状态上判断该改什么，
      也要确认改动没有破坏前面已经恢复的部分。

      ## 终端和集群怎样运行

      终端使用 tree-sitter 解析 bash。平台把官方 \`kubectl\` 和 \`helm\` 二进制编译成
      WebAssembly，命令、参数和资源结构与日常使用一致。
      \`docker build\` 会读取 Dockerfile，按层构建并计算 sha256 摘要。

      集群由内存中的 apiserver 和控制器循环组成。Pod 会经过调度、拉取镜像、就绪和崩溃，
      Deployment、证书、Rollout 与 MachineDeployment 也会由各自的控制器推进。
      时间可以加速，但状态变化仍按控制器逻辑发生。

      ## 怎么验收

      平台检查的是集群最终状态，不是终端历史。用 \`kubectl apply\`、\`patch\`、
      \`helm upgrade\`，或者编辑清单再提交都可以，只要结果满足要求。

      验收还会等待控制器继续运行。一个对象刚创建时看起来正确，但下一轮 reconcile
      又被改坏，照样不能通过。网络策略必须真的改变连通性，回滚必须真的撤掉坏版本，
      恢复任务也必须把对象和数据一起找回来。

      ## 项目边界

      这是可执行的单集群实验环境，不需要准备真实云账号或 Kubernetes 安装。
      你处理的是集群内资源、仓库状态和控制器行为，不涉及采购机器或配置真实公司的网络。
    `,
    code`
      ## What you are taking over

      You have just joined the infrastructure team. Your predecessor left a jump host,
      a Kubernetes cluster, and a handover document that cannot be trusted completely.
      The first stage does not tell you what failed. You must inspect nodes, workloads,
      and events with \`kubectl\` and work out the current state yourself.

      The remaining tasks follow the path of real cluster operations. You will containerise
      an application, push it to a private registry, and deal with configuration, Secrets,
      probes, and resource limits. You then take over ingress traffic, certificates, network
      policy, and GitOps. Later stages tighten RBAC, turn rules into admission policy, and add
      observability, automated rollback, backup and restore, and elastic capacity. Stage 23
      ends with an Operator that keeps a custom resource reconciled with its desired state.

      ## Scope of the twenty-three stages

      | Phase | Stages | Work |
      | --- | --- | --- |
      | Takeover and launch | 1-7 | Diagnosis, Deployments, image builds, private registries, configuration, probes, resources, and eviction |
      | Delivery and traffic | 8-13 | Gateway API, certificates, network policy, GitOps, Helm, and manifest customisation |
      | Network and security | 14-18 | Packet paths, service identities, RBAC, policy, and secrets outside the cluster |
      | Operations and recovery | 19-23 | Observability, rollback, backup and restore, elastic capacity, and an Operator |

      Every stage uses the same cluster world. Objects, repository commits, certificates,
      and policies from earlier work remain in place. These are not isolated command drills.
      You must decide what to change in the state you inherited and make sure the change does
      not break something you already repaired.

      ## How the terminal and cluster work

      The terminal parses bash with tree-sitter. The platform runs the upstream \`kubectl\`
      and \`helm\` binaries compiled to WebAssembly, with their normal commands, flags, and
      resource shapes. \`docker build\` reads the Dockerfile, creates layers, and computes
      sha256 digests.

      The cluster is an in-memory apiserver with controller loops. Pods are scheduled, pull
      images, become ready, and crash. Deployments, certificates, Rollouts, and
      MachineDeployments advance through their own controllers. Time can be accelerated,
      but state still changes through controller logic.

      ## How it is checked

      The platform checks the final cluster state, not the shell history. You may use
      \`kubectl apply\`, \`patch\`, \`helm upgrade\`, or edit and commit a manifest. The route
      does not matter if the resulting state is correct.

      Acceptance also lets controllers continue running. An object that looks correct at
      creation time but is broken by the next reconcile does not pass. A network policy must
      change connectivity, a rollback must remove the bad release, and a restore must recover
      both objects and data.

      ## Project boundary

      This is an executable single-cluster lab. It needs no cloud account or Kubernetes
      installation. The work covers cluster resources, repository state, and controller
      behaviour, not purchasing machines or configuring a real company network.
    `
  ),
  workspace: { kind: 'ops', world: WORLD },
  files: [],
  stages: [
    stage1, stage2, stage3, stage4, stage5, stage6,
    stage7, stage8, stage9, stage10, stage11, stage12,
    stage13, stage14, stage15, stage16, stage17, stage18, stage19, stage20,
    stage21, stage22, stage23,
  ],
};
