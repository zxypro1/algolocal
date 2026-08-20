/**
 * 离线保证
 *
 * 这个项目的卖点是「东西都在你自己机器上」。加了账号和市场之后，最容易悄悄
 * 破坏掉的就是这一点：某个人在题目列表里顺手加一个云端调用，从此没网的机器
 * 打开首页要先卡八秒。
 *
 * 这里钉住两件事：
 *  1. 所有云端请求都必须经过 cloudFetch，而 cloudFetch 在关闭或离线时
 *     根本不会调用 fetch —— 不是「调用了然后失败」，是压根不发。
 *  2. 主链路的模块（题库、执行器、工程实战运行时、本地 API 路由）不许
 *     引用云端模块。这条是静态检查，改错了会在 CI 里挂掉。
 */
import fs from 'fs';
import path from 'path';

class MemoryStorage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  clear() {
    this.store.clear();
  }
}

function installBrowser(online = true) {
  const storage = new MemoryStorage();
  (global as any).window = {
    localStorage: storage,
    location: { origin: 'http://localhost:3000', hostname: 'localhost', protocol: 'http:' },
  };
  (global as any).localStorage = storage;
  (global as any).navigator = { onLine: online };
  return storage;
}

function uninstallBrowser() {
  delete (global as any).window;
  delete (global as any).localStorage;
  delete (global as any).navigator;
}

