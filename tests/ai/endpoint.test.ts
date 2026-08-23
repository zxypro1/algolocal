/**
 * 端点策略：什么算远程、什么该拦。
 *
 * 这层的判断会决定「API Key 明文发到哪」和「服务端愿意去请求谁」，
 * 错一个网段就是一个 SSRF 缺口，所以逐段钉住。
 */
import { isInsecureRemote, isPrivateHostname, looksRemote } from '../../src/lib/endpointHosts';
import { checkEndpoint } from '../../src/lib/server/endpointPolicy';
import { normalizeCompatibleEndpoint } from '../../src/lib/server/aiProvider';

describe('host classification', () => {
  it('treats loopback, private ranges and link-local as private', () => {
    for (const host of [
      'localhost', 'app.localhost', 'printer.local',
      '127.0.0.1', '127.9.9.9', '0.0.0.0',
      '10.1.2.3', '172.16.0.1', '172.31.255.254', '192.168.1.9',
      '169.254.169.254',            // 云厂商元数据端点
      '::1', '[::1]', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1',
    ]) {
      expect([host, isPrivateHostname(host)]).toEqual([host, true]);
    }
  });

  it('does not over-block public addresses that merely look similar', () => {
    for (const host of [
      'api.openai.com', 'gw.example.com',
      '172.32.0.1',     // 刚好在 172.16/12 之外
      '172.15.0.1',
      '192.169.1.1',    // 不是 192.168
      '169.253.0.1',    // 不是 169.254
      '8.8.8.8',
    ]) {
      expect([host, isPrivateHostname(host)]).toEqual([host, false]);
    }
  });
});

describe('scheme defaults', () => {
  it('keeps local endpoints on http and puts remote ones on https', () => {
    expect(normalizeCompatibleEndpoint('localhost:1234')).toBe('http://localhost:1234/v1');
    expect(normalizeCompatibleEndpoint('192.168.1.9:1234')).toBe('http://192.168.1.9:1234/v1');
    // 远程默认补 http 的话，API Key 就明文出去了
    expect(normalizeCompatibleEndpoint('gw.example.com')).toBe('https://gw.example.com/v1');
    expect(normalizeCompatibleEndpoint('gw.example.com:8443/v1')).toBe('https://gw.example.com:8443/v1');
  });

  it('never overrides a scheme the user wrote out', () => {
    expect(normalizeCompatibleEndpoint('http://gw.example.com/v1')).toBe('http://gw.example.com/v1');
    expect(normalizeCompatibleEndpoint('https://localhost:1234/v1')).toBe('https://localhost:1234/v1');
  });
});

describe('endpoint policy', () => {
  const saved = process.env.AI_ENDPOINT_BLOCK_PRIVATE_NETWORK;
  afterEach(() => {
    if (saved === undefined) delete process.env.AI_ENDPOINT_BLOCK_PRIVATE_NETWORK;
    else process.env.AI_ENDPOINT_BLOCK_PRIVATE_NETWORK = saved;
  });

  it('allows anything http(s) by default, which is right for desktop and self-hosted', () => {
    delete process.env.AI_ENDPOINT_BLOCK_PRIVATE_NETWORK;
    expect(checkEndpoint('http://localhost:1234/v1/models').ok).toBe(true);
    expect(checkEndpoint('https://gw.example.com/v1/models').ok).toBe(true);
    expect(checkEndpoint('http://169.254.169.254/latest/meta-data/').ok).toBe(true);
  });

  it('rejects non-http schemes regardless of deployment', () => {
    delete process.env.AI_ENDPOINT_BLOCK_PRIVATE_NETWORK;
    expect(checkEndpoint('file:///etc/passwd').ok).toBe(false);
    expect(checkEndpoint('gopher://x/1').ok).toBe(false);
  });

  it('blocks private and loopback targets once a public deployment opts in', () => {
    process.env.AI_ENDPOINT_BLOCK_PRIVATE_NETWORK = '1';
    expect(checkEndpoint('http://169.254.169.254/latest/meta-data/').ok).toBe(false);
    expect(checkEndpoint('http://localhost:1234/v1/models').ok).toBe(false);
    expect(checkEndpoint('http://10.0.0.5/v1/models').ok).toBe(false);
    // 公网地址仍然放行，否则这个开关等于关掉整个功能
    expect(checkEndpoint('https://gw.example.com/v1/models').ok).toBe(true);
  });
});

describe('warnings the settings page shows', () => {
  it('spots a remote endpoint, so it can ask for an API key', () => {
    expect(looksRemote('https://gw.example.com/v1')).toBe(true);
    expect(looksRemote('http://localhost:1234/v1')).toBe(false);
  });

  it('spots plaintext http going somewhere remote', () => {
    expect(isInsecureRemote('http://gw.example.com/v1')).toBe(true);
    expect(isInsecureRemote('https://gw.example.com/v1')).toBe(false);
    // 本地明文没问题，不该报警
    expect(isInsecureRemote('http://localhost:1234/v1')).toBe(false);
  });
});
