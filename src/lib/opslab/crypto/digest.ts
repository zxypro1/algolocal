/**
 * SHA-256，输出原始字节
 *
 * 镜像那边已经有一份十六进制的实现（machine/oci/digest.ts），这里只是把
 * 同一套算法的字节形式导出来给签名用 —— 复用它而不是再写一遍。
 */
import { sha256Hex } from '../machine/oci/digest';

export function sha256Bytes(input: Uint8Array | string): Uint8Array {
  const hex = sha256Hex(input);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export { sha256Hex };
