/**
 * 机器层
 *
 * 实验台之下的那一层：磁盘、shell、命令。上面跑什么由各个实验台决定 ——
 * opslab 往里装 kubectl / helm / docker，gpulab 往里装 nvcc / ncu。
 * 这一层不认识它们中的任何一个。
 */
export {
  Vfs, VfsError, createVfs, normalizePath, dirname, basename,
  type FileStat, type VfsSnapshot,
} from './vfs';

export {
  parseShell, loadShellParser, resetShellParser, ShellSyntaxError,
  type Node, type Word, type WordPart, type Redirect,
} from './shell/parser';

export {
  Shell, createShell, matchesGlob,
  type CommandContext, type CommandHandler, type CommandResult,
  type ShellOptions, type RunResult,
} from './shell/shell';

export { COREUTILS } from './shell/coreutils';

export {
  Machine, createMachine,
  type MachineOptions, type MachineSnapshot, type CommandRecord,
} from './machine';
