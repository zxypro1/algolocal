/**
 * 平台提供的只读头文件
 *
 * 学员能 `cat` 它们，能 `#include` 它们，但改不了 —— 它们是**接口的
 * 契约**，不是可以顺手改一行的代码。里面全是原型声明，实现在平台侧
 * （见 `containers.ts` 与 `runtime.ts`）。
 *
 * 这些原型必须和编译器里 `HOST_FNS` 的签名对得上。对不上的话
 * 学员按头文件写就会撞上编译错误，而头文件是他唯一的参考 ——
 * `tests/gpulab/host.test.ts` 里有一条用例把两边钉在一起。
 */

export const CONTAINERS_H = `/* containers.h -- 平台提供的容器，实现不在你这边
 *
 * 这个 CUDA 子集里没有 struct，也没有宿主堆。分页 KV 的块表、
 * 连续批处理的请求队列这些东西要的是「一个能用的动态数组 / 哈希表 /
 * 队列」，不是一堂用裸指针搓容器的课 —— 真实工程里它们也从来
 * 不是自己写的（vLLM 用 Python 的 list 与 dict，TensorRT-LLM 用 STL）。
 *
 * 每个容器用一个 int 句柄表示。句柄从 1 开始，0 永远是无效的 ——
 * 忘了初始化的变量在 C 里是 0，于是会立刻报错而不是悄悄操作别人的容器。
 */
#ifndef CONTAINERS_H
#define CONTAINERS_H

/* ---- vec：可变长的 int 数组 ---- */
int  vec_new(void);
void vec_push(int v, int value);
int  vec_pop(int v);              /* 弹出末尾；空的时候报错 */
int  vec_get(int v, int index);   /* 越界报错，不是未定义行为 */
void vec_set(int v, int index, int value);
int  vec_len(int v);
void vec_clear(int v);

/* ---- map：int64 键 -> int32 值 ---- */
int  map_new(void);
void map_set(int m, int key, int value);
int  map_get(int m, int key, int fallback);   /* 没有这个键就返回 fallback */
int  map_has(int m, int key);
void map_del(int m, int key);
int  map_len(int m);

/* ---- ring：先进先出队列 ---- */
int  ring_new(void);
void ring_push(int r, int value);
int  ring_pop(int r);             /* 取出队头；空的时候报错 */
int  ring_peek(int r);            /* 看一眼队头，不取出 */
int  ring_len(int r);

#endif
`;

export const ENGINE_H = `/* engine.h -- 平台把数据交给你的地方
 *
 * 真实的推理引擎从权重加载器拿张量。这里是同一件事的最小版本：
 * 关卡准备好若干个缓冲区（内容是确定的，判定知道它们是什么），
 * 你的 main 用 lab_buffer(i) 拿到它们的**设备指针**，正常传给 kernel。
 *
 * 编号就是关卡描述里列出的顺序，从 0 开始。
 */
#ifndef ENGINE_H
#define ENGINE_H

float* lab_buffer(int index);      /* 第 index 个缓冲区的设备指针 */
int    lab_buffer_len(int index);  /* 它有多少个 float */

#endif
`;

