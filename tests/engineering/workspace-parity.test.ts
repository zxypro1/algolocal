/**
 * 两个实战工作台的能力对齐
 *
 * ## 这道闸门也是补出来的，而且是第二次
 *
 * 第一次是 gpulab 的工作台 UI 整个没写（见 workspace-dispatch.test.ts）。
 * 第二次是 gpulab 有了工作台，但**没有 AI 助手也没有复盘** —— ops 那边两样都有，
 * gpu 这边直到用户提出来才发现。两次是同一个形态：
 * ops 先落地，gpu 后落地，中间漏掉的能力没有任何东西在盯。
 *
 * 所以这条用例问得同样笨：**ops 有的这几样东西，gpu 必须也有。**
 * 它拦不住「gpu 的实现质量不如 ops」，但拦得住「gpu 压根没有这一样」——
 * 而后者才是连着发生了两次的事。
 *
 * 只对齐**两边都该有**的能力。拓扑图、包路径是 K8s 独有的，
 * 剖析、访存是 GPU 独有的，那些不在这张表里。
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

const OPS_WORKSPACE = 'src/components/opslab/OpsWorkspace.tsx';
const GPU_WORKSPACE = 'src/components/gpulab/GpuWorkspace.tsx';

describe('AI 能力', () => {
  /** 两边都要有的那几样：对话路由、复盘路由、上下文裁剪、两个组件 */
  const PAIRS: Array<{ what: string; ops: string; gpu: string }> = [
    { what: '对话路由', ops: 'pages/api/ops-chat.ts', gpu: 'pages/api/gpu-chat.ts' },
    { what: '复盘路由', ops: 'pages/api/ops-review.ts', gpu: 'pages/api/gpu-review.ts' },
    { what: '提示词排版', ops: 'src/lib/server/opsPrompt.ts', gpu: 'src/lib/server/gpuPrompt.ts' },
    { what: '上下文裁剪', ops: 'src/lib/opslab/lab/aicontext.ts', gpu: 'src/lib/gpulab/lab/aicontext.ts' },
    { what: '对话组件', ops: 'src/components/opslab/OpsChat.tsx', gpu: 'src/components/gpulab/GpuChat.tsx' },
    { what: '复盘组件', ops: 'src/components/opslab/OpsReview.tsx', gpu: 'src/components/gpulab/GpuReview.tsx' },
  ];

  it.each(PAIRS)('$what：ops 有，gpu 也必须有', ({ ops, gpu }) => {
    // 先确认 ops 那边真的存在 —— 否则这条用例会因为「两边都没有」而假通过
    expect(existsSync(join(ROOT, ops))).toBe(true);
    expect(existsSync(join(ROOT, gpu))).toBe(true);
  });

  it('两个工作台都把对话挂进了右栏 tab', () => {
    for (const file of [OPS_WORKSPACE, GPU_WORKSPACE]) {
      const source = read(file);
      expect(source).toMatch(/Tabs\.Tab value="chat"/);
      expect(source).toMatch(/Tabs\.Panel value="chat"/);
    }
  });

  it('两个工作台都把复盘挂进了左栏 tab', () => {
    for (const file of [OPS_WORKSPACE, GPU_WORKSPACE]) {
      const source = read(file);
      expect(source).toMatch(/Tabs\.Tab value="review"/);
      expect(source).toMatch(/Tabs\.Panel value="review"/);
    }
  });

  it('两套复盘维度各自定义，不能互相借用', () => {
    const types = read('src/lib/engineering/types.ts');
    expect(types).toContain('OPS_DIMENSION_KEYS');
    expect(types).toContain('GPU_DIMENSION_KEYS');
  });

  it('两边的文案键都齐，中英各一份', () => {
    const zh = JSON.parse(read('locales/zh.json'));
    const en = JSON.parse(read('locales/en.json'));
    for (const locale of [zh, en]) {
      for (const namespace of ['opslab', 'gpulab']) {
        expect(locale[namespace]?.chat?.placeholder).toBeTruthy();
        expect(locale[namespace]?.review?.title).toBeTruthy();
        expect(Object.keys(locale[namespace]?.review?.dimensions ?? {}).length).toBeGreaterThanOrEqual(5);
      }
    }
  });
});

describe('IDE 的文件列表是磁盘的实时投影', () => {
  /**
   * gpu 这边曾经只取关卡声明的那份清单，并且钉死在 stageKey 上 ——
   * 学员在终端里 `cp` 出来的文件，IDE 里永远看不到。ops 那边一直是实时投影。
   */
  it('两边都从 vfs 现读，而不是只认关卡声明的清单', () => {
    expect(read(OPS_WORKSPACE)).toContain('toFileMap');
    expect(read('src/hooks/useGpuWorkspace.ts')).toContain('toFileMap');
  });
});

describe('只读，不代劳', () => {
  /**
   * 两个助手都不能替学员动手：判定读的就是执行结果，
   * 能替他改代码 / 改集群的助手等于能替他通关。
   * 这条盯的是提示词里那句话没被删掉。
   */
  it('两份提示词里都写着「没有手」', () => {
    expect(read('pages/api/ops-chat.ts')).toContain('You have no hands');
    expect(read('pages/api/gpu-chat.ts')).toContain('You have no hands');
  });

  it('两个对话路由都不导出任何能改世界的东西', () => {
    for (const file of ['pages/api/ops-chat.ts', 'pages/api/gpu-chat.ts']) {
      const source = read(file);
      // 路由只该 stream 出去，不该 import 执行器 / 判定器
      expect(source).not.toContain('runGpuStage');
      expect(source).not.toContain('runOpsStage');
      expect(source).not.toContain('writeFile');
    }
  });
});
