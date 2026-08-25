/**
 * 网络工具：curl / dig / nslookup / nc / getent
 *
 * 输出与退出码照抄真命令 —— 学员判断「连不上」是哪一种，靠的就是这几句话：
 *
 *   curl: (6) Could not resolve host: X          名字解析不了
 *   curl: (7) Failed to connect ... Connection refused   端口上没人听
 *   curl: (7) ... No route to host               网段够不到
 *   curl: (28) ... Timeout was reached           包被丢了（策略）
 *
 * 退出码也是真的（6 / 7 / 28 / 22），因为脚本里会拿它当条件。
 */
import type { CommandHandler, CommandResult } from '../machine';
import type { Network } from './network';
import type { Source, Target } from './types';

export interface NetToolsOptions {
  network: Network;
  /** 这台机器在哪个分区、以什么身份发起连接 */
  source: () => Source;
  /** 推进虚拟时钟。超时要真的花掉 30 秒虚拟时间。 */
  advance: (ms: number) => void;
}

export function createNetTools(options: NetToolsOptions): Record<string, CommandHandler> {
  return {
    curl: (context) => curl(context.argv, options),
    dig: (context) => dig(context.argv, options),
    nslookup: (context) => nslookup(context.argv, options),
    nc: (context) => netcat(context.argv, options),
    getent: (context) => getent(context.argv, options),
    ping: (context) => ping(context.argv, options),
  };
}

/* ------------------------------------------------------------------ */

interface CurlFlags {
  silent: boolean;
  headOnly: boolean;
  failOnError: boolean;
  include: boolean;
  writeOut?: string;
  output?: string;
  maxTimeMs?: number;
  url?: string;
  method?: string;
  verbose: boolean;
  /** `-H 'Host: x'` */
  hostHeader?: string;
  /** `--resolve host:port:addr` */
  resolveTo: Array<{ host: string; port: number; address: string }>;
}

function parseCurl(argv: string[]): CurlFlags {
  const flags: CurlFlags = {
    silent: false, headOnly: false, failOnError: false, include: false, verbose: false,
    resolveTo: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '-s': case '--silent': flags.silent = true; break;
      case '-S': case '--show-error': break;
      case '-I': case '--head': flags.headOnly = true; break;
      case '-i': case '--include': flags.include = true; break;
      case '-f': case '--fail': flags.failOnError = true; break;
      case '-v': case '--verbose': flags.verbose = true; break;
      case '-w': case '--write-out': flags.writeOut = argv[++i]; break;
      case '-o': case '--output': flags.output = argv[++i]; break;
      case '-X': case '--request': flags.method = argv[++i]; break;
      case '-m': case '--max-time': flags.maxTimeMs = Number(argv[++i]) * 1000; break;
      case '--connect-timeout': flags.maxTimeMs = Number(argv[++i]) * 1000; break;
      case '-H': case '--header': {
        const header = argv[++i] ?? '';
        const match = /^\s*host\s*:\s*(\S+)\s*$/i.exec(header);
        if (match) flags.hostHeader = match[1];
        break;
      }
      case '--resolve': {
        // host:port:address
        const parts = (argv[++i] ?? '').split(':');
        if (parts.length >= 3) {
          flags.resolveTo.push({ host: parts[0], port: Number(parts[1]), address: parts[2] });
        }
        break;
      }
      case '-k': case '--insecure': break;
      case '-L': case '--location': break;
      default:
        if (arg.startsWith('-s') && /^-[a-zA-Z]+$/.test(arg)) {
          // 合写的短选项，如 -sS
          for (const letter of arg.slice(1)) {
            if (letter === 's') flags.silent = true;
            if (letter === 'S') { /* show-error */ }
            if (letter === 'f') flags.failOnError = true;
            if (letter === 'I') flags.headOnly = true;
            if (letter === 'i') flags.include = true;
            if (letter === 'v') flags.verbose = true;
          }
          break;
        }
        if (!arg.startsWith('-')) flags.url = arg;
    }
  }
  return flags;
}

/** `http://portal.payments.svc.cluster.local:8080/healthz` */
export function parseUrl(raw: string): Target | undefined {
  const text = /^[a-z]+:\/\//.test(raw) ? raw : `http://${raw}`;
  const match = /^([a-z]+):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(text);
  if (!match) return undefined;
  const [, scheme, host, port, path] = match;
  const tls = scheme === 'https';
  return { host, port: port ? Number(port) : tls ? 443 : 80, path: path ?? '/', tls };
}

