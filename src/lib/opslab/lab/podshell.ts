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
import { COREUTILS, createShell, createVfs } from '../../labkit/machine';
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

    /**
     * 把卷挂进来。
     *
     * 容器的根文件系统每次 exec 都是新的（真容器里写在 rootfs 上的东西
     * 一重建也就没了），**挂载点下面**的内容却来自卷 —— 这正是持久化的含义。
     * emptyDir 故意不接：它和 Pod 同生共死，写进去的东西下一次 exec 就不在了。
     */
    const mounts = mountsOf(pod, container.name, cluster);
    for (const mount of mounts) {
      vfs.mkdirp(mount.path);
      vfs.populate(prefixed(cluster.volumes.read(mount.volume), mount.path));
    }

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

    // 写回。挂载点下面的都是卷上的字节，其余的随容器一起消失。
    for (const mount of mounts) {
      cluster.volumes.write(mount.volume, stripped(vfs.toFileMap(mount.path), mount.path));
    }
    return { stdout: result.stdout, stderr: result.stderr, code: result.code };
  };
}

/**
 * 这个容器挂了哪些卷。
 *
 * 一条挂载要经过两跳：容器的 volumeMounts 指到 Pod 的 volumes 上，
 * volumes 里那一项再指到 PVC，PVC 再指到 PV。任何一跳断了都是「挂上去了，
 * 但里面是空的」—— 而这三跳分别由三个人写（开发、平台、存储），
 * 所以现实里断得很频繁。
 */
function mountsOf(
  pod: KubeObject,
  containerName: string,
  cluster: Cluster
): Array<{ path: string; volume: string }> {
  const spec = (pod.spec ?? {}) as any;
  const container = (spec.containers ?? []).find((item: any) => item.name === containerName);
  const volumes: any[] = spec.volumes ?? [];
  const out: Array<{ path: string; volume: string }> = [];

  for (const mount of container?.volumeMounts ?? []) {
    const volume = volumes.find((item) => item.name === mount.name);
    const claimName = volume?.persistentVolumeClaim?.claimName;
    if (!claimName) continue;
    const claims = cluster.scheme.get({ group: '', version: 'v1', resource: 'persistentvolumeclaims' });
    if (!claims) continue;
    try {
      const claim = cluster.registry.get(claims, pod.metadata.namespace, claimName);
      const volumeName = ((claim.spec ?? {}) as any).volumeName;
      if (volumeName) out.push({ path: normalizeMountPath(mount.mountPath), volume: volumeName });
    } catch {
      // PVC 不在了：挂载点还在，只是下面什么都没有
    }
  }
  return out;
}

/** `/data/` → `/data`，根目录保持 `/` */
function normalizeMountPath(path: string): string {
  const trimmed = (path ?? '/').replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** 卷上的相对路径 → 容器里的绝对路径 */
function prefixed(content: Record<string, string>, mountPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, value] of Object.entries(content)) {
    out[`${mountPath === '/' ? '' : mountPath}/${path.replace(/^\/+/, '')}`] = value;
  }
  return out;
}

/** 容器里的绝对路径 → 卷上的相对路径 */
function stripped(files: Record<string, string>, mountPath: string): Record<string, string> {
  const prefix = mountPath === '/' ? '/' : `${mountPath}/`;
  const out: Record<string, string> = {};
  for (const [path, value] of Object.entries(files)) {
    if (!path.startsWith(prefix)) continue;
    out[path.slice(prefix.length)] = value;
  }
  return out;
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
