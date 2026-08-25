/**
 * opslab 确定性内核
 *
 * 世界里所有会「过时间」的东西都挂在这上面。详见 kernel.ts 的说明，
 * 以及 design/opslab.md 里 L0 那一层。
 */
export { Kernel, createKernel, DeadlockError, BudgetExceededError, Priority } from './kernel';
export type { KernelOptions, KernelSnapshot, SettleOptions, PriorityValue, ScheduleOptions } from './kernel';
export { VirtualClock } from './clock';
export { createRandom } from './random';
export type { DeterministicRandom } from './random';
