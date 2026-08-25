/**
 * git
 *
 * 要证明的是两件事：
 *  1. **内容寻址是真的** —— 这里算出来的 blob hash 和真 git 一致；
 *  2. **CLI 的行为对得上** —— 输出、退出码、失败时说的话都能带走。
 *
 * 第 11 关往后的 GitOps 全建立在这上面：仓库里那份 YAML 才是期望状态。
 */
import { createOpsWorld } from '../../src/lib/opslab/lab';
import {
  GitNetwork, Repository, hashObject, parseCommit, readTree, seedRepository, statusOf, writeTree,
  ObjectStore,
} from '../../src/lib/opslab/git';
import { createVfs } from '../../src/lib/opslab/machine';
import type { OpsWorldSpec } from '../../src/lib/engineering/types';

const NOW = Date.parse('2026-03-02T09:00:00Z');

describe('对象库', () => {
  it('blob 的 hash 和真 git 逐位一致', () => {
    // 这两个值是 `git hash-object` 出来的，不是我们算的
    expect(hashObject('blob', 'hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
    expect(hashObject('blob', '')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  it('同样的内容永远是同一个 hash —— GitOps 敢拿 sha 当凭据就是因为这个', () => {
    const store = new ObjectStore();
    const a = writeTree(store, { 'a/b.yaml': 'x: 1\n', 'c.yaml': 'y: 2\n' });
    const b = writeTree(store, { 'c.yaml': 'y: 2\n', 'a/b.yaml': 'x: 1\n' });
    expect(a).toBe(b);
  });

  it('tree 能原样读回来，包括子目录', () => {
    const store = new ObjectStore();
    const files = { 'apps/portal.yaml': 'kind: Deployment\n', 'README.md': '# platform\n' };
    expect(readTree(store, writeTree(store, files))).toEqual(files);
  });

  it('改一个字节，tree 的 hash 就变了', () => {
    const store = new ObjectStore();
    const before = writeTree(store, { 'a.yaml': 'replicas: 2\n' });
    const after = writeTree(store, { 'a.yaml': 'replicas: 3\n' });
    expect(before).not.toBe(after);
  });
});

describe('仓库', () => {
  function repository() {
    const vfs = createVfs(() => NOW);
    vfs.mkdirp('/root/app');
    const repo = new Repository(vfs, '/root/app', () => NOW);
    repo.init();
    return { vfs, repo };
  }

  it('提交之后 HEAD 指到新的 commit，内容读得回来', () => {
    const { vfs, repo } = repository();
    vfs.writeFile('/root/app/main.yaml', 'replicas: 2\n');
    repo.add(['.']);
    const hash = repo.createCommit('first', { name: 'ops', email: 'ops@corp.internal' });
    expect(repo.headCommit()).toBe(hash);
    expect(repo.committed()).toEqual({ 'main.yaml': 'replicas: 2\n' });
  });

  it('第二次提交挂在第一次下面', () => {
    const { vfs, repo } = repository();
    vfs.writeFile('/root/app/main.yaml', 'replicas: 2\n');
    repo.add(['.']);
    const first = repo.createCommit('first', { name: 'ops', email: 'o@x' });
    vfs.writeFile('/root/app/main.yaml', 'replicas: 3\n');
    repo.add(['.']);
    const second = repo.createCommit('second', { name: 'ops', email: 'o@x' });
    expect(repo.commit(second)!.parents).toEqual([first]);
    expect(repo.history().map((entry) => entry.commit.message)).toEqual(['second', 'first']);
  });

  it('status 把暂存、未暂存、未跟踪分得清', () => {
    const { vfs, repo } = repository();
    vfs.writeFile('/root/app/a.yaml', 'a\n');
    repo.add(['.']);
    repo.createCommit('first', { name: 'ops', email: 'o@x' });

    vfs.writeFile('/root/app/a.yaml', 'a changed\n');
    vfs.writeFile('/root/app/b.yaml', 'b\n');
    vfs.writeFile('/root/app/c.yaml', 'c\n');
    repo.add(['b.yaml']);

    const state = statusOf(repo);
    expect(state.staged).toEqual([{ path: 'b.yaml', state: 'added' }]);
    expect(state.unstaged).toEqual([{ path: 'a.yaml', state: 'modified' }]);
    expect(state.untracked).toEqual(['c.yaml']);
  });

  it('仓库状态全在 .git 下面 —— 快照回放才对得上', () => {
    const { vfs, repo } = repository();
    vfs.writeFile('/root/app/a.yaml', 'a\n');
    repo.add(['.']);
    const hash = repo.createCommit('first', { name: 'ops', email: 'o@x' });

    // 换一个 Repository 实例（内存里的缓存全丢），照样读得出来
    const reopened = Repository.find(vfs, '/root/app/deep/er', () => NOW)!;
    expect(reopened.root).toBe('/root/app');
    expect(reopened.headCommit()).toBe(hash);
    expect(reopened.committed()).toEqual({ 'a.yaml': 'a\n' });
  });

  it('切分支会把工作树换过去', () => {
    const { vfs, repo } = repository();
    vfs.writeFile('/root/app/a.yaml', 'main\n');
    repo.add(['.']);
    repo.createCommit('on main', { name: 'ops', email: 'o@x' });

    repo.checkout('feature', true);
    vfs.writeFile('/root/app/a.yaml', 'feature\n');
    vfs.writeFile('/root/app/only-here.yaml', 'x\n');
    repo.add(['.']);
    repo.createCommit('on feature', { name: 'ops', email: 'o@x' });

    repo.checkout('main');
    expect(vfs.readFile('/root/app/a.yaml')).toBe('main\n');
    // 分支上新加的文件切回来之后不该还在
    expect(vfs.exists('/root/app/only-here.yaml')).toBe(false);
  });
});

describe('远端', () => {
  it('URL 归一化：结尾的斜杠与 .git 不算数', () => {
    const network = new GitNetwork();
    network.create('https://git.corp.internal/platform/apps');
    expect(network.has('https://git.corp.internal/platform/apps.git')).toBe(true);
    expect(network.has('https://git.corp.internal/platform/apps/')).toBe(true);
    expect(network.has('https://git.corp.internal/platform/other')).toBe(false);
  });

  it('seedRepository 铺出来的内容 clone 得到', () => {
    const network = new GitNetwork();
    const bare = network.create('https://git.corp.internal/platform/apps');
    const head = seedRepository(bare, { 'apps/portal.yaml': 'kind: Deployment\n' }, { timestamp: NOW });
    expect(bare.refs.main).toBe(head);
    expect(readTree(bare.objects, parseCommit(bare.objects.get(head)!.body).tree))
      .toEqual({ 'apps/portal.yaml': 'kind: Deployment\n' });
  });
});

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const WORLD: OpsWorldSpec = {
  namespaces: ['default'],
  gitRepositories: [
    {
      url: 'https://git.corp.internal/platform/apps',
      files: { 'apps/portal.yaml': 'kind: Deployment\nreplicas: 2\n', 'README.md': '# platform\n' },
      message: 'bootstrap platform repo',
    },
    { url: 'https://git.corp.internal/platform/frozen', files: { 'a.txt': 'a\n' }, readOnly: true },
  ],
};

describe('git 命令', () => {
  async function world() {
    return createOpsWorld({ world: WORLD });
  }

  it('clone 下来的是工作树，不是一堆对象', async () => {
    const w = await world();
    const cloned = await w.run('git clone https://git.corp.internal/platform/apps');
    expect(cloned.code).toBe(0);
    expect(cloned.stderr).toContain("Cloning into 'apps'...");
    expect(w.machine.vfs.readFile('/root/apps/apps/portal.yaml')).toBe('kind: Deployment\nreplicas: 2\n');

    const status = await w.run('cd /root/apps && git status --porcelain');
    expect(status.stdout).toBe('');
  });

  it('域名解析不到时报的是 Could not resolve host', async () => {
    const w = await world();
    const result = await w.run('git clone https://git.example.com/nope/nope');
    expect(result.code).toBe(128);
    expect(result.stderr).toContain('Could not resolve host: git.example.com');
  });

  it('主机在但仓库不在，报的是 repository not found —— 两件事要分得开', async () => {
    const w = await world();
    const result = await w.run('git clone https://git.corp.internal/platform/nope');
    expect(result.code).toBe(128);
    expect(result.stderr).toContain("repository 'https://git.corp.internal/platform/nope' not found");
  });

  it('改一行、提交、推上去，远端的 ref 跟着动', async () => {
    const w = await world();
    await w.run('git clone https://git.corp.internal/platform/apps');
    await w.run("cd /root/apps && sed -i 's/replicas: 2/replicas: 3/' apps/portal.yaml");

    const diff = await w.run('cd /root/apps && git diff');
    expect(diff.stdout).toContain('-replicas: 2');
    expect(diff.stdout).toContain('+replicas: 3');

    await w.run('cd /root/apps && git add apps/portal.yaml');
    const committed = await w.run("cd /root/apps && git commit -m 'scale portal to 3'");
    expect(committed.stdout).toMatch(/^\[main [0-9a-f]{7}\] scale portal to 3\n/);

    const pushed = await w.run('cd /root/apps && git push origin main');
    expect(pushed.code).toBe(0);

    const bare = w.git.get('https://git.corp.internal/platform/apps')!;
    const head = bare.refs.main;
    const tree = parseCommit(bare.objects.get(head)!.body).tree;
    expect(readTree(bare.objects, tree)['apps/portal.yaml']).toBe('kind: Deployment\nreplicas: 3\n');
  });

  it('没东西可提交时退出码非 0，而且说清楚了', async () => {
    const w = await world();
    await w.run('git clone https://git.corp.internal/platform/apps');
    const result = await w.run("cd /root/apps && git commit -m 'nothing'");
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('nothing to commit, working tree clean');
  });

  it('只读仓库 push 被 403 拒掉', async () => {
    const w = await world();
    await w.run('git clone https://git.corp.internal/platform/frozen');
    await w.run("cd /root/frozen && echo b > b.txt && git add . && git commit -m 'add b'");
    const result = await w.run('cd /root/frozen && git push origin main');
    expect(result.code).toBe(128);
    expect(result.stderr).toContain('403');
  });

  it('别人推了之后 pull 得下来', async () => {
    const w = await world();
    await w.run('git clone https://git.corp.internal/platform/apps');
    // 平台组在另一台机器上推了一版
    const bare = w.git.get('https://git.corp.internal/platform/apps')!;
    seedRepository(bare, { 'apps/portal.yaml': 'kind: Deployment\nreplicas: 5\n' }, {
      message: 'platform bumped it', timestamp: w.now(),
    });

    const pulled = await w.run('cd /root/apps && git pull origin main');
    expect(pulled.stdout).toContain('Fast-forward');
    expect(w.machine.vfs.readFile('/root/apps/apps/portal.yaml')).toContain('replicas: 5');
  });

  it('git log --oneline 与 rev-parse HEAD 对得上', async () => {
    const w = await world();
    await w.run('git clone https://git.corp.internal/platform/apps');
    const head = await w.run('cd /root/apps && git rev-parse HEAD');
    const log = await w.run('cd /root/apps && git log --oneline');
    expect(log.stdout.trim()).toBe(`${head.stdout.trim().slice(0, 7)} bootstrap platform repo`);
  });

  it('git hash-object 和对象库算的是同一个值', async () => {
    const w = await world();
    await w.run('git clone https://git.corp.internal/platform/apps');
    const result = await w.run('cd /root/apps && git hash-object README.md');
    expect(result.stdout.trim()).toBe(hashObject('blob', '# platform\n'));
  });

  it('不在仓库里的时候报 not a git repository', async () => {
    const w = await world();
    const result = await w.run('git status');
    expect(result.code).toBe(128);
    expect(result.stderr).toContain('not a git repository');
  });
});
