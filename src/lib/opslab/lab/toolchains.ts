/**
 * 基础镜像自带的工具
 *
 * `FROM node:22-alpine` 之后 `RUN npm ci` 要真的能跑 —— 不是真装依赖，
 * 而是「行为一致」：有 package.json 就成功并写出 node_modules，没有就报
 * npm 自己那句 ENOENT。学员据此判断 Dockerfile 的顺序对不对
 * （先 COPY package.json 再 npm ci，才有缓存可言）。
 *
 * 题目里只写工具链的名字，实现在这里，因为「命令的行为」写不进 JSON。
 */
import type { CommandHandler } from '../machine';
import { finalizeImage, makeLayer, normalizeReference, type Image } from '../machine/oci';

export type ToolchainName = 'node' | 'python' | 'static';

/** Node 基础镜像：npm + node */
const NODE_TOOLS: Record<string, CommandHandler> = {
  npm: ({ argv, vfs, cwd }) => {
    const [subcommand] = argv;
    if (subcommand === '--version' || argv.includes('--version')) return { stdout: '10.9.2\n' };

    if (subcommand === 'ci' || subcommand === 'install' || subcommand === 'i') {
      if (!vfs.exists(`${cwd}/package.json`)) {
        return {
          stderr: 'npm error code ENOENT\nnpm error syscall open\n'
            + `npm error path ${cwd}/package.json\n`
            + 'npm error errno -2\n'
            + 'npm error enoent Could not read package.json\n',
          code: 254,
        };
      }
      if (subcommand === 'ci' && !vfs.exists(`${cwd}/package-lock.json`)) {
        return {
          stderr: 'npm error code EUSAGE\n'
            + 'npm error The `npm ci` command can only install with an existing package-lock.json\n',
          code: 1,
        };
      }
      const production = argv.includes('--omit=dev') || argv.includes('--production');
      vfs.writeFile(`${cwd}/node_modules/.package-lock.json`, '{"lockfileVersion":3}\n');
      vfs.writeFile(`${cwd}/node_modules/express/index.js`, 'module.exports = () => {};\n');
      if (!production) vfs.writeFile(`${cwd}/node_modules/jest/index.js`, 'module.exports = {};\n');
      return { stdout: `added ${production ? 42 : 318} packages in 2s\n` };
    }

    if (subcommand === 'run') {
      return { stdout: `> ${argv[1]}\n\n` };
    }
    return { stderr: `Unknown command: "${subcommand ?? ''}"\n`, code: 1 };
  },

  node: ({ argv }) => {
    if (argv.includes('--version') || argv.includes('-v')) return { stdout: 'v22.14.0\n' };
    return { stdout: '' };
  },
};

/** Alpine 系的包管理器，写 Dockerfile 时常见 */
const APK_TOOLS: Record<string, CommandHandler> = {
  apk: ({ argv }) => {
    if (argv[0] === 'add') {
      return { stdout: `(1/1) Installing ${argv.filter((a) => !a.startsWith('-')).slice(1).join(' ')}\nOK: 8 MiB in 20 packages\n` };
    }
    if (argv[0] === 'update') return { stdout: 'OK: 18 distinct packages available\n' };
    return { stderr: `ERROR: unknown command: ${argv[0] ?? ''}\n`, code: 1 };
  },
  adduser: ({ argv, vfs }) => {
    const name = argv[argv.length - 1];
    vfs.appendFile('/etc/passwd', `${name}:x:10001:10001::/home/${name}:/sbin/nologin\n`);
    return { code: 0 };
  },
};

const TOOLCHAINS: Record<ToolchainName, Record<string, CommandHandler>> = {
  node: { ...NODE_TOOLS, ...APK_TOOLS },
  python: {
    pip: ({ argv }) => (argv[0] === 'install'
      ? { stdout: 'Successfully installed flask-3.1.0\n' }
      : { stderr: 'ERROR: unknown command\n', code: 1 }),
    python3: () => ({ stdout: 'Python 3.13.2\n' }),
    ...APK_TOOLS,
  },
  static: APK_TOOLS,
};

export function toolchainFor(name: ToolchainName | undefined): Record<string, CommandHandler> {
  return name ? TOOLCHAINS[name] ?? {} : {};
}

/** 基础镜像的根文件系统 —— 有个 /bin/sh 才像样 */
const BASE_ROOTFS: Record<ToolchainName, Record<string, string>> = {
  node: {
    '/bin/sh': '#!/bin/sh\n',
    '/usr/local/bin/node': 'node binary\n',
    '/usr/local/bin/npm': 'npm binary\n',
    '/etc/passwd': 'root:x:0:0:root:/root:/bin/sh\nnode:x:1000:1000::/home/node:/bin/sh\n',
  },
  python: {
    '/bin/sh': '#!/bin/sh\n',
    '/usr/local/bin/python3': 'python binary\n',
    '/etc/passwd': 'root:x:0:0:root:/root:/bin/sh\n',
  },
  static: {
    '/bin/sh': '#!/bin/sh\n',
    '/etc/passwd': 'root:x:0:0:root:/root:/bin/sh\n',
  },
};

/** 造一个能当 FROM 用的基础镜像 */
export function baseImageOf(reference: string, toolchain: ToolchainName, created: string): Image {
  return finalizeImage({
    config: {
      Env: ['PATH=/usr/local/bin:/usr/bin:/bin'],
      Cmd: ['/bin/sh'],
      User: '',
    },
    layers: [makeLayer(BASE_ROOTFS[toolchain], [], `ADD file:${toolchain} in /`)],
    history: [{ created, created_by: `ADD file:${toolchain} in /` }],
    architecture: 'amd64',
    os: 'linux',
    created,
    repoTags: [normalizeReference(reference)],
  });
}
