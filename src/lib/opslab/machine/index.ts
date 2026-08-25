/**
 * 机器层
 *
 * 集群之下的那一层：磁盘、shell、命令。kubectl 也只是这台机器上的
 * 一个命令 —— 它凭 kubeconfig 找到 apiserver，和现实里一样。
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

export {
  ImageStore, Registry, RegistryNetwork, RegistryError,
  buildImage, createDockerCommand, imageRootfs, readCredentials,
  parseDockerfile, parseReference, normalizeReference, flattenLayers,
  finalizeImage, makeLayer, imageManifest, manifestDigest,
  digestOf, sha256Hex, shortId,
  type Image, type Layer, type OciImageConfig, type Credentials,
  type BuildOptions, type BuildOutcome, type DockerOptions,
} from './oci';
