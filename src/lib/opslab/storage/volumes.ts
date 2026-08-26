/**
 * 卷里的数据
 *
 * apiserver 里存的是**对象**，不是数据。PV 只是一条元数据记录，
 * 真正的字节在存储后端上 —— 这里就是那个后端。
 *
 * 分开存有两个直接后果，两个都是这一层要教的：
 *
 *   1. 删掉 Pod 数据还在（数据不属于 Pod），删掉 PV 数据才没
 *   2. 备份对象图不等于备份数据 —— Velero 把 PVC 的 YAML 存下来了，
 *      恢复出来是一个**空盘**，除非它同时做了卷快照
 */

/** 一块盘上的内容：绝对路径到内容 */
export type VolumeContent = Record<string, string>;

export class VolumeStore {
  private data = new Map<string, VolumeContent>();

  /** 读一块盘。没有就是空盘，不是错误 —— 新建的盘本来就是空的。 */
  read(name: string): VolumeContent {
    return { ...(this.data.get(name) ?? {}) };
  }

  write(name: string, content: VolumeContent): void {
    this.data.set(name, { ...content });
  }

  has(name: string): boolean {
    return this.data.has(name);
  }

  /** 盘没了，数据也就没了 */
  drop(name: string): void {
    this.data.delete(name);
  }

  /** 快照/恢复用：整块拷过去 */
  copy(from: string, to: string): void {
    this.data.set(to, { ...(this.data.get(from) ?? {}) });
  }

  /** 世界快照。排序是为了让同样的世界序列化出同样的字节。 */
  snapshot(): Record<string, VolumeContent> {
    const out: Record<string, VolumeContent> = {};
    for (const name of [...this.data.keys()].sort()) out[name] = { ...this.data.get(name)! };
    return out;
  }

  restore(state: Record<string, VolumeContent>): void {
    this.data = new Map(Object.entries(state).map(([name, content]) => [name, { ...content }]));
  }
}