function curl(argv: string[], options: NetToolsOptions): CommandResult {
  const flags = parseCurl(argv);
  if (!flags.url) {
    return { stderr: 'curl: try \'curl --help\' for more information\n', code: 2 };
  }
  const target = parseUrl(flags.url);
  if (!target) return { stderr: `curl: (3) URL rejected: Bad hostname\n`, code: 3 };
  if (flags.method) target.method = flags.method;
  if (flags.headOnly) target.method = 'HEAD';
  if (flags.hostHeader) target.headerHost = flags.hostHeader;
  const override = flags.resolveTo.find(
    (entry) => entry.host === target.host && entry.port === target.port
  );
  if (override) target.address = override.address;

  const result = options.network.connect(options.source(), target);
  const spent = flags.maxTimeMs !== undefined
    ? Math.min(result.elapsedMs, flags.maxTimeMs)
    : result.elapsedMs;
  options.advance(spent);

  const place = `${target.host} port ${target.port}`;
  const timedOut = result.kind === 'timeout'
    || (flags.maxTimeMs !== undefined && result.elapsedMs > flags.maxTimeMs);

  if (timedOut) {
    return {
      stderr: `curl: (28) Failed to connect to ${place} after ${Math.round(spent)} ms: Timeout was reached\n`,
      code: 28,
    };
  }
  switch (result.kind) {
    case 'dns-failure':
      return { stderr: `curl: (6) Could not resolve host: ${target.host}\n`, code: 6 };
    case 'no-route':
      return {
        stderr: `curl: (7) Failed to connect to ${place} after ${Math.round(spent)} ms: No route to host\n`,
        code: 7,
      };
    case 'refused':
      return {
        stderr: `curl: (7) Failed to connect to ${place} after ${Math.round(spent)} ms: Connection refused\n`,
        code: 7,
      };
    case 'reset':
      return { stderr: `curl: (56) Recv failure: Connection reset by peer\n`, code: 56 };
    default:
      break;
  }

  const status = result.status ?? 200;
  if (flags.failOnError && status >= 400) {
    return {
      stderr: `curl: (22) The requested URL returned error: ${status}\n`,
      code: 22,
    };
  }

  const headers = [
    `HTTP/1.1 ${status} ${reasonOf(status)}`,
    'content-type: text/plain',
    '',
    '',
  ].join('\r\n');
  const body = flags.headOnly ? '' : result.body ?? '';
  let stdout = flags.include || flags.headOnly ? headers + body : body;
  if (flags.output === '/dev/null') stdout = '';
  if (flags.writeOut) stdout += renderWriteOut(flags.writeOut, status, spent);

  return { stdout, code: 0 };
}

/** `-w '%{http_code}'` 这类 */
function renderWriteOut(format: string, status: number, elapsedMs: number): string {
  return format
    .replace(/%\{http_code\}/g, String(status))
    .replace(/%\{time_total\}/g, (elapsedMs / 1000).toFixed(6))
    .replace(/\\n/g, '\n');
}

function reasonOf(status: number): string {
  const reasons: Record<number, string> = {
    200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently',
    400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
    500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
  };
  return reasons[status] ?? '';
}

/* ------------------------------------------------------------------ */

function dig(argv: string[], options: NetToolsOptions): CommandResult {
  const short = argv.includes('+short');
  const name = argv.find((arg) => !arg.startsWith('+') && !arg.startsWith('-') && !arg.startsWith('@'));
  if (!name) return { stderr: 'dig: no name given\n', code: 1 };

  const answer = options.network.resolve(name, options.source());
  options.advance(2);

  if (short) {
    return { stdout: answer.addresses.map((ip) => `${ip}\n`).join(''), code: 0 };
  }

  const found = answer.addresses.length > 0;
  const lines = [
    '',
    `; <<>> DiG 9.20.4 <<>> ${name}`,
    ';; global options: +cmd',
    ';; Got answer:',
    `;; ->>HEADER<<- opcode: QUERY, status: ${found ? 'NOERROR' : 'NXDOMAIN'}, id: 1`,
    `;; flags: qr aa rd ra; QUERY: 1, ANSWER: ${answer.addresses.length}, AUTHORITY: 0, ADDITIONAL: 0`,
    '',
    ';; QUESTION SECTION:',
    `;${answer.canonical ?? name}.\t\t\tIN\tA`,
    '',
  ];
  if (found) {
    lines.push(';; ANSWER SECTION:');
    for (const ip of answer.addresses) lines.push(`${answer.canonical}.\t30\tIN\tA\t${ip}`);
    lines.push('');
  }
  lines.push(';; SERVER: 10.96.0.10#53(10.96.0.10)', '');
  return { stdout: lines.join('\n'), code: found ? 0 : 9 };
}

