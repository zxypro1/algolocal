/**
 * git —— 内容寻址的对象库 + 一个够用的 CLI
 *
 * 第 11 关往后的 GitOps 全建立在这上面：仓库里那份 YAML 才是「期望状态」，
 * 集群里的对象只是它的一个投影。
 */
export {
  ObjectStore, hashObject, encodeTree, parseTree, encodeCommit, parseCommit,
  writeTree, readTree,
} from './objects';
export type { Commit, FileMap, GitObjectType, TreeEntry } from './objects';
export { Repository, statusOf, DEFAULT_BRANCH } from './repository';
export type { GitIdentity, StatusEntry } from './repository';
export { GitNetwork, seedRepository } from './remote';
export type { BareRepository } from './remote';
export { createGitCommand } from './command';
export type { GitCommandOptions } from './command';
