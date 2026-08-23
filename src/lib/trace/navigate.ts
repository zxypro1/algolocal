/**
 * 在录好的轨迹上做「调试器动作」。
 *
 * 断点没有真的让代码停住 —— 代码早就跑完了，这里是在录像上跳位置。
 * 好处是每个动作都有反向版本：往回 continue、往回单步，
 * 真正的断点调试器做不到这件事。
 */

import type { TraceStep } from './types';

/** 找不到目标时返回原地，UI 就自然表现为「没得跳了」 */
function firstMatch(
  steps: TraceStep[],
  from: number,
  direction: 1 | -1,
  predicate: (step: TraceStep) => boolean
): number {
  for (let i = from + direction; i >= 0 && i < steps.length; i += direction) {
    if (predicate(steps[i])) return i;
  }
  return from;
}

/** 继续：跳到下一个命中断点的步。没有断点就跳到末尾（和真调试器一致）。 */
export function continueRun(steps: TraceStep[], from: number, direction: 1 | -1 = 1): number {
  const target = firstMatch(steps, from, direction, (step) => Boolean(step.hit));
  if (target !== from) return target;
  // 后面没有命中了：正向跑到底，反向回到开头
  return direction === 1 ? steps.length - 1 : 0;
}

/** 单步进入：老老实实走下一条记录，进到被调用的函数里 */
export function stepInto(steps: TraceStep[], from: number, direction: 1 | -1 = 1): number {
  const next = from + direction;
  if (next < 0 || next >= steps.length) return from;
  return next;
}

/** 单步跳过：停在同一层或更浅的下一步，中间的被调函数整个略过 */
export function stepOver(steps: TraceStep[], from: number, direction: 1 | -1 = 1): number {
  const current = steps[from];
  if (!current) return from;
  return firstMatch(steps, from, direction, (step) => step.depth <= current.depth);
}

/** 单步跳出：一路走到比当前更浅的一层，也就是回到调用者 */
export function stepOut(steps: TraceStep[], from: number, direction: 1 | -1 = 1): number {
  const current = steps[from];
  if (!current) return from;
  return firstMatch(steps, from, direction, (step) => step.depth < current.depth);
}

/** 第一个命中断点的步；一个都没有就从头开始 */
export function firstHit(steps: TraceStep[]): number {
  const index = steps.findIndex((step) => step.hit);
  return index === -1 ? 0 : index;
}
