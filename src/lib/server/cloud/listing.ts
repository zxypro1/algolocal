/**
 * 上传内容的规整与校验
 *
 * 市场里的 payload 全部来自用户，下载之后会在别人机器上被执行（算法题的测试
 * 跑在 WASM 沙箱里，工程题的用例跑在 Web Worker 里）。所以这里做两件事：
 * 一是结构校验，挡掉根本跑不起来的东西；二是体积限制，挡掉把数据库当网盘用的。
 *
 * 这里**不做**代码内容审查。执行沙箱才是安全边界，靠正则找 `eval` 只会给人
 * 一种虚假的安全感，同时误伤正常题目。
 */
import { coerceProject, validateProjectShape } from '../../engineering/validateProject';
import type { EngineeringProject } from '../../engineering/types';
import {
  coerceProblem,
  hasBlockingIssues,
  slugifyProblemId,
  validateProblem,
  type AlgorithmProblem,
} from '../../workshop/problem';
import { MAX_PAYLOAD_BYTES, type ListingDifficulty, type ListingKind, type LocalizedText } from '../../cloud/types';
import { badRequest } from './http';

export interface NormalizedListing {
  kind: ListingKind;
  desiredSlug: string;
  title: LocalizedText;
  summary: LocalizedText;
  difficulty: ListingDifficulty;
  tags: string[];
  language: string | null;
  payload: AlgorithmProblem | EngineeringProject;
}

/** 把 markdown 题面压成一句话简介，用于列表卡片 */
export function excerpt(markdown: string, max = 220): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_>#-]{1,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (plain.length <= max) return plain;
  return `${plain.slice(0, max - 1).trimEnd()}…`;
}

export function payloadSize(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload ?? null), 'utf8');
}

export function normalizeListing(kind: unknown, rawPayload: unknown): NormalizedListing {
  if (kind !== 'algorithm' && kind !== 'engineering') {
    throw badRequest('kind must be "algorithm" or "engineering"');
  }
  if (!rawPayload || typeof rawPayload !== 'object') {
    throw badRequest('payload must be an object');
  }

  const size = payloadSize(rawPayload);
  if (size > MAX_PAYLOAD_BYTES) {
    throw badRequest(
      `The payload is ${(size / 1024 / 1024).toFixed(1)}MB, over the ${MAX_PAYLOAD_BYTES / 1024 / 1024}MB limit`
    );
  }

  return kind === 'algorithm' ? normalizeAlgorithm(rawPayload) : normalizeEngineering(rawPayload);
}

function normalizeAlgorithm(rawPayload: unknown): NormalizedListing {
  const problem = coerceProblem(rawPayload);
  const issues = validateProblem(problem);

  if (hasBlockingIssues(issues)) {
    throw badRequest(
      'The problem does not pass validation',
      issues.filter((issue) => issue.severity === 'error').map((issue) => ({ field: issue.field, message: issue.message.en }))
    );
  }

  return {
    kind: 'algorithm',
    desiredSlug: problem.id,
    title: problem.title,
    summary: { en: excerpt(problem.description.en), zh: excerpt(problem.description.zh) },
    difficulty: problem.difficulty,
    tags: problem.tags,
    language: null,
    payload: problem,
  };
}

function normalizeEngineering(rawPayload: unknown): NormalizedListing {
  const project = coerceProject(rawPayload);
  const errors = validateProjectShape(project);

  if (errors.length) {
    throw badRequest('The project does not pass validation', errors);
  }

  return {
    kind: 'engineering',
    desiredSlug: slugifyProblemId(project.id),
    title: project.title,
    summary:
      project.summary.en || project.summary.zh
        ? project.summary
        : { en: excerpt(project.brief.en), zh: excerpt(project.brief.zh) },
    difficulty: project.difficulty,
    tags: Array.from(new Set([project.domain, ...(project.tags || [])].filter(Boolean))).slice(0, 12),
    language: project.language,
    payload: project,
  };
}

/**
 * 挑一个没被别人占用的 slug。
 *
 * 同一个作者重新发布同一个 id 时会命中原来那条记录，也就是发新版本；
 * 别人已经占用的话自动加后缀，而不是让用户看到「这个名字有人用了，请重试」。
 */
export async function resolveSlug(
  desired: string,
  ownerId: string,
  findBySlug: (slug: string) => Promise<{ ownerId: string } | null>,
  explicit?: string
): Promise<string> {
  if (explicit) {
    const slug = slugifyProblemId(explicit);
    const existing = await findBySlug(slug);
    if (existing && existing.ownerId !== ownerId) {
      throw badRequest(`"${slug}" is already published by another account`);
    }
    return slug;
  }

  const base = slugifyProblemId(desired);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const existing = await findBySlug(slug);
    if (!existing || existing.ownerId === ownerId) return slug;
  }

  // 同一个名字被 50 个不同的人占了，与其继续试，不如让用户自己起个名字
  throw badRequest(`Too many listings named "${base}" — pick a different id`);
}
