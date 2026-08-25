/**
 * 网络的语义模型
 *
 * 不做协议字节，做**连接结果的语义**。这条线是刻意划的：学员从网络问题里
 * 真正要学会的是「连不上时，从症状反推是哪一层的问题」，而症状恰恰是
 * 少数几种可区分的结果，不是字节流。
 *
 *   refused  端口上没人听        → 应用没起来 / 端口写错
 *   timeout  包被丢了            → 策略拦了 / 路由不通（**不会**回 RST）
 *   reset    连上了又被掐断      → 后端崩了 / 中间件主动断
 *   no route 目标地址不可达      → 网段隔离
 *   dns      名字解析不出来      → Service 名写错 / DNS 被策略切断
 *
 * 「被 NetworkPolicy 拒绝表现为超时而不是拒绝」是这套语义里最要紧的一条，
 * 也是第 10 关的核心：学员必须能从「卡住」而不是「立刻失败」认出这是策略问题。
 */

/** 网络分区。跳板机在办公网，Pod 在集群网，外网是另一个世界。 */
export type Zone = 'office' | 'internet' | 'cluster' | 'node';

export type ConnectKind = 'ok' | 'refused' | 'timeout' | 'reset' | 'no-route' | 'dns-failure';

/** 一跳。包路径回放与拓扑的数据面层都读它。 */
export interface Hop {
  /** 这一跳发生在哪：`pod/payments/portal-x`、`svc/payments/portal`、`policy/deny-all` */
  at: string;
  /** 干了什么 */
  detail: string;
  verdict: 'forward' | 'deliver' | 'drop' | 'reject';
  /** 虚拟耗时（毫秒） */
  elapsedMs: number;
}

export interface ConnectResult {
  kind: ConnectKind;
  /** HTTP 请求时才有 */
  status?: number;
  body?: string;
  /** 走过的每一跳，按顺序 */
  hops: Hop[];
  /** 被谁挡了：策略名、或者「no listener」这类原因 */
  blockedBy?: string;
  /** 总耗时（虚拟毫秒）。超时的话就是超时时长。 */
  elapsedMs: number;
}

/** 谁在发起连接 */
export interface Source {
  zone: Zone;
  /** 在集群里发起时，是哪个 Pod */
  namespace?: string;
  podName?: string;
  ip?: string;
  /** 显示用，如 `jump-01` */
  label: string;
}

/** 要连到哪 */
export interface Target {
  /** 主机名或 IP，学员敲进去的那个 */
  host: string;
  port: number;
  /** HTTP 请求时才有 */
  path?: string;
  method?: string;
  tls?: boolean;
  /** TLS 时的 SNI，缺省用 host */
  serverName?: string;
  /**
   * 直接连这个地址，不查 DNS。
   *
   * `curl --resolve host:port:addr` 就是这么干的：DNS 还没改过来的时候，
   * 拿它先把路由验通。
   */
  address?: string;
  /** Host 头。Gateway 与 HTTPRoute 匹配的是它，不是连过去的那个地址。 */
  headerHost?: string;
  /** `curl -k`：跳过证书校验 */
  insecure?: boolean;
}

/** DNS 查出来的东西 */
export interface Resolution {
  /** 问的是什么 */
  question: string;
  /** 实际查到的完整名字（走完 search 之后） */
  canonical?: string;
  addresses: string[];
  /** 解析路上试过哪些名字 —— ndots 的效果全在这里 */
  attempts: string[];
  kind: 'service' | 'headless' | 'external' | 'pod' | 'host' | 'nxdomain';
}
