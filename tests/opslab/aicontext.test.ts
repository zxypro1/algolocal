/**
 * 喂给 AI 的集群快照
 *
 * 这一组存在的理由是一个踩过的坑：工程对话把整个工作区发上去，撞在 Next 默认的
 * 1mb 请求体上限上，中等项目直接 413 —— 功能不是变慢，是直接不可用。
 *
 * ops 的上下文比代码形态更容易失控（一个集群几百个对象，每个都有 YAML），
 * 所以裁剪放在客户端，而这里盯着裁剪真的生效：**大集群下请求体必须远低于上限**。
 */
import { createOpsWorld } from '../../src/lib/opslab/lab';
import { buildOpsSnapshot, summarizeReport, SNAPSHOT_LIMITS } from '../../src/lib/opslab/lab';
import { buildOpsContext, REVIEW_MAX_CHARS } from '../../src/lib/server/opsPrompt';
import type { OpsWorldSpec, StageRunReport } from '../../src/lib/engineering/types';
import type { CommandRecord } from '../../src/lib/labkit/machine';

const APP_IMAGE = 'registry.corp.internal/app:1.0';
const BAD_IMAGE = 'registry.corp.internal/app:broken';

/** 一个「大」集群：多命名空间、多工作负载，其中一部分是坏的 */
function bigWorld(namespaceCount: number, perNamespace: number): OpsWorldSpec {
  const namespaces = ['default', 'kube-system'];
  for (let i = 0; i < namespaceCount; i += 1) namespaces.push(`team-${i}`);

  const objects: unknown[] = [];
  for (let i = 0; i < namespaceCount; i += 1) {
    for (let j = 0; j < perNamespace; j += 1) {
      const broken = j % 7 === 0;
      const name = `svc-${j}`;
      objects.push({
        apiVersion: 'apps/v1', kind: 'Deployment',
        metadata: { name, namespace: `team-${i}` },
        spec: {
          replicas: 2,
          selector: { matchLabels: { app: name } },
          template: {
            metadata: { labels: { app: name } },
            spec: {
              containers: [{
                name: 'app',
                image: broken ? BAD_IMAGE : APP_IMAGE,
                // 塞一堆环境变量，模拟真实 manifest 的体积
                env: Array.from({ length: 12 }, (_, k) => ({ name: `VAR_${k}`, value: 'x'.repeat(60) })),
              }],
            },
          },
        },
      });
      objects.push({
        apiVersion: 'v1', kind: 'Service',
        metadata: { name, namespace: `team-${i}` },
        spec: { selector: { app: name }, ports: [{ port: 80, targetPort: 8080 }] },
      });
      objects.push({
        apiVersion: 'v1', kind: 'ConfigMap',
        metadata: { name: `${name}-config`, namespace: `team-${i}` },
        data: { 'app.conf': 'y'.repeat(2000) },
      });
    }
  }

  return {
    namespaces,
    images: {
      [APP_IMAGE]: { pullMs: 10, startupMs: 10, readyAfterMs: 10 },
      // 坏镜像不在目录里 -> 拉不到 -> Pod 进 ImagePullBackOff
    },
    objects: objects as never,
  };
}

async function build(spec: OpsWorldSpec) {
  const world = await createOpsWorld({ world: spec });
  await world.cluster.advanceBy(60_000);
  return world;
}

const command = (text: string, code: number, out: string): CommandRecord => ({
  command: text, cwd: '/root', at: 0, code, stdout: out, stderr: code === 0 ? '' : out,
});