function nslookup(argv: string[], options: NetToolsOptions): CommandResult {
  const name = argv.find((arg) => !arg.startsWith('-'));
  if (!name) return { stderr: 'nslookup: no name given\n', code: 1 };
  const answer = options.network.resolve(name, options.source());
  options.advance(2);

  if (answer.addresses.length === 0) {
    return {
      stdout: 'Server:\t\t10.96.0.10\nAddress:\t10.96.0.10#53\n\n',
      stderr: `** server can't find ${name}: NXDOMAIN\n`,
      code: 1,
    };
  }
  const lines = ['Server:\t\t10.96.0.10', 'Address:\t10.96.0.10#53', '', 'Name:\t' + answer.canonical];
  for (const ip of answer.addresses) lines.push(`Address: ${ip}`);
  lines.push('');
  return { stdout: lines.join('\n'), code: 0 };
}

function getent(argv: string[], options: NetToolsOptions): CommandResult {
  if (argv[0] !== 'hosts' && argv[0] !== 'ahostsv4') {
    return { stderr: `getent: Unknown database: ${argv[0] ?? ''}\n`, code: 2 };
  }
  const name = argv[1];
  if (!name) return { code: 2 };
  const answer = options.network.resolve(name, options.source());
  options.advance(2);
  if (answer.addresses.length === 0) return { code: 2 };
  return {
    stdout: answer.addresses.map((ip) => `${ip}       ${answer.canonical ?? name}\n`).join(''),
    code: 0,
  };
}

function netcat(argv: string[], options: NetToolsOptions): CommandResult {
  // `-w` 后面那个数字是超时秒数，不是位置参数 —— 不跳过它，
  // `nc -z host 80 -w 2` 会被解析成连 80 的 2 端口
  const values: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '-w' || argv[i] === '-p' || argv[i] === '-s') { i += 1; continue; }
    if (!argv[i].startsWith('-')) values.push(argv[i]);
  }
  const port = Number(values[1] ?? values[values.length - 1]);
  const host = values[0];
  if (!host || !Number.isFinite(port)) {
    return { stderr: 'nc: missing hostname and port\n', code: 1 };
  }
  const waitIndex = argv.indexOf('-w');
  const waitMs = waitIndex >= 0 ? Number(argv[waitIndex + 1]) * 1000 : undefined;

  const result = options.network.connect(options.source(), { host, port });
  const spent = waitMs !== undefined ? Math.min(result.elapsedMs, waitMs) : result.elapsedMs;
  options.advance(spent);

  const timedOut = result.kind === 'timeout' || (waitMs !== undefined && result.elapsedMs > waitMs);
  if (timedOut) return { stderr: `nc: connect to ${host} port ${port} (tcp) timed out\n`, code: 1 };
  if (result.kind === 'dns-failure') {
    return { stderr: `nc: getaddrinfo for host "${host}" port ${port}: Name or service not known\n`, code: 1 };
  }
  if (result.kind !== 'ok') {
    const reason = result.kind === 'refused' ? 'Connection refused' : 'No route to host';
    return { stderr: `nc: connect to ${host} port ${port} (tcp) failed: ${reason}\n`, code: 1 };
  }
  return { stderr: `Connection to ${host} ${port} port [tcp/*] succeeded!\n`, code: 0 };
}

function ping(argv: string[], options: NetToolsOptions): CommandResult {
  const host = argv.find((arg) => !arg.startsWith('-'));
  if (!host) return { stderr: 'ping: usage error: Destination address required\n', code: 2 };
  const answer = options.network.resolve(host, options.source());
  options.advance(2);
  if (answer.addresses.length === 0) {
    return { stderr: `ping: ${host}: Name or service not known\n`, code: 2 };
  }
  /**
   * ICMP 不做。
   *
   * 说清楚比假装能 ping 更有用：集群里绝大多数「ping 不通」都不说明问题
   * （ClusterIP 本来就不回 ICMP），学员该用的是 curl 或 nc。
   */
  return {
    stdout: `PING ${host} (${answer.addresses[0]}): 56 data bytes\n`,
    stderr: 'ping: ICMP 不在 opslab 的模拟范围内（ClusterIP 本来也不回 ICMP）。'
      + '测连通性请用 `curl` 或 `nc -z`。\n',
    code: 2,
  };
}
