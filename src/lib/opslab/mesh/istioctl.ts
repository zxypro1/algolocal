/**
 * `istioctl`
 *
 * 真 istioctl 是 Go 写的，把它编进多合一二进制要多背一份 Istio 的 API 与
 * proto，产物会涨一大截 —— 而它在这里的价值全在**输出**上：
 * `ztunnel-config workload` 那张表、`x describe pod` 那几行判定、
 * `analyze` 报出来的问题。所以这里按行为等价重写，输出照抄上游的格式。
 *
 * 不做的：`istioctl install`（用 kubectl apply 装）、`proxy-config`
 * （那是 sidecar 模式的东西，ambient 里没有 sidecar）。
 */
import type { KubeObject } from '../apiserver';
import type { CommandHandler, CommandResult } from '../machine/shell/shell';
import { policiesFor } from './policy';
import { isAmbient, strictnessFor, type MeshPeer, type MeshView } from './mesh';
import { AMBIENT_LABEL, spiffeId } from './resources';

export interface IstioctlOptions {
  /** 集群视图。命令只读，不改任何东西。 */
  view(): {
    mesh: MeshView;
    pods(namespace?: string): KubeObject[];
    namespaces(): KubeObject[];
    services(namespace?: string): KubeObject[];
    peerOf(pod: KubeObject): MeshPeer;
  } | undefined;
  /** 默认命名空间 */
  namespace(): string;
}

export function createIstioctlCommand(options: IstioctlOptions): CommandHandler {
  return ({ argv }) => {
    const view = options.view();
    if (!view) return { stderr: 'istioctl: 这个集群没有注册 Istio 的类型\n', code: 1 };

    const [command, ...rest] = argv;
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
        return { stdout: USAGE };
      case 'version':
        return { stdout: 'client version: 1.28.1\ncontrol plane version: 1.28.1\nztunnel version: 1.28.1\n' };
      case 'x':
      case 'experimental':
        return experimental(rest, view, options);
      case 'ztunnel-config':
        return ztunnelConfig(rest, view);
      case 'analyze':
        return analyze(rest, view, options);
      case 'proxy-status':
      case 'ps':
        return proxyStatus(view);
      default:
        return { stderr: `unknown command ${JSON.stringify(command)}\n${USAGE}`, code: 1 };
    }
  };
}

const USAGE = `Istio configuration command line utility.

Usage:
  istioctl [command]

Available Commands:
  analyze          Analyze Istio policy and print validation messages
  proxy-status     Retrieves the synchronization status of the mesh
  version          Prints out build version information
  x                Experimental commands
  ztunnel-config   Update or retrieve current ztunnel configuration
`;

function experimental(argv: string[], view: NonNullable<ReturnType<IstioctlOptions['view']>>, options: IstioctlOptions): CommandResult {
  const [command, ...rest] = argv;
  if (command === 'ztunnel-config') return ztunnelConfig(rest, view);
  if (command === 'describe') return describe(rest, view, options);
  return { stderr: `unknown experimental command ${JSON.stringify(command ?? '')}\n`, code: 1 };
}

/**
 * `istioctl ztunnel-config workload`
 *
 * 这张表回答的是「哪些工作负载真的进网格了」。`PROTOCOL` 那一列是重点：
 * HBONE 表示 ztunnel 接管了它，TCP 表示没有 —— 命名空间标签打了没打，
 * 一眼就看出来。
 */
function ztunnelConfig(argv: string[], view: NonNullable<ReturnType<IstioctlOptions['view']>>): CommandResult {
  const what = argv.find((entry) => !entry.startsWith('-')) ?? 'workload';
  if (!what.startsWith('workload')) {
    return { stderr: `istioctl: 这里只做 workload 视图\n`, code: 1 };
  }
  const rows = view.pods()
    .filter((pod) => ((pod.status ?? {}) as any).phase === 'Running')
    .map((pod) => {
      const peer = view.peerOf(pod);
      return {
        namespace: pod.metadata.namespace ?? 'default',
        name: pod.metadata.name ?? '',
        ip: ((pod.status ?? {}) as any).podIP ?? '',
        node: ((pod.spec ?? {}) as any).nodeName ?? '',
        waypoint: view.mesh.hasWaypoint(pod.metadata.namespace ?? 'default') ? 'waypoint' : 'None',
        protocol: peer.enrolled ? 'HBONE' : 'TCP',
      };
    })
    .sort((a, b) => (`${a.namespace}/${a.name}` < `${b.namespace}/${b.name}` ? -1 : 1));

  const header = ['NAMESPACE', 'POD NAME', 'ADDRESS', 'NODE', 'WAYPOINT', 'PROTOCOL'];
  const table = rows.map((row) => [row.namespace, row.name, row.ip, row.node, row.waypoint, row.protocol]);
  return { stdout: renderTable(header, table) };
}

