/**
 * RSASSA-PKCS1-v1_5 with SHA-256
 *
 * 真的签、真的验。选 PKCS#1 v1.5 而不是 PSS，是因为它**没有随机数** ——
 * 同样的输入签出同样的字节，重放才可能逐字节一致。
 *
 * 只有模幂一处是自己写的（BigInt 的平方乘），2048 位签一次约 8ms、验一次
 * 不到 1ms，够用。
 */
import { sha256Bytes } from './digest';
import type { RsaKeyPair } from './keys';

/** SHA-256 的 DigestInfo 前缀，RFC 8017 里那串固定字节 */
const SHA256_PREFIX = Uint8Array.from([
  0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65,
  0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20,
]);

export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let value = base % modulus;
  let remaining = exponent;
  while (remaining > 0n) {
    if (remaining & 1n) result = (result * value) % modulus;
    value = (value * value) % modulus;
    remaining >>= 1n;
  }
  return result;
}

export function base64urlToBigInt(value: string): bigint {
  const bytes = base64urlToBytes(value);
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result;
}

export function base64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function bigIntToBytes(value: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result;
}

/** 模数有多少字节 */
export function modulusLength(key: Pick<RsaKeyPair, 'n'>): number {
  return base64urlToBytes(key.n).length;
}

/**
 * EMSA-PKCS1-v1_5 填充。
 *
 * `0x00 0x01 0xFF...0xFF 0x00 DigestInfo`。填充是固定的，
 * 所以整个签名过程没有随机数。
 */
export function pkcs1Pad(message: Uint8Array, length: number): Uint8Array {
  const digest = sha256Bytes(message);
  const info = new Uint8Array(SHA256_PREFIX.length + digest.length);
  info.set(SHA256_PREFIX);
  info.set(digest, SHA256_PREFIX.length);

  if (length < info.length + 11) throw new Error('RSA: 模数太短，放不下 DigestInfo');
  const out = new Uint8Array(length);
  out[0] = 0x00;
  out[1] = 0x01;
  out.fill(0xff, 2, length - info.length - 1);
  out[length - info.length - 1] = 0x00;
  out.set(info, length - info.length);
  return out;
}

export function sign(key: RsaKeyPair, message: Uint8Array): Uint8Array {
  const length = modulusLength(key);
  const padded = pkcs1Pad(message, length);
  const signature = modPow(
    bytesToBigInt(padded),
    base64urlToBigInt(key.d),
    base64urlToBigInt(key.n)
  );
  return bigIntToBytes(signature, length);
}

export function verify(
  key: Pick<RsaKeyPair, 'n' | 'e'>,
  message: Uint8Array,
  signature: Uint8Array
): boolean {
  try {
    const length = modulusLength(key);
    if (signature.length !== length) return false;
    const recovered = modPow(
      bytesToBigInt(signature),
      base64urlToBigInt(key.e),
      base64urlToBigInt(key.n)
    );
    const expected = pkcs1Pad(message, length);
    return equalBytes(bigIntToBytes(recovered, length), expected);
  } catch {
    return false;
  }
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}
