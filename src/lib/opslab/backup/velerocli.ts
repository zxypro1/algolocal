/**
 * `velero`
 *
 * 这个 CLI 本质上是 `kubectl apply` 的壳：`velero backup create` 就是建一个
 * Backup 对象，`velero restore create` 就是建一个 Restore。做出来是因为
 * 真人在真集群里用的就是它，而且 `velero backup describe` 打出来的那几行
 * （尤其是 warnings 和 volume snapshots 的计数）正是这一关要学员看懂的东西。
 */
import type { CommandHandler, CommandResult } from '../../labkit/machine/shell/shell';
import type { KubeObject, Registry, Scheme } from '../apiserver';
import { BACKUPS, BACKUPSTORAGELOCATIONS, RESTORES } from './velero';

export interface VeleroCliOptions {
  registry: Registry;
  scheme: Scheme;
  /** 建完对象之后让世界往前走一会儿，不然 create 完立刻 get 什么都没有 */
  settle: () => void;
  namespace?: string;
}

const USAGE = [
  'Velero is a tool for managing disaster recovery, specifically for Kubernetes',
  'cluster resources.',
  '',
  'Usage:',
  '  velero backup create NAME [flags]',
  '  velero backup get',
  '  velero backup describe NAME',
  '  velero restore create NAME --from-backup BACKUP [flags]',
  '  velero restore get',
  '  velero restore describe NAME',
  '  velero backup-location get',
  '',
].join('\n');

export function createVeleroCommand(options: VeleroCliOptions): CommandHandler {
  return ({ argv }) => {
    const [group, ...rest] = argv;
    if (!group || group === 'help' || group === '--help') return { stdout: USAGE };
    if (group === 'version' || group === '--version') {
      return { stdout: 'Client:\n\tVersion: v1.16.1\n' };
    }
    if (group === 'backup') return backup(rest, options);
    if (group === 'restore') return restore(rest, options);
    if (group === 'backup-location') return locations(rest, options);
    return { stderr: `Error: unknown command "${group}" for "velero"\n`, code: 1 };
  };
}

/** `--flag value` 和 `--flag=value` 都要认 */
function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith('--')) { positional.push(entry); continue; }
    const equals = entry.indexOf('=');
    if (equals >= 0) {
      flags[entry.slice(2, equals)] = entry.slice(equals + 1);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[entry.slice(2)] = next;
      index += 1;
    } else {
      flags[entry.slice(2)] = 'true';
    }
  }
  return { positional, flags };
}

const list = (value: string | undefined): string[] | undefined =>
  value === undefined ? undefined : value.split(',').map((entry) => entry.trim()).filter(Boolean);

function backup(argv: string[], options: VeleroCliOptions): CommandResult {
  const [action, ...rest] = argv;
  const { positional, flags } = parseFlags(rest);
  const namespace = options.namespace ?? 'velero';

  if (action === 'create') {
    const name = positional[0];
    if (!name) return { stderr: 'Error: accepts 1 arg(s), received 0\n', code: 1 };
    const spec: Record<string, unknown> = {
      storageLocation: flags['storage-location'] ?? 'default',
      includedNamespaces: list(flags['include-namespaces']) ?? ['*'],
      ttl: flags.ttl,
    };
    if (flags['exclude-namespaces']) spec.excludedNamespaces = list(flags['exclude-namespaces']);
    if (flags['include-resources']) spec.includedResources = list(flags['include-resources']);
    if (flags['exclude-resources']) spec.excludedResources = list(flags['exclude-resources']);
    if (flags['snapshot-volumes'] === 'false') spec.snapshotVolumes = false;
    if (flags['snapshot-volumes'] === 'true') spec.snapshotVolumes = true;
    if (flags.selector) {
      spec.labelSelector = {
        matchLabels: Object.fromEntries(
          flags.selector.split(',').map((pair) => pair.split('=').map((part) => part.trim()) as [string, string])
        ),
      };
    }
    if (spec.ttl === undefined) delete spec.ttl;

    try {
      options.registry.create(BACKUPS, namespace, {
        apiVersion: 'velero.io/v1', kind: 'Backup',
        metadata: { name, namespace }, spec,
      } as KubeObject);
    } catch (error) {
      return { stderr: `Error: ${(error as Error).message}\n`, code: 1 };
    }
    options.settle();
    return {
      stdout: `Backup request "${name}" submitted successfully.\n`
        + 'Run `velero backup describe ' + name + '` or `velero backup logs ' + name + '` for more details.\n',
    };
  }

  if (action === 'get') {
    const items = options.registry.list(BACKUPS, { namespace }).items;
    if (items.length === 0) return { stdout: 'No backups found.\n' };
    const rows = items.map((item) => {
      const status = (item.status ?? {}) as any;
      return [
        item.metadata.name!, status.phase ?? 'New',
        String(status.errors ?? 0), String(status.warnings ?? 0),
        status.expiration ?? '<none>',
        ((item.spec ?? {}) as any).storageLocation ?? 'default',
      ];
    });
    return { stdout: table(['NAME', 'STATUS', 'ERRORS', 'WARNINGS', 'EXPIRES', 'STORAGE LOCATION'], rows) };
  }

  if (action === 'describe') {
    const name = positional[0];
    if (!name) return { stderr: 'Error: accepts 1 arg(s), received 0\n', code: 1 };
    let item: KubeObject;
    try {
      item = options.registry.get(BACKUPS, namespace, name);
    } catch {
      return { stderr: `Error: backups.velero.io "${name}" not found\n`, code: 1 };
    }
    const spec = (item.spec ?? {}) as any;
    const status = (item.status ?? {}) as any;
    const lines = [
      `Name:         ${name}`,
      `Namespace:    ${namespace}`,
      '',
      `Phase:  ${status.phase ?? 'New'}`,
      ...(status.failureReason ? [`Failure:  ${status.failureReason}`] : []),
      '',
      ...(status.warnings ? [`Warnings:  ${status.warnings}`, ''] : []),
      'Namespaces:',
      `  Included:  ${(spec.includedNamespaces ?? ['*']).join(', ')}`,
      `  Excluded:  ${(spec.excludedNamespaces ?? ['<none>']).join(', ')}`,
      '',
      `Storage Location:  ${spec.storageLocation ?? 'default'}`,
      '',
      `Velero-Native Snapshot PVs:  ${spec.snapshotVolumes === false ? 'false' : 'auto'}`,
      '',
      'CSI Snapshots:',
      `  Attempted:  ${status.volumeSnapshotsAttempted ?? 0}`,
      `  Completed:  ${status.volumeSnapshotsCompleted ?? 0}`,
      '',
      `TTL:  ${spec.ttl ?? '720h0m0s'}`,
      '',
    ];
    return { stdout: `${lines.join('\n')}\n` };
  }

  return { stdout: USAGE, code: 1 };
}

