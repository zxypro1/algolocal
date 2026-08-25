/**
 * cosign
 *
 * 签的不是镜像内容，是**镜像的 digest**。这一点值得强调：签名和 tag 无关，
 * 换个 tag 指向同一个 digest，签名照样有效；而 tag 不变、digest 变了
 * （有人重新推了一版），签名立刻失效。供应链安全靠的就是这个不可变的锚点。
 *
 * 我们用现成的 RSA + SHA-256 做真签名 —— 拿到公钥的人真的能验，
 * 换一个 digest 真的验不过。签名存在镜像仓库里，和真 cosign 一样
 * （真 cosign 存成 `sha256-<digest>.sig` 这个 tag）。
 */
import { sha256Hex } from '../crypto/digest';
import { parsePrivateKeyPem, publicKeyPem, parsePublicKeyPem } from '../crypto/x509';
import { sign, verify } from '../crypto/rsa';

/** 一条签名记录 */
export interface Signature {
  /** 被签的 digest，形如 `sha256:abc...` */
  digest: string;
  /** base64 的签名 */
  signature: string;
  /** 签它的公钥（PEM），便于展示「谁签的」 */
  publicKey: string;
}

/** 签名库：镜像仓库的一部分 */
export class SignatureStore {
  private readonly byDigest = new Map<string, Signature[]>();

  add(signature: Signature): void {
    const list = this.byDigest.get(signature.digest) ?? [];
    if (!list.some((entry) => entry.signature === signature.signature)) list.push(signature);
    this.byDigest.set(signature.digest, list);
  }

  get(digest: string): Signature[] {
    return this.byDigest.get(digest) ?? [];
  }

  /** 这个 digest 有没有被这把公钥签过 */
  verify(digest: string, publicKeyPemText: string): boolean {
    const key = parsePublicKeyPem(publicKeyPemText);
    if (!key) return false;
    const payload = payloadFor(digest);
    return this.get(digest).some((entry) => verify(key, payload, fromBase64(entry.signature)));
  }
}

/**
 * 被签的那段字节。
 *
 * 真 cosign 签的是一个 simple signing 格式的 JSON payload，里面带着 digest。
 * 我们保留同样的形状 —— 关键是「签的内容里含 digest」，而不是签 digest 本身，
 * 这样同一个 digest 在不同仓库里的签名能被区分开。
 */
export function payloadFor(digest: string): Uint8Array {
  const payload = JSON.stringify({
    critical: { identity: { 'docker-reference': '' }, image: { 'docker-manifest-digest': digest }, type: 'cosign container image signature' },
    optional: null,
  });
  return new TextEncoder().encode(payload);
}

export function signDigest(privateKeyPem: string, digest: string): Signature | undefined {
  const key = parsePrivateKeyPem(privateKeyPem);
  if (!key) return undefined;
  return {
    digest,
    signature: toBase64(sign(key, payloadFor(digest))),
    publicKey: publicKeyPem(key),
  };
}

/** 镜像引用 -> digest。没有 digest 的镜像按引用本身取 sha256，稳定且确定。 */
export function digestOf(image: string): string {
  const explicit = /@(sha256:[0-9a-f]{64})$/.exec(image);
  if (explicit) return explicit[1];
  return `sha256:${sha256Hex(image)}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
