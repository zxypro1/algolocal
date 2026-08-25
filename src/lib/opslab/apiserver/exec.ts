/**
 * `kubectl exec` 的服务端
 *
 * 走的是 k8s 的通道协议（`v5.channel.k8s.io`）：WebSocket 上的每一帧，
 * 第一个字节是通道号，剩下是数据。
 *
 *   0 stdin   1 stdout   2 stderr   3 error（一个 metav1.Status 的 JSON）
 *   4 resize  255 close
 *
 * 退出码走的是 3 号通道里的 Status —— 不是 HTTP 状态码。所以
 * `kubectl exec ... && echo ok` 这种写法能不能对，全看这一段。
 */
import type { StreamSession, UpgradeRequest } from '../net';
import { OPCODE } from '../net';

export const CHANNEL = { STDIN: 0, STDOUT: 1, STDERR: 2, ERROR: 3, RESIZE: 4, CLOSE: 255 } as const;
export const EXEC_PROTOCOL = 'v5.channel.k8s.io';

export interface ExecRequest {
  namespace: string;
  pod: string;
  container?: string;
  command: string[];
  stdin: boolean;
  tty: boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type ExecHandler = (request: ExecRequest, stdin: string) => Promise<ExecResult>;

/** 从 `/api/v1/namespaces/x/pods/y/exec?command=...&stdout=true` 解出请求 */
export function parseExecRequest(request: UpgradeRequest): ExecRequest | undefined {
  const match = /^\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)\/exec/.exec(request.path);
  if (!match) return undefined;
  const query = new URLSearchParams(request.path.split('?')[1] ?? '');
  return {
    namespace: match[1],
    pod: decodeURIComponent(match[2]),
    container: query.get('container') ?? undefined,
    command: query.getAll('command'),
    stdin: query.get('stdin') === 'true',
    tty: query.get('tty') === 'true',
  };
}

/**
 * 一次 exec 会话。
 *
 * 命令是异步跑的（里面可能有 curl，要等虚拟时钟推进），跑完把 stdout/stderr
 * 分通道写回去，最后在 3 号通道上写一个 Status 表示退出码，再关掉连接。
 */
export function createExecSession(request: ExecRequest, handler: ExecHandler): StreamSession {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let stdin = '';
  let launch: (() => void) | undefined;

  return {
    protocol: EXEC_PROTOCOL,

    onFrame(opcode, payload) {
      if (opcode !== OPCODE.BINARY || payload.length === 0) return;
      if (payload[0] === CHANNEL.STDIN) stdin += decoder.decode(payload.subarray(1));
      /**
       * 255 通道是 v5 加的「某条流关了」。
       *
       * `-i` 的时候要等 stdin 关掉才开跑：我们的命令是一次性执行的，
       * 提前跑就等于把 stdin 当成空的 —— `kubectl exec -i pod -- cat`
       * 会静默输出空，比报错还难查。
       */
      if (payload[0] === CHANNEL.CLOSE && payload[1] === CHANNEL.STDIN) {
        const start = launch;
        launch = undefined;
        start?.();
      }
    },

    start(send, close) {
      const write = (channel: number, text: string) => {
        if (!text) return;
        const body = encoder.encode(text);
        const frame = new Uint8Array(body.length + 1);
        frame[0] = channel;
        frame.set(body, 1);
        send(OPCODE.BINARY, frame);
      };

      const run = async () => {
        let result: ExecResult;
        try {
          result = await handler(request, stdin);
        } catch (error) {
          result = { stdout: '', stderr: `${(error as Error).message}\n`, code: 1 };
        }
        write(CHANNEL.STDOUT, result.stdout);
        write(CHANNEL.STDERR, result.stderr);
        write(CHANNEL.ERROR, JSON.stringify(statusOf(result.code, request)));
        close();
      };

      // 不带 -i 时没人会送 stdin，等一个微任务批次就开跑
      if (request.stdin) launch = () => { void run(); };
      else void Promise.resolve().then(run);
    },

    onClose() {
      // 连接先断了：stdin 不会再来了，别把会话晾在那儿
      launch = undefined;
    },
  };
}

/**
 * 3 号通道上那个 Status。
 *
 * 成功是 `status: Success`；失败要带上 `reason: NonZeroExitCode` 与
 * `ExitCode` 这个 cause，kubectl 就是从这里取退出码的。少一个字段，
 * `kubectl exec ... ; echo $?` 就永远是 0。
 */
export function statusOf(code: number, request: ExecRequest): unknown {
  if (code === 0) {
    return { metadata: {}, status: 'Success' };
  }
  return {
    metadata: {},
    status: 'Failure',
    message: `command terminated with exit code ${code}`,
    reason: 'NonZeroExitCode',
    details: {
      causes: [
        { reason: 'ExitCode', message: String(code) },
        { reason: 'Command', message: request.command.join(' ') },
      ],
    },
  };
}
