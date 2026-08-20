#!/usr/bin/env node
/**
 * 对着一个真实部署跑一遍完整流程
 *
 *   node scripts/smoke-cloud.js https://algolocal.vercel.app
 *
 * 单元测试和集成测试跑的是内存仓储，证明不了「Neon 连得上、迁移跑过了、
 * 环境变量配对了」。这个脚本证明的正是这些：它注册一个一次性账号，发布、
 * star、下载、改版本、删除，最后把账号留下的东西清干净。
 *
 * 退出码非零就是部署有问题，可以直接挂在流水线上。
 */

const [, , baseArg] = process.argv;
const BASE = (baseArg || process.env.SMOKE_BASE_URL || '').replace(/\/+$/, '');

if (!BASE) {
  console.error('Usage: node scripts/smoke-cloud.js <deployment-url>');
  console.error('   or: SMOKE_BASE_URL=https://... node scripts/smoke-cloud.js');
  process.exit(2);
}

const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS || 20000);

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function request(path, { method = 'GET', body, token } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 300) };
      }
    }

    return { status: response.status, body: parsed, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

/** 一道最小但合法的算法题，够过发布校验 */
function smokeProblem(id) {
  return {
    id,
    title: { en: 'Smoke Test Problem', zh: '冒烟测试题' },
    difficulty: 'Easy',
    tags: ['smoke-test'],
    description: {
      en: 'Return the sum of two integers. Published by an automated deployment check.',
      zh: '返回两个整数的和。由自动部署检查发布。',
    },
    examples: [{ input: 'a = 1, b = 2', output: '3' }],
    template: { js: 'function solve(a, b) {\n  // write your code here\n}\nmodule.exports = solve;' },
    solution: { js: 'function solve(a, b) {\n  return a + b;\n}\nmodule.exports = solve;' },
    tests: [
      { input: '1,2', output: '3' },
      { input: '-1,1', output: '0' },
      { input: '0,0', output: '0' },
    ],
  };
}

async function main() {
  console.log(`Smoke-testing ${BASE}\n`);

  /* ------------------------------ 健康检查 ------------------------------ */
  console.log('health');
  const health = await request('/api/cloud/health');
  check('responds 200', health.status === 200, `got ${health.status}`);
  check('reports a database', health.body?.features?.database === true, JSON.stringify(health.body?.features));
  check('reports accounts', health.body?.features?.accounts === true, 'AUTH_SECRET may be missing');
  check('reports a version', typeof health.body?.version === 'string');

  if (health.body?.features?.database !== true) {
    console.error('\nThe deployment has no database configured — stopping here.');
    console.error('Set DATABASE_URL (and AUTH_SECRET) and run the migration, then try again.');
    process.exit(1);
  }

  /* ------------------------------ CORS ------------------------------ */
  console.log('\ncors');
  const preflight = await request('/api/cloud/market', { method: 'OPTIONS' });
  check('answers preflight', preflight.status === 204 || preflight.status === 200, `got ${preflight.status}`);
  check(
    'allows the Authorization header',
    String(preflight.headers.get('access-control-allow-headers') || '').toLowerCase().includes('authorization')
  );

  /* ------------------------------ 账号 ------------------------------ */
  console.log('\naccounts');
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const email = `smoke-${stamp}@smoke-test.invalid`;
  const password = `smoke-${stamp}-password`;

  const registered = await request('/api/cloud/auth/register', {
    method: 'POST',
    body: { email, password, displayName: 'Deployment Smoke Test' },
  });
  check('registers a new account', registered.status === 200, JSON.stringify(registered.body));

  const token = registered.body?.token;
  if (!token) {
    console.error('\nRegistration failed, cannot continue.');
    process.exit(1);
  }

  const me = await request('/api/cloud/auth/me', { token });
  check('reads the profile back', me.status === 200 && me.body?.user?.email === email);
  check('does not leak the password hash', !JSON.stringify(me.body).includes('scrypt'));

  const anonymous = await request('/api/cloud/auth/me');
  check('rejects an anonymous request', anonymous.status === 401, `got ${anonymous.status}`);

  const wrongPassword = await request('/api/cloud/auth/login', {
    method: 'POST',
    body: { email, password: 'definitely not the password' },
  });
  check('rejects a wrong password', wrongPassword.status === 401, `got ${wrongPassword.status}`);

  /* ------------------------------ 发布 ------------------------------ */
  console.log('\npublishing');
  const problemId = `smoke-test-${stamp}`;
  const published = await request('/api/cloud/market/publish', {
    method: 'POST',
    token,
    body: { kind: 'algorithm', payload: smokeProblem(problemId) },
  });
  check('publishes a problem', published.status === 200, JSON.stringify(published.body));

  const slug = published.body?.listing?.slug;
  check('assigns a slug', Boolean(slug), String(slug));
  check('starts at version 1', published.body?.listing?.version === 1);

  const rejected = await request('/api/cloud/market/publish', {
    method: 'POST',
    token,
    body: { kind: 'algorithm', payload: { ...smokeProblem(`${problemId}-bad`), tests: [] } },
  });
  check('rejects a problem with no tests', rejected.status === 400, `got ${rejected.status}`);

  /* ------------------------------ 读取 ------------------------------ */
  console.log('\nbrowsing');
  const listed = await request(`/api/cloud/market?search=${encodeURIComponent(problemId)}`);
  check('finds it by search', listed.status === 200 && listed.body?.total >= 1, JSON.stringify(listed.body?.total));
  check(
    'keeps the payload out of the list',
    !listed.body?.items?.some((item) => item.payload),
    'the list response is carrying full payloads'
  );

  const detail = await request(`/api/cloud/market/${slug}`);
  check('serves the detail', detail.status === 200);
  check('includes the payload in the detail', Array.isArray(detail.body?.payload?.tests));

  /* ------------------------------ star ------------------------------ */
  console.log('\nstars');
  const starred = await request(`/api/cloud/market/${slug}/star`, { method: 'POST', token });
  check('stars', starred.status === 200 && starred.body?.starCount === 1, JSON.stringify(starred.body));

  const starredTwice = await request(`/api/cloud/market/${slug}/star`, { method: 'POST', token });
  check('is idempotent', starredTwice.body?.starCount === 1, JSON.stringify(starredTwice.body));

  const unstarred = await request(`/api/cloud/market/${slug}/star`, { method: 'DELETE', token });
  check('unstars', unstarred.body?.starCount === 0, JSON.stringify(unstarred.body));

  /* ------------------------------ 下载 ------------------------------ */
  console.log('\ndownloads');
  const downloaded = await request(`/api/cloud/market/${slug}/download`, { method: 'POST' });
  check('downloads without an account', downloaded.status === 200, `got ${downloaded.status}`);
  check('counts the download', downloaded.body?.downloadCount >= 1, String(downloaded.body?.downloadCount));
  check('returns runnable content', downloaded.body?.payload?.tests?.length === 3);

  /* ------------------------------ 新版本 ------------------------------ */
  console.log('\nversions');
  const republished = await request('/api/cloud/market/publish', {
    method: 'POST',
    token,
    body: {
      kind: 'algorithm',
      slug,
      payload: { ...smokeProblem(problemId), title: { en: 'Smoke Test v2', zh: '冒烟测试 v2' } },
      changelog: 'Automated deployment check',
    },
  });
  check('publishes a second version', republished.body?.listing?.version === 2, JSON.stringify(republished.body));
  check(
    'keeps the version history',
    (republished.body?.listing?.versions || []).length === 2,
    JSON.stringify(republished.body?.listing?.versions)
  );

  /* ------------------------------ 清理 ------------------------------ */
  console.log('\ncleanup');
  const removed = await request(`/api/cloud/market/${slug}`, { method: 'DELETE', token });
  check('deletes the listing', removed.status === 204, `got ${removed.status}`);

  const gone = await request(`/api/cloud/market/${slug}`);
  check('is really gone', gone.status === 404, `got ${gone.status}`);

  const loggedOut = await request('/api/cloud/auth/logout', { method: 'POST', token });
  check('signs out', loggedOut.status === 204, `got ${loggedOut.status}`);

  const afterLogout = await request('/api/cloud/auth/me', { token });
  check('invalidates the token', afterLogout.status === 401, `got ${afterLogout.status}`);

  /* ------------------------------ 结果 ------------------------------ */
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('\nFailures:');
    failures.forEach((entry) => console.log(`  - ${entry}`));
    // 冒烟账号本身留在库里：它的邮箱域名是 .invalid，收不到任何邮件，
    // 而保留它能让排查的人看到当时发生了什么
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('\nSmoke test crashed:', error?.message || error);
  process.exit(1);
});
