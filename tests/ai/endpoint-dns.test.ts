/**
 * DNS 那一层单独测，并且把解析结果打桩。
 *
 * 不打桩的话这个测试就依赖运行环境的 DNS —— 而「公网域名解析到内网地址」
 * 恰恰是最需要钉死的一条：只比主机名字符串的实现在这里必然放行。
 */
const lookupMock = jest.fn();
jest.mock('dns', () => ({ promises: { lookup: (...args: unknown[]) => lookupMock(...args) } }));

import { checkEndpoint } from '../../src/lib/server/endpointPolicy';

describe('DNS-level blocking', () => {
  const saved = process.env.AI_ENDPOINT_BLOCK_PRIVATE_NETWORK;

  beforeEach(() => {
    lookupMock.mockReset();
    process.env.AI_ENDPOINT_BLOCK_PRIVATE_NETWORK = '1';
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.AI_ENDPOINT_BLOCK_PRIVATE_NETWORK;
    else process.env.AI_ENDPOINT_BLOCK_PRIVATE_NETWORK = saved;
  });

  it('blocks a perfectly ordinary hostname that resolves into the private range', async () => {
    // 攻击者完全可以给自己的域名配一条指向 169.254.169.254 的 A 记录
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    const verdict = await checkEndpoint('https://totally-normal.example.com/v1/models');
    expect(verdict.ok).toBe(false);
  });

  it('blocks when only one of several answers is private', async () => {
    // 多 A 记录里混一条内网地址，取第一条来判断就会被绕过
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    expect((await checkEndpoint('https://mixed.example.com/v1')).ok).toBe(false);
  });

  it('allows a hostname that resolves entirely to public addresses', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    expect((await checkEndpoint('https://gw.example.com/v1')).ok).toBe(true);
  });

  it('refuses rather than guesses when the name does not resolve', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    expect((await checkEndpoint('https://nope.example.com/v1')).ok).toBe(false);
  });

  it('does not spend a DNS lookup when the flag is off', async () => {
    process.env.AI_ENDPOINT_BLOCK_PRIVATE_NETWORK = '0';
    expect((await checkEndpoint('https://anything.example.com/v1')).ok).toBe(true);
    expect(lookupMock).not.toHaveBeenCalled();
  });
});
