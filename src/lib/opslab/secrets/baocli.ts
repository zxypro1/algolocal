/**
 * `bao`
 *
 * OpenBao 的 CLI。只做 KV v2 与状态查询 —— 集群这边的活由 ESO 干，
 * 人用 CLI 主要是往里放东西、以及确认自己放对了地方。
 *
 * `BAO_ADDR` 与 `BAO_TOKEN` 两个环境变量的行为和真 CLI 一致：不设地址就报
 * 连不上，不设令牌就是 permission denied。这两个错很常见，值得原样保留。
 */
import type { CommandHandler, CommandResult } from '../machine/shell/shell';
import type { OpenBao } from './openbao';

export interface BaoCliOptions {
  server(address: string): OpenBao | undefined;
}

export function createBaoCommand(options: BaoCliOptions): CommandHandler {
  return ({ argv, env }) => {
    const address = env.BAO_ADDR ?? env.VAULT_ADDR;
    const token = env.BAO_TOKEN ?? env.VAULT_TOKEN;
    const [command, ...rest] = argv;

    if (command === 'version' || command === '--version') {
      return { stdout: 'OpenBao v2.4.1\n' };
    }
    if (!command) return { stdout: USAGE };

    if (!address) {
      return {
        stderr: 'Error checking seal status: Get "/v1/sys/seal-status": '
          + 'unsupported protocol scheme ""\n\n'
          + 'BAO_ADDR 没设。先 export BAO_ADDR=https://<host>:8200\n',
        code: 2,
      };
    }
    const server = options.server(address);
    if (!server) {
      return {
        stderr: `Error making API request.\n\nURL: GET ${address}/v1/sys/seal-status\n`
          + `Code: -1. Errors:\n\n* dial tcp: lookup ${hostOf(address)}: no such host\n`,
        code: 2,
      };
    }

    if (command === 'status') {
      return {
        stdout: [
          'Key             Value',
          '---             -----',
          'Seal Type       shamir',
          'Initialized     true',
          'Sealed          false',
          'Storage Type    raft',
          'Version         2.4.1',
          `Cluster Name    ${hostOf(address)}`,
          '',
        ].join('\n'),
      };
    }

    if (!token) {
      return {
        stderr: 'Error making API request.\n\nCode: 400. Errors:\n\n* missing client token\n',
        code: 2,
      };
    }
    if (!server.policyOf(token)) {
      return {
        stderr: 'Error making API request.\n\nCode: 403. Errors:\n\n* permission denied\n',
        code: 2,
      };
    }

    if (command === 'kv') return kv(server, token, rest);
    if (command === 'auth') return auth(server, token, rest);
    if (command === 'write') return write(server, token, rest);
    if (command === 'read') return read(server, token, rest);

    return { stderr: `Unknown command: ${command}\n${USAGE}`, code: 1 };
  };
}

const USAGE = `Usage: bao <command> [args]

Common commands:
    status     Print seal and HA status
    kv         Interact with the key/value store
    auth       Interact with auth methods
    read       Read data from OpenBao
    write      Write data, configuration, and secrets
`;

/**
 * `bao auth enable kubernetes`
 *
 * 开了这个方法，集群里的工作负载才能拿自己的 ServiceAccount 换令牌 ——
 * 不用再保管一把长期有效的静态令牌。
 */
function auth(server: OpenBao, token: string, argv: string[]): CommandResult {
  const [action, ...rest] = argv;
  const positional = rest.filter((entry) => !entry.startsWith('-'));
  if (action === 'list') {
    return {
      stdout: [
        'Path           Type          Description',
        '----           ----          -----------',
        'token/         token         token based credentials',
        ...(server.kubernetesAuthEnabled
          ? ['kubernetes/    kubernetes    n/a']
          : []),
        '',
      ].join('\n'),
    };
  }
  if (action !== 'enable') return { stderr: `Unknown auth subcommand: ${action ?? ''}\n`, code: 1 };
  if (server.policyOf(token) !== 'root') {
    return { stderr: denied('sys/auth').stderr, code: 2 };
  }
  if (positional[0] !== 'kubernetes') {
    return { stderr: `Error enabling ${positional[0] ?? ''}: 这个世界只做了 kubernetes 认证\n`, code: 1 };
  }
  server.enableKubernetesAuth();
  return { stdout: 'Success! Enabled kubernetes auth method at: kubernetes/\n' };
}

/**
 * `bao write auth/kubernetes/role/<name> ...`
 *
 * 角色说的是「哪些 ServiceAccount 能登录、登录后拿哪个策略」。
 * 三个参数里最容易写错的是命名空间那个：漏了它，谁都登不进来。
 */