export const CUDA_RUNTIME_H = `/* cuda_runtime.h -- 这个子集支持的 CUDA runtime
 *
 * 名字与签名和真 CUDA 一致，你在真卡上敲的就是这几行。
 * 没列出来的（流、事件、异步拷贝、统一内存）这个子集还不支持，
 * 用了会明确报错而不是悄悄跑错。
 */
#ifndef CUDA_RUNTIME_H
#define CUDA_RUNTIME_H

/* cudaMemcpy 的方向。**这个参数不是装饰** ——
 * 主机内存与设备内存在这里是真的两个地址空间，方向写错会搬错东西。 */
#define cudaMemcpyHostToHost     0
#define cudaMemcpyHostToDevice   1
#define cudaMemcpyDeviceToHost   2
#define cudaMemcpyDeviceToDevice 3

/* 第一个参数只支持 (void**)&指针 这一种写法 */
int cudaMalloc(void** devicePtr, int bytes);
int cudaFree(void* devicePtr);
int cudaMemcpy(void* dst, const void* src, int bytes, int kind);
int cudaMemset(void* devicePtr, int value, int bytes);
int cudaDeviceSynchronize(void);

/* ---- 流 ----
 *
 * 起 kernel 时指定流：kernel<<<grid, block, 0, stream>>>(...)
 * 第三个参数（动态共享内存）必须写 0，那个还不支持。
 *
 * ⚠️ **一处要说清楚的偏差**：这个模拟器是**即时执行**的 ——
 * kernel 在 launch 那一刻就跑完了，流不改变执行顺序，也**不检测
 * 跨流的数据竞争**。流在这里的作用是记账：平台据此回答
 * "发起这次集合通信时，别的流上还有没有计算在飞"，也就是重叠率。
 *
 * 真卡上把有依赖的活放到不同的流上而不 cudaStreamWaitEvent，
 * 是一个会静默出错的严重问题。这个子集查不出来，别养成习惯。 */
int cudaStreamCreate(int* stream);
int cudaStreamSynchronize(int stream);
int cudaStreamDestroy(int stream);

/* ---- CUDA Graph ----
 *
 * 把一串 launch 录下来，之后一次重放。省下来的是**提交开销** ——
 * kernel 该干的活一点没少。解码那种"每步计算量很小、kernel 又很多"的
 * 场景里，提交开销本身就是瓶颈。
 *
 * ⚠️ 录下来的是**捕获那一刻的实参值**。指针是稳定的地址，重放没问题；
 * 而按值传的标量录下来就定死了，之后再变也不会生效。
 * 真实引擎的解法是把会变的量放进显存、让 kernel 从指针读。
 *
 * 出参写成 &变量（和 cudaMalloc 一个路子）。
 */
#define cudaStreamCaptureModeGlobal       0
#define cudaStreamCaptureModeThreadLocal  1
#define cudaStreamCaptureModeRelaxed      2

int cudaStreamBeginCapture(int stream, int mode);
int cudaStreamEndCapture(int stream, int* graph);
int cudaGraphInstantiate(int* graphExec, int graph, int flags);
int cudaGraphLaunch(int graphExec, int stream);
int cudaGraphDestroy(int graph);
int cudaGraphExecDestroy(int graphExec);

#endif
`;

export const CUDA_FP8_H = `/* cuda_fp8.h -- fp8 转换
 *
 * 名字、参数、枚举取值都和真 CUDA 一致。
 *
 * **一处刻意的偏差**：真 API 的 __nv_cvt_fp8_to_halfraw 返回 __half_raw
 * （一个结构体，取值要写 .x），这个子集没有 struct，所以直接返回 half。
 * 语义没有区别，写法上少一次 .x。
 *
 * 另外：fp8 在这里没有独立的存储类型。真 CUDA 有 __nv_fp8_storage_t
 * （一个 unsigned char）与 __nv_fp8x4_e4m3（一个 32 位、装 4 个）。
 * 这个子集的显存按 4 字节寻址，所以照真实 kernel 的做法来：
 * 自己把 4 个 8 位存储移位拼进一个 int，读的时候再拆开。
 * 量化省下来的显存因此是真的省下来了，ncu 上量得出来。
 */
#ifndef CUDA_FP8_H
#define CUDA_FP8_H

/* __nv_saturation_t */
#define __NV_NOSAT      0
#define __NV_SATFINITE  1   /* 溢出夹到最大有限值，推理里的默认 */

/* __nv_fp8_interpretation_t */
#define __NV_E4M3  0   /* 4 位指数 3 位尾数，最大 448，没有 inf。权重与激活用它 */
#define __NV_E5M2  1   /* 5 位指数 2 位尾数，最大 57344，有 inf。梯度用它 */

/* float -> fp8 的 8 位存储（0..255） */
int  __nv_cvt_float_to_fp8(float x, int saturate, int interpretation);
/* fp8 存储 -> half */
half __nv_cvt_fp8_to_halfraw(int storage, int interpretation);

#endif
`;

