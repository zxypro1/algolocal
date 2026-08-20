import { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import path from 'path';

/**
 * 题库。
 *
 * 这里曾经有四条 console.log，其中一条把整个 problems.json（约 500KB）
 * 原样打进日志 —— 首页每次加载都会触发一次。本地只是刷屏，部署到
 * Serverless 上就是按量计费的日志。出错时打错误就够了。
 */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    // 优先使用 Electron 主进程注入的 APP_ROOT，保证打包后路径正确
    const appRoot = process.env.APP_ROOT || process.cwd();
    const problemsPath = path.join(appRoot, 'public', 'problems.json');
    const problems = JSON.parse(fs.readFileSync(problemsPath, 'utf8'));

    res.status(200).json(problems);
  } catch (error) {
    console.error('Error reading problems.json:', error);
    res.status(500).json({ error: 'Failed to load problems: ' + (error as Error).message });
  }
}