function write(server: OpenBao, token: string, argv: string[]): CommandResult {
  const positional = argv.filter((entry) => !entry.startsWith('-'));
  const path = positional[0] ?? '';
  const match = /^auth\/kubernetes\/role\/(.+)$/.exec(path);
  if (!match) {
    return { stderr: `Error writing data to ${path}: 这个世界只做了 auth/kubernetes/role/<name>\n`, code: 2 };
  }
  if (server.policyOf(token) !== 'root') return denied(path);
  if (!server.kubernetesAuthEnabled) {
    return {
      stderr: `Error writing data to ${path}: Error making API request.\n\n`
        + 'Code: 404. Errors:\n\n* no handler for route "auth/kubernetes/role". '
        + '先 bao auth enable kubernetes\n',
      code: 2,
    };
  }

  const fields: Record<string, string> = {};
  for (const entry of positional.slice(1)) {
    const index = entry.indexOf('=');
    if (index > 0) fields[entry.slice(0, index)] = entry.slice(index + 1);
  }
  const names = split(fields.bound_service_account_names);
  const namespaces = split(fields.bound_service_account_namespaces);
  const policy = split(fields.policies)[0];
  if (names.length === 0 || namespaces.length === 0 || !policy) {
    return {
      stderr: `Error writing data to ${path}: bound_service_account_names、`
        + 'bound_service_account_namespaces、policies 三个都要给\n',
      code: 2,
    };
  }
  if (!server.hasPolicy(policy) && policy !== 'root') {
    return { stderr: `Error writing data to ${path}: policy "${policy}" does not exist\n`, code: 2 };
  }

  const bound = namespaces.flatMap((namespace) => names.map((name) => `${namespace}/${name}`));
  server.addKubernetesRole(match[1], { boundServiceAccounts: bound, policy });
  return { stdout: `Success! Data written to: ${path}\n` };
}

function read(server: OpenBao, token: string, argv: string[]): CommandResult {
  const path = argv.filter((entry) => !entry.startsWith('-'))[0] ?? '';
  const match = /^auth\/kubernetes\/role\/(.+)$/.exec(path);
  if (!match) return { stderr: `No value found at ${path}\n`, code: 2 };
  if (server.policyOf(token) !== 'root') return denied(path);
  const role = server.kubernetesRole(match[1]);
  if (!role) return { stderr: `No value found at ${path}\n`, code: 2 };
  return {
    stdout: [
      '====== Data ======',
      'Key                                 Value',
      '---                                 -----',
      `bound_service_account_names         [${role.boundServiceAccounts.map((entry) => entry.split('/')[1]).join(' ')}]`,
      `bound_service_account_namespaces    [${[...new Set(role.boundServiceAccounts.map((entry) => entry.split('/')[0]))].join(' ')}]`,
      `policies                            [${role.policy}]`,
      '',
    ].join('\n'),
  };
}

function split(value: string | undefined): string[] {
  return (value ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
}

function kv(server: OpenBao, token: string, argv: string[]): CommandResult {
  const [action, ...rest] = argv;
  const positional = rest.filter((entry) => !entry.startsWith('-'));
  const path = positional[0];

  if (action === 'put') {
    if (!path) return { stderr: 'Error: a path is required\n', code: 1 };
    if (!server.allows(token, path, 'create') && !server.allows(token, path, 'update')) {
      return denied(path);
    }
    const data: Record<string, string> = {};
    for (const entry of positional.slice(1)) {
      const index = entry.indexOf('=');
      if (index > 0) data[entry.slice(0, index)] = entry.slice(index + 1);
    }
    const version = server.write(path, data);
    return { stdout: versionTable(path, version) };
  }

  if (action === 'get') {
    if (!path) return { stderr: 'Error: a path is required\n', code: 1 };
    if (!server.allows(token, path, 'read')) return denied(path);
    const data = server.read(path);
    if (!data) return { stderr: `No value found at ${path}\n`, code: 2 };
    const field = flag(rest, '-field');
    if (field) {
      return data[field] === undefined
        ? { stderr: `Error: field "${field}" not present in secret\n`, code: 1 }
        : { stdout: `${data[field]}\n` };
    }
    const rows = Object.entries(data).sort(([a], [b]) => (a < b ? -1 : 1));
    const width = Math.max(4, ...rows.map(([key]) => key.length));
    return {
      stdout: [
        `====== Data ======`,
        `${'Key'.padEnd(width)}    Value`,
        `${'---'.padEnd(width)}    -----`,
        ...rows.map(([key, value]) => `${key.padEnd(width)}    ${value}`),
        '',
      ].join('\n'),
    };
  }

  if (action === 'list') {
    const prefix = path ?? '';
    if (!server.allows(token, `${prefix}/`, 'list')) return denied(prefix);
    const keys = server.list(prefix);
    return { stdout: keys.length ? `Keys\n----\n${keys.join('\n')}\n` : `No value found at ${prefix}\n` };
  }

  return { stderr: `Unknown kv subcommand: ${action ?? ''}\n`, code: 1 };
}

function denied(path: string): CommandResult {
  return {
    stderr: `Error making API request.\n\nCode: 403. Errors:\n\n`
      + `* 1 error occurred:\n\t* permission denied on ${path}\n\n`,
    code: 2,
  };
}

function versionTable(path: string, version: number): string {
  return [
    `====== Secret Path ======`,
    `${path}/data`,
    '',
    '======= Metadata =======',
    'Key                Value',
    '---                -----',
    'created_time       2026-03-02T09:00:00Z',
    'deletion_time      n/a',
    'destroyed          false',
    `version            ${version}`,
    '',
  ].join('\n');
}

function flag(argv: string[], name: string): string | undefined {
  const inline = argv.find((entry) => entry.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function hostOf(address: string): string {
  return address.replace(/^[a-z]+:\/\//, '').split(/[:/]/)[0];
}
