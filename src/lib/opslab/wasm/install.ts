/**
 * 把真 CLI 装到虚拟机器上
 *
 * 装完之后 `kubectl` 就是这台机器上一个普通命令：能被管道串起来、
 * 能重定向、能写在脚本里 —— 因为它走的是同一个 shell 派发路径。
 * 它读的 kubeconfig、`-f` 指到的 manifest，也和 IDE 编辑的是同一棵树。
 */
import { Machine } from '../machine/machine';
import { CliRuntime, CliRunOptions, FetchLike } from './runtime';
import type { StreamServer, UpgradeRequest } from '../net/websocket';
import { DEFAULT_KUBECONFIG_PATH, KubeconfigSpec, defaultKubeconfig, renderKubeconfig } from './kubeconfig';

export interface InstallCliOptions {
  machine: Machine;
  runtime: CliRuntime;
  /**
   * client-go 的请求打到哪 —— 通常是 cluster.apiServer。
   *
   * `handle` 走普通请求，`openStream` 走 `kubectl exec` 那条 WebSocket。
   */
  apiServer: {
    handle: (url: string, init?: never) => Promise<Response>;
    openStream?: (request: UpgradeRequest) => ReturnType<StreamServer['open']>;
  };
  /** 装哪些 applet。不传就问二进制本人。 */
  applets?: string[];
  /** 不传就写一份单集群的默认配置；已经有配置文件时用 false 保留它 */
  kubeconfig?: KubeconfigSpec | false;
  kubeconfigPath?: string;
  /**
   * 哪些主机名解析得到 apiserver。
   *
   * 不限制的话，kubeconfig 里写错的 server 也能连上 —— 而「context 选错了、
   * 连的是另一个集群」正是第 1 关要教的东西。不在这个名单里的主机，
   * 表现和真实的 DNS 失败一样。
   */
  endpoints?: string[];
  now?: () => number;
}

/** kubeconfig 里的 server 是完整 URL，取出主机名（不含端口） */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url, 'https://apiserver.opslab').hostname;
  } catch {
    return undefined;
  }
}

export async function installClusterCli(options: InstallCliOptions): Promise<string[]> {
  const { machine, runtime } = options;
  const path = options.kubeconfigPath ?? DEFAULT_KUBECONFIG_PATH;

  // 世界自己铺过 kubeconfig 就别覆盖 —— 那份多半是关卡精心写歪的
  if (options.kubeconfig !== false && !machine.vfs.exists(path)) {
    machine.vfs.writeFile(path, renderKubeconfig(options.kubeconfig ?? defaultKubeconfig()));
  }

  const endpoints = options.endpoints ?? ['apiserver.opslab'];
  const fetchImpl: FetchLike = (url, init) => {
    const host = hostOf(url);
    if (host && !endpoints.includes(host)) {
      // fetch 在 DNS 失败时抛的就是 TypeError，client-go 那边会翻成
      // 「Unable to connect to the server」
      return Promise.reject(new TypeError(`dial tcp: lookup ${host}: no such host`));
    }
    return options.apiServer.handle(url, init as never);
  };
  /**
   * exec 的通道。
   *
   * gorilla dial 的是 `host:port`，主机名这一关和 fetch 那边同一套判断 ——
   * 不然 context 选错集群时，普通命令连不上而 exec 却能连上。
   */
  const stream: StreamServer | undefined = options.apiServer.openStream
    ? { open: (request) => options.apiServer.openStream!(request) }
    : undefined;
  const dial = (address: string) => {
    const host = address.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return endpoints.includes(host) ? stream : undefined;
  };

  const applets = options.applets ?? (await runtime.applets());

  for (const applet of applets) {
    machine.install(applet, async ({ argv, stdin, cwd, env, vfs }) => {
      const run: CliRunOptions = {
        vfs, cwd, stdin,
        env: { KUBECONFIG: path, ...env },
        fetch: fetchImpl,
        dial,
        now: options.now,
      };
      const result = await runtime.run(applet, argv, run);
      return { stdout: result.stdout, stderr: result.stderr, code: result.code };
    });
  }

  return applets;
}
