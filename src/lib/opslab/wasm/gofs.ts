/**
 * Go 在 js/wasm 下的文件系统垫片
 *
 * Go 把 os 包的调用转发到 `globalThis.fs`。wasm_exec.js 自带的那个只会往
 * stdout/stderr 写，别的一律报错。kubectl 要读 kubeconfig、要读 `-f` 指到的
 * manifest、`kubectl apply -f -` 还要读 stdin —— 所以这一层把它接到机器层
 * 那棵**同一棵**文件树上。
 *
 * 「同一棵」是重点：IDE 里改完的文件，终端里 kubectl apply 立刻就能看到，
 * 因为根本没有第二份数据。
 */
import { Vfs, normalizePath } from '../../labkit/machine/vfs';

type Sink = (bytes: Uint8Array) => void;
type Callback = (error: unknown, ...rest: unknown[]) => void;

export interface GoFsOptions {
  vfs: Vfs;
  /**
   * 相对路径按它解析。
   *
   * Go 在 js/wasm 下把 `os.Open("portal.yaml")` 原样透给 `fs.open` —— 它自己
   * 不做相对路径解析，指望宿主来。少了这一步，`kubectl apply -f portal.yaml`
   * 会去找 `/portal.yaml`，而学员明明就站在那个目录里。
   */
  cwd?: string;
  /** `kubectl apply -f -` 读的就是它 */
  stdin?: string;
  onStdout: Sink;
  onStderr: Sink;
  /** 虚拟墙钟（毫秒） */
  now?: () => number;
}

interface OpenFile {
  path: string;
  position: number;
  /**
   * 当前内容。
   *
   * 打开时读一次就留着 —— Go 读文件是一小块一小块读的，每次都从
   * 字符串重新编码一遍整个文件的话，读一个大 manifest 就是 O(n²)。
   */
  data: Uint8Array;
  /** 有没有被写过；写过才需要落盘 */
  dirty: boolean;
}

const O_TRUNC = 512;
const O_APPEND = 1024;
const O_CREAT = 64;

const errorWith = (code: string) => Object.assign(new Error(code), { code });

