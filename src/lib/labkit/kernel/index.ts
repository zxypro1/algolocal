/**
 * 确定性内核
 *
 * 实验台里所有会「过时间」的东西都挂在这上面：控制器、kubelet、容器进程、
 * 协议超时，以及 gpulab 那边的流、事件、多卡进度。详见 kernel.ts 的说明，
 * 以及 design/opslab.md 与 design/gpulab.md 里 L0 那一层。
 */
export { Kernel, createKernel, DeadlockError, BudgetExceededError, Priority } from './kernel';
export type { KernelOptions, KernelSnapshot, SettleOptions, PriorityValue, ScheduleOptions } from './kernel';
export { VirtualClock, ClockLivelockError } from './clock';
export { createRandom } from './random';
export type { DeterministicRandom } from './random';
