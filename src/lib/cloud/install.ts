/**
 * 把市场上的题目装进本地题库
 *
 * 两种落点：算法题走 /api/add-problem，工程题走 /api/projects。两个接口都是
 * 同源的本地服务，装完之后题目就是本地的，之后再也不需要网络。
 *
 * 网页版（Vercel）的文件系统是只读的，这两个接口会返回 501。这时调用方应该
 * 改成 downloadAsFile()，让用户把 JSON 存下来，回桌面端导入。
 */
import type { EngineeringProject } from '../engineering/types';
import type { AlgorithmProblem } from '../workshop/problem';

export class InstallError extends Error {
  constructor(message: string, readonly readOnly = false) {
    super(message);
    this.name = 'InstallError';
  }
}

async function postJson(url: string, body: unknown): Promise<any> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const readOnly = response.status === 501 || payload?.code === 'read_only_library';
    const detail = Array.isArray(payload?.problems) ? `: ${payload.problems.join('; ')}` : '';
    throw new InstallError((payload?.error || `Request failed with ${response.status}`) + detail, readOnly);
  }

  return payload;
}

export async function installProblem(problem: AlgorithmProblem): Promise<string> {
  const result = await postJson('/api/add-problem', { problem });
  return result?.id || problem.id;
}

export async function installProject(project: EngineeringProject): Promise<string> {
  const result = await postJson('/api/projects', { project });
  return result?.project?.id || project.id;
}

export function installListing(kind: 'algorithm' | 'engineering', payload: unknown): Promise<string> {
  return kind === 'algorithm'
    ? installProblem(payload as AlgorithmProblem)
    : installProject(payload as EngineeringProject);
}

/** 存成 JSON 文件。网页版没有本地题库可写时用这个。 */
export function downloadAsFile(name: string, payload: unknown): void {
  if (typeof window === 'undefined') return;

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${name}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // 立刻 revoke 会让 Safari 来不及开始下载，下一帧再放
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
