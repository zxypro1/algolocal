/**
 * etcd 语义的键值存储 —— apiserver 的地基。
 * 详见 store.ts 的说明，以及 design/opslab.md 里 L2 那一层。
 */
export { Store, createStore, CompactedError, FutureRevisionError } from './store';
export type {
  Compare,
  EventType,
  KeyValue,
  RangeOptions,
  RangeResult,
  StoreSnapshot,
  TxnOp,
  TxnResult,
  WatchEvent,
  Watcher,
  WatchOptions,
} from './store';