describe('集群快照', () => {
  it('状态不正常的对象优先带上，健康的可以省', async () => {
    const world = await build(bigWorld(3, 7));
    const snapshot = buildOpsSnapshot(world, { namespace: 'team-0' });

    expect(snapshot.problems.length).toBeGreaterThan(0);
    // 坏镜像那几个必须在
    expect(snapshot.problems.some((item) => item.detail.includes('ImagePull') || item.status === 'error'))
      .toBe(true);
    // 省掉的东西要有个数，模型才知道自己看到的不是全部
    expect(snapshot.omitted.objects).toBeGreaterThan(0);
  });

  it('各项都有上限', async () => {
    const world = await build(bigWorld(12, 10));
    const history = Array.from({ length: 30 }, (_, i) => command(`kubectl get pods # ${i}`, 0, 'x'.repeat(5000)));
    const snapshot = buildOpsSnapshot(world, { namespace: 'team-0', history });

    expect(snapshot.workloads.length).toBeLessThanOrEqual(40);
    expect(snapshot.problems.length).toBeLessThanOrEqual(25);
    expect(snapshot.events.length).toBeLessThanOrEqual(20);
    expect(snapshot.commands.length).toBeLessThanOrEqual(8);
    expect(snapshot.omitted.commands).toBe(22);
    for (const entry of snapshot.commands) {
      expect(entry.output.length).toBeLessThan(1400);
    }
  });

  /**
   * 这一条是这组测试存在的理由。
   *
   * 一个十二个命名空间、每个十套服务的集群，请求体必须远远低于 Next 的默认
   * 1mb —— 就算将来有人把 sizeLimit 改回默认值，功能也不该挂。
   */
  it('大集群下请求体远低于 1mb', async () => {
    const world = await build(bigWorld(12, 10));
    const history = Array.from({ length: 40 }, (_, i) =>
      command(`kubectl describe pod pod-${i}`, i % 3 === 0 ? 1 : 0, 'z'.repeat(20000)));
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) files[`/root/infra/manifest-${i}.yaml`] = 'a'.repeat(30000);

    const snapshot = buildOpsSnapshot(world, { namespace: 'team-0', history, files });
    const payload = JSON.stringify({ messages: [{ role: 'user', content: '为什么起不来' }], context: { snapshot } });

    // 原始素材是好几 MB（20 个 30KB 的文件 + 40 条 20KB 的输出 + 几百个对象）
    expect(payload.length).toBeLessThan(200_000);
    // 也不能压过头压成空壳
    expect(snapshot.problems.length).toBeGreaterThan(0);
    expect(snapshot.commands.length).toBe(8);
    expect(snapshot.files.length).toBeGreaterThan(0);
  });

  it('文件有总预算，超了就不再带', async () => {
    const world = await build(bigWorld(1, 1));
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i += 1) files[`/root/f-${i}.yaml`] = 'b'.repeat(9000);
    const snapshot = buildOpsSnapshot(world, { files });

    const total = snapshot.files.reduce((sum, file) => sum + file.content.length, 0);
    expect(total).toBeLessThanOrEqual(11000);
    expect(snapshot.files.length).toBeLessThan(10);
  });

  it('命令输出里 stderr 排在 stdout 前面', async () => {
    const world = await build(bigWorld(1, 1));
    const record: CommandRecord = {
      command: 'kubectl apply -f x.yaml', cwd: '/root', at: 0, code: 1,
      stdout: 'STDOUT-PART', stderr: 'STDERR-PART',
    };
    const snapshot = buildOpsSnapshot(world, { history: [record] });
    const output = snapshot.commands[0].output;
    expect(output.indexOf('STDERR-PART')).toBeLessThan(output.indexOf('STDOUT-PART'));
  });
});

describe('验收结果的摘要', () => {
  it('只留没过的那几条', () => {
    const report = {
      status: 'failed',
      totals: { total: 10, passed: 7, failed: 3 },
      cases: Array.from({ length: 10 }, (_, i) => ({
        suite: 'stage', name: `case-${i}`, passed: i > 2, durationMs: 1,
        error: i > 2 ? undefined : `boom ${i}`,
      })),
      gates: [], metrics: {} as never, console: [], wallClockMs: 1,
    } as unknown as StageRunReport;

    const summary = summarizeReport(report)!;
    expect(summary.passed).toBe(7);
    expect(summary.failing).toHaveLength(3);
    expect(summary.failing[0].error).toBe('boom 0');
  });

  it('没跑过就是 null', () => {
    expect(summarizeReport(null)).toBeNull();
  });
});

