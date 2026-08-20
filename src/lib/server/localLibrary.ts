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
 * 用 501 而不是 403：这不是权限问题，是这个部署形态压根没有实现这个能力。
 */
export function ensureLibraryWritable(res: NextApiResponse): boolean {
  if (isLibraryWritable()) return true;

  res.status(501).json({
    error:
      'This deployment has a read-only problem library. Editing problems works in the desktop app or a local server.',
    code: 'read_only_library',
  });
  return false;
}