export const NCCL_H = `/* nccl.h -- 集合通信
 *
 * 名字与参数顺序和真 NCCL 一致。一处偏差：
 * 通信子是一个 int（就是它所在那张卡的编号），不是不透明句柄。
 *
 * devlist 决定第 i 个 rank 在哪张卡上。**它不是摆设** ——
 * ring 是按实际的卡走的，一个组摊在两台机器上时环上就会有跨机的边。
 * 传 0 表示用 0..ndev-1。
 *
 * ⚠️ **单线程管多张卡时，集合操作必须放在 ncclGroupStart / ncclGroupEnd 之间。**
 * 每个 NCCL 调用都可能阻塞在等对端上，不成组就会死锁 ——
 * 这一条是 NVIDIA 文档里明写的，这里不成组会直接报错而不是跑出个结果。
 */
#ifndef NCCL_H
#define NCCL_H

/* ncclDataType_t */
#define ncclFloat  0
#define ncclInt    1

/* ncclRedOp_t */
#define ncclSum   0
#define ncclProd  1
#define ncclMax   2
#define ncclMin   3

#define ncclSuccess 0

int ncclCommInitAll(int* comms, int ndev, const int* devlist);
int ncclCommDestroy(int comm);

int ncclGroupStart(void);
int ncclGroupEnd(void);

int ncclAllReduce(const void* send, void* recv, int count, int datatype,
                  int op, int comm, int stream);
int ncclAllGather(const void* send, void* recv, int sendcount, int datatype,
                  int comm, int stream);
int ncclReduceScatter(const void* send, void* recv, int recvcount, int datatype,
                      int op, int comm, int stream);
int ncclBroadcast(const void* send, void* recv, int count, int datatype,
                  int root, int comm, int stream);
int ncclReduce(const void* send, void* recv, int count, int datatype,
               int op, int root, int comm, int stream);

#endif
`;

export const CLUSTER_H = `/* cluster.h -- 多卡
 *
 * 每张卡有自己的地址空间。**一张卡的指针在另一张卡上是非法的** ——
 * 真卡上误用会得到 illegal memory access，这里会直接报错告诉你
 * 那是哪张卡的指针。要跨卡搬数据，用 cudaMemcpyPeer。
 */
#ifndef CLUSTER_H
#define CLUSTER_H

int cudaGetDeviceCount(int* count);
int cudaSetDevice(int device);
int cudaGetDevice(int* device);
int cudaMemcpyPeer(void* dst, int dstDevice, const void* src, int srcDevice, int bytes);

/* 流水线调度：声明一个步边界。
 *
 * 真硬件上没有这个函数 —— 流水线的"步"是 nsys 时间线上看出来的，
 * 不是程序里声明的。这里让你显式声明，是因为气泡率要**数**出来：
 * 平台记下每一步里哪几张卡真的干了活。
 *
 *   气泡率 = 1 - 干活的(步, 卡)格子数 / (步数 x 卡数)
 *
 * 少报步数能让这个数好看，所以判定同时校验总工作量 —— 两头对上才算数。 */
void pipe_step(void);

#endif
`;

/** 挂进机器磁盘的那几个头文件 */
export const HOST_HEADERS: Record<string, string> = {
  '/root/containers.h': CONTAINERS_H,
  '/root/engine.h': ENGINE_H,
  '/root/cuda_runtime.h': CUDA_RUNTIME_H,
  '/root/cuda_fp8.h': CUDA_FP8_H,
  '/root/nccl.h': NCCL_H,
  '/root/cluster.h': CLUSTER_H,
};
