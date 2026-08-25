/**
 * 给 Go wasm 用的内存文件系统。
 *
 * Go 在 js/wasm 下把 os 包的调用转发到 globalThis.fs，wasm_exec.js 自带的那个
 * 只支持往 stdout/stderr 写。kubectl 要读 kubeconfig、要读 -f 指到的 manifest，
 * 所以这一层就是「kubectl 眼里的虚拟机器文件系统」——真集群里它读磁盘，这里读我们的树。
 */
type Sink = (b: Uint8Array) => void;

export function createVFS(
  files: Record<string, string | Uint8Array>,
  { onStdout, onStderr }: { onStdout?: Sink; onStderr?: Sink } = {}
) {
  const enc = new TextEncoder();
  const tree = new Map<string, Uint8Array>();                       // path -> Uint8Array
  for (const [p, c] of Object.entries(files)) {
    tree.set(normalize(p), typeof c === 'string' ? enc.encode(c) : c);
  }
  const fds = new Map<number, { path: string; pos: number }>();                        // fd -> {path, pos, append}
  let nextFd = 3;

  function normalize(p: string) {
    const parts = String(p).split('/');
    const out: string[] = [];
    for (const s of parts) {
      if (!s || s === '.') continue;
      if (s === '..') { out.pop(); continue; }
      out.push(s);
    }
    return '/' + out.join('/');
  }

  function exists(p: string) { return tree.has(p); }
  function isDir(p: string) {
    if (p === '/') return true;
    for (const k of tree.keys()) if (k.startsWith(p + '/')) return true;
    return false;
  }
  const err = (code: string) => Object.assign(new Error(code), { code });

  function statOf(p: string) {
    const dir = isDir(p);
    const size = dir ? 0 : (tree.get(p)?.length ?? 0);
    const now = Date.now();
    return {
      dev: 1, ino: hash(p), mode: dir ? 0o40755 : 0o100644, nlink: 1, uid: 0, gid: 0, rdev: 0,
      size, blksize: 4096, blocks: Math.ceil(size / 512),
      atimeMs: now, mtimeMs: now, ctimeMs: now, birthtimeMs: now,
      isDirectory: () => dir, isFile: () => !dir, isSymbolicLink: () => false,
      isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false,
    };
  }
  function hash(s: string) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h; }

  return {
    tree,
    constants: { O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_TRUNC: 512, O_APPEND: 1024, O_EXCL: 128, O_DIRECTORY: 65536 },
    writeSync(fd: number, buf: Uint8Array): number {
      if (fd === 1) { onStdout?.(buf); return buf.length; }
      if (fd === 2) { onStderr?.(buf); return buf.length; }
      const h = fds.get(fd); if (!h) throw err('EBADF');
      const old = tree.get(h.path) ?? new Uint8Array(0);
      const merged = new Uint8Array(Math.max(old.length, h.pos + buf.length));
      merged.set(old); merged.set(buf, h.pos);
      tree.set(h.path, merged); h.pos += buf.length;
      return buf.length;
    },
    write(fd: number, buf: Uint8Array, offset: number, length: number, position: number | null, cb: Function) {
      try { const n = this.writeSync(fd, buf.subarray(offset, offset + length)); cb(null, n); }
      catch (e) { cb(e); }
    },
    open(p: string, flags: number, mode: number, cb: Function) {
      const path = normalize(p);
      const creat = (flags & 64) !== 0;
      if (!exists(path) && !isDir(path)) {
        if (!creat) return cb(err('ENOENT'));
        tree.set(path, new Uint8Array(0));
      }
      if ((flags & 512) !== 0) tree.set(path, new Uint8Array(0));   // O_TRUNC
      const fd = nextFd++;
      fds.set(fd, { path, pos: (flags & 1024) !== 0 ? (tree.get(path)?.length ?? 0) : 0 });
      cb(null, fd);
    },
    close(fd: number, cb: Function) { fds.delete(fd); cb(null); },
    read(fd: number, buf: Uint8Array, offset: number, length: number, position: number | null, cb: Function) {
      const h = fds.get(fd); if (!h) return cb(err('EBADF'));
      const data = tree.get(h.path) ?? new Uint8Array(0);
      const pos = position === null ? h.pos : position;
      const n = Math.min(length, Math.max(0, data.length - pos));
      buf.set(data.subarray(pos, pos + n), offset);
      if (position === null) h.pos += n;
      cb(null, n);
    },
    fsync(fd: number, cb: Function) { cb(null); },
    stat(p: string, cb: Function) { const path = normalize(p); if (!exists(path) && !isDir(path)) return cb(err('ENOENT')); cb(null, statOf(path)); },
    lstat(p: string, cb: Function) { this.stat(p, cb); },
    fstat(fd: number, cb: Function) { const h = fds.get(fd); if (!h) return cb(err('EBADF')); cb(null, statOf(h.path)); },
    mkdir(p: string, mode: number, cb: Function) { tree.set(normalize(p) + '/.keep', new Uint8Array(0)); cb(null); },
    readdir(p: string, cb: Function) {
      const base = normalize(p); const out = new Set();
      for (const k of tree.keys()) if (k.startsWith(base === '/' ? '/' : base + '/')) {
        const rest = k.slice(base === '/' ? 1 : base.length + 1);
        const seg = rest.split('/')[0]; if (seg && seg !== '.keep') out.add(seg);
      }
      cb(null, [...out]);
    },
    unlink(p: string, cb: Function) { tree.delete(normalize(p)); cb(null); },
    rmdir(p: string, cb: Function) { cb(null); },
    rename(a: string, b: string, cb: Function) { const A = normalize(a), B = normalize(b); const v = tree.get(A); if (v) { tree.set(B, v); tree.delete(A); } cb(null); },
    chmod(p: string, m: number, cb: Function) { cb(null); }, fchmod(fd: number, m: number, cb: Function) { cb(null); },
    chown(p: string, u: number, g: number, cb: Function) { cb(null); }, fchown(fd: number, u: number, g: number, cb: Function) { cb(null); }, lchown(p: string, u: number, g: number, cb: Function) { cb(null); },
    utimes(p: string, a: number, m: number, cb: Function) { cb(null); }, truncate(p: string, l: number, cb: Function) { cb(null); }, ftruncate(fd: number, l: number, cb: Function) { cb(null); },
    readlink(p: string, cb: Function) { cb(err('EINVAL')); }, symlink(t: string, p: string, cb: Function) { cb(null); }, link(a: string, b: string, cb: Function) { cb(null); },
  };
}
