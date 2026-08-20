/**
 * 当前这份服务能做什么
 *
 * 界面上有几个地方要按部署形态分叉：网页版不能往本地题库里写，所以市场的
 * 「安装到本地」要变成「下载 JSON」，工坊的「保存到题库」要变成「导出」。
 * 与其在每个按钮里 try/catch 一个 501，不如一开始就问清楚。
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { isLibraryWritable, isServerlessDeployment } from '../../src/lib/server/localLibrary';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../../package.json');

export interface EnvironmentInfo {
  version: string;
  /** 能不能把题目写进本地题库 */
  writableLibrary: boolean;
  /** 跑在 Serverless 平台上（也就是网页版） */
  hosted: boolean;
}

export default function handler(req: NextApiRequest, res: NextApiResponse<EnvironmentInfo | { error: string }>) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  return res.status(200).json({
    version,
    writableLibrary: isLibraryWritable(),
    hosted: isServerlessDeployment(),
  });
}
