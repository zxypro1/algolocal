/**
 * 上传内容的规整与 slug 分配
 *
 * 市场收到的 payload 全部来自用户。这一层决定什么能进库、进库之后叫什么名字，
 * 所以它既要挡住坏数据，也不能因为重名就把用户拦在门外。
 */
import { useMemoryCloud } from './harness';

useMemoryCloud();

/* eslint-disable @typescript-eslint/no-var-requires */
const { excerpt, normalizeListing, payloadSize, resolveSlug } = require('../../src/lib/server/cloud/listing');
const { blankAlgorithmProblem, blankEngineeringProject } = require('../../src/lib/workshop/templates');
const { MAX_PAYLOAD_BYTES } = require('../../src/lib/cloud/types');
/* eslint-enable @typescript-eslint/no-var-requires */

describe('excerpt', () => {
  it('strips markdown down to a readable line', () => {
    const text = excerpt('# Title\n\nSome **bold** text with `code` and a [link](https://example.com).');

    expect(text).not.toMatch(/[#*`[\]]/);
    expect(text).toContain('bold');
    expect(text).toContain('link');
  });

  it('drops fenced code rather than dumping it into the card', () => {
    const text = excerpt('Intro paragraph.\n\n```js\nconst secret = 1;\n```\n\nOutro.');

    expect(text).not.toContain('const secret');
    expect(text).toContain('Intro paragraph');
  });

  it('truncates with an ellipsis', () => {
    const text = excerpt('word '.repeat(200), 50);
    expect(text.length).toBeLessThanOrEqual(50);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('normalizeListing', () => {
  it('accepts a well-formed algorithm problem and derives its metadata', () => {
    const normalized = normalizeListing('algorithm', blankAlgorithmProblem());

    expect(normalized.kind).toBe('algorithm');
    expect(normalized.desiredSlug).toBe('sum-of-two-numbers');
    expect(normalized.difficulty).toBe('Easy');
    expect(normalized.language).toBeNull();
    expect(normalized.summary.zh.length).toBeGreaterThan(0);
    expect(normalized.summary.zh).not.toContain('**');
  });

  it('accepts a well-formed engineering project and keeps its workspace language', () => {
    const normalized = normalizeListing('engineering', blankEngineeringProject());

    expect(normalized.kind).toBe('engineering');
    expect(normalized.language).toBe('typescript');
    // domain 也该进标签，否则按领域筛不到它
    expect(normalized.tags).toContain('engineering');
    expect(normalized.tags).toContain('concurrency');
  });

  it('rejects an unknown kind', () => {
    expect(() => normalizeListing('recipe', blankAlgorithmProblem())).toThrow(/algorithm/);
  });

  it('rejects a non-object payload', () => {
    expect(() => normalizeListing('algorithm', 'a string')).toThrow(/object/);
    expect(() => normalizeListing('algorithm', null)).toThrow(/object/);
  });

  it('reports which fields failed instead of a bare "invalid"', () => {
    try {
      normalizeListing('algorithm', { ...blankAlgorithmProblem(), tests: [], template: {} });
      throw new Error('should have thrown');
    } catch (error: any) {
      expect(error.status).toBe(400);
      expect(error.details.map((issue: any) => issue.field)).toEqual(
        expect.arrayContaining(['tests', 'template'])
      );
    }
  });

  it('rejects a project whose stage has no reference implementation', () => {
    const project = blankEngineeringProject();
    project.stages[0].referenceFiles = [];

    expect(() => normalizeListing('engineering', project)).toThrow(/validation/);
  });

  it('refuses an oversized payload before it reaches the database', () => {
    const problem = blankAlgorithmProblem();
    problem.description.en = 'x'.repeat(MAX_PAYLOAD_BYTES + 1000);

    expect(() => normalizeListing('algorithm', problem)).toThrow(/limit/);
  });

  it('measures payload size in bytes, not characters', () => {
    // 中文题面在 UTF-8 下每个字三字节，按字符数算会让上限形同虚设
    expect(payloadSize({ text: '中'.repeat(100) })).toBeGreaterThan(300);
  });
});

describe('resolveSlug', () => {
  const noExisting = async () => null;

  it('uses the derived slug when nothing is taken', async () => {
    expect(await resolveSlug('two-sum', 'owner-1', noExisting)).toBe('two-sum');
  });

  it('reuses the same slug for the same owner, which is how re-publishing works', async () => {
    const existing = async () => ({ ownerId: 'owner-1' });
    expect(await resolveSlug('two-sum', 'owner-1', existing)).toBe('two-sum');
  });

  it('suffixes rather than failing when someone else has the name', async () => {
    const taken = new Set(['two-sum', 'two-sum-2']);
    const existing = async (slug: string) => (taken.has(slug) ? { ownerId: 'someone-else' } : null);

    expect(await resolveSlug('two-sum', 'owner-1', existing)).toBe('two-sum-3');
  });

  it('rejects an explicit slug that belongs to someone else', async () => {
    const existing = async () => ({ ownerId: 'someone-else' });

    await expect(resolveSlug('two-sum', 'owner-1', existing, 'two-sum')).rejects.toThrow(/already published/);
  });

  it('slugifies an explicit slug rather than trusting it', async () => {
    expect(await resolveSlug('ignored', 'owner-1', noExisting, 'My Problem!')).toBe('my-problem');
  });

  it('gives up after a sane number of attempts instead of looping', async () => {
    const existing = async () => ({ ownerId: 'someone-else' });
    await expect(resolveSlug('popular', 'owner-1', existing)).rejects.toThrow(/different id/);
  });
});
