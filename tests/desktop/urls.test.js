/**
 * 导航地址判定
 *
 * 原来的判断是 `url.startsWith('http') && !url.includes('localhost')`，
 * 也就是说带上 `?x=localhost` 的外部地址会被当成「自己人」放进应用窗口。
 * 这一组用例就是钉住那个绕过。
 */

const { isInternalUrl, isSafeExternalUrl } = require('../../electron-urls');

const app = { hostname: 'localhost', port: 3000 };

describe('isInternalUrl', () => {
  it('accepts the app on its own host and port', () => {
    expect(isInternalUrl('http://localhost:3000/', app)).toBe(true);
    expect(isInternalUrl('http://localhost:3000/settings', app)).toBe(true);
    expect(isInternalUrl('http://localhost:3000/problems/two-sum?x=1#frag', app)).toBe(true);
  });

  it('rejects an external host that merely mentions localhost', () => {
    // 老的字符串判断正是栽在这里
    expect(isInternalUrl('https://evil.example/?next=localhost', app)).toBe(false);
    expect(isInternalUrl('https://localhost.evil.example/', app)).toBe(false);
    expect(isInternalUrl('https://evil.example/localhost:3000', app)).toBe(false);
  });

  it('rejects another port on the same host', () => {
    expect(isInternalUrl('http://localhost:3001/', app)).toBe(false);
    expect(isInternalUrl('http://localhost/', app)).toBe(false);
  });

  it('tracks the port the server actually landed on', () => {
    // 3000 被占用时会往后找，判定要跟着走
    expect(isInternalUrl('http://localhost:3003/', { hostname: 'localhost', port: 3003 })).toBe(true);
    expect(isInternalUrl('http://localhost:3000/', { hostname: 'localhost', port: 3003 })).toBe(false);
  });

  it('rejects non-http schemes and junk', () => {
    expect(isInternalUrl('file:///etc/passwd', app)).toBe(false);
    expect(isInternalUrl('javascript:alert(1)', app)).toBe(false);
    expect(isInternalUrl('not a url', app)).toBe(false);
    expect(isInternalUrl('', app)).toBe(false);
    expect(isInternalUrl(undefined, app)).toBe(false);
  });
});

describe('isSafeExternalUrl', () => {
  it('allows http and https', () => {
    expect(isSafeExternalUrl('https://example.com')).toBe(true);
    expect(isSafeExternalUrl('http://example.com')).toBe(true);
  });

  it('refuses schemes that shell.openExternal should never receive', () => {
    // file:// 会用默认程序打开本地文件，其余几个更不该出去
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeExternalUrl('smb://share/x')).toBe(false);
  });

  it('refuses unparseable input', () => {
    expect(isSafeExternalUrl('')).toBe(false);
    expect(isSafeExternalUrl('nonsense')).toBe(false);
    expect(isSafeExternalUrl(null)).toBe(false);
  });
});