export function createGoFs(options: GoFsOptions) {
  const { vfs } = options;
  const cwd = options.cwd ?? '/';
  const now = options.now ?? (() => 0);
  const resolve = (path: string) => normalizePath(path, cwd);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stdin = encoder.encode(options.stdin ?? '');
  let stdinPosition = 0;

  const open = new Map<number, OpenFile>();
  let nextFd = 3;

  const read = (path: string): Uint8Array =>
    vfs.exists(path) && vfs.isFile(path) ? encoder.encode(vfs.readFile(path)) : new Uint8Array(0);

  /**
   * 文本落盘。
   *
   * 机器层的文件系统存的是字符串 —— 关卡里的东西全是 YAML / JSON / 脚本。
   * 真往里写二进制会在这里被 UTF-8 解码坏掉，但那种场景本来也不在教学范围内。
   */
  const write = (path: string, bytes: Uint8Array): void => {
    vfs.writeFile(path, decoder.decode(bytes));
  };

  const concat = (head: Uint8Array, tail: Uint8Array, at: number): Uint8Array => {
    const merged = new Uint8Array(Math.max(head.length, at + tail.length));
    merged.set(head);
    merged.set(tail, at);
    return merged;
  };

  const statOf = (path: string) => {
    const directory = vfs.isDir(path);
    const size = directory ? 0 : read(path).length;
    const stamp = vfs.exists(path) ? vfs.stat(path).mtime : now();
    return {
      dev: 1, ino: inode(path), mode: directory ? 0o40755 : 0o100644,
      nlink: 1, uid: 0, gid: 0, rdev: 0,
      size, blksize: 4096, blocks: Math.ceil(size / 512),
      atimeMs: stamp, mtimeMs: stamp, ctimeMs: stamp, birthtimeMs: stamp,
      isDirectory: () => directory, isFile: () => !directory,
      isSymbolicLink: () => false, isBlockDevice: () => false,
      isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
    };
  };

  const fs = {
    constants: {
      O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_TRUNC: 512,
      O_APPEND: 1024, O_EXCL: 128, O_DIRECTORY: 65536,
    },

    writeSync(fd: number, buffer: Uint8Array): number {
      if (fd === 1) { options.onStdout(buffer.slice()); return buffer.length; }
      if (fd === 2) { options.onStderr(buffer.slice()); return buffer.length; }
      const handle = open.get(fd);
      if (!handle) throw errorWith('EBADF');
      handle.data = concat(handle.data, buffer, handle.position);
      handle.dirty = true;
      handle.position += buffer.length;
      return buffer.length;
    },

    write(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, callback: Callback) {
      try {
        callback(null, fs.writeSync(fd, buffer.subarray(offset, offset + length)));
      } catch (error) {
        callback(error);
      }
    },

    read(fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null, callback: Callback) {
      if (fd === 0) {
        const start = position === null ? stdinPosition : position;
        const count = Math.min(length, Math.max(0, stdin.length - start));
        buffer.set(stdin.subarray(start, start + count), offset);
        if (position === null) stdinPosition += count;
        return callback(null, count);
      }
      const handle = open.get(fd);
      if (!handle) return callback(errorWith('EBADF'));
      const data = handle.data;
      const start = position === null ? handle.position : position;
      const count = Math.min(length, Math.max(0, data.length - start));
      buffer.set(data.subarray(start, start + count), offset);
      if (position === null) handle.position += count;
      callback(null, count);
    },

    open(path: string, flags: number, mode: number, callback: Callback) {
      const resolved = resolve(path);
      const exists = vfs.exists(resolved);
      if (!exists && (flags & O_CREAT) === 0) return callback(errorWith('ENOENT'));
      if (!exists) vfs.writeFile(resolved, '');
      if ((flags & O_TRUNC) !== 0) vfs.writeFile(resolved, '');

      const data = read(resolved);
      const fd = nextFd++;
      open.set(fd, {
        path: resolved,
        position: (flags & O_APPEND) !== 0 ? data.length : 0,
        data,
        dirty: false,
      });
      callback(null, fd);
    },

    close(fd: number, callback: Callback) {
      const handle = open.get(fd);
      if (handle?.dirty) write(handle.path, handle.data);
      open.delete(fd);
      callback(null);
    },

    fsync(fd: number, callback: Callback) {
      const handle = open.get(fd);
      if (handle?.dirty) { write(handle.path, handle.data); handle.dirty = false; }
      callback(null);
    },

    stat(path: string, callback: Callback) {
      const resolved = resolve(path);
      if (!vfs.exists(resolved)) return callback(errorWith('ENOENT'));
      callback(null, statOf(resolved));
    },

    lstat(path: string, callback: Callback) { fs.stat(path, callback); },

    fstat(fd: number, callback: Callback) {
      const handle = open.get(fd);
      if (!handle) return callback(errorWith('EBADF'));
      callback(null, statOf(handle.path));
    },

    /** `ftruncate(fd, 0)` 是「清空重写」的常见写法，不能当成 no-op */
    ftruncateSync(fd: number, length: number) {
      const handle = open.get(fd);
      if (!handle) throw errorWith('EBADF');
      handle.data = handle.data.slice(0, length);
      handle.dirty = true;
    },

    mkdir(path: string, mode: number, callback: Callback) {
      vfs.mkdirp(resolve(path));
      callback(null);
    },

    readdir(path: string, callback: Callback) {
      const resolved = resolve(path);
      if (!vfs.isDir(resolved)) return callback(errorWith('ENOTDIR'));
      callback(null, vfs.readDir(resolved));
    },

    unlink(path: string, callback: Callback) {
      const resolved = resolve(path);
      if (!vfs.exists(resolved)) return callback(errorWith('ENOENT'));
      vfs.remove(resolved);
      callback(null);
    },

    rmdir(path: string, callback: Callback) {
      const resolved = resolve(path);
      if (!vfs.exists(resolved)) return callback(errorWith('ENOENT'));
      vfs.remove(resolved, { recursive: true });
      callback(null);
    },

    rename(from: string, to: string, callback: Callback) {
      const source = resolve(from);
      if (!vfs.exists(source)) return callback(errorWith('ENOENT'));
      vfs.rename(source, resolve(to));
      callback(null);
    },

    chmod(path: string, mode: number, callback: Callback) {
      const resolved = resolve(path);
      if (vfs.exists(resolved)) vfs.chmod(resolved, mode);
      callback(null);
    },

    readlink(path: string, callback: Callback) {
      const resolved = resolve(path);
      const stat = vfs.exists(resolved) ? vfs.stat(resolved) : undefined;
      if (stat?.type !== 'symlink') return callback(errorWith('EINVAL'));
      callback(null, stat.target);
    },

    symlink(target: string, path: string, callback: Callback) {
      vfs.symlink(target, resolve(path));
      callback(null);
    },

    // 以下这些 Go 会调但在这个世界里没有意义，认下来就好
    fchmod(fd: number, mode: number, callback: Callback) { callback(null); },
    chown(path: string, uid: number, gid: number, callback: Callback) { callback(null); },
    fchown(fd: number, uid: number, gid: number, callback: Callback) { callback(null); },
    lchown(path: string, uid: number, gid: number, callback: Callback) { callback(null); },
    utimes(path: string, atime: number, mtime: number, callback: Callback) { callback(null); },
    truncate(path: string, length: number, callback: Callback) {
      const resolved = resolve(path);
      if (vfs.exists(resolved)) write(resolved, read(resolved).slice(0, length));
      callback(null);
    },
    ftruncate(fd: number, length: number, callback: Callback) {
      try {
        fs.ftruncateSync(fd, length);
        callback(null);
      } catch (error) {
        callback(error);
      }
    },
    link(from: string, to: string, callback: Callback) { callback(null); },
  };

  return fs;
}

function inode(path: string): number {
  let hash = 5381;
  for (let i = 0; i < path.length; i += 1) hash = ((hash * 33) ^ path.charCodeAt(i)) >>> 0;
  return hash;
}
