/**
 * WASM 产物缓存
 *
 * 多合一二进制解压后 136MB（brotli 传输约 14MB）。本地跑（Electron / next start）
 * 从 localhost 拿，快得无所谓；但网页版第二次打开还要再下一遍 14MB 就说不过去了。
 *
 * 缓存的是**字节**，不是编译后的 Module。原本想存 Module 省掉编译那一步，
 * 在浏览器里实测直接被拒：
 *
 *   DataCloneError: A WebAssembly.Module can not be serialized for storage.
 *
 * Chrome 早就把 Module 的结构化克隆去掉了。所以只能存字节 —— 好在代价可以接受，
 * 同一台机器上实测（Chromium，142MB 的产物）：
 *
 *   | 步骤                        | 耗时   |
 *   | 下载（localhost）           | 1571ms |
 *   | WebAssembly.compile         | 1657ms |
 *   | 写进 IndexedDB              |  174ms |
 *
 * 也就是说命中缓存能省掉下载那一半，编译还是要付。配额也不是问题：
 * 那台机器给了 3.96GB。
 *
 * 新鲜度靠一次 HEAD 拿 ETag / Content-Length 来判断，比自己编版本号可靠：
 * 重新构建一次 wasm，长度必然变，缓存自动失效。
 */

export interface CacheEntry {
  /**
   * 编译好的模块。浏览器存不了（见文件头），但 Electron 里可以由别的实现
   * 直接给一个 —— 所以接口上留着这条路。
   */
  module?: WebAssembly.Module;
  bytes?: Uint8Array;
}

export interface ModuleCache {
  get(key: string, signature: string): Promise<CacheEntry | undefined>;
  put(key: string, signature: string, module: WebAssembly.Module, bytes: Uint8Array): Promise<void>;
  clear(): Promise<void>;
}

const DB_NAME = 'opslab-wasm';
const STORE = 'modules';
const DB_VERSION = 1;

/** 环境不支持就返回 undefined，调用方按「没有缓存」处理 */
export function createIndexedDbCache(dbName = DB_NAME): ModuleCache | undefined {
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!factory) return undefined;

  const openDb = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = factory.open(dbName, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

  const transact = async <T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> => {
    const db = await openDb();
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = run(transaction.objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  };

  return {
    async get(key, signature) {
      try {
        const record = await transact<{ signature: string; module?: unknown; bytes?: ArrayBuffer } | undefined>(
          'readonly',
          (store) => store.get(key)
        );
        if (!record || record.signature !== signature) return undefined;
        if (record.module instanceof WebAssembly.Module) return { module: record.module };
        if (record.bytes) return { bytes: new Uint8Array(record.bytes) };
        return undefined;
      } catch {
        return undefined;
      }
    },

    async put(key, signature, module, bytes) {
      try {
        await transact('readwrite', (store) => store.put({ signature, bytes: toArrayBuffer(bytes) }, key));
      } catch {
        // 配额满了就放弃缓存 —— 大不了下次重新下载，功能不受影响
      }
    },

    async clear() {
      try {
        await transact('readwrite', (store) => store.clear());
      } catch {
        // 清不掉也不是错误
      }
    },
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // 不能直接给 bytes.buffer —— 它可能是某个大 buffer 的一段视图
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * 问一句「远端那份还是不是缓存里那份」。
 *
 * HEAD 拿不到就返回 undefined，调用方据此决定「离线，先用缓存里的」。
 */
export async function remoteSignature(url: string, fetchImpl = fetch): Promise<string | undefined> {
  try {
    const response = await fetchImpl(url, { method: 'HEAD' });
    if (!response.ok) return undefined;
    const etag = response.headers.get('etag');
    const length = response.headers.get('content-length');
    if (!etag && !length) return undefined;
    return `${etag ?? ''}|${length ?? ''}`;
  } catch {
    return undefined;
  }
}
