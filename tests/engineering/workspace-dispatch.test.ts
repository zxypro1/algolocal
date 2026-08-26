/**
 * 每一种工作台形态都必须有人接
 *
 * ## 这道闸门是补出来的
 *
 * gpulab 的 29 关做完、判题全绿、参考实现全对，**而工作台 UI 整个没写** ——
 * `pages/projects/[id].tsx` 的分发只认 `kind === 'ops'`，
 * gpu 项目点进去只有一句「这个版本还不支持这种工作台」。
 * 一直到发版前才被发现。
 *
 * 那次没被任何测试挡住，是因为已有的测试都在验**引擎**：
 * 判题对不对、参考解过不过、指标准不准。没有一条在问
 * 「用户点进去之后看得到什么」。
 *
 * 这条用例问的就是那件事，而且刻意问得很笨：
 * **projects.json 里出现过的每一种 kind，分发那一页里必须有对应的分支。**
 * 它拦不住「组件写得难看」，但拦得住「组件根本不存在」——
 * 而后者才是那次真正发生的事。
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..', '..');

function readProjects(): Array<{ id: string; workspace?: { kind?: string } }> {
  const raw = readFileSync(join(ROOT, 'projects', 'projects.json'), 'utf8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.projects)) return parsed.projects;
  const first = Object.values(parsed)[0];
  if (Array.isArray(first)) return first as Array<{ id: string; workspace?: { kind?: string } }>;
  throw new Error('projects.json 的形状不认识');
}

const dispatchSource = readFileSync(join(ROOT, 'pages', 'projects', '[id].tsx'), 'utf8');

describe('工作台形态的分发', () => {
  const projects = readProjects();
  const kinds = [...new Set(projects.map((project) => project.workspace?.kind ?? 'code'))];

  it('至少有一个项目声明了非 code 的形态 —— 否则这条用例是空转的', () => {
    expect(kinds.some((kind) => kind !== 'code')).toBe(true);
  });

  it.each(kinds)('kind = %s 有对应的工作台组件', (kind) => {
    if (kind === 'code') {
      // code 是兜底分支，不走 if
      expect(dispatchSource).toContain('CodeWorkspace');
      return;
    }
    // 分发里必须真的判过这个 kind，并且渲染了一个组件 ——
    // 而不是落进「这个版本还不支持这种工作台」那个兜底
    expect(dispatchSource).toMatch(new RegExp(`kind === '${kind}'`));
  });

  it.each(kinds.filter((kind) => kind !== 'code'))(
    'kind = %s 的工作台组件文件真的存在',
    (kind) => {
      const pattern = new RegExp(
        `kind === '${kind}'[\\s\\S]{0,200}?<(\\w+)\\s`
      );
      const match = dispatchSource.match(pattern);
      expect(match).not.toBeNull();
      const component = match![1];

      // 组件是 dynamic import 进来的，从 import 语句里把路径挖出来
      const importPattern = new RegExp(
        `const ${component} = dynamic\\(\\s*\\(\\) => import\\('([^']+)'\\)`
      );
      const importMatch = dispatchSource.match(importPattern);
      expect(importMatch).not.toBeNull();

      const relative = importMatch![1].replace(/^\.\.\/\.\.\//, '');
      // 存在即可；这条用例管的是「有没有」，不是「好不好」
      expect(() => readFileSync(join(ROOT, `${relative}.tsx`), 'utf8')).not.toThrow();
    }
  );

  it('**兜底分支还在** —— 装了旧版本、导入了新题目时不能白屏', () => {
    expect(dispatchSource).toContain('unsupportedKind');
  });
});
