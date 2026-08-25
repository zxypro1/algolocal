/**
 * Pod 里面那个 shell
 *
 * `kubectl exec` 落到这里。容器里能跑什么，取决于镜像给了什么：
 * 一个基础的 rootfs、coreutils、以及网络工具 —— 而这些工具发起的连接，
 * 源是**这个 Pod**，不是跳板机。第 10、11 关整两关都建立在这个区别上：
 * 同一条 curl，从跳板机发和从 Pod 里发，结果完全不同。
 */
import type { KubeObject } from '../apiserver';
import type { Cluster } from '../controllers';
import { COREUTILS, createShell, createVfs } from '../machine';
import { createNetTools } from '../net';
import type { ExecRequest, ExecResult } from '../apiserver';

/**
 * 容器里那套最小的根文件系统。
 *
 * 真容器里有什么取决于基础镜像，这里给的是「一个能排查问题的容器」应该有的
 * 那点东西。`/etc/resolv.conf` 尤其重要：第 10 关要学员自己去看 ndots。
 */
function rootfsFor(pod: KubeObject, cluster: Cluster): Record<string, string> {
  const namespace = pod.metadata.namespace ?? 'default';
  const status = (pod.status ?? {}) as { podIP?: string };
  return {
    '/etc/resolv.conf': cluster.network.resolvConfOf(namespace),
    '/etc/hosts': [
      '127.0.0.1\tlocalhost',
      `${status.podIP ?? '127.0.0.1'}\t${pod.metadata.name}`,
      '',
    ].join('\n'),
    '/etc/hostname': `${pod.metadata.name}\n`,
    '/var/run/secrets/kubernetes.io/serviceaccount/namespace': namespace,
  };
}

export function createExecHandler(cluster: Cluster) {
  return async (request: ExecRequest, stdin: string): Promise<ExecResult> => {
    const pods = cluster.scheme.get({ group: '', version: 'v1', resource: 'pods' });
    if (!pods) return { stdout: '', stderr: 'pods resource not registered\n', code: 1 };

    let pod: KubeObject;
    try {
      pod = cluster.registry.get(pods, request.namespace, request.pod);
    } catch {
      return {
        stdout: '',
        stderr: `Error from server (NotFound): pods "${request.pod}" not found\n`,
        code: 1,
      };
    }

    const status = (pod.status ?? {}) as { phase?: string };
    if (status.phase !== 'Running') {
      // 真 apiserver 在这种情况下报的是「连不上后端」，不是「Pod 不存在」
      return {
        stdout: '',
        stderr: `error: unable to upgrade connection: container not found ("${
          request.container ?? containersOf(pod)[0]?.name ?? 'app'
        }")\n`,
        code: 1,
      };
    }

    const containers = containersOf(pod);
    const container = request.container
      ? containers.find((entry) => entry.name === request.container)
      : containers[0];
    if (!container) {
      return {
        stdout: '',
        stderr: `Error from server (BadRequest): container ${request.container} is not valid for pod ${request.pod}\n`,
        code: 1,
      };
    }

    const vfs = createVfs(() => cluster.wallClock());
    vfs.populate(rootfsFor(pod, cluster));
    for (const directory of ['/bin', '/usr/bin', '/tmp', '/app']) vfs.mkdirp(directory);

    const source = {
      zone: 'cluster' as const,
      namespace: request.namespace,
      podName: request.pod,
      ip: ((pod.status ?? {}) as { podIP?: string }).podIP,
      label: request.pod,
    };

    const shell = createShell({
      vfs,
      cwd: '/',
      hostname: request.pod,
      user: 'root',
      env: {
        HOSTNAME: request.pod,
        KUBERNETES_SERVICE_HOST: 'kubernetes.default.svc',
        KUBERNETES_SERVICE_PORT: '443',
        ...envOf(container),
      },
      commands: {
        ...COREUTILS,
        ...createNetTools({
          network: cluster.network,
          source: () => source,
          advance: (ms) => { void cluster.advanceBy(ms); },
        }),
      },
    });

    // `kubectl exec pod -- sh -c '...'` 与 `kubectl exec pod -- curl x` 都要能跑
    const command = normalizeCommand(request.command);
    const result = await shell.run(command, stdin);
    return { stdout: result.stdout, stderr: result.stderr, code: result.code };
  };
}

/**
 * argv 拼回一行。
 *
 * `sh -c 'curl x'` 里那一段本来就是一整条命令，直接拿它；其余情况把参数
 * 用引号包好再拼，免得参数里的空格被 shell 再拆一次。
 */
export function normalizeCommand(argv: string[]): string {
  if ((argv[0] === 'sh' || argv[0] === 'bash') && argv[1] === '-c' && argv[2] !== undefined) {
    return argv.slice(2).join(' ');
  }
  return argv.map(quote).join(' ');
}

function quote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function containersOf(pod: KubeObject): Array<{ name: string; env?: Array<{ name: string; value?: string }> }> {
  return ((pod.spec ?? {}) as any).containers ?? [];
}

function envOf(container: { env?: Array<{ name: string; value?: string }> }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of container.env ?? []) {
    if (entry.value !== undefined) out[entry.name] = entry.value;
  }
  return out;
}
