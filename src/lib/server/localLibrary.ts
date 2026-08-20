/**
 * 本地题库的可写性
 *
 * 同一份代码有两种跑法：用户机器上的本地服务（桌面端或 npm start），
 * 以及 Vercel 上的网页版。前者可以往 public/problems.json 和用户目录里写，
 * 后者的文件系统是只读的。
 *
 * 与其让写入在 Vercel 上抛一个 EROFS 然后被统一的 500 吞掉，不如提前判断，
 * 明确回一句「这个部署上不能改题库，请用桌面端」。
 */
import fs from 'fs';
import path from 'path';
import type { NextApiResponse } from 'next';

export function isServerlessDeployment(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

export function appRoot(): string {
  return process.env.APP_ROOT || process.cwd();
}

/** 题库文件在不在、能不能写。网页版上两者都不成立。 */
export function isLibraryWritable(): boolean {
  if (isServerlessDeployment()) return false;
  try {
    const file = path.join(appRoot(), 'public', 'problems.json');
    fs.accessSync(file, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 写题库之前调它。不可写时直接把响应写完并返回 false，调用方 return 即可。
 *
 * 用 501 而不是 403：在网页版上这不是权限问题，是这个部署形态压根没有实现
 * 这个能力。之前这里没有检查，写失败会变成一个语焉不详的 500。
 */
export function ensureLibraryWritable(res: NextApiResponse): boolean {
  if (isLibraryWritable()) return true;

  // 两种不可写的情况分开说。桌面端装在只读目录里（比如 macOS 的
  // /Applications 且当前用户没有写权限）也会走到这里，这时让用户去
  // 「用桌面端」是一句废话。
  const message = isServerlessDeployment()
    ? 'This deployment has a read-only problem library. Use the desktop app or a local server to edit problems, or export the JSON instead.'
    : 'The problem library is not writable. Check the permissions on public/problems.json.';

  res.status(501).json({ error: message, code: 'read_only_library' });
  return false;
}
