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

#endif
`;

/** 挂进机器磁盘的那几个头文件 */
export const HOST_HEADERS: Record<string, string> = {
  '/root/containers.h': CONTAINERS_H,
  '/root/engine.h': ENGINE_H,
  '/root/cuda_runtime.h': CUDA_RUNTIME_H,
};
