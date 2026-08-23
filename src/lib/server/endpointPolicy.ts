/**
 * 「这个地址允许请求吗」的唯一判定处。
 *
 * 部署形态决定了风险，不是一刀切：
 *
 * - **桌面版（Electron）**：Next 服务跑在用户自己机器上，只有用户自己能访问。
 *   他想请求哪个地址，直接 curl 就行了，拦他没有任何意义。
 * - **自托管**：运维者就是使用者，同上。
 * - **公网多租户部署**：这时才有真问题 —— 匿名访客可以把端点填成
 *   `http://169.254.169.254/latest/meta-data/`（云厂商元数据）或者内网服务地址，
 *   借服务端去探测内网。
 *
 * main 上目前只有前两种形态，所以默认放开；公网部署把
 * AI_ENDPOINT_BLOCK_PRIVATE_NETWORK 设成 1 即可挡掉内网与回环地址。
 */

import { isPrivateHostname } from '../endpointHosts';

export { isPrivateHostname };

/** 公网部署把这个环境变量打开，就会拒绝内网/回环地址 */
export function blocksPrivateNetwork(): boolean {
  const flag = process.env.AI_ENDPOINT_BLOCK_PRIVATE_NETWORK;
  return flag === '1' || flag === 'true';
}

export interface EndpointCheck {
  ok: boolean;
  reason?: string;
}

/**
 * 判断一个已经规整过的地址能不能请求。
 * 只做协议校验和（可选的）内网拦截 —— 其余交给实际请求去报错，
 * 那个错误信息比这里猜更有用。
 */
export function checkEndpoint(rawUrl: string): EndpointCheck {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `Not a valid URL: ${rawUrl}` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only http and https endpoints are supported.' };
  }

  if (blocksPrivateNetwork() && isPrivateHostname(url.hostname)) {
    return {
      ok: false,
      reason:
        'This deployment does not allow endpoints on private or loopback addresses. Use a public https endpoint.',
    };
  }

  return { ok: true };
}

