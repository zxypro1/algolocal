/**
 * 把真 CLI 装到虚拟机器上
 *
 * 装完之后 `kubectl` 就是这台机器上一个普通命令：能被管道串起来、
 * 能重定向、能写在脚本里 —— 因为它走的是同一个 shell 派发路径。
 * 它读的 kubeconfig、`-f` 指到的 manifest，也和 IDE 编辑的是同一棵树。
 */
import { Machine } from '../machine/machine';
import { CliRuntime, CliRunOptions, FetchLike } from './runtime';
import { DEFAULT_KUBECONFIG_PATH, KubeconfigSpec, defaultKubeconfig, renderKubeconfig } from './kubeconfig';

export interface InstallCliOptions {
  machine: Machine;
  runtime: CliRuntime;
  /** client-go 的请求打到哪 —— 通常是 cluster.apiServer.handle */
  apiServer: { handle: (url: string, init?: never) => Promise<Response> };
  /** 装哪些 applet。不传就问二进制本人。 */
  applets?: string[];
  /** 不传就写一份单集群的默认配置 */
  kubeconfig?: KubeconfigSpec | false;
  kubeconfigPath?: string;
  now?: () => number;
}

export async function installClusterCli(options: InstallCliOptions): Promise<string[]> {
  const { machine, runtime } = options;
  const path = options.kubeconfigPath ?? DEFAULT_KUBECONFIG_PATH;

  if (options.kubeconfig !== false) {
    machine.vfs.writeFile(path, renderKubeconfig(options.kubeconfig ?? defaultKubeconfig()));
  }

  const fetchImpl: FetchLike = (url, init) => options.apiServer.handle(url, init as never);
  const applets = options.applets ?? (await runtime.applets());

  for (const applet of applets) {
    machine.install(applet, async ({ argv, stdin, cwd, env, vfs }) => {
      const run: CliRunOptions = {
        vfs, cwd, stdin,
        env: { KUBECONFIG: path, ...env },
        fetch: fetchImpl,
        now: options.now,
      };
      const result = await runtime.run(applet, argv, run);
      return { stdout: result.stdout, stderr: result.stderr, code: result.code };
    });
  }

  return applets;
}
