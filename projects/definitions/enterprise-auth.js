/**
 * 工程实战 · 企业级鉴权授权系统
 *
 * 注意：代码片段使用 String.raw 模板，不要在片段里写 `${}`。
 */
const { t, code, file, readonlyFile, spec, gate } = require('./_helpers');

/* ------------------------------------------------------------------ */
/* 平台提供的基础设施                                                   */
/* ------------------------------------------------------------------ */

const contract = readonlyFile(
  'src/contract.ts',
  code`
    /** Contract provided by the platform (read-only) */

    /** A user within one tenant */
    export interface UserProfile {
      userId: string;
      tenantId: string;
      /** Directly granted role names; inheritance between roles only appears in stage 8 */
      roles: string[];
    }

    /**
     * The identity decoded from an access token. This is the one and only representation of who you
     * are in the whole system.
     */
    export interface SessionClaims {
      /** User id */
      sub: string;
      tenantId: string;
      /** Session id; logout and rotation both work at this granularity */
      sid: string;
      /** Issued at (virtual clock milliseconds) */
      iat: number;
      /** Expires at (virtual clock milliseconds) */
      exp: number;
      /** Revocation epoch, meaningful from stage 4 on */
      epoch?: number;
    }

    /**
     * Collection names for server-side state in the store.
     *
     * These names are **fixed by convention**: the specs count entries in the store by name,
     * so storing under a different name hides the state where the specs cannot see it, which means
     * it does not count.
     */
    export const COLLECTIONS = {
      /** Refresh tokens, keyed by token id */
      refresh: 'refresh',
      /** Revocation records; the key is up to you, but the entries get counted */
      revocations: 'revocations',
      /** Authorization codes */
      codes: 'codes',
      /** Business data; every row carries a tenant field naming the tenant it belongs to */
      documents: 'documents',
      /** Audit log */
      audit: 'audit',
      /** Failed-login counts and lockout state */
      lockouts: 'lockouts',
    };

    /** Stage 8: the role directory is injected by the platform and every read is counted */
    export interface RoleDefinition {
      name: string;
      /** Permissions this role holds directly; wildcards such as 'doc:*' are supported */
      permissions: string[];
      /** Which roles it inherits from. The graph may contain cycles. */
      inherits: string[];
    }

    export interface RoleDirectory {
      /** Read one role definition. Returns undefined when it does not exist. */
      read(name: string): RoleDefinition | undefined;
    }
  `
);

const crypto = readonlyFile(
  'src/support/crypto.ts',
  code`
    /**
     * Cryptography toolkit (read-only, provided by the platform)
     *
     * It is not really SHA-256, but it keeps the three properties this project actually cares about:
     *
     * - **slow hashes are slow**: slowHash advances the virtual clock by the iteration count and
     * records those rounds in
     *   counters.kdfRounds. How many KDF rounds your login really does is something you can measure;
     * - **signatures are unforgeable**: hmac cannot be computed without the key, and changing one
     * byte breaks the signature;
     * - **comparison can be constant-time**: constantTimeEqual records every call,
     *   so whether you used it is measurable too.
     */
    import { random, sleep } from '@lab/env';
    import { count } from '@lab/metrics';

    /** How many iterations count as one millisecond of virtual time */
    const ROUNDS_PER_MS = 1000;
    const HEX = 16;

    function fold(text: string, seed: number): number {
      let acc = seed >>> 0;
      for (let index = 0; index < text.length; index += 1) {
        acc = (Math.imul(acc ^ text.charCodeAt(index), 16777619) + 1) >>> 0;
      }
      return acc >>> 0;
    }

    function digest(text: string, seed: number): string {
      const head = fold(text, seed);
      const tail = fold(head.toString(HEX) + '|' + text, 2166136261);
      return head.toString(HEX).padStart(8, '0') + tail.toString(HEX).padStart(8, '0');
    }

    /** An ordinary digest: fast, computable by anyone — do not store passwords with it */
    export function sha256(text: string): string {
      return digest(text, 2166136261);
    }

    /** A keyed digest. Wrong key, wrong signature. */
    export function hmac(secret: string, message: string): string {
      return digest('k:' + secret + '|m:' + message, 40389);
    }

    /**
     * Slow hash (playing the part of PBKDF2 / bcrypt / argon2)
     *
     * More rounds means slower, which is exactly the point: it makes offline cracking cost more too.
     * Every call records the rounds in counters.kdfRounds and advances the virtual clock accordingly.
     */
    export async function slowHash(password: string, salt: string, rounds: number): Promise<string> {
      const total = Math.max(1, Math.floor(rounds));
      count('kdfRounds', total);
      await sleep(Math.max(1, Math.round(total / ROUNDS_PER_MS)));
      return digest('s:' + salt + '|p:' + password + '|r:' + total, 5381);
    }

    function sameBytes(left: string, right: string): boolean {
      const width = Math.max(left.length, right.length);
      let diff = left.length === right.length ? 0 : 1;
      for (let index = 0; index < width; index += 1) {
        diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
      }
      return diff === 0;
    }

    /**
     * Constant-time comparison: it takes the same time no matter which character differs first.
     *
     * Every call records a counters.constantTimeCompares, which is how the specs tell
     * whether you really used it or wrote an === that returns early.
     */
    export function constantTimeEqual(left: string, right: string): boolean {
      count('constantTimeCompares');
      return sameBytes(left, right);
    }

    /** Reproducible random salt. Two calls within one spec are always different. */
    export function randomSalt(): string {
      return digest('salt:' + random() + ':' + random(), 4294967291).slice(0, 12);
    }

    /** Reproducible random id, for session ids, token ids and authorization codes */
    export function randomId(prefix: string): string {
      return prefix + '_' + digest('id:' + random(), 1103515245).slice(0, 10);
    }

    /**
     * Encoding for token segments: hexadecimal, **reversible and unencrypted**.
     *
     * The base64url that real JWTs use is just as reversible. Putting a secret in the payload
     * sends it in the clear to anyone holding the token.
     */
    export function encodeSegment(value: unknown): string {
      const text = JSON.stringify(value);
      let out = '';
      for (let index = 0; index < text.length; index += 1) {
        out += text.charCodeAt(index).toString(HEX).padStart(4, '0');
      }
      return out;
    }

    export function decodeSegment(segment: string): unknown {
      try {
        let text = '';
        for (let index = 0; index + 4 <= segment.length; index += 4) {
          text += String.fromCharCode(parseInt(segment.slice(index, index + 4), HEX));
        }
        return JSON.parse(text);
      } catch (error) {
        return null;
      }
    }

    /** An asymmetric key pair, used to verify ID tokens in stage 7. */
    export interface KeyPair {
      kid: string;
      privateKey: string;
      publicKey: string;
    }

    export function keyPair(kid: string): KeyPair {
      return { kid, privateKey: 'sk-' + kid, publicKey: 'pk-' + kid };
    }

    /** Sign with the private key */
    export function signRsa(privateKey: string, message: string): string {
      return hmac(privateKey, message);
    }

    /**
     * Verify with the public key.
     *
     * Note that a public key **can only verify, never sign** — which is the whole point of
     * asymmetric crypto, and also
     * the premise of the algorithm-confusion attack in stage 7: the attacker can obtain the public
     * key, and if you use it
     * as an HMAC secret, they can sign tokens you will accept.
     */
    export function verifyRsa(publicKey: string, message: string, signature: string): boolean {
      const derived = 'sk-' + publicKey.slice('pk-'.length);
      return sameBytes(hmac(derived, message), signature);
    }
  `
);

const store = readonlyFile(
  'src/support/store.ts',
  code`
    /**
     * Server-side state store (read-only, provided by the platform)
     *
     * Treat it as a database: only what survives a process restart really got stored.
     * The specs rebuild a fresh service instance against the same store, and state hidden in module
     * variables does not survive that.
     *
     * It also keeps per-tenant accounting: **a record carrying a tenant field belongs to that tenant**,
     * and reading it with a mismatched scope (or no scope at all) records a
     * counters.crossTenantReads. That is exactly what the stage 11 gate measures.
     */
    import { count } from '@lab/metrics';

    export interface StoreScope {
      /** Which tenant this read is on behalf of. Omitted = no tenant, which means reading everyone's. */
      tenantId?: string;
    }

    /** Everything stored is a plain object; those with a tenant field take part in tenant accounting */
    export type StoreRecord = Record<string, unknown>;

    export interface Store {
      put(collection: string, key: string, value: StoreRecord): void;
      get(collection: string, key: string, scope?: StoreScope): StoreRecord | undefined;
      /** List every record in a collection */
      list(collection: string, scope?: StoreScope): StoreRecord[];
      remove(collection: string, key: string): void;
      /** How many records a collection holds. The specs use it to count the state you left behind. */
      size(collection: string): number;
      keys(collection: string): string[];
    }

    export function createStore(): Store {
      const data = new Map<string, Map<string, StoreRecord>>();

      function bucket(collection: string): Map<string, StoreRecord> {
        const existing = data.get(collection);
        if (existing) return existing;
        const created = new Map<string, StoreRecord>();
        data.set(collection, created);
        return created;
      }

      /** The record carries a tenant and this read is not for that tenant — that is a cross-tenant read */
      function audit(record: StoreRecord, scope?: StoreScope): void {
        const owner = record.tenant;
        if (typeof owner !== 'string') return;
        if (scope && scope.tenantId === owner) return;
        count('crossTenantReads');
      }

      return {
        put(collection: string, key: string, value: StoreRecord): void {
          bucket(collection).set(key, { ...value });
        },

        get(collection: string, key: string, scope?: StoreScope): StoreRecord | undefined {
          const record = bucket(collection).get(key);
          if (!record) return undefined;
          audit(record, scope);
          return { ...record };
        },

        list(collection: string, scope?: StoreScope): StoreRecord[] {
          const records = Array.from(bucket(collection).values());
          for (const record of records) audit(record, scope);
          return records.map((record) => ({ ...record }));
        },

        remove(collection: string, key: string): void {
          bucket(collection).delete(key);
        },

        size(collection: string): number {
          return bucket(collection).size;
        },

        keys(collection: string): string[] {
          return Array.from(bucket(collection).keys());
        },
      };
    }
  `
);

/* ------------------------------------------------------------------ */
/* 第 1 关 · 密码怎么存                                                 */
/* ------------------------------------------------------------------ */