describe('排版给模型的上下文', () => {
  it('终端历史排在集群状态前面', async () => {
    const world = await build(bigWorld(2, 3));
    const snapshot = buildOpsSnapshot(world, {
      namespace: 'team-0',
      history: [command('kubectl get pods', 1, 'ImagePullBackOff')],
    });
    const text = buildOpsContext(
      { stageTitle: { zh: '关卡', en: 'stage' }, snapshot },
      'zh'
    );
    expect(text.indexOf('终端最近敲了什么')).toBeLessThan(text.indexOf('集群现状'));
    expect(text).toContain('ImagePullBackOff');
  });

  it('没有异常对象时明说「没有」，而不是留空让模型猜', async () => {
    const world = await build({ namespaces: ['default'], objects: [] as never });
    const snapshot = buildOpsSnapshot(world, {});
    const text = buildOpsContext({ snapshot }, 'zh');
    expect(text).toContain('状态不正常的对象：没有');
  });

  it('服务端兜底截断：构造一个超大 snapshot 也不会无限长', async () => {
    const snapshot = {
      namespace: 'default', nodes: [], workloads: [], problems: [], events: [],
      commands: Array.from({ length: 500 }, (_, i) => ({
        command: `c-${i}`, code: 0, output: 'q'.repeat(5000),
      })),
      files: [], omitted: { objects: 0, namespaces: 0, commands: 0 },
    };
    const text = buildOpsContext({ snapshot }, 'zh');
    expect(text.length).toBeLessThan(41_000);
    expect(text).toContain('上下文过长');
  });
});

/**
 * 复盘的预算和对话不一样，所以要单独盯一遍。
 *
 * 复盘问的是「这一关他是怎么走过来的」，命令的**顺序**本身就是被评的东西 ——
 * 只给最近 8 条等于把排查路径砍掉了。所以条数放宽、单条压短，而放宽之后总量
 * 仍然必须远低于请求体上限。
 */
describe('复盘的上下文', () => {
  it('条数放宽到能看见整条排查路径，单条输出压短', async () => {
    const world = await build(bigWorld(2, 3));
    const history = Array.from({ length: 80 }, (_, i) =>
      command(`kubectl describe pod pod-${i}`, i % 5 === 0 ? 1 : 0, 'z'.repeat(9000)));

    const chat = buildOpsSnapshot(world, { history, limits: SNAPSHOT_LIMITS.chat });
    const review = buildOpsSnapshot(world, { history, limits: SNAPSHOT_LIMITS.review });

    expect(chat.commands).toHaveLength(8);
    expect(review.commands).toHaveLength(50);
    // 放宽的是条数，不是总量：单条反而更短
    expect(review.commands[0].output.length).toBeLessThan(chat.commands[0].output.length);
    expect(review.omitted.commands).toBe(30);
  });

  it('默认还是对话那套预算，调用方不传就不变', async () => {
    const world = await build(bigWorld(1, 1));
    const history = Array.from({ length: 20 }, (_, i) => command(`c-${i}`, 0, 'x'));
    expect(buildOpsSnapshot(world, { history }).commands).toHaveLength(8);
  });

  it('复盘的请求体同样远低于 1mb', async () => {
    const world = await build(bigWorld(12, 10));
    const history = Array.from({ length: 200 }, (_, i) =>
      command(`kubectl describe pod pod-${i}`, i % 3 === 0 ? 1 : 0, 'z'.repeat(20000)));
    const files: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) files[`/root/infra/manifest-${i}.yaml`] = 'a'.repeat(30000);

    const snapshot = buildOpsSnapshot(world, {
      namespace: 'team-0', history, files, limits: SNAPSHOT_LIMITS.review,
    });
    const payload = JSON.stringify({ context: { snapshot } });

    expect(payload.length).toBeLessThan(200_000);
    expect(snapshot.commands).toHaveLength(50);
    expect(snapshot.problems.length).toBeGreaterThan(0);
  });

  it('服务端给复盘的额度更高，但仍然有上限', async () => {
    const snapshot = {
      namespace: 'default', nodes: [], workloads: [], problems: [], events: [],
      commands: Array.from({ length: 500 }, (_, i) => ({
        command: `c-${i}`, code: 0, output: 'q'.repeat(5000),
      })),
      files: [], omitted: { objects: 0, namespaces: 0, commands: 0 },
    };
    const chat = buildOpsContext({ snapshot }, 'zh');
    const review = buildOpsContext({ snapshot }, 'zh', REVIEW_MAX_CHARS);

    expect(review.length).toBeGreaterThan(chat.length);
    expect(review.length).toBeLessThan(REVIEW_MAX_CHARS + 100);
    expect(review).toContain('上下文过长');
  });
});
