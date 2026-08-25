/**
 * `cosign`
 *
 * 三条命令就够用了：生成密钥对、签一个镜像、验一个镜像。
 * 真 cosign 还做 keyless（Fulcio + Rekor），那套依赖公网的 CA 与透明日志，
 * 在内网场景里本来也用不上。
 */
import type { CommandHandler } from '../machine/shell/shell';
import { digestOf, signDigest, type SignatureStore } from './cosign';
import { encodePrivateKeyPem, publicKeyPem } from '../crypto/x509';
import { keyFor } from '../crypto/keys';

export interface CosignOptions {
  signatures: SignatureStore;
  /** 镜像在不在仓库里。不在就没得签。 */
  hasImage(image: string): boolean;
}

export function createCosignCommand(options: CosignOptions): CommandHandler {
  return ({ argv, cwd, vfs }) => {
    const [command, ...rest] = argv;
    // 带值的选项要连它的值一起跳过，否则 `--key cosign.key` 里的文件名
    // 会被当成位置参数（镜像引用）
    const positional = positionalOf(rest, ['--key', '--certificate', '--output']);

    switch (command) {
      case 'version':
        return { stdout: 'GitVersion:    v2.6.1\nGoVersion:     go1.27.0\n' };

      case 'generate-key-pair': {
        /**
         * 真 cosign 会问密码。这里不问 —— 密码保护的是私钥文件本身，
         * 和「签名能不能验」无关，问了只是多一步。
         */
        const key = keyFor(`cosign:${cwd}`);
        vfs.writeFile(resolve(cwd, 'cosign.key'), encodePrivateKeyPem(key));
        vfs.writeFile(resolve(cwd, 'cosign.pub'), publicKeyPem(key));
        return { stderr: 'Private key written to cosign.key\nPublic key written to cosign.pub\n' };
      }

      case 'sign': {
        const keyPath = flag(rest, '--key');
        const image = positional[0];
        if (!keyPath || !image) {
          return { stderr: 'Error: --key and an image reference are required\n', code: 1 };
        }
        const full = resolve(cwd, keyPath);
        if (!vfs.exists(full)) return { stderr: `Error: open ${keyPath}: no such file or directory\n`, code: 1 };
        if (!options.hasImage(image)) {
          return { stderr: `Error: signing ${image}: image not found in registry\n`, code: 1 };
        }
        const signature = signDigest(vfs.readFile(full), digestOf(image));
        if (!signature) return { stderr: `Error: reading key: invalid private key\n`, code: 1 };
        options.signatures.add(signature);
        return {
          stderr: `Pushing signature to: ${image.split(':')[0]}\n`,
          stdout: '',
        };
      }

      case 'verify': {
        const keyPath = flag(rest, '--key');
        const image = positional[0];
        if (!keyPath || !image) {
          return { stderr: 'Error: --key and an image reference are required\n', code: 1 };
        }
        const full = resolve(cwd, keyPath);
        if (!vfs.exists(full)) return { stderr: `Error: open ${keyPath}: no such file or directory\n`, code: 1 };
        const digest = digestOf(image);
        if (!options.signatures.verify(digest, vfs.readFile(full))) {
          return {
            stderr: `Error: no matching signatures:\n\nmain.go:74: error during command execution: `
              + `no matching signatures:\n`,
            code: 1,
          };
        }
        return {
          stderr: `Verification for ${image} --\n`
            + 'The following checks were performed on each of these signatures:\n'
            + '  - The cosign claims were validated\n'
            + '  - The signatures were verified against the specified public key\n',
          stdout: `[{"critical":{"image":{"docker-manifest-digest":"${digest}"},`
            + '"type":"cosign container image signature"},"optional":null}]\n',
        };
      }

      default:
        return {
          stderr: 'Usage: cosign [generate-key-pair|sign|verify|version]\n',
          code: command ? 1 : 0,
        };
    }
  };
}

function positionalOf(argv: string[], valueFlags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const entry = argv[i];
    if (valueFlags.includes(entry)) { i += 1; continue; }
    if (entry.startsWith('-')) continue;
    out.push(entry);
  }
  return out;
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1];
  const inline = argv.find((entry) => entry.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

function resolve(cwd: string, path: string): string {
  if (path.startsWith('/')) return path;
  const parts = `${cwd}/${path}`.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}