const stage1 = {
  id: 'credential-store',
  title: t('第 1 关 · 密码怎么存', 'Stage 1 · Storing a password'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '整套鉴权系统的底座是一句话：**服务端不该知道用户的密码**。',
      '它只存一个「验得出来、但反推不回去」的东西。',
      '',
      '这一关做的就是那个东西。后面十一关的所有令牌、所有权限，',
      '追到根上都是因为这一步认出了「你是你」；这一步松了，上面全是装饰。',
      '',
      '## 要实现什么',
      '',
      '在 `src/credentials.ts` 实现 `createCredentialStore(options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `register(userId, password)` | 生成**每用户独立**的盐，慢哈希后存下来 |',
      '| `verify(userId, password)` | 用这条记录的盐和轮数重算，常数时间比较 |',
      '| `record(userId)` | 只读地看一眼存了什么，用户不存在返回 undefined |',
      '',
      '平台的 `src/support/crypto.ts` 给了三样东西：`randomSalt()`、',
      '`slowHash(password, salt, rounds)`、`constantTimeEqual(a, b)`。',
      '慢哈希会按轮数推进虚拟时钟，也会把轮数记进 `counters.kdfRounds`。',
      '',
      '`options.rounds` 可以不传 —— 不传时用你自己的默认值，而这个默认值是被量的。',
      '',
      '## 怎么算过',
      '',
      '- 存下来的东西里没有明文密码，也没有「密码的快摘要」；',
      '- 两个用户用同一个密码，存下来的哈希不同（门槛 `counters.kdfRounds ≥ 100000`',
      '  量的是默认轮数够不够慢：一次 `register` 就得烧掉十万轮）；',
      '- 比较必须走 `constantTimeEqual`，用例会检查它真的被调用过；',
      '- **用户不存在时也要走完整的哈希**，让「查无此人」和「密码错了」',
      '  花掉一模一样的时间（门槛 `counters.timingGapMs = 0` 量的正是这个差值）；',
      '- 改密码之后旧密码立刻失效，并且换一份新的盐。',
      '',
      '## 最容易写错的地方',
      '',
      '`if (!user) return false;` —— 一行，看起来毫无问题，功能也完全正确。',
      '',
      '但它让「查无此人」立刻返回，而「密码错了」要等一百毫秒。',
      '攻击者拿一个用户名字典跑一遍，按响应时间就能筛出哪些账号真实存在 ——',
      '密码还没开始猜，用户名已经泄露完了。',
    ].join('\n'),
    [
      'The whole authentication stack rests on one sentence: **the server should not know the password.**',
      'It stores something that can be checked but not reversed.',
      '',
      'That something is what you build here. Every token and every permission in the eleven stages that',
      'follow exists because this step recognised you. If this step is loose, everything above it is decoration.',
      '',
      '## What to build',
      '',
      'Implement `createCredentialStore(options)` in `src/credentials.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `register(userId, password)` | Generate a **per-user** salt, slow-hash the password, store the result |',
      '| `verify(userId, password)` | Recompute with that record\'s salt and rounds, compare in constant time |',
      '| `record(userId)` | Read back what was stored; undefined when the user does not exist |',
      '',
      'The platform module `src/support/crypto.ts` gives you `randomSalt()`,',
      '`slowHash(password, salt, rounds)` and `constantTimeEqual(a, b)`. The slow hash advances the virtual',
      'clock in proportion to the rounds and records them in `counters.kdfRounds`.',
      '',
      '`options.rounds` is optional — leave it out and your own default applies, and that default is measured.',
      '',
      '## What counts as passing',
      '',
      '- Nothing stored resembles the plaintext, nor a fast digest of it;',
      '- Two users with the same password store different hashes (the `counters.kdfRounds ≥ 100000` gate',
      '  measures whether your default is slow enough: one `register` has to burn a hundred thousand rounds);',
      '- Comparison goes through `constantTimeEqual`, and the specs check that it really was called;',
      '- **An unknown user still pays for a full hash**, so "no such account" and "wrong password" take',
      '  exactly the same time (the `counters.timingGapMs = 0` gate measures that difference);',
      '- Changing a password invalidates the old one immediately and rolls a fresh salt.',
      '',
      '## The easiest thing to get wrong',
      '',
      '`if (!user) return false;` — one line, apparently harmless, functionally correct.',
      '',
      'It also makes "no such account" return instantly while "wrong password" takes a hundred milliseconds.',
      'Run a username dictionary through it, sort by response time, and you have enumerated every real',
      'account on the system before guessing a single password.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  R["register(userId, password)"] --> S["randomSalt()<br/>每个用户一份"]',
      '  S --> H["slowHash(password, salt, rounds)"]',
      '  H --> ST["存 salt / hash / rounds<br/>明文密码到此为止"]',
      '',
      '  V["verify(userId, password)"] --> L{"这个用户存在吗？"}',
      '  L -- 存在 --> U["取这条记录的 salt 与 rounds"]',
      '  L -- 不存在 --> D["取固定的假记录<br/>salt 与 rounds 同样规格"]',
      '  U --> C["slowHash 重算一遍"]',
      '  D --> C',
      '  C --> EQ["constantTimeEqual(重算的, 存着的)"]',
      '  EQ --> RET["返回 true / false<br/>两条路径耗时相同"]',
      '```',
      '',
      '要点：两条路径在 `slowHash` 处**合流**，而不是在 `if` 处分叉后各走各的。',
      '假记录不是为了「让代码好看」，它是这张图里唯一让计时攻击失效的东西。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  R["register(userId, password)"] --> S["randomSalt()<br/>one per user"]',
      '  S --> H["slowHash(password, salt, rounds)"]',
      '  H --> ST["store salt / hash / rounds<br/>the plaintext ends here"]',
      '',
      '  V["verify(userId, password)"] --> L{"does the user exist?"}',
      '  L -- exists --> U["take that record\'s salt and rounds"]',
      '  L -- missing --> D["take the fixed decoy record<br/>same salt and round shape"]',
      '  U --> C["slowHash recomputes"]',
      '  D --> C',
      '  C --> EQ["constantTimeEqual(recomputed, stored)"]',
      '  EQ --> RET["return true / false<br/>both paths cost the same"]',
      '```',
      '',
      'The point: both paths **merge** at `slowHash` instead of forking at the `if` and going their separate',
      'ways. The decoy record is not there to make the code tidy — it is the only thing in this diagram that',
      'defeats a timing attack.',
    ].join('\n')
  ),
  checklist: [
    t('每个用户一份独立的盐', 'A separate salt for every user'),
    t('默认轮数不低于 100000', 'The default cost is at least 100000 rounds'),
    t('比较走 constantTimeEqual', 'Comparison goes through constantTimeEqual'),
    t('用户不存在也走一遍假哈希', 'A missing user still pays for a decoy hash'),
    t('改密码后旧密码失效并换盐', 'Changing the password rolls a new salt'),
  ],
  pitfalls: [
    t(
      '全局一个盐，或者干脆拿 userId 当盐。存下来的还是「一个密码对应一个固定哈希」，攻击者拖库之后按彩虹表一次比对就能批量还原 —— 盐的意义是让每一条记录都要单独算一次，不是让哈希看起来乱一点。',
      'One global salt, or using the userId as the salt. The result is still "one password maps to one fixed hash", so a stolen table falls to a single rainbow-table pass. A salt exists to force the attacker to compute each record separately, not to make the digest look messier.'
    ),
    t(
      '用 `sha256(password)` 存。它快得可以每秒算几十亿次，也就意味着攻击者拿到库之后每秒能试几十亿个密码。慢哈希慢是设计目标，不是缺陷。',
      'Storing `sha256(password)`. It is fast enough to run billions of times a second, which is exactly how fast an attacker can guess once the table leaks. A password hash is slow on purpose; that is the feature.'
    ),
    t(
      '用 `===` 比较哈希。JavaScript 的字符串比较遇到第一个不同的字符就返回，逐字节试探能把「猜 16 位哈希」从 16 的 N 次方降到 16×N —— 这类攻击对本地测试完全不可见，只有在能反复计时的网络上才成立。',
      'Comparing digests with `===`. JavaScript string comparison returns at the first differing character, which turns guessing a 16-character digest from exponential into linear. The attack is invisible in local tests and entirely real over a network you can time repeatedly.'
    ),
    t(
      '把轮数写死在 verify 里，而不是从记录里读。今天默认 100000，明天想提到 300000，所有老用户的密码在提高轮数的那一刻**全部失效** —— 轮数必须跟着每条记录走，才谈得上以后能升级。',
      'Hard-coding the round count in verify instead of reading it from the record. Raise the default from 100000 to 300000 tomorrow and every existing password breaks at once. The cost has to travel with each record for the parameter to be upgradable at all.'
    ),
  ],
  hints: [
    t(
      '与其在「用户不存在」那条分支上补时间，不如准备一条固定的假记录：salt 是常量、rounds 和真实记录一样、hash 是一个真实哈希永远不会等于的值。两条路径于是走的是同一段代码。',
      'Rather than padding the "user missing" branch with a delay, keep a fixed decoy record: a constant salt, the same round count as a real record, and a hash no real digest can equal. Both paths then run the same code.'
    ),
    t(
      'register 每次都重新 randomSalt()，改密码就自然换了盐 —— 不需要为「改密码」写一条单独的路径。',
      'Call randomSalt() on every register and a password change rolls a new salt for free — no separate code path needed.'
    ),
  ],
  extension: t(
    [
      '真实世界里这一层的选型是有共识的：**PBKDF2 < bcrypt < scrypt < argon2id**，',
      '越靠右越难用专用硬件加速。PBKDF2 只烧 CPU，GPU 上并行几万路毫无压力；',
      'argon2 刻意占用大量内存，把攻击者的显卡拉回和 CPU 差不多的量级。',
      '',
      '轮数不是定死的。OWASP 的建议是「调到你的服务器上大约 0.5 秒一次」，',
      '并且**随硬件逐年上调** —— 这就是为什么轮数必须存在每条记录里：',
      '下次调参时老记录仍然能验，用户下次登录时顺手重算成新参数。',
      '',
      '2012 年 LinkedIn 泄露的 650 万条密码是无盐 SHA-1，几天之内被还原了绝大部分。',
      '同年 Dropbox 泄露的库用了 bcrypt，四年后才被公开，绝大多数密码至今没被还原。',
      '差别不在于哪家更小心，而在于这一关的选择。',
    ].join('\n'),
    [
      'The industry has a consensus ordering here: **PBKDF2 < bcrypt < scrypt < argon2id**, where further',
      'right means harder to accelerate with dedicated hardware. PBKDF2 only burns CPU, and a GPU runs tens',
      'of thousands of those in parallel without effort; argon2 deliberately consumes memory, dragging the',
      "attacker's graphics card back down to roughly CPU speed.",
      '',
      'The round count is not a constant. OWASP\'s advice is to tune it to about half a second on your own',
      'hardware and **raise it as hardware improves** — which is exactly why the count has to live in each',
      'record: old records still verify after a retune, and each user is silently upgraded on their next login.',
      '',
      "In 2012 LinkedIn leaked 6.5 million unsalted SHA-1 passwords and most were recovered within days.",
      'The Dropbox breach of the same year used bcrypt; it surfaced publicly four years later and the bulk of',
      'those passwords have still never been recovered. The difference is not diligence, it is this stage.',
    ].join('\n')
  ),
  focus: ['correctness', 'resilience', 'encapsulation'],
  lab: {},
  starterFiles: [
    contract,
    crypto,
    store,
    file(
      'src/credentials.ts',
      code`
        import { constantTimeEqual, randomSalt, slowHash } from './support/crypto';

        /** One credential record. Note that it holds no password. */
        export interface CredentialRecord {
          userId: string;
          salt: string;
          hash: string;
          /** How many rounds this record was computed with; verification has to use the same number */
          rounds: number;
        }

        export interface CredentialOptions {
          /** Omit it to use your own default — and that default is what the gate measures */
          rounds?: number;
        }

        export interface CredentialStore {
          register(userId: string, password: string): Promise<void>;
          verify(userId: string, password: string): Promise<boolean>;
          record(userId: string): CredentialRecord | undefined;
        }

        export function createCredentialStore(options: CredentialOptions = {}): CredentialStore {
          // TODO: implement this
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-1.spec.ts',
      code`
        import { createCredentialStore } from '../src/credentials';
        import { now } from '@lab/env';
        import { count, getCounters } from '@lab/metrics';

        describe('Stage 1 · How passwords are stored', () => {
          it('the right password passes after registering', async () => {
            const store = createCredentialStore();
            await store.register('alice', 'correct horse battery');

            expect(await store.verify('alice', 'correct horse battery')).toBe(true);
          });

          it('a password one character off does not pass', async () => {
            const store = createCredentialStore();
            await store.register('alice', 'correct horse battery');

            expect(await store.verify('alice', 'correct horse batterY')).toBe(false);
          });

          it('nothing stored contains the plaintext password', async () => {
            const store = createCredentialStore();
            await store.register('alice', 'hunter2-secret');

            const record = store.record('alice');
            expect(record).toBeTruthy();
            expect(JSON.stringify(record)).not.toContain('hunter2-secret');
          });

          it('the same password stores different hashes for two users', async () => {
            const store = createCredentialStore();
            await store.register('alice', 'same-password');
            await store.register('bob', 'same-password');

            const alice = store.record('alice');
            const bob = store.record('bob');
            expect(alice.salt).not.toBe(bob.salt);
            expect(alice.hash).not.toBe(bob.hash);
          });

          it('the default round count is slow enough [gate:kdf]', async () => {
            const store = createCredentialStore();
            await store.register('alice', 'correct horse battery');

            const record = store.record('alice');
            expect(record.rounds).toBeGreaterThanOrEqual(100000);
          });

          it('a nonexistent user costs exactly the same [gate:timing]', async () => {
            const store = createCredentialStore();
            await store.register('alice', 'correct horse battery');

            const beforeKnown = now();
            expect(await store.verify('alice', 'wrong-password')).toBe(false);
            const known = now() - beforeKnown;

            const beforeUnknown = now();
            expect(await store.verify('nobody-here', 'wrong-password')).toBe(false);
            const unknown = now() - beforeUnknown;

            // This difference is what the gate measures: the two paths must take identical time
            count('timingGapMs', Math.abs(known - unknown));
            expect(known).toBeGreaterThan(0);
          });

          it('the comparison goes through the constant-time comparison', async () => {
            const store = createCredentialStore();
            await store.register('alice', 'correct horse battery');

            const before = getCounters()['constantTimeCompares'] || 0;
            await store.verify('alice', 'correct horse battery');
            const after = getCounters()['constantTimeCompares'] || 0;

            expect(after).toBeGreaterThan(before);
          });

          it('the old password stops working after a change, and the salt is new', async () => {
            const store = createCredentialStore();
            await store.register('alice', 'old-password');
            const before = store.record('alice');

            await store.register('alice', 'new-password');
            const after = store.record('alice');

            expect(await store.verify('alice', 'old-password')).toBe(false);
            expect(await store.verify('alice', 'new-password')).toBe(true);
            expect(after.salt).not.toBe(before.salt);
          });

          it('a nonexistent user returns false rather than throwing', async () => {
            const store = createCredentialStore();

            expect(await store.verify('ghost', 'anything')).toBe(false);
            expect(store.record('ghost')).toBeUndefined();
          });

          it('verifying repeatedly does not corrupt the stored record', async () => {
            const store = createCredentialStore();
            await store.register('alice', 'correct horse battery');
            const before = store.record('alice');

            await store.verify('alice', 'wrong');
            await store.verify('alice', 'correct horse battery');
            const after = store.record('alice');

            expect(after.salt).toBe(before.salt);
            expect(after.hash).toBe(before.hash);
          });

          it('an empty password is handled normally and not treated as no password set', async () => {
            const store = createCredentialStore();
            await store.register('alice', '');

            expect(await store.verify('alice', '')).toBe(true);
            expect(await store.verify('alice', 'x')).toBe(false);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.kdfRounds',
      op: 'gte',
      value: 100000,
      zh: '一次注册至少烧掉 100000 轮 KDF',
      en: 'One registration burns at least 100000 KDF rounds',
      dimension: 'resilience',
      scope: 'gate:kdf',
    }),
    gate({
      metric: 'counters.timingGapMs',
      op: 'eq',
      value: 0,
      zh: '「查无此人」与「密码错了」耗时相同',
      en: '"No such user" and "wrong password" cost the same time',
      unit: 'ms',
      dimension: 'resilience',
    }),
  ],
  referenceFiles: [
    file(
      'src/credentials.ts',
      code`
        import { constantTimeEqual, randomSalt, slowHash } from './support/crypto';

        export interface CredentialRecord {
          userId: string;
          salt: string;
          hash: string;
          rounds: number;
        }

        export interface CredentialOptions {
          rounds?: number;
        }

        export interface CredentialStore {
          register(userId: string, password: string): Promise<void>;
          verify(userId: string, password: string): Promise<boolean>;
          record(userId: string): CredentialRecord | undefined;
        }

        /**
         * The default round count. Raising it does not invalidate old records, because the rounds
         * live in each record.
         */
        const DEFAULT_ROUNDS = 120000;
        /** A floor on rounds: however low a caller asks for, it is not accepted */
        const MIN_ROUNDS = 100000;

        export function createCredentialStore(options: CredentialOptions = {}): CredentialStore {
          const rounds = Math.max(MIN_ROUNDS, options.rounds || DEFAULT_ROUNDS);
          const records = new Map<string, CredentialRecord>();

          /**
           * The dummy record that stands in when there is no such user.
           *
           * Its salt and rounds match a real record, so hashing costs the same;
           * its hash is a value a real digest can never produce, so it never matches.
           */
          const decoy: CredentialRecord = {
            userId: '',
            salt: 'decoy-salt',
            hash: 'no-such-digest',
            rounds,
          };

          return {
            async register(userId: string, password: string): Promise<void> {
              // A fresh salt on every registration, which makes a password change rotate the salt
              // automatically
              const salt = randomSalt();
              const hash = await slowHash(password, salt, rounds);
              records.set(userId, { userId, salt, hash, rounds });
            },

            async verify(userId: string, password: string): Promise<boolean> {
              const known = records.get(userId);
              // The two paths converge here: nothing below knows whether the user exists
              const target = known || decoy;
              const attempt = await slowHash(password, target.salt, target.rounds);
              return constantTimeEqual(attempt, target.hash);
            },

            record(userId: string): CredentialRecord | undefined {
              const found = records.get(userId);
              return found ? { ...found } : undefined;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '三个决定：',
      '',
      '**假记录，而不是补一段延时。** 「查不到就 sleep 100ms」也能让两条路径耗时接近，',
      '但那是在猜一个数：轮数调了、机器换了，这个数就不对了。用同规格的假记录，',
      '两条路径走的是同一行 `slowHash`，耗时天然相等，不需要维护。',
      '',
      '**轮数存进记录，不是存在代码里。** `verify` 读的是 `target.rounds`，',
      '所以把 `DEFAULT_ROUNDS` 从 12 万提到 30 万，昨天注册的用户照样能登录。',
      '这一行是「以后能升级」和「升级那天全站登不上」的分界线。',
      '',
      '**`register` 不区分「新建」和「改密」。** 两者都是「取一份新盐，重算，覆盖」。',
      '少一条分支，就少一处「改密码时忘了换盐」的可能。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      'A decoy record rather than a padded delay. "Sleep 100ms when the user is missing" also makes the two',
      'paths roughly equal, but it is a guessed constant: retune the rounds or move to another machine and the',
      'guess is wrong. With a same-shaped decoy, both paths run the same `slowHash` line and cost the same by',
      'construction, with nothing to maintain.',
      '',
      'The round count lives in the record, not in the code. `verify` reads `target.rounds`, so raising',
      '`DEFAULT_ROUNDS` from 120k to 300k leaves yesterday\'s users able to log in. That one line is the',
      'difference between a parameter you can upgrade and one whose upgrade locks everybody out.',
      '',
      '`register` does not distinguish "create" from "change". Both are "take a fresh salt, recompute,',
      'overwrite". One branch fewer is one fewer place to forget rolling the salt.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 2 关 · 无状态会话令牌                                             */
/* ------------------------------------------------------------------ */

const stage2 = {
  id: 'session-token',
  title: t('第 2 关 · 无状态会话令牌', 'Stage 2 · Stateless session tokens'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '上一关验一次密码要烧掉十万轮 KDF、一百毫秒。如果每个请求都这么验一次，',
      '这套系统的吞吐上限就是「一百毫秒一次」—— 认证本身成了瓶颈。',
      '',
      '所以认证只做一次，之后发一张**通行证**。这一关做的就是那张通行证：',
      '它自带身份和有效期，验它只需要一次签名比较，不需要查库，也不需要再哈希一次。',
      '',
      '## 要实现什么',
      '',
      '在 `src/session.ts` 实现 `createSessionIssuer(options)`，令牌格式是两段：',
      '',
      '```',
      'payload . signature',
      '```',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `issue({ userId, tenantId, sid? })` | 组装 claims，编码成 payload，用 `hmac(secret, payload)` 签名 |',
      '| `verify(token)` | 验签 → 解码 → 查有效期，任何一步不过都返回 `null` |',
      '',
      'claims 的字段在 `src/contract.ts` 里：`sub`、`tenantId`、`sid`、`iat`、`exp`，',
      '外加一个可选的 `epoch` —— 调用方给了就原样带上，第 4 关撤销时会用到它。',
      '时间一律取 `@lab/env` 的 `now()`，也就是虚拟时钟。',
      '',
      '## 怎么算过',
      '',
      '- 合法令牌验得回原样的 claims，`sid` 每次签发都不同；',
      '- 载荷改一个字节（比如把 `tenantId` 换成别人的）就必须验不过；',
      '- 换一把密钥签出来的令牌验不过（门槛 `counters.forgedAccepted = 0`',
      '  数的正是「有多少张伪造的令牌被放行了」，一张都不许有）；',
      '- 过期令牌验不过，`exp` 那一刻起就算过期；',
      '- 乱七八糟的字符串、空串、少一段的令牌返回 `null`，不许抛异常；',
      '- **验令牌不许再走一遍慢哈希**（门槛 `counters.kdfRounds = 0`）；',
      '- 换一个新的 issuer 实例、同一把密钥，老令牌照样验得过 —— 这就是「无状态」。',
      '',
      '## 最容易写错的地方',
      '',
      '先解码再验签。',
      '',
      '`const claims = decode(payload); if (claims.exp < now()) return null;` 读起来很自然，',
      '但这时候 payload 还没验过签 —— 你正在用攻击者提供的数据做判断。',
      '哪怕后面补上验签，中间这几行已经把未经验证的输入喂进了业务逻辑。',
      '**验签是入口，不是检查项之一。**',
    ].join('\n'),
    [
      'Verifying a password costs a hundred thousand KDF rounds and a hundred milliseconds. Do that on every',
      'request and the system tops out at ten requests per second per user: authentication itself becomes the',
      'bottleneck.',
      '',
      'So you authenticate once and hand out a **pass**. That pass is this stage: it carries the identity and',
      'an expiry, and checking it costs one signature comparison — no database, no second hash.',
      '',
      '## What to build',
      '',
      'Implement `createSessionIssuer(options)` in `src/session.ts`. A token has two segments:',
      '',
      '```',
      'payload . signature',
      '```',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `issue({ userId, tenantId, sid? })` | Assemble claims, encode the payload, sign it with `hmac(secret, payload)` |',
      '| `verify(token)` | Check the signature, decode, check the expiry; anything short of all three returns `null` |',
      '',
      'The claim fields live in `src/contract.ts`: `sub`, `tenantId`, `sid`, `iat`, `exp`, plus an optional',
      '`epoch` you copy through when the caller supplies one — stage 4 revokes with it. All times come from',
      '`now()` in `@lab/env`, the virtual clock.',
      '',
      '## What counts as passing',
      '',
      '- A valid token verifies back to the same claims, and `sid` differs on every issue;',
      '- Changing one byte of the payload (swapping in someone else\'s `tenantId`, say) must fail verification;',
      '- A token signed with a different key fails (the `counters.forgedAccepted = 0` gate counts how many',
      '  forged tokens were let through — the answer has to be none);',
      '- An expired token fails, and it is expired from the instant `exp` arrives;',
      '- Garbage strings, empty strings and one-segment tokens return `null` rather than throwing;',
      '- **Verification must not run a slow hash** (the `counters.kdfRounds = 0` gate);',
      '- A brand-new issuer with the same key still verifies old tokens — that is what stateless means.',
      '',
      '## The easiest thing to get wrong',
      '',
      'Decoding before verifying.',
      '',
      '`const claims = decode(payload); if (claims.exp < now()) return null;` reads perfectly naturally, but at',
      'that point the payload is unverified — you are making decisions on attacker-supplied data. Even if the',
      'signature check follows, those few lines already fed unauthenticated input into your logic.',
      '**Signature verification is the door, not one of the checks inside.**',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  I["issue(userId, tenantId)"] --> CL["组装 claims<br/>sub / tenantId / sid / iat / exp"]',
      '  CL --> EN["encodeSegment(claims) 得到 payload"]',
      '  EN --> SG["hmac(secret, payload) 得到签名"]',
      '  SG --> TK["token = payload 加点加签名"]',
      '',
      '  V["verify(token)"] --> SP{"切得出两段吗？"}',
      '  SP -- 切不出 --> NO["返回 null"]',
      '  SP -- 切得出 --> RE["用同一把密钥重算签名"]',
      '  RE --> EQ{"constantTimeEqual 对得上？"}',
      '  EQ -- 对不上 --> NO',
      '  EQ -- 对得上 --> DE["decodeSegment(payload)"]',
      '  DE --> EX{"now() 还没到 exp？"}',
      '  EX -- 到了 --> NO',
      '  EX -- 没到 --> OK["返回 claims"]',
      '```',
      '',
      '要点：解码在验签**之后**。这张图里 `decodeSegment` 只有一条入边，',
      '而那条边来自「签名对得上」。把它挪到前面，整条链就从「先证明可信、再读」',
      '变成了「先读、顺便证明一下」。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  I["issue(userId, tenantId)"] --> CL["assemble claims<br/>sub / tenantId / sid / iat / exp"]',
      '  CL --> EN["encodeSegment(claims) gives the payload"]',
      '  EN --> SG["hmac(secret, payload) gives the signature"]',
      '  SG --> TK["token = payload dot signature"]',
      '',
      '  V["verify(token)"] --> SP{"two segments?"}',
      '  SP -- no --> NO["return null"]',
      '  SP -- yes --> RE["recompute the signature with the same key"]',
      '  RE --> EQ{"constantTimeEqual matches?"}',
      '  EQ -- no --> NO',
      '  EQ -- yes --> DE["decodeSegment(payload)"]',
      '  DE --> EX{"is now() still before exp?"}',
      '  EX -- no --> NO',
      '  EX -- yes --> OK["return claims"]',
      '```',
      '',
      'The point: decoding comes **after** verification. `decodeSegment` has exactly one inbound edge in this',
      'diagram and it comes from "the signature matched". Move it earlier and the chain turns from "prove it,',
      'then read it" into "read it, and prove it along the way".',
    ].join('\n')
  ),
  checklist: [
    t('先验签，再解码', 'Verify the signature before decoding'),
    t('过期令牌一律拒绝', 'Expired tokens are always refused'),
    t('畸形输入返回 null 而不是抛错', 'Malformed input returns null instead of throwing'),
    t('每次签发的 sid 都不同', 'Every issue produces a distinct sid'),
    t('验证过程不做慢哈希、不查库', 'Verification does no slow hash and no lookup'),
  ],
  pitfalls: [
    t(
      '把秘密写进 payload。载荷是十六进制编码的，不是加密的 —— 任何拿到令牌的人都能一眼读出来。真实 JWT 的 base64url 同理，「看起来像乱码」和「保密」是两回事。',
      'Putting secrets in the payload. It is hex-encoded, not encrypted: anyone holding the token can read it. Real JWTs use base64url with exactly the same property — "looks like gibberish" is not "confidential".'
    ),
    t(
      '用 `===` 比签名。和上一关同一个问题，而这次比的是攻击者可以随意重放的字符串：他能一个字符一个字符地试探出正确的签名前缀。',
      'Comparing signatures with `===`. Same problem as the previous stage, except here the attacker controls the string and can replay it freely, probing the correct prefix one character at a time.'
    ),
    t(
      '把有效期做成「签发时记一个 Date.now()，验的时候和真实时间比」。沙箱里的时间是虚拟时钟，你必须用 `@lab/env` 的 `now()`；真实系统里对应的坑是「用本机时间判断别人签发的令牌」，两台机器差几分钟就会互相不认。',
      'Judging expiry against real wall-clock time. In this sandbox time is the virtual clock and you must use `now()` from `@lab/env`. The real-world version of this bug is validating someone else\'s token against your own clock: a few minutes of drift between two machines and they stop trusting each other.'
    ),
    t(
      '令牌验不过时抛异常。上层拿到的是一个需要 try/catch 的调用，而「令牌无效」是最正常不过的日常事件（过期了、被撤了、复制粘贴掉了一半）。异常应该留给「不该发生的事」。',
      'Throwing when a token fails to verify. The caller now needs a try/catch for the single most routine event in the system: expired, revoked, half-copied tokens. Exceptions are for things that should not happen.'
    ),
  ],
  hints: [
    t(
      '`token.split(\'.\')` 之后先检查段数。少一段、多一段都直接返回 null —— 后面所有代码就可以假定拿到的是两段。',
      'Split on the dot and check the segment count first. Anything other than two segments returns null, and every line after that can assume it has two.'
    ),
    t(
      '「无状态」的检验方法很简单：verify 里如果出现了任何 Map、任何 store，那就不是无状态的。它只需要 secret 和当前时间。',
      'The test for statelessness is simple: if `verify` touches any Map or store, it is not stateless. All it needs is the secret and the current time.'
    ),
  ],
  extension: t(
    [
      '这就是 JWT 的骨架。真实 JWT 是三段：`header.payload.signature`，多出来的 header 说明用了哪种算法 ——',
      '第 7 关会讲为什么那一段是历史上最麻烦的设计之一。',
      '',
      '无状态令牌的代价就在这一关的最后一行：**签出去就收不回来了**。',
      '服务端不存任何东西，也就没有任何地方可以标记「这张作废了」。',
      '业界的应对是把有效期压到几分钟，用第 3 关的刷新令牌续期 —— ',
      '于是「被偷走的令牌能用多久」从「几天」变成「几分钟」。',
      '',
      '另一条路是 PASETO：它认为 JWT 的可配置性本身就是漏洞来源，',
      '干脆把算法钉死在版本号里，不给「选算法」这个动作留任何空间。',
    ].join('\n'),
    [
      'This is the skeleton of a JWT. A real one has three segments — `header.payload.signature` — where the',
      'header names the algorithm. Stage 7 covers why that segment is one of the most troublesome design',
      'decisions in the history of web security.',
      '',
      'The price of a stateless token is in the last line of this stage: **once issued, you cannot take it',
      'back.** The server stores nothing, so there is nowhere to mark one as dead. The industry answer is to',
      'cut the lifetime to minutes and renew through the refresh tokens of stage 3, which turns "how long can',
      'a stolen token be used" from days into minutes.',
      '',
      'The other road is PASETO, which treats JWT\'s configurability as the vulnerability itself: the algorithm',
      'is pinned by the version number, leaving no room for the act of "choosing an algorithm" at all.',
    ].join('\n')
  ),
  focus: ['correctness', 'latency', 'resilience'],
  lab: {},
  starterFiles: [
    file(
      'src/session.ts',
      code`
        import type { SessionClaims } from './contract';
        import { constantTimeEqual, decodeSegment, encodeSegment, hmac, randomId } from './support/crypto';
        import { now } from '@lab/env';

        export interface SessionIssuerOptions {
          /** Signing key. Change the key and every previously signed token stops verifying. */
          secret: string;
          /** Access token lifetime in milliseconds */
          ttlMs: number;
        }

        export interface SessionInput {
          userId: string;
          tenantId: string;
          /** Generated for you when omitted */
          sid?: string;
          /** Revocation epoch, only needed from stage 4. When given, it is carried into the claims as-is. */
          epoch?: number;
        }

        export interface SessionIssuer {
          issue(input: SessionInput): string;
          /** Anything that fails verification returns null; do not throw */
          verify(token: string): SessionClaims | null;
        }

        export function createSessionIssuer(options: SessionIssuerOptions): SessionIssuer {
          // TODO: implement this
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-2.spec.ts',
      code`
        import { createSessionIssuer } from '../src/session';
        import { decodeSegment, encodeSegment, hmac } from '../src/support/crypto';
        import { now, sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const SECRET = 'session-signing-key';
        const TTL = 60000;

        function makeIssuer(secret = SECRET, ttlMs = TTL) {
          return createSessionIssuer({ secret, ttlMs });
        }

        /** Every forged token that gets through is recorded, and that is what the gate counts */
        function expectRejected(issuer: any, token: string): void {
          const claims = issuer.verify(token);
          if (claims) count('forgedAccepted');
          expect(claims).toBeNull();
        }

        describe('Stage 2 · Stateless session tokens', () => {
          it('a signed token verifies back to the same identity', () => {
            const issuer = makeIssuer();
            const token = issuer.issue({ userId: 'alice', tenantId: 'acme' });

            const claims = issuer.verify(token);
            expect(claims).toBeTruthy();
            expect(claims.sub).toBe('alice');
            expect(claims.tenantId).toBe('acme');
            expect(claims.exp).toBe(claims.iat + TTL);
          });

          it('every issue produces a different session id', () => {
            const issuer = makeIssuer();
            const first = issuer.verify(issuer.issue({ userId: 'alice', tenantId: 'acme' }));
            const second = issuer.verify(issuer.issue({ userId: 'alice', tenantId: 'acme' }));

            expect(first.sid).toBeTruthy();
            expect(second.sid).not.toBe(first.sid);
          });

          it('a session id specified by the caller is carried through', () => {
            const issuer = makeIssuer();
            const token = issuer.issue({ userId: 'alice', tenantId: 'acme', sid: 'sid-fixed' });

            expect(issuer.verify(token).sid).toBe('sid-fixed');
          });

          it('a revocation epoch given by the caller is carried through as-is', () => {
            const issuer = makeIssuer();

            expect(issuer.verify(issuer.issue({ userId: 'alice', tenantId: 'acme', epoch: 7 })).epoch).toBe(7);
            expect(issuer.verify(issuer.issue({ userId: 'alice', tenantId: 'acme' })).epoch).toBeUndefined();
          });

          it('re-encoding the payload with a different tenant breaks the signature', () => {
            const issuer = makeIssuer();
            const token = issuer.issue({ userId: 'alice', tenantId: 'acme' });
            const signature = token.split('.')[1];

            const stolen = encodeSegment({
              sub: 'alice',
              tenantId: 'globex',
              sid: 'sid-x',
              iat: now(),
              exp: now() + TTL,
            });

            expectRejected(issuer, stolen + '.' + signature);
          });

          it('a token signed with a different key is not accepted', () => {
            const issuer = makeIssuer();
            const payload = encodeSegment({
              sub: 'mallory',
              tenantId: 'acme',
              sid: 'sid-y',
              iat: now(),
              exp: now() + TTL,
            });

            expectRejected(issuer, payload + '.' + hmac('some-other-key', payload));
          });

          it('a token with its signature stripped is not accepted', () => {
            const issuer = makeIssuer();
            const token = issuer.issue({ userId: 'alice', tenantId: 'acme' });

            expectRejected(issuer, token.split('.')[0] + '.');
          });

          it('an expired token is not accepted', async () => {
            const issuer = makeIssuer();
            const token = issuer.issue({ userId: 'alice', tenantId: 'acme' });

            await sleep(TTL);
            // It expires exactly on time, with no grace period afterwards
            expectRejected(issuer, token);
          });

          it('a token not yet expired is accepted as usual', async () => {
            const issuer = makeIssuer();
            const token = issuer.issue({ userId: 'alice', tenantId: 'acme' });

            await sleep(TTL - 1);
            expect(issuer.verify(token)).toBeTruthy();
          });

          it('malformed input returns null rather than throwing', () => {
            const issuer = makeIssuer();

            expect(issuer.verify('')).toBeNull();
            expect(issuer.verify('not-a-token')).toBeNull();
            expect(issuer.verify('a.b.c')).toBeNull();
            expect(issuer.verify('zzzz.' + hmac(SECRET, 'zzzz'))).toBeNull();
          });

          it('a fresh instance with the same key still verifies it', () => {
            const token = makeIssuer().issue({ userId: 'alice', tenantId: 'acme' });

            // Service restart, request landing on another machine: a stateless token should not care
            expect(makeIssuer().verify(token).sub).toBe('alice');
          });

          it('the payload is readable; the signature guarantees integrity, not secrecy', () => {
            const issuer = makeIssuer();
            const token = issuer.issue({ userId: 'alice', tenantId: 'acme' });

            // This is not a bug: anyone holding the token can read the payload, which is why no
            // secret belongs in it
            expect(decodeSegment(token.split('.')[0])).toEqual(issuer.verify(token));
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.forgedAccepted',
      op: 'eq',
      value: 0,
      zh: '伪造的令牌一张都不放行',
      en: 'Not one forged token is accepted',
      dimension: 'resilience',
    }),
    gate({
      metric: 'counters.kdfRounds',
      op: 'eq',
      value: 0,
      zh: '验令牌不做慢哈希',
      en: 'Verifying a token runs no slow hash',
      dimension: 'latency',
    }),
  ],
  referenceFiles: [
    file(
      'src/session.ts',
      code`
        import type { SessionClaims } from './contract';
        import { constantTimeEqual, decodeSegment, encodeSegment, hmac, randomId } from './support/crypto';
        import { now } from '@lab/env';

        export interface SessionIssuerOptions {
          secret: string;
          ttlMs: number;
        }

        export interface SessionInput {
          userId: string;
          tenantId: string;
          sid?: string;
          epoch?: number;
        }

        export interface SessionIssuer {
          issue(input: SessionInput): string;
          verify(token: string): SessionClaims | null;
        }

        const SEPARATOR = '.';
        const SEGMENTS = 2;

        export function createSessionIssuer(options: SessionIssuerOptions): SessionIssuer {
          function sign(payload: string): string {
            return hmac(options.secret, payload);
          }

          return {
            issue(input: SessionInput): string {
              const issuedAt = now();
              const claims: SessionClaims = {
                sub: input.userId,
                tenantId: input.tenantId,
                sid: input.sid || randomId('sid'),
                iat: issuedAt,
                exp: issuedAt + options.ttlMs,
              };
              // The epoch is optional: nobody passes one before stage 4
              if (typeof input.epoch === 'number') claims.epoch = input.epoch;

              const payload = encodeSegment(claims);
              return payload + SEPARATOR + sign(payload);
            },

            verify(token: string): SessionClaims | null {
              if (typeof token !== 'string') return null;
              const parts = token.split(SEPARATOR);
              if (parts.length !== SEGMENTS) return null;

              // Verification is the gate: before this line, payload is just a string an attacker
              // can write at will
              if (!constantTimeEqual(sign(parts[0]), parts[1])) return null;

              const claims = decodeSegment(parts[0]) as SessionClaims | null;
              if (!claims || typeof claims.exp !== 'number') return null;
              // Expires exactly on time: exp is the first instant that is too late
              if (now() >= claims.exp) return null;

              return claims;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '三个决定：',
      '',
      '**验签放在最前面，而且是唯一的入口。** `verify` 里在验签之前只做了一件事：',
      '数段数。这不是洁癖 —— 一旦解码走在前面，后面每一行都在处理未经验证的数据，',
      '而「后面会验的」这句话在代码演化几轮之后通常就不成立了。',
      '',
      '**签名比较用 constantTimeEqual。** 攻击者可以任意重放并计时，',
      '而 `===` 在第一个不同的字符处就返回。',
      '',
      '**`exp` 用 `>=` 判过期。** 边界只有两种选法，重要的是选定之后一致：',
      '这里定义 `exp` 是「有效期的下一刻」，于是 `ttlMs` 就是真正的存活毫秒数，',
      '不多不少。这类边界不写清楚，跨系统对时时就会出现「差一毫秒」的玄学。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      'Verification comes first and is the only door. Before the signature check, `verify` does exactly one',
      'thing: count segments. That is not fastidiousness — once decoding moves ahead of it, every line after',
      'handles unverified data, and "we check it later" tends to stop being true after a few rounds of edits.',
      '',
      'Signature comparison uses constantTimeEqual. The attacker can replay and time this at will, and `===`',
      'returns at the first differing character.',
      '',
      '`exp` is compared with `>=`. There are only two ways to pick the boundary; what matters is picking one',
      'and staying consistent. Here `exp` is the instant after the last valid one, which makes `ttlMs` the',
      'exact number of milliseconds a token lives. Leave that unstated and cross-system clock comparisons',
      'grow a permanent off-by-one-millisecond mystery.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 3 关 · 刷新令牌轮转与重放检测                                     */
/* ------------------------------------------------------------------ */

const stage3 = {
  id: 'refresh-rotation',
  title: t('第 3 关 · 刷新令牌轮转', 'Stage 3 · Refresh token rotation'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '上一关的访问令牌是无状态的，签出去就收不回来。唯一的缓解办法是让它**短命** ——',
      '几分钟就过期。但用户不接受每几分钟重新输一次密码。',
      '',
      '于是有了第二种令牌：刷新令牌。它长命、只出示给签发方、用来换新的访问令牌。',
      '问题随之而来：一张能用一个月的令牌被偷走了怎么办？',
      '',
      '答案是**轮转**：每次刷新都换一张新的，旧的立刻作废。',
      '这样一来，被偷的那张要么已经失效，要么就会和真正的用户撞车 ——',
      '而那次撞车，正是你唯一能察觉到失窃的信号。',
      '',
      '## 要实现什么',
      '',
      '在 `src/refresh.ts` 实现 `createRefreshService(store, issuer, options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `start({ userId, tenantId })` | 登录成功后开一条新链，返回一对令牌 |',
      '| `rotate(refreshToken)` | 换一对新的；旧的立刻作废。失败返回 `null` |',
      '',
      '一条链上的所有令牌属于同一个**族（family）**，族 id 同时也是访问令牌里的 `sid`。',
      '状态存进 `store` 的 `COLLECTIONS.refresh` 集合 —— 用例会拿同一个 store',
      '重建一个新的服务实例，藏在模块变量里的东西活不过那一步。',
      '',
      '## 怎么算过',
      '',
      '- `rotate` 之后，旧的刷新令牌立刻失效，新的能继续换；',
      '- **重放**：已经用过的令牌再来一次，不但要拒绝，还要把整个族连坐作废',
      '  （门槛 `counters.replayAccepted = 0` 数「重放被放行了几次」，',
      '  `counters.familyRevoked ≥ 1` 确认连坐真的发生了）；',
      '- 未知的、过期的令牌返回 `null`；',
      '- 库里存的是令牌的**摘要**，不是令牌原文；',
      '- 换一个新的服务实例、同一个 store，链还认得。',
      '',
      '## 为什么是连坐，而不是只拒绝那一次',
      '',
      '重放意味着同一张令牌出现了两次，也就意味着它被复制过。',
      '这时候你分不清哪一边是真用户 —— 小偷可能先刷新了，把真用户的那张变成了旧的。',
      '',
      '只拒绝重放的那一次，相当于赌「后来的那个是小偷」。赌错了，小偷手上是有效令牌，',
      '真用户被挡在外面，而且系统还认为一切正常。**两边一起作废**，',
      '让真用户重新登录一次，是这里唯一安全的选择。',
      '',
      '## 最容易写错的地方',
      '',
      '轮转时把旧记录**删掉**。功能上完全说得通：旧的作废了，删掉正好。',
      '',
      '但删掉之后，重放旧令牌看起来就和「不认识这个令牌」一模一样 ——',
      '你把唯一能发现失窃的信号丢进了垃圾桶。旧记录要留着，标记成已用。',
    ].join('\n'),
    [
      "The access token from stage 2 is stateless: once issued, you cannot take it back. The only mitigation",
      'is making it **short-lived** — minutes. But users will not retype a password every few minutes.',
      '',
      'Hence a second kind of token: the refresh token. It is long-lived, presented only to the issuer, and',
      'exchanged for fresh access tokens. Which raises the obvious question: what happens when a token valid',
      'for a month is stolen?',
      '',
      'The answer is **rotation**: every refresh mints a new one and kills the old. The stolen copy is then',
      'either already dead, or it collides with the real user — and that collision is the only signal you will',
      'ever get that a theft occurred.',
      '',
      '## What to build',
      '',
      'Implement `createRefreshService(store, issuer, options)` in `src/refresh.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `start({ userId, tenantId })` | Open a new chain after login and return a token pair |',
      '| `rotate(refreshToken)` | Exchange for a new pair, killing the old token. `null` on failure |',
      '',
      'Every token on one chain belongs to the same **family**, and the family id doubles as the `sid` inside',
      'the access token. State goes into the `COLLECTIONS.refresh` collection of `store` — the specs rebuild a',
      'fresh service over the same store, and anything hidden in a module variable does not survive that.',
      '',
      '## What counts as passing',
      '',
      '- After `rotate`, the old refresh token is dead and the new one keeps working;',
      '- **Replay**: a token used a second time is not merely refused, it takes the whole family down with it',
      '  (the `counters.replayAccepted = 0` gate counts accepted replays and',
      '  `counters.familyRevoked ≥ 1` confirms the cascade actually happened);',
      '- Unknown and expired tokens return `null`;',
      '- The store holds a **digest** of each token, not the token itself;',
      '- A fresh service instance over the same store still recognises the chain.',
      '',
      '## Why the whole family, and not just that one request',
      '',
      'A replay means one token appeared twice, which means it was copied. At that moment you cannot tell',
      'which side is the real user — the thief may have refreshed first, turning the legitimate copy into the',
      'stale one.',
      '',
      'Refusing only the replayed request bets that the later arrival is the thief. Lose that bet and the thief',
      'holds a valid token, the real user is locked out, and the system believes everything is fine. Killing',
      '**both sides** and making the real user log in again is the only safe move here.',
      '',
      '## The easiest thing to get wrong',
      '',
      'Deleting the old record on rotation. It sounds right: the old token is dead, so remove it.',
      '',
      'Except that a replay of a deleted token now looks exactly like "never heard of this token" — you threw',
      'the one signal that reveals a theft into the bin. Keep the old record and mark it used.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  ST["start(userId, tenantId)"] --> NF["新建 family id<br/>它同时是访问令牌的 sid"]',
      '  NF --> MINT["签一对令牌<br/>refresh 只存摘要"]',
      '',
      '  RO["rotate(refreshToken)"] --> LK["按 sha256(token) 查记录"]',
      '  LK --> EX{"查得到吗？"}',
      '  EX -- 查不到 --> NULL["返回 null"]',
      '  EX -- 查得到 --> US{"这张用过了吗？"}',
      '  US -- 用过 --> ALARM["重放告警<br/>整个 family 全部删除"]',
      '  ALARM --> NULL',
      '  US -- 没用过 --> TTL{"还没过期？"}',
      '  TTL -- 过期了 --> NULL',
      '  TTL -- 没过期 --> MARK["把这张标记成 used<br/>记录留着，不删"]',
      '  MARK --> MINT',
      '```',
      '',
      '要点：「用过了」和「查不到」是两条不同的边。合并成一条（也就是轮转时直接删记录）',
      '代码会短几行，代价是重放告警那条路径永远走不到。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  ST["start(userId, tenantId)"] --> NF["new family id<br/>also the sid of the access token"]',
      '  NF --> MINT["mint a pair<br/>only the digest is stored"]',
      '',
      '  RO["rotate(refreshToken)"] --> LK["look up by sha256(token)"]',
      '  LK --> EX{"found?"}',
      '  EX -- no --> NULL["return null"]',
      '  EX -- yes --> US{"already used?"}',
      '  US -- used --> ALARM["replay alarm<br/>delete the whole family"]',
      '  ALARM --> NULL',
      '  US -- unused --> TTL{"still valid?"}',
      '  TTL -- expired --> NULL',
      '  TTL -- valid --> MARK["mark this one used<br/>keep the record"]',
      '  MARK --> MINT',
      '```',
      '',
      'The point: "already used" and "never seen" are two different edges. Merging them — which is what',
      'deleting the record on rotation does — saves a few lines and makes the replay-alarm path unreachable.',
    ].join('\n')
  ),
  checklist: [
    t('每次刷新都换一张新的刷新令牌', 'Every refresh mints a new refresh token'),
    t('用过的记录留着并标记，不要删', 'Used records are marked, not deleted'),
    t('重放触发整个族连坐', 'A replay takes down the whole family'),
    t('库里存摘要，不存令牌原文', 'The store holds digests, not raw tokens'),
    t('状态在 store 里，换个实例也认得', 'State lives in the store and survives a new instance'),
  ],
  pitfalls: [
    t(
      '轮转时删掉旧记录。之后重放旧令牌和「令牌不存在」返回同一个结果，重放检测这一整套逻辑就永远不会触发 —— 代码写了，路径走不到，测试还全绿。',
      'Deleting the old record on rotation. A replay then returns the same result as an unknown token, so the entire replay-detection path becomes unreachable: the code exists, nothing reaches it, and the tests stay green.'
    ),
    t(
      '把刷新令牌原文存进库。它长命、权限大，等价于一把长期钥匙；库被读一次就等于所有在线会话被接管。存摘要就够了 —— 这里用快摘要而不是慢哈希是对的，因为令牌是高熵随机串，不怕爆破，而密码不是。',
      'Storing raw refresh tokens. They are long-lived and powerful — effectively long-term keys — so one read of the table hands over every live session. A digest suffices, and a fast digest is correct here: the token is a high-entropy random string with nothing to brute-force, unlike a password.'
    ),
    t(
      '重放时只拒绝这一次，不动整个族。相当于赌「后来的那个是小偷」，而小偷完全可以先刷新 —— 赌输了系统还以为自己防住了。',
      'Refusing only the replayed request and leaving the family alone. That bets on the later arrival being the thief, and a thief can simply refresh first. Lose the bet and the system believes it defended itself.'
    ),
    t(
      '把 family 存成一个模块级 Map。功能上跑得通，直到进程重启或请求打到另一台机器 —— 所有人的刷新令牌同时变成「不认识」，全站被迫重新登录。会话状态属于 store。',
      'Keeping families in a module-level Map. It works until the process restarts or the request lands on another machine, at which point every refresh token becomes unrecognised and the whole site is forced to log in again. Session state belongs in the store.'
    ),
  ],
  hints: [
    t(
      '记录里存 { family, sub, tenantId, exp, used } 就够了。key 用 sha256(token)，于是「按令牌查记录」和「不存原文」是同一件事。',
      'A record of { family, sub, tenantId, exp, used } is enough. Key it by sha256(token) and "look up by token" and "never store the token" become the same act.'
    ),
    t(
      '连坐的实现方式是遍历 store.keys(COLLECTIONS.refresh)，把 family 相同的全删掉。族通常只有几条记录，不必为它建索引。',
      'The cascade is a walk over store.keys(COLLECTIONS.refresh), removing everything with the same family. A family holds a handful of records; it does not need an index.'
    ),
  ],
  extension: t(
    [
      'OAuth 2.0 的 BCP（最佳当前实践）把这一关写成了硬性建议：',
      '公开客户端（手机 App、单页应用）的刷新令牌**必须**轮转，或者绑定到发送方。',
      'Auth0、Okta 这些厂商的「refresh token rotation + reuse detection」就是这一关。',
      '',
      '连坐的粒度是有讲究的。这里按 family 连坐，也就是「这一次登录」；',
      '按用户连坐（所有设备一起登出）更安全，但一个人的手机丢了会把他的桌面端也踢掉。',
      '大厂的做法通常是「按 family 自动连坐 + 给用户发一条通知」，',
      '把「要不要把所有设备都踢掉」这个决定交还给用户。',
      '',
      '还有一个这一关没做的现实问题：**网络重试**。',
      '用户的刷新请求发出去了，响应在路上丢了，客户端重试 —— 这在服务端看起来',
      '和重放一模一样。真实实现通常给旧令牌留一个几秒到几十秒的宽限窗口，',
      '在窗口内重复出示返回**同一对**新令牌，超出窗口才当作攻击。',
    ].join('\n'),
    [
      'The OAuth 2.0 best-current-practice document turns this stage into a hard recommendation: refresh',
      'tokens for public clients (mobile apps, SPAs) **must** either rotate or be sender-constrained. What',
      'Auth0 and Okta sell as "refresh token rotation with reuse detection" is this stage.',
      '',
      'The granularity of the cascade is a real decision. Here it is per family, meaning per login. Cascading',
      'per user — logging out every device — is safer, but losing a phone then kicks the desktop out too. The',
      'common production answer is "cascade the family automatically and notify the user", handing the',
      '"should everything be logged out" decision back to the person who can actually answer it.',
      '',
      'One real problem this stage skips: **network retries.** The refresh request goes out, the response is',
      'lost, the client retries — and to the server that is indistinguishable from a replay. Production',
      'implementations usually give the old token a grace window of seconds, returning the **same** new pair',
      'for repeats inside it and only treating later presentations as an attack.',
    ].join('\n')
  ),
  focus: ['correctness', 'resilience', 'encapsulation'],
  lab: {},
  starterFiles: [
    file(
      'src/refresh.ts',
      code`
        import { COLLECTIONS } from './contract';
        import type { SessionIssuer } from './session';
        import type { Store } from './support/store';
        import { randomId, sha256 } from './support/crypto';
        import { now } from '@lab/env';

        export interface RefreshOptions {
          /** Refresh token lifetime in milliseconds */
          ttlMs: number;
        }

        export interface TokenPair {
          accessToken: string;
          refreshToken: string;
        }

        export interface RefreshService {
          start(input: { userId: string; tenantId: string }): TokenPair;
          /** Exchange for a fresh pair; the old one is void immediately. Any failure returns null. */
          rotate(refreshToken: string): TokenPair | null;
        }

        export function createRefreshService(
          store: Store,
          issuer: SessionIssuer,
          options: RefreshOptions
        ): RefreshService {
          // TODO: implement this
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-3.spec.ts',
      code`
        import { createRefreshService } from '../src/refresh';
        import { createSessionIssuer } from '../src/session';
        import { COLLECTIONS } from '../src/contract';
        import { createStore } from '../src/support/store';
        import { sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const SECRET = 'session-signing-key';
        const REFRESH_TTL = 600000;

        function makeService(store: any) {
          const issuer = createSessionIssuer({ secret: SECRET, ttlMs: 60000 });
          return createRefreshService(store, issuer, { ttlMs: REFRESH_TTL });
        }

        function login(service: any) {
          return service.start({ userId: 'alice', tenantId: 'acme' });
        }

        describe('Stage 3 · Refresh token rotation', () => {
          it('login returns a pair and the access token verifies', () => {
            const service = makeService(createStore());
            const pair = login(service);

            const issuer = createSessionIssuer({ secret: SECRET, ttlMs: 60000 });
            expect(issuer.verify(pair.accessToken).sub).toBe('alice');
            expect(pair.refreshToken).toBeTruthy();
          });

          it('refreshing returns a brand-new pair', () => {
            const service = makeService(createStore());
            const first = login(service);

            const second = service.rotate(first.refreshToken);
            expect(second).toBeTruthy();
            expect(second.refreshToken).not.toBe(first.refreshToken);

            const issuer = createSessionIssuer({ secret: SECRET, ttlMs: 60000 });
            expect(issuer.verify(second.accessToken).sub).toBe('alice');
          });

          it('access tokens on one chain share a session id', () => {
            const service = makeService(createStore());
            const issuer = createSessionIssuer({ secret: SECRET, ttlMs: 60000 });
            const first = login(service);
            const second = service.rotate(first.refreshToken);

            expect(issuer.verify(second.accessToken).sid).toBe(issuer.verify(first.accessToken).sid);
          });

          it('the old refresh token is void immediately after rotation', () => {
            const service = makeService(createStore());
            const first = login(service);
            service.rotate(first.refreshToken);

            const replayed = service.rotate(first.refreshToken);
            if (replayed) count('replayAccepted');
            expect(replayed).toBeNull();
          });

          it('replaying an old token voids the entire family [gate:family]', () => {
            const service = makeService(createStore());
            const first = login(service);
            const second = service.rotate(first.refreshToken);

            // The thief turns up with the copied old token
            const stolen = service.rotate(first.refreshToken);
            if (stolen) count('replayAccepted');
            expect(stolen).toBeNull();

            // The newest one, in the real user's hands, has to be voided too: at this point the two
            // are indistinguishable
            const legit = service.rotate(second.refreshToken);
            if (!legit) count('familyRevoked');
            expect(legit).toBeNull();
          });

          it('the family void affects only this chain and leaves other sessions alone', () => {
            const store = createStore();
            const service = makeService(store);
            const alice = login(service);
            const bob = service.start({ userId: 'bob', tenantId: 'acme' });

            service.rotate(alice.refreshToken);
            service.rotate(alice.refreshToken);

            expect(service.rotate(bob.refreshToken)).toBeTruthy();
          });

          it('an unrecognised refresh token returns null', () => {
            const service = makeService(createStore());
            login(service);

            const forged = service.rotate('rt_not-a-real-token');
            if (forged) count('replayAccepted');
            expect(forged).toBeNull();
          });

          it('an expired refresh token returns null', async () => {
            const service = makeService(createStore());
            const pair = login(service);

            await sleep(REFRESH_TTL);
            expect(service.rotate(pair.refreshToken)).toBeNull();
          });

          it('the store holds a digest, not the token itself', () => {
            const store = createStore();
            const service = makeService(store);
            const pair = login(service);

            const dump = JSON.stringify(store.list(COLLECTIONS.refresh)) + store.keys(COLLECTIONS.refresh).join(',');
            expect(dump).not.toContain(pair.refreshToken);
          });

          it('the state lives in the store, so a fresh service instance recognises the chain', () => {
            const store = createStore();
            const pair = login(makeService(store));

            // Service restart, request landing on another machine
            const rebuilt = makeService(store);
            expect(rebuilt.rotate(pair.refreshToken)).toBeTruthy();
          });

          it('replaying again after the family void is still rejected', () => {
            const service = makeService(createStore());
            const first = login(service);
            service.rotate(first.refreshToken);
            service.rotate(first.refreshToken);

            const again = service.rotate(first.refreshToken);
            if (again) count('replayAccepted');
            expect(again).toBeNull();
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.replayAccepted',
      op: 'eq',
      value: 0,
      zh: '重放的刷新令牌一次都不放行',
      en: 'Not one replayed refresh token is accepted',
      dimension: 'resilience',
    }),
    gate({
      metric: 'counters.familyRevoked',
      op: 'gte',
      value: 1,
      zh: '重放确实触发了整族连坐',
      en: 'A replay really does cascade to the whole family',
      dimension: 'resilience',
    }),
  ],
  referenceFiles: [
    file(
      'src/refresh.ts',
      code`
        import { COLLECTIONS } from './contract';
        import type { SessionIssuer } from './session';
        import type { Store } from './support/store';
        import { randomId, sha256 } from './support/crypto';
        import { now } from '@lab/env';

        export interface RefreshOptions {
          ttlMs: number;
        }

        export interface TokenPair {
          accessToken: string;
          refreshToken: string;
        }

        export interface RefreshService {
          start(input: { userId: string; tenantId: string }): TokenPair;
          rotate(refreshToken: string): TokenPair | null;
        }

        /** One refresh token record in the store. Note it does not hold the token itself. */
        interface RefreshRecord {
          family: string;
          sub: string;
          tenantId: string;
          exp: number;
          /** Marked once used, but not deleted — deleting it makes replay undetectable */
          used: boolean;
        }

        export function createRefreshService(
          store: Store,
          issuer: SessionIssuer,
          options: RefreshOptions
        ): RefreshService {
          function read(token: string): RefreshRecord | null {
            const raw = store.get(COLLECTIONS.refresh, sha256(token));
            return raw ? (raw as unknown as RefreshRecord) : null;
          }

          function mint(family: string, sub: string, tenantId: string): TokenPair {
            const refreshToken = randomId('rt');
            const record: RefreshRecord = { family, sub, tenantId, exp: now() + options.ttlMs, used: false };
            store.put(COLLECTIONS.refresh, sha256(refreshToken), record as unknown as Record<string, unknown>);
            return { accessToken: issuer.issue({ userId: sub, tenantId, sid: family }), refreshToken };
          }

          /** Replay alarm: every token on this chain is voided together, including the one not yet used */
          function revokeFamily(family: string): void {
            for (const key of store.keys(COLLECTIONS.refresh)) {
              const record = store.get(COLLECTIONS.refresh, key) as unknown as RefreshRecord | undefined;
              if (record && record.family === family) store.remove(COLLECTIONS.refresh, key);
            }
          }

          return {
            start(input: { userId: string; tenantId: string }): TokenPair {
              // The family id doubles as the session id: one login = one chain
              return mint(randomId('sid'), input.userId, input.tenantId);
            },

            rotate(refreshToken: string): TokenPair | null {
              const record = read(refreshToken);
              if (!record) return null;

              if (record.used) {
                // The same one showed up twice — it has been copied, and neither side can be trusted now
                revokeFamily(record.family);
                return null;
              }
              if (now() >= record.exp) {
                store.remove(COLLECTIONS.refresh, sha256(refreshToken));
                return null;
              }

              const used: RefreshRecord = { ...record, used: true };
              store.put(COLLECTIONS.refresh, sha256(refreshToken), used as unknown as Record<string, unknown>);
              return mint(record.family, record.sub, record.tenantId);
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '三个决定：',
      '',
      '**用过的记录标记，不删。** 这是整关的支点。删掉之后代码更短、状态更少，',
      '但「重放」就退化成了「不认识」，`revokeFamily` 那段永远不会执行。',
      '安全逻辑最怕的不是写错，是写了但走不到。',
      '',
      '**key 是 sha256(token)。** 一举两得：查记录天然按令牌查，而库里从头到尾',
      '没有出现过令牌原文。这里用快摘要是对的 —— 令牌是高熵随机串，',
      '爆破它和爆破密钥一样没指望；密码那关必须用慢哈希，是因为密码熵低。',
      '',
      '**family 就是 sid。** 少一个 id 就少一处「两边对不上」的机会，',
      '而且第 4 关要按会话撤销时，撤的正好就是这条链。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      'Used records are marked, not deleted. This is the pivot of the whole stage. Deleting is shorter and',
      'leaves less state, but it degrades "replay" into "unknown" and `revokeFamily` never runs. The worst',
      'failure mode for security code is not being wrong — it is being unreachable.',
      '',
      'The key is sha256(token). That buys two things at once: lookups are naturally by token, and the raw',
      'token never appears in the store. A fast digest is the right choice here — the token is a high-entropy',
      'random string with nothing to brute-force. Passwords need a slow hash because passwords have little',
      'entropy.',
      '',
      'The family id is the sid. One id fewer is one fewer chance for two identifiers to disagree, and when',
      'stage 4 revokes by session, the thing it revokes is exactly this chain.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 4 关 · 撤销与登出                                                 */
/* ------------------------------------------------------------------ */

const stage4 = {
  id: 'revocation',
  title: t('第 4 关 · 撤销与登出', 'Stage 4 · Revocation and logout'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '第 2 关的令牌是无状态的：验它不需要查任何东西。这正是它快的原因，',
      '也正是它收不回来的原因 —— 服务端没有任何地方可以写下「这张作废了」。',
      '',
      '但「立刻踢人」是刚需：用户点了登出、管理员发现账号被盗、密码刚改完。',
      '这一关补上这个洞，同时不能把上一关的优点还回去。',
      '',
      '## 要实现什么',
      '',
      '在 `src/revocation.ts` 实现 `createRevocationGuard(store)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `stamp(userId)` | 签发令牌前取当前**纪元**，调用方把它写进 `claims.epoch` |',
      '| `revokeSession(claims)` | 登出一个会话。参数是 claims，因为要知道它什么时候自然过期 |',
      '| `revokeUser(userId)` | 踢掉这个用户的**全部**会话 |',
      '| `isActive(claims)` | 验签之后再问一句：这张还作数吗 |',
      '',
      '状态存进 `store` 的 `COLLECTIONS.revocations` 集合。',
      '',
      '## 怎么算过',
      '',
      '- 登出之后那张令牌立刻失效，同用户的其他会话不受影响',
      '  （门槛 `counters.revokedAccepted = 0` 数「撤销之后还被放行了几次」）；',
      '- `revokeUser` 一次踢掉该用户的所有旧令牌，之后**新签发**的照常可用；',
      '- 没带 `epoch` 的老令牌按纪元 0 处理，同样会被踢掉；',
      '- 撤销状态在 store 里，换个服务实例照样生效；',
      '- **留下的记录条数受控**：门槛 `counters.revocationEntries ≤ 4` 会在',
      '  「6 次登录 + 1 次全量踢人 + 1 次单点登出」之后数一遍 store 里的条目。',
      '',
      '## 那个 ≤ 4 是什么意思',
      '',
      '它是在逼你不要按「会话」记账。',
      '',
      '如果撤销是一张黑名单，那么为了以后能踢掉某个用户的所有会话，',
      '你必须**在每次登录时就把这个会话记下来** —— 条目数于是等于登录次数，',
      '一个活跃系统里这个数会一直涨，而其中绝大多数记录到死都用不上。',
      '',
      '换成**纪元**：每个用户存一个单调递增的整数，令牌里带上签发时的值。',
      '踢人就是把那个整数加一，一个数字让所有旧令牌同时失效，而登录不写任何东西。',
      '单点登出仍然需要一条按会话的记录，但它可以在令牌自然过期之后被清掉 ——',
      '毕竟那之后它再也拦不到任何东西了。',
      '',
      '## 最容易写错的地方',
      '',
      '把登出记录永久留着。它看起来无害，直到你意识到这张表只会增长：',
      '每个登出过的会话都在里面躺着，而它们对应的令牌早就过期了。',
      '一年之后这张表比用户表还大，每次鉴权都要查它。',
    ].join('\n'),
    [
      'The stage 2 token is stateless: checking it requires no lookup. That is exactly why it is fast, and',
      'exactly why it cannot be taken back — there is nowhere on the server to write "this one is dead".',
      '',
      'But immediate revocation is not optional: the user pressed log out, an admin spotted a stolen account,',
      'a password was just changed. This stage fills that hole without giving back what stage 2 bought.',
      '',
      '## What to build',
      '',
      'Implement `createRevocationGuard(store)` in `src/revocation.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `stamp(userId)` | Read the current **epoch** before issuing; the caller writes it into `claims.epoch` |',
      '| `revokeSession(claims)` | Log one session out. It takes claims because it needs to know when they expire |',
      '| `revokeUser(userId)` | Kick **every** session of that user |',
      '| `isActive(claims)` | The question asked after the signature checks out: does this still count |',
      '',
      'State goes into the `COLLECTIONS.revocations` collection of `store`.',
      '',
      '## What counts as passing',
      '',
      '- A logged-out token dies immediately while the same user\'s other sessions keep working',
      '  (the `counters.revokedAccepted = 0` gate counts how many revoked tokens were still admitted);',
      '- `revokeUser` kills every existing token of that user, and tokens issued **after** it work normally;',
      '- A token with no `epoch` counts as epoch 0 and is killed too;',
      '- Revocation lives in the store and survives a fresh service instance;',
      '- **The number of records stays bounded**: the `counters.revocationEntries ≤ 4` gate counts the store',
      '  after six logins, one user-wide kick and one single-session logout.',
      '',
      '## What that ≤ 4 is really saying',
      '',
      'It is pushing you off per-session bookkeeping.',
      '',
      'If revocation is a deny list, then to be able to kick all of a user\'s sessions later you must **record',
      'every session at login time** — so the record count equals the login count, grows forever on an active',
      'system, and the overwhelming majority of those rows are never used for anything.',
      '',
      'With an **epoch** instead: each user has a monotonic integer, and a token carries the value it was',
      'issued under. Kicking is incrementing that integer — one number invalidates every old token, and login',
      'writes nothing at all. A single-session logout still needs a per-session row, but that row can be',
      'dropped once the token would have expired anyway, since it can no longer stop anything.',
      '',
      '## The easiest thing to get wrong',
      '',
      'Keeping logout records forever. It looks harmless until you notice the table only grows: every session',
      'ever logged out still sits there, long after its token expired. A year later it is bigger than the user',
      'table, and every authenticated request reads it.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**签发** —— 这条路径上没有任何写操作',
      '',
      '```mermaid',
      'flowchart TD',
      '  LOGIN["签发访问令牌"] --> STAMP["stamp(userId) 取当前纪元"]',
      '  STAMP --> TOKEN["epoch 写进 claims<br/>登录本身不写任何记录"]',
      '```',
      '',
      '**撤销** —— 两种粒度，都先清一遍过期记录',
      '',
      '```mermaid',
      'flowchart TD',
      '  LOGOUT["revokeSession(claims)"] --> PRUNE["先清掉已经过期的登出记录"]',
      '  PRUNE --> ONE["写一条按会话的记录<br/>连同它的 exp"]',
      '  KICK["revokeUser(userId)"] --> PRUNE2["同样先清一遍"]',
      '  PRUNE2 --> BUMP["把这个用户的纪元加一<br/>一个数字撤销一整批"]',
      '```',
      '',
      '**校验** —— 验签通过之后再问的那一句',
      '',
      '```mermaid',
      'flowchart TD',
      '  CHECK["isActive(claims)"] --> D1{"sid 在登出表里？"}',
      '  D1 -- 在 --> DEAD["返回 false"]',
      '  D1 -- 不在 --> D2{"claims.epoch 追得上当前纪元？"}',
      '  D2 -- 追不上 --> DEAD',
      '  D2 -- 追得上 --> ALIVE["返回 true"]',
      '```',
      '',
      '要点：登录那条路径上没有任何写操作。黑名单方案会在 `TOKEN` 那一步多出',
      '一条「把这个会话记下来」的边 —— 而正是那条边让状态随登录次数增长。',
    ].join('\n'),
    [
      '**Issuing** — no write anywhere on this path',
      '',
      '```mermaid',
      'flowchart TD',
      '  LOGIN["issue an access token"] --> STAMP["stamp(userId) reads the epoch"]',
      '  STAMP --> TOKEN["epoch goes into the claims<br/>login itself writes nothing"]',
      '```',
      '',
      '**Revoking** — two granularities, both pruning first',
      '',
      '```mermaid',
      'flowchart TD',
      '  LOGOUT["revokeSession(claims)"] --> PRUNE["first drop expired logout rows"]',
      '  PRUNE --> ONE["write one per-session row<br/>together with its exp"]',
      '  KICK["revokeUser(userId)"] --> PRUNE2["prune first as well"]',
      '  PRUNE2 --> BUMP["increment that user\'s epoch<br/>one number revokes a whole batch"]',
      '```',
      '',
      '**Checking** — the question asked after the signature verifies',
      '',
      '```mermaid',
      'flowchart TD',
      '  CHECK["isActive(claims)"] --> D1{"is the sid on the logout list?"}',
      '  D1 -- yes --> DEAD["return false"]',
      '  D1 -- no --> D2{"does claims.epoch match the current one?"}',
      '  D2 -- no --> DEAD',
      '  D2 -- yes --> ALIVE["return true"]',
      '```',
      '',
      'The point: the login path contains no write. A deny-list design grows an extra edge out of `TOKEN` —',
      '"record this session" — and that edge is what makes the state grow with the login count.',
    ].join('\n')
  ),
  checklist: [
    t('登录路径上不写任何撤销记录', 'The login path writes no revocation record'),
    t('revokeUser 用纪元加一实现', 'revokeUser is an epoch increment'),
    t('单点登出记录带上 exp 并会被清理', 'A logout row carries its exp and gets pruned'),
    t('没带 epoch 的令牌按 0 处理', 'A token with no epoch counts as epoch 0'),
    t('撤销状态存在 store 里', 'Revocation state lives in the store'),
  ],
  pitfalls: [
    t(
      '把所有会话记进一张黑名单，靠遍历它来实现「踢掉某个用户」。功能是对的，代价是每次登录都要写一条记录、每次鉴权都要扫一遍表 —— 无状态令牌最大的好处就此还回去了。',
      'Recording every session in a deny list and scanning it to kick a user. Functionally right, and it costs a write per login plus a table scan per authenticated request — which hands back the entire benefit of a stateless token.'
    ),
    t(
      '用 `claims.epoch > current` 或者 `!==` 判断。纪元只会涨，令牌里带的值应当**等于或大于**当前值才有效；写成不等于的话，同一纪元签发的令牌在下一次踢人之后仍然有一半判断是对的，bug 只在特定顺序下出现。',
      'Comparing with `!==` or `>`. The epoch only ever increases, so a token is valid when its value is at least the current one. Anything else leaves the check accidentally right in some orders and wrong in others — the worst kind of bug to reproduce.'
    ),
    t(
      '把 `claims.epoch` 缺失当成「有效」。老令牌（第 4 关之前签的）没有这个字段，如果缺失被当成通过，那么攻击者只要删掉这个字段就能永久豁免撤销 —— 缺失必须按最小值 0 处理。',
      'Treating a missing `claims.epoch` as valid. Tokens issued before this stage have no such field, and if absence means "fine", an attacker simply removes the field to become permanently unrevocable. Absence has to mean the minimum, zero.'
    ),
    t(
      '在 `isActive` 里做清理。读路径上做写操作，在真实系统里意味着每个请求都可能触发一次删除事务；更麻烦的是并发下两个请求会同时清理同一批记录。清理属于写路径，或者一个后台任务。',
      'Pruning inside `isActive`. That puts a write on the read path — in a real system, a potential delete transaction on every request, and concurrently two requests racing to prune the same rows. Pruning belongs on the write path or in a background job.'
    ),
  ],
  hints: [
    t(
      '两类记录用不同的 key 前缀区分：`user:` 存纪元，`sid:` 存登出。同一个集合，靠前缀就能分开遍历。',
      'Separate the two record kinds by key prefix: `user:` holds epochs, `sid:` holds logouts. One collection, and the prefix is enough to walk them apart.'
    ),
    t(
      '清理的条件就是「这条记录对应的令牌已经过期了」—— 所以 revokeSession 要把 claims.exp 一起存下来。',
      'The prune condition is "the token this row refers to has expired", which is why revokeSession stores claims.exp alongside it.'
    ),
  ],
  extension: t(
    [
      '这一关的纪元在真实世界里有很多名字：Rails 的 `session_version`、',
      'Django 的 `AUTH_USER_MODEL` 密码哈希参与会话签名（改密码即全站登出）、',
      'Firebase 的 `tokensValidAfterTime`、AWS IAM 的 `PermissionsBoundary` 版本。',
      '本质都是同一招：**用一个能放进令牌的小值，代替一张会无限增长的表**。',
      '',
      '代价是粒度。纪元只能整批撤销，不能撤销「某一个会话」——',
      '所以真实系统通常两者并存，就像这一关：纪元管全量，短期黑名单管单点。',
      '',
      '还有一个这一关刻意简化掉的问题：**分布式缓存**。',
      '真实系统的纪元会被缓存在各个网关节点上，于是「撤销多久之后真正生效」',
      '取决于缓存的 TTL。这个窗口是可以量的，通常几秒 —— 第 10 关会再遇到它。',
    ].join('\n'),
    [
      'The epoch has many names in production: Rails\' `session_version`, Django folding the password hash into',
      'the session signature (so changing a password logs out everywhere), Firebase\'s `tokensValidAfterTime`,',
      'the version on an AWS IAM permissions boundary. All the same trick: **replace an unbounded table with a',
      'small value that fits inside the token.**',
      '',
      'The price is granularity. An epoch revokes in batches and cannot single out one session, which is why',
      'production systems run both, exactly as this stage does: epochs for the sweep, a short deny list for the',
      'single case.',
      '',
      'One thing deliberately simplified away here: **distributed caching.** Real gateways cache the epoch on',
      'each node, so "how long until a revocation actually takes effect" is the cache TTL — a measurable window,',
      'usually seconds. Stage 10 meets this problem again.',
    ].join('\n')
  ),
  focus: ['correctness', 'latency', 'encapsulation'],
  lab: {},
  starterFiles: [
    file(
      'src/revocation.ts',
      code`
        import { COLLECTIONS } from './contract';
        import type { SessionClaims } from './contract';
        import type { Store } from './support/store';
        import { now } from '@lab/env';

        export interface RevocationGuard {
          /** Read the current epoch before issuing; the caller writes it into claims.epoch */
          stamp(userId: string): number;
          /** Log one session out */
          revokeSession(claims: SessionClaims): void;
          /** Kick every session belonging to this user */
          revokeUser(userId: string): void;
          /** After verifying the signature, ask one more question: does this one still count? */
          isActive(claims: SessionClaims): boolean;
        }

        export function createRevocationGuard(store: Store): RevocationGuard {
          // TODO: implement this
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-4.spec.ts',
      code`
        import { createRevocationGuard } from '../src/revocation';
        import { createSessionIssuer } from '../src/session';
        import { COLLECTIONS } from '../src/contract';
        import { createStore } from '../src/support/store';
        import { sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const SECRET = 'session-signing-key';
        const TTL = 60000;

        function makeIssuer() {
          return createSessionIssuer({ secret: SECRET, ttlMs: TTL });
        }

        /** Run a full issue: read the epoch, sign, verify back to claims */
        function loginAs(issuer: any, guard: any, userId: string) {
          const token = issuer.issue({ userId, tenantId: 'acme', epoch: guard.stamp(userId) });
          return issuer.verify(token);
        }

        /** Getting through after revocation is exactly what the gate counts */
        function expectRevoked(guard: any, claims: any): void {
          if (guard.isActive(claims)) count('revokedAccepted');
          expect(guard.isActive(claims)).toBe(false);
        }

        describe('Stage 4 · Revocation and logout', () => {
          it('a token that was never revoked stays valid', () => {
            const guard = createRevocationGuard(createStore());
            const claims = loginAs(makeIssuer(), guard, 'alice');

            expect(guard.isActive(claims)).toBe(true);
          });

          it('the token is invalid immediately after logout', () => {
            const guard = createRevocationGuard(createStore());
            const claims = loginAs(makeIssuer(), guard, 'alice');

            guard.revokeSession(claims);
            expectRevoked(guard, claims);
          });

          it("a single logout does not affect the user's other sessions", () => {
            const issuer = makeIssuer();
            const guard = createRevocationGuard(createStore());
            const laptop = loginAs(issuer, guard, 'alice');
            const phone = loginAs(issuer, guard, 'alice');

            guard.revokeSession(laptop);

            expectRevoked(guard, laptop);
            expect(guard.isActive(phone)).toBe(true);
          });

          it('kicking a user invalidates all of their old tokens', () => {
            const issuer = makeIssuer();
            const guard = createRevocationGuard(createStore());
            const sessions = [loginAs(issuer, guard, 'alice'), loginAs(issuer, guard, 'alice')];

            guard.revokeUser('alice');

            for (const claims of sessions) expectRevoked(guard, claims);
          });

          it('tokens issued after the kick work as usual', () => {
            const issuer = makeIssuer();
            const guard = createRevocationGuard(createStore());
            const before = loginAs(issuer, guard, 'alice');

            guard.revokeUser('alice');
            const after = loginAs(issuer, guard, 'alice');

            expectRevoked(guard, before);
            expect(guard.isActive(after)).toBe(true);
          });

          it('kicking twice invalidates what was issued in between', () => {
            const issuer = makeIssuer();
            const guard = createRevocationGuard(createStore());

            guard.revokeUser('alice');
            const middle = loginAs(issuer, guard, 'alice');
            guard.revokeUser('alice');

            expectRevoked(guard, middle);
          });

          it('an old token with no epoch is treated as 0 and gets kicked too', () => {
            const issuer = makeIssuer();
            const guard = createRevocationGuard(createStore());
            // Tokens signed before stage 4 have no epoch field
            const legacy = issuer.verify(issuer.issue({ userId: 'alice', tenantId: 'acme' }));

            expect(guard.isActive(legacy)).toBe(true);
            guard.revokeUser('alice');
            expectRevoked(guard, legacy);
          });

          it('kicking one user does not affect anyone else', () => {
            const issuer = makeIssuer();
            const guard = createRevocationGuard(createStore());
            const alice = loginAs(issuer, guard, 'alice');
            const bob = loginAs(issuer, guard, 'bob');

            guard.revokeUser('alice');

            expectRevoked(guard, alice);
            expect(guard.isActive(bob)).toBe(true);
          });

          it('revocation state lives in the store and works from a fresh instance', () => {
            const store = createStore();
            const claims = loginAs(makeIssuer(), createRevocationGuard(store), 'alice');

            createRevocationGuard(store).revokeUser('alice');

            expectRevoked(createRevocationGuard(store), claims);
          });

          it('six logins and two revocations leave barely any records behind [gate:entries]', () => {
            const store = createStore();
            const issuer = makeIssuer();
            const g = createRevocationGuard(store);

            const alice = [0, 1, 2].map(() => loginAs(issuer, g, 'alice'));
            const bob = [0, 1, 2].map(() => loginAs(issuer, g, 'bob'));

            // One kick covering alice's three sessions, plus logging one of bob's devices out
            g.revokeUser('alice');
            g.revokeSession(bob[0]);

            for (const claims of alice) expectRevoked(g, claims);
            expectRevoked(g, bob[0]);
            expect(g.isActive(bob[1])).toBe(true);

            // This count is what the gate measures: login count must not turn into record count
            count('revocationEntries', store.size(COLLECTIONS.revocations));
          });

          it('the logout record is cleaned up once the token expires naturally', async () => {
            const store = createStore();
            const issuer = makeIssuer();
            const g = createRevocationGuard(store);

            g.revokeSession(loginAs(issuer, g, 'alice'));
            expect(store.size(COLLECTIONS.revocations)).toBe(1);

            await sleep(TTL);
            // That token has expired on its own, so this record can never stop anything again
            g.revokeSession(loginAs(issuer, g, 'bob'));
            expect(store.size(COLLECTIONS.revocations)).toBe(1);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.revokedAccepted',
      op: 'eq',
      value: 0,
      zh: '撤销之后一次都不再放行',
      en: 'Nothing revoked is ever admitted again',
      dimension: 'resilience',
    }),
    gate({
      metric: 'counters.revocationEntries',
      op: 'lte',
      value: 4,
      zh: '六次登录之后撤销记录不超过 4 条',
      en: 'At most four revocation records after six logins',
      dimension: 'latency',
      scope: 'gate:entries',
    }),
  ],
  referenceFiles: [
    file(
      'src/revocation.ts',
      code`
        import { COLLECTIONS } from './contract';
        import type { SessionClaims } from './contract';
        import type { Store } from './support/store';
        import { now } from '@lab/env';

        export interface RevocationGuard {
          stamp(userId: string): number;
          revokeSession(claims: SessionClaims): void;
          revokeUser(userId: string): void;
          isActive(claims: SessionClaims): boolean;
        }

        /** Both kinds of record share one collection, separated by key prefix */
        const USER_KEY = 'user:';
        const SESSION_KEY = 'sid:';

        export function createRevocationGuard(store: Store): RevocationGuard {
          function epochOf(userId: string): number {
            const record = store.get(COLLECTIONS.revocations, USER_KEY + userId);
            return record ? Number(record.epoch) : 0;
          }

          /**
           * Cleanup: once the token itself has expired, its logout record can never stop anything again.
           * Done on the write path only — the read path must stay free of writes.
           */
          function prune(): void {
            for (const key of store.keys(COLLECTIONS.revocations)) {
              if (key.indexOf(SESSION_KEY) !== 0) continue;
              const record = store.get(COLLECTIONS.revocations, key);
              if (record && Number(record.exp) <= now()) store.remove(COLLECTIONS.revocations, key);
            }
          }

          return {
            stamp(userId: string): number {
              // Note this reads without writing: logging in should leave no trace on the server
              return epochOf(userId);
            },

            revokeSession(claims: SessionClaims): void {
              prune();
              // Store exp so we know later when this record can be thrown away
              store.put(COLLECTIONS.revocations, SESSION_KEY + claims.sid, { exp: claims.exp });
            },

            revokeUser(userId: string): void {
              prune();
              // One integer increment voids every token already issued to this user
              store.put(COLLECTIONS.revocations, USER_KEY + userId, { epoch: epochOf(userId) + 1 });
            },

            isActive(claims: SessionClaims): boolean {
              if (!claims) return false;
              if (store.get(COLLECTIONS.revocations, SESSION_KEY + claims.sid)) return false;
              // A missing field is treated as 0: deleting it must not amount to immunity from revocation
              return (claims.epoch || 0) >= epochOf(claims.sub);
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '三个决定：',
      '',
      '**`stamp` 只读不写。** 这是整关的关键，也是最容易被写反的一行。',
      '一旦登录时开始写记录，撤销表的大小就跟着日活走；而纪元方案里，',
      '一个从没被踢过的用户在这张表里连一行都没有。',
      '',
      '**登出记录带着 `exp`。** 没有它，你就无法判断一条记录还有没有用，',
      '于是只能永远留着。带上之后，清理条件是一句自明的话：',
      '「这张令牌自己都过期了」。',
      '',
      '**清理放在写路径上。** `isActive` 每个请求都会被调用，在里面删记录意味着',
      '读路径变成了写路径 —— 缓存、只读副本、并发全都会跟着变复杂。',
      '撤销本身是低频操作，顺手清理一次完全够用。',
      '',
      '一个值得注意的分层：`isActive` 并不检查 `exp`。过期是第 2 关验签那一层的事，',
      '这里只回答「有没有被提前收回」。两层都做等于把同一个判断写两遍，',
      '而两遍迟早会不一致。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      '`stamp` reads and never writes. That is the pivot of the stage and the easiest line to get backwards.',
      'Start writing at login and the revocation table tracks daily active users; with epochs, a user who was',
      'never kicked has no row at all.',
      '',
      'A logout row carries its `exp`. Without it there is no way to tell whether a row still matters, so the',
      'only safe choice is keeping it forever. With it, the prune condition states itself: the token it refers',
      'to has already expired.',
      '',
      'Pruning sits on the write path. `isActive` runs on every request, and deleting rows inside it turns a',
      'read path into a write path — caches, read replicas and concurrency all get harder. Revocation is rare,',
      'so pruning as it happens is plenty.',
      '',
      'One layering detail worth noticing: `isActive` does not check `exp`. Expiry belongs to the signature',
      'layer of stage 2; this layer answers only "was it taken back early". Doing both means writing the same',
      'judgement twice, and two copies drift.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 5 关 · 多因素认证                                                 */
/* ------------------------------------------------------------------ */

const stage5 = {
  id: 'mfa-totp',
  title: t('第 5 关 · 一次性密码与恢复码', 'Stage 5 · One-time codes and recovery codes'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '第 1 关认出的是「你知道什么」。密码这个因素有个无法修补的弱点：',
      '它可以被复制，而且复制之后原主一无所知。',
      '',
      '所以要加一个「你拥有什么」：手机上那个每 30 秒跳一次的六位数。',
      '它的原理简单到有点朴素 —— 服务端和手机共享一个密钥，各自把当前时间',
      '除以 30 秒取整，再和密钥一起哈希。两边算出来的是同一个数。',
      '',
      '## 要实现什么',
      '',
      '在 `src/mfa.ts` 实现 `createMfa(options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `code(atMs)` | 算出某个时刻的六位数（手机那一侧做的事，这里用来出题） |',
      '| `verifyCode(candidate)` | 校验一次性验证码 |',
      '| `useRecoveryCode(candidate)` | 用掉一个恢复码 |',
      '| `remainingRecoveryCodes()` | 还剩几个 |',
      '',
      '`options` 给了 `secret`、`stepMs`（一个窗口多长）、`drift`（允许前后各几个窗口）、',
      '以及 `recoveryHashes` —— 注意是**摘要**，恢复码原文只在生成那一刻给过用户一次。',
      '',
      '## 怎么算过',
      '',
      '- 当前窗口的码通过；',
      '- **同一个码第二次必须不通过**（门槛 `counters.totpReplayAccepted = 0`）——',
      '  它叫「一次性密码」，一次的意思就是一次；',
      '- 前一个和后一个窗口的码也要通过（门槛 `counters.driftRejected = 0`',
      '  数的是「本该接受却被拒了几次」）；',
      '- 再往外一个窗口就不通过了；',
      '- 恢复码只能用一次，用完计数减一；',
      '- 错误的码、别的密钥算出来的码，一律不通过。',
      '',
      '## 为什么要容忍漂移',
      '',
      '手机的时钟和服务器的时钟不会完全一致，几秒到几十秒的偏差很常见。',
      '如果只认当前窗口，那么每当用户在窗口边缘按下确认，就会莫名其妙失败一次 ——',
      '而用户看到的是「我明明输对了」。',
      '',
      '但漂移窗口开得越大，攻击者可用的时间也越长：一个被偷看到的验证码，',
      '在 ±1 的设置下有效期最多 90 秒，±5 就变成 5 分半。',
      '这是一个用**可用性**换**攻击窗口**的滑块，行业惯例停在 ±1。',
      '',
      '## 最容易写错的地方',
      '',
      '把「用过了」记在码上，而不是记在**窗口**上。',
      '',
      '看起来一样，其实差一层：同一个窗口的码永远相同，攻击者截到一个码之后，',
      '在这个窗口内重放的是同一串数字。但如果你按码去重，一个换了窗口又碰巧',
      '相同的码会被误判成重放。按窗口记账才是准确的那一层。',
    ].join('\n'),
    [
      'Stage 1 recognised "something you know". That factor has an unfixable weakness: it can be copied, and',
      'the owner never notices the copy.',
      '',
      'So you add "something you have": the six digits ticking on a phone every thirty seconds. The mechanism',
      'is almost disappointingly simple — the server and the phone share a secret, each divides the current',
      'time by thirty seconds, and each hashes that number with the secret. Both arrive at the same digits.',
      '',
      '## What to build',
      '',
      'Implement `createMfa(options)` in `src/mfa.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `code(atMs)` | Compute the six digits for an instant (the phone\'s job, used here to write tests) |',
      '| `verifyCode(candidate)` | Check a one-time code |',
      '| `useRecoveryCode(candidate)` | Spend a recovery code |',
      '| `remainingRecoveryCodes()` | How many are left |',
      '',
      '`options` carries `secret`, `stepMs` (the window length), `drift` (how many windows either side are',
      'tolerated) and `recoveryHashes` — **digests**, because the plaintext recovery codes were shown to the',
      'user exactly once, at generation time.',
      '',
      '## What counts as passing',
      '',
      '- The current window\'s code is accepted;',
      '- **The same code must fail the second time** (the `counters.totpReplayAccepted = 0` gate) — it is',
      '  called a one-time password, and once means once;',
      '- The previous and next windows are accepted too (the `counters.driftRejected = 0` gate counts codes',
      '  that should have been accepted and were not);',
      '- One window further out is refused;',
      '- A recovery code works once and decrements the remaining count;',
      '- Wrong codes and codes from a different secret never pass.',
      '',
      '## Why tolerate drift at all',
      '',
      'A phone clock and a server clock are never exactly aligned; a few seconds to a few tens of seconds of',
      'skew is routine. Accept only the current window and every user who presses confirm near a boundary gets',
      'an inexplicable failure — and what they see is "but I typed it correctly".',
      '',
      'Widen the window, though, and the attacker gets more time: a shoulder-surfed code lives at most ninety',
      'seconds at ±1 and five and a half minutes at ±5. It is a slider trading **usability** against **attack',
      'window**, and the industry has settled on ±1.',
      '',
      '## The easiest thing to get wrong',
      '',
      'Recording "already used" against the code instead of against the **window**.',
      '',
      'They look identical and differ by one layer. A window always produces the same digits, so a replay',
      'inside that window is literally the same string. But de-duplicating by digits means a code from another',
      'window that happens to collide is misread as a replay. The window is the accurate unit of bookkeeping.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  T["当前时间 now()"] --> CNT["counter = floor(now / stepMs)"]',
      '  CNT --> WIN["候选窗口<br/>counter-drift 到 counter+drift"]',
      '  WIN --> LOOP["逐个窗口检查"]',
      '  LOOP --> USED{"这个窗口用过了？"}',
      '  USED -- 用过 --> NEXT["跳过，看下一个"]',
      '  USED -- 没用过 --> CALC["codeFor(counter)<br/>hmac(secret, counter) 取六位"]',
      '  CALC --> CMP{"constantTimeEqual 相同？"}',
      '  CMP -- 不同 --> NEXT',
      '  CMP -- 相同 --> MARK["把这个窗口标记成用过"]',
      '  MARK --> PASS["通过"]',
      '  NEXT --> LOOP',
      '  LOOP --> FAIL["所有窗口都不匹配 → 拒绝"]',
      '',
      '  RC["useRecoveryCode(candidate)"] --> HASH["sha256(candidate)"]',
      '  HASH --> SET{"在恢复码集合里？"}',
      '  SET -- 不在 --> RNO["拒绝"]',
      '  SET -- 在 --> DEL["从集合里删掉<br/>一次性就是这个意思"]',
      '  DEL --> ROK["通过"]',
      '```',
      '',
      '要点：「用过了」这个标记挂在窗口号上，不挂在码上；',
      '而恢复码的「用过了」是**删掉它** —— 集合里没有的东西没法再用一次。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  T["current time now()"] --> CNT["counter = floor(now / stepMs)"]',
      '  CNT --> WIN["candidate windows<br/>counter-drift through counter+drift"]',
      '  WIN --> LOOP["check them one by one"]',
      '  LOOP --> USED{"window already spent?"}',
      '  USED -- yes --> NEXT["skip to the next one"]',
      '  USED -- no --> CALC["codeFor(counter)<br/>six digits from hmac(secret, counter)"]',
      '  CALC --> CMP{"constantTimeEqual matches?"}',
      '  CMP -- no --> NEXT',
      '  CMP -- yes --> MARK["mark this window spent"]',
      '  MARK --> PASS["accept"]',
      '  NEXT --> LOOP',
      '  LOOP --> FAIL["no window matched, refuse"]',
      '',
      '  RC["useRecoveryCode(candidate)"] --> HASH["sha256(candidate)"]',
      '  HASH --> SET{"present in the recovery set?"}',
      '  SET -- no --> RNO["refuse"]',
      '  SET -- yes --> DEL["remove it from the set<br/>that is what single-use means"]',
      '  DEL --> ROK["accept"]',
      '```',
      '',
      'The point: "spent" hangs off the window number, not off the digits; and for a recovery code, "spent"',
      'is **deleting it** — what is not in the set cannot be used again.',
    ].join('\n')
  ),
  checklist: [
    t('按窗口号记「已用」，不按码', 'Spent-ness is tracked per window, not per code'),
    t('前后各一个窗口都要接受', 'One window either side is accepted'),
    t('再往外的窗口拒绝', 'Anything further out is refused'),
    t('恢复码只能用一次', 'A recovery code works exactly once'),
    t('比较验证码走常数时间比较', 'Codes are compared in constant time'),
  ],
  pitfalls: [
    t(
      '只接受当前窗口。看起来最严格，实际结果是每天都有用户在窗口边缘输对了却被拒 —— 而他们的下一步通常是把 MFA 关掉。安全措施被关掉之后就不再提供任何安全。',
      'Accepting only the current window. It looks like the strict choice; in practice a stream of users type the right code at a boundary and are refused — and their next move is usually to turn MFA off. A control that gets switched off provides no security at all.'
    ),
    t(
      '接受了就完事，不记「已用」。攻击者只要在这 30 秒里拿到码就能用第二次；而 MFA 防的恰恰是「凭据被看到了」这一类攻击，不记一次性等于把这一关做成了摆设。',
      'Accepting without marking the window spent. An attacker who sees the code within those thirty seconds simply uses it again — and "the credential was observed" is exactly the attack MFA exists to stop, so skipping single-use turns the whole factor into decoration.'
    ),
    t(
      '把恢复码原文存在服务端。恢复码是长期有效的完整绕过手段，一旦库泄露，它比密码更值钱 —— 它绕过的正是你加上来防密码泄露的那一层。存摘要就够了。',
      'Storing recovery codes in plaintext. A recovery code is a long-lived complete bypass, so in a database leak it is worth more than the password — it bypasses precisely the layer you added to survive password leaks. A digest is enough.'
    ),
    t(
      '用 `Math.abs(candidate - expected) < tolerance` 之类的「近似比较」。验证码是六位数字组成的字符串，不是数量；`012345` 和 `12345` 是两回事，而数值比较会把前导零吃掉。',
      'Comparing codes numerically with a tolerance. A code is a six-character string, not a quantity: `012345` and `12345` are different codes, and numeric comparison eats the leading zero.'
    ),
  ],
  hints: [
    t(
      '`codeFor(counter)` 是纯函数：hmac(secret, counter) 取前几位十六进制，转成整数对 1000000 取模，再补足六位。同一个 counter 永远得到同一个码。',
      '`codeFor(counter)` is pure: take a few hex characters from hmac(secret, counter), parse them, take the value modulo one million, pad to six digits. The same counter always yields the same code.'
    ),
    t(
      '候选窗口是一个从 -drift 到 +drift 的小循环。命中之后要 return，同时把这个窗口号放进已用集合。',
      'The candidate windows are a small loop from -drift to +drift. On a hit, add the window number to the spent set and return.'
    ),
  ],
  extension: t(
    [
      'RFC 6238（TOTP）就是这一关，它建立在 RFC 4226（HOTP，按次数而不是按时间）之上。',
      '真实实现和这里的差别主要在两处：真的 HMAC-SHA1/SHA256，以及「动态截断」——',
      '从摘要里按最后一个字节指示的偏移取 4 个字节，而不是固定取前几位。',
      '',
      '这一关把「用过的窗口」放在实例里。真实系统必须把它放进共享存储：',
      '否则两台服务器各自记账，同一个码在 A 上用过了还能在 B 上再用一次。',
      '通常存的是「这个用户最后成功的窗口号」，验证时要求 counter 严格大于它 ——',
      '一个数字同时解决了重放和存储增长。',
      '',
      '至于 MFA 自身的弱点：TOTP 防不住实时钓鱼（假页面把你输入的码立刻转发给真站点）。',
      '要防住这个，需要把「域名」也绑进认证过程 —— 那就是 WebAuthn / Passkey 的事了。',
    ].join('\n'),
    [
      'RFC 6238 (TOTP) is this stage, built on RFC 4226 (HOTP, counting events instead of time). Real',
      'implementations differ in two places: genuine HMAC-SHA1/SHA256, and dynamic truncation — four bytes',
      'taken at an offset named by the last byte of the digest, rather than a fixed prefix.',
      '',
      'This stage keeps the spent windows in the instance. Production has to keep them in shared storage,',
      'otherwise two servers each keep their own books and a code spent on A is still fresh on B. The usual',
      'shape is "the last successful window for this user", requiring the counter to be strictly greater — one',
      'number solving replay and storage growth at once.',
      '',
      "As for the weakness of the factor itself: TOTP does not stop real-time phishing, where a fake page",
      'forwards your code to the real site as you type it. Stopping that requires binding the domain into the',
      'ceremony, which is what WebAuthn and passkeys do.',
    ].join('\n')
  ),
  focus: ['correctness', 'resilience', 'elegance'],
  lab: {},
  starterFiles: [
    file(
      'src/mfa.ts',
      code`
        import { constantTimeEqual, hmac, sha256 } from './support/crypto';
        import { now } from '@lab/env';

        export interface MfaOptions {
          /** The secret shared with the phone */
          secret: string;
          /** How long one time window is, in milliseconds; 30000 in the real world */
          stepMs: number;
          /** How many windows of clock drift are allowed on either side */
          drift: number;
          /** Digests of the recovery codes. The user is shown the originals once, at generation time. */
          recoveryHashes: string[];
        }

        export interface MfaVerifier {
          /** The six digits that should be showing at a given instant */
          code(atMs: number): string;
          verifyCode(candidate: string): boolean;
          useRecoveryCode(candidate: string): boolean;
          remainingRecoveryCodes(): number;
        }

        export function createMfa(options: MfaOptions): MfaVerifier {
          // TODO: implement this
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-5.spec.ts',
      code`
        import { createMfa } from '../src/mfa';
        import { sha256 } from '../src/support/crypto';
        import { now, sleep } from '@lab/env';
        import { count, getCounters } from '@lab/metrics';

        const SECRET = 'shared-totp-secret';
        const STEP = 30000;
        const RECOVERY = ['recovery-aaa', 'recovery-bbb'];

        function makeMfa(secret = SECRET) {
          return createMfa({
            secret,
            stepMs: STEP,
            drift: 1,
            recoveryHashes: RECOVERY.map((item) => sha256(item)),
          });
        }

        describe('Stage 5 · One-time passwords and recovery codes', () => {
          it("the current window's code passes", () => {
            const mfa = makeMfa();

            expect(mfa.verifyCode(mfa.code(now()))).toBe(true);
          });

          it('using the same code a second time fails', () => {
            const mfa = makeMfa();
            const code = mfa.code(now());
            expect(mfa.verifyCode(code)).toBe(true);

            const replay = mfa.verifyCode(code);
            if (replay) count('totpReplayAccepted');
            expect(replay).toBe(false);
          });

          it("the previous window's code is still accepted [gate:drift]", () => {
            const mfa = makeMfa();

            const accepted = mfa.verifyCode(mfa.code(now() - STEP));
            if (!accepted) count('driftRejected');
            expect(accepted).toBe(true);
          });

          it("the next window's code is accepted too [gate:drift]", () => {
            const mfa = makeMfa();

            const accepted = mfa.verifyCode(mfa.code(now() + STEP));
            if (!accepted) count('driftRejected');
            expect(accepted).toBe(true);
          });

          it('one window further out is not accepted', () => {
            const mfa = makeMfa();

            expect(mfa.verifyCode(mfa.code(now() - STEP * 2))).toBe(false);
            expect(mfa.verifyCode(mfa.code(now() + STEP * 2))).toBe(false);
          });

          it('a wrong code does not pass', () => {
            const mfa = makeMfa();

            expect(mfa.verifyCode('000000')).toBe(false);
            expect(mfa.verifyCode('')).toBe(false);
          });

          it('a code computed from a different secret does not pass', () => {
            const mfa = makeMfa();
            const other = makeMfa('a-different-secret');

            expect(mfa.verifyCode(other.code(now()))).toBe(false);
          });

          it('the code is a six-character string and stays the same within one window', () => {
            const mfa = makeMfa();
            const code = mfa.code(now());

            expect(code).toHaveLength(6);
            expect(code).toMatch(/^[0-9]{6}$/);
            expect(mfa.code(now() + STEP - 1)).toBe(code);
          });

          it('a used code does not come back to life once the clock enters the next window', async () => {
            const mfa = makeMfa();
            const code = mfa.code(now());
            expect(mfa.verifyCode(code)).toBe(true);

            await sleep(STEP);
            // After the window rolls it is still within the drift range, but it has already been spent
            const replay = mfa.verifyCode(code);
            if (replay) count('totpReplayAccepted');
            expect(replay).toBe(false);
          });

          it('a recovery code works once and not twice', () => {
            const mfa = makeMfa();

            expect(mfa.remainingRecoveryCodes()).toBe(2);
            expect(mfa.useRecoveryCode('recovery-aaa')).toBe(true);
            expect(mfa.remainingRecoveryCodes()).toBe(1);

            const replay = mfa.useRecoveryCode('recovery-aaa');
            if (replay) count('totpReplayAccepted');
            expect(replay).toBe(false);
          });

          it('an unrecognised recovery code does not pass and does not consume one', () => {
            const mfa = makeMfa();

            expect(mfa.useRecoveryCode('recovery-zzz')).toBe(false);
            expect(mfa.remainingRecoveryCodes()).toBe(2);
          });

          it('code comparison goes through the constant-time comparison', () => {
            const mfa = makeMfa();

            const before = getCounters()['constantTimeCompares'] || 0;
            mfa.verifyCode('123456');
            expect(getCounters()['constantTimeCompares'] || 0).toBeGreaterThan(before);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.totpReplayAccepted',
      op: 'eq',
      value: 0,
      zh: '一次性密码一次都不许用第二遍',
      en: 'A one-time code is never accepted twice',
      dimension: 'resilience',
    }),
    gate({
      metric: 'counters.driftRejected',
      op: 'eq',
      value: 0,
      zh: '前后一个窗口的漂移一次都不误拒',
      en: 'Not one legitimate code inside the drift window is refused',
      dimension: 'correctness',
    }),
  ],
  referenceFiles: [
    file(
      'src/mfa.ts',
      code`
        import { constantTimeEqual, hmac, sha256 } from './support/crypto';
        import { now } from '@lab/env';

        export interface MfaOptions {
          secret: string;
          stepMs: number;
          drift: number;
          recoveryHashes: string[];
        }

        export interface MfaVerifier {
          code(atMs: number): string;
          verifyCode(candidate: string): boolean;
          useRecoveryCode(candidate: string): boolean;
          remainingRecoveryCodes(): number;
        }

        const DIGITS = 6;
        const MODULO = 1000000;
        /** How many hex digits of the digest go into the six-digit code */
        const SLICE = 8;

        export function createMfa(options: MfaOptions): MfaVerifier {
          /** Window numbers already spent. Record the window, not the code. */
          const spent = new Set<number>();
          /** Only digests of recovery codes are kept, and a used one is deleted */
          const recovery = new Set<string>(options.recoveryHashes);

          function counterAt(atMs: number): number {
            return Math.floor(atMs / options.stepMs);
          }

          function codeFor(counter: number): string {
            const digest = hmac(options.secret, 'totp:' + counter);
            const value = parseInt(digest.slice(0, SLICE), 16) % MODULO;
            return String(value).padStart(DIGITS, '0');
          }

          return {
            code(atMs: number): string {
              return codeFor(counterAt(atMs));
            },

            verifyCode(candidate: string): boolean {
              const current = counterAt(now());
              for (let offset = -options.drift; offset <= options.drift; offset += 1) {
                const counter = current + offset;
                if (spent.has(counter)) continue;
                if (!constantTimeEqual(codeFor(counter), candidate)) continue;
                spent.add(counter);
                return true;
              }
              return false;
            },

            useRecoveryCode(candidate: string): boolean {
              const digest = sha256(candidate);
              if (!recovery.has(digest)) return false;
              // Delete on use: the most direct way to make something single-use is to stop it existing
              recovery.delete(digest);
              return true;
            },

            remainingRecoveryCodes(): number {
              return recovery.size;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '三个决定：',
      '',
      '**`spent` 记的是窗口号。** 一个整数集合，天然去重，也天然能表达',
      '「这个窗口用过但相邻窗口还没」。如果记的是码字符串，语义就模糊了：',
      '两个不同窗口偶然算出同一个码时，第二个会被误判成重放。',
      '',
      '**恢复码的比较用集合查找，验证码的比较用常数时间。** 这不是前后矛盾：',
      '恢复码是高熵随机串，攻击者没法靠计时逐字节试探出来；',
      '而六位数字只有一百万种，任何能缩小搜索空间的信息都值钱。',
      '',
      '**`code` 和 `verifyCode` 共用 `codeFor`。** 出题的一侧和验证的一侧',
      '如果各写一份算法，两边迟早会因为一个 padStart 而对不上，',
      '而那种 bug 只在极少数结果不足六位时出现。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      '`spent` holds window numbers. A set of integers deduplicates naturally and expresses "this window is',
      'spent but its neighbour is not" without ambiguity. Track code strings instead and the meaning blurs:',
      'two different windows that happen to produce the same digits make the second look like a replay.',
      '',
      'Recovery codes are matched by set lookup while TOTP codes are compared in constant time. That is not',
      'inconsistent: a recovery code is a high-entropy random string with nothing to probe byte by byte, while',
      'six digits have only a million possibilities and any information that shrinks the search space is worth',
      'something.',
      '',
      '`code` and `verifyCode` share `codeFor`. Write the algorithm twice — once to generate, once to check —',
      'and the two copies eventually disagree over something like a `padStart`, in the rare case where the',
      'value has fewer than six digits.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 6 关 · 授权码与 PKCE                                              */
/* ------------------------------------------------------------------ */

const stage6 = {
  id: 'oauth-code-pkce',
  title: t('第 6 关 · 授权码与 PKCE', 'Stage 6 · Authorization codes and PKCE'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '前五关都在处理「用户直接对我们出示凭据」。这一关换个场景：',
      '**第三方应用**想代表用户访问我们的接口，而用户不该把密码交给它。',
      '',
      'OAuth 的答案是一张一次性的**授权码**：用户在我们这里同意授权，',
      '我们把码交给第三方，第三方拿码来换令牌。密码从头到尾没离开过我们。',
      '',
      '但码是通过浏览器重定向传递的 —— 它会经过地址栏、历史记录、',
      '有时还有一个装在同一台手机上的恶意应用。码被截走怎么办？',
      '这就是 PKCE 要回答的问题。',
      '',
      '## 要实现什么',
      '',
      '在 `src/oauth.ts` 实现 `createOAuthServer(store, refresh, options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `authorize(request)` | 校验客户端与回调地址，记下 PKCE 挑战，返回一次性授权码 |',
      '| `exchange(request)` | 校验码 + 客户端 + 回调 + verifier，成功就调 `refresh.start` 发令牌 |',
      '',
      'PKCE 的机制：客户端先自己造一个随机的 `codeVerifier`，',
      '把 `sha256(verifier)` 作为 `codeChallenge` 送来；换令牌时出示原始的 verifier。',
      '截走码的人没有 verifier，而从 challenge 反推 verifier 需要破解哈希。',
      '',
      '## 怎么算过',
      '',
      '- 完整流程走得通：authorize 拿码，exchange 换到一对令牌，访问令牌验得过；',
      '- **一个码只能换一次**（门槛 `counters.codeReuseAccepted = 0`）；',
      '- verifier 不对、没带、或者拿 challenge 冒充 verifier，一律换不到',
      '  （门槛 `counters.pkceBypassAccepted = 0`）；',
      '- `codeChallengeMethod` 只接受 `S256`，`plain` 直接拒绝；',
      '- 未注册的 client、未注册的 redirectUri 一律拒绝；',
      '- 换令牌时的 client 和 redirectUri 必须和当初申请时**完全一致**；',
      '- 过期的码换不到；',
      '- 库里存的是码的摘要；',
      '- **换失败也要把码烧掉**：verifier 猜错一次之后，正确的 verifier 也换不到了。',
      '',
      '## 最后那条为什么重要',
      '',
      '如果失败不消耗码，攻击者截到一个码之后就有了无限次机会去猜 verifier。',
      'PKCE 的全部安全性建立在「他猜不出来」上，而无限次尝试会把「猜不出来」',
      '变成「早晚能猜出来」。',
      '',
      '代价是真实客户端配错一次就得让用户重新授权一遍。这是个划算的交易 ——',
      '配错是开发期的问题，而被截码是线上的问题。',
      '',
      '## 最容易写错的地方',
      '',
      '只校验 verifier，不校验 redirectUri。',
      '',
      '回调地址是攻击者最喜欢的入口：只要能让授权服务器把码送到他控制的地址，',
      '前面所有校验都白做。而且这个洞非常隐蔽 —— 功能测试全过，',
      '因为正常客户端本来就用注册好的那个地址。',
    ].join('\n'),
    [
      'The first five stages all handled "the user presents credentials to us". This one changes the scene: a',
      '**third-party application** wants to call our API on the user\'s behalf, and the user must not hand it',
      'their password.',
      '',
      "OAuth's answer is a single-use **authorization code**: the user consents here, we hand the code to the",
      'third party, the third party trades the code for tokens. The password never leaves our side.',
      '',
      'But the code travels through a browser redirect — address bars, history, sometimes a malicious app',
      'installed on the same phone. What if the code is intercepted? That is the question PKCE answers.',
      '',
      '## What to build',
      '',
      'Implement `createOAuthServer(store, refresh, options)` in `src/oauth.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `authorize(request)` | Validate client and redirect, record the PKCE challenge, return a single-use code |',
      '| `exchange(request)` | Validate code, client, redirect and verifier, then call `refresh.start` |',
      '',
      'How PKCE works: the client invents a random `codeVerifier`, sends `sha256(verifier)` as the',
      '`codeChallenge`, and presents the original verifier when redeeming. Whoever intercepts the code has no',
      'verifier, and deriving one from the challenge means breaking the hash.',
      '',
      '## What counts as passing',
      '',
      '- The happy path works: authorize returns a code, exchange returns a pair, the access token verifies;',
      '- **One code, one exchange** (the `counters.codeReuseAccepted = 0` gate);',
      '- A wrong verifier, a missing verifier, or passing the challenge as the verifier all fail',
      '  (the `counters.pkceBypassAccepted = 0` gate);',
      '- `codeChallengeMethod` accepts only `S256`; `plain` is refused outright;',
      '- Unregistered clients and unregistered redirect URIs are refused;',
      '- The client and redirect URI at exchange time must match the ones from authorize **exactly**;',
      '- Expired codes fail;',
      '- The store holds a digest of the code;',
      '- **A failed exchange burns the code too**: guess the verifier wrong once and the right one no longer works.',
      '',
      '## Why that last rule matters',
      '',
      'If failures do not consume the code, an attacker who intercepts one gets unlimited attempts at the',
      'verifier. The entire security of PKCE rests on "they cannot guess it", and unlimited attempts turn that',
      'into "they will eventually guess it".',
      '',
      'The price is that a misconfigured client forces the user through the consent screen again. That is a',
      'good trade: misconfiguration is a development-time problem, interception is a production one.',
      '',
      '## The easiest thing to get wrong',
      '',
      'Validating the verifier but not the redirect URI.',
      '',
      "The callback address is an attacker's favourite door: get the authorization server to deliver the code",
      'to an address they control and every other check was pointless. The hole is also very quiet —',
      'functional tests all pass, because a legitimate client uses its registered address anyway.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  A["authorize(request)"] --> C1{"client 注册过？"}',
      '  C1 -- 没有 --> AN["返回 null"]',
      '  C1 -- 有 --> C2{"redirectUri 在这个 client 名下？"}',
      '  C2 -- 不在 --> AN',
      '  C2 -- 在 --> C3{"method 是 S256？"}',
      '  C3 -- 不是 --> AN',
      '  C3 -- 是 --> SAVE["记下 client / redirect / challenge / 用户<br/>key 用 sha256(code)"]',
      '  SAVE --> CODE["返回一次性授权码"]',
      '',
      '  E["exchange(request)"] --> L["按 sha256(code) 取记录"]',
      '  L --> F1{"存在且没用过？"}',
      '  F1 -- 否 --> EN["返回 null"]',
      '  F1 -- 是 --> BURN["立刻标记成已用<br/>后面失败也不还回来"]',
      '  BURN --> F2{"没过期？"}',
      '  F2 -- 过期 --> EN',
      '  F2 -- 没过期 --> F3{"client 与 redirect 都对得上？"}',
      '  F3 -- 对不上 --> EN',
      '  F3 -- 对得上 --> F4{"sha256(verifier) 等于 challenge？"}',
      '  F4 -- 不等 --> EN',
      '  F4 -- 相等 --> OK["refresh.start 发一对令牌"]',
      '```',
      '',
      '要点：`BURN` 在所有校验**之前**。放到后面（只有成功才烧）代码更「合理」，',
      '却把 verifier 从「猜一次」变成了「随便猜」。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  A["authorize(request)"] --> C1{"client registered?"}',
      '  C1 -- no --> AN["return null"]',
      '  C1 -- yes --> C2{"redirectUri belongs to it?"}',
      '  C2 -- no --> AN',
      '  C2 -- yes --> C3{"method is S256?"}',
      '  C3 -- no --> AN',
      '  C3 -- yes --> SAVE["record client / redirect / challenge / user<br/>keyed by sha256(code)"]',
      '  SAVE --> CODE["return a single-use code"]',
      '',
      '  E["exchange(request)"] --> L["load by sha256(code)"]',
      '  L --> F1{"present and unused?"}',
      '  F1 -- no --> EN["return null"]',
      '  F1 -- yes --> BURN["mark used immediately<br/>failures do not give it back"]',
      '  BURN --> F2{"not expired?"}',
      '  F2 -- expired --> EN',
      '  F2 -- fresh --> F3{"client and redirect both match?"}',
      '  F3 -- no --> EN',
      '  F3 -- yes --> F4{"sha256(verifier) equals the challenge?"}',
      '  F4 -- no --> EN',
      '  F4 -- yes --> OK["refresh.start mints a pair"]',
      '```',
      '',
      'The point: `BURN` sits **before** every check. Moving it to the end — burn only on success — reads more',
      'reasonably and turns the verifier from "one guess" into "as many as you like".',
    ].join('\n')
  ),
  checklist: [
    t('只接受 S256，拒绝 plain', 'Only S256 is accepted; plain is refused'),
    t('client 与 redirectUri 两头都要对上', 'Client and redirect URI must match on both ends'),
    t('码在任何一次 exchange 之后都作废', 'A code is dead after any exchange attempt'),
    t('verifier 用常数时间比较', 'The verifier is compared in constant time'),
    t('库里存码的摘要', 'The store holds the digest of the code'),
  ],
  pitfalls: [
    t(
      '接受 `codeChallengeMethod: "plain"`。plain 的 challenge 就是 verifier 本身，截走码的人顺手也就截走了 verifier —— PKCE 变成一段纯粹的仪式。RFC 7636 留下 plain 是为了兼容算不动 SHA-256 的老设备，今天没有这样的设备了。',
      'Accepting `codeChallengeMethod: "plain"`. With plain the challenge is the verifier, so whoever intercepts the code intercepts the verifier too and PKCE becomes pure ceremony. RFC 7636 kept plain for devices that could not compute SHA-256; those devices no longer exist.'
    ),
    t(
      '换令牌时不比对 redirectUri。攻击者注册一个自己的 client、诱导用户走一次授权、把码送到自己的地址 —— 全程没有任何一步「看起来不对」。这个校验是 OAuth 里最容易漏、也最致命的一条。',
      'Not comparing the redirect URI at exchange time. An attacker registers their own client, walks the user through a consent, and has the code delivered to their address — with no step that looks wrong along the way. It is the easiest check to omit in OAuth and the most fatal.'
    ),
    t(
      '只有成功才把码标记成已用。失败不消耗码，等于给攻击者无限次机会去猜 verifier；而 PKCE 的整个安全论证前提就是「他只有一次机会」。',
      'Marking the code used only on success. A failure that costs nothing gives the attacker unlimited guesses at the verifier, and the entire security argument for PKCE assumes they get one.'
    ),
    t(
      '授权码用长有效期。它只需要活过「浏览器重定向 + 客户端立刻来换」这段时间，通常是几十秒。给它十分钟，就是给截码的人十分钟去用。',
      'Giving authorization codes a long lifetime. A code only has to survive a redirect plus an immediate exchange — tens of seconds. Ten minutes of validity is ten minutes of opportunity for whoever intercepted it.'
    ),
  ],
  hints: [
    t(
      '记录里存 { clientId, redirectUri, challenge, userId, tenantId, exp, used } 就够了。key 仍然用 sha256(code)，和第 3 关的刷新令牌一个套路。',
      'A record of { clientId, redirectUri, challenge, userId, tenantId, exp, used } is enough, keyed by sha256(code) — the same shape as the refresh tokens in stage 3.'
    ),
    t(
      '换令牌成功之后不要自己去签令牌：调用第 3 关的 `refresh.start`，让所有登录路径都汇到同一处发令牌的代码上。',
      'Do not mint tokens yourself on success: call `refresh.start` from stage 3 so every login path funnels into one place that issues tokens.'
    ),
  ],
  extension: t(
    [
      'PKCE（RFC 7636）最初是为手机 App 设计的：那时候的移动端用自定义 URL scheme',
      '接收回调，而同一台手机上的任何一个应用都能注册同一个 scheme ——',
      '恶意应用于是能截到授权码。PKCE 让截到码的人拿不到令牌。',
      '',
      '后来 OAuth 2.1 把 PKCE 变成了**所有**客户端的强制要求，包括有密钥的后端应用。',
      '理由是它防的不只是「码被截走」，还有「授权码注入」：',
      '攻击者把自己的码塞进受害者的会话，让受害者的客户端拿它去换令牌，',
      '于是受害者「登录成了攻击者的账号」，之后上传的东西全在攻击者手里。',
      '',
      '这一关没做的另一半是 `state` 参数（防 CSRF）和 `nonce`（防 ID Token 重放）——',
      '后者是下一关的事。三个参数各防一件事，而它们经常被混为一谈。',
    ].join('\n'),
    [
      'PKCE (RFC 7636) was designed for mobile apps, back when they received callbacks through custom URL',
      'schemes that any app on the same phone could register — so a malicious app could intercept the code.',
      'PKCE makes an intercepted code useless.',
      '',
      'OAuth 2.1 later made PKCE mandatory for **every** client, including confidential backends. The reason is',
      'that it defends against more than interception: authorization code injection, where an attacker plants',
      'their own code into a victim\'s session so the victim\'s client redeems it, logs the victim into the',
      "attacker's account, and everything uploaded afterwards lands in the attacker's hands.",
      '',
      'The other half this stage skips is the `state` parameter (CSRF) and `nonce` (ID token replay) — the',
      'latter belongs to the next stage. Three parameters, three distinct attacks, routinely confused for each',
      'other.',
    ].join('\n')
  ),
  focus: ['correctness', 'resilience', 'encapsulation'],
  lab: {},
  starterFiles: [
    file(
      'src/oauth.ts',
      code`
        import { COLLECTIONS } from './contract';
        import type { RefreshService, TokenPair } from './refresh';
        import type { Store } from './support/store';
        import { constantTimeEqual, randomId, sha256 } from './support/crypto';
        import { now } from '@lab/env';

        /** A registered third-party client */
        export interface ClientRegistration {
          clientId: string;
          /** Only registered redirect URIs may receive an authorization code */
          redirectUris: string[];
        }

        export interface AuthorizeRequest {
          clientId: string;
          redirectUri: string;
          /** sha256(codeVerifier) */
          codeChallenge: string;
          /** Only 'S256' is accepted */
          codeChallengeMethod: string;
          userId: string;
          tenantId: string;
        }

        export interface ExchangeRequest {
          code: string;
          clientId: string;
          redirectUri: string;
          codeVerifier: string;
        }

        export interface OAuthOptions {
          /** Authorization code lifetime; being short-lived is the point of its design */
          ttlMs: number;
          clients: ClientRegistration[];
        }

        export interface OAuthServer {
          authorize(request: AuthorizeRequest): string | null;
          exchange(request: ExchangeRequest): TokenPair | null;
        }

        export function createOAuthServer(
          store: Store,
          refresh: RefreshService,
          options: OAuthOptions
        ): OAuthServer {
          // TODO: implement this
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-6.spec.ts',
      code`
        import { createOAuthServer } from '../src/oauth';
        import { createRefreshService } from '../src/refresh';
        import { createSessionIssuer } from '../src/session';
        import { COLLECTIONS } from '../src/contract';
        import { createStore } from '../src/support/store';
        import { sha256 } from '../src/support/crypto';
        import { sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const SECRET = 'session-signing-key';
        const CODE_TTL = 30000;
        const VERIFIER = 'a-random-verifier-the-client-invented';
        const CHALLENGE = sha256(VERIFIER);

        const CLIENTS = [
          { clientId: 'photo-app', redirectUris: ['https://photos.example/callback'] },
          { clientId: 'other-app', redirectUris: ['https://other.example/callback'] },
        ];

        function makeServer(store: any) {
          const issuer = createSessionIssuer({ secret: SECRET, ttlMs: 60000 });
          const refresh = createRefreshService(store, issuer, { ttlMs: 600000 });
          return createOAuthServer(store, refresh, { ttlMs: CODE_TTL, clients: CLIENTS });
        }

        function authorize(server: any, overrides: any = {}) {
          return server.authorize({
            clientId: 'photo-app',
            redirectUri: 'https://photos.example/callback',
            codeChallenge: CHALLENGE,
            codeChallengeMethod: 'S256',
            userId: 'alice',
            tenantId: 'acme',
            ...overrides,
          });
        }

        function exchange(server: any, code: string, overrides: any = {}) {
          return server.exchange({
            code,
            clientId: 'photo-app',
            redirectUri: 'https://photos.example/callback',
            codeVerifier: VERIFIER,
            ...overrides,
          });
        }

        describe('Stage 6 · Authorization codes and PKCE', () => {
          it('the full flow works', () => {
            const server = makeServer(createStore());
            const code = authorize(server);
            expect(code).toBeTruthy();

            const pair = exchange(server, code);
            expect(pair).toBeTruthy();

            const issuer = createSessionIssuer({ secret: SECRET, ttlMs: 60000 });
            expect(issuer.verify(pair.accessToken).sub).toBe('alice');
          });

          it('an authorization code can be exchanged only once', () => {
            const server = makeServer(createStore());
            const code = authorize(server);
            expect(exchange(server, code)).toBeTruthy();

            const again = exchange(server, code);
            if (again) count('codeReuseAccepted');
            expect(again).toBeNull();
          });

          it('a wrong verifier cannot be exchanged', () => {
            const server = makeServer(createStore());

            const stolen = exchange(server, authorize(server), { codeVerifier: 'guessed-wrong' });
            if (stolen) count('pkceBypassAccepted');
            expect(stolen).toBeNull();
          });

          it('no verifier cannot be exchanged either', () => {
            const server = makeServer(createStore());

            const empty = exchange(server, authorize(server), { codeVerifier: '' });
            if (empty) count('pkceBypassAccepted');
            expect(empty).toBeNull();
          });

          it('passing the challenge as the verifier does not work', () => {
            const server = makeServer(createStore());

            // This is exactly what an attacker can do in plain mode: they can see the challenge
            const downgraded = exchange(server, authorize(server), { codeVerifier: CHALLENGE });
            if (downgraded) count('pkceBypassAccepted');
            expect(downgraded).toBeNull();
          });

          it('after one wrong guess even the right verifier stops working', () => {
            const server = makeServer(createStore());
            const code = authorize(server);

            expect(exchange(server, code, { codeVerifier: 'guessed-wrong' })).toBeNull();

            const retried = exchange(server, code);
            if (retried) count('pkceBypassAccepted');
            expect(retried).toBeNull();
          });

          it('no code is issued when method is not S256', () => {
            const server = makeServer(createStore());

            expect(authorize(server, { codeChallengeMethod: 'plain' })).toBeNull();
            expect(authorize(server, { codeChallengeMethod: '' })).toBeNull();
          });

          it('an unregistered client or redirect URI gets no code', () => {
            const server = makeServer(createStore());

            expect(authorize(server, { clientId: 'evil-app' })).toBeNull();
            expect(authorize(server, { redirectUri: 'https://evil.example/callback' })).toBeNull();
          });

          it('the client at token exchange must match the one that requested it', () => {
            const server = makeServer(createStore());

            const hijacked = exchange(server, authorize(server), { clientId: 'other-app' });
            if (hijacked) count('codeReuseAccepted');
            expect(hijacked).toBeNull();
          });

          it('the redirectUri at token exchange must match the one that requested it', () => {
            const server = makeServer(createStore());

            const redirected = exchange(server, authorize(server), {
              redirectUri: 'https://other.example/callback',
            });
            if (redirected) count('codeReuseAccepted');
            expect(redirected).toBeNull();
          });

          it('an expired authorization code cannot be exchanged', async () => {
            const server = makeServer(createStore());
            const code = authorize(server);

            await sleep(CODE_TTL);
            expect(exchange(server, code)).toBeNull();
          });

          it('an unrecognised code cannot be exchanged', () => {
            const server = makeServer(createStore());
            authorize(server);

            expect(exchange(server, 'code_made-up')).toBeNull();
          });

          it('the store holds a digest of the code', () => {
            const store = createStore();
            const code = authorize(makeServer(store));

            const dump = JSON.stringify(store.list(COLLECTIONS.codes)) + store.keys(COLLECTIONS.codes).join(',');
            expect(dump).not.toContain(code);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.codeReuseAccepted',
      op: 'eq',
      value: 0,
      zh: '授权码一次都不许换第二遍',
      en: 'An authorization code is never redeemed twice',
      dimension: 'resilience',
    }),
    gate({
      metric: 'counters.pkceBypassAccepted',
      op: 'eq',
      value: 0,
      zh: '没有正确 verifier 一次都换不到令牌',
      en: 'No token is ever issued without the right verifier',
      dimension: 'resilience',
    }),
  ],
  referenceFiles: [
    file(
      'src/oauth.ts',
      code`
        import { COLLECTIONS } from './contract';
        import type { RefreshService, TokenPair } from './refresh';
        import type { Store } from './support/store';
        import { constantTimeEqual, randomId, sha256 } from './support/crypto';
        import { now } from '@lab/env';

        export interface ClientRegistration {
          clientId: string;
          redirectUris: string[];
        }

        export interface AuthorizeRequest {
          clientId: string;
          redirectUri: string;
          codeChallenge: string;
          codeChallengeMethod: string;
          userId: string;
          tenantId: string;
        }

        export interface ExchangeRequest {
          code: string;
          clientId: string;
          redirectUri: string;
          codeVerifier: string;
        }

        export interface OAuthOptions {
          ttlMs: number;
          clients: ClientRegistration[];
        }

        export interface OAuthServer {
          authorize(request: AuthorizeRequest): string | null;
          exchange(request: ExchangeRequest): TokenPair | null;
        }

        /** The only challenge method accepted. plain is a historical leftover and gets no door here. */
        const S256 = 'S256';

        interface CodeRecord {
          clientId: string;
          redirectUri: string;
          challenge: string;
          userId: string;
          tenantId: string;
          exp: number;
          used: boolean;
        }

        export function createOAuthServer(
          store: Store,
          refresh: RefreshService,
          options: OAuthOptions
        ): OAuthServer {
          function registrationOf(clientId: string): ClientRegistration | undefined {
            return options.clients.filter((client) => client.clientId === clientId)[0];
          }

          function save(code: string, record: CodeRecord): void {
            store.put(COLLECTIONS.codes, sha256(code), record as unknown as Record<string, unknown>);
          }

          return {
            authorize(request: AuthorizeRequest): string | null {
              const client = registrationOf(request.clientId);
              if (!client) return null;
              if (client.redirectUris.indexOf(request.redirectUri) < 0) return null;
              if (request.codeChallengeMethod !== S256 || !request.codeChallenge) return null;

              const code = randomId('code');
              save(code, {
                clientId: request.clientId,
                redirectUri: request.redirectUri,
                challenge: request.codeChallenge,
                userId: request.userId,
                tenantId: request.tenantId,
                exp: now() + options.ttlMs,
                used: false,
              });
              return code;
            },

            exchange(request: ExchangeRequest): TokenPair | null {
              const key = sha256(request.code || '');
              const record = store.get(COLLECTIONS.codes, key) as unknown as CodeRecord | undefined;
              if (!record || record.used) return null;

              // Burn it before checking: once an attacker intercepts a code, this is their one
              // chance to guess the verifier
              save(request.code, { ...record, used: true });

              if (now() >= record.exp) return null;
              if (record.clientId !== request.clientId) return null;
              if (record.redirectUri !== request.redirectUri) return null;
              if (!constantTimeEqual(sha256(request.codeVerifier || ''), record.challenge)) return null;

              // Every login path eventually converges on this one place that issues tokens
              return refresh.start({ userId: record.userId, tenantId: record.tenantId });
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '三个决定：',
      '',
      '**先烧码，再校验。** 这一行的位置决定了攻击者有几次机会。写在最后',
      '（成功才烧）功能完全正确，PKCE 的强度却从「一次」掉到「无限次」。',
      '安全代码里，副作用的**顺序**常常比副作用本身更要紧。',
      '',
      '**只认 S256。** 拒绝 plain 不是洁癖：plain 的 challenge 就等于 verifier，',
      '而 challenge 是明着传的。留一个「兼容模式」的下场，就是攻击者永远走那一条。',
      '',
      '**成功之后调 `refresh.start`，不自己签令牌。** 于是「发令牌」这件事',
      '在整个系统里只有一处实现，第 3 关的轮转与重放检测自动覆盖到第三方登录。',
      '复制一份签发逻辑，就等于给自己留了一个迟早会漏掉某个检查的分身。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      'Burn the code before validating. The position of that one line decides how many attempts the attacker',
      'gets. Putting it last — burn only on success — is functionally correct and drops PKCE from "one guess"',
      'to "unlimited". In security code the **order** of side effects often matters more than the effects.',
      '',
      'Only S256 is accepted. Refusing plain is not fastidiousness: with plain the challenge equals the',
      'verifier, and the challenge travels in the clear. Leave a compatibility mode and the attacker always',
      'takes it.',
      '',
      'Success calls `refresh.start` instead of minting tokens locally. Issuing tokens then exists in exactly',
      "one place, and stage 3's rotation and replay detection cover third-party logins for free. A second copy",
      'of the issuing logic is a twin that will eventually miss one of the checks.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 7 关 · ID Token 校验                                              */
/* ------------------------------------------------------------------ */

const stage7 = {
  id: 'oidc-verify',
  title: t('第 7 关 · 校验别人签发的身份', 'Stage 7 · Verifying an identity someone else signed'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '上一关我们是授权服务器。这一关掉个个儿：**我们是依赖方**。',
      '用户点了「用某某账号登录」，那边给了我们一张 ID Token，',
      '上面写着「这个人是 alice」。凭什么信？',
      '',
      '凭签名。但「验签名」这件事在 OIDC 里比看上去麻烦得多 ——',
      '令牌自己带着一个 `alg` 字段，说明它是用哪种算法签的。',
      '按它说的去验，就等于让攻击者自己选考卷。',
      '',
      '## 要实现什么',
      '',
      '在 `src/oidc.ts` 实现 `createIdTokenVerifier(options)`，令牌是三段：',
      '',
      '```',
      'header . payload . signature',
      '```',
      '',
      '`verify(token, expectedNonce)` 通过返回 claims，任何一项不过返回 `null`。要检查：',
      '',
      '| 检查项 | 说明 |',
      '| --- | --- |',
      '| 算法 | 必须等于 `options.algorithm`，**从配置来，不从 header 来** |',
      '| 密钥 | `header.kid` 必须在 `options.keys` 里，用对应的公钥验签 |',
      '| `iss` | 必须等于我们信任的那个签发方 |',
      '| `aud` | 必须包含我们自己的 clientId |',
      '| `exp` / `iat` | 过期不收，签发时间在未来太远也不收 |',
      '| `nonce` | 必须等于我们这次登录发出去的那个，而且只能用一次 |',
      '',
      '## 怎么算过',
      '',
      '- 合法令牌验得过，返回的 claims 能直接拿去开本地会话；',
      '- **一切伪造都拦下**（门槛 `counters.forgedTokensAccepted = 0`），包括：',
      '  `alg: none` 的无签名令牌、用公钥当 HMAC 密钥签的「算法混淆」令牌、',
      '  改过载荷的令牌、用未登记密钥签的令牌；',
      '- iss / aud / exp 任何一项不对都拒绝；',
      '- **同一个 nonce 不能用第二次**（门槛 `counters.nonceReplayAccepted = 0`）。',
      '',
      '## 算法混淆是怎么回事',
      '',
      'RS256 是非对称的：私钥签、公钥验，而公钥是**公开的**。',
      'HS256 是对称的：同一个密钥签和验。',
      '',
      '现在假设你的代码这样写：「看 header.alg，是 RS256 就用公钥验签，',
      '是 HS256 就用密钥验签」，而这里的「密钥」在两条分支里取的是同一个变量。',
      '攻击者于是拿你的**公钥**当 HMAC 密钥，签一张 `alg: HS256` 的令牌 ——',
      '你用公钥去验 HMAC，完全对得上。',
      '',
      '他不需要破解任何东西，只需要你按他说的算法去验。',
      '修法只有一句话：**算法是你的配置，不是他的输入。**',
      '',
      '## 最容易写错的地方',
      '',
      '`aud` 校验写成「不为空就行」。',
      '',
      '同一个 IdP 会给很多家应用签发令牌，它们的签名都是有效的。',
      '不校验 `aud`，就意味着任何一个也接入了这个 IdP 的应用',
      '——包括攻击者自己注册的那个——都能拿它那边的令牌来登录你的系统。',
      '签名对，但那张票不是给你的。',
    ].join('\n'),
    [
      'Last stage we were the authorization server. Now the roles flip: **we are the relying party.** The user',
      'clicked "sign in with X", X handed us an ID token saying "this person is alice", and the question is why',
      'we should believe it.',
      '',
      'Because of the signature. Except that verifying a signature in OIDC is trickier than it looks — the',
      'token carries an `alg` field naming the algorithm it was signed with, and verifying by whatever it says',
      'lets the attacker choose the exam paper.',
      '',
      '## What to build',
      '',
      'Implement `createIdTokenVerifier(options)` in `src/oidc.ts`. Tokens have three segments:',
      '',
      '```',
      'header . payload . signature',
      '```',
      '',
      '`verify(token, expectedNonce)` returns the claims, or `null` if anything fails. Check:',
      '',
      '| Check | Meaning |',
      '| --- | --- |',
      '| Algorithm | Must equal `options.algorithm` — **from your config, not from the header** |',
      '| Key | `header.kid` must exist in `options.keys`; verify with that public key |',
      '| `iss` | Must equal the issuer we trust |',
      '| `aud` | Must contain our own client id |',
      '| `exp` / `iat` | Expired is refused, and so is issued-too-far-in-the-future |',
      '| `nonce` | Must equal the one we sent for this login, and it works exactly once |',
      '',
      '## What counts as passing',
      '',
      '- A legitimate token verifies and its claims are ready to open a local session;',
      '- **Every forgery is refused** (the `counters.forgedTokensAccepted = 0` gate), including: an unsigned',
      '  `alg: none` token, an algorithm-confusion token signed with the public key as an HMAC secret, a token',
      '  with a tampered payload, and a token signed by an unregistered key;',
      '- Wrong `iss`, wrong `aud` or an expired `exp` are all refused;',
      '- **A nonce works exactly once** (the `counters.nonceReplayAccepted = 0` gate).',
      '',
      '## What algorithm confusion actually is',
      '',
      'RS256 is asymmetric: the private key signs, the public key verifies, and the public key is **public**.',
      'HS256 is symmetric: one key both signs and verifies.',
      '',
      'Now suppose your code reads "look at header.alg; if RS256 verify with the public key, if HS256 verify',
      'with the secret" — and both branches happen to read the same variable. The attacker takes your **public',
      'key**, uses it as an HMAC secret, signs a token with `alg: HS256`, and your HMAC check against the public',
      'key matches perfectly.',
      '',
      'They broke nothing. They just got you to verify with the algorithm they named. The fix is one sentence:',
      '**the algorithm is your configuration, not their input.**',
      '',
      '## The easiest thing to get wrong',
      '',
      'Checking `aud` for "not empty".',
      '',
      'One IdP signs tokens for many applications, and every one of those signatures is valid. Skip the `aud`',
      'check and any application on the same IdP — including one the attacker registered — can log into your',
      'system with a token issued to them. The signature is fine; the ticket was simply not for you.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  V["verify(token, expectedNonce)"] --> S{"切得出三段？"}',
      '  S -- 切不出 --> NO["返回 null"]',
      '  S -- 切得出 --> H["解 header"]',
      '  H --> A{"header.alg 等于配置里的算法？"}',
      '  A -- 不等 --> NO',
      '  A -- 相等 --> K{"header.kid 在 JWKS 里？"}',
      '  K -- 不在 --> NO',
      '  K -- 在 --> SIG{"公钥验签通过？"}',
      '  SIG -- 不过 --> NO',
      '  SIG -- 通过 --> P["解 payload"]',
      '  P --> ISS{"iss 是我们信的那家？"}',
      '  ISS -- 不是 --> NO',
      '  ISS -- 是 --> AUD{"aud 包含我们自己？"}',
      '  AUD -- 不含 --> NO',
      '  AUD -- 包含 --> TIME{"exp / iat 在允许范围内？"}',
      '  TIME -- 不在 --> NO',
      '  TIME -- 在 --> N{"nonce 对得上且没用过？"}',
      '  N -- 否 --> NO',
      '  N -- 是 --> OK["记下 nonce，返回 claims"]',
      '```',
      '',
      '要点：这是一条**没有旁路**的链。每多一个「这种情况就跳过某一项检查」的分支，',
      '就多一条攻击者可以走的路 —— 历史上 JWT 库的漏洞几乎全长在这类分支上。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  V["verify(token, expectedNonce)"] --> S{"three segments?"}',
      '  S -- no --> NO["return null"]',
      '  S -- yes --> H["decode the header"]',
      '  H --> A{"header.alg equals the configured one?"}',
      '  A -- no --> NO',
      '  A -- yes --> K{"header.kid present in the JWKS?"}',
      '  K -- no --> NO',
      '  K -- yes --> SIG{"public key verifies the signature?"}',
      '  SIG -- no --> NO',
      '  SIG -- yes --> P["decode the payload"]',
      '  P --> ISS{"iss is the issuer we trust?"}',
      '  ISS -- no --> NO',
      '  ISS -- yes --> AUD{"aud contains us?"}',
      '  AUD -- no --> NO',
      '  AUD -- yes --> TIME{"exp / iat within tolerance?"}',
      '  TIME -- no --> NO',
      '  TIME -- yes --> N{"nonce matches and is unused?"}',
      '  N -- no --> NO',
      '  N -- yes --> OK["record the nonce, return the claims"]',
      '```',
      '',
      'The point: this chain has **no side exits**. Every "in this case skip that check" branch is another road',
      'for the attacker — historically, nearly every JWT library vulnerability grew on exactly such a branch.',
    ].join('\n')
  ),
  checklist: [
    t('算法取自配置，不取自 header', 'The algorithm comes from config, never from the header'),
    t('kid 必须在 JWKS 里', 'The kid must exist in the JWKS'),
    t('iss / aud / exp 逐项校验', 'iss, aud and exp are each checked'),
    t('nonce 对得上而且只能用一次', 'The nonce matches and is single-use'),
    t('任何一项不过都返回 null', 'Any failed check returns null'),
  ],
  pitfalls: [
    t(
      '按 `header.alg` 挑验签方式。这就是算法混淆：攻击者把 alg 改成 HS256，拿你的公钥当 HMAC 密钥签一张，你用同一个公钥去验，完全对得上。2015 年这个洞横扫了当时几乎所有 JWT 库。',
      'Selecting the verification method from `header.alg`. That is algorithm confusion: the attacker sets alg to HS256 and signs with your public key as the HMAC secret, and your check against that same public key matches. In 2015 this swept through nearly every JWT library in existence.'
    ),
    t(
      '接受 `alg: none`。它是标准里为「令牌已经在别的通道里被保护了」留的口子，而在验签这条路径上它的意思是「不用验」。任何一个能构造 HTTP 请求的人都能签出这种令牌。',
      'Accepting `alg: none`. The standard keeps it for tokens already protected by another channel; on a verification path it means "do not verify". Anyone who can compose an HTTP request can sign one of those.'
    ),
    t(
      '不校验 `aud`。同一个 IdP 给几百家应用签令牌，签名个个有效。攻击者在那个 IdP 上注册自己的应用、用自己的账号登录、拿到一张给自己应用的合法令牌，然后拿它来登录你 —— 全程没伪造任何东西。',
      'Skipping the `aud` check. One IdP signs for hundreds of applications and every signature is valid. The attacker registers their own application there, logs in as themselves, receives a perfectly legitimate token addressed to their app, and presents it to you — forging nothing at all.'
    ),
    t(
      '把 nonce 当成可选的。没有 nonce，一张被截获的 ID Token 可以被反复拿来登录；有了 nonce 而不检查「用过没有」，效果完全一样。这个字段的价值全在「一次」两个字上。',
      'Treating the nonce as optional. Without one, an intercepted ID token logs in again and again; with one that is never checked for reuse, the effect is identical. The entire value of the field is in the word "once".'
    ),
  ],
  hints: [
    t(
      '把「拿哪把公钥」和「用哪种算法」分开想：kid 决定前者，配置决定后者。header 只在选 kid 这一件事上有发言权，而选错 kid 的后果是验签失败，无害。',
      'Separate "which key" from "which algorithm": the kid picks the key, your config picks the algorithm. The header only gets a say in the first, and picking the wrong kid merely fails verification.'
    ),
    t(
      'aud 可能是字符串，也可能是字符串数组 —— 标准两种都允许。写一个小函数把两种形态归一，比在主流程里塞一个 Array.isArray 判断清楚。',
      'The `aud` claim may be a string or an array of strings; the standard allows both. A tiny helper that normalises the two reads better than an `Array.isArray` sitting in the main flow.'
    ),
  ],
  extension: t(
    [
      'CVE-2015-9235 就是这一关讲的算法混淆，当时 node-jsonwebtoken 的 `verify(token, key)`',
      '会按 header 里的 alg 决定怎么用那个 key。修法是加上 `algorithms: [...]` 参数，',
      '而这个参数至今仍然是可选的 —— 也就是说这个洞今天仍然能写出来。',
      '',
      '真实的 OIDC 还有两件这一关省掉的事：**JWKS 轮换**（公钥会定期更换，',
      '依赖方要按 kid 去签发方的 `/.well-known/jwks.json` 拉新的，还要防止',
      '「未知 kid」变成一个可以被打爆的远程调用），以及 **ID Token 与 UserInfo 的分工**',
      '（ID Token 只回答「是谁登录了」，业务属性应该去 UserInfo 拉，',
      '把一堆属性塞进 ID Token 会让它变得又大又难撤销）。',
      '',
      '还有一条经验：**ID Token 不是访问令牌**。它是给你看的身份证明，',
      '不该拿去当作访问别人接口的凭据。混用这两者是 OIDC 接入里最常见的设计错误。',
    ].join('\n'),
    [
      'CVE-2015-9235 is exactly the confusion described here: node-jsonwebtoken\'s `verify(token, key)` decided',
      'how to use the key from the header\'s alg. The fix added an `algorithms: [...]` option — which remains',
      'optional to this day, meaning the same bug is still writable in current code.',
      '',
      'Real OIDC also has two things skipped here: **JWKS rotation** (public keys change, so a relying party',
      "fetches new ones by kid from the issuer's `/.well-known/jwks.json`, and must stop an unknown kid from",
      'becoming a remotely triggerable request flood), and **the division of labour between the ID token and',
      'UserInfo** (an ID token answers "who logged in"; business attributes belong in UserInfo, since stuffing',
      'them into the token makes it large and hard to revoke).',
      '',
      'And one rule of thumb: **an ID token is not an access token.** It is proof of identity addressed to you,',
      "not a credential for calling somebody else's API. Confusing the two is the most common design mistake in",
      'OIDC integrations.',
    ].join('\n')
  ),
  focus: ['correctness', 'resilience', 'elegance'],
  lab: {},
  starterFiles: [
    file(
      'src/oidc.ts',
      code`
        import { decodeSegment, verifyRsa } from './support/crypto';
        import { now } from '@lab/env';

        /** The fields inside an ID token issued by an external IdP */
        export interface IdTokenClaims {
          iss: string;
          /** The standard permits a single string as well as an array of strings */
          aud: string | string[];
          sub: string;
          nonce: string;
          iat: number;
          exp: number;
          /** The tenant carried across from the federated identity */
          tenantId?: string;
        }

        export interface IdTokenVerifierOptions {
          /** The issuer we trust */
          issuer: string;
          /** Our own client id at their end */
          audience: string;
          /** The only algorithm accepted. Note it lives in the configuration, not in the token. */
          algorithm: string;
          /** JWKS: kid -> public key */
          keys: Record<string, string>;
          /** Clock skew allowed, in milliseconds */
          clockSkewMs: number;
        }

        export interface IdTokenVerifier {
          /** Returns the claims on success and null if any single check fails */
          verify(token: string, expectedNonce: string): IdTokenClaims | null;
        }

        export function createIdTokenVerifier(options: IdTokenVerifierOptions): IdTokenVerifier {
          // TODO: implement this
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-7.spec.ts',
      code`
        import { createIdTokenVerifier } from '../src/oidc';
        import { createRefreshService } from '../src/refresh';
        import { createSessionIssuer } from '../src/session';
        import { createStore } from '../src/support/store';
        import { encodeSegment, hmac, keyPair, signRsa } from '../src/support/crypto';
        import { now, sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const ISSUER = 'https://idp.example';
        const AUDIENCE = 'our-client-id';
        const SKEW = 5000;
        const LIFETIME = 60000;
        const NONCE = 'nonce-from-our-login-request';

        const signing = keyPair('kid-1');
        const rogue = keyPair('kid-rogue');

        function makeVerifier() {
          const keys: any = {};
          keys[signing.kid] = signing.publicKey;
          return createIdTokenVerifier({
            issuer: ISSUER,
            audience: AUDIENCE,
            algorithm: 'RS256',
            keys,
            clockSkewMs: SKEW,
          });
        }

        function claimsFor(overrides: any = {}) {
          return {
            iss: ISSUER,
            aud: AUDIENCE,
            sub: 'alice',
            nonce: NONCE,
            iat: now(),
            exp: now() + LIFETIME,
            tenantId: 'acme',
            ...overrides,
          };
        }

        /** Playing the IdP: sign an ID token with the private key */
        function mint(claims: any, header: any = { alg: 'RS256', kid: signing.kid }, key = signing.privateKey) {
          const body = encodeSegment(header) + '.' + encodeSegment(claims);
          return body + '.' + signRsa(key, body);
        }

        /** Every forged token that gets through is recorded */
        function expectForgeryRejected(verifier: any, token: string): void {
          const claims = verifier.verify(token, NONCE);
          if (claims) count('forgedTokensAccepted');
          expect(claims).toBeNull();
        }

        describe('Stage 7 · Verifying an identity someone else issued', () => {
          it('a legitimate ID token verifies', () => {
            const verifier = makeVerifier();

            const claims = verifier.verify(mint(claimsFor()), NONCE);
            expect(claims).toBeTruthy();
            expect(claims.sub).toBe('alice');
            expect(claims.tenantId).toBe('acme');
          });

          it('a verified token can open a local session directly', () => {
            const store = createStore();
            const issuer = createSessionIssuer({ secret: 'session-signing-key', ttlMs: 60000 });
            const refresh = createRefreshService(store, issuer, { ttlMs: 600000 });

            const claims = makeVerifier().verify(mint(claimsFor()), NONCE);
            const pair = refresh.start({ userId: claims.sub, tenantId: claims.tenantId });

            expect(issuer.verify(pair.accessToken).sub).toBe('alice');
          });

          it('an unsigned token with alg set to none is not accepted', () => {
            const verifier = makeVerifier();
            const body = encodeSegment({ alg: 'none' }) + '.' + encodeSegment(claimsFor());

            expectForgeryRejected(verifier, body + '.');
          });

          it('an algorithm-confusion token using the public key as an HMAC secret is not accepted', () => {
            const verifier = makeVerifier();
            const header = { alg: 'HS256', kid: signing.kid };
            const body = encodeSegment(header) + '.' + encodeSegment(claimsFor());

            // The public key is public, so an attacker signs one with it as a symmetric key
            expectForgeryRejected(verifier, body + '.' + hmac(signing.publicKey, body));
          });

          it('a token signed with an unregistered key is not accepted', () => {
            const verifier = makeVerifier();

            expectForgeryRejected(
              verifier,
              mint(claimsFor(), { alg: 'RS256', kid: rogue.kid }, rogue.privateKey)
            );
          });

          it('moving a signature onto a different payload is not accepted', () => {
            const verifier = makeVerifier();
            const original = mint(claimsFor());
            const tampered = encodeSegment({ alg: 'RS256', kid: signing.kid }) +
              '.' + encodeSegment(claimsFor({ sub: 'admin' })) +
              '.' + original.split('.')[2];

            expectForgeryRejected(verifier, tampered);
          });

          it('a wrong issuer is not accepted', () => {
            const verifier = makeVerifier();

            expectForgeryRejected(verifier, mint(claimsFor({ iss: 'https://evil.example' })));
          });

          it('an audience that is not us is not accepted', () => {
            const verifier = makeVerifier();

            // This ticket was signed by the same IdP for a different application, and the signature
            // is perfectly valid
            expectForgeryRejected(verifier, mint(claimsFor({ aud: 'someone-elses-client' })));
          });

          it('an array audience is accepted when it contains us', () => {
            const verifier = makeVerifier();

            const claims = verifier.verify(mint(claimsFor({ aud: ['someone-else', AUDIENCE] })), NONCE);
            expect(claims).toBeTruthy();
          });

          it('an expired token is not accepted', async () => {
            const verifier = makeVerifier();
            const token = mint(claimsFor());

            await sleep(LIFETIME + SKEW);
            expectForgeryRejected(verifier, token);
          });

          it('an issued-at too far in the future is not accepted', () => {
            const verifier = makeVerifier();

            expectForgeryRejected(verifier, mint(claimsFor({ iat: now() + SKEW * 10 })));
          });

          it('a mismatched nonce is not accepted', () => {
            const verifier = makeVerifier();

            const claims = verifier.verify(mint(claimsFor({ nonce: 'some-other-nonce' })), NONCE);
            if (claims) count('nonceReplayAccepted');
            expect(claims).toBeNull();
          });

          it('the same nonce cannot be used twice', () => {
            const verifier = makeVerifier();
            const token = mint(claimsFor());
            expect(verifier.verify(token, NONCE)).toBeTruthy();

            const replay = verifier.verify(token, NONCE);
            if (replay) count('nonceReplayAccepted');
            expect(replay).toBeNull();
          });

          it('a malformed token returns null rather than throwing', () => {
            const verifier = makeVerifier();

            expect(verifier.verify('', NONCE)).toBeNull();
            expect(verifier.verify('a.b', NONCE)).toBeNull();
            expect(verifier.verify('zz.zz.zz', NONCE)).toBeNull();
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.forgedTokensAccepted',
      op: 'eq',
      value: 0,
      zh: '伪造的 ID Token 一张都不接受',
      en: 'Not one forged ID token is accepted',
      dimension: 'resilience',
    }),
    gate({
      metric: 'counters.nonceReplayAccepted',
      op: 'eq',
      value: 0,
      zh: 'nonce 一次都不许用第二遍',
      en: 'A nonce is never accepted twice',
      dimension: 'resilience',
    }),
  ],
  referenceFiles: [
    file(
      'src/oidc.ts',
      code`
        import { decodeSegment, verifyRsa } from './support/crypto';
        import { now } from '@lab/env';

        export interface IdTokenClaims {
          iss: string;
          aud: string | string[];
          sub: string;
          nonce: string;
          iat: number;
          exp: number;
          tenantId?: string;
        }

        export interface IdTokenVerifierOptions {
          issuer: string;
          audience: string;
          algorithm: string;
          keys: Record<string, string>;
          clockSkewMs: number;
        }

        export interface IdTokenVerifier {
          verify(token: string, expectedNonce: string): IdTokenClaims | null;
        }

        const SEGMENTS = 3;

        interface TokenHeader {
          alg?: string;
          kid?: string;
        }

        /** aud may be a string or an array of strings; normalise it to one shape here */
        function audienceContains(aud: string | string[], expected: string): boolean {
          const list = Array.isArray(aud) ? aud : [aud];
          return list.indexOf(expected) >= 0;
        }

        export function createIdTokenVerifier(options: IdTokenVerifierOptions): IdTokenVerifier {
          /** Nonces already used. One nonce corresponds to exactly one login. */
          const spentNonces = new Set<string>();

          function publicKeyFor(header: TokenHeader): string | null {
            if (!header.kid) return null;
            const key = options.keys[header.kid];
            return typeof key === 'string' ? key : null;
          }

          function timeIsSane(claims: IdTokenClaims): boolean {
            if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') return false;
            if (now() >= claims.exp + options.clockSkewMs) return false;
            return claims.iat <= now() + options.clockSkewMs;
          }

          return {
            verify(token: string, expectedNonce: string): IdTokenClaims | null {
              const parts = String(token || '').split('.');
              if (parts.length !== SEGMENTS) return null;

              const header = decodeSegment(parts[0]) as TokenHeader | null;
              if (!header) return null;
              // The algorithm comes from our configuration. What the token claims to be does not count.
              if (header.alg !== options.algorithm) return null;

              const publicKey = publicKeyFor(header);
              if (!publicKey) return null;
              if (!verifyRsa(publicKey, parts[0] + '.' + parts[1], parts[2])) return null;

              const claims = decodeSegment(parts[1]) as IdTokenClaims | null;
              if (!claims) return null;
              if (claims.iss !== options.issuer) return null;
              if (!audienceContains(claims.aud, options.audience)) return null;
              if (!timeIsSane(claims)) return null;
              if (!expectedNonce || claims.nonce !== expectedNonce) return null;
              if (spentNonces.has(claims.nonce)) return null;

              // Record the nonce only when everything passed: a failed attempt should not consume this login
              spentNonces.add(claims.nonce);
              return claims;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '三个决定：',
      '',
      '**`header.alg` 只被用来和配置比对，从不用来做选择。** 它在代码里出现了一次，',
      '出现在一个 `!==` 的右边。这是整关唯一重要的一行 —— 一旦它变成 `switch (header.alg)`，',
      '后面写得再仔细也守不住。',
      '',
      '**`kid` 可以听令牌的，`alg` 不行。** 区别在于后果：kid 选错了，验签失败，',
      '攻击者一无所获；alg 选错了，验签方式本身被替换掉了。',
      '「哪些输入可以影响控制流」是安全代码里最值得反复问的问题。',
      '',
      '**nonce 只在成功之后记账。** 反过来写（进来就记）会让一次失败的尝试',
      '把这次登录的 nonce 消耗掉，真用户随后的正常回调反而被当成重放 ——',
      '攻击者于是有了一个零成本的拒绝服务手段。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      '`header.alg` is only ever compared against the configuration, never used to choose. It appears once in',
      'the code, on the right-hand side of a `!==`. That is the one line that matters in this stage — turn it',
      'into a `switch (header.alg)` and no amount of care downstream will hold.',
      '',
      'The token may pick the `kid`; it may not pick the `alg`. The difference is the consequence: a wrong kid',
      'fails verification and the attacker gains nothing, while a wrong alg replaces the verification method',
      'itself. "Which inputs are allowed to influence control flow" is the question worth asking repeatedly in',
      'security code.',
      '',
      'The nonce is recorded only after success. Recording it on entry lets a single failed attempt consume the',
      "login's nonce, so the real user's legitimate callback is then rejected as a replay — handing the attacker",
      'a free denial of service.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 8 关 · 角色继承与通配权限                                         */
/* ------------------------------------------------------------------ */

const stage8 = {
  id: 'rbac',
  title: t('第 8 关 · 角色继承与通配权限', 'Stage 8 · Role inheritance and wildcards'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '前七关回答的都是「你是谁」。从这一关开始换一个问题：**你能做什么**。',
      '',
      '最朴素的做法是给每个用户列一张权限清单。它在二十个用户时很好用，',
      '在两千个用户时变成灾难 —— 新加一个功能要改两千行。',
      '所以真实系统按**角色**授权，而角色之间还会继承：',
      '「主编」天然包含「编辑」，「编辑」天然包含「读者」。',
      '',
      '继承一旦允许，两个新问题立刻冒出来：**图里可能有环**，',
      '以及**同一个角色会被走到很多次**。',
      '',
      '## 要实现什么',
      '',
      '在 `src/rbac.ts` 实现 `createRbac(directory)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `permissionsOf(roles)` | 展开继承，返回去重且排序的权限列表 |',
      '| `can(roles, permission)` | 判断有没有某个权限，支持通配 |',
      '',
      '角色目录由平台注入（`RoleDirectory`，见 `src/contract.ts`），',
      '每读一个角色定义都会被计数 —— 这就是门槛量的东西。',
      '',
      '通配的规则：`*` 匹配一切；`doc:*` 匹配 `doc:` 开头的一切；',
      '反过来不成立 —— 持有 `doc:read` 的人不算持有 `doc:*`。',
      '',
      '## 怎么算过',
      '',
      '- 直接持有的、继承来的、隔了好几层继承来的权限都算数；',
      '- 菱形继承（两条路走到同一个祖先）不产生重复；',
      '- 未知角色被忽略而不是抛错，空角色列表意味着**什么都不能做**；',
      '- **图里有环也要能走完**（门槛 `counters.roleCycleHangs = 0`：',
      '  角色目录在被读了太多次之后会直接抛错并计一笔，走不完就会撞上它）；',
      '- **反复查询不重复读角色**（门槛 `counters.roleGraphVisits ≤ 12`）。',
      '',
      '## 那个 ≤ 12 是什么意思',
      '',
      '判权是**每个请求都要做一次**的操作。如果每次都从头走一遍角色图，',
      '那么权限模型设计得越细致（继承层数越多），系统就越慢 ——',
      '而这恰好和「把权限模型做好」的方向相反。',
      '',
      '门槛限制的是「读角色定义」的次数，不是「查询」的次数：',
      '同一个角色在这个解析器的生命周期里只该被读一次。',
      '',
      '## 最容易写错的地方',
      '',
      '用递归展开继承，然后在环上转到栈溢出。',
      '',
      '「角色图不会有环」听起来是个合理假设，直到某个管理员为了省事',
      '把「主编」加进了「编辑」的继承列表 —— 而「编辑」本来就在「主编」下面。',
      '环不是异常输入，是**迟早会有人配出来**的输入。',
    ].join('\n'),
    [
      'The first seven stages answered "who are you". From here the question changes: **what may you do.**',
      '',
      'The naive answer is a permission list per user. It works fine at twenty users and becomes a disaster at',
      'two thousand, where adding one feature means editing two thousand rows. So real systems grant by',
      '**role**, and roles inherit: an editor-in-chief naturally contains an editor, an editor contains a reader.',
      '',
      'The moment inheritance exists, two problems appear: **the graph may contain cycles**, and **the same',
      'role gets walked over and over.**',
      '',
      '## What to build',
      '',
      'Implement `createRbac(directory)` in `src/rbac.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `permissionsOf(roles)` | Expand inheritance and return a deduplicated, sorted list |',
      '| `can(roles, permission)` | Decide one permission, wildcards included |',
      '',
      'The role directory is injected by the platform (`RoleDirectory` in `src/contract.ts`), and every',
      'definition it reads is counted — that is what the gate measures.',
      '',
      'Wildcard rules: `*` matches everything; `doc:*` matches everything starting with `doc:`; the reverse',
      'does not hold — holding `doc:read` is not holding `doc:*`.',
      '',
      '## What counts as passing',
      '',
      '- Permissions held directly, inherited, or inherited several levels up all count;',
      '- Diamond inheritance (two paths to the same ancestor) produces no duplicates;',
      '- An unknown role is ignored rather than throwing, and an empty role list means **nothing is allowed**;',
      '- **A cyclic graph still terminates** (the `counters.roleCycleHangs = 0` gate: the directory throws and',
      '  records a hang once it has been read far too many times, which is what a non-terminating walk hits);',
      '- **Repeated queries do not re-read roles** (the `counters.roleGraphVisits ≤ 12` gate).',
      '',
      '## What that ≤ 12 is really saying',
      '',
      'Authorisation runs **on every request**. Walk the role graph from scratch each time and the more',
      'carefully the permission model is designed — the deeper the inheritance — the slower the system gets,',
      'which is exactly backwards from the incentive you want.',
      '',
      'The gate limits how many times a role definition is **read**, not how many queries you answer: within',
      "one resolver's lifetime, each role should be read once.",
      '',
      '## The easiest thing to get wrong',
      '',
      'Expanding inheritance recursively and spinning forever on a cycle.',
      '',
      '"The role graph has no cycles" sounds like a fair assumption right up until an administrator adds',
      '"editor-in-chief" to the inheritance list of "editor" — which was already underneath it. A cycle is not',
      'exotic input; it is input **somebody will eventually configure.**',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  Q["permissionsOf(roles)"] --> INIT["队列 = 传进来的角色<br/>seen = 空集合"]',
      '  INIT --> POP["弹出一个角色名"]',
      '  POP --> SEEN{"这一轮见过了？"}',
      '  SEEN -- 见过 --> POP',
      '  SEEN -- 没见过 --> MARK["放进 seen<br/>环在这里被截断"]',
      '  MARK --> CACHE{"定义缓存里有吗？"}',
      '  CACHE -- 有 --> USE["用缓存的定义"]',
      '  CACHE -- 没有 --> READ["directory.read(name)<br/>这一步会被计数"]',
      '  READ --> STORE["存进定义缓存"]',
      '  STORE --> USE',
      '  USE --> COLLECT["把它的权限收进结果集"]',
      '  COLLECT --> PUSH["把它继承的角色推进队列"]',
      '  PUSH --> POP',
      '  POP --> DONE["队列空了 → 去重排序返回"]',
      '',
      '  C["can(roles, permission)"] --> Q',
      '  Q --> MATCH["逐条按通配规则匹配"]',
      '```',
      '',
      '要点：`seen` 和定义缓存是**两层不同的东西**。前者是一次查询内的防环，',
      '后者跨查询存活、决定读了几次目录。少了前者会转死，少了后者过不了门槛。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  Q["permissionsOf(roles)"] --> INIT["queue = the given roles<br/>seen = empty set"]',
      '  INIT --> POP["pop a role name"]',
      '  POP --> SEEN{"seen in this query?"}',
      '  SEEN -- yes --> POP',
      '  SEEN -- no --> MARK["add to seen<br/>this is where cycles stop"]',
      '  MARK --> CACHE{"definition cached?"}',
      '  CACHE -- yes --> USE["use the cached definition"]',
      '  CACHE -- no --> READ["directory.read(name)<br/>this call is counted"]',
      '  READ --> STORE["put it in the definition cache"]',
      '  STORE --> USE',
      '  USE --> COLLECT["collect its permissions"]',
      '  COLLECT --> PUSH["push the roles it inherits"]',
      '  PUSH --> POP',
      '  POP --> DONE["queue empty, dedupe, sort, return"]',
      '',
      '  C["can(roles, permission)"] --> Q',
      '  Q --> MATCH["match each entry by the wildcard rules"]',
      '```',
      '',
      'The point: `seen` and the definition cache are **two different layers**. The first stops cycles within',
      'one query; the second lives across queries and decides how many reads happen. Without the first you',
      'spin; without the second you miss the gate.',
    ].join('\n')
  ),
  checklist: [
    t('继承按图遍历，不假设是树', 'Inheritance is walked as a graph, not assumed to be a tree'),
    t('环能终止', 'Cycles terminate'),
    t('角色定义跨查询缓存', 'Role definitions are cached across queries'),
    t('通配只单向匹配', 'Wildcards match in one direction only'),
    t('空角色列表等于什么都不能做', 'An empty role list allows nothing'),
  ],
  pitfalls: [
    t(
      '递归展开继承而不记 seen。菱形继承下同一个祖先会被展开多次（还能用，只是慢），有环时直接栈溢出。而环是配置出来的，不是攻击出来的 —— 它会在某个周五下午由一个善意的管理员制造出来。',
      'Recursing through inheritance without a seen set. Diamond inheritance expands the same ancestor repeatedly (merely slow), and a cycle overflows the stack. Cycles come from configuration, not attacks: a well-meaning administrator will create one on a Friday afternoon.'
    ),
    t(
      '把通配写成双向匹配，比如用 startsWith 两边都试一次。结果是持有 `doc:read` 的人被判定为持有 `doc:*` —— 一个只读用户就此获得了整个 doc 域的写权限。通配的方向就是授权的方向。',
      'Making wildcards bidirectional — trying `startsWith` both ways. Now someone holding `doc:read` is judged to hold `doc:*`, and a read-only user has just acquired write access to the entire doc namespace. The direction of the wildcard is the direction of the grant.'
    ),
    t(
      '未知角色抛异常。角色被删掉、被改名，而某个用户身上还挂着旧名字 —— 这在任何有历史的系统里都会发生。抛异常会让这个用户的每一次请求都变成 500，而正确的行为是「这个角色不给他任何权限」。',
      'Throwing on an unknown role. Roles get deleted and renamed while some user still carries the old name — inevitable in any system with a history. Throwing turns every request from that user into a 500, when the right behaviour is "that role grants nothing".'
    ),
    t(
      '把展开结果缓存在角色上，却在有环时也照缓存不误。环里的成员互相继承，谁先算完谁就少一部分权限，于是同一个查询换个顺序会得到不同结果 —— 一个只在特定调用顺序下出现的授权 bug。',
      'Caching the expanded set per role even when a cycle is involved. Members of a cycle inherit from each other, so whoever finishes first is missing part of the answer, and the same query returns different results depending on order — an authorisation bug that only appears under one call sequence.'
    ),
  ],
  hints: [
    t(
      '用广度优先加一个 seen 集合，天然防环，也不会栈溢出。队列里放角色名，seen 决定要不要展开它。',
      'Breadth-first with a seen set handles cycles naturally and cannot overflow the stack. The queue holds role names; seen decides whether to expand one.'
    ),
    t(
      '缓存要缓存**定义**（directory.read 的结果），而不是缓存展开后的权限集合。前者简单且总是正确，后者在环上会算出不完整的结果。',
      'Cache the **definition** (the result of directory.read), not the expanded permission set. The former is simple and always correct; the latter produces incomplete answers inside a cycle.'
    ),
  ],
  extension: t(
    [
      '这一关是 NIST RBAC 模型里的「层次化 RBAC」。再往上还有一层',
      '**职责分离（SoD）**：某些角色不能同时授予同一个人 ——',
      '比如「提交付款」和「审批付款」。这在金融系统里是硬性合规要求，',
      '而它没法用「权限的并集」表达，必须是一条独立的约束规则。',
      '',
      '通配权限的写法在各家云厂商那里几乎一模一样：AWS IAM 的 `s3:Get*`、',
      'Kubernetes RBAC 的 `verbs: ["*"]`、Google IAM 的 `roles/storage.*`。',
      '它们也都踩过同一个坑：通配的**边界**在哪里。',
      '`doc:*` 该不该匹配 `document:read`？如果你用的是纯前缀匹配，答案是「会」——',
      '所以真实实现都在分隔符上做文章，通配只在段边界上生效。',
      '',
      '还有一件事这一关刻意没做：**否定权限**（deny）。',
      'RBAC 里加 deny 会让「并集」这个简单模型立刻崩塌，因为顺序开始重要了。',
      '那是下一关的事。',
    ].join('\n'),
    [
      'This stage is hierarchical RBAC from the NIST model. One layer above it sits **separation of duties**:',
      'certain roles must never be granted to the same person — submitting a payment and approving one, for',
      'instance. In financial systems that is a hard compliance requirement, and it cannot be expressed as a',
      'union of permissions; it has to be an independent constraint.',
      '',
      'Wildcard syntax looks nearly identical across cloud providers: AWS IAM `s3:Get*`, Kubernetes RBAC',
      '`verbs: ["*"]`, Google IAM `roles/storage.*`. They have all hit the same question — where does a',
      'wildcard **end**? Should `doc:*` match `document:read`? With plain prefix matching it does, which is why',
      'real implementations anchor wildcards to segment boundaries.',
      '',
      'One thing deliberately left out: **deny rules.** Adding deny to RBAC collapses the simple union model,',
      'because order starts to matter. That is the next stage.',
    ].join('\n')
  ),
  focus: ['correctness', 'latency', 'elegance'],
  lab: {},
  starterFiles: [
    file(
      'src/rbac.ts',
      code`
        import type { RoleDefinition, RoleDirectory } from './contract';

        export interface PermissionResolver {
          /** Every permission these roles hold once inheritance is expanded, deduplicated and sorted */
          permissionsOf(roles: string[]): string[];
          /**
           * Whether a specific permission is held. Wildcards work one way only: doc:* covers
           * doc:read, not the reverse.
           */
          can(roles: string[], permission: string): boolean;
        }

        export function createRbac(directory: RoleDirectory): PermissionResolver {
          // TODO: implement this
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-8.spec.ts',
      code`
        import { createRbac } from '../src/rbac';
        import { count } from '@lab/metrics';

        const GRAPH: any = {
          viewer: { name: 'viewer', permissions: ['doc:read'], inherits: [] },
          editor: { name: 'editor', permissions: ['doc:write'], inherits: ['viewer'] },
          publisher: { name: 'publisher', permissions: ['doc:publish'], inherits: ['editor'] },
          auditor: { name: 'auditor', permissions: ['audit:read'], inherits: ['viewer'] },
          admin: { name: 'admin', permissions: ['*'], inherits: ['publisher', 'auditor'] },
          support: { name: 'support', permissions: ['ticket:*'], inherits: ['viewer'] },
        };

        const CYCLIC: any = {
          alpha: { name: 'alpha', permissions: ['x:1'], inherits: ['beta'] },
          beta: { name: 'beta', permissions: ['x:2'], inherits: ['gamma'] },
          gamma: { name: 'gamma', permissions: ['x:3'], inherits: ['alpha'] },
        };

        /**
         * The platform-side role directory: every definition read is recorded.
         * Reading too many means the graph was never fully walked — that is an infinite loop,
         * turned here into an observable failure.
         */
        function makeDirectory(graph: any) {
          let reads = 0;
          return {
            read(name: string) {
              count('roleGraphVisits');
              reads += 1;
              if (reads > 60) {
                count('roleCycleHangs');
                throw new Error('role graph walk never terminated');
              }
              return graph[name];
            },
          };
        }

        describe('Stage 8 · Role inheritance and wildcard permissions', () => {
          it('directly held permissions count', () => {
            const rbac = createRbac(makeDirectory(GRAPH));

            expect(rbac.can(['viewer'], 'doc:read')).toBe(true);
          });

          it('inherited permissions count', () => {
            const rbac = createRbac(makeDirectory(GRAPH));

            expect(rbac.can(['editor'], 'doc:read')).toBe(true);
            expect(rbac.can(['editor'], 'doc:write')).toBe(true);
          });

          it('permissions inherited several levels up count too', () => {
            const rbac = createRbac(makeDirectory(GRAPH));

            expect(rbac.can(['publisher'], 'doc:read')).toBe(true);
            expect(rbac.permissionsOf(['publisher'])).toEqual(['doc:publish', 'doc:read', 'doc:write']);
          });

          it('diamond inheritance produces no duplicates', () => {
            const rbac = createRbac(makeDirectory(GRAPH));

            // admin reaches viewer through both publisher and auditor
            expect(rbac.permissionsOf(['admin'])).toEqual([
              '*',
              'audit:read',
              'doc:publish',
              'doc:read',
              'doc:write',
            ]);
          });

          it('doc:* covers everything beginning with doc:', () => {
            const rbac = createRbac(makeDirectory(GRAPH));

            expect(rbac.can(['support'], 'ticket:close')).toBe(true);
            expect(rbac.can(['support'], 'ticket:read')).toBe(true);
          });

          it('a bare asterisk covers everything', () => {
            const rbac = createRbac(makeDirectory(GRAPH));

            expect(rbac.can(['admin'], 'anything:at:all')).toBe(true);
          });

          it('wildcards do not match in reverse', () => {
            const rbac = createRbac(makeDirectory(GRAPH));

            // Holding doc:read is not the same as holding the whole doc namespace
            expect(rbac.can(['viewer'], 'doc:*')).toBe(false);
            expect(rbac.can(['viewer'], 'doc:write')).toBe(false);
          });

          it('wildcards only take effect on segment boundaries', () => {
            const rbac = createRbac(makeDirectory(GRAPH));

            expect(rbac.can(['support'], 'ticketing:read')).toBe(false);
          });

          it('an unknown role is ignored rather than throwing', () => {
            const rbac = createRbac(makeDirectory(GRAPH));

            expect(rbac.permissionsOf(['ghost-role'])).toEqual([]);
            expect(rbac.can(['ghost-role', 'viewer'], 'doc:read')).toBe(true);
          });

          it('no roles means nothing is permitted', () => {
            const rbac = createRbac(makeDirectory(GRAPH));

            expect(rbac.permissionsOf([])).toEqual([]);
            expect(rbac.can([], 'doc:read')).toBe(false);
          });

          it('a graph with a cycle still gets walked to completion [gate:cycle]', () => {
            const rbac = createRbac(makeDirectory(CYCLIC));

            expect(rbac.permissionsOf(['alpha'])).toEqual(['x:1', 'x:2', 'x:3']);
            // Starting from any point on the cycle yields the same set of permissions
            expect(rbac.permissionsOf(['gamma'])).toEqual(['x:1', 'x:2', 'x:3']);
          });

          it('repeated checks do not re-read the role definitions [gate:memo]', () => {
            const rbac = createRbac(makeDirectory(GRAPH));

            expect(rbac.can(['admin'], 'doc:read')).toBe(true);
            expect(rbac.can(['admin'], 'audit:read')).toBe(true);
            expect(rbac.can(['publisher'], 'doc:write')).toBe(true);
            expect(rbac.can(['support'], 'ticket:close')).toBe(true);
            expect(rbac.permissionsOf(['admin'])).toHaveLength(5);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.roleGraphVisits',
      op: 'lte',
      value: 12,
      zh: '五次判权最多读 12 次角色定义',
      en: 'Five authorisation queries read at most twelve role definitions',
      dimension: 'latency',
      scope: 'gate:memo',
    }),
    gate({
      metric: 'counters.roleCycleHangs',
      op: 'eq',
      value: 0,
      zh: '角色图有环也不会转死',
      en: 'A cyclic role graph never spins',
      dimension: 'resilience',
    }),
  ],
  referenceFiles: [
    file(
      'src/rbac.ts',
      code`
        import type { RoleDefinition, RoleDirectory } from './contract';

        export interface PermissionResolver {
          permissionsOf(roles: string[]): string[];
          can(roles: string[], permission: string): boolean;
        }

        const ANY = '*';
        const WILDCARD_SUFFIX = ':*';

        /** Whether a granted pattern covers the permission being asked about. The direction is one-way. */
        function grants(pattern: string, permission: string): boolean {
          if (pattern === ANY) return true;
          if (pattern === permission) return true;
          if (pattern.slice(-WILDCARD_SUFFIX.length) !== WILDCARD_SUFFIX) return false;
          // Only on segment boundaries: doc:* covers doc:read but not document:read
          return permission.indexOf(pattern.slice(0, pattern.length - 1)) === 0;
        }

        export function createRbac(directory: RoleDirectory): PermissionResolver {
          /**
           * A cache of role definitions that outlives a single query.
           * It caches the **definitions**, not the expanded permissions: a definition is a fact, an
           * expansion depends on the question.
           */
          const definitions = new Map<string, RoleDefinition | undefined>();

          function definitionOf(name: string): RoleDefinition | undefined {
            if (!definitions.has(name)) definitions.set(name, directory.read(name));
            return definitions.get(name);
          }

          function expand(roles: string[]): string[] {
            const queue = roles.slice();
            const seen = new Set<string>();
            const collected = new Set<string>();

            while (queue.length > 0) {
              const name = queue.shift() as string;
              // Cycles terminate here: within one query a role is expanded at most once
              if (seen.has(name)) continue;
              seen.add(name);

              const definition = definitionOf(name);
              if (!definition) continue;
              for (const permission of definition.permissions) collected.add(permission);
              for (const parent of definition.inherits) queue.push(parent);
            }

            return Array.from(collected).sort();
          }

          return {
            permissionsOf(roles: string[]): string[] {
              return expand(roles);
            },

            can(roles: string[], permission: string): boolean {
              return expand(roles).some((pattern) => grants(pattern, permission));
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '三个决定：',
      '',
      '**广度优先 + seen，而不是递归。** 队列版本没有栈深度问题，防环只需要一个集合，',
      '而且「同一轮里不重复展开」和「跨轮不重复读」变成了两件互不干扰的事。',
      '',
      '**缓存定义，不缓存展开结果。** 这是环上唯一正确的选择：',
      '环里的角色互相继承，任何「先算完谁」的缓存都会留下一个不完整的答案，',
      '而它的错误程度取决于第一次是从哪个角色问起的 —— 这种 bug 复现不了。',
      '',
      '**`grants` 是个纯函数，单独一个。** 通配规则是这一关最容易写反的地方',
      '（谁覆盖谁），把它拎出来之后，它的三行代码就是这条规则的完整定义，',
      '而不是散落在主流程里的几个 `startsWith`。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      'Breadth-first with a seen set instead of recursion. The queue version has no stack depth to worry',
      'about, cycle protection is a single set, and "do not expand twice in one query" and "do not read twice',
      'across queries" become two independent concerns.',
      '',
      'Cache definitions, not expansions. On a cyclic graph that is the only correct choice: members of a cycle',
      'inherit from each other, so any "whoever finishes first" cache stores an incomplete answer whose',
      'wrongness depends on which role was asked about first — a bug that does not reproduce.',
      '',
      '`grants` is a separate pure function. The wildcard direction is the easiest thing here to get backwards,',
      'and pulling it out makes those three lines the complete definition of the rule rather than a couple of',
      '`startsWith` calls scattered through the main flow.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 9 关 · 条件策略                                                   */
/* ------------------------------------------------------------------ */

const stage9 = {
  id: 'abac-policy',
  title: t('第 9 关 · 条件策略与默认拒绝', 'Stage 9 · Conditional policies and default deny'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '上一关的角色回答不了这种问题：「编辑可以改文档」—— 改**谁的**文档？',
      '所有人的吗？别的租户的呢？半夜三点也可以吗？',
      '',
      '把这些答案塞进角色，角色数量就会爆炸：',
      '「本租户编辑」「本租户属主编辑」「工作时间审计员」……',
      '真实系统的做法是让权限带上**条件**：',
      '规则不再是「谁能做什么」，而是「谁在什么情况下能做什么」。',
      '',
      '## 要实现什么',
      '',
      '在 `src/abac.ts` 实现 `createPolicyEngine(rbac, policies)`。',
      '一条策略是 `{ id, effect, actions, condition? }`，`effect` 是 `allow` 或 `deny`，',
      '条件支持五类：`sameTenant`、`ownerOnly`、`roles`、`classification`、`between`。',
      '',
      '`evaluate(request)` 返回 `{ allowed, reason }`，判定顺序是：',
      '',
      '| 步骤 | 结果 |',
      '| --- | --- |',
      '| 1. RBAC 没给这个动作 | 拒绝，`reason` 为 `rbac-denied` |',
      '| 2. 有匹配的 **deny** 规则 | 拒绝，`reason` 为 `policy:<id>` |',
      '| 3. 有匹配的 **allow** 规则 | 允许，`reason` 为 `policy:<id>` |',
      '| 4. 什么都没匹配上 | 拒绝，`reason` 为 `default-deny` |',
      '',
      '## 怎么算过',
      '',
      '- 条件成立时 allow 生效，条件不成立时那条规则**当作不存在**；',
      '- **deny 永远赢**，哪怕同时有一条更「具体」的 allow 匹配上',
      '  （门槛 `counters.denyOverridden = 0`）；',
      '- **没有规则匹配就是拒绝**，不是放行',
      '  （门槛 `counters.implicitAllows = 0`）；',
      '- ABAC 只能**收窄** RBAC 给出的权限，不能扩大：',
      '  角色里没有的动作，写多少条 allow 也放不出去；',
      '- `reason` 要指出是哪条规则做的决定 —— 出事之后这一行就是全部线索。',
      '',
      '## 为什么 deny 必须优先',
      '',
      '因为 allow 是「有人记得加」，deny 是「有人特意要拦」。',
      '',
      '一条 deny 规则的存在，说明有人明确判断过「这件事不能做」；',
      '而一条 allow 规则很可能只是当初为了让某个功能跑起来顺手加的。',
      '让后者覆盖前者，等于让「顺手」压过「特意」。',
      '',
      '更实际的理由是：deny 优先让规则集**可推理**。',
      '你可以指着一条 deny 说「这件事在任何情况下都不会发生」，',
      '而不需要把另外三百条 allow 全看一遍才敢下这个结论。',
      '',
      '## 最容易写错的地方',
      '',
      '「没匹配上就放行」。',
      '',
      '它通常不是被写出来的，而是被漏出来的：一路 `if` 判下来，',
      '最后一行忘了写 `return deny`，函数返回 `undefined`，',
      '而调用方一个 `if (!decision.allowed)` 就把它当成了允许。',
      '默认拒绝必须是**显式的最后一行**。',
    ].join('\n'),
    [
      'Roles from the last stage cannot answer this: "an editor may modify documents" — **whose** documents?',
      "Everyone's? Another tenant's? At three in the morning?",
      '',
      'Push those answers into roles and the role count explodes: "same-tenant editor", "same-tenant owner',
      'editor", "business-hours auditor"… Real systems attach **conditions** to permissions instead, so a rule',
      'stops being "who may do what" and becomes "who may do what, under which circumstances".',
      '',
      '## What to build',
      '',
      'Implement `createPolicyEngine(rbac, policies)` in `src/abac.ts`. A policy is',
      '`{ id, effect, actions, condition? }` where `effect` is `allow` or `deny`, and conditions cover',
      '`sameTenant`, `ownerOnly`, `roles`, `classification` and `between`.',
      '',
      '`evaluate(request)` returns `{ allowed, reason }`, decided in this order:',
      '',
      '| Step | Result |',
      '| --- | --- |',
      '| 1. RBAC does not grant the action | Deny, `reason` is `rbac-denied` |',
      '| 2. A matching **deny** policy exists | Deny, `reason` is `policy:<id>` |',
      '| 3. A matching **allow** policy exists | Allow, `reason` is `policy:<id>` |',
      '| 4. Nothing matched | Deny, `reason` is `default-deny` |',
      '',
      '## What counts as passing',
      '',
      '- An allow applies when its condition holds; when it does not, the policy **is not there**;',
      '- **Deny always wins**, even against a more specific allow that also matched',
      '  (the `counters.denyOverridden = 0` gate);',
      '- **No match means refuse**, never admit (the `counters.implicitAllows = 0` gate);',
      '- ABAC can only **narrow** what RBAC granted, never widen it: no number of allow policies hands out an',
      '  action the roles do not carry;',
      '- `reason` names the policy that decided — after an incident, that string is the entire trail.',
      '',
      '## Why deny has to win',
      '',
      'Because an allow is "somebody remembered to add it" and a deny is "somebody deliberately blocked it".',
      '',
      'The existence of a deny rule means a person judged that this must not happen. An allow rule was quite',
      'possibly added to make one feature work. Letting the second override the first lets convenience outrank',
      'intent.',
      '',
      'The practical reason is that deny-wins makes the rule set **reasonable about**: you can point at one',
      'deny and say "this never happens under any circumstances" without reading the other three hundred',
      'allows first.',
      '',
      '## The easiest thing to get wrong',
      '',
      '"Nothing matched, so let it through."',
      '',
      'It is rarely written on purpose; it leaks out. A chain of `if`s, a missing `return deny` on the last',
      'line, the function returns `undefined`, and a caller writing `if (!decision.allowed)` reads that as',
      'permission. Default deny has to be an **explicit last line**.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  E["evaluate(request)"] --> R{"rbac.can(roles, action)？"}',
      '  R -- 不能 --> D1["拒绝<br/>reason = rbac-denied"]',
      '  R -- 能 --> M["筛出匹配的策略<br/>动作匹配 且 条件成立"]',
      '  M --> HD{"里面有 deny 吗？"}',
      '  HD -- 有 --> D2["拒绝<br/>reason = 那条 deny 的 id"]',
      '  HD -- 没有 --> HA{"里面有 allow 吗？"}',
      '  HA -- 有 --> A["允许<br/>reason = 那条 allow 的 id"]',
      '  HA -- 没有 --> D3["拒绝<br/>reason = default-deny"]',
      '',
      '  M --> C["条件逐项检查"]',
      '  C --> C1["sameTenant：资源与请求者同租户"]',
      '  C1 --> C2["ownerOnly：资源属主就是请求者"]',
      '  C2 --> C3["roles：请求者带着其中某个角色"]',
      '  C3 --> C4["classification：资源分级在允许集合里"]',
      '  C4 --> C5["between：请求时刻落在窗口内"]',
      '```',
      '',
      '要点：这张图有**三个出口都是拒绝**，只有一个是允许。',
      '如果你画出来的图里拒绝只有一两个出口，多半是漏了默认拒绝那一条。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  E["evaluate(request)"] --> R{"rbac.can(roles, action)?"}',
      '  R -- no --> D1["deny<br/>reason = rbac-denied"]',
      '  R -- yes --> M["select matching policies<br/>action matches and condition holds"]',
      '  M --> HD{"any deny among them?"}',
      '  HD -- yes --> D2["deny<br/>reason = that policy id"]',
      '  HD -- no --> HA{"any allow among them?"}',
      '  HA -- yes --> A["allow<br/>reason = that policy id"]',
      '  HA -- no --> D3["deny<br/>reason = default-deny"]',
      '',
      '  M --> C["conditions, one by one"]',
      '  C --> C1["sameTenant: resource shares the tenant"]',
      '  C1 --> C2["ownerOnly: the requester owns it"]',
      '  C2 --> C3["roles: the requester carries one of them"]',
      '  C3 --> C4["classification: the level is in the set"]',
      '  C4 --> C5["between: the instant falls inside the window"]',
      '```',
      '',
      'The point: **three exits deny and only one allows.** If your diagram has one or two denying exits, the',
      'missing one is almost certainly the default.',
    ].join('\n')
  ),
  checklist: [
    t('deny 优先于 allow', 'Deny outranks allow'),
    t('没匹配上就是拒绝', 'No match means refuse'),
    t('条件不成立时规则视为不存在', 'A policy whose condition fails does not exist'),
    t('ABAC 只能收窄 RBAC', 'ABAC only narrows what RBAC granted'),
    t('reason 指出是哪条规则决定的', 'reason names the deciding policy'),
  ],
  pitfalls: [
    t(
      '按「最具体的规则赢」来判定。它听起来更聪明，代价是「具体」需要定义，而任何定义都会有争议：条件多的更具体？动作不带通配的更具体？规则集一旦大起来，没有人能预测某个请求会命中哪条。deny 优先的规则丑，但它可推理。',
      'Deciding by "the most specific rule wins". It sounds smarter and requires defining specific, and every definition is arguable: more conditions? a non-wildcard action? Once the rule set grows, nobody can predict which policy a request hits. Deny-wins is uglier and reasonable about.'
    ),
    t(
      '在 evaluate 里对条件求值时抛异常（比如资源没有 classification 字段就崩）。判权路径上的异常通常被上层 catch 成 500，而 500 在很多前端里会触发重试 —— 一个格式不对的资源于是变成了一串失败请求，而不是一次干脆的拒绝。',
      'Throwing while evaluating a condition — a resource without a `classification` field, say. Exceptions on the authorisation path usually surface as a 500, and many front ends retry a 500, so one malformed resource becomes a burst of failing requests instead of one clean refusal.'
    ),
    t(
      '让 allow 规则绕过 RBAC。「这条策略明确写了 allow，那就放行」听起来合理，但它意味着任何一条写错的策略都能授予任意权限。两层的关系是**收窄**：RBAC 决定上限，ABAC 在上限之内挑。',
      'Letting an allow policy bypass RBAC. "The policy explicitly says allow" sounds reasonable and means any mistyped policy can grant anything. The two layers compose by **narrowing**: RBAC sets the ceiling, ABAC picks beneath it.'
    ),
    t(
      '把时间条件写成「现在几点」而不是从请求里取。判权函数一旦自己去读时钟，它就不再是纯函数：同一个请求在不同时刻返回不同结果，测不了，也没法在审计时重放。时间是请求的一部分。',
      'Reading the clock inside the policy engine instead of taking the instant from the request. The function stops being pure: the same request returns different answers at different moments, which cannot be tested and cannot be replayed during an audit. Time is part of the request.'
    ),
  ],
  hints: [
    t(
      '先把「这条规则适用吗」和「它说 allow 还是 deny」分开。前者是动作匹配加条件判断，后者只是读一个字段 —— 混在一起写，deny 优先就很容易变成「谁在数组里靠前谁赢」。',
      'Separate "does this policy apply" from "what does it say". The first is action matching plus conditions; the second is reading a field. Mixed together, deny-wins quietly turns into "whichever comes first in the array".'
    ),
    t(
      '条件对象里每一项都是可选的：没写就等于不限制。写成「没写 → 这一项通过」，五个条件就是五个 `!condition.x || 检查`。',
      'Every field of a condition is optional, and absent means unconstrained. Write it as "absent passes" and five conditions become five `!condition.x || check` expressions.'
    ),
  ],
  extension: t(
    [
      'AWS IAM 的判定顺序就是这一关：显式 Deny > 显式 Allow > 默认 Deny。',
      '它的策略语言里还有一层这里没做的东西 —— **策略的来源**：',
      '身份策略、资源策略、权限边界、SCP，四种来源各自判一遍再取交集，',
      '于是「为什么这个请求被拒了」在 AWS 上是一个需要专门工具（IAM Policy Simulator）',
      '才能回答的问题。',
      '',
      'XACML 是这套模型的学院派版本，它把「多个规则冲突时怎么办」抽象成了',
      '**组合算法**（combining algorithm）：deny-overrides、permit-overrides、',
      'first-applicable、only-one-applicable。这一关用的是 deny-overrides，',
      '也是绝大多数生产系统的选择。',
      '',
      '实践里最容易被低估的是 `reason` 这个字段。判权系统上线之后，',
      '收到最多的问题不是「为什么放行了」，而是「为什么拒绝了」——',
      '而在一个没有 reason 的系统里，回答这个问题需要把整个规则集重跑一遍。',
    ].join('\n'),
    [
      "AWS IAM's evaluation order is this stage: explicit deny beats explicit allow beats default deny. Its",
      'policy language adds a layer this stage skips — **where the policy came from**: identity policies,',
      'resource policies, permissions boundaries and SCPs are each evaluated and intersected, which is why',
      '"why was this request denied" on AWS requires a dedicated tool (the IAM Policy Simulator) to answer.',
      '',
      'XACML is the academic version of the same model, abstracting "what happens when rules conflict" into a',
      '**combining algorithm**: deny-overrides, permit-overrides, first-applicable, only-one-applicable. This',
      'stage uses deny-overrides, as do the overwhelming majority of production systems.',
      '',
      'The most underrated field in practice is `reason`. Once an authorisation system ships, the common',
      'question is not "why was this allowed" but "why was this denied" — and in a system without a reason,',
      'answering it means re-running the entire rule set by hand.',
    ].join('\n')
  ),
  focus: ['correctness', 'encapsulation', 'elegance'],
  lab: {},
  starterFiles: [
    file(
      'src/abac.ts',
      code`
        import type { PermissionResolver } from './rbac';

        export interface AccessSubject {
          userId: string;
          tenantId: string;
          roles: string[];
        }

        export interface AccessResource {
          id: string;
          tenantId: string;
          /** Who owns this resource */
          ownerId: string;
          /** Resource classification, e.g. public / internal / secret */
          classification?: string;
        }

        export interface AccessRequest {
          subject: AccessSubject;
          /** For example doc:read */
          action: string;
          resource: AccessResource;
          /**
           * When the request happened. Time is part of the request; do not read the clock inside
           * the engine.
           */
          atMs: number;
        }

        export interface PolicyCondition {
          /** The resource must be in the same tenant as the requester */
          sameTenant?: boolean;
          /** The resource owner must be the requester themselves */
          ownerOnly?: boolean;
          /** The requester must hold at least one of these roles */
          roles?: string[];
          /** The resource classification must be in this set */
          classification?: string[];
          /** Only in effect within this time window, start inclusive and end exclusive */
          between?: { fromMs: number; toMs: number };
        }

        export interface Policy {
          id: string;
          effect: 'allow' | 'deny';
          /** Which actions this rule governs; wildcards such as doc:* are supported */
          actions: string[];
          /** Omitted means unconditional */
          condition?: PolicyCondition;
        }

        export interface PolicyDecision {
          allowed: boolean;
          /** policy:<id> / rbac-denied / default-deny */
          reason: string;
        }

        export interface PolicyEngine {
          evaluate(request: AccessRequest): PolicyDecision;
        }

        export function createPolicyEngine(rbac: PermissionResolver, policies: Policy[]): PolicyEngine {
          // TODO: implement this
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-9.spec.ts',
      code`
        import { createPolicyEngine } from '../src/abac';
        import { createRbac } from '../src/rbac';
        import { count } from '@lab/metrics';

        const GRAPH: any = {
          viewer: { name: 'viewer', permissions: ['doc:read'], inherits: [] },
          editor: { name: 'editor', permissions: ['doc:write', 'doc:publish'], inherits: ['viewer'] },
          auditor: { name: 'auditor', permissions: ['audit:read'], inherits: ['viewer'] },
        };

        const POLICIES: any[] = [
          {
            id: 'own-docs',
            effect: 'allow',
            actions: ['doc:*'],
            condition: { sameTenant: true, ownerOnly: true },
          },
          {
            id: 'team-read',
            effect: 'allow',
            actions: ['doc:read'],
            condition: { sameTenant: true },
          },
          {
            id: 'no-secret',
            effect: 'deny',
            actions: ['doc:*'],
            condition: { classification: ['secret'] },
          },
          {
            id: 'office-hours-audit',
            effect: 'allow',
            actions: ['audit:read'],
            condition: { roles: ['auditor'], between: { fromMs: 1000, toMs: 5000 } },
          },
        ];

        function makeEngine(policies: any[] = POLICIES) {
          const directory = { read: (name: string) => GRAPH[name] };
          return createPolicyEngine(createRbac(directory), policies);
        }

        function request(overrides: any = {}) {
          return {
            subject: { userId: 'alice', tenantId: 'acme', roles: ['editor'] },
            action: 'doc:read',
            resource: { id: 'doc-1', tenantId: 'acme', ownerId: 'alice', classification: 'internal' },
            atMs: 2000,
            ...overrides,
          };
        }

        /** Getting through despite matching a deny — that is what the gate counts */
        function expectDenyWins(engine: any, input: any, policyId: string): void {
          const decision = engine.evaluate(input);
          if (decision.allowed) count('denyOverridden');
          expect(decision.allowed).toBe(false);
          expect(decision.reason).toBe('policy:' + policyId);
        }

        /** Getting through without matching a single rule — that is default-allow, and the other gate */
        function expectDefaultDeny(engine: any, input: any): void {
          const decision = engine.evaluate(input);
          if (decision.allowed) count('implicitAllows');
          expect(decision.allowed).toBe(false);
          expect(decision.reason).toBe('default-deny');
        }

        describe('Stage 9 · Conditional policies and default deny', () => {
          it('allow takes effect when the condition holds, and names the rule', () => {
            const engine = makeEngine();

            const decision = engine.evaluate(request({ action: 'doc:write' }));
            expect(decision.allowed).toBe(true);
            expect(decision.reason).toBe('policy:own-docs');
          });

          it("someone else's document in the same tenant can be read", () => {
            const engine = makeEngine();

            const decision = engine.evaluate(request({
              resource: { id: 'doc-2', tenantId: 'acme', ownerId: 'bob', classification: 'internal' },
            }));
            expect(decision.allowed).toBe(true);
            expect(decision.reason).toBe('policy:team-read');
          });

          it("someone else's document in the same tenant cannot be written", () => {
            const engine = makeEngine();

            // own-docs does not match because of ownerOnly, and team-read only governs doc:read
            expectDefaultDeny(engine, request({
              action: 'doc:write',
              resource: { id: 'doc-2', tenantId: 'acme', ownerId: 'bob', classification: 'internal' },
            }));
          });

          it('cross-tenant access is always denied', () => {
            const engine = makeEngine();

            expectDefaultDeny(engine, request({
              resource: { id: 'doc-3', tenantId: 'globex', ownerId: 'alice', classification: 'internal' },
            }));
          });

          it('a deny rule overrides an allow that matches at the same time', () => {
            const engine = makeEngine();

            // It is their own document (own-docs matches), but it is secret
            expectDenyWins(engine, request({
              action: 'doc:write',
              resource: { id: 'doc-4', tenantId: 'acme', ownerId: 'alice', classification: 'secret' },
            }), 'no-secret');
          });

          it('the order of deny rules does not change the outcome', () => {
            const reordered = [POLICIES[2], POLICIES[0], POLICIES[1], POLICIES[3]];
            const engine = makeEngine(reordered);

            expectDenyWins(engine, request({
              resource: { id: 'doc-4', tenantId: 'acme', ownerId: 'alice', classification: 'secret' },
            }), 'no-secret');
          });

          it('allowed inside the time window, denied outside it', () => {
            const engine = makeEngine();
            const auditing = {
              subject: { userId: 'carol', tenantId: 'acme', roles: ['auditor'] },
              action: 'audit:read',
              resource: { id: 'log-1', tenantId: 'acme', ownerId: 'system', classification: 'internal' },
            };

            expect(engine.evaluate(request({ ...auditing, atMs: 2000 })).allowed).toBe(true);
            expectDefaultDeny(engine, request({ ...auditing, atMs: 5000 }));
            expectDefaultDeny(engine, request({ ...auditing, atMs: 999 }));
          });

          it('a rule whose role condition is unmet is treated as absent', () => {
            // inspector holds the audit:read permission, but it is not auditor
            const graph: any = {
              inspector: { name: 'inspector', permissions: ['audit:read'], inherits: [] },
            };
            const engine = createPolicyEngine(
              createRbac({ read: (name: string) => graph[name] }),
              POLICIES
            );

            expectDefaultDeny(engine, request({
              subject: { userId: 'dave', tenantId: 'acme', roles: ['inspector'] },
              action: 'audit:read',
              resource: { id: 'log-1', tenantId: 'acme', ownerId: 'system', classification: 'internal' },
            }));
          });

          it('however permissive the policy, an action the roles never granted does not get through', () => {
            const engine = makeEngine();

            const decision = engine.evaluate(request({
              subject: { userId: 'alice', tenantId: 'acme', roles: ['viewer'] },
              action: 'doc:write',
            }));
            if (decision.allowed) count('implicitAllows');
            expect(decision.allowed).toBe(false);
            expect(decision.reason).toBe('rbac-denied');
          });

          it('an action wildcard matches', () => {
            const engine = makeEngine();

            const decision = engine.evaluate(request({ action: 'doc:publish' }));
            expect(decision.allowed).toBe(true);
            expect(decision.reason).toBe('policy:own-docs');
          });

          it('with no policies at all everything is denied', () => {
            const engine = makeEngine([]);

            expectDefaultDeny(engine, request());
          });

          it('a resource with no classification field does not crash', () => {
            const engine = makeEngine();

            const decision = engine.evaluate(request({
              resource: { id: 'doc-5', tenantId: 'acme', ownerId: 'alice' },
            }));
            expect(decision.allowed).toBe(true);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.denyOverridden',
      op: 'eq',
      value: 0,
      zh: 'deny 规则一次都没有被 allow 盖过',
      en: 'No deny policy is ever overridden by an allow',
      dimension: 'correctness',
    }),
    gate({
      metric: 'counters.implicitAllows',
      op: 'eq',
      value: 0,
      zh: '没有一次「没匹配上却放行」',
      en: 'Nothing is ever admitted without a matching policy',
      dimension: 'resilience',
    }),
  ],
  referenceFiles: [
    file(
      'src/abac.ts',
      code`
        import type { PermissionResolver } from './rbac';

        export interface AccessSubject {
          userId: string;
          tenantId: string;
          roles: string[];
        }

        export interface AccessResource {
          id: string;
          tenantId: string;
          ownerId: string;
          classification?: string;
        }

        export interface AccessRequest {
          subject: AccessSubject;
          action: string;
          resource: AccessResource;
          atMs: number;
        }

        export interface PolicyCondition {
          sameTenant?: boolean;
          ownerOnly?: boolean;
          roles?: string[];
          classification?: string[];
          between?: { fromMs: number; toMs: number };
        }

        export interface Policy {
          id: string;
          effect: 'allow' | 'deny';
          actions: string[];
          condition?: PolicyCondition;
        }

        export interface PolicyDecision {
          allowed: boolean;
          reason: string;
        }

        export interface PolicyEngine {
          evaluate(request: AccessRequest): PolicyDecision;
        }

        const ANY = '*';
        const WILDCARD_SUFFIX = ':*';

        /**
         * Action matching. The rule is the same one as the permission wildcard in stage 8 — in real code
         * the two should share an implementation; they are written twice here so each stage reads on its own.
         */
        function covers(pattern: string, action: string): boolean {
          if (pattern === ANY || pattern === action) return true;
          if (pattern.slice(-WILDCARD_SUFFIX.length) !== WILDCARD_SUFFIX) return false;
          return action.indexOf(pattern.slice(0, pattern.length - 1)) === 0;
        }

        function withinWindow(window: { fromMs: number; toMs: number }, atMs: number): boolean {
          return atMs >= window.fromMs && atMs < window.toMs;
        }

        /** Every field in a condition is optional: omitting one means no restriction */
        function holds(condition: PolicyCondition | undefined, request: AccessRequest): boolean {
          if (!condition) return true;
          const subject = request.subject;
          const resource = request.resource;

          return [
            !condition.sameTenant || resource.tenantId === subject.tenantId,
            !condition.ownerOnly || resource.ownerId === subject.userId,
            !condition.roles || condition.roles.some((role) => subject.roles.indexOf(role) >= 0),
            !condition.classification ||
              condition.classification.indexOf(resource.classification || '') >= 0,
            !condition.between || withinWindow(condition.between, request.atMs),
          ].every(Boolean);
        }

        export function createPolicyEngine(rbac: PermissionResolver, policies: Policy[]): PolicyEngine {
          function applicable(request: AccessRequest): Policy[] {
            return policies.filter(
              (policy) =>
                policy.actions.some((pattern) => covers(pattern, request.action)) &&
                holds(policy.condition, request)
            );
          }

          function firstWith(matched: Policy[], effect: string): Policy | undefined {
            return matched.filter((policy) => policy.effect === effect)[0];
          }

          return {
            evaluate(request: AccessRequest): PolicyDecision {
              // Roles set the ceiling; the policy only picks from below it
              if (!rbac.can(request.subject.roles, request.action)) {
                return { allowed: false, reason: 'rbac-denied' };
              }

              const matched = applicable(request);

              // deny is checked first, and order does not matter: one match is enough
              const denied = firstWith(matched, 'deny');
              if (denied) return { allowed: false, reason: 'policy:' + denied.id };

              const allowed = firstWith(matched, 'allow');
              if (allowed) return { allowed: true, reason: 'policy:' + allowed.id };

              // An explicit last line: no match means not permitted
              return { allowed: false, reason: 'default-deny' };
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '三个决定：',
      '',
      '**先筛出「适用的规则」，再看 effect。** 两步分开之后，deny 优先就是',
      '「在同一个集合里先找 deny」，而不是「遍历时遇到 deny 就 return」——',
      '后者读起来一样，但它的结果依赖数组顺序，而顺序是配置文件写出来的。',
      '',
      '**条件写成一个「全部为真」的数组。** 每一项都是',
      '「没配置这项 或者 这项通过」，五个条件就是五行对称的表达式。',
      '换成五个 `if (...) return false`，圈复杂度和阅读成本都会跟着涨，',
      '而且很容易在中间某一行忘掉取反。',
      '',
      '**`evaluate` 的最后一行是 `return deny`。** 它不在任何 `if` 里面 ——',
      '这是「默认拒绝」在代码层面的样子。任何时候看到判权函数以',
      '「最后一个 if」结尾，都值得停下来问一句：不满足的时候返回的是什么？',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      'Select the applicable policies first, then look at the effect. With the two steps separated, deny-wins',
      'becomes "find a deny inside this set" rather than "return as soon as a deny is encountered while',
      'iterating". The second reads the same and depends on array order — order that comes out of a config file.',
      '',
      'Conditions are an array that must be all true. Each entry is "this constraint is absent, or it passes",',
      'so five conditions become five symmetric lines. Five `if (…) return false` statements raise both the',
      'cyclomatic complexity and the chance of forgetting one negation in the middle.',
      '',
      'The last line of `evaluate` is `return deny`, and it is not inside any `if`. That is what default-deny',
      'looks like in code. Whenever an authorisation function ends with its last `if`, it is worth stopping to',
      'ask what it returns when that condition is false.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 10 关 · 权限缓存与失效                                            */
/* ------------------------------------------------------------------ */

const stage10 = {
  id: 'permission-cache',
  title: t('第 10 关 · 权限缓存与失效', 'Stage 10 · Caching decisions, and invalidating them'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '前两关合起来是一次完整的判权：走一遍角色图，再过一遍策略集。',
      '它每个请求都要做一次，而同一个用户在几秒钟内往往要问几十次同样的问题。',
      '',
      '所以要缓存。而缓存判权结果有一个别的缓存没有的性质：',
      '**缓存错了不是慢，是越权**。撤掉的权限如果还在缓存里，',
      '那个人就还能继续做他已经不该做的事。',
      '',
      '这一关的两个门槛正好是一对相反的力：',
      '一个逼你少求值，一个逼你别把旧答案留太久。',
      '',
      '## 要实现什么',
      '',
      '在 `src/permissionCache.ts` 实现 `createPermissionCache(engine, options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `evaluate(request)` | 命中就直接返回，未命中才问底层引擎 |',
      '| `invalidateSubject(userId)` | 这个用户的角色或策略变了 |',
      '| `invalidateResource(resourceId)` | 这份资源变了（换属主、改分级） |',
      '| `invalidateAll()` | 策略集本身换了 |',
      '| `stats()` | 命中与未命中次数 |',
      '',
      '`options.ttlMs` 是一条缓存的存活时长。',
      '',
      '## 怎么算过',
      '',
      '- 同一个「租户 + 用户 + 动作 + 资源」只求值一次',
      '  （门槛 `counters.policyEvals ≤ 3`：12 次查询里只有 3 个不同的组合）；',
      '- **撤权之后立刻生效**：`invalidateSubject` 之后不能再返回旧的允许',
      '  （门槛 `counters.staleAllows = 0`）；',
      '- 用户不同、动作不同、资源不同、租户不同，都不能共用同一条缓存；',
      '- TTL 到期之后重新求值；',
      '- **拒绝的结果也要缓存** —— 否则被拒的流量（往往正是攻击流量）',
      '  会直接打在判权引擎上；',
      '- 三种失效各管各的：清用户不该顺手把别人的清掉。',
      '',
      '## 这两个门槛为什么是一对',
      '',
      '只看 `policyEvals ≤ 3`，最优解是「算一次，永远不失效」——',
      '而那样的系统里，一个被开除的员工的权限会一直有效到进程重启。',
      '',
      '只看 `staleAllows = 0`，最优解是「根本不缓存」——',
      '判权于是重新变成每个请求都要走一遍角色图加策略集。',
      '',
      '两个一起看，答案只剩下一种形状：**缓存，但要有明确的失效路径**。',
      'TTL 负责兜底（就算你忘了调 invalidate，最多错 ttlMs），',
      '显式失效负责及时（权限一变就立刻生效）。缺哪一半都不行。',
      '',
      '## 最容易写错的地方',
      '',
      '缓存键漏掉一个维度。',
      '',
      '只用 `userId + action` 当键，两份不同的文档就共用了一条缓存 ——',
      '一个人只要能读自己的那份，就能读同一动作下的**所有**文档。',
      '这类 bug 的可怕之处在于：它不会让任何测试变红，',
      '只会让某些请求返回「本来也该有的答案」，直到某天不该有的那个也返回了。',
    ].join('\n'),
    [
      'The last two stages together are one full authorisation: walk the role graph, then run the policy set.',
      'It happens on every request, and the same user usually asks the same question dozens of times within a',
      'few seconds.',
      '',
      'So you cache it. And caching authorisation decisions has a property other caches do not: **a wrong',
      'entry is not slowness, it is privilege.** A revoked permission still sitting in the cache means that',
      'person can still do what they are no longer allowed to do.',
      '',
      "This stage's two gates are precisely opposing forces: one pushes you to evaluate less, the other pushes",
      'you not to keep old answers around.',
      '',
      '## What to build',
      '',
      'Implement `createPermissionCache(engine, options)` in `src/permissionCache.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `evaluate(request)` | Return the hit; only ask the engine on a miss |',
      '| `invalidateSubject(userId)` | This user\'s roles or policies changed |',
      '| `invalidateResource(resourceId)` | This resource changed (owner, classification) |',
      '| `invalidateAll()` | The policy set itself changed |',
      '| `stats()` | Hits and misses |',
      '',
      '`options.ttlMs` is how long one entry lives.',
      '',
      '## What counts as passing',
      '',
      '- One evaluation per distinct "tenant + user + action + resource"',
      '  (the `counters.policyEvals ≤ 3` gate: twelve queries covering three distinct combinations);',
      '- **Revocation takes effect immediately**: after `invalidateSubject`, no stale allow comes back',
      '  (the `counters.staleAllows = 0` gate);',
      '- A different user, action, resource or tenant never shares an entry;',
      '- Entries are re-evaluated after the TTL;',
      '- **Denials are cached too** — otherwise refused traffic, which is often the attack traffic, lands',
      '  directly on the policy engine;',
      '- The three invalidations stay in their lanes: clearing one user must not clear anybody else.',
      '',
      '## Why the two gates are a pair',
      '',
      'Optimise only for `policyEvals ≤ 3` and the best answer is "evaluate once, never invalidate" — a system',
      "where a dismissed employee's access survives until the process restarts.",
      '',
      'Optimise only for `staleAllows = 0` and the best answer is "do not cache", which puts the role graph and',
      'the policy set back on every request.',
      '',
      'Together they leave one shape: **cache, with an explicit invalidation path.** The TTL is the backstop —',
      'forget to invalidate and you are wrong for at most ttlMs — and explicit invalidation is the timeliness.',
      'Neither half works alone.',
      '',
      '## The easiest thing to get wrong',
      '',
      'Leaving a dimension out of the cache key.',
      '',
      'Key on `userId + action` alone and two different documents share one entry, so anyone who may read',
      'their own may read **every** document under that action. What makes this class of bug frightening is',
      'that it turns no test red: it keeps returning answers that were correct anyway, until one day it returns',
      'one that was not.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**读路径** —— 命中就走，未命中才问引擎',
      '',
      '```mermaid',
      'flowchart TD',
      '  EV["evaluate(request)"] --> KEY["键 = 租户 + 用户 + 动作 + 资源<br/>时间不进键"]',
      '  KEY --> HIT{"缓存里有且没过期？"}',
      '  HIT -- 有 --> H["hits 加一<br/>直接返回那个决定"]',
      '  HIT -- 没有 --> M["misses 加一"]',
      '  M --> CALL["engine.evaluate(request)"]',
      '  CALL --> SAVE["存进缓存<br/>连同 expiresAt / userId / resourceId"]',
      '  SAVE --> RET["返回决定（拒绝也一样缓存）"]',
      '```',
      '',
      '**失效路径** —— 三种粒度，各管各的',
      '',
      '```mermaid',
      'flowchart TD',
      '  IS["invalidateSubject(userId)"] --> DROP1["删掉 userId 相同的条目"]',
      '  IR["invalidateResource(id)"] --> DROP2["删掉 resourceId 相同的条目"]',
      '  IA["invalidateAll()"] --> DROP3["整个清空"]',
      '```',
      '',
      '要点：条目里除了「决定」，还存着 `userId` 和 `resourceId`。',
      '它们不是给读路径用的 —— 键里已经有了 —— 而是给失效路径用的：',
      '没有它们，`invalidateSubject` 就只能靠拆字符串或者全清。',
    ].join('\n'),
    [
      '**The read path** — a hit returns, a miss asks the engine',
      '',
      '```mermaid',
      'flowchart TD',
      '  EV["evaluate(request)"] --> KEY["key = tenant + user + action + resource<br/>time is not in the key"]',
      '  KEY --> HIT{"present and fresh?"}',
      '  HIT -- yes --> H["hits + 1<br/>return the stored decision"]',
      '  HIT -- no --> M["misses + 1"]',
      '  M --> CALL["engine.evaluate(request)"]',
      '  CALL --> SAVE["store it<br/>with expiresAt / userId / resourceId"]',
      '  SAVE --> RET["return the decision (denials cached too)"]',
      '```',
      '',
      '**The invalidation path** — three granularities, each in its lane',
      '',
      '```mermaid',
      'flowchart TD',
      '  IS["invalidateSubject(userId)"] --> DROP1["drop entries with that userId"]',
      '  IR["invalidateResource(id)"] --> DROP2["drop entries with that resourceId"]',
      '  IA["invalidateAll()"] --> DROP3["clear everything"]',
      '```',
      '',
      'The point: an entry stores `userId` and `resourceId` alongside the decision. Not for the read path — the',
      'key already has them — but for the invalidation path. Without them, `invalidateSubject` can only parse',
      'key strings or clear the lot.',
    ].join('\n')
  ),
  checklist: [
    t('缓存键包含租户、用户、动作、资源', 'The key covers tenant, user, action and resource'),
    t('拒绝也缓存', 'Denials are cached as well'),
    t('TTL 到期后重新求值', 'Entries are re-evaluated after the TTL'),
    t('三种失效互不越界', 'The three invalidations stay in their lanes'),
    t('撤权之后立刻不再命中旧结果', 'A revoked decision stops being served at once'),
  ],
  pitfalls: [
    t(
      '把时间放进缓存键。带时间条件的策略确实会随时间改变结果，但把 `atMs` 放进键等于每次查询都是新键 —— 缓存命中率归零，代码却还留着一整套缓存逻辑。时间该由 TTL 承担，不该进键。',
      'Putting the instant into the cache key. Time-conditioned policies really do change with time, but keying on `atMs` makes every query a fresh key: the hit rate goes to zero while the whole caching apparatus remains. Time belongs to the TTL, not the key.'
    ),
    t(
      '只缓存允许的结果。想法是「拒绝很便宜，不用缓存」，而实际上被拒的流量往往是最密集的那一股：一个配置错误的客户端、一次扫描、一波攻击。不缓存拒绝，等于给攻击者留了一条直达判权引擎的路。',
      'Caching only the allows, on the theory that denials are cheap. In practice refused traffic is the densest: a misconfigured client, a scanner, an attack wave. Not caching denials leaves a direct path from the attacker to the policy engine.'
    ),
    t(
      '失效时图省事直接 `invalidateAll()`。一个用户改了角色，全站的权限缓存被清空 —— 紧接着所有在线用户的下一次请求同时穿透到判权引擎。在有一定规模的系统里，这就是一次自己造的雪崩。',
      'Reaching for `invalidateAll()` because it is easier. One user changes roles and the whole cache is dropped, so every online user\'s next request stampedes the policy engine at once. At any real scale that is a self-inflicted thundering herd.'
    ),
    t(
      '把 TTL 设得很长，理由是「反正有显式失效」。显式失效只能覆盖你想到的那些变更路径；总有一条是你没想到的（比如策略是从另一个服务同步过来的）。TTL 是兜底，它的长度就是「你最多错多久」。',
      'Setting a long TTL on the grounds that explicit invalidation covers it. Explicit invalidation only covers the change paths you thought of, and one always escapes — policies synced from another service, for instance. The TTL is the backstop, and its length is exactly how wrong you can be.'
    ),
  ],
  hints: [
    t(
      '条目里存 { decision, expiresAt, userId, resourceId }。前两个给读路径，后两个给失效路径 —— 失效需要「按维度找条目」，而键是拼好的字符串，拆回来既慢又脆。',
      'Store { decision, expiresAt, userId, resourceId } per entry: the first two serve reads, the last two serve invalidation. Invalidation needs to find entries by dimension, and taking a concatenated key apart again is both slow and brittle.'
    ),
    t(
      '三个 invalidate 可以共用一个「按条件删除」的私有函数，各自只提供不同的判断条件。',
      'The three invalidations can share one private "delete where" helper, each supplying its own predicate.'
    ),
  ],
  extension: t(
    [
      '真实系统里这一层通常不在进程内，而在 Redis 之类的共享缓存上 ——',
      '于是「失效」变成了一个分布式问题：发消息通知所有节点清、还是干脆等 TTL？',
      'Google 的 Zanzibar（Docs/Drive 背后的授权系统）给出的答案是',
      '**给每个决定带上一个版本号（zookie）**，调用方可以要求「不早于这个版本」，',
      '把「要不要接受旧数据」的决定权交给调用方：',
      '列个文件夹可以用几秒前的结果，改共享设置就必须用最新的。',
      '',
      '另一个值得知道的数字是缓存穿透。判权缓存的键空间是',
      '「用户 × 动作 × 资源」，在大系统里这是个天文数字，命中率天然不高。',
      '所以真实实现往往不缓存最终决定，而是缓存**中间结果**：',
      '用户的角色展开集合、资源的属主。它们的键空间小得多，复用率高得多。',
      '',
      '这一关也是第 4 关那个「撤销多久之后真正生效」的窗口的另一面：',
      '那里是纪元缓存，这里是决定缓存，而它们的 TTL 加起来才是真正的生效延迟。',
    ].join('\n'),
    [
      'In production this layer usually lives outside the process, in something like Redis, which turns',
      'invalidation into a distributed problem: broadcast to every node, or just wait for the TTL? Google\'s',
      'Zanzibar — the authorisation system behind Docs and Drive — answers by **stamping every decision with a',
      'version (a zookie)**, so callers can demand "no older than this" and decide for themselves whether stale',
      'data is acceptable: listing a folder can use a few-second-old answer, changing sharing settings cannot.',
      '',
      'The other number worth knowing is the hit rate. The key space here is user × action × resource, which in',
      'a large system is astronomical, so hit rates are naturally poor. Real implementations therefore often',
      'cache **intermediate results** instead of final decisions: the expanded role set for a user, the owner',
      'of a resource. Those key spaces are far smaller and far more reusable.',
      '',
      'This stage is also the other half of the window from stage 4. There it was a cached epoch, here it is a',
      'cached decision, and the true revocation latency is the sum of the two TTLs.',
    ].join('\n')
  ),
  focus: ['latency', 'correctness', 'encapsulation'],
  lab: {},
  starterFiles: [
    file(
      'src/permissionCache.ts',
      code`
        import type { AccessRequest, PolicyDecision, PolicyEngine } from './abac';
        import { now } from '@lab/env';

        export interface CacheOptions {
          /**
           * How long one entry lives. It is the backstop: forget to invalidate and you are wrong
           * for at most this long.
           */
          ttlMs: number;
        }

        export interface CacheStats {
          hits: number;
          misses: number;
        }

        export interface CachedPolicyEngine extends PolicyEngine {
          /** This user's roles or policies changed */
          invalidateSubject(userId: string): void;
          /** This resource changed: new owner, new classification */
          invalidateResource(resourceId: string): void;
          /** The policy set itself was replaced */
          invalidateAll(): void;
          stats(): CacheStats;
        }

        export function createPermissionCache(
          engine: PolicyEngine,
          options: CacheOptions
        ): CachedPolicyEngine {
          // TODO: implement this
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-10.spec.ts',
      code`
        import { createPermissionCache } from '../src/permissionCache';
        import { sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const TTL = 5000;

        /**
         * A stand-in for the platform-side authorization engine: every question is recorded,
         * and access can be revoked at runtime to exercise cache invalidation.
         */
        function makeProbe() {
          const state = { allowed: true };
          return {
            state,
            engine: {
              evaluate(request: any) {
                count('policyEvals');
                return state.allowed
                  ? { allowed: true, reason: 'policy:test' }
                  : { allowed: false, reason: 'default-deny' };
              },
            },
          };
        }

        function request(overrides: any = {}) {
          return {
            subject: { userId: 'alice', tenantId: 'acme', roles: ['editor'] },
            action: 'doc:read',
            resource: { id: 'doc-1', tenantId: 'acme', ownerId: 'alice' },
            atMs: 0,
            ...overrides,
          };
        }

        function makeCache(probe: any) {
          return createPermissionCache(probe.engine, { ttlMs: TTL });
        }

        describe('Stage 10 · Permission caching and invalidation', () => {
          it('the first call goes through and the second hits the cache', () => {
            const probe = makeProbe();
            const cache = makeCache(probe);

            expect(cache.evaluate(request()).allowed).toBe(true);
            expect(cache.evaluate(request()).allowed).toBe(true);

            expect(cache.stats().misses).toBe(1);
            expect(cache.stats().hits).toBe(1);
          });

          it('twelve queries evaluate only three times [gate:evals]', () => {
            const probe = makeProbe();
            const cache = makeCache(probe);

            for (let index = 0; index < 10; index += 1) cache.evaluate(request());
            cache.evaluate(request({ action: 'doc:write' }));
            cache.evaluate(request({ resource: { id: 'doc-2', tenantId: 'acme', ownerId: 'alice' } }));

            expect(cache.stats().misses).toBe(3);
            expect(cache.stats().hits).toBe(9);
          });

          it('a cached allow is no longer returned after revocation', () => {
            const probe = makeProbe();
            const cache = makeCache(probe);
            expect(cache.evaluate(request()).allowed).toBe(true);

            // An administrator revokes alice's role
            probe.state.allowed = false;
            cache.invalidateSubject('alice');

            const after = cache.evaluate(request());
            if (after.allowed) count('staleAllows');
            expect(after.allowed).toBe(false);
          });

          it('re-evaluates once the TTL expires', async () => {
            const probe = makeProbe();
            const cache = makeCache(probe);
            cache.evaluate(request());

            probe.state.allowed = false;
            await sleep(TTL);

            // Even with nobody calling invalidate, the old answer must not be reused past the TTL
            const after = cache.evaluate(request());
            if (after.allowed) count('staleAllows');
            expect(after.allowed).toBe(false);
          });

          it('still hits the cache within the TTL', async () => {
            const probe = makeProbe();
            const cache = makeCache(probe);
            cache.evaluate(request());

            await sleep(TTL - 1);
            cache.evaluate(request());

            expect(cache.stats().misses).toBe(1);
          });

          it('different users do not share a cache entry', () => {
            const probe = makeProbe();
            const cache = makeCache(probe);

            cache.evaluate(request());
            cache.evaluate(request({ subject: { userId: 'bob', tenantId: 'acme', roles: ['editor'] } }));

            expect(cache.stats().misses).toBe(2);
          });

          it('the same username in different tenants does not share one either', () => {
            const probe = makeProbe();
            const cache = makeCache(probe);

            cache.evaluate(request());
            cache.evaluate(request({ subject: { userId: 'alice', tenantId: 'globex', roles: ['editor'] } }));

            expect(cache.stats().misses).toBe(2);
          });

          it('different resources do not share a cache entry', () => {
            const probe = makeProbe();
            const cache = makeCache(probe);

            cache.evaluate(request());
            cache.evaluate(request({ resource: { id: 'doc-2', tenantId: 'acme', ownerId: 'bob' } }));

            expect(cache.stats().misses).toBe(2);
          });

          it('a denial is cached just the same', () => {
            const probe = makeProbe();
            probe.state.allowed = false;
            const cache = makeCache(probe);

            cache.evaluate(request());
            cache.evaluate(request());
            cache.evaluate(request());

            expect(cache.stats().misses).toBe(1);
            expect(cache.stats().hits).toBe(2);
          });

          it('clearing one user does not affect anyone else', () => {
            const probe = makeProbe();
            const cache = makeCache(probe);
            cache.evaluate(request());
            cache.evaluate(request({ subject: { userId: 'bob', tenantId: 'acme', roles: ['editor'] } }));

            cache.invalidateSubject('alice');
            cache.evaluate(request({ subject: { userId: 'bob', tenantId: 'acme', roles: ['editor'] } }));

            // bob's entry is still there
            expect(cache.stats().misses).toBe(2);
            expect(cache.stats().hits).toBe(1);
          });

          it('invalidating by resource clears only that resource', () => {
            const probe = makeProbe();
            const cache = makeCache(probe);
            cache.evaluate(request());
            cache.evaluate(request({ resource: { id: 'doc-2', tenantId: 'acme', ownerId: 'alice' } }));

            cache.invalidateResource('doc-1');
            probe.state.allowed = false;

            const stale = cache.evaluate(request());
            if (stale.allowed) count('staleAllows');
            expect(stale.allowed).toBe(false);
            // The doc-2 entry was left alone
            expect(cache.evaluate(request({
              resource: { id: 'doc-2', tenantId: 'acme', ownerId: 'alice' },
            })).allowed).toBe(true);
          });

          it('replacing the policy set clears everything', () => {
            const probe = makeProbe();
            const cache = makeCache(probe);
            cache.evaluate(request());
            cache.evaluate(request({ subject: { userId: 'bob', tenantId: 'acme', roles: ['editor'] } }));

            cache.invalidateAll();
            probe.state.allowed = false;

            for (const userId of ['alice', 'bob']) {
              const after = cache.evaluate(request({
                subject: { userId, tenantId: 'acme', roles: ['editor'] },
              }));
              if (after.allowed) count('staleAllows');
              expect(after.allowed).toBe(false);
            }
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.policyEvals',
      op: 'lte',
      value: 3,
      zh: '12 次查询最多求值 3 次',
      en: 'Twelve queries cost at most three evaluations',
      dimension: 'latency',
      scope: 'gate:evals',
    }),
    gate({
      metric: 'counters.staleAllows',
      op: 'eq',
      value: 0,
      zh: '撤权之后一次都不再返回旧的允许',
      en: 'No stale allow is ever served after a revocation',
      dimension: 'correctness',
    }),
  ],
  referenceFiles: [
    file(
      'src/permissionCache.ts',
      code`
        import type { AccessRequest, PolicyDecision, PolicyEngine } from './abac';
        import { now } from '@lab/env';

        export interface CacheOptions {
          ttlMs: number;
        }

        export interface CacheStats {
          hits: number;
          misses: number;
        }

        export interface CachedPolicyEngine extends PolicyEngine {
          invalidateSubject(userId: string): void;
          invalidateResource(resourceId: string): void;
          invalidateAll(): void;
          stats(): CacheStats;
        }

        interface CacheEntry {
          decision: PolicyDecision;
          expiresAt: number;
          /** These two fields serve the invalidation path, not the read path */
          userId: string;
          resourceId: string;
        }

        const SEPARATOR = '|';

        export function createPermissionCache(
          engine: PolicyEngine,
          options: CacheOptions
        ): CachedPolicyEngine {
          const entries = new Map<string, CacheEntry>();
          const counters: CacheStats = { hits: 0, misses: 0 };

          /** Whatever the decision depends on has to be in the key — time excepted, which the TTL handles */
          function keyOf(request: AccessRequest): string {
            return [
              request.subject.tenantId,
              request.subject.userId,
              request.action,
              request.resource.id,
            ].join(SEPARATOR);
          }

          function dropWhere(matches: (entry: CacheEntry) => boolean): void {
            for (const pair of Array.from(entries.entries())) {
              if (matches(pair[1])) entries.delete(pair[0]);
            }
          }

          return {
            evaluate(request: AccessRequest): PolicyDecision {
              const key = keyOf(request);
              const cached = entries.get(key);
              if (cached && now() < cached.expiresAt) {
                counters.hits += 1;
                return cached.decision;
              }

              counters.misses += 1;
              const decision = engine.evaluate(request);
              // Denials are cached too: rejected traffic is often heavier than admitted traffic
              entries.set(key, {
                decision,
                expiresAt: now() + options.ttlMs,
                userId: request.subject.userId,
                resourceId: request.resource.id,
              });
              return decision;
            },

            invalidateSubject(userId: string): void {
              dropWhere((entry) => entry.userId === userId);
            },

            invalidateResource(resourceId: string): void {
              dropWhere((entry) => entry.resourceId === resourceId);
            },

            invalidateAll(): void {
              entries.clear();
            },

            stats(): CacheStats {
              return { hits: counters.hits, misses: counters.misses };
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '三个决定：',
      '',
      '**键里有四个维度，唯独没有时间。** 决定依赖的东西必须全部进键，',
      '否则就是把两个不同的问题当成同一个；而时间是唯一的例外 ——',
      '它进了键就等于没有缓存，所以交给 TTL 兜着。',
      '',
      '**条目里冗余存了 `userId` 和 `resourceId`。** 读路径不需要它们（键里有），',
      '但失效路径需要按维度找条目。另一种写法是解析键字符串，',
      '那会让「键的格式」变成两处代码之间的隐式契约 —— 改一个分隔符就出事。',
      '',
      '**三个 invalidate 共用一个 `dropWhere`。** 它们的区别只有一个谓词，',
      '而遍历、删除、边界处理是同一份。三处各写一遍循环，',
      '迟早有一处会在遍历中删除时踩到迭代器。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      'The key has four dimensions and deliberately no time. Everything the decision depends on has to be in',
      'the key, or two different questions get treated as one. Time is the single exception: putting it in the',
      'key is equivalent to having no cache, so the TTL carries it instead.',
      '',
      'Entries redundantly store `userId` and `resourceId`. The read path does not need them — they are in the',
      'key — but the invalidation path needs to find entries by dimension. The alternative is parsing the key',
      'string, which turns the key format into an implicit contract between two pieces of code that breaks the',
      'day someone changes a separator.',
      '',
      'The three invalidations share one `dropWhere`. They differ only by a predicate, while iteration,',
      'deletion and edge cases are identical. Write the loop three times and one of them will eventually',
      'mutate the map it is iterating.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 11 关 · 租户隔离                                                  */
/* ------------------------------------------------------------------ */

const stage11 = {
  id: 'tenant-isolation',
  title: t('第 11 关 · 租户隔离', 'Stage 11 · Tenant isolation'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '前十关都在判「这个人能不能做这件事」。这一关问的是另一个层次的问题：',
      '**这条数据凭什么出现在他面前**。',
      '',
      '多租户系统里，所有客户的数据躺在同一张表里，靠一个 `tenant` 字段分开。',
      '这意味着任何一次忘了带租户条件的查询，都会把别人的数据端出来 ——',
      '而且它不会报错，只会安静地多返回几行。',
      '',
      '这类事故的代价和其他 bug 不是一个量级：它不是「功能不好用」，',
      '而是「A 公司在你的产品里看到了 B 公司的数据」。',
      '',
      '## 要实现什么',
      '',
      '在 `src/tenant.ts` 实现 `createTenantRepository(store, claims)`。',
      '注意构造参数是**会话身份**：租户不是每个方法的参数，而是这个仓储的属性 ——',
      '调用方没有「忘了传租户」这个选项。',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `read(id)` | 读本租户的一份文档，别的租户的当作不存在 |',
      '| `list()` | 列出本租户的全部文档 |',
      '| `listOwnedBy(ownerId)` | 在本租户内按属主筛 |',
      '| `write(input)` | 写一份文档，**租户来自会话，不来自入参** |',
      '',
      '## 平台会数你读了什么',
      '',
      '`src/support/store.ts` 里，带 `tenant` 字段的记录属于那个租户。',
      '读它的时候如果作用域对不上，或者压根没带作用域，就记一笔 `crossTenantReads`。',
      '',
      '要注意 `store.list(collection, scope)` 会把**整个集合**读回来 ——',
      '包括别的租户的记录。「先全部拉回来，再在内存里 filter」在功能上没错，',
      '但每一条不属于你的记录都会被记一笔。',
      '',
      '## 怎么算过',
      '',
      '- 写进去的记录带着租户标记，读得回来；',
      '- 另一个租户下的同名 id 读不到，也不会被列出来；',
      '- 两个租户可以有完全相同的文档 id，互不覆盖；',
      '- `write` 时调用方即使自己塞了一个 `tenant` 字段，也以会话为准；',
      '- **整个过程中 `counters.crossTenantReads = 0`** —— 这是唯一的硬门槛，',
      '  它数的是「你读到了多少条不属于你的记录」，而不是「你返回了多少条」。',
      '',
      '## 门槛为什么数「读到」而不是「返回」',
      '',
      '因为返回之前的过滤救不了你。',
      '',
      '把别的租户的数据读进内存，再靠一行 `filter` 挡住 —— 功能测试全绿，',
      '但那一行随时可能被改掉、被绕过、或者在某个新写的接口里根本没有。',
      '更别提日志、错误信息、分页计数这些地方，数据早就漏出去了。',
      '',
      '正确的做法是让租户成为**查询的一部分**，而不是查询之后的一步：',
      'SQL 里是 `WHERE tenant_id = ?`，这一关里是把租户放进主键。',
      '别的租户的数据不该被读出来，而不是读出来之后被丢掉。',
      '',
      '## 最容易写错的地方',
      '',
      '`write` 时相信入参里的租户。',
      '',
      '「调用方当然会传对」——直到某个接口把请求体直接透传进来。',
      '这时候攻击者只要在 JSON 里加一个 `"tenant": "别人家"`，',
      '就能往别人的数据里写东西。租户只有一个可信来源：**签过名的那个会话**。',
    ].join('\n'),
    [
      'Ten stages of deciding whether a person may do a thing. This stage asks a different question: **why is',
      'this row in front of them at all?**',
      '',
      "In a multi-tenant system every customer's data sits in the same table, separated by a `tenant` column.",
      "Which means any query that forgets the tenant condition serves somebody else's data — without an error,",
      'just a few extra rows.',
      '',
      'The cost of that class of incident is not in the same league as other bugs. It is not "a feature is',
      'awkward"; it is "company A saw company B\'s data inside your product".',
      '',
      '## What to build',
      '',
      'Implement `createTenantRepository(store, claims)` in `src/tenant.ts`. Note the constructor argument: the',
      '**session identity**. The tenant is not a parameter on every method, it is a property of the repository',
      '— the caller has no option to forget it.',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `read(id)` | Read one document of this tenant; another tenant\'s does not exist |',
      '| `list()` | Every document of this tenant |',
      '| `listOwnedBy(ownerId)` | Filter by owner, within this tenant |',
      '| `write(input)` | Store a document — **the tenant comes from the session, not the input** |',
      '',
      '## The platform counts what you read',
      '',
      'In `src/support/store.ts`, a record carrying a `tenant` field belongs to that tenant. Reading it with a',
      'mismatched scope — or with no scope at all — records one `crossTenantReads`.',
      '',
      'Note that `store.list(collection, scope)` pulls back the **whole collection**, other tenants included.',
      '"Fetch everything, then filter in memory" is functionally correct and charges you one count for every',
      'record that was not yours.',
      '',
      '## What counts as passing',
      '',
      '- A written record carries its tenant marker and reads back;',
      '- The same id under another tenant is neither readable nor listed;',
      '- Two tenants may hold identical document ids without overwriting each other;',
      '- If a caller passes their own `tenant` field to `write`, the session wins;',
      '- **`counters.crossTenantReads = 0` throughout** — the one hard gate. It counts records you read that',
      '  were not yours, not records you returned.',
      '',
      '## Why the gate counts reads and not returns',
      '',
      'Because filtering afterwards does not save you.',
      '',
      "Pull another tenant's rows into memory and block them with one `filter` line: every functional test",
      'passes, and that line can be edited, bypassed, or simply absent in the next endpoint somebody writes.',
      'Never mind logs, error messages and pagination counts, where the data has already leaked.',
      '',
      'The tenant has to be **part of the query** rather than a step after it: `WHERE tenant_id = ?` in SQL,',
      "and here, part of the primary key. Another tenant's data should not come back, rather than coming back",
      'and being dropped.',
      '',
      '## The easiest thing to get wrong',
      '',
      'Trusting the tenant in the input to `write`.',
      '',
      '"The caller obviously passes the right one" — until an endpoint forwards the request body straight',
      'through. At that point an attacker adds `"tenant": "someone-else"` to the JSON and writes into another',
      "company's data. There is exactly one trustworthy source for the tenant: **the signed session.**",
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**构造与写入** —— 租户在这里被钉死一次',
      '',
      '```mermaid',
      'flowchart TD',
      '  S["createTenantRepository(store, claims)"] --> T["tenant = claims.tenantId<br/>整个仓储只认这一个租户"]',
      '  T --> P["key 前缀 = tenant 加分隔符<br/>scope = tenantId"]',
      '  W["write(input)"] --> OW["记录 = 入参覆盖上会话的 tenant<br/>入参里的 tenant 不作数"]',
      '  OW --> PUT["store.put(前缀 加 id)"]',
      '```',
      '',
      '**按 id 读** —— 别人的 id 在查询阶段就不存在',
      '',
      '```mermaid',
      'flowchart TD',
      '  R["read(id)"] --> GET["store.get(前缀 加 id, scope)"]',
      '  GET --> MISS{"取到了吗？"}',
      '  MISS -- 没有 --> NULL["返回 null"]',
      '  MISS -- 有 --> DOC["返回文档"]',
      '```',
      '',
      '**列表** —— 先按前缀筛 key，再取值',
      '',
      '```mermaid',
      'flowchart TD',
      '  L["list()"] --> KEYS["store.keys(documents)"]',
      '  KEYS --> FIL["只留下本租户前缀的 key"]',
      '  FIL --> EACH["逐个 store.get(key, scope)"]',
      '  EACH --> ARR["返回数组"]',
      '```',
      '',
      '要点：`list` 走的是「先按前缀筛 key，再取」，而不是「先 store.list 全取，再 filter」。',
      '两种写法返回的东西一模一样，区别只在于**有没有把别人的数据读进内存**——',
      '而门槛数的正是这个。',
    ].join('\n'),
    [
      '**Construction and writes** — the tenant is pinned once, here',
      '',
      '```mermaid',
      'flowchart TD',
      '  S["createTenantRepository(store, claims)"] --> T["tenant = claims.tenantId<br/>this repository knows one tenant"]',
      '  T --> P["key prefix = tenant plus separator<br/>scope = tenantId"]',
      '  W["write(input)"] --> OW["record = input overridden by the session tenant<br/>the input tenant does not count"]',
      '  OW --> PUT["store.put(prefix plus id)"]',
      '```',
      '',
      '**Reading by id** — another tenant\'s id does not exist at query time',
      '',
      '```mermaid',
      'flowchart TD',
      '  R["read(id)"] --> GET["store.get(prefix plus id, scope)"]',
      '  GET --> MISS{"anything there?"}',
      '  MISS -- no --> NULL["return null"]',
      '  MISS -- yes --> DOC["return the document"]',
      '```',
      '',
      '**Listing** — filter keys by prefix first, fetch second',
      '',
      '```mermaid',
      'flowchart TD',
      '  L["list()"] --> KEYS["store.keys(documents)"]',
      '  KEYS --> FIL["keep only keys with our prefix"]',
      '  FIL --> EACH["store.get(key, scope) for each"]',
      '  EACH --> ARR["return the array"]',
      '```',
      '',
      'The point: `list` filters keys first and fetches second, rather than fetching everything and filtering.',
      'Both return identical data; the difference is **whether other tenants\' rows entered your memory** — and',
      'that is exactly what the gate counts.',
    ].join('\n')
  ),
  checklist: [
    t('租户来自会话，不是方法参数', 'The tenant comes from the session, not a parameter'),
    t('租户是主键的一部分', 'The tenant is part of the key'),
    t('先按租户筛，再取数据', 'Filter by tenant first, fetch second'),
    t('每次 store 读取都带作用域', 'Every store read carries the scope'),
    t('write 忽略入参里的租户', 'write ignores any tenant in the input'),
  ],
  pitfalls: [
    t(
      '先 `store.list()` 全取回来，再在内存里 `filter`。功能完全正确，但别人的数据已经进了你的进程 —— 一次日志打印、一个错误堆栈、一个分页总数，都可能把它带出去。而且这条 filter 在下一个接口里很容易被忘掉。',
      'Calling `store.list()` and filtering in memory. Functionally correct, and another tenant\'s data is already inside your process — one log line, one stack trace, one pagination total is enough to leak it. And that filter is easy to omit in the next endpoint.'
    ),
    t(
      '把租户做成每个方法的参数。看起来更灵活，实际上是把「别忘了传对」这件事分发给了所有调用方，而调用方有几十个、还会不断增加。租户应该在构造仓储时钉死一次。',
      'Making the tenant a parameter on every method. It looks flexible and distributes "remember to pass the right one" to dozens of callers, with more arriving every sprint. Pin the tenant once, when the repository is constructed.'
    ),
    t(
      '信任入参里的 `tenant` 字段。任何一个把请求体透传到仓储的接口，都会让攻击者能指定自己要写进哪个租户。租户的唯一可信来源是签过名的会话。',
      'Trusting a `tenant` field from the input. Any endpoint that forwards a request body into the repository lets an attacker name the tenant they are writing into. The signed session is the only trustworthy source.'
    ),
    t(
      '用「先查再改」实现更新，中间那次查询忘了带作用域。写路径通常测得比读路径松，而这里的后果更严重：不是读到别人的数据，是改掉别人的数据。',
      'Implementing an update as read-then-write and forgetting the scope on the read in the middle. Write paths are usually tested less carefully than read paths, and the consequence here is worse: not reading someone else\'s data but overwriting it.'
    ),
  ],
  hints: [
    t(
      '主键用 `tenant + 分隔符 + id`。这样「别的租户的 id」在查询阶段就不存在了 —— 不需要读出来再判断它属于谁。',
      "Key by `tenant + separator + id`. Another tenant's id then does not exist at query time — nothing to read and then classify.",
    ),
    t(
      '仓储里应该只有一处出现 `store.get`。所有读路径都经过它，作用域也就只会被写一次、忘不了。',
      'There should be exactly one `store.get` in the repository. Every read goes through it, so the scope is written once and cannot be forgotten.'
    ),
  ],
  extension: t(
    [
      '真实世界里租户隔离有三种做法，成本和强度递增：',
      '',
      '| 做法 | 隔离强度 | 代价 |',
      '| --- | --- | --- |',
      '| 共享表 + tenant 列 | 全靠代码 | 最省，但一次漏写就是事故 |',
      '| 共享库 + 每租户一个 schema | 数据库层面 | 迁移和连接管理变复杂 |',
      '| 每租户一个数据库 | 物理隔离 | 最贵，几千个租户时运维不可行 |',
      '',
      '绝大多数 SaaS 用第一种，然后用两层保险把「漏写」变成不可能：',
      'PostgreSQL 的**行级安全（RLS）**在数据库里强制加上租户条件 ——',
      '就算应用层忘了写 WHERE，数据库也不会把别人的行返回给你；',
      '以及在 ORM 层强制作用域（Rails 的 `default_scope`、',
      'Django 的自定义 Manager），让「不带租户的查询」在代码里根本写不出来。',
      '',
      '这一关的「租户进主键」是同一个思路的最小版本：',
      '**让错误的写法变得不可表达**，比让它变得「不推荐」有效得多。',
      '',
      '顺便一提，跨租户读的另一个常见来源是缓存 —— 第 10 关那个缓存键',
      '如果漏了租户维度，两个租户的判权结果就会互相串。',
    ].join('\n'),
    [
      'Production tenant isolation comes in three shapes, in increasing order of cost and strength:',
      '',
      '| Approach | Strength | Cost |',
      '| --- | --- | --- |',
      '| Shared tables with a tenant column | Code only | Cheapest; one missing clause is an incident |',
      '| Shared database, one schema per tenant | Database level | Migrations and connections get harder |',
      '| One database per tenant | Physical | Most expensive; unworkable at thousands of tenants |',
      '',
      'Most SaaS runs the first and then makes the omission impossible with two backstops: PostgreSQL',
      '**row-level security**, which appends the tenant condition inside the database so a forgotten WHERE',
      'still cannot return foreign rows; and enforced scoping at the ORM layer (Rails `default_scope`, a custom',
      'Django manager) so a query without a tenant cannot be written in the first place.',
      '',
      '"Tenant in the primary key" here is the smallest version of the same idea: **making the wrong code',
      'inexpressible** beats making it discouraged.',
      '',
      'Incidentally, the other common source of cross-tenant reads is caching — leave the tenant out of the',
      'stage 10 cache key and two tenants start sharing authorisation decisions.',
    ].join('\n')
  ),
  focus: ['correctness', 'encapsulation', 'resilience'],
  lab: {},
  starterFiles: [
    file(
      'src/tenant.ts',
      code`
        import { COLLECTIONS } from './contract';
        import type { SessionClaims } from './contract';
        import type { Store } from './support/store';

        /** One row of business data. The tenant field is the one the platform accounts on. */
        export interface TenantDocument {
          id: string;
          tenant: string;
          ownerId: string;
          title: string;
          classification?: string;
        }

        /** What a caller may supply on write — note there is no tenant */
        export interface DocumentInput {
          id: string;
          ownerId: string;
          title: string;
          classification?: string;
        }

        export interface TenantRepository {
          read(id: string): TenantDocument | null;
          list(): TenantDocument[];
          listOwnedBy(ownerId: string): TenantDocument[];
          write(input: DocumentInput): TenantDocument;
        }

        export function createTenantRepository(store: Store, claims: SessionClaims): TenantRepository {
          // TODO: implement this
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-11.spec.ts',
      code`
        import { createTenantRepository } from '../src/tenant';
        import { createRefreshService } from '../src/refresh';
        import { createSessionIssuer } from '../src/session';
        import { COLLECTIONS } from '../src/contract';
        import { createStore } from '../src/support/store';

        function claimsFor(userId: string, tenantId: string) {
          return { sub: userId, tenantId, sid: 'sid-' + userId, iat: 0, exp: 60000 };
        }

        function repositoryFor(store: any, userId: string, tenantId: string) {
          return createTenantRepository(store, claimsFor(userId, tenantId));
        }

        describe('Stage 11 · Tenant isolation', () => {
          it('what is written can be read back', () => {
            const repository = repositoryFor(createStore(), 'alice', 'acme');
            repository.write({ id: 'doc-1', ownerId: 'alice', title: 'roadmap' });

            const document = repository.read('doc-1');
            expect(document).toBeTruthy();
            expect(document.title).toBe('roadmap');
            expect(document.tenant).toBe('acme');
          });

          it('a written record carries its tenant marker', () => {
            const store = createStore();
            repositoryFor(store, 'alice', 'acme').write({ id: 'doc-1', ownerId: 'alice', title: 'roadmap' });

            const records = store.list(COLLECTIONS.documents, { tenantId: 'acme' });
            expect(records).toHaveLength(1);
            expect(records[0].tenant).toBe('acme');
          });

          it('a same-named document in another tenant is not readable', () => {
            const store = createStore();
            repositoryFor(store, 'mallory', 'globex').write({
              id: 'doc-1',
              ownerId: 'mallory',
              title: 'globex internal',
            });

            expect(repositoryFor(store, 'alice', 'acme').read('doc-1')).toBeNull();
          });

          it('two tenants may hold same-named documents without overwriting each other', () => {
            const store = createStore();
            const acme = repositoryFor(store, 'alice', 'acme');
            const globex = repositoryFor(store, 'mallory', 'globex');

            acme.write({ id: 'doc-1', ownerId: 'alice', title: 'acme plan' });
            globex.write({ id: 'doc-1', ownerId: 'mallory', title: 'globex plan' });

            expect(acme.read('doc-1').title).toBe('acme plan');
            expect(globex.read('doc-1').title).toBe('globex plan');
          });

          it("a listing contains only this tenant's documents", () => {
            const store = createStore();
            const acme = repositoryFor(store, 'alice', 'acme');
            const globex = repositoryFor(store, 'mallory', 'globex');

            acme.write({ id: 'doc-1', ownerId: 'alice', title: 'a1' });
            acme.write({ id: 'doc-2', ownerId: 'bob', title: 'a2' });
            globex.write({ id: 'doc-3', ownerId: 'mallory', title: 'g1' });

            const titles = acme.list().map((document: any) => document.title).sort();
            expect(titles).toEqual(['a1', 'a2']);
            expect(globex.list()).toHaveLength(1);
          });

          it('filtering by owner stays within this tenant too', () => {
            const store = createStore();
            const acme = repositoryFor(store, 'alice', 'acme');
            const globex = repositoryFor(store, 'alice', 'globex');

            acme.write({ id: 'doc-1', ownerId: 'alice', title: 'a1' });
            acme.write({ id: 'doc-2', ownerId: 'bob', title: 'a2' });
            // The same person also has documents in the other tenant
            globex.write({ id: 'doc-9', ownerId: 'alice', title: 'g1' });

            expect(acme.listOwnedBy('alice')).toHaveLength(1);
            expect(acme.listOwnedBy('alice')[0].title).toBe('a1');
          });

          it('the tenant on write comes from the session, not from the arguments', () => {
            const store = createStore();
            const acme = repositoryFor(store, 'alice', 'acme');

            acme.write({ id: 'doc-1', ownerId: 'alice', title: 'plan', tenant: 'globex' } as any);

            expect(acme.read('doc-1').tenant).toBe('acme');
            expect(repositoryFor(store, 'mallory', 'globex').read('doc-1')).toBeNull();
          });

          it("writing the same id again updates only this tenant's row", () => {
            const store = createStore();
            const acme = repositoryFor(store, 'alice', 'acme');
            const globex = repositoryFor(store, 'mallory', 'globex');
            acme.write({ id: 'doc-1', ownerId: 'alice', title: 'v1' });
            globex.write({ id: 'doc-1', ownerId: 'mallory', title: 'globex v1' });

            acme.write({ id: 'doc-1', ownerId: 'alice', title: 'v2' });

            expect(acme.read('doc-1').title).toBe('v2');
            expect(globex.read('doc-1').title).toBe('globex v1');
          });

          it('a missing document returns null and an empty tenant lists an empty array', () => {
            const store = createStore();
            repositoryFor(store, 'mallory', 'globex').write({
              id: 'doc-1',
              ownerId: 'mallory',
              title: 'g1',
            });
            const acme = repositoryFor(store, 'alice', 'acme');

            expect(acme.read('nope')).toBeNull();
            expect(acme.list()).toEqual([]);
          });

          it("the repository's tenant comes from the session issued at login", () => {
            const store = createStore();
            const issuer = createSessionIssuer({ secret: 'session-signing-key', ttlMs: 60000 });
            const refresh = createRefreshService(store, issuer, { ttlMs: 600000 });

            const pair = refresh.start({ userId: 'alice', tenantId: 'acme' });
            const repository = createTenantRepository(store, issuer.verify(pair.accessToken));
            repository.write({ id: 'doc-1', ownerId: 'alice', title: 'from a real session' });

            expect(repository.read('doc-1').tenant).toBe('acme');
            expect(repositoryFor(store, 'mallory', 'globex').list()).toEqual([]);
          });

          it('however many rows another tenant writes, none of them become readable', () => {
            const store = createStore();
            const globex = repositoryFor(store, 'mallory', 'globex');
            for (let index = 0; index < 20; index += 1) {
              globex.write({ id: 'doc-' + index, ownerId: 'mallory', title: 'g' + index });
            }
            const acme = repositoryFor(store, 'alice', 'acme');
            acme.write({ id: 'doc-1', ownerId: 'alice', title: 'mine' });

            // The gate counts how many of someone else's records were read; fetching everything and
            // then filtering shows up here
            expect(acme.list()).toHaveLength(1);
            expect(acme.listOwnedBy('mallory')).toEqual([]);
            expect(acme.read('doc-7')).toBeNull();
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.crossTenantReads',
      op: 'eq',
      value: 0,
      zh: '一条不属于本租户的记录都没读过',
      en: 'Not one record belonging to another tenant is ever read',
      dimension: 'correctness',
    }),
  ],
  referenceFiles: [
    file(
      'src/tenant.ts',
      code`
        import { COLLECTIONS } from './contract';
        import type { SessionClaims } from './contract';
        import type { Store } from './support/store';

        export interface TenantDocument {
          id: string;
          tenant: string;
          ownerId: string;
          title: string;
          classification?: string;
        }

        export interface DocumentInput {
          id: string;
          ownerId: string;
          title: string;
          classification?: string;
        }

        export interface TenantRepository {
          read(id: string): TenantDocument | null;
          list(): TenantDocument[];
          listOwnedBy(ownerId: string): TenantDocument[];
          write(input: DocumentInput): TenantDocument;
        }

        const KEY_SEPARATOR = '|';

        export function createTenantRepository(store: Store, claims: SessionClaims): TenantRepository {
          // The tenant is pinned once here, and no method afterwards can change it
          const tenant = claims.tenantId;
          const scope = { tenantId: tenant };
          const prefix = tenant + KEY_SEPARATOR;

          /**
           * The whole repository reads the store in exactly one place, so the scope is written
           * exactly once
           */
          function fetch(key: string): TenantDocument | null {
            const record = store.get(COLLECTIONS.documents, key, scope);
            return record ? (record as unknown as TenantDocument) : null;
          }

          function all(): TenantDocument[] {
            const documents: TenantDocument[] = [];
            for (const key of store.keys(COLLECTIONS.documents)) {
              // Filter keys by tenant first and fetch the data second: other tenants' records are
              // never read at all
              if (key.indexOf(prefix) !== 0) continue;
              const document = fetch(key);
              if (document) documents.push(document);
            }
            return documents;
          }

          return {
            read(id: string): TenantDocument | null {
              return fetch(prefix + id);
            },

            list(): TenantDocument[] {
              return all();
            },

            listOwnedBy(ownerId: string): TenantDocument[] {
              return all().filter((document) => document.ownerId === ownerId);
            },

            write(input: DocumentInput): TenantDocument {
              // tenant goes last: even if the arguments carry that field, the session overrides it
              const document: TenantDocument = { ...input, tenant };
              store.put(COLLECTIONS.documents, prefix + input.id, document as unknown as Record<string, unknown>);
              return document;
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '三个决定：',
      '',
      '**租户在构造时钉死，不做方法参数。** 这一行决定了这个仓储上',
      '「忘了带租户」这件事是**写不出来**的。安全性从「每个调用方都要记得」',
      '变成了「结构上就没有那个选项」—— 后者才扛得住团队和时间。',
      '',
      '**只有一处 `store.get`。** `read`、`list`、`listOwnedBy` 全都经过 `fetch`，',
      '于是作用域参数只写了一次。三处各写一遍的话，第三处迟早会漏。',
      '',
      '**`list` 先筛 key 再取值。** 和「全取回来再 filter」返回的东西一模一样，',
      '但后者会把别人的数据读进进程 —— 而数据一旦进了内存，',
      '它就可能出现在日志、错误信息、监控指标里。门槛数的是「读到」，正是这个道理。',
      '',
      '`write` 里 `{ ...input, tenant }` 的字段顺序也不是随手写的：',
      '把 `tenant` 放在展开之后，入参里的同名字段就被无声地覆盖掉了。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      'The tenant is pinned at construction, not passed per call. That one line makes "forgot the tenant"',
      '**unwritable** against this repository. Safety moves from "every caller must remember" to "the option',
      'does not exist", and only the second survives a team and a year.',
      '',
      'There is exactly one `store.get`. `read`, `list` and `listOwnedBy` all go through `fetch`, so the scope',
      'argument is written once. Write it in three places and the third will eventually be missing.',
      '',
      '`list` filters keys before fetching. It returns exactly what "fetch everything and filter" returns,',
      "except the latter pulls other tenants' rows into the process — and once data is in memory it can appear",
      'in a log line, an error message, a metric. That is why the gate counts reads.',
      '',
      'The field order in `{ ...input, tenant }` is not incidental either: putting `tenant` after the spread',
      'silently overrides anything the caller supplied.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */
/* 第 12 关 · 审计链与登录加固                                          */
/* ------------------------------------------------------------------ */

const stage12 = {
  id: 'audit-hardening',
  title: t('第 12 关 · 审计链与登录加固', 'Stage 12 · An audit chain, and hardening the front door'),
  // 本关任务：背景 + 通关标准 + 代码细节，一整块
  goal: t(
    [
      '前十一关做的都是「拦住不该发生的事」。这一关做的是另外两件事：',
      '**万一发生了，查得清**；以及把第 1 关那扇门重新加固一遍。',
      '',
      '为什么审计要单独做一层？因为出事之后，日志是唯一的证据 ——',
      '而一个能被入侵者改掉的日志，不是证据，是安慰。',
      '',
      '至于加固：第 1 关的慢哈希让**离线**爆破变贵，但对着线上接口一个个试密码',
      '完全不受它影响。那条路要靠限流和锁定来堵。',
      '',
      '## 要实现什么',
      '',
      '在 `src/audit.ts` 实现两样东西。',
      '',
      '**`createAuditLog(store, options)`** —— 一条哈希链：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `record(event)` | 追加一条，`seq` 连续递增，`prevHash` 指向上一条的 `hash` |',
      '| `entries()` | 按 seq 顺序返回全部条目 |',
      '| `verifyChain()` | 返回第一处断裂的下标，完好则返回 `-1` |',
      '',
      '每条的 `hash` 用 `hmac(secret, 这条的内容 + prevHash)` 算 —— 用 HMAC 而不是',
      '普通摘要，是因为能改库的人同样能重算普通摘要。',
      '',
      '**`createHardenedLogin(store, credentials, audit, options)`** —— 登录闸门：',
      '',
      '| 情况 | 行为 |',
      '| --- | --- |',
      '| 密码正确且未锁定 | 通过，失败计数清零 |',
      '| 密码错误 | 失败计数加一，达到 `maxAttempts` 就锁 `lockoutMs` |',
      '| 锁定期内 | 一律拒绝，**连慢哈希都不做** |',
      '| 锁定期满 | 重新开始计数 |',
      '',
      '每一次尝试，无论成败，都要留下一条审计。',
      '',
      '## 怎么算过',
      '',
      '- **每个安全事件都留下了痕迹**，seq 连续没有缺口',
      '  （门槛 `counters.auditGaps = 0` 数的是「该有记录却没有」以及',
      '  「链被改了却验不出来」）；',
      '- 改掉一条、删掉一条，`verifyChain()` 都要指出位置；',
      '- **审计里没有秘密**（门槛 `counters.secretsInAudit = 0`）：',
      '  密码、令牌、验证码这些字段要脱敏，嵌套在对象里的也要；',
      '- **锁定期间正确的密码也进不来**（门槛 `counters.bruteForceAccepted = 0`）；',
      '- 锁定只针对这个账号，别人不受影响；成功登录会把计数清零。',
      '',
      '## 为什么锁定期间不能做慢哈希',
      '',
      '因为那会把防护措施变成放大器。',
      '',
      '一次慢哈希是一百毫秒的 CPU。如果锁定之后每个请求还照样哈希一遍，',
      '攻击者就得到了一个「一个请求消耗你一百毫秒 CPU」的接口 ——',
      '他甚至不需要猜对密码，只要不停地发。',
      '',
      '锁定判断必须在验密码**之前**。这也是这一关唯一一处',
      '「检查顺序」比「检查本身」更重要的地方。',
      '',
      '## 最容易写错的地方',
      '',
      '把审计写成「先返回结果，再顺手记一笔」。',
      '',
      '登录失败那条路径上，`return` 常常写在前面，审计写在后面 ——',
      '于是**失败的登录不留痕迹**。而这正是唯一真正需要留痕的那一类事件：',
      '成功的登录每天几万次，失败的登录才是入侵的样子。',
    ].join('\n'),
    [
      'Eleven stages of stopping things that should not happen. This one does two other things: making sure',
      'that **if it happens anyway, you can find out**; and hardening the door from stage 1 all over again.',
      '',
      'Why does auditing deserve its own layer? Because after an incident the log is the only evidence — and a',
      'log the intruder could edit is not evidence, it is reassurance.',
      '',
      'As for hardening: the slow hash of stage 1 makes **offline** cracking expensive and does nothing about',
      'someone trying passwords against the live endpoint one at a time. That road is closed by rate limiting',
      'and lockout.',
      '',
      '## What to build',
      '',
      'Two things in `src/audit.ts`.',
      '',
      '**`createAuditLog(store, options)`** — a hash chain:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `record(event)` | Append one entry; `seq` increments, `prevHash` points at the previous `hash` |',
      '| `entries()` | Every entry in seq order |',
      '| `verifyChain()` | The index of the first break, or `-1` when intact |',
      '',
      'Each `hash` is `hmac(secret, this entry plus prevHash)` — an HMAC rather than a plain digest, because',
      'whoever can rewrite the table can also recompute a plain digest.',
      '',
      '**`createHardenedLogin(store, credentials, audit, options)`** — the login gate:',
      '',
      '| Situation | Behaviour |',
      '| --- | --- |',
      '| Correct password, not locked | Admit, reset the failure count |',
      '| Wrong password | Increment failures; at `maxAttempts`, lock for `lockoutMs` |',
      '| Inside the lockout | Always refuse, **without even running the slow hash** |',
      '| Lockout expired | Start counting again |',
      '',
      'Every attempt, successful or not, leaves an audit entry.',
      '',
      '## What counts as passing',
      '',
      '- **Every security event leaves a trace** and the sequence has no holes (the `counters.auditGaps = 0`',
      '  gate counts both "should have been recorded and was not" and "the chain was altered undetectably");',
      '- Editing an entry and deleting an entry both make `verifyChain()` point at the break;',
      '- **No secrets in the audit** (the `counters.secretsInAudit = 0` gate): passwords, tokens and codes are',
      '  redacted, nested ones included;',
      '- **The right password does not get in during a lockout** (the `counters.bruteForceAccepted = 0` gate);',
      '- A lockout affects one account only, and a successful login resets the counter.',
      '',
      '## Why a lockout must not run the slow hash',
      '',
      'Because that turns the defence into an amplifier.',
      '',
      'One slow hash is a hundred milliseconds of CPU. Keep hashing after the account is locked and the',
      'attacker has an endpoint where one request costs you a hundred milliseconds — they do not even need to',
      'guess correctly, only to keep sending.',
      '',
      'The lockout check has to come **before** password verification. It is the one place in this stage where',
      'the order of the checks matters more than the checks.',
      '',
      '## The easiest thing to get wrong',
      '',
      'Writing the audit as "return the result, then note it down".',
      '',
      'On the failure path the `return` usually comes first and the audit call after it, so **failed logins',
      'leave no trace** — and failed logins are the one category that genuinely needs one. Successful logins',
      'happen tens of thousands of times a day; failed ones are what an intrusion looks like.',
    ].join('\n')
  ),

  // 参考架构：这一关的代码怎么组织，一种可行解
  architecture: t(
    [
      '**登录** —— 三条路径，每条都留一条审计',
      '',
      '```mermaid',
      'flowchart TD',
      '  L["login(userId, password)"] --> ST["读锁定状态"]',
      '  ST --> LK{"还在锁定期内？"}',
      '  LK -- 在 --> AUD1["记一条 deny 审计"]',
      '  AUD1 --> DENY["返回 locked<br/>这条路径上没有慢哈希"]',
      '  LK -- 不在 --> VER["credentials.verify()<br/>这里才付出一次 KDF"]',
      '  VER --> OK{"密码对吗？"}',
      '  OK -- 对 --> RESET["失败计数清零"]',
      '  RESET --> AUD2["记一条 allow 审计"]',
      '  AUD2 --> PASS["通过"]',
      '  OK -- 不对 --> INC["失败计数加一<br/>到上限就写锁定时间"]',
      '  INC --> AUD3["记一条 deny 审计"]',
      '  AUD3 --> FAIL["返回 invalid-credentials"]',
      '',
      '```',
      '',
      '**记一条** —— 先脱敏，再算哈希',
      '',
      '```mermaid',
      'flowchart TD',
      '  REC["record(event)"] --> PREV["取上一条的 hash<br/>没有就用 genesis"]',
      '  PREV --> RED["detail 逐层脱敏"]',
      '  RED --> CALC["hash = hmac(secret, 内容 + prevHash)"]',
      '  CALC --> APP["按 seq 追加进 store"]',
      '```',
      '',
      '**验链** —— 三种断裂，一次遍历',
      '',
      '```mermaid',
      'flowchart TD',
      '  VC["verifyChain()"] --> WALK["从头逐条走"]',
      '  WALK --> C1{"seq 连续？"}',
      '  C1 -- 否 --> BRK["返回这一条的下标"]',
      '  C1 -- 是 --> C2{"prevHash 接得上？"}',
      '  C2 -- 否 --> BRK',
      '  C2 -- 是 --> C3{"重算的 hash 一致？"}',
      '  C3 -- 否 --> BRK',
      '  C3 -- 是 --> WALK',
      '  WALK --> INTACT["走完了，返回 -1"]',
      '```',
      '',
      '要点：三条登录路径上各挂着一条审计，一条都不能省。',
      '「返回」和「记录」谁先谁后无所谓，但**不能有一条路径只有返回**。',
    ].join('\n'),
    [
      '**Login** — three paths, each leaving an audit entry',
      '',
      '```mermaid',
      'flowchart TD',
      '  L["login(userId, password)"] --> ST["read the lockout state"]',
      '  ST --> LK{"still locked?"}',
      '  LK -- yes --> AUD1["record a deny entry"]',
      '  AUD1 --> DENY["return locked<br/>no slow hash on this path"]',
      '  LK -- no --> VER["credentials.verify()<br/>the KDF is paid here"]',
      '  VER --> OK{"password correct?"}',
      '  OK -- yes --> RESET["reset the failure count"]',
      '  RESET --> AUD2["record an allow entry"]',
      '  AUD2 --> PASS["admit"]',
      '  OK -- no --> INC["increment failures<br/>at the limit, write a lock until"]',
      '  INC --> AUD3["record a deny entry"]',
      '  AUD3 --> FAIL["return invalid-credentials"]',
      '',
      '```',
      '',
      '**Recording** — redact first, then hash',
      '',
      '```mermaid',
      'flowchart TD',
      '  REC["record(event)"] --> PREV["take the previous hash<br/>genesis when there is none"]',
      '  PREV --> RED["redact the detail, recursively"]',
      '  RED --> CALC["hash = hmac(secret, body plus prevHash)"]',
      '  CALC --> APP["append by seq into the store"]',
      '```',
      '',
      '**Verifying** — three kinds of break, one pass',
      '',
      '```mermaid',
      'flowchart TD',
      '  VC["verifyChain()"] --> WALK["walk from the start"]',
      '  WALK --> C1{"seq contiguous?"}',
      '  C1 -- no --> BRK["return this index"]',
      '  C1 -- yes --> C2{"prevHash links up?"}',
      '  C2 -- no --> BRK',
      '  C2 -- yes --> C3{"recomputed hash matches?"}',
      '  C3 -- no --> BRK',
      '  C3 -- yes --> WALK',
      '  WALK --> INTACT["walked it all, return -1"]',
      '```',
      '',
      'The point: all three login paths carry an audit call and none may be skipped. Whether the record comes',
      'before or after the return does not matter; **a path with only a return** does.',
    ].join('\n')
  ),
  checklist: [
    t('三条登录路径都留审计', 'All three login paths record an entry'),
    t('锁定判断在验密码之前', 'The lockout check precedes password verification'),
    t('链用 HMAC，不是普通摘要', 'The chain uses an HMAC, not a plain digest'),
    t('脱敏要递归到嵌套对象', 'Redaction recurses into nested objects'),
    t('verifyChain 指出第一处断裂', 'verifyChain points at the first break'),
  ],
  pitfalls: [
    t(
      '只在登录成功时写审计。成功的登录每天几万条，没人看；失败的登录才是入侵的形状 —— 而它恰好是最容易被 `return` 提前截断的那条路径。',
      'Recording only successful logins. Successes happen tens of thousands of times a day and nobody reads them; failures are the shape of an intrusion, and theirs is exactly the path an early `return` cuts short.'
    ),
    t(
      '用普通摘要做链。能改数据库的人同样能重算 sha256，改完一条把后面所有条的 hash 重新算一遍，链看起来完好无损。HMAC 需要密钥，而密钥不在数据库里 —— 这是「防篡改」和「看起来防篡改」的分界线。',
      'Chaining with a plain digest. Whoever can edit the database can recompute sha256 too: edit one row, recompute every hash after it, and the chain looks pristine. An HMAC needs a key, and the key is not in the database — that is the line between tamper-evident and tamper-evident-looking.'
    ),
    t(
      '脱敏只做一层。`{ user: { password: "..." } }` 里的密码逃过了检查，而这种嵌套结构在真实的审计事件里到处都是（整个请求体、整个配置对象）。脱敏要么递归，要么就别声称自己脱敏了。',
      'Redacting one level deep. The password inside `{ user: { password: "…" } }` slips through, and nested structures are everywhere in real audit events — whole request bodies, whole config objects. Redaction either recurses or should not claim to redact.'
    ),
    t(
      '锁定之后仍然去验密码。既然结果注定是拒绝，那次慢哈希就是纯浪费 —— 而攻击者可以无限次触发它。防爆破措施反而成了消耗 CPU 的入口，这是安全设计里典型的「防御变武器」。',
      'Verifying the password after the account is locked. The outcome is already decided, so the slow hash is pure waste — and the attacker can trigger it indefinitely. The anti-brute-force control becomes a CPU-burning endpoint, the classic case of a defence turned into a weapon.'
    ),
  ],
  hints: [
    t(
      '审计条目按 seq 当 key 存进 store（补齐成定长字符串，key 排序就是 seq 排序）。verifyChain 只需要顺序走一遍，重算每条的 hash 和 prevHash 对不对得上。',
      'Key audit entries by seq (zero-padded, so sorting keys sorts by seq). verifyChain is a single pass recomputing each hash and checking it links to the previous one.'
    ),
    t(
      '锁定状态存 { failures, lockedUntil } 两个字段就够了。锁定期满不必主动清理 —— 读的时候发现 lockedUntil 已经过去，把 failures 当 0 处理即可。',
      'Lockout state is two fields: { failures, lockedUntil }. No cleanup job needed — when a read finds lockedUntil in the past, treat failures as zero.'
    ),
  ],
  extension: t(
    [
      '哈希链是区块链之前就有的老技术：Merkle 在 1979 年提出，',
      'Certificate Transparency 用它公开记录全世界签发的每一张 TLS 证书，',
      'Git 的 commit 也是同一个结构 —— 改掉历史上任何一次提交，',
      '后面所有 commit 的 sha 都得跟着变。',
      '',
      '真实的审计系统还会做一件这一关没做的事：**把链的头部发到别处**。',
      '本地链能证明「没人在本地悄悄改过」，但拿到写权限的人可以把整条链重建。',
      '定期把最新的 hash 写到一个只能追加的外部系统（另一个团队的存储、',
      '甚至打印出来），才能让重建也露馅。',
      '',
      '登录锁定这一侧，业界的共识这几年变了：单纯的「N 次失败就锁定」',
      '本身是一种拒绝服务手段 —— 攻击者可以故意锁掉任何人的账号。',
      'NIST SP 800-63B 现在推荐的是**指数退避加速率限制**，配合',
      '「已泄露密码库比对」，而不是一刀切的锁定。这一关做的是最简单的那种，',
      '它的问题也正好是这个：想想看，谁能锁掉别人的账号？',
    ].join('\n'),
    [
      'Hash chains predate blockchains by decades: Merkle proposed them in 1979, Certificate Transparency uses',
      'one to publicly log every TLS certificate issued anywhere, and a Git commit is the same structure —',
      'rewrite any commit in history and every sha after it has to change.',
      '',
      'Real audit systems do one thing this stage does not: **publish the head of the chain elsewhere.** A',
      'local chain proves nobody quietly edited it locally, but whoever gains write access can rebuild the',
      'whole thing. Periodically writing the latest hash into an append-only external system — another team\'s',
      'storage, or literally printed on paper — is what makes a rebuild visible.',
      '',
      'On the lockout side, the consensus shifted in recent years: plain "lock after N failures" is itself a',
      'denial of service, since an attacker can deliberately lock anyone out. NIST SP 800-63B now recommends',
      'exponential backoff with rate limiting, combined with checks against breached-password lists, rather',
      'than a blanket lockout. This stage builds the simplest version, and its weakness is exactly that: think',
      'about who gets to lock whose account.',
    ].join('\n')
  ),
  focus: ['correctness', 'resilience', 'encapsulation'],
  lab: {},
  starterFiles: [
    file(
      'src/audit.ts',
      code`
        import { COLLECTIONS } from './contract';
        import type { CredentialStore } from './credentials';
        import type { Store } from './support/store';
        import { hmac } from './support/crypto';
        import { now } from '@lab/env';

        export interface AuditEvent {
          actor: string;
          tenantId: string;
          /** For example auth:login */
          action: string;
          outcome: 'allow' | 'deny';
          /** Extra detail. Any secrets inside it must be redacted. */
          detail?: Record<string, unknown>;
        }

        export interface AuditEntry {
          /** Contiguous, starting at 1 */
          seq: number;
          at: number;
          actor: string;
          tenantId: string;
          action: string;
          outcome: string;
          detail: Record<string, unknown>;
          prevHash: string;
          hash: string;
        }

        export interface AuditLog {
          record(event: AuditEvent): AuditEntry;
          entries(): AuditEntry[];
          /** The index of the first break; -1 when the chain is intact */
          verifyChain(): number;
        }

        export interface AuditOptions {
          /** The key for the chain HMAC. It is not in the database, and that is the entire point. */
          secret: string;
        }

        export function createAuditLog(store: Store, options: AuditOptions): AuditLog {
          // TODO: implement this
          throw new Error('not implemented');
        }

        export interface LoginOptions {
          /** How many consecutive failures before locking */
          maxAttempts: number;
          /** How long the lock lasts */
          lockoutMs: number;
        }

        export interface LoginResult {
          ok: boolean;
          reason: 'ok' | 'invalid-credentials' | 'locked';
        }

        export interface HardenedLogin {
          login(input: { userId: string; password: string; tenantId: string }): Promise<LoginResult>;
        }

        export function createHardenedLogin(
          store: Store,
          credentials: CredentialStore,
          audit: AuditLog,
          options: LoginOptions
        ): HardenedLogin {
          // TODO: implement this
          throw new Error('not implemented');
        }
      `,
      { openByDefault: true }
    ),
  ],
  specs: [
    spec(
      'specs/stage-12.spec.ts',
      code`
        import { createAuditLog, createHardenedLogin } from '../src/audit';
        import { createCredentialStore } from '../src/credentials';
        import { COLLECTIONS } from '../src/contract';
        import { createStore } from '../src/support/store';
        import { sleep } from '@lab/env';
        import { count, getCounters } from '@lab/metrics';

        const PASSWORD = 'correct horse battery staple';
        const MAX_ATTEMPTS = 3;
        const LOCKOUT = 60000;

        async function setup() {
          const store = createStore();
          const credentials = createCredentialStore();
          await credentials.register('alice', PASSWORD);
          await credentials.register('bob', 'bobs-password');
          const audit = createAuditLog(store, { secret: 'audit-chain-key' });
          const guard = createHardenedLogin(store, credentials, audit, {
            maxAttempts: MAX_ATTEMPTS,
            lockoutMs: LOCKOUT,
          });
          return { store, audit, guard };
        }

        async function failLogin(guard: any, times: number, userId = 'alice') {
          for (let index = 0; index < times; index += 1) {
            await guard.login({ userId, password: 'wrong-guess', tenantId: 'acme' });
          }
        }

        describe('Stage 12 · Audit chain and login hardening', () => {
          it('both successful and failed logins leave an audit entry', async () => {
            const context = await setup();

            await context.guard.login({ userId: 'alice', password: PASSWORD, tenantId: 'acme' });
            await failLogin(context.guard, 1);

            const entries = context.audit.entries();
            if (entries.length < 2) count('auditGaps');
            expect(entries).toHaveLength(2);
            expect(entries[0].outcome).toBe('allow');
            expect(entries[1].outcome).toBe('deny');
          });

          it('audit entries are numbered contiguously and the chain verifies', async () => {
            const context = await setup();
            await failLogin(context.guard, 2);
            await context.guard.login({ userId: 'alice', password: PASSWORD, tenantId: 'acme' });

            const entries = context.audit.entries();
            entries.forEach((entry: any, index: number) => {
              if (entry.seq !== index + 1) count('auditGaps');
              expect(entry.seq).toBe(index + 1);
            });

            const broken = context.audit.verifyChain();
            if (broken >= 0) count('auditGaps');
            expect(broken).toBe(-1);
          });

          it('altering one record makes chain verification point at its position', async () => {
            const context = await setup();
            await failLogin(context.guard, 3);

            const keys = context.store.keys(COLLECTIONS.audit).sort();
            const record = context.store.get(COLLECTIONS.audit, keys[1]);
            context.store.put(COLLECTIONS.audit, keys[1], { ...record, actor: 'somebody-else' });

            const broken = context.audit.verifyChain();
            if (broken < 0) count('auditGaps');
            expect(broken).toBeGreaterThanOrEqual(0);
          });

          it('deleting one record is detected by chain verification too', async () => {
            const context = await setup();
            await failLogin(context.guard, 3);

            const keys = context.store.keys(COLLECTIONS.audit).sort();
            context.store.remove(COLLECTIONS.audit, keys[1]);

            const broken = context.audit.verifyChain();
            if (broken < 0) count('auditGaps');
            expect(broken).toBeGreaterThanOrEqual(0);
          });

          it('no plaintext password appears in the audit log', async () => {
            const context = await setup();
            await failLogin(context.guard, 2);
            await context.guard.login({ userId: 'alice', password: PASSWORD, tenantId: 'acme' });

            const dump = JSON.stringify(context.audit.entries());
            if (dump.indexOf(PASSWORD) >= 0) count('secretsInAudit');
            if (dump.indexOf('wrong-guess') >= 0) count('secretsInAudit');
            expect(dump).not.toContain(PASSWORD);
          });

          it('secrets passed in when recording an event are redacted', async () => {
            const context = await setup();

            context.audit.record({
              actor: 'alice',
              tenantId: 'acme',
              action: 'token:issue',
              outcome: 'allow',
              detail: {
                refreshToken: 'rt_super-secret-value',
                password: 'plaintext-password',
                note: 'this one is fine',
              },
            });

            const dump = JSON.stringify(context.audit.entries());
            if (dump.indexOf('rt_super-secret-value') >= 0) count('secretsInAudit');
            if (dump.indexOf('plaintext-password') >= 0) count('secretsInAudit');
            expect(dump).toContain('this one is fine');
          });

          it('secrets nested inside objects are redacted too', async () => {
            const context = await setup();

            context.audit.record({
              actor: 'alice',
              tenantId: 'acme',
              action: 'client:register',
              outcome: 'allow',
              detail: { request: { body: { clientSecret: 'sk-nested-secret' }, ip: '10.0.0.1' } },
            });

            const dump = JSON.stringify(context.audit.entries());
            if (dump.indexOf('sk-nested-secret') >= 0) count('secretsInAudit');
            expect(dump).toContain('10.0.0.1');
          });

          it('the account locks once consecutive failures reach the limit', async () => {
            const context = await setup();
            await failLogin(context.guard, MAX_ATTEMPTS);

            const result = await context.guard.login({
              userId: 'alice',
              password: 'wrong-guess',
              tenantId: 'acme',
            });
            expect(result.reason).toBe('locked');
          });

          it('even the right password does not get in while locked', async () => {
            const context = await setup();
            await failLogin(context.guard, MAX_ATTEMPTS);

            const result = await context.guard.login({
              userId: 'alice',
              password: PASSWORD,
              tenantId: 'acme',
            });
            if (result.ok) count('bruteForceAccepted');
            expect(result.ok).toBe(false);
            expect(result.reason).toBe('locked');
          });

          it('no slow hash is computed while locked', async () => {
            const context = await setup();
            await failLogin(context.guard, MAX_ATTEMPTS);

            const before = getCounters()['kdfRounds'] || 0;
            await context.guard.login({ userId: 'alice', password: PASSWORD, tenantId: 'acme' });
            const after = getCounters()['kdfRounds'] || 0;

            // The rejection is a foregone conclusion, so that hash is pure wasted CPU an attacker
            // can trigger without limit
            expect(after).toBe(before);
          });

          it('login works again once the lock expires', async () => {
            const context = await setup();
            await failLogin(context.guard, MAX_ATTEMPTS);

            await sleep(LOCKOUT);
            const result = await context.guard.login({
              userId: 'alice',
              password: PASSWORD,
              tenantId: 'acme',
            });
            expect(result.ok).toBe(true);
          });

          it('a successful login resets the failure count', async () => {
            const context = await setup();
            await failLogin(context.guard, MAX_ATTEMPTS - 1);
            await context.guard.login({ userId: 'alice', password: PASSWORD, tenantId: 'acme' });

            await failLogin(context.guard, MAX_ATTEMPTS - 1);
            const result = await context.guard.login({
              userId: 'alice',
              password: PASSWORD,
              tenantId: 'acme',
            });
            if (!result.ok) count('auditGaps');
            expect(result.ok).toBe(true);
          });

          it('the lock applies to this account only', async () => {
            const context = await setup();
            await failLogin(context.guard, MAX_ATTEMPTS);

            const result = await context.guard.login({
              userId: 'bob',
              password: 'bobs-password',
              tenantId: 'acme',
            });
            expect(result.ok).toBe(true);
          });

          it('attempts made while locked are audited as well', async () => {
            const context = await setup();
            await failLogin(context.guard, MAX_ATTEMPTS);
            const before = context.audit.entries().length;

            await context.guard.login({ userId: 'alice', password: PASSWORD, tenantId: 'acme' });

            const after = context.audit.entries().length;
            if (after === before) count('auditGaps');
            expect(after).toBe(before + 1);
          });
        });
      `
    ),
  ],
  gates: [
    gate({
      metric: 'counters.auditGaps',
      op: 'eq',
      value: 0,
      zh: '审计链没有缺口，改动一律验得出来',
      en: 'The audit chain has no holes and every edit is detected',
      dimension: 'resilience',
    }),
    gate({
      metric: 'counters.secretsInAudit',
      op: 'eq',
      value: 0,
      zh: '审计里不含任何秘密',
      en: 'No secret ever reaches the audit log',
      dimension: 'correctness',
    }),
    gate({
      metric: 'counters.bruteForceAccepted',
      op: 'eq',
      value: 0,
      zh: '锁定期间一次都没放行',
      en: 'Nothing is admitted during a lockout',
      dimension: 'resilience',
    }),
  ],
  referenceFiles: [
    file(
      'src/audit.ts',
      code`
        import { COLLECTIONS } from './contract';
        import type { CredentialStore } from './credentials';
        import type { Store } from './support/store';
        import { hmac } from './support/crypto';
        import { now } from '@lab/env';

        export interface AuditEvent {
          actor: string;
          tenantId: string;
          action: string;
          outcome: 'allow' | 'deny';
          detail?: Record<string, unknown>;
        }

        export interface AuditEntry {
          seq: number;
          at: number;
          actor: string;
          tenantId: string;
          action: string;
          outcome: string;
          detail: Record<string, unknown>;
          prevHash: string;
          hash: string;
        }

        export interface AuditLog {
          record(event: AuditEvent): AuditEntry;
          entries(): AuditEntry[];
          verifyChain(): number;
        }

        export interface AuditOptions {
          secret: string;
        }

        /** The start of the chain. The first entry's prevHash points at it. */
        const GENESIS = 'genesis';
        const MASK = '[redacted]';
        const KEY_WIDTH = 6;
        /** A field whose name contains one of these words is treated as a secret */
        const SENSITIVE = ['password', 'secret', 'token', 'authorization', 'verifier', 'code'];

        function isSensitive(key: string): boolean {
          const lower = key.toLowerCase();
          return SENSITIVE.some((word) => lower.indexOf(word) >= 0);
        }

        function redactValue(value: unknown): unknown {
          if (!value || typeof value !== 'object') return value;
          if (Array.isArray(value)) return value.map(redactValue);
          return redact(value as Record<string, unknown>);
        }

        /** Recursive redaction: secrets often hide inside nested structures such as a whole request body */
        function redact(detail: Record<string, unknown>): Record<string, unknown> {
          const clean: Record<string, unknown> = {};
          for (const key of Object.keys(detail)) {
            clean[key] = isSensitive(key) ? MASK : redactValue(detail[key]);
          }
          return clean;
        }

        export function createAuditLog(store: Store, options: AuditOptions): AuditLog {
          function bodyOf(entry: AuditEntry): string {
            return [
              entry.seq,
              entry.at,
              entry.actor,
              entry.tenantId,
              entry.action,
              entry.outcome,
              JSON.stringify(entry.detail),
              entry.prevHash,
            ].join('|');
          }

          /**
           * HMAC rather than a plain digest: someone who can edit the database should not be able
           * to recompute this value
           */
          function hashOf(entry: AuditEntry): string {
            return hmac(options.secret, bodyOf(entry));
          }

          function keyOf(seq: number): string {
            return String(seq).padStart(KEY_WIDTH, '0');
          }

          function all(): AuditEntry[] {
            const keys = store.keys(COLLECTIONS.audit).sort();
            const found: AuditEntry[] = [];
            for (const key of keys) {
              const record = store.get(COLLECTIONS.audit, key);
              if (record) found.push(record as unknown as AuditEntry);
            }
            return found;
          }

          return {
            record(event: AuditEvent): AuditEntry {
              const existing = all();
              const previous = existing[existing.length - 1];
              const entry: AuditEntry = {
                seq: previous ? previous.seq + 1 : 1,
                at: now(),
                actor: event.actor,
                tenantId: event.tenantId,
                action: event.action,
                outcome: event.outcome,
                detail: redact(event.detail || {}),
                prevHash: previous ? previous.hash : GENESIS,
                hash: '',
              };
              entry.hash = hashOf(entry);
              store.put(COLLECTIONS.audit, keyOf(entry.seq), entry as unknown as Record<string, unknown>);
              return entry;
            },

            entries(): AuditEntry[] {
              return all();
            },

            verifyChain(): number {
              let expected = GENESIS;
              const list = all();
              for (let index = 0; index < list.length; index += 1) {
                const entry = list[index];
                // Three kinds of break: a skipped number, a mismatch with the previous entry, or
                // altered content
                if (entry.seq !== index + 1) return index;
                if (entry.prevHash !== expected) return index;
                if (entry.hash !== hashOf(entry)) return index;
                expected = entry.hash;
              }
              return -1;
            },
          };
        }

        export interface LoginOptions {
          maxAttempts: number;
          lockoutMs: number;
        }

        export interface LoginResult {
          ok: boolean;
          reason: 'ok' | 'invalid-credentials' | 'locked';
        }

        export interface HardenedLogin {
          login(input: { userId: string; password: string; tenantId: string }): Promise<LoginResult>;
        }

        interface LockState {
          failures: number;
          lockedUntil: number;
        }

        export function createHardenedLogin(
          store: Store,
          credentials: CredentialStore,
          audit: AuditLog,
          options: LoginOptions
        ): HardenedLogin {
          function stateOf(userId: string): LockState {
            const record = store.get(COLLECTIONS.lockouts, userId) as unknown as LockState | undefined;
            if (!record) return { failures: 0, lockedUntil: 0 };
            // Once the lock expires, treat it as starting over; no separate cleanup task is needed
            if (record.lockedUntil && record.lockedUntil <= now()) return { failures: 0, lockedUntil: 0 };
            return record;
          }

          function save(userId: string, state: LockState): void {
            store.put(COLLECTIONS.lockouts, userId, state as unknown as Record<string, unknown>);
          }

          function trace(userId: string, tenantId: string, outcome: 'allow' | 'deny', reason: string): void {
            audit.record({ actor: userId, tenantId, action: 'auth:login', outcome, detail: { reason } });
          }

          return {
            async login(input: { userId: string; password: string; tenantId: string }): Promise<LoginResult> {
              const state = stateOf(input.userId);

              // The lock check comes before the password check: the outcome is already decided, so
              // that slow hash is pure waste
              if (state.lockedUntil > now()) {
                trace(input.userId, input.tenantId, 'deny', 'locked');
                return { ok: false, reason: 'locked' };
              }

              const matched = await credentials.verify(input.userId, input.password);
              if (matched) {
                save(input.userId, { failures: 0, lockedUntil: 0 });
                trace(input.userId, input.tenantId, 'allow', 'ok');
                return { ok: true, reason: 'ok' };
              }

              const failures = state.failures + 1;
              const locked = failures >= options.maxAttempts;
              save(input.userId, { failures, lockedUntil: locked ? now() + options.lockoutMs : 0 });
              trace(input.userId, input.tenantId, 'deny', 'invalid-credentials');
              return { ok: false, reason: 'invalid-credentials' };
            },
          };
        }
      `
    ),
  ],
  referenceNotes: t(
    [
      '三个决定：',
      '',
      '**`trace()` 是个小函数，三条路径各调一次。** 把审计收成一行，',
      '「有没有哪条路径漏了」就变成看得见的事 —— 三个 return，三次 trace，一眼能数。',
      '散着写的话，漏掉的那一条永远是失败路径上的那个提前 return。',
      '',
      '**链的哈希是 HMAC，密钥不在库里。** 这一点决定了这条链到底防谁：',
      '普通摘要防的是「改了没发现」，HMAC 防的是「有人改了还想让你发现不了」。',
      '拿到数据库写权限的攻击者能重算前者，不能重算后者。',
      '',
      '**锁定状态过期即视为清零，不做清理任务。** `stateOf` 读到一个已经过去的',
      '`lockedUntil` 就返回一个干净的状态。这样系统里不需要任何定时任务，',
      '也不会出现「清理任务挂了导致所有人被永久锁定」这种事故。',
      '',
      '还有一处顺序：`record` 里先算 `detail` 的脱敏，再算 hash。',
      '反过来的话，链上钉住的是**未脱敏**的内容 —— 秘密没进库，',
      '但它的哈希进了，而哈希对于低熵的秘密来说和明文差不多。',
    ].join('\n'),
    [
      'Three decisions:',
      '',
      '`trace()` is a small function called once on each path. Collapsing the audit into one line makes "did a',
      'path skip it" visible — three returns, three traces, countable at a glance. Spread inline, the one that',
      'goes missing is always the early return on the failure path.',
      '',
      'The chain hashes with an HMAC whose key is not in the database. That decides who the chain defends',
      'against: a plain digest catches "changed and nobody noticed", an HMAC catches "someone changed it and',
      'wanted you not to notice". An attacker with write access can recompute the first, not the second.',
      '',
      'An expired lockout reads as a clean state, with no cleanup job. `stateOf` sees a `lockedUntil` in the',
      'past and returns zeroes, so the system needs no scheduled task and cannot suffer the "the cleanup job',
      'died and everyone is permanently locked out" incident.',
      '',
      'One more ordering detail: `record` redacts the detail before hashing. The other way round, the chain',
      'pins the **unredacted** content — the secret never entered the database, but its hash did, and for a',
      'low-entropy secret a hash is nearly the plaintext.',
    ].join('\n')
  ),
};

/* ------------------------------------------------------------------ */

module.exports = {
  id: 'enterprise-auth',
  title: t('企业级鉴权授权系统', 'Enterprise authentication and authorisation'),
  summary: t(
    '先把密码存对，再处理会话、MFA、OAuth 与 OIDC。后半程转向权限模型、租户隔离和审计，共十二关。',
    'Store passwords correctly, then handle sessions, MFA, OAuth and OIDC. The later stages cover permission models, tenant isolation and audit hardening across twelve stages.'
  ),
  difficulty: 'Hard',
  domain: 'security',
  tags: [
    'authentication',
    'authorization',
    'oauth2',
    'oidc',
    'jwt',
    'rbac',
    'abac',
    'multi-tenancy',
    'audit',
  ],
  estimatedMinutes: 600,
  language: 'typescript',
  weights: {
    correctness: 3,
    concurrency: 1,
    latency: 1,
    resilience: 2.5,
    encapsulation: 2,
    elegance: 1.5,
  },
  brief: t(
    [
      '## 背景',
      '',
      '「登录」这两个字底下压着两个完全不同的问题：**你是谁**（认证），和**你能做什么**（授权）。',
      '一套企业级的鉴权系统就是把这两个问题拆成十来个互相咬合的零件：',
      '',
      '| 层 | 关卡 | 回答的问题 |',
      '| --- | --- | --- |',
      '| 凭据 | 1 | 密码怎么存才敢说「泄露了也不至于全丢」 |',
      '| 会话 | 2-4 | 认过一次之后，接下来每个请求凭什么放行，怎么收回 |',
      '| 多因素与联邦 | 5-7 | 密码之外还要什么，以及怎么信任别人签发的身份 |',
      '| 授权 | 8-10 | 「能不能做这件事」怎么算，怎么算得快 |',
      '| 边界与追责 | 11-12 | 数据不串租户，出事之后查得清 |',
      '',
      '十二关做完，你手上是一套能签发和撤销会话、支持 MFA 与第三方登录、',
      '按角色和属性判权、多租户隔离、并且每一步都留下不可篡改审计的鉴权系统。',
      '',
      '## 平台提供什么',
      '',
      '`src/support/crypto.ts` 是只读的密码学工具箱。它不是真的 SHA-256，但保留了要紧的性质：',
      '',
      '```ts',
      'await slowHash(password, salt, rounds); // 按轮数推进虚拟时钟，并记进 counters.kdfRounds',
      'hmac(secret, message);                  // 不知道密钥就算不出来',
      'constantTimeEqual(a, b);                // 每次调用都会被记一笔',
      'verifyRsa(publicKey, message, sig);     // 公钥只能验、不能签',
      '```',
      '',
      '`src/support/store.ts` 是只读的服务端存储。把它当数据库：',
      '**进程重启后还在的东西才算存进来了** —— 用例会用同一个 store 重建一个新的服务实例，',
      '藏在模块变量里的会话和撤销记录活不过那一步。它还会记账跨租户的读取。',
      '',
      '## 这十二关怎么串起来',
      '',
      '每一关补的都是上一关留下的洞，而且是**真的**留着的洞：',
      '',
      '- 第 2 关的会话令牌是无状态的，于是「怎么提前收回」成了第 3、4 关；',
      '- 第 3 关的刷新令牌能轮转，于是「旧的那份被人捡走了怎么办」成了重放检测；',
      '- 第 8 关算得出权限，但每次请求都要走一遍角色图，于是有了第 10 关的缓存；',
      '- 第 10 关的缓存会过期不及时，于是「撤了权还能用多久」成了它自己的门槛。',
      '',
      '## 硬性约束',
      '',
      '1. 服务端任何地方都不得出现明文密码，审计日志里也不行；',
      '2. 令牌的载荷是**可读的**，签名保证的是不可篡改，不是不可见；',
      '3. 默认拒绝：没有明确允许的事情一律不许做；',
      '4. 撤销必须能在令牌自然过期之前生效；',
      '5. 每一次数据访问都带着租户作用域，没有例外。',
      '',
      '## 非目标',
      '',
      '- 不实现真正的密码学原语：平台的工具箱行为等价，但不要拿去保护真东西；',
      '- 不做用户注册流程、邮件验证、密码找回这些产品功能；',
      '- 不做真正的网络协议：OAuth 与 OIDC 只做**校验逻辑**，不做重定向与前端。',
      '',
      '## 术语',
      '',
      '- **KDF**：密钥派生函数，密码慢哈希用的就是它。',
      '- **访问令牌 / 刷新令牌**：前者短命、到处出示；后者长命、只对着签发方出示。',
      '- **令牌族（family）**：一条刷新链上的所有令牌，轮转时同族相连。',
      '- **纪元（epoch）**：一个单调递增的版本号，用一个数字撤销一整批令牌。',
      '- **TOTP**：基于时间的一次性密码，手机验证器里跳的那六位数。',
      '- **PKCE**：授权码交换时的证明码，防止授权码被中途截走使用。',
      '- **RBAC / ABAC**：按角色判权 / 按属性判权。',
    ].join('\n'),
    [
      '## Context',
      '',
      '"Log in" hides two entirely different questions: **who are you** (authentication) and **what may you',
      'do** (authorisation). An enterprise auth system is those two questions split into a dozen interlocking',
      'parts:',
      '',
      '| Layer | Stages | Questions it answers |',
      '| --- | --- | --- |',
      '| Credentials | 1 | How do you store a password so a leak is not a total loss |',
      '| Sessions | 2-4 | What admits the next request, and how do you take it back |',
      '| MFA and federation | 5-7 | What beyond a password, and how do you trust an identity someone else signed |',
      '| Authorisation | 8-10 | How is "may I do this" computed, and computed fast |',
      '| Boundaries and accountability | 11-12 | Data that never crosses tenants, and an audit trail that holds up |',
      '',
      'Twelve stages later you have a system that issues and revokes sessions, supports MFA and third-party',
      'login, decides by role and by attribute, isolates tenants, and leaves a tamper-evident trail behind',
      'every step.',
      '',
      '## What the platform gives you',
      '',
      '`src/support/crypto.ts` is a read-only crypto toolbox. It is not really SHA-256, but it keeps the',
      'properties that matter here:',
      '',
      '```ts',
      'await slowHash(password, salt, rounds); // advances the virtual clock, records counters.kdfRounds',
      'hmac(secret, message);                  // uncomputable without the key',
      'constantTimeEqual(a, b);                // every call is counted',
      'verifyRsa(publicKey, message, sig);     // a public key verifies, it cannot sign',
      '```',
      '',
      '`src/support/store.ts` is the read-only server-side store. Treat it as the database: **only what',
      'survives a restart counts as stored.** The specs rebuild a fresh service instance over the same store,',
      'and sessions or revocations hidden in module variables do not survive that. It also accounts for',
      'cross-tenant reads.',
      '',
      '## How the twelve stages connect',
      '',
      'Each stage fills a hole the previous one really did leave open:',
      '',
      '- stage 2 issues stateless session tokens, so "how do we take one back early" becomes stages 3 and 4;',
      '- stage 3 rotates refresh tokens, so "what if someone kept the old one" becomes replay detection;',
      '- stage 8 computes permissions but walks the role graph on every request, so stage 10 caches it;',
      '- stage 10\'s cache goes stale, so "how long does a revoked permission keep working" becomes its own gate.',
      '',
      '## Hard constraints',
      '',
      '1. A plaintext password must not appear anywhere on the server, audit logs included;',
      '2. A token payload is **readable**; the signature buys integrity, not secrecy;',
      '3. Default deny: anything not explicitly allowed is refused;',
      '4. Revocation has to take effect before the token would expire on its own;',
      '5. Every data access carries a tenant scope. No exceptions.',
      '',
      '## Non-goals',
      '',
      '- No real cryptographic primitives: the toolbox is behaviourally equivalent, but do not protect',
      '  anything real with it;',
      '- No signup flow, email verification or password recovery — those are product features;',
      '- No wire protocol: OAuth and OIDC here are **verification logic**, without redirects or a front end.',
      '',
      '## Glossary',
      '',
      '- KDF: key derivation function, what a slow password hash is built from.',
      '- Access token / refresh token: the first is short-lived and shown everywhere, the second is long-lived',
      '  and shown only to the issuer.',
      '- Family: all tokens on one refresh chain, linked as they rotate.',
      '- Epoch: a monotonic version number that revokes a whole batch of tokens with a single integer.',
      '- TOTP: the six digits ticking in an authenticator app.',
      '- PKCE: the proof key that stops a stolen authorization code from being redeemed by the thief.',
      '- RBAC / ABAC: deciding by role / deciding by attribute.',
    ].join('\n')
  ),
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  PW["password"] --> CR["1 credential store"]',
      '  CR --> MFA["5 TOTP and recovery codes"]',
      '  MFA --> SS["2 session token"]',
      '  IDP["external IdP"] --> OA["6 code and PKCE"]',
      '  OA --> OI["7 ID token verification"]',
      '  OI --> SS',
      '  SS --> RF["3 refresh rotation"]',
      '  RF --> RV["4 revocation and epoch"]',
      '  RV --> GUARD["request guard"]',
      '  GUARD --> RB["8 RBAC role graph"]',
      '  RB --> AB["9 ABAC conditions"]',
      '  AB --> PC["10 permission cache"]',
      '  PC --> TN["11 tenant scoped data"]',
      '  TN --> AU["12 audit chain and lockout"]',
      '```',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  PW["password"] --> CR["1 credential store"]',
      '  CR --> MFA["5 TOTP and recovery codes"]',
      '  MFA --> SS["2 session token"]',
      '  IDP["external IdP"] --> OA["6 code and PKCE"]',
      '  OA --> OI["7 ID token verification"]',
      '  OI --> SS',
      '  SS --> RF["3 refresh rotation"]',
      '  RF --> RV["4 revocation and epoch"]',
      '  RV --> GUARD["request guard"]',
      '  GUARD --> RB["8 RBAC role graph"]',
      '  RB --> AB["9 ABAC conditions"]',
      '  AB --> PC["10 permission cache"]',
      '  PC --> TN["11 tenant scoped data"]',
      '  TN --> AU["12 audit chain and lockout"]',
      '```',
    ].join('\n')
  ),
  files: [contract, crypto, store],
  stages: [stage1, stage2, stage3, stage4, stage5, stage6, stage7, stage8, stage9, stage10, stage11, stage12],
};