/**
 * `istioctl x describe pod <name>`
 *
 * 上游这条命令的价值在于它把散落在几个对象里的判定合到一起说：
 * 进没进网格、mTLS 是什么模式、哪些 AuthorizationPolicy 选中了它。
 */
function describe(argv: string[], view: NonNullable<ReturnType<IstioctlOptions['view']>>, options: IstioctlOptions): CommandResult {
  const positional = argv.filter((entry) => !entry.startsWith('-'));
  if (positional[0] !== 'pod' || !positional[1]) {
    return { stderr: 'usage: istioctl x describe pod <pod-name> [-n <namespace>]\n', code: 1 };
  }
  const namespace = namespaceOf(argv) ?? options.namespace();
  const pod = view.pods(namespace).find((item) => item.metadata.name === positional[1]);
  if (!pod) {
    return { stderr: `pod ${positional[1]} not found in namespace ${namespace}\n`, code: 1 };
  }

  const peer = view.peerOf(pod);
  const lines = [`Pod: ${pod.metadata.name}`];
  lines.push(`   Pod Revision: default`);
  if (!view.mesh.installed()) {
    lines.push('WARNING: 网格没有在跑（istiod / ztunnel 不可用），下面的判定不会生效');
  }
  lines.push(peer.enrolled
    ? `   Pod Ports: ambient (ztunnel)`
    : `   Pod Ports: 不在网格里（命名空间缺少 ${AMBIENT_LABEL.key}=${AMBIENT_LABEL.value}）`);
  lines.push(`   Identity: ${spiffeId(peer.namespace, peer.serviceAccount)}`);

  const mode = strictnessFor(view.mesh.peerAuthentications(), peer);
  lines.push('');
  lines.push(`Effective PeerAuthentication:`);
  lines.push(`   Workload mTLS mode: ${mode.mtls}${mode.policy ? ` (${mode.policy})` : ' (default)'}`);

  const selected = policiesFor(view.mesh.authorizationPolicies(), {
    namespace: peer.namespace, labels: peer.labels,
  });
  lines.push('');
  if (selected.length === 0) {
    lines.push('Exposed on Ingress Gateway: none');
    lines.push('AuthorizationPolicy: 没有策略选中这个工作负载（默认允许）');
  } else {
    lines.push('AuthorizationPolicy:');
    for (const policy of selected) {
      const action = ((policy.spec ?? {}) as any).action ?? 'ALLOW';
      lines.push(`   ${policy.metadata.namespace}/${policy.metadata.name}: ${action}`);
    }
    if (!view.mesh.hasWaypoint(peer.namespace) && usesLayer7(selected)) {
      lines.push(
        `WARNING: 有规则用到了 methods/paths，但 ${peer.namespace} 没有 waypoint，`
        + 'ztunnel 求值不了这些条件，它们会被忽略'
      );
    }
  }
  return { stdout: `${lines.join('\n')}\n` };
}

/**
 * `istioctl analyze`
 *
 * 只报真会咬人的那几类。报太多没人看，报错了比不报还糟。
 */
