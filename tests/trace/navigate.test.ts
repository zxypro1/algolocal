/**
 * 调试器动作在轨迹上的语义。
 *
 * 用一条手写的轨迹，因为这里要验的是「跳到哪一步」的规则本身，
 * 不该被某段具体代码的插桩细节牵着走。
 */
import {
  continueRun,
  firstHit,
  stepInto,
  stepOut,
  stepOver,
} from '../../src/lib/trace/navigate';
import type { TraceStep } from '../../src/lib/trace/types';

/** depth 序列：0 0 1 1 2 1 0 0，第 1 步和第 6 步命中断点 */
const steps: TraceStep[] = [
  { line: 1, depth: 0, fn: 'main', vars: [], stack: ['main'] },
  { line: 2, depth: 0, fn: 'main', vars: [], stack: ['main'], hit: true },
  { line: 10, depth: 1, fn: 'helper', vars: [], stack: ['main', 'helper'] },
  { line: 11, depth: 1, fn: 'helper', vars: [], stack: ['main', 'helper'] },
  { line: 20, depth: 2, fn: 'inner', vars: [], stack: ['main', 'helper', 'inner'] },
  { line: 12, depth: 1, fn: 'helper', vars: [], stack: ['main', 'helper'] },
  { line: 3, depth: 0, fn: 'main', vars: [], stack: ['main'], hit: true },
  { line: 4, depth: 0, fn: 'main', vars: [], stack: ['main'] },
];

describe('debugger actions over a recorded trace', () => {
  it('step into goes to the very next step, entering callees', () => {
    expect(stepInto(steps, 1)).toBe(2);
    expect(steps[stepInto(steps, 1)].depth).toBe(1);
  });

  it('step over skips the whole callee and lands at the same depth or shallower', () => {
    // 从 main 的第 1 步跨过 helper 那一整段，落到下一条 depth<=0
    expect(stepOver(steps, 1)).toBe(6);
    expect(steps[6].depth).toBe(0);
  });

  it('step out returns to the caller frame', () => {
    // 站在 inner(depth 2)，跳出应落到 depth 1
    expect(stepOut(steps, 4)).toBe(5);
    expect(steps[5].depth).toBe(1);
    // 站在 helper(depth 1)，跳出应回到 main
    expect(stepOut(steps, 3)).toBe(6);
  });

  it('continue jumps to the next breakpoint hit', () => {
    expect(continueRun(steps, 0)).toBe(1);
    expect(continueRun(steps, 1)).toBe(6);
  });

  it('continue past the last hit runs to the end', () => {
    expect(continueRun(steps, 6)).toBe(steps.length - 1);
  });

  it('every action has a working reverse, which a real debugger cannot do', () => {
    expect(continueRun(steps, 7, -1)).toBe(6);
    expect(continueRun(steps, 6, -1)).toBe(1);
    expect(stepInto(steps, 3, -1)).toBe(2);
    // 从 main 的最后一步往回跨过 helper 整段
    expect(stepOver(steps, 6, -1)).toBe(1);
    expect(stepOut(steps, 4, -1)).toBe(3);
  });

  it('stays put rather than running off either end', () => {
    expect(stepInto(steps, 0, -1)).toBe(0);
    expect(stepInto(steps, steps.length - 1, 1)).toBe(steps.length - 1);
    expect(stepOut(steps, 0)).toBe(0); // 已经在最外层
  });

  it('opens on the first hit, or the start when nothing is hit', () => {
    expect(firstHit(steps)).toBe(1);
    expect(firstHit(steps.map(({ hit, ...rest }) => rest))).toBe(0);
  });
});