function restore(argv: string[], options: VeleroCliOptions): CommandResult {
  const [action, ...rest] = argv;
  const { positional, flags } = parseFlags(rest);
  const namespace = options.namespace ?? 'velero';

  if (action === 'create') {
    const backupName = flags['from-backup'];
    if (!backupName) {
      return { stderr: 'Error: either a backup or schedule must be specified, but not both\n', code: 1 };
    }
    const name = positional[0] ?? `${backupName}-restore`;
    const spec: Record<string, unknown> = { backupName };
    if (flags['include-namespaces']) spec.includedNamespaces = list(flags['include-namespaces']);
    if (flags['namespace-mappings']) {
      spec.namespaceMapping = Object.fromEntries(
        flags['namespace-mappings'].split(',')
          .map((pair) => pair.split(':').map((part) => part.trim()) as [string, string])
      );
    }
    try {
      options.registry.create(RESTORES, namespace, {
        apiVersion: 'velero.io/v1', kind: 'Restore',
        metadata: { name, namespace }, spec,
      } as KubeObject);
    } catch (error) {
      return { stderr: `Error: ${(error as Error).message}\n`, code: 1 };
    }
    options.settle();
    return {
      stdout: `Restore request "${name}" submitted successfully.\n`
        + 'Run `velero restore describe ' + name + '` for more details.\n',
    };
  }

  if (action === 'get') {
    const items = options.registry.list(RESTORES, { namespace }).items;
    if (items.length === 0) return { stdout: 'No restores found.\n' };
    const rows = items.map((item) => {
      const status = (item.status ?? {}) as any;
      return [
        item.metadata.name!,
        ((item.spec ?? {}) as any).backupName ?? '',
        status.phase ?? 'New',
        String(status.errors ?? 0), String(status.warnings ?? 0),
      ];
    });
    return { stdout: table(['NAME', 'BACKUP', 'STATUS', 'ERRORS', 'WARNINGS'], rows) };
  }

  if (action === 'describe') {
    const name = positional[0];
    let item: KubeObject;
    try {
      item = options.registry.get(RESTORES, namespace, name ?? '');
    } catch {
      return { stderr: `Error: restores.velero.io "${name}" not found\n`, code: 1 };
    }
    const spec = (item.spec ?? {}) as any;
    const status = (item.status ?? {}) as any;
    return {
      stdout: [
        `Name:         ${name}`,
        `Namespace:    ${namespace}`,
        '',
        `Phase:  ${status.phase ?? 'New'}`,
        ...(status.failureReason ? [`Failure:  ${status.failureReason}`] : []),
        `Backup:  ${spec.backupName}`,
        '',
        `Warnings:  ${status.warnings ?? 0}`,
        `Errors:    ${status.errors ?? 0}`,
        '',
      ].join('\n') + '\n',
    };
  }

  return { stdout: USAGE, code: 1 };
}

function locations(argv: string[], options: VeleroCliOptions): CommandResult {
  if (argv[0] !== 'get') return { stdout: USAGE, code: 1 };
  const namespace = options.namespace ?? 'velero';
  const items = options.registry.list(BACKUPSTORAGELOCATIONS, { namespace }).items;
  if (items.length === 0) return { stdout: 'No backup storage locations found.\n' };
  const rows = items.map((item) => {
    const spec = (item.spec ?? {}) as any;
    const status = (item.status ?? {}) as any;
    return [
      item.metadata.name!, spec.provider ?? '',
      spec.objectStorage?.bucket ?? '', status.phase ?? 'Unknown',
      status.lastValidationTime ?? '', String(spec.default === true),
    ];
  });
  return { stdout: table(['NAME', 'PROVIDER', 'BUCKET/PREFIX', 'PHASE', 'LAST VALIDATED', 'DEFAULT'], rows) };
}

/** 列宽对齐。velero 自己也是这么打的，两个空格分隔。 */
function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) => Math.max(
    header.length, ...rows.map((row) => (row[index] ?? '').length)
  ));
  const line = (cells: string[]) => cells
    .map((cell, index) => (index === cells.length - 1 ? cell : cell.padEnd(widths[index])))
    .join('   ')
    .replace(/\s+$/, '');
  return [line(headers), ...rows.map(line)].join('\n') + '\n';
}