describe('cloudFetch', () => {
  let fetchCalls: number;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    jest.resetModules();
    installBrowser();
    fetchCalls = 0;
    originalFetch = global.fetch;
    global.fetch = (async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    uninstallBrowser();
  });

  it('sends no request at all when cloud features are turned off', async () => {
    const { setCloudEnabled } = require('../../src/lib/cloud/config');
    const { cloudFetch, CloudError } = require('../../src/lib/cloud/client');

    setCloudEnabled(false);

    await expect(cloudFetch('/api/cloud/health')).rejects.toThrow(CloudError);
    expect(fetchCalls).toBe(0);

    try {
      await cloudFetch('/api/cloud/health');
    } catch (error: any) {
      expect(error.code).toBe('disabled');
      expect(error.isOffline).toBe(true);
    }
  });

  it('fails immediately when the browser reports it is offline', async () => {
    const { cloudFetch } = require('../../src/lib/cloud/client');
    (global as any).navigator.onLine = false;

    const started = Date.now();
    await expect(cloudFetch('/api/cloud/health')).rejects.toMatchObject({ code: 'offline' });

    expect(fetchCalls).toBe(0);
    // 「立刻」是这条规则的全部意义：等超时也算失败，但用户已经盯了八秒
    expect(Date.now() - started).toBeLessThan(100);
  });

  it('gives up on a hung server instead of waiting forever', async () => {
    const { cloudFetch } = require('../../src/lib/cloud/client');

    global.fetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;

    await expect(cloudFetch('/api/cloud/health', { timeoutMs: 40 })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('turns a network failure into an offline error rather than a raw TypeError', async () => {
    const { cloudFetch } = require('../../src/lib/cloud/client');

    global.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    await expect(cloudFetch('/api/cloud/health')).rejects.toMatchObject({ code: 'offline' });
  });

  it('drops the local session when the server rejects the token', async () => {
    const { setSession, getSession, resetSessionCache } = require('../../src/lib/cloud/session');
    const { cloudFetch } = require('../../src/lib/cloud/client');

    resetSessionCache();
    setSession({
      token: 'alc_stale',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: { id: 'u1', email: 'a@b.c', displayName: 'A', avatarUrl: null, providers: ['password'], createdAt: '' },
    });
    expect(getSession()).not.toBeNull();

    global.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'nope' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    await expect(cloudFetch('/api/cloud/auth/me')).rejects.toMatchObject({ code: 'unauthorized' });
    expect(getSession()).toBeNull();
  });

  it('attaches the bearer token when there is a session', async () => {
    const { setSession, resetSessionCache } = require('../../src/lib/cloud/session');
    const { cloudFetch } = require('../../src/lib/cloud/client');

    resetSessionCache();
    setSession({
      token: 'alc_live',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: { id: 'u1', email: 'a@b.c', displayName: 'A', avatarUrl: null, providers: ['password'], createdAt: '' },
    });

    let seen: Record<string, string> = {};
    global.fetch = (async (_url: string, init: RequestInit) => {
      seen = init.headers as Record<string, string>;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    await cloudFetch('/api/cloud/auth/me');
    expect(seen.Authorization).toBe('Bearer alc_live');
    // 用 header 认证，就不该再带 cookie：带了才需要操心 CSRF
    expect(seen.Cookie).toBeUndefined();
  });
});

describe('session storage', () => {
  beforeEach(() => {
    jest.resetModules();
    installBrowser();
  });
  afterEach(uninstallBrowser);

  it('treats an expired session as no session', () => {
    const { setSession, getSession, resetSessionCache } = require('../../src/lib/cloud/session');
    resetSessionCache();

    setSession({
      token: 'alc_old',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      user: { id: 'u1', email: 'a@b.c', displayName: 'A', avatarUrl: null, providers: [], createdAt: '' },
    });

    expect(getSession()).toBeNull();
  });

  it('survives localStorage throwing', () => {
    const { setSession, getSession, resetSessionCache } = require('../../src/lib/cloud/session');
    resetSessionCache();

    (global as any).window.localStorage = {
      getItem() {
        throw new Error('SecurityError');
      },
      setItem() {
        throw new Error('SecurityError');
      },
      removeItem() {
        throw new Error('SecurityError');
      },
    };

    // 隐私模式下 localStorage 会直接抛。不能因此崩掉整个应用。
    expect(() => getSession()).not.toThrow();
    expect(() =>
      setSession({
        token: 'alc_x',
        expiresAt: new Date(Date.now() + 1000).toISOString(),
        user: { id: 'u', email: '', displayName: '', avatarUrl: null, providers: [], createdAt: '' },
      })
    ).not.toThrow();
  });
});

describe('cloud address resolution', () => {
  beforeEach(() => {
    jest.resetModules();
    installBrowser();
  });
  afterEach(uninstallBrowser);

  it('defaults to the official deployment on localhost', () => {
    const { getCloudBase, DEFAULT_CLOUD_BASE } = require('../../src/lib/cloud/config');
    expect(getCloudBase()).toBe(DEFAULT_CLOUD_BASE);
  });

  it('uses same-origin when the page is served from a real host', () => {
    (global as any).window.location = {
      origin: 'https://algolocal.vercel.app',
      hostname: 'algolocal.vercel.app',
      protocol: 'https:',
    };
    const { getCloudBase } = require('../../src/lib/cloud/config');
    expect(getCloudBase()).toBe('');
  });

  it('lets the user point at their own backend', () => {
    const { getCloudBase, setCloudBase } = require('../../src/lib/cloud/config');

    setCloudBase('my-server.example.com/');
    expect(getCloudBase()).toBe('https://my-server.example.com');

    setCloudBase(null);
    expect(getCloudBase()).not.toBe('https://my-server.example.com');
  });
});

describe('import boundaries', () => {
  const root = path.join(__dirname, '..', '..');

  const sourcesUnder = (dir: string): string[] => {
    const results: string[] = [];
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) results.push(full);
      }
    };
    walk(path.join(root, dir));
    return results;
  };

  const readImports = (file: string): string[] => {
    const source = fs.readFileSync(file, 'utf8');
    return Array.from(source.matchAll(/from\s+'([^']+)'|require\('([^']+)'\)/g)).map(
      (match) => match[1] || match[2]
    );
  };

  /** 允许引用云端模块的文件。新增一个云端界面时把它加进来，顺便想一想它是不是真的需要。 */
  const CLOUD_SURFACES = [
    'src/contexts/CloudContext.tsx',
    'src/components/cloud/CloudGate.tsx',
    'src/components/cloud/CloudSettingsCard.tsx',
    'src/components/cloud/ListingCard.tsx',
    'src/lib/cloud/api.ts',
    'src/lib/cloud/client.ts',
    'src/lib/cloud/config.ts',
    'src/lib/cloud/install.ts',
    'src/lib/cloud/session.ts',
    'src/lib/cloud/types.ts',
    'pages/_app.tsx',
    'pages/account.tsx',
    'pages/market/index.tsx',
    'pages/market/[slug].tsx',
    'pages/workshop/index.tsx',
    'pages/workshop/[draftId].tsx',
  ];

  it('keeps cloud imports inside the known cloud surfaces', () => {
    const offenders: string[] = [];

    for (const file of [...sourcesUnder('src'), ...sourcesUnder('pages')]) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (CLOUD_SURFACES.includes(relative)) continue;
      // 服务端的云端实现不受这条限制，它本来就是云端
      if (relative.startsWith('src/lib/server/cloud/') || relative.startsWith('pages/api/cloud/')) continue;

      const imports = readImports(file);
      if (imports.some((specifier) => /(^|\/)lib\/cloud\//.test(specifier) || /cloud\/(api|client)$/.test(specifier))) {
        offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('keeps the offline practice runtime free of cloud and database code', () => {
    const forbidden = /lib\/cloud\/|@neondatabase|server\/cloud\//;
    const offenders: string[] = [];

    const offlineCore = [
      ...sourcesUnder('src/lib/engineering'),
      ...sourcesUnder('src/workers'),
      path.join(root, 'src/hooks/useWasmExecutor.ts'),
      path.join(root, 'src/hooks/useProjectRunner.ts'),
      path.join(root, 'src/lib/practiceStats.ts'),
      path.join(root, 'src/lib/problemDrafts.ts'),
      path.join(root, 'pages/api/problems.ts'),
      path.join(root, 'pages/api/projects.ts'),
    ];

    for (const file of offlineCore) {
      if (readImports(file).some((specifier) => forbidden.test(specifier))) {
        offenders.push(path.relative(root, file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it('does not pull the database driver into the client bundle', () => {
    const offenders: string[] = [];

    for (const file of [...sourcesUnder('src/components'), ...sourcesUnder('src/contexts'), ...sourcesUnder('src/hooks')]) {
      if (readImports(file).some((specifier) => specifier.includes('@neondatabase'))) {
        offenders.push(path.relative(root, file));
      }
    }

    expect(offenders).toEqual([]);
  });
});
