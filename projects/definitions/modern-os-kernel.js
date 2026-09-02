/**
 * 工程实战 · 从 0 写一个现代操作系统内核
 *
 * 运行器执行 TypeScript 和 JavaScript，硬件相关部分用可测试的模型代替。
 * 注意：代码片段使用 String.raw 模板，不要在片段里写 `${}`。
 */
const { t, code, file, spec, gate } = require('./_helpers');

/* ------------------------------------------------------------------ */
/* 第 1 关 · 物理页框分配器                                           */
/* ------------------------------------------------------------------ */

const stage1 = {
  id: 'frame-allocator',
  title: t('第 1 关 · 从启动内存图拿到第一块页框', 'Stage 1 · Allocate the first physical frame'),
  goal: t(
    [
      '固件交给内核的不是一整段可用内存，而是一张夹着保留区和设备区的内存图。',
      '内核启动后的第一件事，是把可用区域裁到页边界，再交给页框分配器管理。',
      '',
      '在 `src/memory/frameAllocator.ts` 实现 `createFrameAllocator(regions, pageSize)`。',
      '',
      '- 只接收 `usable` 区域中的完整页；',
      '- `allocate()` 返回最低地址的空闲页框，没有空间时返回 `null`；',
      '- `free()` 归还已分配页框，并拒绝重复释放和越界地址；',
      '- `reserve()` 能在启动阶段扣掉内核镜像或设备占用的页；',
      '- `stats()` 中的数量在每次操作后都要一致。',
      '',
      '测试会故意给出没有按页对齐的区域。把区域首尾直接取整，通常会把半页内存错误地交给上层。',
    ].join('\n'),
    [
      'Firmware does not hand the kernel one clean span of memory. It provides a map with usable ranges',
      'mixed with reserved and device regions. The kernel must trim usable ranges to page boundaries',
      'before anything else can allocate memory.',
      '',
      'Implement `createFrameAllocator(regions, pageSize)` in `src/memory/frameAllocator.ts`.',
      '',
      '- Accept only complete pages from `usable` regions;',
      '- `allocate()` returns the lowest free frame, or `null` when memory is exhausted;',
      '- `free()` returns an allocated frame and rejects double frees and foreign addresses;',
      '- `reserve()` removes pages occupied by the kernel image or a device during boot;',
      '- `stats()` stays consistent after every operation.',
      '',
      'The specs include unaligned regions. Rounding both ends in the convenient direction hands a partial',
      'page to the allocator, which is memory corruption waiting for its first write.',
    ].join('\n')
  ),
  architecture: t(
    [
      '```mermaid',
      'flowchart LR',
      '  M[启动内存图] --> F[裁到页边界]',
      '  F --> Q[有序空闲队列]',
      '  Q --> A[allocate]',
      '  A --> U[已分配集合]',
      '  U --> R[free]',
      '  R --> Q',
      '  Q --> V[reserve]',
      '  V --> X[保留集合]',
      '```',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart LR',
      '  M[boot memory map] --> F[trim to page boundaries]',
      '  F --> Q[ordered free queue]',
      '  Q --> A[allocate]',
      '  A --> U[allocated set]',
      '  U --> R[free]',
      '  R --> Q',
      '  Q --> V[reserve]',
      '  V --> X[reserved set]',
      '```',
    ].join('\n')
  ),
  checklist: [
    t('只管理 usable 区域中的完整页', 'Only complete pages in usable regions are managed'),
    t('分配顺序稳定，内存耗尽时返回 null', 'Allocation order is stable and exhaustion returns null'),
    t('重复释放和非法地址会被拒绝', 'Double frees and foreign addresses are rejected'),
    t('统计数字始终守恒', 'The accounting always balances'),
  ],
  hints: [
    t('区域起点向上对齐，区域终点向下对齐。', 'Align the start up and the end down.'),
    t('分别维护全部页框、空闲页框、已分配页框和保留页框。', 'Track all, free, allocated and reserved frames separately.'),
  ],
  pitfalls: [
    t('把区域起点向下对齐会接管固件保留的字节。页框分配器只能使用完全落在 usable 区域里的页。', 'Aligning a region start down takes ownership of bytes the firmware did not mark usable. A frame must sit entirely inside a usable region.'),
    t('只把地址塞回空闲数组，不检查它是否真的处于已分配状态，会让同一页框被分给两个调用方。', 'Pushing an address back without checking that it is allocated lets the same frame be handed to two callers.'),
  ],
  focus: ['correctness', 'resilience', 'encapsulation'],
  lab: {},
  starterFiles: [
    file(
      'src/memory/frameAllocator.ts',
      code`
        export interface MemoryRegion {
          base: number;
          length: number;
          type: 'usable' | 'reserved' | 'device';
        }

        export interface FrameStats {
          total: number;
          free: number;
          allocated: number;
          reserved: number;
        }

        export interface FrameAllocator {
          allocate(): number | null;
          free(address: number): void;
          reserve(address: number): void;
          stats(): FrameStats;
        }

        export function createFrameAllocator(
          regions: MemoryRegion[],
          pageSize = 4096
        ): FrameAllocator {
          // TODO: build the usable frame list and keep its accounting consistent
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-1.spec.ts',
      code`
        import { createFrameAllocator } from '../src/memory/frameAllocator';
        import { count } from '@lab/metrics';

        function throws(run: () => void): boolean {
          try { run(); return false; } catch (error) { return true; }
        }

        describe('Stage 1 · Physical frame allocator', () => {
          it('uses only complete pages from usable regions', () => {
            const allocator = createFrameAllocator([
              { base: 1, length: 8191, type: 'usable' },
              { base: 8192, length: 4096, type: 'reserved' },
              { base: 12288, length: 4096, type: 'usable' },
            ]);
            expect(allocator.stats()).toEqual({ total: 2, free: 2, allocated: 0, reserved: 0 });
            expect(allocator.allocate()).toBe(4096);
            expect(allocator.allocate()).toBe(12288);
          });

          it('returns null after the last frame is allocated', () => {
            const allocator = createFrameAllocator([{ base: 0, length: 4096, type: 'usable' }]);
            expect(allocator.allocate()).toBe(0);
            expect(allocator.allocate()).toBe(null);
          });

          it('reuses a freed frame in address order', () => {
            const allocator = createFrameAllocator([{ base: 0, length: 12288, type: 'usable' }]);
            expect(allocator.allocate()).toBe(0);
            expect(allocator.allocate()).toBe(4096);
            allocator.free(0);
            expect(allocator.allocate()).toBe(0);
          });

          it('rejects a double free and a foreign frame', () => {
            const allocator = createFrameAllocator([{ base: 0, length: 4096, type: 'usable' }]);
            allocator.allocate();
            allocator.free(0);
            expect(throws(() => allocator.free(0))).toBe(true);
            expect(throws(() => allocator.free(4096))).toBe(true);
          });

          it('can reserve a free frame before normal allocation', () => {
            const allocator = createFrameAllocator([{ base: 0, length: 12288, type: 'usable' }]);
            allocator.reserve(4096);
            expect(allocator.allocate()).toBe(0);
            expect(allocator.allocate()).toBe(8192);
            expect(allocator.stats()).toEqual({ total: 3, free: 0, allocated: 2, reserved: 1 });
          });

          it('keeps the allocation count exact [gate:frames]', () => {
            const allocator = createFrameAllocator([{ base: 0, length: 16384, type: 'usable' }]);
            allocator.allocate();
            allocator.allocate();
            allocator.allocate();
            count('allocatedFrames', allocator.stats().allocated);
            expect(allocator.stats().free).toBe(1);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.allocatedFrames',
      op: 'eq',
      value: 3,
      unit: 'frames',
      zh: '连续分配三页后，统计中必须正好有三页已分配',
      en: 'After three allocations, accounting must report exactly three allocated frames',
      dimension: 'correctness',
      scope: 'gate:frames',
    }),
  ],
  referenceFiles: [
    file(
      'src/memory/frameAllocator.ts',
      code`
        export interface MemoryRegion {
          base: number;
          length: number;
          type: 'usable' | 'reserved' | 'device';
        }

        export interface FrameStats {
          total: number;
          free: number;
          allocated: number;
          reserved: number;
        }

        export interface FrameAllocator {
          allocate(): number | null;
          free(address: number): void;
          reserve(address: number): void;
          stats(): FrameStats;
        }

        export function createFrameAllocator(
          regions: MemoryRegion[],
          pageSize = 4096
        ): FrameAllocator {
          if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error('invalid page size');

          const all = new Set<number>();
          for (const region of regions) {
            if (region.type !== 'usable' || region.length <= 0) continue;
            const start = Math.ceil(region.base / pageSize) * pageSize;
            const end = Math.floor((region.base + region.length) / pageSize) * pageSize;
            for (let address = start; address < end; address += pageSize) all.add(address);
          }

          const freeFrames = Array.from(all).sort((left, right) => left - right);
          const allocated = new Set<number>();
          const reserved = new Set<number>();

          function removeFree(address: number): boolean {
            const index = freeFrames.indexOf(address);
            if (index < 0) return false;
            freeFrames.splice(index, 1);
            return true;
          }

          return {
            allocate(): number | null {
              const address = freeFrames.shift();
              if (address === undefined) return null;
              allocated.add(address);
              return address;
            },

            free(address: number): void {
              if (!allocated.has(address)) throw new Error('frame is not allocated');
              allocated.delete(address);
              freeFrames.push(address);
              freeFrames.sort((left, right) => left - right);
            },

            reserve(address: number): void {
              if (!all.has(address)) throw new Error('frame is outside usable memory');
              if (allocated.has(address)) throw new Error('allocated frame cannot be reserved');
              if (reserved.has(address)) return;
              if (!removeFree(address)) throw new Error('frame is not free');
              reserved.add(address);
            },

            stats(): FrameStats {
              return {
                total: all.size,
                free: freeFrames.length,
                allocated: allocated.size,
                reserved: reserved.size,
              };
            },
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 2 关 · 虚拟内存                                                 */
/* ------------------------------------------------------------------ */

const stage2 = {
  id: 'virtual-memory',
  title: t('第 2 关 · 页表、权限与地址空间', 'Stage 2 · Page tables, permissions and address spaces'),
  goal: t(
    [
      '有了物理页框，还不能把地址直接交给进程。每个进程需要自己的虚拟地址空间，页表负责翻译地址并隔离权限。',
      '',
      '在 `src/memory/addressSpace.ts` 实现地址空间：',
      '',
      '- `map()` 建立连续映射，拒绝未对齐地址和重叠页；',
      '- 用户映射不能越过 `userTop`；',
      '- 同一页不能同时可写和可执行；',
      '- `translate()` 同时检查读、写、执行权限以及用户态隔离；',
      '- `protect()` 修改权限，`unmap()` 撤销映射。',
      '',
      '地址翻译不是一次普通的 Map 查询。偏移量必须保留，权限检查也必须发生在返回物理地址之前。',
    ].join('\n'),
    [
      'Physical frames are not safe to expose directly to a process. Each process needs its own virtual',
      'address space, with page tables translating addresses and enforcing isolation.',
      '',
      'Implement the address space in `src/memory/addressSpace.ts`:',
      '',
      '- `map()` creates a contiguous mapping and rejects unaligned or overlapping pages;',
      '- user mappings cannot cross `userTop`;',
      '- a page cannot be writable and executable at the same time;',
      '- `translate()` checks read, write and execute access as well as user isolation;',
      '- `protect()` changes permissions and `unmap()` removes mappings.',
      '',
      'Translation is more than a Map lookup. The offset inside the page must survive, and permission',
      'checks must happen before a physical address is returned.',
    ].join('\n')
  ),
  checklist: [
    t('虚拟地址正确翻译到物理地址并保留页内偏移', 'Translation preserves the offset within a page'),
    t('用户态无法访问内核页', 'User mode cannot access kernel pages'),
    t('写权限和执行权限不会同时打开', 'Write and execute permissions are never enabled together'),
    t('重叠映射会在修改页表前失败', 'An overlapping mapping fails before changing the page table'),
  ],
  hints: [
    t('先把整段映射预检查一遍，再写入任何页表项。', 'Validate the whole range before writing any entry.'),
    t('页内偏移是 `address % pageSize`。', 'The offset inside a page is `address % pageSize`.'),
  ],
  pitfalls: [
    t('边检查边写入映射。遇到中间页重叠时，前半段已经生效，调用方拿到一张半更新的页表。', 'Writing entries while validating them leaves a half-updated page table when a later page overlaps.'),
    t('只检查页表项是否存在，不检查访问类型和运行级别，会把页表变成没有隔离能力的地址字典。', 'Checking only that an entry exists turns the page table into an address dictionary with no isolation.'),
  ],
  focus: ['correctness', 'resilience', 'encapsulation'],
  lab: {},
  starterFiles: [
    file(
      'src/memory/addressSpace.ts',
      code`
        export interface PagePermissions {
          read: boolean;
          write: boolean;
          execute: boolean;
          user: boolean;
        }

        export type AccessType = 'read' | 'write' | 'execute';
        export type CpuMode = 'user' | 'kernel';

        export interface AddressSpace {
          map(virtualAddress: number, physicalAddress: number, pages: number, permissions: PagePermissions): void;
          unmap(virtualAddress: number, pages: number): void;
          protect(virtualAddress: number, pages: number, permissions: PagePermissions): void;
          translate(address: number, access: AccessType, mode: CpuMode): number;
          mappedPages(): number;
        }

        export function createAddressSpace(options: { pageSize?: number; userTop?: number } = {}): AddressSpace {
          // TODO: implement the page table and all permission checks
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-2.spec.ts',
      code`
        import { createAddressSpace } from '../src/memory/addressSpace';

        function throws(run: () => void): boolean {
          try { run(); return false; } catch (error) { return true; }
        }

        const rwUser = { read: true, write: true, execute: false, user: true };
        const rxUser = { read: true, write: false, execute: true, user: true };

        describe('Stage 2 · Virtual memory', () => {
          it('translates every page and preserves its offset', () => {
            const space = createAddressSpace({ pageSize: 4096, userTop: 0x80000000 });
            space.map(0x4000, 0x20000, 2, rwUser);
            expect(space.translate(0x4123, 'read', 'user')).toBe(0x20123);
            expect(space.translate(0x5007, 'write', 'user')).toBe(0x21007);
          });

          it('rejects unaligned and overlapping mappings atomically', () => {
            const space = createAddressSpace();
            expect(throws(() => space.map(1, 0, 1, rwUser))).toBe(true);
            space.map(0x1000, 0x9000, 1, rwUser);
            expect(throws(() => space.map(0, 0x8000, 2, rwUser))).toBe(true);
            expect(space.mappedPages()).toBe(1);
          });

          it('enforces access permissions', () => {
            const space = createAddressSpace();
            space.map(0x1000, 0x9000, 1, rxUser);
            expect(space.translate(0x1000, 'execute', 'user')).toBe(0x9000);
            expect(throws(() => space.translate(0x1000, 'write', 'user'))).toBe(true);
          });

          it('blocks user access to a kernel-only page', () => {
            const space = createAddressSpace();
            space.map(0x1000, 0x9000, 1, { read: true, write: true, execute: false, user: false });
            expect(throws(() => space.translate(0x1000, 'read', 'user'))).toBe(true);
            expect(space.translate(0x1000, 'read', 'kernel')).toBe(0x9000);
          });

          it('enforces the user address ceiling and write xor execute', () => {
            const space = createAddressSpace({ userTop: 0x8000 });
            expect(throws(() => space.map(0x8000, 0, 1, rwUser))).toBe(true);
            expect(throws(() => space.map(0x1000, 0, 1, { read: true, write: true, execute: true, user: true }))).toBe(true);
            space.map(0x8000, 0, 1, { read: true, write: true, execute: false, user: false });
            expect(throws(() => space.protect(0x8000, 1, rwUser))).toBe(true);
          });

          it('protects and unmaps existing pages', () => {
            const space = createAddressSpace();
            space.map(0x1000, 0x9000, 1, rwUser);
            space.protect(0x1000, 1, rxUser);
            expect(throws(() => space.translate(0x1000, 'write', 'user'))).toBe(true);
            expect(space.translate(0x1000, 'execute', 'user')).toBe(0x9000);
            space.unmap(0x1000, 1);
            expect(throws(() => space.translate(0x1000, 'read', 'user'))).toBe(true);
          });
        });
      `
    ),
  ],
  referenceFiles: [
    file(
      'src/memory/addressSpace.ts',
      code`
        export interface PagePermissions {
          read: boolean;
          write: boolean;
          execute: boolean;
          user: boolean;
        }

        export type AccessType = 'read' | 'write' | 'execute';
        export type CpuMode = 'user' | 'kernel';

        interface PageEntry {
          physicalPage: number;
          permissions: PagePermissions;
        }

        export interface AddressSpace {
          map(virtualAddress: number, physicalAddress: number, pages: number, permissions: PagePermissions): void;
          unmap(virtualAddress: number, pages: number): void;
          protect(virtualAddress: number, pages: number, permissions: PagePermissions): void;
          translate(address: number, access: AccessType, mode: CpuMode): number;
          mappedPages(): number;
        }

        export function createAddressSpace(options: { pageSize?: number; userTop?: number } = {}): AddressSpace {
          const pageSize = options.pageSize || 4096;
          const userTop = options.userTop === undefined ? 0x80000000 : options.userTop;
          const entries = new Map<number, PageEntry>();

          if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error('invalid page size');

          function aligned(address: number): boolean {
            return Number.isInteger(address) && address >= 0 && address % pageSize === 0;
          }

          function validPermissions(permissions: PagePermissions): void {
            if (permissions.write && permissions.execute) throw new Error('write xor execute violation');
          }

          function pagesInRange(address: number, pages: number): number[] {
            if (!aligned(address) || !Number.isInteger(pages) || pages <= 0) throw new Error('invalid page range');
            const first = address / pageSize;
            return Array.from({ length: pages }, (_, index) => first + index);
          }

          return {
            map(virtualAddress, physicalAddress, pages, permissions): void {
              if (!aligned(physicalAddress)) throw new Error('physical address is not aligned');
              validPermissions(permissions);
              if (permissions.user && virtualAddress + pages * pageSize > userTop) {
                throw new Error('user mapping crosses into kernel space');
              }
              const virtualPages = pagesInRange(virtualAddress, pages);
              if (virtualPages.some((page) => entries.has(page))) throw new Error('mapping overlaps an existing page');
              const physicalFirst = physicalAddress / pageSize;
              virtualPages.forEach((page, index) => {
                entries.set(page, { physicalPage: physicalFirst + index, permissions: { ...permissions } });
              });
            },

            unmap(virtualAddress, pages): void {
              for (const page of pagesInRange(virtualAddress, pages)) entries.delete(page);
            },

            protect(virtualAddress, pages, permissions): void {
              validPermissions(permissions);
              const range = pagesInRange(virtualAddress, pages);
              if (permissions.user && virtualAddress + pages * pageSize > userTop) {
                throw new Error('user mapping crosses into kernel space');
              }
              if (range.some((page) => !entries.has(page))) throw new Error('cannot protect an unmapped page');
              range.forEach((page) => {
                const entry = entries.get(page) as PageEntry;
                entries.set(page, { physicalPage: entry.physicalPage, permissions: { ...permissions } });
              });
            },

            translate(address, access, mode): number {
              if (!Number.isInteger(address) || address < 0) throw new Error('invalid virtual address');
              const page = Math.floor(address / pageSize);
              const entry = entries.get(page);
              if (!entry) throw new Error('page fault: unmapped');
              if (mode === 'user' && !entry.permissions.user) throw new Error('page fault: supervisor page');
              if (!entry.permissions[access]) throw new Error('page fault: permission denied');
              return entry.physicalPage * pageSize + (address % pageSize);
            },

            mappedPages(): number {
              return entries.size;
            },
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 3 关 · 抢占式调度                                               */
/* ------------------------------------------------------------------ */

const stage3 = {
  id: 'preemptive-scheduler',
  title: t('第 3 关 · 时间片与抢占调度', 'Stage 3 · Time slices and preemptive scheduling'),
  goal: t(
    [
      '进程不能靠自觉让出 CPU。时钟中断到来时，调度器要扣掉一个 tick，在时间片用完后切换任务；更高优先级任务就绪时，还要立刻抢占。',
      '',
      '在 `src/scheduler.ts` 实现一个单核调度器：',
      '',
      '- 同一优先级使用 round-robin；',
      '- 数字越大的优先级越先运行；',
      '- 更高优先级任务就绪后，在下一个 tick 抢占当前任务；',
      '- 阻塞任务不占 CPU，唤醒后回到就绪队列；',
      '- 任务耗尽 `remainingTicks` 后进入 done 状态。',
      '',
      '最容易漏掉的是队列去重。任务被 block、wake 或抢占时，如果旧队列项没有清掉，它会在未来凭空多运行一次。',
    ].join('\n'),
    [
      'Processes cannot be trusted to yield the CPU. Each timer interrupt consumes one tick, the scheduler',
      'switches tasks when a slice expires, and a newly ready higher-priority task must preempt.',
      '',
      'Implement a single-core scheduler in `src/scheduler.ts`:',
      '',
      '- Tasks at the same priority use round-robin;',
      '- A larger priority number runs first;',
      '- A newly ready higher-priority task preempts on the next tick;',
      '- Blocked tasks consume no CPU and return to the ready queue when woken;',
      '- A task enters the done state after consuming all `remainingTicks`.',
      '',
      'Queue duplication is the subtle bug. If block, wake or preemption leaves an old queue entry behind,',
      'the task receives a free extra turn later.',
    ].join('\n')
  ),
  checklist: [
    t('同优先级任务按时间片轮转', 'Equal-priority tasks rotate by time slice'),
    t('高优先级任务会抢占低优先级任务', 'A higher-priority task preempts a lower-priority task'),
    t('阻塞和唤醒不会制造重复队列项', 'Blocking and waking do not duplicate queue entries'),
    t('完成的任务不会再次运行', 'Completed tasks never run again'),
  ],
  hints: [
    t('当前任务单独保存，就绪队列里不要再留它的 id。', 'Keep the current task outside the ready queues.'),
    t('每次调度前，只需比较当前优先级和最高就绪优先级。', 'Before scheduling, compare the current priority with the highest ready priority.'),
  ],
  pitfalls: [
    t('用一个全局 FIFO 会让低优先级长任务挡住刚唤醒的高优先级任务。', 'One global FIFO lets a long low-priority task delay a newly woken high-priority task.'),
    t('时间片用完后先入队再判断任务是否完成，会把 done 任务放回就绪队列。', 'Requeueing before checking completion puts a done task back in the ready queue.'),
  ],
  focus: ['correctness', 'resilience', 'elegance'],
  lab: {},
  starterFiles: [
    file(
      'src/scheduler.ts',
      code`
        export type TaskState = 'ready' | 'running' | 'blocked' | 'done';

        export interface TaskSnapshot {
          id: string;
          priority: number;
          remainingTicks: number;
          state: TaskState;
        }

        export interface Scheduler {
          add(id: string, priority: number, ticks: number): void;
          tick(): string | null;
          block(id: string): void;
          wake(id: string): void;
          current(): string | null;
          snapshot(): TaskSnapshot[];
        }

        export function createScheduler(options: { quantum: number }): Scheduler {
          // TODO: implement ready queues, preemption and task state transitions
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-3.spec.ts',
      code`
        import { createScheduler } from '../src/scheduler';

        function throws(run: () => void): boolean {
          try { run(); return false; } catch (error) { return true; }
        }

        describe('Stage 3 · Preemptive scheduler', () => {
          it('rotates equal-priority tasks after each quantum', () => {
            const scheduler = createScheduler({ quantum: 1 });
            scheduler.add('a', 1, 2);
            scheduler.add('b', 1, 2);
            expect([scheduler.tick(), scheduler.tick(), scheduler.tick(), scheduler.tick()]).toEqual(['a', 'b', 'a', 'b']);
            expect(scheduler.tick()).toBe(null);
          });

          it('keeps a task on CPU until a longer quantum expires', () => {
            const scheduler = createScheduler({ quantum: 2 });
            scheduler.add('a', 1, 3);
            scheduler.add('b', 1, 2);
            expect([scheduler.tick(), scheduler.tick(), scheduler.tick()]).toEqual(['a', 'a', 'b']);
          });

          it('preempts when a higher-priority task becomes ready', () => {
            const scheduler = createScheduler({ quantum: 4 });
            scheduler.add('low', 1, 4);
            expect(scheduler.tick()).toBe('low');
            scheduler.add('high', 9, 1);
            expect(scheduler.tick()).toBe('high');
            expect(scheduler.tick()).toBe('low');
          });

          it('does not run blocked tasks and can wake them once', () => {
            const scheduler = createScheduler({ quantum: 1 });
            scheduler.add('io', 5, 2);
            scheduler.add('worker', 1, 2);
            scheduler.block('io');
            expect(scheduler.tick()).toBe('worker');
            scheduler.wake('io');
            scheduler.wake('io');
            expect(scheduler.tick()).toBe('io');
            expect(scheduler.tick()).toBe('io');
            expect(scheduler.tick()).toBe('worker');
          });

          it('marks exhausted tasks done', () => {
            const scheduler = createScheduler({ quantum: 3 });
            scheduler.add('short', 1, 1);
            expect(scheduler.tick()).toBe('short');
            expect(scheduler.current()).toBe(null);
            expect(scheduler.snapshot()).toEqual([{ id: 'short', priority: 1, remainingTicks: 0, state: 'done' }]);
          });

          it('rejects invalid and duplicate tasks', () => {
            const scheduler = createScheduler({ quantum: 1 });
            scheduler.add('a', 1, 1);
            expect(throws(() => scheduler.add('a', 1, 1))).toBe(true);
            expect(throws(() => scheduler.add('b', 1, 0))).toBe(true);
          });
        });
      `
    ),
  ],
  referenceFiles: [
    file(
      'src/scheduler.ts',
      code`
        export type TaskState = 'ready' | 'running' | 'blocked' | 'done';

        export interface TaskSnapshot {
          id: string;
          priority: number;
          remainingTicks: number;
          state: TaskState;
        }

        interface Task extends TaskSnapshot {}

        export interface Scheduler {
          add(id: string, priority: number, ticks: number): void;
          tick(): string | null;
          block(id: string): void;
          wake(id: string): void;
          current(): string | null;
          snapshot(): TaskSnapshot[];
        }

        export function createScheduler(options: { quantum: number }): Scheduler {
          if (!Number.isInteger(options.quantum) || options.quantum <= 0) throw new Error('invalid quantum');
          const tasks = new Map<string, Task>();
          const ready = new Map<number, string[]>();
          let currentId: string | null = null;
          let slice = 0;

          function enqueue(task: Task): void {
            if (task.state === 'done') return;
            const queue = ready.get(task.priority) || [];
            if (!queue.includes(task.id)) queue.push(task.id);
            ready.set(task.priority, queue);
            task.state = 'ready';
          }

          function removeFromReady(id: string): void {
            for (const [priority, queue] of Array.from(ready.entries())) {
              const filtered = queue.filter((item) => item !== id);
              if (filtered.length) ready.set(priority, filtered);
              else ready.delete(priority);
            }
          }

          function highestReadyPriority(): number | null {
            const priorities = Array.from(ready.entries())
              .filter((entry) => entry[1].length > 0)
              .map((entry) => entry[0]);
            return priorities.length ? Math.max(...priorities) : null;
          }

          function takeNext(): Task | null {
            const priority = highestReadyPriority();
            if (priority === null) return null;
            const queue = ready.get(priority) as string[];
            const id = queue.shift() as string;
            if (queue.length === 0) ready.delete(priority);
            const task = tasks.get(id) as Task;
            task.state = 'running';
            return task;
          }

          function schedule(): Task | null {
            if (currentId) {
              const running = tasks.get(currentId) as Task;
              const highest = highestReadyPriority();
              if (highest !== null && highest > running.priority) {
                enqueue(running);
                currentId = null;
                slice = 0;
              }
            }
            if (!currentId) {
              const next = takeNext();
              if (!next) return null;
              currentId = next.id;
              slice = 0;
            }
            return tasks.get(currentId) as Task;
          }

          return {
            add(id, priority, ticks): void {
              if (tasks.has(id)) throw new Error('duplicate task id');
              if (!id || !Number.isFinite(priority) || !Number.isInteger(ticks) || ticks <= 0) {
                throw new Error('invalid task');
              }
              const task: Task = { id, priority, remainingTicks: ticks, state: 'ready' };
              tasks.set(id, task);
              enqueue(task);
            },

            tick(): string | null {
              const task = schedule();
              if (!task) return null;
              task.remainingTicks -= 1;
              slice += 1;
              const ran = task.id;
              if (task.remainingTicks === 0) {
                task.state = 'done';
                currentId = null;
                slice = 0;
              } else if (slice >= options.quantum) {
                enqueue(task);
                currentId = null;
                slice = 0;
              }
              return ran;
            },

            block(id): void {
              const task = tasks.get(id);
              if (!task || task.state === 'done') throw new Error('task cannot be blocked');
              removeFromReady(id);
              if (currentId === id) {
                currentId = null;
                slice = 0;
              }
              task.state = 'blocked';
            },

            wake(id): void {
              const task = tasks.get(id);
              if (!task) throw new Error('unknown task');
              if (task.state === 'blocked') enqueue(task);
            },

            current(): string | null {
              return currentId;
            },

            snapshot(): TaskSnapshot[] {
              return Array.from(tasks.values())
                .map((task) => ({ ...task }))
                .sort((left, right) => left.id.localeCompare(right.id));
            },
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 4 关 · 系统调用与句柄                                           */
/* ------------------------------------------------------------------ */

const stage4 = {
  id: 'syscalls-handles',
  title: t('第 4 关 · 系统调用边界与句柄权限', 'Stage 4 · The syscall boundary and handle rights'),
  goal: t(
    [
      '用户程序不能拿到内核对象引用。它只能提交系统调用号、普通参数和一个整数句柄，内核再检查这个句柄是否存在、是否拥有所需权限。',
      '',
      '在 `src/syscalls.ts` 实现句柄表和系统调用表：',
      '',
      '- 句柄从 3 开始分配，关闭后立即失效；',
      '- `duplicate()` 只能缩减权限，不能凭空增加权限；',
      '- `get(handle, right)` 同时检查句柄有效性和权限；',
      '- 未注册系统调用返回 `ENOSYS`；',
      '- 内核可识别错误保留错误码，其他异常统一收成 `EFAULT`。',
      '',
      '这里的返回值不能依赖抛异常。系统调用是内核和用户态之间的协议，错误码本身就是协议的一部分。',
    ].join('\n'),
    [
      'User programs cannot receive references to kernel objects. They submit a syscall number, plain',
      'arguments and an integer handle. The kernel then checks whether the handle exists and carries the',
      'required right.',
      '',
      'Implement the handle table and syscall table in `src/syscalls.ts`:',
      '',
      '- Handles start at 3 and become invalid as soon as they are closed;',
      '- `duplicate()` may reduce rights but can never add one;',
      '- `get(handle, right)` checks both validity and rights;',
      '- An unregistered syscall returns `ENOSYS`;',
      '- Known kernel errors keep their code and unexpected exceptions become `EFAULT`.',
      '',
      'The boundary cannot depend on exceptions escaping. A syscall is a protocol between user mode and the',
      'kernel, and its error codes are part of that protocol.',
    ].join('\n')
  ),
  checklist: [
    t('用户态只看到整数句柄', 'User mode sees only integer handles'),
    t('复制句柄不能扩大权限', 'Duplicating a handle cannot widen its rights'),
    t('未知调用和非法句柄返回稳定错误码', 'Unknown calls and invalid handles return stable error codes'),
    t('关闭句柄后资源不可再访问', 'A closed handle can no longer access its resource'),
  ],
  hints: [
    t('句柄表内部保存资源和 Set 权限，向外只返回递增整数。', 'Store the resource and a Set of rights internally, returning only increasing integers.'),
    t('系统调用表的 invoke 是唯一需要 catch 的地方。', '`invoke` is the only place in the syscall table that needs to catch.'),
  ],
  pitfalls: [
    t('复制句柄时直接接受调用方给的新权限，相当于允许只读句柄自行升级成可写。', 'Accepting caller-supplied rights during duplication lets a read-only handle upgrade itself to writable.'),
    t('把所有异常都返回同一个错误码，会让用户态无法区分未知调用、坏句柄和权限不足。', 'Returning one code for every failure prevents user mode from distinguishing an unknown call, a bad handle and missing rights.'),
  ],
  focus: ['correctness', 'resilience', 'encapsulation'],
  lab: {},
  starterFiles: [
    file(
      'src/syscalls.ts',
      code`
        export type Right = 'read' | 'write' | 'signal' | 'duplicate';

        export class KernelError extends Error {
          constructor(public code: string) {
            super(code);
            this.name = 'KernelError';
          }
        }

        export interface HandleTable {
          grant(resource: unknown, rights: Right[]): number;
          duplicate(handle: number, rights: Right[]): number;
          get(handle: number, right: Right): unknown;
          close(handle: number): void;
          size(): number;
        }

        export type SyscallResult = { ok: true; value: unknown } | { ok: false; error: string };
        export type SyscallHandler = (args: unknown[], handles: HandleTable) => unknown;

        export interface SyscallTable {
          register(number: number, handler: SyscallHandler): void;
          invoke(number: number, args: unknown[], handles: HandleTable): SyscallResult;
        }

        export function createHandleTable(): HandleTable {
          // TODO
          throw new Error('not implemented');
        }

        export function createSyscallTable(): SyscallTable {
          // TODO
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-4.spec.ts',
      code`
        import { createHandleTable, createSyscallTable, KernelError } from '../src/syscalls';

        describe('Stage 4 · Syscalls and handles', () => {
          it('allocates opaque handles starting at 3', () => {
            const handles = createHandleTable();
            expect(handles.grant({ name: 'console' }, ['write'])).toBe(3);
            expect(handles.grant({ name: 'log' }, ['read'])).toBe(4);
            expect(handles.size()).toBe(2);
          });

          it('checks rights before returning a resource', () => {
            const handles = createHandleTable();
            const resource = { value: 7 };
            const handle = handles.grant(resource, ['read']);
            expect(handles.get(handle, 'read')).toBe(resource);
            let code = '';
            try { handles.get(handle, 'write'); } catch (error) { code = (error as KernelError).code; }
            expect(code).toBe('EPERM');
          });

          it('duplicates with fewer rights but never more', () => {
            const handles = createHandleTable();
            const original = handles.grant({ value: 7 }, ['read', 'write', 'duplicate']);
            const copy = handles.duplicate(original, ['read']);
            expect((handles.get(copy, 'read') as { value: number }).value).toBe(7);
            let code = '';
            try { handles.duplicate(copy, ['write']); } catch (error) { code = (error as KernelError).code; }
            expect(code).toBe('EPERM');
          });

          it('invalidates a handle immediately on close', () => {
            const handles = createHandleTable();
            const handle = handles.grant({}, ['read']);
            handles.close(handle);
            let code = '';
            try { handles.get(handle, 'read'); } catch (error) { code = (error as KernelError).code; }
            expect(code).toBe('EBADF');
            expect(handles.size()).toBe(0);
          });

          it('dispatches a registered syscall through its handle table', () => {
            const handles = createHandleTable();
            const handle = handles.grant({ value: 5 }, ['read']);
            const syscalls = createSyscallTable();
            syscalls.register(1, (args, table) => {
              const resource = table.get(Number(args[0]), 'read') as { value: number };
              return resource.value + Number(args[1]);
            });
            expect(syscalls.invoke(1, [handle, 2], handles)).toEqual({ ok: true, value: 7 });
          });

          it('returns stable errors instead of throwing across the boundary', () => {
            const handles = createHandleTable();
            const syscalls = createSyscallTable();
            expect(syscalls.invoke(99, [], handles)).toEqual({ ok: false, error: 'ENOSYS' });
            syscalls.register(1, () => { throw new KernelError('EPERM'); });
            syscalls.register(2, () => { throw new Error('bug'); });
            expect(syscalls.invoke(1, [], handles)).toEqual({ ok: false, error: 'EPERM' });
            expect(syscalls.invoke(2, [], handles)).toEqual({ ok: false, error: 'EFAULT' });
          });
        });
      `
    ),
  ],
  referenceFiles: [
    file(
      'src/syscalls.ts',
      code`
        export type Right = 'read' | 'write' | 'signal' | 'duplicate';

        export class KernelError extends Error {
          constructor(public code: string) {
            super(code);
            this.name = 'KernelError';
          }
        }

        interface HandleEntry {
          resource: unknown;
          rights: Set<Right>;
        }

        export interface HandleTable {
          grant(resource: unknown, rights: Right[]): number;
          duplicate(handle: number, rights: Right[]): number;
          get(handle: number, right: Right): unknown;
          close(handle: number): void;
          size(): number;
        }

        export type SyscallResult = { ok: true; value: unknown } | { ok: false; error: string };
        export type SyscallHandler = (args: unknown[], handles: HandleTable) => unknown;

        export interface SyscallTable {
          register(number: number, handler: SyscallHandler): void;
          invoke(number: number, args: unknown[], handles: HandleTable): SyscallResult;
        }

        export function createHandleTable(): HandleTable {
          const entries = new Map<number, HandleEntry>();
          let nextHandle = 3;

          function entryOf(handle: number): HandleEntry {
            const entry = entries.get(handle);
            if (!entry) throw new KernelError('EBADF');
            return entry;
          }

          return {
            grant(resource, rights): number {
              const handle = nextHandle;
              nextHandle += 1;
              entries.set(handle, { resource, rights: new Set(rights) });
              return handle;
            },

            duplicate(handle, rights): number {
              const source = entryOf(handle);
              if (!source.rights.has('duplicate')) throw new KernelError('EPERM');
              if (rights.some((right) => !source.rights.has(right))) throw new KernelError('EPERM');
              return this.grant(source.resource, rights);
            },

            get(handle, right): unknown {
              const entry = entryOf(handle);
              if (!entry.rights.has(right)) throw new KernelError('EPERM');
              return entry.resource;
            },

            close(handle): void {
              if (!entries.delete(handle)) throw new KernelError('EBADF');
            },

            size(): number {
              return entries.size;
            },
          };
        }

        export function createSyscallTable(): SyscallTable {
          const handlers = new Map<number, SyscallHandler>();
          return {
            register(number, handler): void {
              if (!Number.isInteger(number) || number < 0 || handlers.has(number)) {
                throw new Error('invalid or duplicate syscall number');
              }
              handlers.set(number, handler);
            },

            invoke(number, args, handles): SyscallResult {
              const handler = handlers.get(number);
              if (!handler) return { ok: false, error: 'ENOSYS' };
              try {
                return { ok: true, value: handler(args, handles) };
              } catch (error) {
                if (error instanceof KernelError) return { ok: false, error: error.code };
                return { ok: false, error: 'EFAULT' };
              }
            },
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 5 关 · VFS 与文件描述符                                         */
/* ------------------------------------------------------------------ */

const stage5 = {
  id: 'vfs',
  title: t('第 5 关 · VFS、路径与文件描述符', 'Stage 5 · VFS paths and file descriptors'),
  goal: t(
    [
      '内核不应该让每种文件系统各自定义一套 open、read 和 write。VFS 统一路径和文件描述符语义，底层实现只负责节点和数据。',
      '',
      '在 `src/vfs.ts` 实现一个内存文件系统：',
      '',
      '- 路径需要处理重复斜杠、`.` 和 `..`，但不能逃出根目录；',
      '- `mkdir()` 和 `createFile()` 要求父目录存在；',
      '- 每次 `open()` 都有独立的读写偏移；',
      '- `r`、`w`、`rw` 和 `a` 模式遵守各自权限；',
      '- 关闭后的文件描述符返回 `EBADF`。',
      '',
      '`open` 返回的是一次打开实例，不是文件节点本身。两个文件描述符指向同一文件时，它们共享内容，但不能共享 offset。',
    ].join('\n'),
    [
      'The kernel should not expose a different open, read and write API for every filesystem. A VFS',
      'standardises paths and file descriptor semantics while the backing implementation owns nodes and data.',
      '',
      'Implement an in-memory filesystem in `src/vfs.ts`:',
      '',
      '- Paths handle repeated slashes, `.` and `..`, but cannot escape the root;',
      '- `mkdir()` and `createFile()` require an existing parent directory;',
      '- Every `open()` has an independent file offset;',
      '- Modes `r`, `w`, `rw` and `a` enforce their own rights;',
      '- A closed file descriptor returns `EBADF`.',
      '',
      '`open` returns an open-file instance, not the node itself. Two descriptors may share file contents,',
      'but they must not share an offset.',
    ].join('\n')
  ),
  checklist: [
    t('路径规范化不会逃出根目录', 'Path normalisation cannot escape the root'),
    t('文件描述符拥有独立偏移', 'Each file descriptor has its own offset'),
    t('打开模式限制读写能力', 'Open modes enforce read and write rights'),
    t('关闭后的 fd 立即失效', 'A closed file descriptor becomes invalid immediately'),
  ],
  hints: [
    t('文件节点和打开实例用两张 Map 保存。', 'Keep file nodes and open instances in separate Maps.'),
    t('append 模式的每次 write 都从当前文件末尾开始。', 'Every append-mode write starts at the current end of the file.'),
  ],
  pitfalls: [
    t('把 offset 存在文件节点上，会让一个进程的 read 改变另一个进程下一次 read 的位置。', 'Storing the offset on the file node lets one process move another process\'s next read position.'),
    t('只在 open 时把 append 的 offset 放到末尾，其他写入随后增长文件时，append fd 会写到旧末尾。', 'Setting an append offset only at open time writes to a stale end after another descriptor grows the file.'),
  ],
  focus: ['correctness', 'encapsulation', 'resilience'],
  lab: {},
  starterFiles: [
    file(
      'src/vfs.ts',
      code`
        export type OpenMode = 'r' | 'w' | 'rw' | 'a';

        export interface VfsStat {
          kind: 'file' | 'directory';
          size: number;
        }

        export interface Vfs {
          mkdir(path: string): void;
          createFile(path: string, data?: string): void;
          open(path: string, mode: OpenMode): number;
          read(fd: number, length: number): string;
          write(fd: number, data: string): number;
          seek(fd: number, offset: number): void;
          close(fd: number): void;
          stat(path: string): VfsStat;
        }

        export function createVfs(): Vfs {
          // TODO: implement nodes, open-file instances and path normalisation
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-5.spec.ts',
      code`
        import { createVfs } from '../src/vfs';

        function errorOf(run: () => void): string {
          try { run(); return ''; } catch (error) { return (error as Error).message; }
        }

        describe('Stage 5 · VFS', () => {
          it('creates directories and normalises paths', () => {
            const vfs = createVfs();
            vfs.mkdir('/etc');
            vfs.createFile('/etc/config', 'ok');
            expect(vfs.stat('//etc/./config')).toEqual({ kind: 'file', size: 2 });
            expect(errorOf(() => vfs.stat('/../../etc/config'))).toBe('EINVAL');
          });

          it('requires the parent directory to exist', () => {
            const vfs = createVfs();
            expect(errorOf(() => vfs.createFile('/missing/file'))).toBe('ENOENT');
          });

          it('keeps an independent offset for every open descriptor', () => {
            const vfs = createVfs();
            vfs.createFile('/data', 'abcdef');
            const first = vfs.open('/data', 'r');
            const second = vfs.open('/data', 'r');
            expect(vfs.read(first, 2)).toBe('ab');
            expect(vfs.read(first, 2)).toBe('cd');
            expect(vfs.read(second, 2)).toBe('ab');
          });

          it('enforces read and write modes', () => {
            const vfs = createVfs();
            vfs.createFile('/data', 'abc');
            const reader = vfs.open('/data', 'r');
            const writer = vfs.open('/data', 'w');
            expect(errorOf(() => vfs.write(reader, 'x'))).toBe('EBADF');
            expect(errorOf(() => vfs.read(writer, 1))).toBe('EBADF');
          });

          it('truncates in write mode and appends at the current end', () => {
            const vfs = createVfs();
            vfs.createFile('/log', 'old');
            const writer = vfs.open('/log', 'w');
            vfs.write(writer, 'new');
            const append = vfs.open('/log', 'a');
            vfs.write(writer, '!');
            vfs.write(append, 'tail');
            const reader = vfs.open('/log', 'r');
            expect(vfs.read(reader, 20)).toBe('new!tail');
          });

          it('invalidates a closed descriptor', () => {
            const vfs = createVfs();
            vfs.createFile('/data', 'x');
            const fd = vfs.open('/data', 'r');
            vfs.close(fd);
            expect(errorOf(() => vfs.read(fd, 1))).toBe('EBADF');
          });
        });
      `
    ),
  ],
  referenceFiles: [
    file(
      'src/vfs.ts',
      code`
        export type OpenMode = 'r' | 'w' | 'rw' | 'a';

        export interface VfsStat {
          kind: 'file' | 'directory';
          size: number;
        }

        interface Node {
          kind: 'file' | 'directory';
          data: string;
        }

        interface OpenFile {
          path: string;
          mode: OpenMode;
          offset: number;
        }

        export interface Vfs {
          mkdir(path: string): void;
          createFile(path: string, data?: string): void;
          open(path: string, mode: OpenMode): number;
          read(fd: number, length: number): string;
          write(fd: number, data: string): number;
          seek(fd: number, offset: number): void;
          close(fd: number): void;
          stat(path: string): VfsStat;
        }

        export function createVfs(): Vfs {
          const nodes = new Map<string, Node>();
          const openFiles = new Map<number, OpenFile>();
          let nextFd = 3;
          nodes.set('/', { kind: 'directory', data: '' });

          function normalize(path: string): string {
            if (!path.startsWith('/')) throw new Error('EINVAL');
            const parts: string[] = [];
            for (const part of path.split('/')) {
              if (!part || part === '.') continue;
              if (part === '..') {
                if (parts.length === 0) throw new Error('EINVAL');
                parts.pop();
              } else {
                parts.push(part);
              }
            }
            return '/' + parts.join('/');
          }

          function parentOf(path: string): string {
            const index = path.lastIndexOf('/');
            return index <= 0 ? '/' : path.slice(0, index);
          }

          function requireDirectory(path: string): void {
            const node = nodes.get(path);
            if (!node || node.kind !== 'directory') throw new Error('ENOENT');
          }

          function opened(fd: number): OpenFile {
            const handle = openFiles.get(fd);
            if (!handle) throw new Error('EBADF');
            return handle;
          }

          return {
            mkdir(path): void {
              const normalized = normalize(path);
              if (nodes.has(normalized)) throw new Error('EEXIST');
              requireDirectory(parentOf(normalized));
              nodes.set(normalized, { kind: 'directory', data: '' });
            },

            createFile(path, data = ''): void {
              const normalized = normalize(path);
              if (nodes.has(normalized)) throw new Error('EEXIST');
              requireDirectory(parentOf(normalized));
              nodes.set(normalized, { kind: 'file', data });
            },

            open(path, mode): number {
              const normalized = normalize(path);
              let node = nodes.get(normalized);
              if (!node && (mode === 'w' || mode === 'rw' || mode === 'a')) {
                requireDirectory(parentOf(normalized));
                node = { kind: 'file', data: '' };
                nodes.set(normalized, node);
              }
              if (!node) throw new Error('ENOENT');
              if (node.kind !== 'file') throw new Error('EISDIR');
              if (mode === 'w') node.data = '';
              const fd = nextFd;
              nextFd += 1;
              openFiles.set(fd, { path: normalized, mode, offset: mode === 'a' ? node.data.length : 0 });
              return fd;
            },

            read(fd, length): string {
              const handle = opened(fd);
              if (handle.mode !== 'r' && handle.mode !== 'rw') throw new Error('EBADF');
              if (!Number.isInteger(length) || length < 0) throw new Error('EINVAL');
              const node = nodes.get(handle.path) as Node;
              const chunk = node.data.slice(handle.offset, handle.offset + length);
              handle.offset += chunk.length;
              return chunk;
            },

            write(fd, data): number {
              const handle = opened(fd);
              if (handle.mode !== 'w' && handle.mode !== 'rw' && handle.mode !== 'a') throw new Error('EBADF');
              const node = nodes.get(handle.path) as Node;
              if (handle.mode === 'a') handle.offset = node.data.length;
              const before = node.data.slice(0, handle.offset);
              const afterOffset = handle.offset + data.length;
              const after = afterOffset < node.data.length ? node.data.slice(afterOffset) : '';
              node.data = before + data + after;
              handle.offset += data.length;
              return data.length;
            },

            seek(fd, offset): void {
              if (!Number.isInteger(offset) || offset < 0) throw new Error('EINVAL');
              opened(fd).offset = offset;
            },

            close(fd): void {
              if (!openFiles.delete(fd)) throw new Error('EBADF');
            },

            stat(path): VfsStat {
              const node = nodes.get(normalize(path));
              if (!node) throw new Error('ENOENT');
              return { kind: node.kind, size: node.kind === 'file' ? node.data.length : 0 };
            },
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 6 关 · 管道与背压                                               */
/* ------------------------------------------------------------------ */

const stage6 = {
  id: 'pipes',
  title: t('第 6 关 · 有界管道、阻塞与唤醒', 'Stage 6 · Bounded pipes, blocking and wakeups'),
  goal: t(
    [
      '管道把两个进程接在一起，但中间缓冲区不能无限增长。写端填满缓冲区后必须等待读端腾出空间，读端在没有数据时也要休眠。',
      '',
      '在 `src/pipe.ts` 实现一个有界异步管道：',
      '',
      '- 写入超过容量时，Promise 保持 pending，直到读端消费了足够数据；',
      '- 空管道上的 read 等待下一次写入；',
      '- 数据按写入顺序送达；',
      '- 写端关闭后，缓冲区读完返回空字符串表示 EOF；',
      '- 读端关闭后，新的和等待中的写入都返回 `EPIPE`。',
      '',
      '不要用轮询或定时器。内核知道哪个读者和写者在等待，状态变化时直接唤醒对应队列。',
    ].join('\n'),
    [
      'A pipe connects two processes, but its buffer cannot grow without bound. Once full, writers must',
      'wait for readers to make room, and readers on an empty pipe must sleep.',
      '',
      'Implement a bounded asynchronous pipe in `src/pipe.ts`:',
      '',
      '- A write beyond capacity remains pending until readers consume enough data;',
      '- A read on an empty pipe waits for the next write;',
      '- Bytes arrive in write order;',
      '- After the writer closes, draining the buffer yields an empty string for EOF;',
      '- After the reader closes, new and waiting writes fail with `EPIPE`.',
      '',
      'Do not poll and do not use timers. The kernel knows which readers and writers are asleep, so a state',
      'change can wake the corresponding queue directly.',
    ].join('\n')
  ),
  checklist: [
    t('缓冲区容量始终有上限', 'Buffer capacity is always bounded'),
    t('等待队列按提交顺序唤醒', 'Wait queues wake in submission order'),
    t('EOF 只在缓冲区排空后出现', 'EOF appears only after the buffer is drained'),
    t('读端关闭会向写端报告 EPIPE', 'Closing the reader reports EPIPE to writers'),
  ],
  hints: [
    t('把等待中的 read 和 write 各放一条 FIFO 队列，所有状态变化都调用同一个 pump。', 'Keep FIFO queues for waiting reads and writes, and call one pump after every state change.'),
    t('一次大写入可以分段进入缓冲区，但它的 Promise 要在全部写完后才 resolve。', 'A large write may enter the buffer in pieces, but its Promise resolves only after all bytes are accepted.'),
  ],
  pitfalls: [
    t('缓冲区满时继续接收数据，会把背压问题变成内存问题。', 'Accepting more data while full turns a backpressure problem into a memory problem.'),
    t('写端关闭后立刻返回 EOF，会丢掉缓冲区里已经成功写入的数据。', 'Returning EOF as soon as the writer closes drops data already accepted into the buffer.'),
  ],
  focus: ['correctness', 'concurrency', 'resilience'],
  lab: {},
  starterFiles: [
    file(
      'src/pipe.ts',
      code`
        export interface Pipe {
          write(data: string): Promise<number>;
          read(maxBytes: number): Promise<string>;
          closeWriter(): void;
          closeReader(): void;
          buffered(): number;
        }

        export function createPipe(capacity: number): Pipe {
          // TODO: implement a bounded buffer and FIFO wait queues
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-6.spec.ts',
      code`
        import { createPipe } from '../src/pipe';
        import { count } from '@lab/metrics';

        describe('Stage 6 · Pipes', () => {
          it('delivers bytes in order', async () => {
            const pipe = createPipe(8);
            await pipe.write('abc');
            await pipe.write('def');
            expect(await pipe.read(2)).toBe('ab');
            expect(await pipe.read(8)).toBe('cdef');
          });

          it('blocks a large write until a reader makes room', async () => {
            const pipe = createPipe(4);
            let completed = false;
            const writing = pipe.write('abcdef').then((size) => { completed = true; return size; });
            await Promise.resolve();
            expect(pipe.buffered()).toBe(4);
            expect(completed).toBe(false);
            expect(await pipe.read(3)).toBe('abc');
            expect(await writing).toBe(6);
            expect(await pipe.read(3)).toBe('def');
          });

          it('wakes a reader waiting on an empty pipe', async () => {
            const pipe = createPipe(4);
            const reading = pipe.read(4);
            await pipe.write('wake');
            expect(await reading).toBe('wake');
          });

          it('drains buffered data before EOF', async () => {
            const pipe = createPipe(4);
            await pipe.write('done');
            pipe.closeWriter();
            expect(await pipe.read(4)).toBe('done');
            expect(await pipe.read(4)).toBe('');
          });

          it('reports EPIPE when the reader is closed', async () => {
            const pipe = createPipe(2);
            pipe.closeReader();
            let message = '';
            try { await pipe.write('x'); } catch (error) { message = (error as Error).message; }
            expect(message).toBe('EPIPE');
          });

          it('wakes readers that were waiting when the read end closes', async () => {
            const pipe = createPipe(2);
            const reading = pipe.read(1);
            pipe.closeReader();
            let message = '';
            try { await reading; } catch (error) { message = (error as Error).message; }
            expect(message).toBe('EBADF');
          });

          it('never grows beyond capacity [gate:buffer]', async () => {
            const pipe = createPipe(4);
            await pipe.write('1234');
            count('pipeBuffered', pipe.buffered());
            expect(pipe.buffered()).toBe(4);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.pipeBuffered',
      op: 'lte',
      value: 4,
      unit: 'bytes',
      zh: '容量为 4 的管道最多保留 4 字节',
      en: 'A pipe with capacity 4 holds at most 4 bytes',
      dimension: 'resilience',
      scope: 'gate:buffer',
    }),
  ],
  referenceFiles: [
    file(
      'src/pipe.ts',
      code`
        export interface Pipe {
          write(data: string): Promise<number>;
          read(maxBytes: number): Promise<string>;
          closeWriter(): void;
          closeReader(): void;
          buffered(): number;
        }

        interface WaitingReader {
          maxBytes: number;
          resolve(value: string): void;
          reject(error: Error): void;
        }

        interface WaitingWriter {
          data: string;
          offset: number;
          resolve(value: number): void;
          reject(error: Error): void;
        }

        export function createPipe(capacity: number): Pipe {
          if (!Number.isInteger(capacity) || capacity <= 0) throw new Error('EINVAL');
          let buffer = '';
          let writerClosed = false;
          let readerClosed = false;
          const readers: WaitingReader[] = [];
          const writers: WaitingWriter[] = [];

          function pump(): void {
            let changed = true;
            while (changed) {
              changed = false;

              if (readerClosed && writers.length) {
                const waiting = writers.splice(0);
                waiting.forEach((writer) => writer.reject(new Error('EPIPE')));
                changed = true;
              }

              while (readers.length && (buffer.length > 0 || writerClosed)) {
                const reader = readers.shift() as WaitingReader;
                if (buffer.length === 0) reader.resolve('');
                else {
                  const chunk = buffer.slice(0, reader.maxBytes);
                  buffer = buffer.slice(chunk.length);
                  reader.resolve(chunk);
                }
                changed = true;
              }

              if (!readerClosed && writers.length && buffer.length < capacity) {
                const writer = writers[0];
                const room = capacity - buffer.length;
                const chunk = writer.data.slice(writer.offset, writer.offset + room);
                buffer += chunk;
                writer.offset += chunk.length;
                if (writer.offset === writer.data.length) {
                  writers.shift();
                  writer.resolve(writer.data.length);
                }
                changed = true;
              }
            }
          }

          return {
            write(data): Promise<number> {
              if (readerClosed || writerClosed) return Promise.reject(new Error('EPIPE'));
              if (data.length === 0) return Promise.resolve(0);
              return new Promise<number>((resolve, reject) => {
                writers.push({ data, offset: 0, resolve, reject });
                pump();
              });
            },

            read(maxBytes): Promise<string> {
              if (!Number.isInteger(maxBytes) || maxBytes <= 0) return Promise.reject(new Error('EINVAL'));
              if (readerClosed) return Promise.reject(new Error('EBADF'));
              return new Promise<string>((resolve, reject) => {
                readers.push({ maxBytes, resolve, reject });
                pump();
              });
            },

            closeWriter(): void {
              writerClosed = true;
              pump();
            },

            closeReader(): void {
              readerClosed = true;
              buffer = '';
              const waiting = readers.splice(0);
              waiting.forEach((reader) => reader.reject(new Error('EBADF')));
              pump();
            },

            buffered(): number {
              return buffer.length;
            },
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 7 关 · 写时复制                                                 */
/* ------------------------------------------------------------------ */

const stage7 = {
  id: 'copy-on-write',
  title: t('第 7 关 · fork 与写时复制', 'Stage 7 · Fork and copy-on-write'),
  goal: t(
    [
      '`fork()` 如果立刻复制整个地址空间，复制成本会和进程内存一起增长。写时复制先让父子进程共享物理页，只有一方第一次写入时才复制那一页。',
      '',
      '在 `src/processMemory.ts` 实现进程内存管理器：',
      '',
      '- `fork()` 只复制页表关系并增加引用计数；',
      '- 父子进程最初读到相同内容；',
      '- 写共享页时只复制目标页，其他页继续共享；',
      '- 同一进程随后再写该页，不重复复制；',
      '- `exit()` 递减引用计数，并释放最后一个引用消失的页框。',
      '',
      '复制发生在写缺页处理路径上。先改原页再复制，会让另一个进程看到本不属于它的写入。',
    ].join('\n'),
    [
      'Copying an entire address space inside `fork()` makes its cost grow with process memory. Copy-on-write',
      'shares physical pages first and copies one page only when either process writes to it.',
      '',
      'Implement the process memory manager in `src/processMemory.ts`:',
      '',
      '- `fork()` copies mappings and increments reference counts, without copying frames;',
      '- Parent and child initially read the same bytes;',
      '- Writing a shared page copies only that page;',
      '- Later writes to the private page do not copy it again;',
      '- `exit()` decrements references and frees a frame after its last reference disappears.',
      '',
      'The copy belongs in the write-fault path. Modifying the original frame before copying exposes the',
      'write to the other process.',
    ].join('\n')
  ),
  checklist: [
    t('fork 不立即复制物理页', 'Fork does not copy physical frames immediately'),
    t('第一次写共享页时只复制一页', 'The first write to a shared page copies one frame'),
    t('父子进程的写入彼此隔离', 'Parent and child writes are isolated'),
    t('进程退出后引用计数和页框数量正确', 'Exit leaves frame counts and references correct'),
  ],
  hints: [
    t('每个进程保存 frame id 数组，每个 frame 保存 bytes 和 refs。', 'Each process keeps frame ids, while each frame keeps bytes and a reference count.'),
    t('write 前如果 refs 大于 1，先复制、减旧引用，再替换当前进程的映射。', 'Before writing a frame with refs above 1, copy it, decrement the old ref and replace this process mapping.'),
  ],
  pitfalls: [
    t('fork 时复制所有 bytes，功能上没错，但完全失去了写时复制的性能特征。', 'Copying every byte during fork is functionally correct but loses the defining performance property of copy-on-write.'),
    t('进程退出时只删页表，不减 frame 引用，会让已退出进程的内存永远无法回收。', 'Deleting only the process mappings on exit leaves frame references behind forever.'),
  ],
  focus: ['correctness', 'latency', 'resilience'],
  lab: {},
  starterFiles: [
    file(
      'src/processMemory.ts',
      code`
        export interface MemoryStats {
          processes: number;
          frames: number;
          sharedFrames: number;
          copies: number;
        }

        export interface ProcessMemoryManager {
          create(bytes: number[]): number;
          fork(pid: number): number;
          read(pid: number, address: number): number;
          write(pid: number, address: number, value: number): void;
          exit(pid: number): void;
          stats(): MemoryStats;
        }

        export function createProcessMemoryManager(pageSize = 4096): ProcessMemoryManager {
          // TODO: implement frame references and the copy-on-write fault path
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-7.spec.ts',
      code`
        import { createProcessMemoryManager } from '../src/processMemory';
        import { count } from '@lab/metrics';

        describe('Stage 7 · Copy-on-write', () => {
          it('fork shares frames without copying [gate:fork]', () => {
            const memory = createProcessMemoryManager(4);
            const parent = memory.create([1, 2, 3, 4, 5]);
            const before = memory.stats();
            const child = memory.fork(parent);
            const after = memory.stats();
            count('forkCopies', after.copies - before.copies);
            expect(after.frames).toBe(before.frames);
            expect(after.sharedFrames).toBe(2);
            expect(memory.read(child, 4)).toBe(5);
          });

          it('copies only the written page', () => {
            const memory = createProcessMemoryManager(4);
            const parent = memory.create([1, 2, 3, 4, 5, 6]);
            const child = memory.fork(parent);
            memory.write(child, 1, 9);
            expect(memory.read(parent, 1)).toBe(2);
            expect(memory.read(child, 1)).toBe(9);
            expect(memory.stats()).toEqual({ processes: 2, frames: 3, sharedFrames: 1, copies: 1 });
          });

          it('does not copy a private page twice', () => {
            const memory = createProcessMemoryManager(4);
            const parent = memory.create([1, 2, 3, 4]);
            const child = memory.fork(parent);
            memory.write(child, 0, 7);
            memory.write(child, 1, 8);
            expect(memory.stats().copies).toBe(1);
          });

          it('isolates writes made by either side', () => {
            const memory = createProcessMemoryManager(4);
            const parent = memory.create([1, 2, 3, 4]);
            const child = memory.fork(parent);
            memory.write(parent, 0, 8);
            memory.write(child, 1, 9);
            expect([memory.read(parent, 0), memory.read(parent, 1)]).toEqual([8, 2]);
            expect([memory.read(child, 0), memory.read(child, 1)]).toEqual([1, 9]);
          });

          it('releases frames after the last process exits', () => {
            const memory = createProcessMemoryManager(4);
            const parent = memory.create([1, 2, 3, 4]);
            const child = memory.fork(parent);
            memory.exit(child);
            expect(memory.stats()).toEqual({ processes: 1, frames: 1, sharedFrames: 0, copies: 0 });
            memory.exit(parent);
            expect(memory.stats().frames).toBe(0);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.forkCopies',
      op: 'eq',
      value: 0,
      unit: 'frames',
      zh: 'fork 阶段不能复制任何物理页',
      en: 'Fork must copy zero physical frames',
      dimension: 'latency',
      scope: 'gate:fork',
    }),
  ],
  referenceFiles: [
    file(
      'src/processMemory.ts',
      code`
        export interface MemoryStats {
          processes: number;
          frames: number;
          sharedFrames: number;
          copies: number;
        }

        interface Frame {
          bytes: number[];
          refs: number;
        }

        export interface ProcessMemoryManager {
          create(bytes: number[]): number;
          fork(pid: number): number;
          read(pid: number, address: number): number;
          write(pid: number, address: number, value: number): void;
          exit(pid: number): void;
          stats(): MemoryStats;
        }

        export function createProcessMemoryManager(pageSize = 4096): ProcessMemoryManager {
          if (!Number.isInteger(pageSize) || pageSize <= 0) throw new Error('EINVAL');
          const frames = new Map<number, Frame>();
          const processes = new Map<number, number[]>();
          let nextFrame = 1;
          let nextPid = 1;
          let copies = 0;

          function allocate(bytes: number[]): number {
            const id = nextFrame;
            nextFrame += 1;
            const page = bytes.slice(0, pageSize);
            while (page.length < pageSize) page.push(0);
            frames.set(id, { bytes: page, refs: 1 });
            return id;
          }

          function mappingsOf(pid: number): number[] {
            const mappings = processes.get(pid);
            if (!mappings) throw new Error('ESRCH');
            return mappings;
          }

          function location(pid: number, address: number): { mappings: number[]; page: number; offset: number; frame: Frame } {
            if (!Number.isInteger(address) || address < 0) throw new Error('EFAULT');
            const mappings = mappingsOf(pid);
            const page = Math.floor(address / pageSize);
            const frameId = mappings[page];
            const frame = frames.get(frameId);
            if (frameId === undefined || !frame) throw new Error('EFAULT');
            return { mappings, page, offset: address % pageSize, frame };
          }

          return {
            create(bytes): number {
              const mappings: number[] = [];
              for (let offset = 0; offset < bytes.length; offset += pageSize) {
                mappings.push(allocate(bytes.slice(offset, offset + pageSize)));
              }
              const pid = nextPid;
              nextPid += 1;
              processes.set(pid, mappings);
              return pid;
            },

            fork(pid): number {
              const source = mappingsOf(pid);
              const childMappings = source.slice();
              childMappings.forEach((frameId) => {
                (frames.get(frameId) as Frame).refs += 1;
              });
              const child = nextPid;
              nextPid += 1;
              processes.set(child, childMappings);
              return child;
            },

            read(pid, address): number {
              const found = location(pid, address);
              return found.frame.bytes[found.offset];
            },

            write(pid, address, value): void {
              if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error('EINVAL');
              let found = location(pid, address);
              if (found.frame.refs > 1) {
                found.frame.refs -= 1;
                const privateFrame = allocate(found.frame.bytes);
                found.mappings[found.page] = privateFrame;
                copies += 1;
                found = location(pid, address);
              }
              found.frame.bytes[found.offset] = value;
            },

            exit(pid): void {
              const mappings = mappingsOf(pid);
              for (const frameId of mappings) {
                const frame = frames.get(frameId) as Frame;
                frame.refs -= 1;
                if (frame.refs === 0) frames.delete(frameId);
              }
              processes.delete(pid);
            },

            stats(): MemoryStats {
              return {
                processes: processes.size,
                frames: frames.size,
                sharedFrames: Array.from(frames.values()).filter((frame) => frame.refs > 1).length,
                copies,
              };
            },
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 8 关 · 进程生命周期                                             */
/* ------------------------------------------------------------------ */

const stage8 = {
  id: 'process-lifecycle',
  title: t('第 8 关 · 退出、僵尸进程与 wait', 'Stage 8 · Exit, zombies and wait'),
  goal: t(
    [
      '进程退出后不能立刻从进程表消失。父进程还要通过 `wait()` 取走退出码；在此之前，它是一条只保留身份和状态的僵尸记录。',
      '',
      '在 `src/processTable.ts` 实现进程生命周期：',
      '',
      '- 创建时自动建立 pid 1 的 init 进程；',
      '- `spawn()` 记录父子关系，pid 单调递增；',
      '- `exit()` 把进程变为 zombie，并把仍存活的子进程托管给 init；',
      '- 只有父进程能用 `wait()` 回收自己的 zombie 子进程；',
      '- `kill(pid, signal)` 以 `128 + signal` 作为退出码；',
      '- init 不能退出。',
      '',
      '僵尸进程不再运行，也不再持有普通资源，但进程表项必须留到父进程读取退出状态。过早删除和永不删除都不对。',
    ].join('\n'),
    [
      'A process cannot disappear from the process table the instant it exits. Its parent still needs to',
      'collect the status with `wait()`. Until then, a zombie record keeps only identity and exit state.',
      '',
      'Implement process lifecycle rules in `src/processTable.ts`:',
      '',
      '- Creation automatically installs init as pid 1;',
      '- `spawn()` records parentage and pids increase monotonically;',
      '- `exit()` creates a zombie and reparents living children to init;',
      '- Only a parent may reap its own zombie child with `wait()`;',
      '- `kill(pid, signal)` uses `128 + signal` as the exit code;',
      '- Init cannot exit.',
      '',
      'A zombie no longer runs or holds ordinary resources, but its process table entry must remain until',
      'the parent reads its status. Deleting it immediately and retaining it forever are both wrong.',
    ].join('\n')
  ),
  checklist: [
    t('退出状态会保留到父进程 wait', 'Exit status remains until the parent waits'),
    t('wait 后僵尸进程才从表中删除', 'A zombie is removed only after wait'),
    t('孤儿进程会托管给 init', 'Orphans are reparented to init'),
    t('非父进程不能回收别人的子进程', 'A non-parent cannot reap another process'),
  ],
  hints: [
    t('exit 只改变状态并处理父子关系，真正的 delete 放在 wait。', '`exit` changes state and parentage, while `wait` performs the deletion.'),
    t('wait 不指定 pid 时，按最小 pid 回收一个 zombie 子进程。', 'Without a pid, wait reaps the lowest-pid zombie child.'),
  ],
  pitfalls: [
    t('exit 时直接删除进程表项，会让父进程永远拿不到退出码。', 'Deleting the process entry during exit loses the status before the parent can read it.'),
    t('父进程退出时把子进程一并删除，会误杀仍在正常运行的孤儿进程。', 'Deleting children when their parent exits kills orphaned processes that should keep running.'),
  ],
  focus: ['correctness', 'resilience', 'encapsulation'],
  lab: {},
  starterFiles: [
    file(
      'src/processTable.ts',
      code`
        export type ProcessState = 'running' | 'zombie';

        export interface ProcessInfo {
          pid: number;
          parentPid: number | null;
          name: string;
          state: ProcessState;
          exitCode?: number;
        }

        export interface ProcessTable {
          initPid(): number;
          spawn(parentPid: number, name: string): number;
          exit(pid: number, code: number): void;
          kill(pid: number, signal: number): void;
          wait(parentPid: number, childPid?: number): { pid: number; exitCode: number } | null;
          get(pid: number): ProcessInfo | null;
          children(pid: number): number[];
        }

        export function createProcessTable(): ProcessTable {
          // TODO: implement parentage, zombie retention and reaping
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-8.spec.ts',
      code`
        import { createProcessTable } from '../src/processTable';

        function errorOf(run: () => void): string {
          try { run(); return ''; } catch (error) { return (error as Error).message; }
        }

        describe('Stage 8 · Process lifecycle', () => {
          it('boots init as pid 1 and allocates increasing pids', () => {
            const table = createProcessTable();
            expect(table.initPid()).toBe(1);
            expect(table.spawn(1, 'shell')).toBe(2);
            expect(table.spawn(1, 'logger')).toBe(3);
          });

          it('keeps a zombie until its parent waits', () => {
            const table = createProcessTable();
            const child = table.spawn(1, 'worker');
            table.exit(child, 7);
            expect(table.get(child)).toEqual({ pid: child, parentPid: 1, name: 'worker', state: 'zombie', exitCode: 7 });
            expect(table.wait(1, child)).toEqual({ pid: child, exitCode: 7 });
            expect(table.get(child)).toBe(null);
          });

          it('does not reap a running child', () => {
            const table = createProcessTable();
            const child = table.spawn(1, 'worker');
            expect(table.wait(1, child)).toBe(null);
            expect(table.get(child)?.state).toBe('running');
          });

          it('reparents living orphans to init', () => {
            const table = createProcessTable();
            const parent = table.spawn(1, 'parent');
            const child = table.spawn(parent, 'child');
            table.exit(parent, 0);
            expect(table.get(child)?.parentPid).toBe(1);
            expect(table.children(1)).toEqual([parent, child]);
          });

          it('lets only the parent reap a zombie', () => {
            const table = createProcessTable();
            const parent = table.spawn(1, 'parent');
            const stranger = table.spawn(1, 'stranger');
            const child = table.spawn(parent, 'child');
            table.exit(child, 0);
            expect(errorOf(() => table.wait(stranger, child))).toBe('ECHILD');
            expect(table.wait(parent, child)).toEqual({ pid: child, exitCode: 0 });
          });

          it('maps signals to conventional exit codes and protects init', () => {
            const table = createProcessTable();
            const child = table.spawn(1, 'worker');
            table.kill(child, 9);
            expect(table.wait(1, child)).toEqual({ pid: child, exitCode: 137 });
            expect(errorOf(() => table.exit(1, 0))).toBe('EPERM');
          });
        });
      `
    ),
  ],
  referenceFiles: [
    file(
      'src/processTable.ts',
      code`
        export type ProcessState = 'running' | 'zombie';

        export interface ProcessInfo {
          pid: number;
          parentPid: number | null;
          name: string;
          state: ProcessState;
          exitCode?: number;
        }

        export interface ProcessTable {
          initPid(): number;
          spawn(parentPid: number, name: string): number;
          exit(pid: number, code: number): void;
          kill(pid: number, signal: number): void;
          wait(parentPid: number, childPid?: number): { pid: number; exitCode: number } | null;
          get(pid: number): ProcessInfo | null;
          children(pid: number): number[];
        }

        export function createProcessTable(): ProcessTable {
          const processes = new Map<number, ProcessInfo>();
          let nextPid = 2;
          processes.set(1, { pid: 1, parentPid: null, name: 'init', state: 'running' });

          function requireProcess(pid: number): ProcessInfo {
            const process = processes.get(pid);
            if (!process) throw new Error('ESRCH');
            return process;
          }

          function listChildren(pid: number): ProcessInfo[] {
            return Array.from(processes.values())
              .filter((process) => process.parentPid === pid)
              .sort((left, right) => left.pid - right.pid);
          }

          return {
            initPid(): number {
              return 1;
            },

            spawn(parentPid, name): number {
              const parent = requireProcess(parentPid);
              if (parent.state !== 'running') throw new Error('ESRCH');
              if (!name) throw new Error('EINVAL');
              const pid = nextPid;
              nextPid += 1;
              processes.set(pid, { pid, parentPid, name, state: 'running' });
              return pid;
            },

            exit(pid, code): void {
              if (pid === 1) throw new Error('EPERM');
              const process = requireProcess(pid);
              if (process.state === 'zombie') throw new Error('ESRCH');
              process.state = 'zombie';
              process.exitCode = code;
              for (const child of listChildren(pid)) child.parentPid = 1;
            },

            kill(pid, signal): void {
              if (!Number.isInteger(signal) || signal <= 0) throw new Error('EINVAL');
              this.exit(pid, 128 + signal);
            },

            wait(parentPid, childPid): { pid: number; exitCode: number } | null {
              requireProcess(parentPid);
              const children = listChildren(parentPid);
              if (childPid !== undefined && !children.some((child) => child.pid === childPid)) {
                throw new Error('ECHILD');
              }
              const target = childPid === undefined
                ? children.find((child) => child.state === 'zombie')
                : children.find((child) => child.pid === childPid && child.state === 'zombie');
              if (!target) return null;
              processes.delete(target.pid);
              return { pid: target.pid, exitCode: target.exitCode as number };
            },

            get(pid): ProcessInfo | null {
              const process = processes.get(pid);
              return process ? { ...process } : null;
            },

            children(pid): number[] {
              requireProcess(pid);
              return listChildren(pid).map((process) => process.pid);
            },
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 9 关 · 中断与延迟工作                                           */
/* ------------------------------------------------------------------ */

const stage9 = {
  id: 'interrupts-deferred-work',
  title: t('第 9 关 · 中断上半部与延迟工作', 'Stage 9 · Interrupt top halves and deferred work'),
  goal: t(
    [
      '中断处理必须尽快结束。上半部只确认设备状态并收集必要信息，耗时工作放进延迟队列，等内核回到可调度上下文后再执行。',
      '',
      '在 `src/interrupts.ts` 实现中断控制器：',
      '',
      '- 中断向量范围是 0 到 255，同一向量只能注册一次；',
      '- 被 mask 的中断先进入等待队列，unmask 后按到达顺序交付；',
      '- 上半部可以返回一个 deferred 回调，但 `raise()` 不能直接执行它；',
      '- `runDeferred(limit)` 按 FIFO 执行，并遵守本轮上限；',
      '- `pending()` 分别报告被 mask 的事件数和延迟工作数。',
      '',
      '如果上半部直接做完整工作，一个慢设备就能拖住所有中断。这里的队列不是为了异步写法好看，而是为了缩短不可抢占的路径。',
    ].join('\n'),
    [
      'Interrupt handling must finish quickly. The top half acknowledges device state and captures the',
      'minimum data. Longer work goes to a deferred queue and runs after the kernel returns to a schedulable',
      'context.',
      '',
      'Implement the interrupt controller in `src/interrupts.ts`:',
      '',
      '- Vectors range from 0 through 255 and each vector may be registered once;',
      '- Masked interrupts wait and are delivered in arrival order after unmasking;',
      '- A top half may return a deferred callback, but `raise()` must not run it directly;',
      '- `runDeferred(limit)` executes FIFO work and respects the per-run limit;',
      '- `pending()` reports masked events and deferred jobs separately.',
      '',
      'Doing the whole job in the top half lets one slow device hold up every interrupt. The queue shortens',
      'the non-preemptible path; it is not decorative asynchrony.',
    ].join('\n')
  ),
  checklist: [
    t('被 mask 的中断不会提前执行', 'Masked interrupts do not execute early'),
    t('上半部和延迟工作分开运行', 'Top halves and deferred work run separately'),
    t('等待队列与延迟队列都保持 FIFO', 'Both pending and deferred queues preserve FIFO order'),
    t('每轮延迟工作有明确上限', 'Each deferred-work run has an explicit limit'),
  ],
  hints: [
    t('内部保存 `masked Set`、等待事件数组和 deferred 回调数组。', 'Keep a masked Set, a pending event array and a deferred callback array.'),
    t('unmask 时只取出当前向量的事件，其他向量的相对顺序不要改变。', 'When unmasking, extract only that vector without changing the relative order of other events.'),
  ],
  pitfalls: [
    t('raise 里立刻执行 deferred 回调，会让上半部重新变成长路径。', 'Running the deferred callback inside raise turns the top half back into a long path.'),
    t('用一个布尔 pending 位记录被 mask 的中断，会丢掉同一设备连续上报的多个事件。', 'One pending boolean loses repeated events from the same masked device.'),
  ],
  focus: ['correctness', 'latency', 'resilience'],
  lab: {},
  starterFiles: [
    file(
      'src/interrupts.ts',
      code`
        export type DeferredWork = () => void;
        export type TopHalf = (payload: unknown) => DeferredWork | void;

        export interface InterruptController {
          register(vector: number, topHalf: TopHalf): void;
          mask(vector: number): void;
          unmask(vector: number): void;
          raise(vector: number, payload?: unknown): void;
          runDeferred(limit?: number): number;
          pending(): { masked: number; deferred: number };
        }

        export function createInterruptController(): InterruptController {
          // TODO: keep masked events and deferred callbacks in separate FIFO queues
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-9.spec.ts',
      code`
        import { createInterruptController } from '../src/interrupts';

        function errorOf(run: () => void): string {
          try { run(); return ''; } catch (error) { return (error as Error).message; }
        }

        describe('Stage 9 · Interrupts and deferred work', () => {
          it('runs the top half now and defers the returned work', () => {
            const controller = createInterruptController();
            const events: string[] = [];
            controller.register(32, (payload) => {
              events.push('top:' + String(payload));
              return () => events.push('bottom:' + String(payload));
            });
            controller.raise(32, 'timer');
            expect(events).toEqual(['top:timer']);
            expect(controller.pending()).toEqual({ masked: 0, deferred: 1 });
            expect(controller.runDeferred()).toBe(1);
            expect(events).toEqual(['top:timer', 'bottom:timer']);
          });

          it('holds masked interrupts until unmask in arrival order', () => {
            const controller = createInterruptController();
            const events: number[] = [];
            controller.register(40, (payload) => { events.push(Number(payload)); });
            controller.mask(40);
            controller.raise(40, 1);
            controller.raise(40, 2);
            expect(events).toEqual([]);
            expect(controller.pending().masked).toBe(2);
            controller.unmask(40);
            expect(events).toEqual([1, 2]);
          });

          it('does not disturb pending events for another vector', () => {
            const controller = createInterruptController();
            const events: string[] = [];
            controller.register(40, () => { events.push('a'); });
            controller.register(41, () => { events.push('b'); });
            controller.mask(40);
            controller.mask(41);
            controller.raise(40);
            controller.raise(41);
            controller.unmask(41);
            expect(events).toEqual(['b']);
            expect(controller.pending().masked).toBe(1);
          });

          it('limits one deferred-work run and keeps FIFO order', () => {
            const controller = createInterruptController();
            const events: number[] = [];
            controller.register(50, (payload) => () => events.push(Number(payload)));
            controller.raise(50, 1);
            controller.raise(50, 2);
            controller.raise(50, 3);
            expect(controller.runDeferred(2)).toBe(2);
            expect(events).toEqual([1, 2]);
            expect(controller.pending().deferred).toBe(1);
            controller.runDeferred();
            expect(events).toEqual([1, 2, 3]);
          });

          it('rejects unknown, duplicate and out-of-range vectors', () => {
            const controller = createInterruptController();
            expect(errorOf(() => controller.raise(1))).toBe('EINVAL');
            expect(errorOf(() => controller.register(256, () => {}))).toBe('EINVAL');
            controller.register(1, () => {});
            expect(errorOf(() => controller.register(1, () => {}))).toBe('EEXIST');
          });
        });
      `
    ),
  ],
  referenceFiles: [
    file(
      'src/interrupts.ts',
      code`
        export type DeferredWork = () => void;
        export type TopHalf = (payload: unknown) => DeferredWork | void;

        interface PendingInterrupt {
          vector: number;
          payload: unknown;
        }

        export interface InterruptController {
          register(vector: number, topHalf: TopHalf): void;
          mask(vector: number): void;
          unmask(vector: number): void;
          raise(vector: number, payload?: unknown): void;
          runDeferred(limit?: number): number;
          pending(): { masked: number; deferred: number };
        }

        export function createInterruptController(): InterruptController {
          const handlers = new Map<number, TopHalf>();
          const masked = new Set<number>();
          let pendingInterrupts: PendingInterrupt[] = [];
          const deferred: DeferredWork[] = [];

          function validVector(vector: number): boolean {
            return Number.isInteger(vector) && vector >= 0 && vector <= 255;
          }

          function requireHandler(vector: number): TopHalf {
            if (!validVector(vector)) throw new Error('EINVAL');
            const handler = handlers.get(vector);
            if (!handler) throw new Error('EINVAL');
            return handler;
          }

          function deliver(vector: number, payload: unknown): void {
            const work = requireHandler(vector)(payload);
            if (typeof work === 'function') deferred.push(work);
          }

          return {
            register(vector, topHalf): void {
              if (!validVector(vector)) throw new Error('EINVAL');
              if (handlers.has(vector)) throw new Error('EEXIST');
              handlers.set(vector, topHalf);
            },

            mask(vector): void {
              requireHandler(vector);
              masked.add(vector);
            },

            unmask(vector): void {
              requireHandler(vector);
              masked.delete(vector);
              const deliverNow = pendingInterrupts.filter((event) => event.vector === vector);
              pendingInterrupts = pendingInterrupts.filter((event) => event.vector !== vector);
              deliverNow.forEach((event) => deliver(event.vector, event.payload));
            },

            raise(vector, payload): void {
              requireHandler(vector);
              if (masked.has(vector)) pendingInterrupts.push({ vector, payload });
              else deliver(vector, payload);
            },

            runDeferred(limit = Number.POSITIVE_INFINITY): number {
              if (limit < 0 || Number.isNaN(limit)) throw new Error('EINVAL');
              let ran = 0;
              while (deferred.length && ran < limit) {
                (deferred.shift() as DeferredWork)();
                ran += 1;
              }
              return ran;
            },

            pending(): { masked: number; deferred: number } {
              return { masked: pendingInterrupts.length, deferred: deferred.length };
            },
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 10 关 · Futex                                                   */
/* ------------------------------------------------------------------ */

const stage10 = {
  id: 'futex',
  title: t('第 10 关 · Futex 与无丢失唤醒', 'Stage 10 · Futexes without lost wakeups'),
  goal: t(
    [
      '用户态互斥锁不该每次操作都陷入内核。没有竞争时，原子指令就能完成；只有发现锁值仍然等于预期值时，线程才通过 futex 进入等待队列。',
      '',
      '在 `src/futex.ts` 实现最小 futex 服务：',
      '',
      '- `wait(index, expected, id)` 先原子比较当前值，不相等时立即返回 `not-equal`；',
      '- 值相等时按地址进入 FIFO 等待队列；',
      '- `wake(index, count)` 最多唤醒指定数量，并返回被唤醒的 waiter id；',
      '- 不同地址的等待队列互不影响；',
      '- `cancel(id)` 能移除一个等待者并让它得到 `cancelled`。',
      '',
      '比较和入队必须是一个不可分割的动作。如果先比较、稍后再入队，wake 可能正好落在两步之间，线程随后睡下却再也收不到那次唤醒。',
    ].join('\n'),
    [
      'A user-space mutex should not enter the kernel on every operation. Atomic instructions handle the',
      'uncontended path. A thread calls futex wait only when the lock word still matches an expected value.',
      '',
      'Implement a minimal futex service in `src/futex.ts`:',
      '',
      '- `wait(index, expected, id)` compares atomically and returns `not-equal` immediately on a mismatch;',
      '- A matching waiter joins a FIFO queue for that address;',
      '- `wake(index, count)` wakes at most that many waiters and returns their ids;',
      '- Wait queues for different addresses remain independent;',
      '- `cancel(id)` removes one waiter and resolves it as `cancelled`.',
      '',
      'Comparison and queue insertion must be indivisible. If wake lands between a separate compare and',
      'enqueue, the thread goes to sleep after the wake and may never receive another one.',
    ].join('\n')
  ),
  checklist: [
    t('值不匹配时不进入等待队列', 'A mismatched value never enters a wait queue'),
    t('同一地址按 FIFO 唤醒', 'Waiters on one address wake in FIFO order'),
    t('唤醒数量不会超过 count', 'Wake never exceeds the requested count'),
    t('取消等待不会影响其他线程', 'Cancelling one waiter leaves the others intact'),
  ],
  hints: [
    t('用 `Map<index, Waiter[]>` 保存地址队列，再用一张 id 索引支持 cancel。', 'Use `Map<index, Waiter[]>` for address queues and a second id index for cancellation.'),
    t('wait 的值比较要在创建 Promise 和入队之前同步完成。', 'Perform the wait comparison synchronously before creating and enqueueing the Promise.'),
  ],
  pitfalls: [
    t('store 自动唤醒所有等待者，会把普通内存写和 futex wake 的语义混在一起。', 'Automatically waking on store confuses a normal memory write with an explicit futex wake.'),
    t('wake 先删 id 索引、稍后才出队，异常路径会留下一个无法取消的幽灵 waiter。', 'Deleting the id index before removing the queue entry can leave a waiter that can no longer be cancelled.'),
  ],
  focus: ['correctness', 'concurrency', 'resilience'],
  lab: {},
  starterFiles: [
    file(
      'src/futex.ts',
      code`
        export type WaitResult = 'ok' | 'not-equal' | 'cancelled';

        export interface FutexMemory {
          load(index: number): number;
          store(index: number, value: number): void;
          wait(index: number, expected: number, waiterId: string): Promise<WaitResult>;
          wake(index: number, count: number): string[];
          cancel(waiterId: string): boolean;
          waiting(index: number): number;
        }

        export function createFutexMemory(initial: number[]): FutexMemory {
          // TODO: make compare-and-queue atomic and keep one FIFO per address
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-10.spec.ts',
      code`
        import { createFutexMemory } from '../src/futex';
        import { count } from '@lab/metrics';

        describe('Stage 10 · Futex', () => {
          it('returns immediately when the value no longer matches', async () => {
            const futex = createFutexMemory([0]);
            expect(await futex.wait(0, 1, 'a')).toBe('not-equal');
            expect(futex.waiting(0)).toBe(0);
          });

          it('queues matching waiters and wakes in FIFO order', async () => {
            const futex = createFutexMemory([1]);
            const first = futex.wait(0, 1, 'first');
            const second = futex.wait(0, 1, 'second');
            expect(futex.wake(0, 1)).toEqual(['first']);
            expect(await first).toBe('ok');
            expect(futex.waiting(0)).toBe(1);
            expect(futex.wake(0, 2)).toEqual(['second']);
            expect(await second).toBe('ok');
          });

          it('keeps queues for separate addresses independent', async () => {
            const futex = createFutexMemory([1, 1]);
            const left = futex.wait(0, 1, 'left');
            const right = futex.wait(1, 1, 'right');
            expect(futex.wake(1, 1)).toEqual(['right']);
            expect(await right).toBe('ok');
            expect(futex.waiting(0)).toBe(1);
            futex.wake(0, 1);
            expect(await left).toBe('ok');
          });

          it('does not lose a wake between store and wait', async () => {
            const futex = createFutexMemory([1]);
            futex.store(0, 0);
            expect(await futex.wait(0, 1, 'late')).toBe('not-equal');
            expect(futex.wake(0, 1)).toEqual([]);
          });

          it('cancels one waiter without waking its neighbours', async () => {
            const futex = createFutexMemory([1]);
            const first = futex.wait(0, 1, 'first');
            const second = futex.wait(0, 1, 'second');
            expect(futex.cancel('first')).toBe(true);
            expect(await first).toBe('cancelled');
            expect(futex.wake(0, 1)).toEqual(['second']);
            expect(await second).toBe('ok');
            expect(futex.cancel('missing')).toBe(false);
          });

          it('tracks a bounded waiting set [gate:waiters]', async () => {
            const futex = createFutexMemory([1]);
            const first = futex.wait(0, 1, 'a');
            const second = futex.wait(0, 1, 'b');
            count('futexWaiters', futex.waiting(0));
            futex.wake(0, 2);
            await first;
            await second;
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.futexWaiters',
      op: 'eq',
      value: 2,
      unit: 'waiters',
      zh: '两个竞争线程必须进入同一地址的等待队列',
      en: 'Two contending threads must appear in the same address wait queue',
      dimension: 'concurrency',
      scope: 'gate:waiters',
    }),
  ],
  referenceFiles: [
    file(
      'src/futex.ts',
      code`
        export type WaitResult = 'ok' | 'not-equal' | 'cancelled';

        interface Waiter {
          id: string;
          index: number;
          resolve(result: WaitResult): void;
        }

        export interface FutexMemory {
          load(index: number): number;
          store(index: number, value: number): void;
          wait(index: number, expected: number, waiterId: string): Promise<WaitResult>;
          wake(index: number, count: number): string[];
          cancel(waiterId: string): boolean;
          waiting(index: number): number;
        }

        export function createFutexMemory(initial: number[]): FutexMemory {
          const memory = initial.slice();
          const queues = new Map<number, Waiter[]>();
          const byId = new Map<string, Waiter>();

          function validIndex(index: number): boolean {
            return Number.isInteger(index) && index >= 0 && index < memory.length;
          }

          function requireIndex(index: number): void {
            if (!validIndex(index)) throw new Error('EFAULT');
          }

          function queueOf(index: number): Waiter[] {
            const existing = queues.get(index);
            if (existing) return existing;
            const created: Waiter[] = [];
            queues.set(index, created);
            return created;
          }

          return {
            load(index): number {
              requireIndex(index);
              return memory[index];
            },

            store(index, value): void {
              requireIndex(index);
              memory[index] = value;
            },

            wait(index, expected, waiterId): Promise<WaitResult> {
              requireIndex(index);
              if (byId.has(waiterId)) throw new Error('EEXIST');
              if (memory[index] !== expected) return Promise.resolve('not-equal');
              return new Promise<WaitResult>((resolve) => {
                const waiter = { id: waiterId, index, resolve };
                queueOf(index).push(waiter);
                byId.set(waiterId, waiter);
              });
            },

            wake(index, count): string[] {
              requireIndex(index);
              if (!Number.isInteger(count) || count < 0) throw new Error('EINVAL');
              const queue = queueOf(index);
              const woken: string[] = [];
              while (queue.length && woken.length < count) {
                const waiter = queue.shift() as Waiter;
                byId.delete(waiter.id);
                woken.push(waiter.id);
                waiter.resolve('ok');
              }
              if (queue.length === 0) queues.delete(index);
              return woken;
            },

            cancel(waiterId): boolean {
              const waiter = byId.get(waiterId);
              if (!waiter) return false;
              const queue = queueOf(waiter.index);
              const index = queue.findIndex((item) => item.id === waiterId);
              if (index >= 0) queue.splice(index, 1);
              if (queue.length === 0) queues.delete(waiter.index);
              byId.delete(waiterId);
              waiter.resolve('cancelled');
              return true;
            },

            waiting(index): number {
              requireIndex(index);
              return queues.get(index)?.length || 0;
            },
          };
        }
      `
    ),
  ],
};

module.exports = {
  id: 'modern-os-kernel',
  title: t('从 0 写一个现代操作系统内核', 'Build a modern operating system kernel from scratch'),
  summary: t(
    '从启动内存图开始，依次实现虚拟内存、抢占调度、系统调用、VFS 与进程生命周期。最后处理硬中断和 Futex，共十关。',
    'Start with the boot memory map, then implement virtual memory, preemptive scheduling, syscalls, a VFS and process lifecycle. Hardware interrupts and futexes complete the ten-stage project.'
  ),
  difficulty: 'Hard',
  domain: 'operating-systems',
  tags: ['kernel', 'memory', 'scheduler', 'syscalls', 'vfs', 'ipc', 'copy-on-write'],
  estimatedMinutes: 450,
  language: 'typescript',
  weights: {
    correctness: 3,
    concurrency: 1.5,
    latency: 1.5,
    resilience: 2,
    encapsulation: 2,
    elegance: 1,
  },
  brief: t(
    [
      '## 你会实现哪些内核机制',
      '',
      '项目从启动时拿到的一张物理内存图开始。你先实现页框分配和虚拟地址空间，',
      '再让任务按时间片运行，并通过系统调用和句柄访问内核资源。文件、管道、fork、',
      '退出与 wait 会把内存、调度和资源生命周期接在一起。最后两关处理硬中断的延迟工作，',
      '以及 Futex 的用户态快路径和等待队列。',
      '',
      '这些模块共用状态。页表映射要消耗第 1 关的页框，写时复制依赖页权限与引用计数，',
      '管道阻塞会把任务交回调度器，进程退出还要关闭句柄并唤醒 wait。单独写对一个函数不够，',
      '内核必须在失败、阻塞和进程消失时把账收平。',
      '',
      '## 十关的工作范围',
      '',
      '| 关卡 | 模块 | 要解决的问题 |',
      '| --- | --- | --- |',
      '| 1 | 物理页框分配器 | 哪些内存能用，如何避免重复分配 |',
      '| 2 | 虚拟内存 | 地址翻译、用户与内核隔离、W^X |',
      '| 3 | 抢占调度器 | 时间片、公平性、阻塞与唤醒 |',
      '| 4 | 系统调用与句柄 | 用户态如何安全地请求内核服务 |',
      '| 5 | VFS | 统一路径、文件描述符和读写语义 |',
      '| 6 | 管道 | 有界缓冲、阻塞、EOF 与 EPIPE |',
      '| 7 | 写时复制 | fork 如何共享内存，又不互相污染 |',
      '| 8 | 进程表 | 退出状态、孤儿进程和僵尸回收 |',
      '| 9 | 中断 | 上半部、mask 和延迟工作 |',
      '| 10 | Futex | 用户态快路径、等待队列和无丢失唤醒 |',
      '',
      '## 重点会卡在哪里',
      '',
      '内核代码最难的部分通常不在正常路径。页框不能重复分配或重复释放，用户地址不能绕过权限，',
      '调度器不能让阻塞任务继续占用 CPU。管道需要在容量满时阻塞写者，并在最后一个端点关闭时',
      '给出正确的 EOF 或 EPIPE。Futex 则要避免「检查条件」和「进入等待」之间丢掉一次唤醒。',
      '',
      '资源生命周期也会跨模块。fork 后的页面共享到第一次写入为止；父进程退出后，孤儿要重新归属；',
      '子进程退出后，退出状态要保留到 wait 消费，随后僵尸才能从进程表移除。',
      '',
      '## 运行和验收方式',
      '',
      'AlgoLocal 的工程运行器执行 TypeScript 和 JavaScript，不能启动真实的 x86 或 RISC-V 镜像。',
      '启动汇编、寄存器切换和 MMU 指令因此被收成可测试的接口。代码仍会维护页表、运行队列、',
      '句柄表、文件描述符和等待队列，并执行对应的状态转换。',
      '',
      '验收会检查返回结果，也会检查状态守恒和错误路径。重复释放、越权访问、失控缓冲、',
      '丢失唤醒和僵尸泄漏都有单独用例。',
      '',
      '## 项目边界',
      '',
      '这是内核机制的可执行模型，不包含启动汇编、真实设备驱动或可引导镜像。',
      '项目关注资源管理、隔离、阻塞与唤醒语义，不要求处理具体 CPU 的特权指令。',
    ].join('\n'),
    [
      '## Kernel mechanisms you will implement',
      '',
      'The project begins with the physical memory map available at boot. You first implement frame',
      'allocation and virtual address spaces, then schedule tasks with time slices and expose kernel',
      'resources through syscalls and handles. Files, pipes, fork, exit, and wait connect memory,',
      'scheduling, and resource lifetimes. The last two stages handle deferred interrupt work and',
      'a Futex with a user-space fast path and kernel wait queues.',
      '',
      'The modules share state. Page mappings consume frames from stage 1, copy-on-write depends on',
      'page permissions and reference counts, a blocked pipe returns its task to the scheduler, and',
      'process exit must close handles and wake waiters. Correct isolated functions are not enough.',
      'The kernel has to balance its accounting through failures, blocking, and process removal.',
      '',
      '## Scope of the ten stages',
      '',
      '| Stage | Module | Problem |',
      '| --- | --- | --- |',
      '| 1 | Physical frame allocator | Which memory is usable and how double allocation is prevented |',
      '| 2 | Virtual memory | Translation, user and kernel isolation, and W^X |',
      '| 3 | Preemptive scheduler | Time slices, fairness, blocking and wakeups |',
      '| 4 | Syscalls and handles | How user mode safely requests kernel services |',
      '| 5 | VFS | Common paths, descriptors and I/O semantics |',
      '| 6 | Pipes | Bounded buffers, blocking, EOF and EPIPE |',
      '| 7 | Copy-on-write | How fork shares memory without sharing later writes |',
      '| 8 | Process table | Exit status, orphans and zombie reaping |',
      '| 9 | Interrupts | Top halves, masking and deferred work |',
      '| 10 | Futex | User-space fast paths, wait queues and wakeups without loss |',
      '',
      '## Where the difficult cases are',
      '',
      'Kernel failures tend to live outside the happy path. A frame must not be allocated or freed twice,',
      'a user address must not bypass permissions, and a blocked task must not keep its CPU slot. Pipes',
      'block writers at capacity and return the correct EOF or EPIPE after the final endpoint closes.',
      'A Futex must not lose a wakeup between checking its value and joining the wait queue.',
      '',
      'Resource lifetimes cross module boundaries too. Pages after fork remain shared until the first',
      'write. Orphans need a new parent when their original parent exits. A child exit status stays until',
      'wait consumes it, after which the zombie can leave the process table.',
      '',
      '## Runtime and acceptance',
      '',
      'The AlgoLocal engineering runner executes TypeScript and JavaScript, so it cannot boot a real x86',
      'or RISC-V image. Boot assembly, register switching, and MMU instructions become testable',
      'interfaces. Your code still maintains page tables, run queues, handle tables, file descriptors,',
      'and wait queues and performs the corresponding state transitions.',
      '',
      'Acceptance checks return values, state conservation, and failure paths. Double frees, privilege',
      'leaks, unbounded buffers, lost wakeups, and unreaped zombies have separate cases.',
      '',
      '## Project boundary',
      '',
      'This is an executable model of kernel mechanisms. It does not include boot assembly, physical',
      'device drivers, or a bootable image. The project covers resource management, isolation, blocking,',
      'and wakeup semantics without requiring privileged instructions from a particular CPU.',
    ].join('\n')
  ),
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  B[启动内存图] --> P[物理页框分配器]',
      '  P --> V[虚拟地址空间]',
      '  V --> C[写时复制]',
      '  T[时钟 tick] --> S[抢占调度器]',
      '  U[用户进程] --> Y[系统调用边界]',
      '  Y --> H[句柄表]',
      '  H --> F[VFS]',
      '  H --> I[管道 IPC]',
      '  S --> R[进程表与 wait]',
      '  D[设备] --> N[中断上半部]',
      '  N --> W[延迟工作]',
      '  U --> X[Futex 等待队列]',
      '```',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  B[boot memory map] --> P[physical frame allocator]',
      '  P --> V[virtual address spaces]',
      '  V --> C[copy-on-write]',
      '  T[timer tick] --> S[preemptive scheduler]',
      '  U[user process] --> Y[syscall boundary]',
      '  Y --> H[handle table]',
      '  H --> F[VFS]',
      '  H --> I[pipe IPC]',
      '  S --> R[process table and wait]',
      '  D[device] --> N[interrupt top half]',
      '  N --> W[deferred work]',
      '  U --> X[futex wait queues]',
      '```',
    ].join('\n')
  ),
  files: [],
  stages: [stage1, stage2, stage3, stage4, stage5, stage6, stage7, stage8, stage9, stage10],
};