function analyze(argv: string[], view: NonNullable<ReturnType<IstioctlOptions['view']>>, options: IstioctlOptions): CommandResult {
  const all = argv.includes('-A') || argv.includes('--all-namespaces');
  const namespace = namespaceOf(argv) ?? options.namespace();
  const scope = all ? undefined : namespace;
  const messages: string[] = [];

  if (!view.mesh.installed()) {
    messages.push(
      'Error [IST0001] (Mesh) 网格的控制面或数据面不可用：istiod 与 ztunnel 都需要在跑，'
      + '否则 PeerAuthentication 与 AuthorizationPolicy 全部不生效'
    );
  }

  // L7 规则没有 waypoint
  for (const policy of view.mesh.authorizationPolicies()) {
    const policyNamespace = policy.metadata.namespace ?? 'default';
    if (scope && policyNamespace !== scope) continue;
    if (!usesLayer7([policy])) continue;
    if (view.mesh.hasWaypoint(policyNamespace)) continue;
    messages.push(
      `Warning [IST0162] (AuthorizationPolicy ${policyNamespace}/${policy.metadata.name}) `
      + `规则里用到了 methods/paths，但 ${policyNamespace} 没有挂 waypoint。`
      + `ztunnel 只做 L4，这些条件不会被求值。`
    );
  }

  // STRICT 但命名空间没进网格
  for (const policy of view.mesh.peerAuthentications()) {
    const policyNamespace = policy.metadata.namespace ?? 'default';
    if (scope && policyNamespace !== scope) continue;
    if (((policy.spec ?? {}) as any).mtls?.mode !== 'STRICT') continue;
    const object = view.namespaces().find((item) => item.metadata.name === policyNamespace);
    if (isAmbient(object) || policyNamespace === 'istio-system') continue;
    messages.push(
      `Warning [IST0163] (PeerAuthentication ${policyNamespace}/${policy.metadata.name}) `
      + `要求 STRICT，但 ${policyNamespace} 没有打上 ${AMBIENT_LABEL.key}=${AMBIENT_LABEL.value}，`
      + `里面的工作负载不在网格里，这条策略不会生效。`
    );
  }

  // 一有 ALLOW 策略，其余全拒 —— 值得提醒一次
  for (const policy of view.mesh.authorizationPolicies()) {
    const policyNamespace = policy.metadata.namespace ?? 'default';
    if (scope && policyNamespace !== scope) continue;
    const spec = (policy.spec ?? {}) as any;
    if ((spec.action ?? 'ALLOW') !== 'ALLOW') continue;
    if ((spec.rules ?? []).length > 0) continue;
    messages.push(
      `Warning [IST0164] (AuthorizationPolicy ${policyNamespace}/${policy.metadata.name}) `
      + `ALLOW 但一条 rule 都没有，等于拒绝所有访问。`
    );
  }

  if (messages.length === 0) {
    return { stdout: `✔ No validation issues found when analyzing ${all ? 'all namespaces' : `namespace: ${namespace}`}.\n` };
  }
  return { stdout: `${messages.join('\n')}\n`, code: 1 };
}

/** `istioctl proxy-status`：ambient 下看的是 ztunnel 有没有跟上配置 */
function proxyStatus(view: NonNullable<ReturnType<IstioctlOptions['view']>>): CommandResult {
  if (!view.mesh.installed()) {
    return { stderr: 'Error: 无法连接到控制面：istiod 不可用\n', code: 1 };
  }
  const rows = view.pods()
    .filter((pod) => ((pod.status ?? {}) as any).phase === 'Running' && view.peerOf(pod).enrolled)
    .map((pod) => [
      `${pod.metadata.name}.${pod.metadata.namespace}`,
      'ztunnel',
      'SYNCED', 'SYNCED', 'SYNCED', 'SYNCED',
      'istiod-5d9f8c7b6-abcde', '1.28.1',
    ])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const header = ['NAME', 'CLUSTER', 'CDS', 'LDS', 'EDS', 'RDS', 'ISTIOD', 'VERSION'];
  return { stdout: renderTable(header, rows) };
}

/* ------------------------------------------------------------------ */

function usesLayer7(policies: KubeObject[]): boolean {
  return policies.some((policy) =>
    (((policy.spec ?? {}) as any).rules ?? []).some((rule: any) =>
      (rule.to ?? []).some((entry: any) => entry.operation?.methods || entry.operation?.paths)));
}

function namespaceOf(argv: string[]): string | undefined {
  const index = argv.findIndex((entry) => entry === '-n' || entry === '--namespace');
  return index >= 0 ? argv[index + 1] : undefined;
}

/** 和 kubectl 一样：每列按最宽的内容对齐，列间三个空格 */
function renderTable(header: string[], rows: string[][]): string {
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => (row[index] ?? '').length)));
  const line = (cells: string[]) =>
    cells.map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index]))).join('   ');
  return [line(header), ...rows.map(line)].join('\n') + '\n';
}
