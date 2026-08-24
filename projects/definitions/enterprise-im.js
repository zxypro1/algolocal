/**
 * 工程实战 · 企业级 IM 通讯系统
 *
 * 注意：代码片段使用 String.raw 模板，不要在片段里写 `${}`。
 */
const { t, code, file, readonlyFile, spec, gate } = require('./_helpers');

/* ------------------------------------------------------------------ */
/* 平台提供的基础设施                                                   */
/* ------------------------------------------------------------------ */

const crypto = readonlyFile(
  'src/support/crypto.ts',
  code`
    /**
     * Device key ring and sealed envelopes (read-only, provided by the platform).
     *
     * Stage 10 turns the server into a router that cannot read what it routes.
     * That only means something if the server genuinely has no way in, so the
     * envelope is manufactured here and nowhere else:
     *
     * - seal is the only function that produces a SealedEnvelope, and it needs
     *   the recipient device's public key;
     * - open needs that device's private key, which lives on the device;
     * - the transport recognises a sealed envelope by a brand this module owns,
     *   so "pretend it is encrypted" is not a thing you can do.
     *
     * The cipher is deliberately a toy — the point of the stage is the key
     * management and the fan-out arithmetic, not the primitive.
     */
    import { count } from '@lab/metrics';

    export interface DeviceKeyPair {
      deviceId: string;
      publicKey: string;
      privateKey: string;
    }

    /** What the server is allowed to hold: a blob addressed to one device. */
    export interface SealedEnvelope {
      /** Brand. Only this module sets it. */
      readonly sealed: true;
      /** Which device can open it */
      deviceId: string;
      ciphertext: string;
      /** Ratchet position for this sender/recipient pair */
      counter: number;
    }

    export interface KeyRing {
      /** A device comes online for the first time and publishes a public key. */
      register(deviceId: string): DeviceKeyPair;
      publicKeyOf(deviceId: string): string | undefined;
      /**
       * Seal one plaintext for one device. Counts sealOperations.
       *
       * counter is the ratchet position. Reusing one for the same recipient
       * counts keyReuse — in a real ratchet that is a nonce reuse, which leaks
       * the xor of two plaintexts.
       */
      seal(deviceId: string, plaintext: string, counter: number): SealedEnvelope;
      /** Open an envelope. Throws unless the key pair matches the addressee. */
      open(keyPair: DeviceKeyPair, envelope: SealedEnvelope): string;
    }

    /** The transport uses this to tell ciphertext from plaintext on the wire. */
    export function isSealed(value: unknown): boolean {
      return !!value && typeof value === 'object' && (value as SealedEnvelope).sealed === true;
    }

    const KEY_SPACE = 0x10000;

    /** A reversible mix of the key and the ratchet position. Not cryptography. */
    function scramble(text: string, secret: number, counter: number): string {
      const mask = (secret + counter * 2654435761) % KEY_SPACE;
      let out = '';
      for (let index = 0; index < text.length; index += 1) {
        out += String.fromCharCode(text.charCodeAt(index) ^ ((mask + index) % 255));
      }
      return out;
    }

    function secretOf(key: string): number {
      let total = 0;
      for (let index = 0; index < key.length; index += 1) {
        total = (total * 31 + key.charCodeAt(index)) % KEY_SPACE;
      }
      return total;
    }

    export function createKeyRing(): KeyRing {
      const pairs = new Map<string, DeviceKeyPair>();
      /** deviceId + counter values already used, to catch ratchet reuse */
      const used = new Set<string>();

      return {
        register(deviceId: string): DeviceKeyPair {
          const existing = pairs.get(deviceId);
          if (existing) return { ...existing };
          const pair: DeviceKeyPair = {
            deviceId,
            publicKey: 'pk-' + deviceId,
            privateKey: 'sk-' + deviceId,
          };
          pairs.set(deviceId, pair);
          return { ...pair };
        },

        publicKeyOf(deviceId: string): string | undefined {
          const pair = pairs.get(deviceId);
          return pair ? pair.publicKey : undefined;
        },

        seal(deviceId: string, plaintext: string, counter: number): SealedEnvelope {
          const pair = pairs.get(deviceId);
          if (!pair) throw new Error('no published key for device ' + deviceId);
          count('sealOperations');

          const slot = deviceId + '#' + counter;
          if (used.has(slot)) count('keyReuse');
          used.add(slot);

          return {
            sealed: true,
            deviceId,
            ciphertext: scramble(plaintext, secretOf(pair.publicKey), counter),
            counter,
          };
        },

        open(keyPair: DeviceKeyPair, envelope: SealedEnvelope): string {
          if (!isSealed(envelope)) throw new Error('not a sealed envelope');
          if (envelope.deviceId !== keyPair.deviceId) {
            throw new Error('envelope is addressed to ' + envelope.deviceId);
          }
          const secret = secretOf('pk-' + keyPair.deviceId);
          return scramble(envelope.ciphertext, secret, envelope.counter);
        },
      };
    }
  `
);

const transport = readonlyFile(
  'src/support/transport.ts',
  code`
    /**
     * The connection hub (read-only, provided by the platform).
     *
     * Everything the server says to a device goes through push, which is why
     * the hub is where delivery is measured. Four things get counted here, and
     * every gate about fan-out cost in this project reads one of them:
     *
     * - framesPushed — how many frames actually reached the wire. Fan-out
     *   strategy, receipt aggregation and presence batching are all judged by it;
     * - pushToDeadConnection — a push at a socket the hub has already closed.
     *   The hub knows the socket is gone; your registry is the thing that does not;
     * - duplicatePush — the same (conversation, seq) handed to the same
     *   connection twice. A device that already has a message should not get it again;
     * - plaintextOnWire — a message frame whose payload is not a sealed
     *   envelope. Stage 10 gates on it; before that it is only a reading.
     *
     * The hub also stamps lastSeenAt on every heartbeat. Deciding when a
     * connection has gone quiet for too long is a policy question, so it is yours.
     */
    import { now } from '@lab/env';
    import { count } from '@lab/metrics';
    import { isSealed } from './crypto';

    export type FrameKind = 'message' | 'receipt' | 'presence' | 'control';

    export interface Frame {
      kind: FrameKind;
      /** Which conversation this frame is about, when it is about one */
      conversationId?: string;
      /** Position in that conversation, when the frame carries a message */
      seq?: number;
      payload?: unknown;
    }

    export interface ConnectionInfo {
      connectionId: string;
      userId: string;
      deviceId: string;
      /** Virtual-clock time of the last heartbeat the hub saw */
      lastSeenAt: number;
    }

    export interface Transport {
      /** A device dials in. Returns the connection id. */
      open(userId: string, deviceId: string): string;
      /** The socket goes away. Pushes after this count pushToDeadConnection. */
      close(connectionId: string): void;
      isOpen(connectionId: string): boolean;
      /** Which device is behind a connection; undefined if the hub never had it. */
      deviceOf(connectionId: string): string | undefined;
      /** The device says it is still there. Unknown connections are ignored. */
      heartbeat(connectionId: string): void;
      /** When the hub last heard from this connection; -1 if it never existed. */
      lastSeenAt(connectionId: string): number;
      push(connectionId: string, frame: Frame): void;
      /** Everything this connection received, in order. Used by the specs. */
      inbox(connectionId: string): Frame[];
      /** Every connection the hub still holds open. */
      connections(): ConnectionInfo[];
    }

    interface Connection extends ConnectionInfo {
      open: boolean;
      received: Frame[];
      /** conversation + seq already handed to this connection */
      seen: Set<string>;
    }

    export function createTransport(): Transport {
      const connections = new Map<string, Connection>();
      let nextId = 1;

      return {
        open(userId: string, deviceId: string): string {
          const connectionId = 'c' + nextId;
          nextId += 1;
          connections.set(connectionId, {
            connectionId,
            userId,
            deviceId,
            lastSeenAt: now(),
            open: true,
            received: [],
            seen: new Set<string>(),
          });
          return connectionId;
        },

        close(connectionId: string): void {
          const connection = connections.get(connectionId);
          if (connection) connection.open = false;
        },

        isOpen(connectionId: string): boolean {
          const connection = connections.get(connectionId);
          return !!connection && connection.open;
        },

        deviceOf(connectionId: string): string | undefined {
          const connection = connections.get(connectionId);
          return connection ? connection.deviceId : undefined;
        },

        heartbeat(connectionId: string): void {
          const connection = connections.get(connectionId);
          if (connection && connection.open) connection.lastSeenAt = now();
        },

        lastSeenAt(connectionId: string): number {
          const connection = connections.get(connectionId);
          return connection ? connection.lastSeenAt : -1;
        },

        push(connectionId: string, frame: Frame): void {
          const connection = connections.get(connectionId);
          if (!connection || !connection.open) {
            count('pushToDeadConnection');
            return;
          }

          count('framesPushed');

          if (frame.kind === 'message') {
            if (!isSealed(frame.payload)) count('plaintextOnWire');
            if (frame.conversationId && typeof frame.seq === 'number') {
              const key = frame.conversationId + '#' + frame.seq;
              if (connection.seen.has(key)) count('duplicatePush');
              connection.seen.add(key);
            }
          }

          connection.received.push({ ...frame });
        },

        inbox(connectionId: string): Frame[] {
          const connection = connections.get(connectionId);
          return connection ? connection.received.map((frame) => ({ ...frame })) : [];
        },

        connections(): ConnectionInfo[] {
          return Array.from(connections.values())
            .filter((connection) => connection.open)
            .map((connection) => ({
              connectionId: connection.connectionId,
              userId: connection.userId,
              deviceId: connection.deviceId,
              lastSeenAt: connection.lastSeenAt,
            }));
        },
      };
    }
  `
);

const store = readonlyFile(
  'src/support/store.ts',
  code`
    /**
     * Server-side storage (read-only, provided by the platform).
     *
     * The split that matters here is between **data** and **metadata**:
     *
     * - reading a message or an inbox entry hands you a record, and every record
     *   handed back counts one messagesScanned. That counter is what turns
     *   "how expensive is your unread count" from an opinion into a reading;
     * - counts, member lists and cursors are metadata. Reading them is free,
     *   because a real server keeps them in an index and so should you.
     *
     * Three things are audited as you write:
     *
     * - appending a clientMsgId a conversation already holds counts
     *   duplicateMessages — the same send arriving twice became two messages;
     * - appending a seq that is not count + 1 counts seqGaps;
     * - moving a cursor backwards counts cursorRegressions. The store still
     *   writes it: a cursor that silently refused to regress would hide the bug
     *   instead of teaching you to guard the write.
     *
     * putIndex holds numbers only. It is there for the lookups a server
     * legitimately keeps (clientMsgId to seq, for instance) and is deliberately
     * too narrow to hide message content in.
     */
    import { count } from '@lab/metrics';

    export type MessageState = 'live' | 'recalled' | 'edited';

    export interface MessageRecord {
      conversationId: string;
      /** Position in this conversation. Dense, starting at 1. */
      seq: number;
      senderId: string;
      /** Minted by the client before the send, and stable across retries */
      clientMsgId: string;
      /** A string before stage 10, a SealedEnvelope map after it */
      payload: unknown;
      sentAt: number;
      /** Stage 9 rewrites this in place */
      state?: MessageState;
      revisedAt?: number;
    }

    export interface InboxEntry {
      conversationId: string;
      seq: number;
      /** Copied from the message so a conversation list can sort without reading it */
      sentAt: number;
    }

    export interface ConversationMeta {
      conversationId: string;
      kind: 'direct' | 'group';
      members: string[];
    }

    export interface Store {
      /* --- conversations: metadata, free to read --- */
      putConversation(meta: ConversationMeta): void;
      getConversation(conversationId: string): ConversationMeta | undefined;
      conversationsOf(userId: string): string[];

      /* --- the conversation log: records are counted --- */
      appendMessage(record: MessageRecord): void;
      /** Up to max records from position index (0-based). Counts one per record. */
      readMessages(conversationId: string, index: number, max: number): MessageRecord[];
      /** How many records the log holds. Metadata, free. */
      messageCount(conversationId: string): number;
      /** Rewrite one record in place. Costs one scan and one write. */
      replaceMessage(conversationId: string, index: number, record: MessageRecord): void;

      /* --- per-member inbox: write-fan-out lands here --- */
      appendInbox(userId: string, entry: InboxEntry): void;
      readInbox(userId: string, index: number, max: number): InboxEntry[];
      inboxSize(userId: string): number;

      /* --- cursors: free, but monotonicity is audited --- */
      putCursor(table: string, ownerId: string, conversationId: string, value: number): void;
      /** 0 when the cursor was never set */
      getCursor(table: string, ownerId: string, conversationId: string): number;

      /* --- numeric index: free --- */
      putIndex(name: string, key: string, value: number): void;
      getIndex(name: string, key: string): number | undefined;
    }

    export function createStore(): Store {
      const conversations = new Map<string, ConversationMeta>();
      const logs = new Map<string, MessageRecord[]>();
      /** conversation + clientMsgId already appended */
      const minted = new Set<string>();
      const inboxes = new Map<string, InboxEntry[]>();
      const cursors = new Map<string, number>();
      const indexes = new Map<string, number>();

      function logOf(conversationId: string): MessageRecord[] {
        const existing = logs.get(conversationId);
        if (existing) return existing;
        const created: MessageRecord[] = [];
        logs.set(conversationId, created);
        return created;
      }

      function inboxOf(userId: string): InboxEntry[] {
        const existing = inboxes.get(userId);
        if (existing) return existing;
        const created: InboxEntry[] = [];
        inboxes.set(userId, created);
        return created;
      }

      function cursorKey(table: string, ownerId: string, conversationId: string): string {
        return table + '|' + ownerId + '|' + conversationId;
      }

      return {
        putConversation(meta: ConversationMeta): void {
          conversations.set(meta.conversationId, { ...meta, members: [...meta.members] });
        },

        getConversation(conversationId: string): ConversationMeta | undefined {
          const meta = conversations.get(conversationId);
          return meta ? { ...meta, members: [...meta.members] } : undefined;
        },

        conversationsOf(userId: string): string[] {
          return Array.from(conversations.values())
            .filter((meta) => meta.members.indexOf(userId) >= 0)
            .map((meta) => meta.conversationId);
        },

        appendMessage(record: MessageRecord): void {
          const log = logOf(record.conversationId);
          count('storeWrites');

          if (record.seq !== log.length + 1) count('seqGaps');

          const mintKey = record.conversationId + '|' + record.clientMsgId;
          if (minted.has(mintKey)) count('duplicateMessages');
          minted.add(mintKey);

          log.push({ ...record });
        },

        readMessages(conversationId: string, index: number, max: number): MessageRecord[] {
          const log = logOf(conversationId);
          const from = Math.max(0, index);
          const slice = log.slice(from, from + Math.max(0, max));
          for (let step = 0; step < slice.length; step += 1) count('messagesScanned');
          return slice.map((record) => ({ ...record }));
        },

        messageCount(conversationId: string): number {
          return logOf(conversationId).length;
        },

        replaceMessage(conversationId: string, index: number, record: MessageRecord): void {
          const log = logOf(conversationId);
          if (index < 0 || index >= log.length) throw new Error('no record at index ' + index);
          count('messagesScanned');
          count('storeWrites');
          log[index] = { ...record };
        },

        appendInbox(userId: string, entry: InboxEntry): void {
          count('inboxWrites');
          inboxOf(userId).push({ ...entry });
        },

        readInbox(userId: string, index: number, max: number): InboxEntry[] {
          const inbox = inboxOf(userId);
          const from = Math.max(0, index);
          const slice = inbox.slice(from, from + Math.max(0, max));
          for (let step = 0; step < slice.length; step += 1) count('messagesScanned');
          return slice.map((entry) => ({ ...entry }));
        },

        inboxSize(userId: string): number {
          return inboxOf(userId).length;
        },

        putCursor(table: string, ownerId: string, conversationId: string, value: number): void {
          const key = cursorKey(table, ownerId, conversationId);
          const current = cursors.get(key) || 0;
          if (value < current) count('cursorRegressions');
          cursors.set(key, value);
        },

        getCursor(table: string, ownerId: string, conversationId: string): number {
          return cursors.get(cursorKey(table, ownerId, conversationId)) || 0;
        },

        putIndex(name: string, key: string, value: number): void {
          indexes.set(name + '|' + key, value);
        },

        getIndex(name: string, key: string): number | undefined {
          return indexes.get(name + '|' + key);
        },
      };
    }
  `
);

const pushGateway = readonlyFile(
  'src/support/push.ts',
  code`
    /**
     * The OS push gateway (read-only, provided by the platform).
     *
     * This is the one hop that leaves your system: APNs, FCM, whatever the phone
     * vendor runs. Two properties of that hop are enforced here.
     *
     * A notification carries **routing and a badge, never content.** The struct
     * has three fields and the gateway counts pushLeakedContent for any other
     * property, any non-primitive value, and any string longer than
     * MAX_FIELD_CHARS. Once messages are end-to-end encrypted the server could
     * not put the text in even if it wanted to — but the habit has to come first,
     * because a notification is rendered on a lock screen by an OS you do not own.
     *
     * Every accepted notification counts pushNotifications. That is the number
     * a coalescing window is judged by: fifty messages in a burst is one
     * conversation waking up, not fifty reasons to buzz someone's pocket.
     */
    import { count } from '@lab/metrics';

    /** Longer than this and it is prose, which means it is content. */
    export const MAX_FIELD_CHARS = 64;

    export type WakeReason = 'message' | 'mention' | 'call';

    export interface Notification {
      /** Where to look, not what was said */
      conversationId: string;
      /** What the app icon should show */
      badge: number;
      reason: WakeReason;
    }

    export interface PushGateway {
      /** A device registers for wake-ups. */
      register(deviceId: string): string;
      /** Wake one device. Counts pushNotifications. */
      send(deviceToken: string, notification: Notification): void;
      /** What actually reached a device. Used by the specs. */
      delivered(deviceToken: string): Notification[];
    }

    const ALLOWED_FIELDS = ['conversationId', 'badge', 'reason'];

    function leaks(notification: Notification): boolean {
      const record = notification as unknown as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        if (ALLOWED_FIELDS.indexOf(key) < 0) return true;
        const value = record[key];
        if (value !== null && typeof value === 'object') return true;
        if (typeof value === 'string' && value.length > MAX_FIELD_CHARS) return true;
      }
      return false;
    }

    export function createPushGateway(): PushGateway {
      const tokens = new Map<string, Notification[]>();

      return {
        register(deviceId: string): string {
          const token = 'tok-' + deviceId;
          if (!tokens.has(token)) tokens.set(token, []);
          return token;
        },

        send(deviceToken: string, notification: Notification): void {
          const box = tokens.get(deviceToken);
          if (!box) throw new Error('unregistered device token: ' + deviceToken);
          count('pushNotifications');
          if (leaks(notification)) count('pushLeakedContent');
          box.push({ ...notification });
        },

        delivered(deviceToken: string): Notification[] {
          const box = tokens.get(deviceToken);
          return box ? box.map((notification) => ({ ...notification })) : [];
        },
      };
    }
  `
);

/* ------------------------------------------------------------------ */
/* 第 1 关 · 一个用户是好几台设备                                        */
/* ------------------------------------------------------------------ */

const stage1 = {
  id: 'connection-registry',
  title: t('第 1 关 · 连接注册与心跳', 'Stage 1 · Connections and heartbeats'),
  goal: t(
    [
      '在 IM 里，「发给张三」不是一个地址，是**一组地址**。',
      '',
      '张三有手机、笔记本、平板，还有一个忘了退出的旧手机。每一台都是一条连接，',
      '每一条都要收到这条消息。这和「发给一个消费者」完全不是一回事 ——',
      '消息队列里一条消息给一个消费者就结束了，IM 里它才刚开始。',
      '',
      '而连接是会死的，死法还不止一种：',
      '',
      '- 对端明确断开，hub 立刻知道；',
      '- 手机进了电梯，TCP 还开着，但那头已经没人了 —— 这叫半开连接，',
      '  只有「多久没听到心跳」能发现它。',
      '',
      '这一关先把这两件事做对，后面十一关的每一次投递都从这里出去。',
      '',
      '## 要实现什么',
      '',
      '在 `src/session/registry.ts` 实现 `createRegistry(transport, options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `attach(userId, deviceId)` | 一台设备接入，返回 hub 给的连接 id |',
      '| `beat(connectionId)` | 收到一次心跳 |',
      '| `reap()` | 摘掉已关闭的和静默超时的连接，返回被摘掉的 id |',
      '| `connectionsOf(userId)` | 这个用户还活着的连接，按接入顺序 |',
      '| `deliver(userId, frame)` | 推给这个用户的每一条活连接，返回推成功几条 |',
      '| `online(userId)` | 还有没有活连接 |',
      '',
      '「活着」= hub 那边还开着，**并且**距离上次心跳不到 `idleMs`。',
      '',
      '同一台设备重新接入时，它上一条连接要被替换掉，而不是并排留着 ——',
      '换个 Wi-Fi 就多一条僵尸连接的话，一天下来一台手机能攒出几十条。',
      '',
      '## 怎么算过',
      '',
      '- `deliver` 只推给这个用户，别的用户一帧都收不到',
      '  （门槛 `counters.framesPushed ≤ 3`：三设备用户收一条消息就是三帧，',
      '  同时在线的另一个两设备用户不该被捎带上）；',
      '- 对端把 socket 关了而 registry 还不知道时，`deliver` 一帧也不能往里推',
      '  （门槛 `counters.pushToDeadConnection = 0`，这个数由 hub 自己记）；',
      '- 静默超过 `idleMs` 的连接，`reap()` 之前也不该收到东西；',
      '- `reap()` 之后 `connectionsOf` 和 `online` 要跟着变；',
      '- 没见过的用户 `deliver` 返回 0，不抛异常。',
      '',
      '## 那个坑',
      '',
      '把「活着」判成「我的 map 里还有它」。',
      '',
      'registry 自己的 map 是**你**维护的，socket 的死活是**hub**知道的，',
      '这两件事之间没有任何自动的联系。只信自己的 map，代码会一直正确地',
      '往一个已经不存在的 socket 里写东西 —— 不报错，不抛异常，',
      '消息就是到不了，而 `pushToDeadConnection` 会把这个次数原样告诉你。',
    ].join('\n'),
    [
      'In an IM system, "send it to Alice" is not one address. It is **a set of them.**',
      '',
      'Alice has a phone, a laptop, a tablet and an old phone she forgot to sign out of. Each is a',
      'connection and each has to receive the message. This is the opposite of a message queue, where one',
      'message going to one consumer is the end of the story. Here it is the beginning.',
      '',
      'And connections die in more than one way:',
      '',
      '- the peer disconnects cleanly and the hub knows immediately;',
      '- the phone goes into a lift, TCP stays open, and nobody is home. That is a half-open connection,',
      '  and the only thing that finds it is "how long since we last heard a heartbeat".',
      '',
      'This stage gets those two right first, because every delivery in the eleven stages that follow',
      'leaves through here.',
      '',
      '## What to build',
      '',
      'Implement `createRegistry(transport, options)` in `src/session/registry.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `attach(userId, deviceId)` | A device dials in; returns the hub connection id |',
      '| `beat(connectionId)` | A heartbeat arrived |',
      '| `reap()` | Drop closed and silent connections; return what was dropped |',
      '| `connectionsOf(userId)` | This user\'s live connections, in attach order |',
      '| `deliver(userId, frame)` | Push to every live connection of the user; return how many got it |',
      '| `online(userId)` | Is there still a live connection |',
      '',
      '"Live" means the hub still has it open **and** the last heartbeat is less than `idleMs` ago.',
      '',
      'When the same device dials in again, its previous connection is replaced rather than kept',
      'alongside. One zombie per Wi-Fi switch adds up to dozens per phone per day.',
      '',
      '## What counts as passing',
      '',
      '- `deliver` reaches this user and nobody else (the `counters.framesPushed ≤ 3` gate: a',
      '  three-device user receiving one message is three frames, and the two-device user who happens to',
      '  be online too is not along for the ride);',
      '- when the peer closed the socket and the registry has not noticed, `deliver` puts nothing into it',
      '  (the `counters.pushToDeadConnection = 0` gate, counted by the hub itself);',
      '- a connection silent for longer than `idleMs` receives nothing, even before `reap()` runs;',
      '- after `reap()`, `connectionsOf` and `online` agree with it;',
      '- `deliver` to a user nobody has ever heard of returns 0 rather than throwing.',
      '',
      '## The trap',
      '',
      'Treating "live" as "still in my map".',
      '',
      'Your map is maintained by **you**; whether the socket is alive is known by **the hub**, and nothing',
      'connects those two facts automatically. Trust only the map and your code will go on correctly',
      'writing into a socket that no longer exists — no error, no exception, the message simply does not',
      'arrive. `pushToDeadConnection` is the hub telling you how many times that happened.',
    ].join('\n')
  ),

  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  A["attach(userId, deviceId)"] --> OLD{"这台设备已经有连接了？"}',
      '  OLD -- 有 --> KILL["transport.close(旧连接)<br/>从 map 里摘掉"]',
      '  OLD -- 没有 --> NEW',
      '  KILL --> NEW["transport.open(userId, deviceId)"]',
      '  NEW --> PUT["记进 byUser[userId]<br/>记进 owner[连接 id]"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  D["deliver(userId, frame)"] --> LIST["byUser[userId] 的连接列表"]',
      '  LIST --> EACH["逐条判断"]',
      '  EACH --> LIVE{"活着吗？<br/>isOpen 并且 now - lastSeenAt < idleMs"}',
      '  LIVE -- 活着 --> PUSH["transport.push(连接, frame)<br/>计数加一"]',
      '  LIVE -- 死了 --> DROP["从 map 里摘掉<br/>不推"]',
      '  PUSH --> MORE{"还有连接吗？"}',
      '  DROP --> MORE',
      '  MORE -- 有 --> EACH',
      '  MORE -- 没有 --> RET["返回推成功的条数"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  R["reap()"] --> SWEEP["遍历 owner 里的每一条"]',
      '  SWEEP --> LIVE2{"活着吗？"}',
      '  LIVE2 -- 死了 --> REMOVE["close + 从两张 map 里摘掉<br/>收进返回值"]',
      '  LIVE2 -- 活着 --> KEEP["留着"]',
      '```',
      '',
      '要点：判「活着」的那个菱形在 `deliver` 和 `reap` 里是同一个。',
      '只在 `reap` 里判的话，两次 `reap` 之间的投递照样会打进死连接。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  A["attach(userId, deviceId)"] --> OLD{"does this device already have one?"}',
      '  OLD -- yes --> KILL["transport.close(old)<br/>drop it from the map"]',
      '  OLD -- no --> NEW',
      '  KILL --> NEW["transport.open(userId, deviceId)"]',
      '  NEW --> PUT["record in byUser[userId]<br/>record in owner[connectionId]"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  D["deliver(userId, frame)"] --> LIST["the connection list for the user"]',
      '  LIST --> EACH["walk them"]',
      '  EACH --> LIVE{"live?<br/>isOpen and now - lastSeenAt < idleMs"}',
      '  LIVE -- live --> PUSH["transport.push(connection, frame)<br/>count it"]',
      '  LIVE -- dead --> DROP["drop from the map<br/>push nothing"]',
      '  PUSH --> MORE{"any left?"}',
      '  DROP --> MORE',
      '  MORE -- yes --> EACH',
      '  MORE -- no --> RET["return how many were pushed"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  R["reap()"] --> SWEEP["walk every tracked connection"]',
      '  SWEEP --> LIVE2{"live?"}',
      '  LIVE2 -- dead --> REMOVE["close, drop from both maps<br/>collect for the return value"]',
      '  LIVE2 -- live --> KEEP["keep"]',
      '```',
      '',
      'The point: the liveness diamond is the same one in `deliver` and in `reap`. Check it only in',
      '`reap` and every delivery between two sweeps still lands in a dead socket.',
    ].join('\n')
  ),

  checklist: [
    t('活连接 = hub 还开着 且 心跳未超时', 'Live means the hub has it open and the heartbeat has not expired'),
    t('deliver 之前逐条判活，不是只信自己的 map', 'deliver checks each connection instead of trusting the map'),
    t('同一设备重连替换旧连接', 'Reconnecting a device replaces its old connection'),
    t('reap 返回被摘掉的连接并更新 online', 'reap returns what it dropped and updates online'),
    t('未知用户 deliver 返回 0', 'deliver to an unknown user returns 0'),
  ],

  pitfalls: [
    t(
      '把自己的 map 当作连接是否存活的唯一依据。map 是你写的，socket 的死活是 hub 知道的，中间没有任何东西替你同步。真实系统里这表现为「消息发出去了，日志显示成功，对方就是没收到」—— 因为写进一个已关闭的 socket 在大多数运行时里既不抛异常也不返回错误。',
      'Treating your own map as the authority on whether a connection exists. You write the map; the hub knows about the socket; nothing synchronises them for you. In production this shows up as "the send succeeded according to the log and the user never got it", because writing to a closed socket usually neither throws nor returns an error.'
    ),
    t(
      '只在心跳超时的时候摘连接，不管 hub 已经报告关闭的那些。这两个信号覆盖的是不同的故障：明确断开是立刻可知的，半开连接只有超时能发现。只做后者，一次正常退出登录之后的每一条消息都会先打进那条已关的连接，直到超时才停。',
      'Reaping only on heartbeat timeout and ignoring connections the hub already reported closed. The two signals cover different failures: a clean disconnect is known immediately, a half-open socket is only found by the timeout. Do only the second and every message after a normal sign-out goes into the closed connection until the idle window elapses.'
    ),
    t(
      '同一台设备重连时把新连接追加进去，不动旧的。旧连接要么已经关了（于是每次投递都撞一次死连接），要么还半开着（于是同一条消息在同一台设备上出现两次）。IM 里设备重连是常态而不是异常 —— 地铁、电梯、Wi-Fi 切 4G，一天几十次。',
      'Appending the new connection when a device reconnects and leaving the old one. The old one is either already closed, so every delivery hits a dead socket, or still half-open, so the same message arrives twice on the same device. Reconnection is the normal case in IM, not the exceptional one: lifts, tunnels, Wi-Fi handing over to cellular, dozens of times a day.'
    ),
    t(
      '让 `deliver` 顺手把超时的连接也「续一秒」—— 比如推送成功就更新 lastSeenAt。心跳是**对端**还活着的证据，你自己写出去的字节不是。这样写出来的连接永远不会超时，半开连接会一直留在列表里，直到 TCP 自己在几十分钟后放弃。',
      'Letting `deliver` refresh the idle timer — bumping lastSeenAt because a push succeeded. A heartbeat is evidence the **peer** is alive; bytes you wrote yourself are not. Do this and a connection never expires, so half-open sockets stay in the list until TCP gives up on its own half an hour later.'
    ),
  ],

  hints: [
    t(
      '两张 map 就够：`byUser: userId -> 连接 id 数组`（保序）和 `owner: 连接 id -> { userId, deviceId }`。摘一条连接的时候两张都要动。',
      'Two maps are enough: `byUser` from user id to an ordered array of connection ids, and `owner` from connection id to its user and device. Dropping a connection touches both.'
    ),
    t(
      '把「活着吗」写成一个私有函数，`deliver`、`reap`、`connectionsOf`、`online` 全都调它。四个地方各写一遍判断条件，迟早有一个会漏掉 `isOpen`。',
      'Write the liveness test once as a private function and have `deliver`, `reap`, `connectionsOf` and `online` all call it. Inline the condition in four places and one of them will eventually forget `isOpen`.'
    ),
  ],

  extension: t(
    [
      '真实系统里这一层叫「接入层」或者 gateway，微信、Slack、Signal 都有。',
      '它通常和业务逻辑分开部署，因为它的资源画像完全不同：几乎不吃 CPU，',
      '但要为每条连接常驻一小块内存，一台机器扛几十万条长连接是常态。',
      '',
      '心跳间隔是个有讲究的数：太长发现不了半开连接，太短会把手机的射频',
      '一直唤醒着，非常耗电。微信早年公开过的做法是**自适应心跳** ——',
      '在能保活的前提下不断试探更长的间隔，因为运营商 NAT 的超时时间各不相同',
      '（常见 5 分钟到 30 分钟）。发得比 NAT 超时慢一点，连接就被中间设备悄悄丢掉了。',
      '',
      'WebSocket 自带 ping/pong 帧，但它只证明 TCP 通，不证明**应用层**还活着 ——',
      '一个卡死在死锁里的进程，内核照样会回 pong。所以生产系统一般还是自己在',
      '应用层再发一次心跳。',
    ].join('\n'),
    [
      'This layer is usually called the access layer or the gateway, and WeChat, Slack and Signal all have',
      'one. It tends to be deployed separately from business logic because its resource profile is nothing',
      'like it: almost no CPU, but a resident slab of memory per connection, with a few hundred thousand',
      'long-lived connections per box being unremarkable.',
      '',
      'The heartbeat interval is a genuinely interesting number. Too long and half-open connections go',
      'unnoticed; too short and the phone radio never sleeps, which costs battery. WeChat published an',
      '**adaptive heartbeat** approach years ago: probe for the longest interval that still keeps the',
      'connection alive, because carrier NAT timeouts vary wildly (five to thirty minutes is the usual',
      'range). Send slower than the NAT timeout and a middlebox drops the connection without telling',
      'anyone.',
      '',
      'WebSocket has ping/pong frames built in, but they only prove TCP is up, not that the **application**',
      'is: a process wedged in a deadlock still has a kernel that answers pong. Production systems',
      'generally send their own heartbeat at the application layer anyway.',
    ].join('\n')
  ),

  focus: ['correctness', 'resilience', 'encapsulation'],
  lab: {},

  starterFiles: [
    file(
      'src/session/registry.ts',
      code`
        import type { Frame, Transport } from '../support/transport';

        export interface RegistryOptions {
          /** A connection unheard from for this long is stale. */
          idleMs: number;
        }

        export interface ConnectionRegistry {
          /** A device dials in. Returns the connection id the hub handed out. */
          attach(userId: string, deviceId: string): string;
          /** A heartbeat arrived on this connection. */
          beat(connectionId: string): void;
          /** Drop closed and silent connections. Returns the ids that were dropped. */
          reap(): string[];
          /** Live connections of one user, in attach order. */
          connectionsOf(userId: string): string[];
          /** Push a frame to every live connection of a user. Returns how many got it. */
          deliver(userId: string, frame: Frame): number;
          online(userId: string): boolean;
        }

        export function createRegistry(
          transport: Transport,
          options: RegistryOptions
        ): ConnectionRegistry {
          // TODO: implement
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
        import { createRegistry } from '../src/session/registry';
        import { createTransport } from '../src/support/transport';
        import { sleep } from '@lab/env';

        const IDLE_MS = 1000;

        function makeRegistry() {
          const transport = createTransport();
          return { transport, registry: createRegistry(transport, { idleMs: IDLE_MS }) };
        }

        function messageFrame(text: string) {
          return { kind: 'control' as const, payload: text };
        }

        describe('阶段1 · 连接注册与心跳', () => {
          it('attach 之后能按接入顺序列出这个用户的连接', () => {
            const context = makeRegistry();

            const phone = context.registry.attach('alice', 'phone');
            const laptop = context.registry.attach('alice', 'laptop');

            expect(context.registry.connectionsOf('alice')).toEqual([phone, laptop]);
            expect(context.registry.online('alice')).toBe(true);
          });

          it('deliver 只推给这个用户的每一条连接 [gate:fanout]', () => {
            const context = makeRegistry();
            context.registry.attach('alice', 'phone');
            context.registry.attach('alice', 'laptop');
            context.registry.attach('alice', 'tablet');
            const bobPhone = context.registry.attach('bob', 'phone');
            context.registry.attach('bob', 'laptop');

            const reached = context.registry.deliver('alice', messageFrame('hi'));

            expect(reached).toBe(3);
            expect(context.transport.inbox(bobPhone)).toEqual([]);
          });

          it('同一台设备重连会替换掉旧连接', () => {
            const context = makeRegistry();

            const first = context.registry.attach('alice', 'phone');
            const second = context.registry.attach('alice', 'phone');

            expect(second).not.toBe(first);
            expect(context.registry.connectionsOf('alice')).toEqual([second]);
            expect(context.transport.isOpen(first)).toBe(false);
          });

          it('对端关掉 socket 之后 deliver 一帧都不推', () => {
            const context = makeRegistry();
            const phone = context.registry.attach('alice', 'phone');
            const laptop = context.registry.attach('alice', 'laptop');

            // socket 掉了，registry 还不知道
            context.transport.close(phone);

            const reached = context.registry.deliver('alice', messageFrame('hi'));

            expect(reached).toBe(1);
            expect(context.transport.inbox(laptop)).toHaveLength(1);
          });

          it('心跳能让连接继续活着', async () => {
            const context = makeRegistry();
            const phone = context.registry.attach('alice', 'phone');

            await sleep(IDLE_MS - 1);
            context.registry.beat(phone);
            await sleep(IDLE_MS - 1);

            expect(context.registry.deliver('alice', messageFrame('hi'))).toBe(1);
            expect(context.registry.reap()).toEqual([]);
          });

          it('静默超时的连接在 reap 之前也收不到东西', async () => {
            const context = makeRegistry();
            context.registry.attach('alice', 'phone');

            await sleep(IDLE_MS);

            expect(context.registry.deliver('alice', messageFrame('hi'))).toBe(0);
          });

          it('reap 摘掉超时的连接并返回它们', async () => {
            const context = makeRegistry();
            const phone = context.registry.attach('alice', 'phone');
            await sleep(IDLE_MS - 1);
            const laptop = context.registry.attach('alice', 'laptop');
            await sleep(1);

            // phone 静默了 IDLE_MS，laptop 才 1ms
            expect(context.registry.reap()).toEqual([phone]);
            expect(context.registry.connectionsOf('alice')).toEqual([laptop]);
          });

          it('reap 也摘掉 hub 已经关掉的连接', () => {
            const context = makeRegistry();
            const phone = context.registry.attach('alice', 'phone');
            context.transport.close(phone);

            expect(context.registry.reap()).toEqual([phone]);
            expect(context.registry.online('alice')).toBe(false);
          });

          it('reap 是幂等的', async () => {
            const context = makeRegistry();
            context.registry.attach('alice', 'phone');
            await sleep(IDLE_MS);

            expect(context.registry.reap()).toHaveLength(1);
            expect(context.registry.reap()).toEqual([]);
          });

          it('没见过的用户 deliver 返回 0，online 是 false', () => {
            const context = makeRegistry();

            expect(context.registry.deliver('nobody', messageFrame('hi'))).toBe(0);
            expect(context.registry.online('nobody')).toBe(false);
            expect(context.registry.connectionsOf('nobody')).toEqual([]);
          });

          it('一个用户的两台设备各自独立超时', async () => {
            const context = makeRegistry();
            const phone = context.registry.attach('alice', 'phone');
            const laptop = context.registry.attach('alice', 'laptop');

            await sleep(IDLE_MS - 1);
            context.registry.beat(laptop);
            await sleep(1);

            expect(context.registry.connectionsOf('alice')).toEqual([laptop]);
            expect(context.transport.isOpen(phone)).toBe(false);
          });

          it('投递本身不会让连接续命', async () => {
            const context = makeRegistry();
            context.registry.attach('alice', 'phone');

            await sleep(IDLE_MS - 1);
            context.registry.deliver('alice', messageFrame('hi'));
            await sleep(1);

            // 心跳来自对端，自己推出去的字节不算
            expect(context.registry.deliver('alice', messageFrame('hi'))).toBe(0);
          });
        });
      `
    ),
  ],

  gates: [
    gate({
      metric: 'counters.pushToDeadConnection',
      op: 'eq',
      value: 0,
      zh: '一帧都没打进死连接',
      en: 'Not one frame went into a dead connection',
      dimension: 'resilience',
    }),
    gate({
      metric: 'counters.framesPushed',
      op: 'lte',
      value: 3,
      zh: '三设备用户收一条消息就是三帧',
      en: 'One message to a three-device user is three frames',
      dimension: 'latency',
      scope: 'gate:fanout',
    }),
  ],

  referenceFiles: [
    file(
      'src/session/registry.ts',
      code`
        import type { Frame, Transport } from '../support/transport';
        import { now } from '@lab/env';

        export interface RegistryOptions {
          idleMs: number;
        }

        export interface ConnectionRegistry {
          attach(userId: string, deviceId: string): string;
          beat(connectionId: string): void;
          reap(): string[];
          connectionsOf(userId: string): string[];
          deliver(userId: string, frame: Frame): number;
          online(userId: string): boolean;
        }

        interface Owned {
          userId: string;
          deviceId: string;
        }

        export function createRegistry(
          transport: Transport,
          options: RegistryOptions
        ): ConnectionRegistry {
          /** user id -> connection ids, in attach order */
          const byUser = new Map<string, string[]>();
          const owner = new Map<string, Owned>();

          /**
           * The single definition of "live", used by every method below.
           *
           * Both halves are load-bearing: isOpen catches the clean disconnect the
           * hub already saw, the idle window catches the half-open socket it did not.
           */
          function isLive(connectionId: string): boolean {
            if (!transport.isOpen(connectionId)) return false;
            return now() - transport.lastSeenAt(connectionId) < options.idleMs;
          }

          function forget(connectionId: string): void {
            const owned = owner.get(connectionId);
            if (!owned) return;
            owner.delete(connectionId);
            const remaining = (byUser.get(owned.userId) || []).filter((id) => id !== connectionId);
            if (remaining.length) byUser.set(owned.userId, remaining);
            else byUser.delete(owned.userId);
            transport.close(connectionId);
          }

          /** Live connections of a user, dropping the dead ones on the way past. */
          function liveOf(userId: string): string[] {
            const tracked = byUser.get(userId) || [];
            const live: string[] = [];
            for (const connectionId of tracked) {
              if (isLive(connectionId)) live.push(connectionId);
              else forget(connectionId);
            }
            return live;
          }

          return {
            attach(userId: string, deviceId: string): string {
              // A device holds exactly one connection: the reconnect replaces the zombie
              for (const connectionId of byUser.get(userId) || []) {
                if (owner.get(connectionId)?.deviceId === deviceId) forget(connectionId);
              }

              const connectionId = transport.open(userId, deviceId);
              owner.set(connectionId, { userId, deviceId });
              byUser.set(userId, [...(byUser.get(userId) || []), connectionId]);
              return connectionId;
            },

            beat(connectionId: string): void {
              transport.heartbeat(connectionId);
            },

            reap(): string[] {
              const dropped: string[] = [];
              for (const connectionId of Array.from(owner.keys())) {
                if (isLive(connectionId)) continue;
                dropped.push(connectionId);
                forget(connectionId);
              }
              return dropped;
            },

            connectionsOf(userId: string): string[] {
              return liveOf(userId);
            },

            deliver(userId: string, frame: Frame): number {
              const live = liveOf(userId);
              for (const connectionId of live) transport.push(connectionId, frame);
              return live.length;
            },

            online(userId: string): boolean {
              return liveOf(userId).length > 0;
            },
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 2 关 · 会话序号与幂等落号                                          */
/* ------------------------------------------------------------------ */

const stage2 = {
  id: 'message-seq',
  title: t('第 2 关 · 会话序号与幂等落号', 'Stage 2 · Conversation sequence, assigned once'),
  goal: t(
    [
      '第 1 关把消息送到了设备上。但「送到」不等于「送对」：',
      '',
      '手机在信号不好的地方发一条消息，客户端等不到回执就重发。',
      '服务端收到两次一模一样的请求，于是会话里出现两条一模一样的消息 ——',
      '这是 IM 里用户最容易发现、也最不能忍的 bug。',
      '',
      '同时还有第二个问题：两台设备同时发言，谁在前面？',
      '客户端的时间戳不能用（手机的表是错的，而且会往回跳），',
      '所以顺序必须由**服务端**来定，并且定下来就不再变。',
      '',
      '这两件事其实是同一件事：给每条消息在会话里**分配一个位置**，',
      '并且保证同一次发送永远拿到同一个位置。',
      '',
      '这不是消息队列的 offset。offset 是 append 的副产品，写下去才知道是几；',
      '这里的位置由**客户端的身份**决定 —— 客户端发送前就自己生成了一个',
      '`clientMsgId`，重试时带的是同一个，服务端必须认出来。',
      '',
      '## 要实现什么',
      '',
      '在 `src/conversation/sequence.ts` 实现 `createSequencer(store)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `send(request)` | 分配或找回这次发送的 seq，返回 `{ seq, deduplicated }` |',
      '| `headSeq(conversationId)` | 会话当前最大的 seq，空会话是 0 |',
      '| `seqOf(conversationId, clientMsgId)` | 按客户端 id 反查 seq，没有就 undefined |',
      '',
      'seq 从 1 开始，会话内**稠密递增**，中间不留洞。',
      '`clientMsgId` 只在**会话内**唯一：两个会话里出现同一个字符串是两条不同的消息。',
      '',
      '## 怎么算过',
      '',
      '- 重发同一个 `clientMsgId` 拿回**原来那个** seq（不是最新的），',
      '  并且 `deduplicated` 是 true，日志里也不多出一条',
      '  （门槛 `counters.duplicateMessages = 0`，store 会认出同一个 id 被写了两次）；',
      '- seq 稠密不跳号（门槛 `counters.seqGaps = 0`，store 按 `count + 1` 核对）；',
      '- 200 次发送里有 40 次是重发，去重**不能靠翻日志**',
      '  （门槛 `counters.messagesScanned ≤ 5`：每条记录被读出来都会记一笔）。',
      '',
      '## 那个坑',
      '',
      '先占号再查重。',
      '',
      '`const seq = headSeq() + 1` 写在前面，然后才发现这是一次重发、于是提前 return ——',
      '号已经占掉了。下一条消息拿到的是 seq+2，会话里就有了一个洞。',
      '洞本身不致命，致命的是第 3 关：增量拉取靠 seq 定位，',
      '一个洞会让「从第 47 条开始拉」永远拉不到第 47 条，客户端于是一直重试。',
    ].join('\n'),
    [
      'Stage 1 got the message onto the devices. Arriving is not the same as arriving correctly:',
      '',
      'A phone in a bad spot sends a message, never sees the acknowledgement, and retries. The server',
      'receives the identical request twice, and the conversation now shows the message twice — the bug in',
      'this domain that users notice fastest and forgive least.',
      '',
      'There is a second problem underneath it. Two devices speak at the same moment: which comes first?',
      'Client timestamps cannot decide it, because phone clocks are wrong and occasionally run backwards.',
      'The order has to be assigned by **the server**, and once assigned it never changes.',
      '',
      'Both problems are the same problem: give every message **a position in its conversation**, and',
      'guarantee that one send always gets the same position.',
      '',
      'This is not a broker offset. An offset is a by-product of appending — you learn it by writing.',
      'Here the position is decided by **the identity the client brought**: the client mints a',
      '`clientMsgId` before sending, carries the same one through every retry, and the server has to',
      'recognise it.',
      '',
      '## What to build',
      '',
      'Implement `createSequencer(store)` in `src/conversation/sequence.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `send(request)` | Assign or recover the seq for this send; return `{ seq, deduplicated }` |',
      '| `headSeq(conversationId)` | The highest seq in the conversation; 0 when empty |',
      '| `seqOf(conversationId, clientMsgId)` | Reverse lookup by client id, or undefined |',
      '',
      'Sequences start at 1 and are **dense** within a conversation, with no holes.',
      '`clientMsgId` is unique **within a conversation**: the same string in two conversations is two',
      'different messages.',
      '',
      '## What counts as passing',
      '',
      '- Resending a `clientMsgId` returns **its original** seq, not the newest one, with `deduplicated`',
      '  set and no extra record in the log (the `counters.duplicateMessages = 0` gate — the store notices',
      '  when one client id is written twice);',
      '- Sequences are dense (the `counters.seqGaps = 0` gate, checked against `count + 1`);',
      '- With 40 retries among 200 sends, deduplication **must not read the log**',
      '  (the `counters.messagesScanned ≤ 5` gate: every record handed back is counted).',
      '',
      '## The trap',
      '',
      'Taking the number before checking for the retry.',
      '',
      'Put `const seq = headSeq() + 1` first, discover this is a resend, return early — and the number is',
      'already spent. The next message gets seq+2 and the conversation has a hole. The hole is not fatal by',
      'itself; stage 3 is where it becomes fatal, because incremental pull navigates by seq, and one hole',
      'means "start from 47" never yields 47 and the client retries forever.',
    ].join('\n')
  ),

  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  S["send(request)"] --> KEY["索引 key = 会话 id + 客户端消息 id"]',
      '  KEY --> LOOK["store.getIndex(clientMsgId, key)"]',
      '  LOOK --> HIT{"查到了吗？"}',
      '  HIT -- 查到 --> BACK["返回原来那个 seq<br/>deduplicated = true"]',
      '  HIT -- 没查到 --> TAKE["seq = store.messageCount(会话) + 1"]',
      '  TAKE --> APPEND["store.appendMessage(记录)"]',
      '  APPEND --> INDEX["store.putIndex(clientMsgId, key, seq)"]',
      '  INDEX --> OUT["返回新 seq<br/>deduplicated = false"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  Q["seqOf(会话, 客户端消息 id)"] --> LOOK2["同一张索引"]',
      '  LOOK2 --> Q2["查到就返回，查不到返回 undefined"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  H["headSeq(会话)"] --> CNT["store.messageCount(会话)"]',
      '  CNT --> H2["seq 稠密，所以条数就是最大号"]',
      '```',
      '',
      '要点：查重的菱形在占号**之前**。两者调换位置，重发会吃掉一个号，',
      '于是会话里出现一个永远填不上的洞。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  S["send(request)"] --> KEY["index key = conversation id + client message id"]',
      '  KEY --> LOOK["store.getIndex(clientMsgId, key)"]',
      '  LOOK --> HIT{"found?"}',
      '  HIT -- found --> BACK["return the original seq<br/>deduplicated = true"]',
      '  HIT -- not found --> TAKE["seq = store.messageCount(conversation) + 1"]',
      '  TAKE --> APPEND["store.appendMessage(record)"]',
      '  APPEND --> INDEX["store.putIndex(clientMsgId, key, seq)"]',
      '  INDEX --> OUT["return the new seq<br/>deduplicated = false"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  Q["seqOf(conversation, client message id)"] --> LOOK2["the same index"]',
      '  LOOK2 --> Q2["return it, or undefined"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  H["headSeq(conversation)"] --> CNT["store.messageCount(conversation)"]',
      '  CNT --> H2["sequences are dense, so the count is the head"]',
      '```',
      '',
      'The point: the lookup diamond comes **before** the number is taken. Swap them and a resend eats a',
      'sequence number, leaving a hole in the conversation that nothing will ever fill.',
    ].join('\n')
  ),

  checklist: [
    t('seq 从 1 开始，会话内稠密递增', 'Sequences start at 1 and stay dense within a conversation'),
    t('查重在占号之前', 'The duplicate check comes before the number is taken'),
    t('重发拿回原来那个 seq，不是最新的', 'A resend returns its original seq, not the newest one'),
    t('clientMsgId 只在会话内唯一', 'A client message id is unique only within its conversation'),
    t('去重走索引，不翻日志', 'Deduplication goes through the index, never the log'),
  ],

  pitfalls: [
    t(
      '把「重复」处理成「丢弃」：认出是重发就直接 return，不告诉客户端 seq。客户端要靠 seq 才能把这条消息从「发送中」变成「已发送」并插到正确位置，拿不到就只能一直转圈、继续重试。幂等的定义是「重复执行结果相同」，不是「重复执行没有结果」。',
      'Treating "duplicate" as "discard": recognise the resend and return nothing. The client needs the seq to move the message from sending to sent and to place it correctly, so without one it spins and keeps retrying. Idempotent means repeating produces the same result, not that repeating produces no result.'
    ),
    t(
      '用时间戳或者 UUID 当会话序号。时间戳会因为时钟回拨产生重复和倒序，UUID 根本没有顺序，而后面每一关 —— 增量拉取、已读位点、未读数、撤回定位 —— 都建立在「seq 可比较、可相减、可当下标」上。序号必须是服务端分配的稠密整数。',
      'Using a timestamp or a UUID as the conversation sequence. Timestamps duplicate and go backwards when a clock is corrected, UUIDs have no order at all, and every stage after this one — incremental pull, read cursors, unread counts, locating a recall — assumes the sequence can be compared, subtracted and used as an index. It has to be a dense integer the server assigns.'
    ),
    t(
      '为了查重去扫会话日志。功能上没错，代价是每次发送都读一遍历史：一个上万条的群，发一条消息要读一万条记录，而这是**写路径**上的开销，直接变成发消息的延迟。索引存的是 id 到号的映射，几十个字节，本来就该常驻。',
      'Scanning the conversation log to find the duplicate. It works, and it costs a full history read per send: ten thousand records read to post one message in a busy group, on the **write** path, straight into send latency. The index is an id-to-number map of a few dozen bytes and belongs in memory.'
    ),
    t(
      '让 clientMsgId 全局唯一。听起来更安全，实际上把两个无关会话耦合在了一起：客户端为了保证全局不重复，要么依赖设备 id 拼接（换设备就失效），要么维护一个全局计数器（多端同步时会冲突）。会话内唯一就够了，而会话内唯一是客户端可以本地保证的。',
      'Making the client message id globally unique. It sounds safer and it couples unrelated conversations: to guarantee global uniqueness the client either concatenates a device id, which breaks when the device changes, or maintains a global counter, which conflicts across devices. Uniqueness within the conversation is enough, and it is something a client can guarantee locally.'
    ),
  ],

  hints: [
    t(
      'seq 稠密的好处马上就用上了：`store.messageCount(会话)` 是免费的元数据，而它恰好等于当前最大的 seq。不需要另外维护一个 head 计数器。',
      'Density pays off immediately: `store.messageCount(conversation)` is free metadata and happens to equal the current head. There is no need for a separate counter.'
    ),
    t(
      '索引的 key 要把会话 id 拼进去，否则两个会话里同名的 clientMsgId 会互相覆盖 —— 第二个会话的消息会被当成第一个会话的重发。',
      'Put the conversation id into the index key. Without it the same client message id in two conversations collides, and the second conversation\'s message is mistaken for a resend of the first.'
    ),
  ],

  extension: t(
    [
      '这套「客户端生成 id + 服务端分配序号」的组合在几乎所有 IM 里都能找到。',
      'Signal 协议里叫 `timestamp` 但实际充当消息 id，Matrix 里叫 `transaction_id`，',
      'Telegram 的 MTProto 里叫 `random_id` —— 名字不同，作用完全一样：',
      '让重试可以被识别。',
      '',
      '这和 HTTP 的 `Idempotency-Key` 是同一个思路，Stripe 把它写进了公开 API：',
      '同一个 key 24 小时内重复请求，返回第一次的结果而不是再扣一次款。',
      '区别在于 IM 的幂等窗口通常更长（消息要在会话里永久存在），',
      '所以映射表跟着消息一起保留，而不是像 Stripe 那样定期过期。',
      '',
      '「稠密序号」还有一个隐藏的好处：客户端可以**自己发现丢消息**。',
      '收到 seq 10 和 seq 12，中间少了 11，客户端不需要服务端告诉它，',
      '自己就能发起一次补拉。稀疏 id（雪花、UUID）做不到这件事，',
      '这也是为什么会话序号和全局消息 id 通常是两个不同的字段。',
    ].join('\n'),
    [
      'The pairing of a client-minted id with a server-assigned sequence turns up in nearly every IM',
      'system. Signal calls it a timestamp while using it as the message id, Matrix calls it a',
      '`transaction_id`, MTProto calls it `random_id` — different names, identical job: make a retry',
      'recognisable.',
      '',
      'It is the same idea as HTTP\'s `Idempotency-Key`, which Stripe put in its public API: the same key',
      'within 24 hours returns the first result instead of charging again. The difference is that an IM',
      'idempotency window is usually much longer, because the message lives in the conversation forever, so',
      'the mapping is retained alongside it rather than expiring on a schedule.',
      '',
      'Dense sequences have a hidden benefit: the client can **detect loss by itself.** Receiving seq 10',
      'and seq 12 with nothing between them tells the client to go and fetch 11, with no help from the',
      'server. Sparse ids — snowflakes, UUIDs — cannot do that, which is why the conversation sequence and',
      'the global message id are usually two separate fields.',
    ].join('\n')
  ),

  focus: ['correctness', 'latency', 'encapsulation'],
  lab: {},

  starterFiles: [
    file(
      'src/conversation/sequence.ts',
      code`
        import type { Store } from '../support/store';

        export interface SendRequest {
          conversationId: string;
          senderId: string;
          /** Minted by the client before the send, identical on every retry */
          clientMsgId: string;
          payload: unknown;
          sentAt: number;
        }

        export interface SendResult {
          /** The position of this message in its conversation */
          seq: number;
          /** True when this client message id already had a position */
          deduplicated: boolean;
        }

        export interface Sequencer {
          send(request: SendRequest): SendResult;
          /** Highest assigned seq; 0 for an empty conversation */
          headSeq(conversationId: string): number;
          seqOf(conversationId: string, clientMsgId: string): number | undefined;
        }

        export function createSequencer(store: Store): Sequencer {
          // TODO: implement
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
        import { createSequencer } from '../src/conversation/sequence';
        import { createStore } from '../src/support/store';

        function makeSequencer() {
          const store = createStore();
          return { store, sequencer: createSequencer(store) };
        }

        function request(conversationId: string, clientMsgId: string, text: string) {
          return {
            conversationId,
            senderId: 'alice',
            clientMsgId,
            payload: text,
            sentAt: 0,
          };
        }

        describe('阶段2 · 会话序号与幂等落号', () => {
          it('第一条是 1，之后逐条递增', () => {
            const context = makeSequencer();

            expect(context.sequencer.send(request('c1', 'm1', 'a')).seq).toBe(1);
            expect(context.sequencer.send(request('c1', 'm2', 'b')).seq).toBe(2);
            expect(context.sequencer.headSeq('c1')).toBe(2);
          });

          it('空会话的 headSeq 是 0', () => {
            const context = makeSequencer();

            expect(context.sequencer.headSeq('c1')).toBe(0);
          });

          it('重发同一个 clientMsgId 拿回同一个 seq', () => {
            const context = makeSequencer();

            const first = context.sequencer.send(request('c1', 'm1', 'a'));
            const again = context.sequencer.send(request('c1', 'm1', 'a'));

            expect(again.seq).toBe(first.seq);
            expect(first.deduplicated).toBe(false);
            expect(again.deduplicated).toBe(true);
          });

          it('重发不会在日志里多出一条', () => {
            const context = makeSequencer();

            context.sequencer.send(request('c1', 'm1', 'a'));
            context.sequencer.send(request('c1', 'm1', 'a'));
            context.sequencer.send(request('c1', 'm1', 'a'));

            expect(context.store.messageCount('c1')).toBe(1);
            expect(context.sequencer.headSeq('c1')).toBe(1);
          });

          it('重发一条旧消息拿回的是它原来的号，不是最新的', () => {
            const context = makeSequencer();

            const first = context.sequencer.send(request('c1', 'm1', 'a'));
            context.sequencer.send(request('c1', 'm2', 'b'));
            context.sequencer.send(request('c1', 'm3', 'c'));

            expect(context.sequencer.send(request('c1', 'm1', 'a')).seq).toBe(first.seq);
            expect(context.sequencer.headSeq('c1')).toBe(3);
          });

          it('重发之后下一条消息不跳号', () => {
            const context = makeSequencer();

            context.sequencer.send(request('c1', 'm1', 'a'));
            context.sequencer.send(request('c1', 'm1', 'a'));

            expect(context.sequencer.send(request('c1', 'm2', 'b')).seq).toBe(2);
          });

          it('不同会话各自从 1 开始', () => {
            const context = makeSequencer();

            context.sequencer.send(request('c1', 'm1', 'a'));
            context.sequencer.send(request('c1', 'm2', 'b'));

            expect(context.sequencer.send(request('c2', 'm9', 'z')).seq).toBe(1);
            expect(context.sequencer.headSeq('c1')).toBe(2);
          });

          it('同一个 clientMsgId 出现在两个会话里是两条消息', () => {
            const context = makeSequencer();

            const inFirst = context.sequencer.send(request('c1', 'same', 'a'));
            const inSecond = context.sequencer.send(request('c2', 'same', 'b'));

            expect(inFirst.deduplicated).toBe(false);
            expect(inSecond.deduplicated).toBe(false);
            expect(context.store.messageCount('c1')).toBe(1);
            expect(context.store.messageCount('c2')).toBe(1);
          });

          it('seqOf 能按客户端 id 反查，查不到返回 undefined', () => {
            const context = makeSequencer();
            context.sequencer.send(request('c1', 'm1', 'a'));
            context.sequencer.send(request('c1', 'm2', 'b'));

            expect(context.sequencer.seqOf('c1', 'm2')).toBe(2);
            expect(context.sequencer.seqOf('c1', 'nope')).toBeUndefined();
            expect(context.sequencer.seqOf('c2', 'm1')).toBeUndefined();
          });

          it('内容和发送者原样落库', () => {
            const context = makeSequencer();
            context.sequencer.send({
              conversationId: 'c1',
              senderId: 'bob',
              clientMsgId: 'm1',
              payload: 'hello there',
              sentAt: 42,
            });

            const stored = context.store.readMessages('c1', 0, 10);
            expect(stored).toHaveLength(1);
            expect(stored[0].senderId).toBe('bob');
            expect(stored[0].payload).toBe('hello there');
            expect(stored[0].seq).toBe(1);
            expect(stored[0].sentAt).toBe(42);
          });

          it('两个会话交错发送，各自的号都连续', () => {
            const context = makeSequencer();
            const seen: number[] = [];

            for (let round = 1; round <= 4; round += 1) {
              seen.push(context.sequencer.send(request('c1', 'a' + round, 'x')).seq);
              context.sequencer.send(request('c2', 'b' + round, 'y'));
            }

            expect(seen).toEqual([1, 2, 3, 4]);
            expect(context.sequencer.headSeq('c2')).toBe(4);
          });

          it('两百次发送里四十次是重发，去重不翻日志 [gate:index]', () => {
            const context = makeSequencer();

            for (let index = 1; index <= 200; index += 1) {
              context.sequencer.send(request('c1', 'm' + index, 'x'));
            }
            for (let index = 1; index <= 40; index += 1) {
              const result = context.sequencer.send(request('c1', 'm' + index, 'x'));
              expect(result.deduplicated).toBe(true);
            }

            expect(context.store.messageCount('c1')).toBe(200);
          });
        });
      `
    ),
  ],

  gates: [
    gate({
      metric: 'counters.duplicateMessages',
      op: 'eq',
      value: 0,
      zh: '同一次发送不会变成两条消息',
      en: 'One send never becomes two messages',
      dimension: 'correctness',
    }),
    gate({
      metric: 'counters.seqGaps',
      op: 'eq',
      value: 0,
      zh: '会话序号稠密，一个洞都没有',
      en: 'Sequences stay dense — not one hole',
      dimension: 'correctness',
    }),
    gate({
      metric: 'counters.messagesScanned',
      op: 'lte',
      value: 5,
      zh: '两百次发送的去重一条日志都不用翻',
      en: 'Deduplicating 200 sends reads no log records',
      dimension: 'latency',
      scope: 'gate:index',
    }),
  ],

  referenceFiles: [
    file(
      'src/conversation/sequence.ts',
      code`
        import type { Store } from '../support/store';

        export interface SendRequest {
          conversationId: string;
          senderId: string;
          clientMsgId: string;
          payload: unknown;
          sentAt: number;
        }

        export interface SendResult {
          seq: number;
          deduplicated: boolean;
        }

        export interface Sequencer {
          send(request: SendRequest): SendResult;
          headSeq(conversationId: string): number;
          seqOf(conversationId: string, clientMsgId: string): number | undefined;
        }

        /** Client ids are unique per conversation, so the conversation is part of the key. */
        const MINT_INDEX = 'clientMsgId';

        function mintKey(conversationId: string, clientMsgId: string): string {
          return conversationId + '|' + clientMsgId;
        }

        export function createSequencer(store: Store): Sequencer {
          function lookup(conversationId: string, clientMsgId: string): number | undefined {
            return store.getIndex(MINT_INDEX, mintKey(conversationId, clientMsgId));
          }

          return {
            send(request: SendRequest): SendResult {
              // The lookup comes first. Taking the number before knowing whether this
              // is a resend spends a sequence on nothing and leaves a hole behind.
              const known = lookup(request.conversationId, request.clientMsgId);
              if (known !== undefined) return { seq: known, deduplicated: true };

              // Sequences are dense, so the record count is the head
              const seq = store.messageCount(request.conversationId) + 1;

              store.appendMessage({
                conversationId: request.conversationId,
                seq,
                senderId: request.senderId,
                clientMsgId: request.clientMsgId,
                payload: request.payload,
                sentAt: request.sentAt,
                state: 'live',
              });
              store.putIndex(MINT_INDEX, mintKey(request.conversationId, request.clientMsgId), seq);

              return { seq, deduplicated: false };
            },

            headSeq(conversationId: string): number {
              return store.messageCount(conversationId);
            },

            seqOf(conversationId: string, clientMsgId: string): number | undefined {
              return lookup(conversationId, clientMsgId);
            },
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 3 关 · 离线期间漏了什么                                            */
/* ------------------------------------------------------------------ */

const stage3 = {
  id: 'offline-backlog',
  title: t('第 3 关 · 离线消息与增量拉取', 'Stage 3 · What you missed while you were away'),
  goal: t(
    [
      '第 2 关给了每条消息一个位置。位置的第一个用途是回答一个问题：',
      '**「我离线这三天，漏了什么？」**',
      '',
      '客户端重新连上来的时候，手里有一份自己的进度：',
      '「工作群我读到 812，和张三的对话读到 47，其余没变」。',
      '它把这份进度交给服务端，服务端把差值补上。',
      '',
      '这件事有两个约束，而且都是硬的：',
      '',
      '- **必须有界**。离线三天可能积压了两万条，一次全推回去，',
      '  客户端要么 OOM，要么在解析 JSON 的时候白屏十几秒。',
      '  所以一次只给一页，并告诉客户端还有没有；',
      '- **代价要和「漏了多少」成正比，不能和「一共有多少」成正比**。',
      '  一个人可能在 200 个会话里，其中 197 个这三天一条消息都没有。',
      '  那 197 个会话应该一条记录都不读。',
      '',
      '第二条是这一关真正在考的东西，也是它和「翻日志」的分界线。',
      '',
      '## 要实现什么',
      '',
      '在 `src/conversation/backlog.ts` 实现 `createBacklog(store)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `pull(request)` | 按 `since` 补差值，最多 `limit` 条，返回 `{ entries, cursors, hasMore }` |',
      '| `pendingCount(userId, since)` | 一共欠这个设备多少条，**一条记录都不读** |',
      '',
      '`since` 是一张「会话 → 已经有到第几号」的表，缺项表示这个会话一条都没有。',
      '`entries` 按 `store.conversationsOf(userId)` 的顺序排列，会话内按 seq 升序。',
      '`cursors` 只包含这次真的前进了的会话，客户端拿它**合并**进自己的 `since`。',
      '',
      '## 怎么算过',
      '',
      '- 一页最多 `limit` 条，还有剩余时 `hasMore` 为 true；',
      '- `since` 之前的消息不会再回来，第二页接着第一页，不重不漏；',
      '- 这个用户不在的会话不会出现；',
      '- 40 个会话共 2000 条消息、其中只有 3 个会话有新消息时，',
      '  拉一页 20 条**最多读 40 条记录**',
      '  （门槛 `counters.messagesScanned ≤ 40`：store 每交出一条记录记一笔）；',
      '- `pendingCount` 一条记录都不读（门槛 `counters.messagesScanned = 0`）。',
      '',
      '## 那个坑',
      '',
      '`store.readMessages(会话, 0, 很大的数)` 然后 `.filter(m => m.seq > since)`。',
      '',
      '结果完全正确，测试全绿，代价是每次拉取都把每个会话的全部历史读一遍。',
      '这个实现在你自己的账号上（三个会话、几百条消息）快得看不出问题，',
      '在一个进了 200 个群、聊了三年的账号上，一次上线要读几十万条记录 ——',
      '而上线这个动作，每天早上会在同一分钟里发生几百万次。',
      '',
      '`messagesScanned` 就是为了让这个差别在你写完的当下就看得见，',
      '而不是等到有人在半年后的故障复盘里发现它。',
    ].join('\n'),
    [
      'Stage 2 gave every message a position. The first thing a position is good for is answering one',
      'question: **"what did I miss while I was gone?"**',
      '',
      'When a client reconnects it holds its own progress: caught up to 812 in the work group, 47 in the',
      'thread with Alice, nothing new anywhere else. It hands that over and the server fills in the gap.',
      '',
      'Two constraints, both hard:',
      '',
      '- **It has to be bounded.** Three days offline can be twenty thousand messages, and pushing all of',
      '  them back at once either exhausts the client or freezes it for ten seconds parsing JSON. One page',
      '  at a time, plus an honest answer about whether there is more;',
      '- **The cost has to scale with what you missed, not with what exists.** Someone can be in 200',
      '  conversations of which 197 saw no traffic at all. Those 197 should not have a single record read.',
      '',
      'The second constraint is what this stage is actually about, and it is the line between an index and',
      'a scan.',
      '',
      '## What to build',
      '',
      'Implement `createBacklog(store)` in `src/conversation/backlog.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `pull(request)` | Fill the gap after `since`, at most `limit`, returning `{ entries, cursors, hasMore }` |',
      '| `pendingCount(userId, since)` | How many messages are owed, **reading no records at all** |',
      '',
      '`since` maps a conversation to the highest seq the device already has; a missing entry means it has',
      'none. `entries` follow the order of `store.conversationsOf(userId)`, and within a conversation they',
      'ascend by seq. `cursors` contains only the conversations that actually advanced, and the client',
      '**merges** it into its own `since`.',
      '',
      '## What counts as passing',
      '',
      '- A page holds at most `limit` entries and sets `hasMore` when anything remains;',
      '- Nothing at or before `since` comes back, and the second page continues the first with no gap and',
      '  no repeat;',
      '- Conversations this user is not in never appear;',
      '- With 40 conversations holding 2000 messages of which only 3 have anything new, a 20-message page',
      '  **reads at most 40 records** (the `counters.messagesScanned ≤ 40` gate — the store counts every',
      '  record it hands back);',
      '- `pendingCount` reads none at all (the `counters.messagesScanned = 0` gate).',
      '',
      '## The trap',
      '',
      '`store.readMessages(conversation, 0, something_large)` followed by `.filter(m => m.seq > since)`.',
      '',
      'The result is perfectly correct and the tests go green, and the cost is a full history read per',
      'conversation per sync. On your own account — three conversations, a few hundred messages — it is',
      'indistinguishable from the right answer. On an account in 200 groups after three years it reads',
      'hundreds of thousands of records to come online, and coming online is something that happens a few',
      'million times within the same morning minute.',
      '',
      '`messagesScanned` exists so that difference is visible while you are writing the code, rather than',
      'in an incident review six months later.',
    ].join('\n')
  ),

  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  P["pull(userId, since, limit)"] --> LIST["store.conversationsOf(userId)"]',
      '  LIST --> EACH["逐个会话"]',
      '  EACH --> TOTAL["total = store.messageCount(会话)<br/>免费的元数据"]',
      '  TOTAL --> FROM["from = since[会话] 或者 0"]',
      '  FROM --> NEW{"total 大于 from？"}',
      '  NEW -- 否 --> SKIP["一条记录都不读<br/>下一个会话"]',
      '  NEW -- 是 --> ROOM{"这一页还有位置？"}',
      '  ROOM -- 没有 --> MARK["hasMore = true<br/>下一个会话"]',
      '  ROOM -- 有 --> READ["store.readMessages(会话, from, 位置数)<br/>seq 稠密，seq N 在下标 N-1"]',
      '  READ --> COLL["收进 entries<br/>cursors[会话] = 最后一条的 seq"]',
      '  COLL --> LEFT{"这个会话还有剩的？"}',
      '  LEFT -- 有 --> MARK',
      '  LEFT -- 没有 --> NEXT["下一个会话"]',
      '  SKIP --> NEXT',
      '  MARK --> NEXT',
      '  NEXT --> DONE{"会话走完了？"}',
      '  DONE -- 没有 --> EACH',
      '  DONE -- 走完 --> OUT["返回 entries / cursors / hasMore"]',
      '```',
      '',
      '要点：`total 大于 from` 这个菱形在 `readMessages` **之前**。',
      '它是整条路径上唯一一个能让 197 个安静会话的代价归零的判断。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  P["pull(userId, since, limit)"] --> LIST["store.conversationsOf(userId)"]',
      '  LIST --> EACH["for each conversation"]',
      '  EACH --> TOTAL["total = store.messageCount(conversation)<br/>free metadata"]',
      '  TOTAL --> FROM["from = since[conversation] or 0"]',
      '  FROM --> NEW{"total greater than from?"}',
      '  NEW -- no --> SKIP["read nothing<br/>next conversation"]',
      '  NEW -- yes --> ROOM{"room left in this page?"}',
      '  ROOM -- no --> MARK["hasMore = true<br/>next conversation"]',
      '  ROOM -- yes --> READ["store.readMessages(conversation, from, room)<br/>dense seq: seq N sits at index N-1"]',
      '  READ --> COLL["collect into entries<br/>cursors[conversation] = last seq"]',
      '  COLL --> LEFT{"anything left here?"}',
      '  LEFT -- yes --> MARK',
      '  LEFT -- no --> NEXT["next conversation"]',
      '  SKIP --> NEXT',
      '  MARK --> NEXT',
      '  NEXT --> DONE{"conversations exhausted?"}',
      '  DONE -- no --> EACH',
      '  DONE -- yes --> OUT["return entries / cursors / hasMore"]',
      '```',
      '',
      'The point: the "total greater than from" diamond sits **before** `readMessages`. It is the single',
      'test on this path that drives the cost of 197 quiet conversations to zero.',
    ].join('\n')
  ),

  checklist: [
    t('安静的会话一条记录都不读', 'A quiet conversation has no records read'),
    t('一页不超过 limit，还有剩就报 hasMore', 'A page never exceeds limit and reports hasMore honestly'),
    t('cursors 只包含前进过的会话', 'cursors carries only the conversations that advanced'),
    t('第二页接着第一页，不重不漏', 'The second page continues the first exactly'),
    t('pendingCount 只用免费的元数据', 'pendingCount uses free metadata only'),
  ],

  pitfalls: [
    t(
      '`readMessages(会话, 0, 很大的数)` 之后在内存里 filter。测试会全绿，因为结果是对的。代价是每次上线把每个会话的全部历史读一遍 —— 一个三年老账号上线一次读几十万条，而早高峰同一分钟里有几百万人上线。这类 bug 的特征是：在开发者自己的账号上永远复现不了。',
      'Reading from index 0 and filtering in memory. The tests pass because the answer is right. The cost is the entire history of every conversation on every sync — hundreds of thousands of records for a three-year-old account, multiplied by the few million people who come online in the same morning minute. The signature of this class of bug is that it never reproduces on the developer\'s own account.'
    ),
    t(
      '把 `since` 当成下标直接传给 `readMessages`，或者反过来把下标当成 seq 返回。seq 从 1 开始、下标从 0 开始，两者差一。差一的结果是每次拉取要么把最后一条重复给一遍（客户端出现重复气泡），要么漏掉一条（客户端出现空洞，然后无限重试）。写之前先把「seq N 在下标 N-1」这句话写进注释。',
      'Passing `since` straight to `readMessages` as an index, or returning an index as a seq. Sequences start at 1, indexes at 0, and the difference of one means every page either repeats its last message — duplicate bubbles on the client — or skips one, leaving a hole the client retries forever. Write "seq N lives at index N-1" in a comment before writing the code.'
    ),
    t(
      '一次把所有欠的消息都返回，不做上限。离线三天的账号可能欠两万条，一个响应几十 MB，客户端在解析阶段白屏。更糟的是这个响应通常还会被重试 —— 客户端等超时了就再发一次，服务端于是再构造一遍同样的几十 MB。有界分页不是优化，是可用性的下限。',
      'Returning everything that is owed with no limit. Three days offline can be twenty thousand messages and tens of megabytes, and the client goes blank while it parses. Worse, that response tends to get retried: the client times out and asks again, and the server rebuilds the same tens of megabytes. Bounded pages are not an optimisation, they are the floor of being usable at all.'
    ),
    t(
      '在 `cursors` 里把所有会话都回报一遍，包括没有新消息的。看起来更「完整」，实际上让客户端无法区分「这个会话确认没有新消息」和「这个会话这次没查」，而且响应体积随会话数线性增长 —— 200 个会话的用户每次拉一页都要背着 200 个键。只回报前进过的，语义和体积都对。',
      'Reporting every conversation in `cursors`, including the untouched ones. It looks more complete and it leaves the client unable to tell "confirmed nothing new" from "not examined this time", while the response grows linearly with the conversation count — 200 keys on every page for someone in 200 conversations. Report only what advanced and both the semantics and the size come out right.'
    ),
  ],

  hints: [
    t(
      '`store.messageCount(会话)` 和 `store.conversationsOf(userId)` 都是免费的元数据，随便调。真正要省的只有 `readMessages` 交出来的记录条数。',
      '`store.messageCount` and `store.conversationsOf` are free metadata — call them as much as you like. The only thing to be frugal with is the number of records `readMessages` hands back.'
    ),
    t(
      '一页读多少条 = `Math.min(这一页剩下的位置, total - from)`。取小的那个，既不会超出 limit，也不会让 store 白跑一趟末尾的空区间。',
      'How much to read is `Math.min(room left in the page, total - from)`. The smaller of the two keeps you inside the limit and stops the store walking an empty tail.'
    ),
  ],

  extension: t(
    [
      '这个接口在真实系统里通常叫 sync 或者 catch-up，Matrix 的 `/sync`、',
      'Slack 的 `conversations.history`、企业微信的「拉取消息」都是它。',
      '',
      '一个这里没做、但真实系统必须做的事：**位点的下界**。',
      '消息不会永久保留，一个 90 天前的位点对应的消息可能已经被清掉了。',
      '这时服务端不能沉默地少给几条，必须明确告诉客户端「你的位点太旧了，',
      '请走全量重建」—— Matrix 里这叫 limited timeline，客户端收到之后会丢掉',
      '本地缓存重新拉。悄悄少给的后果是客户端永远显示一个不完整的会话，',
      '而且它自己不知道。',
      '',
      '另一个有意思的取舍是「按会话拉」还是「按用户拉」。这一关做的是前者',
      '（每个会话一个位点），Matrix 做的也是。后者是给整个账号一个全局位点，',
      '实现简单很多，但代价是任何一个会话有新消息都会让全局位点前进，',
      '客户端没法只同步自己正在看的那个会话 —— 打开一个群要等所有群都同步完。',
    ].join('\n'),
    [
      'This endpoint is usually called sync or catch-up: Matrix\'s `/sync`, Slack\'s',
      '`conversations.history`, the "fetch messages" call in most enterprise suites.',
      '',
      'One thing this stage leaves out that production cannot: **a floor on the cursor.** Messages do not',
      'live forever, and the messages a 90-day-old cursor points into may already be gone. The server must',
      'not quietly return fewer records; it has to tell the client its cursor is too old and a full rebuild',
      'is required. Matrix calls this a limited timeline, and a client that receives one discards its local',
      'cache and refetches. Quietly under-delivering leaves the client showing an incomplete conversation',
      'without knowing it.',
      '',
      'The other interesting trade-off is per-conversation versus per-account cursors. This stage does the',
      'former, as Matrix does. A single global cursor per account is much simpler to implement, and the',
      'price is that any conversation receiving a message advances it, so a client cannot sync just the',
      'conversation it is looking at — opening one group means waiting for every group.',
    ].join('\n')
  ),

  focus: ['correctness', 'latency', 'encapsulation'],
  lab: {},

  starterFiles: [
    file(
      'src/conversation/backlog.ts',
      code`
        import type { Store } from '../support/store';

        /** Where a device thinks it is: conversation id to highest seq it holds. */
        export type SyncPoint = Record<string, number>;

        export interface BacklogRequest {
          userId: string;
          since: SyncPoint;
          /** At most this many entries in one page */
          limit: number;
        }

        export interface BacklogEntry {
          conversationId: string;
          seq: number;
          senderId: string;
          payload: unknown;
          sentAt: number;
        }

        export interface BacklogPage {
          entries: BacklogEntry[];
          /** Only the conversations that advanced in this page */
          cursors: SyncPoint;
          /** True when messages remain beyond this page */
          hasMore: boolean;
        }

        export interface Backlog {
          pull(request: BacklogRequest): BacklogPage;
          /** How many messages are owed. Must read no records. */
          pendingCount(userId: string, since: SyncPoint): number;
        }

        export function createBacklog(store: Store): Backlog {
          // TODO: implement
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
        import { createBacklog } from '../src/conversation/backlog';
        import { createSequencer } from '../src/conversation/sequence';
        import { createStore } from '../src/support/store';

        function makeBacklog() {
          const store = createStore();
          const sequencer = createSequencer(store);
          return { store, sequencer, backlog: createBacklog(store) };
        }

        function conversation(context: any, id: string, members: string[]): void {
          context.store.putConversation({ conversationId: id, kind: 'group', members });
        }

        function post(context: any, conversationId: string, howMany: number, from = 1): void {
          for (let index = 0; index < howMany; index += 1) {
            const nth = from + index;
            context.sequencer.send({
              conversationId,
              senderId: 'bob',
              clientMsgId: conversationId + '-m' + nth,
              payload: 'text-' + nth,
              sentAt: nth,
            });
          }
        }

        describe('阶段3 · 离线消息与增量拉取', () => {
          it('位点为空时从头拉，按 seq 升序', () => {
            const context = makeBacklog();
            conversation(context, 'c1', ['alice', 'bob']);
            post(context, 'c1', 3);

            const page = context.backlog.pull({ userId: 'alice', since: {}, limit: 10 });

            expect(page.entries.map((entry: any) => entry.seq)).toEqual([1, 2, 3]);
            expect(page.entries[0].payload).toBe('text-1');
            expect(page.hasMore).toBe(false);
            expect(page.cursors).toEqual({ c1: 3 });
          });

          it('位点之后的才回来', () => {
            const context = makeBacklog();
            conversation(context, 'c1', ['alice', 'bob']);
            post(context, 'c1', 5);

            const page = context.backlog.pull({ userId: 'alice', since: { c1: 3 }, limit: 10 });

            expect(page.entries.map((entry: any) => entry.seq)).toEqual([4, 5]);
          });

          it('拉满一页就报 hasMore', () => {
            const context = makeBacklog();
            conversation(context, 'c1', ['alice', 'bob']);
            post(context, 'c1', 10);

            const page = context.backlog.pull({ userId: 'alice', since: {}, limit: 4 });

            expect(page.entries).toHaveLength(4);
            expect(page.hasMore).toBe(true);
            expect(page.cursors).toEqual({ c1: 4 });
          });

          it('第二页接着第一页，不重不漏', () => {
            const context = makeBacklog();
            conversation(context, 'c1', ['alice', 'bob']);
            conversation(context, 'c2', ['alice', 'carol']);
            post(context, 'c1', 5);
            post(context, 'c2', 5);

            const first = context.backlog.pull({ userId: 'alice', since: {}, limit: 6 });
            const merged = { ...first.cursors };
            const second = context.backlog.pull({ userId: 'alice', since: merged, limit: 6 });

            const all = [...first.entries, ...second.entries].map(
              (entry: any) => entry.conversationId + '#' + entry.seq
            );
            expect(all).toHaveLength(10);
            expect(new Set(all).size).toBe(10);
            expect(second.hasMore).toBe(false);
          });

          it('没有新消息的会话不出现在 entries 和 cursors 里', () => {
            const context = makeBacklog();
            conversation(context, 'c1', ['alice', 'bob']);
            conversation(context, 'c2', ['alice', 'carol']);
            post(context, 'c1', 2);
            post(context, 'c2', 2);

            const page = context.backlog.pull({
              userId: 'alice',
              since: { c1: 2, c2: 1 },
              limit: 10,
            });

            expect(page.entries.map((entry: any) => entry.conversationId)).toEqual(['c2']);
            expect(page.cursors).toEqual({ c2: 2 });
          });

          it('全都追平之后是空页，hasMore 为 false', () => {
            const context = makeBacklog();
            conversation(context, 'c1', ['alice', 'bob']);
            post(context, 'c1', 3);

            const page = context.backlog.pull({ userId: 'alice', since: { c1: 3 }, limit: 10 });

            expect(page.entries).toEqual([]);
            expect(page.cursors).toEqual({});
            expect(page.hasMore).toBe(false);
          });

          it('不是成员的会话一条都拉不到', () => {
            const context = makeBacklog();
            conversation(context, 'c1', ['alice', 'bob']);
            conversation(context, 'secret', ['bob', 'carol']);
            post(context, 'c1', 2);
            post(context, 'secret', 4);

            const page = context.backlog.pull({ userId: 'alice', since: {}, limit: 50 });

            expect(page.entries.map((entry: any) => entry.conversationId)).toEqual(['c1', 'c1']);
          });

          it('limit 为 0 时不返回内容，但仍然如实报告还有剩', () => {
            const context = makeBacklog();
            conversation(context, 'c1', ['alice', 'bob']);
            post(context, 'c1', 3);

            const page = context.backlog.pull({ userId: 'alice', since: {}, limit: 0 });

            expect(page.entries).toEqual([]);
            expect(page.hasMore).toBe(true);
          });

          it('发送者和内容原样带回来', () => {
            const context = makeBacklog();
            conversation(context, 'c1', ['alice', 'bob']);
            context.sequencer.send({
              conversationId: 'c1',
              senderId: 'carol',
              clientMsgId: 'x1',
              payload: 'hello',
              sentAt: 77,
            });

            const entry = context.backlog.pull({ userId: 'alice', since: {}, limit: 5 }).entries[0];

            expect(entry.senderId).toBe('carol');
            expect(entry.payload).toBe('hello');
            expect(entry.sentAt).toBe(77);
            expect(entry.conversationId).toBe('c1');
          });

          it('pendingCount 等于各会话缺口之和', () => {
            const context = makeBacklog();
            conversation(context, 'c1', ['alice', 'bob']);
            conversation(context, 'c2', ['alice', 'carol']);
            post(context, 'c1', 10);
            post(context, 'c2', 4);

            expect(context.backlog.pendingCount('alice', { c1: 7 })).toBe(7);
            expect(context.backlog.pendingCount('alice', { c1: 10, c2: 4 })).toBe(0);
          });

          it('pendingCount 一条记录都不读 [gate:count]', () => {
            const context = makeBacklog();
            for (let index = 1; index <= 40; index += 1) {
              conversation(context, 'k' + index, ['alice', 'bob']);
              post(context, 'k' + index, 50);
            }

            expect(context.backlog.pendingCount('alice', {})).toBe(2000);
          });

          it('安静的会话不参与扫描 [gate:pull]', () => {
            const context = makeBacklog();
            const since: Record<string, number> = {};
            for (let index = 1; index <= 40; index += 1) {
              const id = 'k' + index;
              conversation(context, id, ['alice', 'bob']);
              post(context, id, 50);
              // 只有最后三个会话有新消息，其余全部追平
              since[id] = index > 37 ? 40 : 50;
            }

            const page = context.backlog.pull({ userId: 'alice', since, limit: 20 });

            expect(page.entries).toHaveLength(20);
            expect(page.hasMore).toBe(true);
            expect(new Set(page.entries.map((entry: any) => entry.conversationId)).size).toBe(2);
          });
        });
      `
    ),
  ],

  gates: [
    gate({
      metric: 'counters.messagesScanned',
      op: 'lte',
      value: 40,
      zh: '拉一页 20 条最多读 40 条记录，安静的会话不参与',
      en: 'A 20-message page reads at most 40 records; quiet conversations cost nothing',
      dimension: 'latency',
      scope: 'gate:pull',
    }),
    gate({
      metric: 'counters.messagesScanned',
      op: 'eq',
      value: 0,
      zh: '数「欠多少条」不读任何一条记录',
      en: 'Counting what is owed reads no records at all',
      dimension: 'latency',
      scope: 'gate:count',
    }),
  ],

  referenceFiles: [
    file(
      'src/conversation/backlog.ts',
      code`
        import type { Store } from '../support/store';

        export type SyncPoint = Record<string, number>;

        export interface BacklogRequest {
          userId: string;
          since: SyncPoint;
          limit: number;
        }

        export interface BacklogEntry {
          conversationId: string;
          seq: number;
          senderId: string;
          payload: unknown;
          sentAt: number;
        }

        export interface BacklogPage {
          entries: BacklogEntry[];
          cursors: SyncPoint;
          hasMore: boolean;
        }

        export interface Backlog {
          pull(request: BacklogRequest): BacklogPage;
          pendingCount(userId: string, since: SyncPoint): number;
        }

        /** How far behind this device is in one conversation, from metadata alone. */
        function gapOf(store: Store, conversationId: string, since: SyncPoint): number {
          return Math.max(0, store.messageCount(conversationId) - (since[conversationId] || 0));
        }

        export function createBacklog(store: Store): Backlog {
          return {
            pull(request: BacklogRequest): BacklogPage {
              const entries: BacklogEntry[] = [];
              const cursors: SyncPoint = {};
              let hasMore = false;

              for (const conversationId of store.conversationsOf(request.userId)) {
                const gap = gapOf(store, conversationId, request.since);
                // Nothing new here: this conversation costs zero records
                if (gap === 0) continue;

                const room = request.limit - entries.length;
                if (room <= 0) {
                  hasMore = true;
                  continue;
                }

                // Sequences are dense from 1, so the message after seq N sits at index N
                const from = request.since[conversationId] || 0;
                const batch = store.readMessages(conversationId, from, Math.min(room, gap));

                for (const record of batch) {
                  entries.push({
                    conversationId: record.conversationId,
                    seq: record.seq,
                    senderId: record.senderId,
                    payload: record.payload,
                    sentAt: record.sentAt,
                  });
                  cursors[conversationId] = record.seq;
                }

                if (batch.length < gap) hasMore = true;
              }

              return { entries, cursors, hasMore };
            },

            pendingCount(userId: string, since: SyncPoint): number {
              return store
                .conversationsOf(userId)
                .reduce((total, conversationId) => total + gapOf(store, conversationId, since), 0);
            },
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 4 关 · 多端同步                                                    */
/* ------------------------------------------------------------------ */

const stage4 = {
  id: 'device-sync',
  title: t('第 4 关 · 每设备位点与多端同步', 'Stage 4 · Per-device cursors and multi-device sync'),
  goal: t(
    [
      '第 3 关的拉取是**客户端问、服务端答**。但 IM 主要是推的：',
      '消息一到就要出现在屏幕上，等不到下一次轮询。',
      '',
      '推的时候，第 1 关那个「推给这个用户的每一条连接」不够用了，因为：',
      '',
      '- 一台设备可能刚刚**自己拉过**这条消息（第 3 关那条路），再推一次就是重复气泡；',
      '- **发消息的那台设备本来就有这条消息** —— 它是自己写的。',
      '  但同一个人的**另一台**设备必须收到，否则手机上发的消息在电脑上看不见。',
      '  这件事叫多端同步，是「一个人不等于一台设备」最直接的后果。',
      '',
      '要同时做到这两件，服务端必须知道**每台设备各自到哪了**。',
      '这就是这一关引入的东西：一个按设备记的位点，服务端自己维护，',
      '并且它是一条**只涨不落的水位线**。',
      '',
      '## 要实现什么',
      '',
      '在 `src/device/deviceSync.ts` 实现 `createDeviceSync(...)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `publish(conversationId, seq, originDeviceId?)` | 一条新消息，推给所有成员的所有活设备 |',
      '| `resume(userId, deviceId)` | 这台设备（重）连上来，把服务端认为它缺的补上，有上限 |',
      '| `acknowledge(deviceId, conversationId, seq)` | 设备确认自己已经有到 seq |',
      '| `cursorOf(deviceId, conversationId)` | 服务端记的这台设备的水位线 |',
      '',
      '`publish` 里，`originDeviceId` 是写出这条消息的那台设备：它不该收到消息体，',
      '但它的位点要跟着前进。剩下的判断只有一句 —— **位点已经到 seq 的设备跳过**。',
      '',
      '`resume` 复用第 3 关的 `backlog.pull`，`since` 由服务端的位点拼出来。',
      '',
      '## 怎么算过',
      '',
      '- 同一台设备不会拿到同一条消息两次，无论 `resume` 和 `publish` 谁先谁后',
      '  （门槛 `counters.duplicatePush = 0`，hub 按「连接 + 会话 + seq」记）；',
      '- 手机发的消息，同一个人的电脑收得到，手机自己收不到消息体',
      '  （门槛 `counters.selfSyncMisses = 0`）；',
      '- 迟到的 `acknowledge` 不会让位点倒退',
      '  （门槛 `counters.cursorRegressions = 0`，store 在写入时核对）。',
      '',
      '## 那个坑',
      '',
      '把位点当成「设备现在在哪」，于是 `acknowledge` 直接写进去。',
      '',
      '确认包会乱序到达 —— 网络会重排，客户端会在重连之后补发旧的确认，',
      '一个后台线程可能拿着五秒前的快照才发出来。写进去的那一刻位点就退了，',
      '而位点退一格的后果是：那一条消息会被再推一次。用户看到的是',
      '**一条老消息突然又跳到了会话底部**，时间戳还是旧的。',
      '',
      '水位线只认 `Math.max`。这不是防御性编程，这是这个数据结构的定义。',
    ].join('\n'),
    [
      'Stage 3\'s pull is the client asking and the server answering. IM is mostly the other direction: a',
      'message has to appear on screen when it arrives, not at the next poll.',
      '',
      'On the push path, stage 1\'s "send it to every connection of this user" is no longer enough:',
      '',
      '- a device may have **just pulled** that message itself through stage 3, and pushing it again is a',
      '  duplicate bubble;',
      '- **the device that sent the message already has it** — it wrote it. But the same person\'s **other**',
      '  devices must receive it, or a message sent from the phone never appears on the laptop. That is',
      '  multi-device sync, and it is the most direct consequence of a person not being a device.',
      '',
      'Doing both requires the server to know **where each device is**, which is what this stage',
      'introduces: a per-device cursor the server maintains, and it is **a high-water mark that only ever',
      'rises.**',
      '',
      '## What to build',
      '',
      'Implement `createDeviceSync(...)` in `src/device/deviceSync.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `publish(conversationId, seq, originDeviceId?)` | A new message goes to every live device of every member |',
      '| `resume(userId, deviceId)` | A device (re)connects; push the bounded remainder the server thinks it lacks |',
      '| `acknowledge(deviceId, conversationId, seq)` | The device confirms it holds everything up to seq |',
      '| `cursorOf(deviceId, conversationId)` | The high-water mark the server holds |',
      '',
      'In `publish`, `originDeviceId` is the device that composed the message: it gets no body, but its',
      'cursor still advances. After that there is only one rule — **skip any device whose cursor already',
      'reaches seq.**',
      '',
      '`resume` reuses stage 3\'s `backlog.pull`, with `since` assembled from the server-side cursors.',
      '',
      '## What counts as passing',
      '',
      '- No device receives the same message twice, in either order of `resume` and `publish`',
      '  (the `counters.duplicatePush = 0` gate, counted by the hub per connection, conversation and seq);',
      '- A message sent from the phone reaches the same person\'s laptop, and the phone gets no body',
      '  (the `counters.selfSyncMisses = 0` gate);',
      '- A late `acknowledge` does not move the cursor backwards',
      '  (the `counters.cursorRegressions = 0` gate, checked by the store on write).',
      '',
      '## The trap',
      '',
      'Treating the cursor as "where the device is now", and writing whatever `acknowledge` reports.',
      '',
      'Acknowledgements arrive out of order. Networks reorder, clients replay old confirmations after a',
      'reconnect, a background thread sends one built from a five-second-old snapshot. The moment you write',
      'it the cursor drops, and a cursor that drops by one means that message gets pushed again. What the',
      'user sees is **an old message suddenly jumping to the bottom of the conversation** with its original',
      'timestamp still on it.',
      '',
      'A high-water mark only ever takes `Math.max`. That is not defensive programming, it is the',
      'definition of the data structure.',
    ].join('\n')
  ),

  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  P["publish(会话, seq, 发出的设备)"] --> ORIG{"有发出的设备吗？"}',
      '  ORIG -- 有 --> BUMP["先把它的位点推到 seq<br/>它自己写的，不用再给它"]',
      '  ORIG -- 没有 --> REC',
      '  BUMP --> REC["store.readMessages(会话, seq-1, 1) 读出这一条"]',
      '  REC --> MEM["store.getConversation(会话).members"]',
      '  MEM --> CONN["每个成员 registry.connectionsOf(成员)"]',
      '  CONN --> DEV["transport.deviceOf(连接) 拿到设备 id"]',
      '  DEV --> HAS{"位点已经到 seq 了？"}',
      '  HAS -- 到了 --> SKIP["跳过，计入 skipped"]',
      '  HAS -- 没到 --> PUSH["transport.push(连接, 消息帧)"]',
      '  PUSH --> ADV["位点 = max(位点, seq)"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  R["resume(userId, deviceId)"] --> SINCE["用位点拼出 since 表"]',
      '  SINCE --> PULL["backlog.pull(userId, since, catchUpLimit)"]',
      '  PULL --> SEND["逐条 push 到这台设备的连接"]',
      '  SEND --> ADV2["位点 = max(位点, 这次推到的 seq)"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  A["acknowledge(设备, 会话, seq)"] --> MAX["位点 = max(位点, seq)"]',
      '  MAX --> NOTE["迟到的确认在这里被吃掉<br/>而不是让位点倒退"]',
      '```',
      '',
      '要点：三条路径最后都汇到同一个 `max` 上。',
      '任何一条绕过它直接写位点，重复推送就会从那条路径漏出来。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  P["publish(conversation, seq, origin device)"] --> ORIG{"is there an origin device?"}',
      '  ORIG -- yes --> BUMP["move its cursor to seq first<br/>it wrote the message, it has it"]',
      '  ORIG -- no --> REC',
      '  BUMP --> REC["store.readMessages(conversation, seq-1, 1)"]',
      '  REC --> MEM["store.getConversation(conversation).members"]',
      '  MEM --> CONN["registry.connectionsOf(member) for each member"]',
      '  CONN --> DEV["transport.deviceOf(connection) for the device id"]',
      '  DEV --> HAS{"cursor already at seq?"}',
      '  HAS -- yes --> SKIP["skip, count it as skipped"]',
      '  HAS -- no --> PUSH["transport.push(connection, message frame)"]',
      '  PUSH --> ADV["cursor = max(cursor, seq)"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  R["resume(userId, deviceId)"] --> SINCE["assemble since from the cursors"]',
      '  SINCE --> PULL["backlog.pull(userId, since, catchUpLimit)"]',
      '  PULL --> SEND["push each entry to this device"]',
      '  SEND --> ADV2["cursor = max(cursor, what was pushed)"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  A["acknowledge(device, conversation, seq)"] --> MAX["cursor = max(cursor, seq)"]',
      '  MAX --> NOTE["a late confirmation is absorbed here<br/>instead of dragging the mark back"]',
      '```',
      '',
      'The point: all three paths funnel into the same `max`. Let any one of them write the cursor',
      'directly and duplicate delivery leaks out through that path.',
    ].join('\n')
  ),

  checklist: [
    t('位点只用 max 前进，永不回退', 'The cursor only advances through max, never backwards'),
    t('发出消息的那台设备不收消息体，但位点前进', 'The origin device gets no body but its cursor advances'),
    t('同一个人的其他设备一定收到', 'The same person\'s other devices always receive it'),
    t('位点已到 seq 的设备直接跳过', 'A device whose cursor reaches seq is skipped'),
    t('resume 有上限，复用第 3 关的分页', 'resume is bounded and reuses stage 3\'s paging'),
  ],

  pitfalls: [
    t(
      '`acknowledge` 里直接 `putCursor(..., seq)`。确认包乱序到达是常态而不是异常，写进去的那一刻位点就退了，那条消息于是被重推一次 —— 用户看到一条老消息带着旧时间戳跳到会话底部。水位线的定义就是 max，绕过它这个结构就不成立了。',
      'Calling `putCursor(..., seq)` straight from `acknowledge`. Out-of-order confirmations are the normal case, not the exception; the write drops the cursor and the message is pushed again, so the user watches an old message with an old timestamp jump to the bottom of the conversation. A high-water mark is defined by its max, and bypassing it means you no longer have one.'
    ),
    t(
      '给发消息的那台设备也推一份消息体。看起来无害 —— 客户端反正会按 seq 去重。代价是白白多一份流量，而且发送方的客户端要处理「我自己发的消息又回来了」这个状态：它本地那条消息还处在「发送中」，收到推送时如果没认出是自己的，会渲染成第二个气泡。真实 IM 里这个 bug 非常常见。',
      'Pushing the body back to the device that sent it. It looks harmless because the client will dedupe by seq. It costs a redundant copy, and it forces the sending client to handle "my own message came back": its local copy is still in the sending state, and if it fails to recognise the echo it renders a second bubble. This bug is extremely common in real clients.'
    ),
    t(
      '只推给「发送者以外的成员」，把整个发送者跳过。这样手机发的消息在同一个人的电脑上永远不出现 —— 这不是优化，是多端同步彻底没做。要跳过的是**那一台设备**，不是那个人。',
      'Skipping the whole sender instead of the sending device. A message sent from the phone then never appears on the same person\'s laptop, which is not an optimisation but the complete absence of multi-device sync. The thing to skip is **the device**, not the person.'
    ),
    t(
      '在 `publish` 里给不在线的设备也留一份「待推送」。听起来是好意，实际上是在重新发明第 3 关：设备重新上线时会走 `resume`，服务端按位点算出它缺什么，不需要任何离线队列。多留一份待推队列意味着两套状态要保持一致，而它们迟早不一致。',
      'Keeping a pending-push list for devices that are offline. It sounds considerate and it reinvents stage 3: a device that comes back runs `resume`, and the server derives what it lacks from the cursor. An extra queue means two pieces of state that have to agree, and eventually they will not.'
    ),
  ],

  hints: [
    t(
      '把「前进位点」写成一个私有函数，`publish`、`resume`、`acknowledge` 三条路都调它。三个地方各写一次 `putCursor`，总有一个会忘了 max。',
      'Write "advance the cursor" once as a private function and call it from `publish`, `resume` and `acknowledge`. Three separate `putCursor` calls and one of them will forget the max.'
    ),
    t(
      '`resume` 里的 `since` 表：遍历 `store.conversationsOf(userId)`，每个会话取 `cursorOf(deviceId, 会话)`。这正好是 `backlog.pull` 想要的形状。',
      'The `since` map in `resume`: walk `store.conversationsOf(userId)` and take `cursorOf(deviceId, conversation)` for each. That is exactly the shape `backlog.pull` wants.'
    ),
  ],

  extension: t(
    [
      '多端同步是 IM 和消息队列分道扬镳的地方。队列里一条消息被一个消费者',
      '取走就结束了；IM 里「取走」这个动作对同一个人的每台设备都要发生一次，',
      '而且设备数量是随时变化的。',
      '',
      'Signal 的做法是把每台设备当成一个独立的收件人（linked device），',
      '发消息时对每台设备各加密一份 —— 这也是为什么 Signal 加一台新设备',
      '需要扫码，以及为什么新设备看不到历史消息：历史消息是加密给旧设备的，',
      '服务端没有明文可以补给新设备。这个取舍在第 10 关会再遇到一次。',
      '',
      'iMessage 走的是另一条路：消息在 Apple 的服务器上按设备分发，',
      '而历史记录靠 iCloud 备份同步，于是「端到端加密」和「换新手机能看到历史」',
      '这两件事被拆成了两套机制。',
      '',
      '水位线（high-water mark）这个词在分布式系统里到处都是：Kafka 的 HW、',
      'Flink 的 watermark、Raft 的 commitIndex，共同点是「只涨不落」，',
      '因为一旦允许回退，所有基于它做的判断都要重新考虑「如果它退了会怎样」。',
    ].join('\n'),
    [
      'Multi-device sync is where IM and message queues part company. In a queue, one consumer taking a',
      'message ends the story; in IM that has to happen once per device belonging to the same person, and',
      'the number of devices changes at any time.',
      '',
      'Signal treats every device as an independent recipient — a linked device — and encrypts a separate',
      'copy for each. That is why adding a Signal device requires scanning a code, and why a new device',
      'cannot see old messages: the history was encrypted for the old devices and the server holds no',
      'plaintext to backfill from. Stage 10 runs into the same trade-off.',
      '',
      'iMessage took the other road: messages are fanned out per device by Apple\'s servers while history',
      'syncs through iCloud backup, which splits "end-to-end encrypted" and "my new phone shows my history"',
      'into two separate mechanisms.',
      '',
      'The term high-water mark shows up everywhere in distributed systems: Kafka\'s HW, Flink\'s watermark,',
      'Raft\'s commitIndex. What they share is monotonicity, because the moment a mark is allowed to move',
      'back, every decision made from it has to be re-examined for what happens when it does.',
    ].join('\n')
  ),

  focus: ['correctness', 'concurrency', 'encapsulation'],
  lab: {},

  starterFiles: [
    file(
      'src/device/deviceSync.ts',
      code`
        import type { Backlog } from '../conversation/backlog';
        import type { ConnectionRegistry } from '../session/registry';
        import type { Store } from '../support/store';
        import type { Transport } from '../support/transport';

        /** Cursor table: how far a device has been served. */
        export const DEVICE_CURSOR = 'deviceSync';

        export interface DeviceSyncOptions {
          /** Most messages pushed to one device in a single resume */
          catchUpLimit: number;
        }

        export interface PublishResult {
          /** Connection ids that received the body */
          delivered: string[];
          /** Live devices that already had it, including the origin device */
          skipped: number;
        }

        export interface DeviceSync {
          publish(conversationId: string, seq: number, originDeviceId?: string): PublishResult;
          /** Push the bounded remainder this device is missing. Returns frames pushed. */
          resume(userId: string, deviceId: string): number;
          /** The device confirms it holds everything up to seq. */
          acknowledge(deviceId: string, conversationId: string, seq: number): void;
          cursorOf(deviceId: string, conversationId: string): number;
        }

        export function createDeviceSync(
          store: Store,
          transport: Transport,
          registry: ConnectionRegistry,
          backlog: Backlog,
          options: DeviceSyncOptions
        ): DeviceSync {
          // TODO: implement
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
        import { createBacklog } from '../src/conversation/backlog';
        import { createSequencer } from '../src/conversation/sequence';
        import { createDeviceSync } from '../src/device/deviceSync';
        import { createRegistry } from '../src/session/registry';
        import { createStore } from '../src/support/store';
        import { createTransport } from '../src/support/transport';
        import { count } from '@lab/metrics';

        const IDLE_MS = 100000;

        function makeWorld(catchUpLimit = 50) {
          const store = createStore();
          const transport = createTransport();
          const registry = createRegistry(transport, { idleMs: IDLE_MS });
          const sequencer = createSequencer(store);
          const backlog = createBacklog(store);
          const sync = createDeviceSync(store, transport, registry, backlog, { catchUpLimit });
          return { store, transport, registry, sequencer, backlog, sync };
        }

        function conversation(world: any, id: string, members: string[]): void {
          world.store.putConversation({ conversationId: id, kind: 'direct', members });
        }

        /** Append a message without fanning it out yet. */
        function write(world: any, conversationId: string, sender: string, nth: number): number {
          return world.sequencer.send({
            conversationId,
            senderId: sender,
            clientMsgId: conversationId + '-m' + nth,
            payload: 'text-' + nth,
            sentAt: nth,
          }).seq;
        }

        function messageFrames(world: any, connectionId: string) {
          return world.transport.inbox(connectionId).filter((frame: any) => frame.kind === 'message');
        }

        describe('阶段4 · 每设备位点与多端同步', () => {
          it('推给会话里每个成员的每一台活设备', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const alicePhone = world.registry.attach('alice', 'alice-phone');
            const bobPhone = world.registry.attach('bob', 'bob-phone');
            const bobLaptop = world.registry.attach('bob', 'bob-laptop');

            const seq = write(world, 'c1', 'alice', 1);
            const result = world.sync.publish('c1', seq);

            expect(result.delivered).toHaveLength(3);
            expect(messageFrames(world, alicePhone)).toHaveLength(1);
            expect(messageFrames(world, bobPhone)).toHaveLength(1);
            expect(messageFrames(world, bobLaptop)).toHaveLength(1);
          });

          it('自己的另一台设备收得到，发出的那台收不到消息体 [gate:self]', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const alicePhone = world.registry.attach('alice', 'alice-phone');
            const aliceLaptop = world.registry.attach('alice', 'alice-laptop');
            const bobPhone = world.registry.attach('bob', 'bob-phone');

            const seq = write(world, 'c1', 'alice', 1);
            world.sync.publish('c1', seq, 'alice-phone');

            // 同一个人的另一台设备没收到，就是多端同步没做
            if (messageFrames(world, aliceLaptop).length === 0) count('selfSyncMisses');

            expect(messageFrames(world, aliceLaptop)).toHaveLength(1);
            expect(messageFrames(world, alicePhone)).toHaveLength(0);
            expect(messageFrames(world, bobPhone)).toHaveLength(1);
          });

          it('发出消息的那台设备位点也前进了', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            world.registry.attach('alice', 'alice-phone');

            const seq = write(world, 'c1', 'alice', 1);
            world.sync.publish('c1', seq, 'alice-phone');

            expect(world.sync.cursorOf('alice-phone', 'c1')).toBe(1);
          });

          it('catch-up 先跑，随后到达的 publish 不会重复推', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const bobPhone = world.registry.attach('bob', 'bob-phone');
            const seq = write(world, 'c1', 'alice', 1);

            // 重连的补推先到，扇出随后才跑
            world.sync.resume('bob', 'bob-phone');
            const result = world.sync.publish('c1', seq);

            expect(messageFrames(world, bobPhone)).toHaveLength(1);
            expect(result.delivered).toEqual([]);
            expect(result.skipped).toBe(1);
          });

          it('publish 先跑，随后的 resume 不会重复推', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const bobPhone = world.registry.attach('bob', 'bob-phone');
            const seq = write(world, 'c1', 'alice', 1);

            world.sync.publish('c1', seq);
            const pushed = world.sync.resume('bob', 'bob-phone');

            expect(pushed).toBe(0);
            expect(messageFrames(world, bobPhone)).toHaveLength(1);
          });

          it('连续两次 resume，第二次一帧都不推', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const bobPhone = world.registry.attach('bob', 'bob-phone');
            write(world, 'c1', 'alice', 1);
            write(world, 'c1', 'alice', 2);

            expect(world.sync.resume('bob', 'bob-phone')).toBe(2);
            expect(world.sync.resume('bob', 'bob-phone')).toBe(0);
            expect(messageFrames(world, bobPhone)).toHaveLength(2);
          });

          it('resume 有上限，剩下的下一次再补', () => {
            const world = makeWorld(3);
            conversation(world, 'c1', ['alice', 'bob']);
            world.registry.attach('bob', 'bob-phone');
            for (let nth = 1; nth <= 8; nth += 1) write(world, 'c1', 'alice', nth);

            expect(world.sync.resume('bob', 'bob-phone')).toBe(3);
            expect(world.sync.cursorOf('bob-phone', 'c1')).toBe(3);
            expect(world.sync.resume('bob', 'bob-phone')).toBe(3);
            expect(world.sync.resume('bob', 'bob-phone')).toBe(2);
            expect(world.sync.resume('bob', 'bob-phone')).toBe(0);
          });

          it('acknowledge 让位点前进，之后不再推', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const bobPhone = world.registry.attach('bob', 'bob-phone');
            write(world, 'c1', 'alice', 1);
            write(world, 'c1', 'alice', 2);

            // 设备自己走第 3 关的拉取补齐了，然后确认
            world.sync.acknowledge('bob-phone', 'c1', 2);

            expect(world.sync.resume('bob', 'bob-phone')).toBe(0);
            expect(messageFrames(world, bobPhone)).toHaveLength(0);
          });

          it('迟到的 acknowledge 不会让位点倒退', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            world.registry.attach('bob', 'bob-phone');
            for (let nth = 1; nth <= 5; nth += 1) write(world, 'c1', 'alice', nth);

            world.sync.acknowledge('bob-phone', 'c1', 5);
            world.sync.acknowledge('bob-phone', 'c1', 2);

            expect(world.sync.cursorOf('bob-phone', 'c1')).toBe(5);
            expect(world.sync.resume('bob', 'bob-phone')).toBe(0);
          });

          it('不在线的设备不会被推，重连之后补上', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const seq = write(world, 'c1', 'alice', 1);

            const result = world.sync.publish('c1', seq);
            expect(result.delivered).toEqual([]);

            const bobPhone = world.registry.attach('bob', 'bob-phone');
            expect(world.sync.resume('bob', 'bob-phone')).toBe(1);
            expect(messageFrames(world, bobPhone)).toHaveLength(1);
          });

          it('不是成员的人一帧都收不到', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            world.registry.attach('alice', 'alice-phone');
            const outsider = world.registry.attach('carol', 'carol-phone');

            const seq = write(world, 'c1', 'alice', 1);
            world.sync.publish('c1', seq);

            expect(world.transport.inbox(outsider)).toEqual([]);
          });

          it('resume 对一台没有连接的设备返回 0', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            write(world, 'c1', 'alice', 1);

            expect(world.sync.resume('bob', 'bob-phone')).toBe(0);
            expect(world.sync.cursorOf('bob-phone', 'c1')).toBe(0);
          });

          it('推出去的帧带着会话和 seq', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const bobPhone = world.registry.attach('bob', 'bob-phone');

            const seq = write(world, 'c1', 'alice', 1);
            world.sync.publish('c1', seq);

            const frame = messageFrames(world, bobPhone)[0];
            expect(frame.conversationId).toBe('c1');
            expect(frame.seq).toBe(1);
            expect(frame.payload).toBe('text-1');
          });
        });
      `
    ),
  ],

  gates: [
    gate({
      metric: 'counters.duplicatePush',
      op: 'eq',
      value: 0,
      zh: '同一台设备没拿到过重复的消息',
      en: 'No device ever received the same message twice',
      dimension: 'correctness',
    }),
    gate({
      metric: 'counters.selfSyncMisses',
      op: 'eq',
      value: 0,
      zh: '同一个人的其他设备一次都没漏',
      en: 'The sender\'s other devices were never missed',
      dimension: 'correctness',
      scope: 'gate:self',
    }),
    gate({
      metric: 'counters.cursorRegressions',
      op: 'eq',
      value: 0,
      zh: '位点一次都没有倒退',
      en: 'The cursor never moved backwards',
      dimension: 'resilience',
    }),
  ],

  referenceFiles: [
    file(
      'src/device/deviceSync.ts',
      code`
        import type { Backlog, SyncPoint } from '../conversation/backlog';
        import type { ConnectionRegistry } from '../session/registry';
        import type { Store } from '../support/store';
        import type { Transport } from '../support/transport';

        export const DEVICE_CURSOR = 'deviceSync';

        export interface DeviceSyncOptions {
          catchUpLimit: number;
        }

        export interface PublishResult {
          delivered: string[];
          skipped: number;
        }

        export interface DeviceSync {
          publish(conversationId: string, seq: number, originDeviceId?: string): PublishResult;
          resume(userId: string, deviceId: string): number;
          acknowledge(deviceId: string, conversationId: string, seq: number): void;
          cursorOf(deviceId: string, conversationId: string): number;
        }

        export function createDeviceSync(
          store: Store,
          transport: Transport,
          registry: ConnectionRegistry,
          backlog: Backlog,
          options: DeviceSyncOptions
        ): DeviceSync {
          function cursorOf(deviceId: string, conversationId: string): number {
            return store.getCursor(DEVICE_CURSOR, deviceId, conversationId);
          }

          /**
           * The one place the cursor moves.
           *
           * It is a high-water mark, so it takes the max and nothing else. Every
           * path — live push, catch-up, acknowledgement — comes through here, which
           * is what makes a reordered acknowledgement harmless.
           */
          function advance(deviceId: string, conversationId: string, seq: number): void {
            const current = cursorOf(deviceId, conversationId);
            if (seq <= current) return;
            store.putCursor(DEVICE_CURSOR, deviceId, conversationId, seq);
          }

          function connectionFor(userId: string, deviceId: string): string | undefined {
            return registry
              .connectionsOf(userId)
              .filter((connectionId) => transport.deviceOf(connectionId) === deviceId)[0];
          }

          return {
            publish(conversationId: string, seq: number, originDeviceId?: string): PublishResult {
              // The composing device already holds the message; mark it, then let the
              // ordinary "does this device have it" test skip it like any other.
              if (originDeviceId) advance(originDeviceId, conversationId, seq);

              const meta = store.getConversation(conversationId);
              if (!meta) return { delivered: [], skipped: 0 };

              const record = store.readMessages(conversationId, seq - 1, 1)[0];
              if (!record) return { delivered: [], skipped: 0 };

              const delivered: string[] = [];
              let skipped = 0;

              for (const member of meta.members) {
                for (const connectionId of registry.connectionsOf(member)) {
                  const deviceId = transport.deviceOf(connectionId);
                  if (!deviceId) continue;
                  if (cursorOf(deviceId, conversationId) >= seq) {
                    skipped += 1;
                    continue;
                  }
                  transport.push(connectionId, {
                    kind: 'message',
                    conversationId,
                    seq,
                    payload: record.payload,
                  });
                  advance(deviceId, conversationId, seq);
                  delivered.push(connectionId);
                }
              }

              return { delivered, skipped };
            },

            resume(userId: string, deviceId: string): number {
              const connectionId = connectionFor(userId, deviceId);
              if (!connectionId) return 0;

              // What the server believes this device holds becomes stage 3's since map
              const since: SyncPoint = {};
              for (const conversationId of store.conversationsOf(userId)) {
                since[conversationId] = cursorOf(deviceId, conversationId);
              }

              const page = backlog.pull({ userId, since, limit: options.catchUpLimit });
              for (const entry of page.entries) {
                transport.push(connectionId, {
                  kind: 'message',
                  conversationId: entry.conversationId,
                  seq: entry.seq,
                  payload: entry.payload,
                });
                advance(deviceId, entry.conversationId, entry.seq);
              }

              return page.entries.length;
            },

            acknowledge(deviceId: string, conversationId: string, seq: number): void {
              advance(deviceId, conversationId, seq);
            },

            cursorOf,
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 5 关 · 已读位点与未读数                                            */
/* ------------------------------------------------------------------ */

const stage5 = {
  id: 'read-cursor',
  title: t('第 5 关 · 已读位点与未读数', 'Stage 5 · Read cursors and unread counts'),
  goal: t(
    [
      '第 4 关让每台设备都**拿到**了消息。但「拿到」不是「读了」。',
      '',
      '这是 IM 里最人类的一个概念：未读数。它有两个和前四关都不同的性质：',
      '',
      '- **它属于人，不属于设备。** 在手机上读完，电脑上的红点必须也消失。',
      '  第 4 关那个位点是每设备一份的，这一关这个是每人一份的 ——',
      '  同一个会话，两条位点，含义完全不同，别把它们混成一条；',
      '- **它是推导出来的，不是存下来的。** 未读数 = 会话总条数 − 已读位点。',
      '  存一个计数器然后收到消息加一、点开减一，是这个领域里最经典的 bug：',
      '  两条路径任何一条漏一次或者重一次，红点就永远对不上了，',
      '  而且没有任何办法从错误状态恢复 —— 因为你已经不知道正确值是多少了。',
      '',
      '## 要实现什么',
      '',
      '在 `src/conversation/readCursor.ts` 实现 `createReadCursors(store)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `markRead(userId, conversationId, seq)` | 推进已读位点，返回生效后的值 |',
      '| `readSeq(userId, conversationId)` | 当前已读到哪 |',
      '| `unreadOf(userId, conversationId)` | 这个会话还有几条没读 |',
      '| `summary(userId)` | 所有有未读的会话 + 总数 |',
      '',
      '两条硬规则：',
      '',
      '1. **只涨不落。** 一台落后的设备上报旧位点，不能把已读变回未读；',
      '2. **上限是会话末尾。** 客户端报 999 而会话只有 20 条时，位点停在 20。',
      '',
      '## 怎么算过',
      '',
      '- 手机读了，同一个人电脑上的未读也归零；',
      '- 落后的设备回报旧位点之后，位点纹丝不动',
      '  （门槛 `counters.cursorRegressions = 0`）；',
      '- 位点被夹到 20 之后，第 21 条到达时**仍然算未读**；',
      '- 自己发的消息不算自己的未读；',
      '- 50 个会话算一遍未读总数，**一条记录都不读**',
      '  （门槛 `counters.messagesScanned = 0`）。',
      '',
      '## 那个坑',
      '',
      '第 2 条规则看起来是防御性编程，其实不是。',
      '',
      '不夹上限的话，客户端报一个 999，位点就写进去 999。',
      '接下来第 21 到第 999 条消息全部落在位点**下面** ——',
      '它们一到就已经是「已读」状态，红点不亮，会话列表不置顶，',
      '用户完全不知道有人给他发过消息。而这个状态是**永久**的：',
      '未读数是推导出来的，位点错了就没有任何东西能纠正它。',
      '',
      '客户端上报 999 不需要恶意，一个把「最后一条消息 id」和「seq」搞混的',
      '版本就够了，而它会在应用商店里存在好几周。',
    ].join('\n'),
    [
      'Stage 4 got the message **onto** every device. Having it is not reading it.',
      '',
      'The unread count is the most human concept in the system, and it differs from everything in the',
      'first four stages in two ways:',
      '',
      '- **It belongs to the person, not the device.** Read it on the phone and the badge on the laptop has',
      '  to clear too. Stage 4\'s cursor is one per device; this one is one per person. Same conversation,',
      '  two cursors, entirely different meanings — do not collapse them into one;',
      '- **It is derived, not stored.** Unread equals the conversation length minus the read cursor. Keeping',
      '  a counter and incrementing on arrival, decrementing on open, is the canonical bug of this domain:',
      '  miss once or double once on either path and the badge is wrong forever, with no way back, because',
      '  nothing remembers what the right number was.',
      '',
      '## What to build',
      '',
      'Implement `createReadCursors(store)` in `src/conversation/readCursor.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `markRead(userId, conversationId, seq)` | Advance the read cursor; return the resulting value |',
      '| `readSeq(userId, conversationId)` | Where the cursor is |',
      '| `unreadOf(userId, conversationId)` | How many are unread here |',
      '| `summary(userId)` | Every conversation with unread, plus the total |',
      '',
      'Two hard rules:',
      '',
      '1. **It only rises.** A lagging device reporting an old position cannot un-read anything;',
      '2. **The ceiling is the end of the conversation.** A client reporting 999 for a 20-message',
      '   conversation leaves the cursor at 20.',
      '',
      '## What counts as passing',
      '',
      '- Reading on the phone zeroes the unread count on the same person\'s laptop;',
      '- A lagging device reporting an old position moves nothing',
      '  (the `counters.cursorRegressions = 0` gate);',
      '- After the cursor is clamped to 20, message 21 **still counts as unread**;',
      '- Your own messages are not unread for you;',
      '- Totalling unread across 50 conversations **reads no records at all**',
      '  (the `counters.messagesScanned = 0` gate).',
      '',
      '## The trap',
      '',
      'Rule 2 looks like defensive programming. It is not.',
      '',
      'Without the clamp, a client reporting 999 gets 999 written. Messages 21 through 999 then arrive',
      '**below** the cursor — already read the moment they land. No badge, no bump to the top of the',
      'conversation list, and the user has no idea anyone wrote to them. The state is **permanent**: the',
      'unread count is derived, so once the cursor is wrong nothing exists that could correct it.',
      '',
      'Reporting 999 does not require malice. One client build that confuses "last message id" with "seq"',
      'is enough, and it will sit in the app store for weeks.',
    ].join('\n')
  ),

  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  M["markRead(userId, 会话, seq)"] --> HEAD["head = store.messageCount(会话)"]',
      '  HEAD --> CAP["capped = min(seq, head)<br/>客户端报多少都不能超过会话末尾"]',
      '  CAP --> CUR["current = store.getCursor(read, userId, 会话)"]',
      '  CUR --> UP{"capped 比 current 大？"}',
      '  UP -- 不大 --> KEEP["什么都不写<br/>落后的设备在这里被挡住"]',
      '  UP -- 大 --> WRITE["store.putCursor(read, userId, 会话, capped)"]',
      '  KEEP --> RET["返回 max(current, capped)"]',
      '  WRITE --> RET',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  U["unreadOf(userId, 会话)"] --> H2["head = store.messageCount(会话)"]',
      '  H2 --> C2["cursor = store.getCursor(read, userId, 会话)"]',
      '  C2 --> SUB["返回 max(0, head - cursor)<br/>推导，不是读计数器"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  S["summary(userId)"] --> LOOP["store.conversationsOf(userId) 逐个"]',
      '  LOOP --> ONE["unreadOf(userId, 会话)"]',
      '  ONE --> PICK{"大于 0？"}',
      '  PICK -- 是 --> COLL["收进列表，累加到 total"]',
      '  PICK -- 否 --> NEXT["跳过"]',
      '  COLL --> NEXT',
      '  NEXT --> OUT["返回 conversations + total<br/>全程没读过一条消息记录"]',
      '```',
      '',
      '要点：`min` 和 `max` 各出现一次，缺哪个都会坏 ——',
      '缺 `min`，新消息一到就是已读；缺 `max`，已读会被落后的设备变回未读。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  M["markRead(userId, conversation, seq)"] --> HEAD["head = store.messageCount(conversation)"]',
      '  HEAD --> CAP["capped = min(seq, head)<br/>no client claim exceeds the end"]',
      '  CAP --> CUR["current = store.getCursor(read, userId, conversation)"]',
      '  CUR --> UP{"is capped above current?"}',
      '  UP -- no --> KEEP["write nothing<br/>the lagging device stops here"]',
      '  UP -- yes --> WRITE["store.putCursor(read, userId, conversation, capped)"]',
      '  KEEP --> RET["return max(current, capped)"]',
      '  WRITE --> RET',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  U["unreadOf(userId, conversation)"] --> H2["head = store.messageCount(conversation)"]',
      '  H2 --> C2["cursor = store.getCursor(read, userId, conversation)"]',
      '  C2 --> SUB["return max(0, head - cursor)<br/>derived, not a counter read"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  S["summary(userId)"] --> LOOP["walk store.conversationsOf(userId)"]',
      '  LOOP --> ONE["unreadOf(userId, conversation)"]',
      '  ONE --> PICK{"above zero?"}',
      '  PICK -- yes --> COLL["collect it, add to total"]',
      '  PICK -- no --> NEXT["skip"]',
      '  COLL --> NEXT',
      '  NEXT --> OUT["return conversations + total<br/>not one message record was read"]',
      '```',
      '',
      'The point: `min` appears once and `max` appears once, and dropping either breaks it — without the',
      '`min` new messages arrive pre-read, without the `max` a lagging device un-reads them.',
    ].join('\n')
  ),

  checklist: [
    t('未读数由「总数 − 位点」推导，不存计数器', 'Unread is derived from length minus cursor, never stored'),
    t('位点按人记，两台设备共享一条', 'The cursor is per person and shared by that person\'s devices'),
    t('位点只涨不落', 'The cursor only rises'),
    t('上报值被夹到会话末尾', 'A reported position is clamped to the end of the conversation'),
    t('summary 不读任何消息记录', 'summary reads no message records'),
  ],

  pitfalls: [
    t(
      '把未读数存成一个计数器，收到消息 +1、点开会话清零。两条路径里任何一条漏一次或者重一次，红点就永远错了，而且无法自愈 —— 你已经不知道正确值是多少。真实产品里这个 bug 的表现是「点进去什么都没有，退出来红点还在」，用户会反复点它，然后去应用商店打一星。位点是可以对账的，计数器不行。',
      'Storing unread as a counter, incrementing on arrival and clearing on open. Miss once or double once on either path and the badge is permanently wrong with no way to self-heal, because nothing knows the right value any more. In shipped products this is the "open it, nothing there, back out, badge still on" bug that users poke at repeatedly before leaving a one-star review. A cursor can be reconciled; a counter cannot.'
    ),
    t(
      '不夹上限，直接写客户端上报的 seq。客户端报一个超出末尾的数（把消息 id 当成 seq 是最常见的原因），之后所有新消息都落在位点下面，一到达就是已读状态：不亮红点、不置顶、用户永远不知道有人找过他。而且因为未读是推导出来的，这个状态不会自己恢复。',
      'Writing whatever seq the client reported. One value past the end — confusing a message id with a sequence is the usual cause — and every later message lands below the cursor, arriving pre-read: no badge, no bump to the top, the user never learns anyone wrote. Because unread is derived, the state never recovers on its own.'
    ),
    t(
      '把第 4 关的设备位点直接拿来当已读位点。它们的语义完全不同：设备位点回答「这台设备收到哪了」，已读位点回答「这个人看到哪了」。合成一条的后果是消息一推到手机上就算已读 —— 手机在口袋里躺着，未读数已经清零了。',
      'Reusing stage 4\'s device cursor as the read cursor. They answer different questions: one is how far this device has been served, the other is how far this person has looked. Merge them and a message counts as read the moment it reaches the phone — which is in a pocket, with the badge already cleared.'
    ),
    t(
      '`summary` 里为了拿未读数去读消息记录，比如读出位点之后的所有消息再数一遍长度。一个在 200 个会话里的用户每次刷新会话列表都要读几千条记录，而会话列表是 IM 里**打开频率最高**的界面 —— 每次切前台、每次收到推送、每次下拉刷新都要算一遍。总数是 `messageCount − cursor`，两个免费的数相减。',
      'Reading message records in `summary` to obtain the count — fetching everything after the cursor and taking its length. Someone in 200 conversations then reads thousands of records to refresh the conversation list, which is the **most frequently opened** screen in the product: every foreground, every notification, every pull-to-refresh. The number is `messageCount − cursor`, two free values subtracted.'
    ),
  ],

  hints: [
    t(
      '`markRead` 里 `min` 和 `max` 都要有：`min` 夹住客户端上报的上限，`max` 挡住落后设备的回退。顺序是先 `min` 后比较，反过来会把一个超大的值和当前值比较，然后写进去。',
      'Both `min` and `max` belong in `markRead`: the `min` caps what the client claims, the `max` blocks a lagging device. Clamp first, then compare — the other order compares an oversized value against the current one and writes it.'
    ),
    t(
      '自己发的消息不算自己的未读，靠的是发送时也调一次 `markRead`。不需要在算未读的时候去看每条消息的发送者 —— 那会让 `summary` 变成一次全量扫描。',
      'Your own messages stay out of your unread count because sending also calls `markRead`. There is no need to inspect senders while counting, which is what would turn `summary` into a full scan.'
    ),
  ],

  extension: t(
    [
      '「未读数不准」是 IM 产品最长寿的一类投诉，几乎每个平台都有过。',
      '原因基本都一样：未读是存下来的而不是推导出来的，于是任何一次',
      '推送丢失、重复投递、客户端崩溃都会让它偏一格，而且永远回不来。',
      '',
      '推导式的方案还有一个额外好处：**可以对账**。服务端和客户端各自算一遍',
      '`总数 − 位点`，两边应该相等；不等就说明有一边的会话长度不对，',
      '这是一个可以被监控、可以被自动修复的错误。计数器方案里，',
      '「不等」根本无从发现，因为没有第二个数可以比。',
      '',
      '真实系统里还有几个这一关没做的维度：',
      '',
      '- **@我的**单独计数，因为它的优先级不同（群里 500 条未读，',
      '  但只有 1 条 @ 你，红点要显示的是后者）；',
      '- **免打扰**的会话算未读但不加进总数；',
      '- **多端已读上报的节流**：手指在会话里滑动时位点每秒变几十次，',
      '  全部上报会把上行带宽打满，通常是本地节流 + 退出会话时强制上报一次。',
      '',
      '最后一个细节：位点该记「已读到第几条」还是「第一条未读是第几条」？',
      '两种都有人用，差一格。选定之后要在服务端、客户端、协议里保持一致 ——',
      '这是那种一旦不一致就会产生「永远有一条读不掉的消息」的经典差一错误。',
    ].join('\n'),
    [
      '"The unread count is wrong" is the longest-lived complaint in this product category, and nearly',
      'every platform has had it. The cause is almost always the same: unread was stored rather than',
      'derived, so any lost push, duplicate delivery or client crash shifts it by one and it never comes',
      'back.',
      '',
      'Deriving it has a second benefit: **it can be reconciled.** The server and the client each compute',
      '`length − cursor` and the two should agree; when they do not, one side has the wrong conversation',
      'length, which is a monitorable and automatically repairable error. With a counter, disagreement',
      'cannot even be detected, because there is no second number to compare against.',
      '',
      'A few dimensions this stage leaves out:',
      '',
      '- **mentions counted separately**, because they rank differently — 500 unread in a group of which',
      '  one mentions you, and the badge should be showing the one;',
      '- **muted conversations** that count as unread without joining the total;',
      '- **throttling read reports**: a finger scrolling through a conversation moves the cursor dozens of',
      '  times a second, and sending all of them saturates the uplink. The usual answer is local throttling',
      '  plus one forced report when the conversation closes.',
      '',
      'One last detail: does the cursor mean "read up to this one" or "first unread is this one"? Both are',
      'used and they differ by one. Whichever you choose has to hold across the server, the client and the',
      'protocol — this is the classic off-by-one that produces the message which can never be marked read.',
    ].join('\n')
  ),

  focus: ['correctness', 'latency', 'encapsulation'],
  lab: {},

  starterFiles: [
    file(
      'src/conversation/readCursor.ts',
      code`
        import type { Store } from '../support/store';

        /** Cursor table: how far a person has read. One per user, not per device. */
        export const READ_CURSOR = 'read';

        export interface ReadState {
          conversationId: string;
          readSeq: number;
          unread: number;
        }

        export interface UnreadSummary {
          /** Only the conversations that actually have unread messages */
          conversations: ReadState[];
          total: number;
        }

        export interface ReadCursors {
          /**
           * Advance the read position. Clamped to the end of the conversation and
           * never moved backwards. Returns the cursor after the call.
           */
          markRead(userId: string, conversationId: string, seq: number): number;
          readSeq(userId: string, conversationId: string): number;
          unreadOf(userId: string, conversationId: string): number;
          /** Must read no message records. */
          summary(userId: string): UnreadSummary;
        }

        export function createReadCursors(store: Store): ReadCursors {
          // TODO: implement
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
        import { createReadCursors } from '../src/conversation/readCursor';
        import { createSequencer } from '../src/conversation/sequence';
        import { createStore } from '../src/support/store';

        function makeWorld() {
          const store = createStore();
          const sequencer = createSequencer(store);
          return { store, sequencer, cursors: createReadCursors(store) };
        }

        function conversation(world: any, id: string, members: string[]): void {
          world.store.putConversation({ conversationId: id, kind: 'group', members });
        }

        /** Sending also advances the sender's own read cursor: you have read what you wrote. */
        function post(world: any, conversationId: string, sender: string, howMany: number): void {
          const base = world.store.messageCount(conversationId);
          for (let index = 1; index <= howMany; index += 1) {
            world.sequencer.send({
              conversationId,
              senderId: sender,
              clientMsgId: conversationId + '-m' + (base + index),
              payload: 'text',
              sentAt: base + index,
            });
          }
          world.cursors.markRead(sender, conversationId, world.store.messageCount(conversationId));
        }

        describe('阶段5 · 已读位点与未读数', () => {
          it('从没读过时未读数就是全部消息数', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            post(world, 'c1', 'bob', 4);

            expect(world.cursors.readSeq('alice', 'c1')).toBe(0);
            expect(world.cursors.unreadOf('alice', 'c1')).toBe(4);
          });

          it('推进位点之后未读数相应减少', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            post(world, 'c1', 'bob', 10);

            expect(world.cursors.markRead('alice', 'c1', 6)).toBe(6);
            expect(world.cursors.unreadOf('alice', 'c1')).toBe(4);
          });

          it('读到最新之后未读是 0', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            post(world, 'c1', 'bob', 3);

            world.cursors.markRead('alice', 'c1', 3);

            expect(world.cursors.unreadOf('alice', 'c1')).toBe(0);
            expect(world.cursors.summary('alice').conversations).toEqual([]);
          });

          it('位点按人记：两台设备上报的是同一条位点', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            post(world, 'c1', 'bob', 5);

            // 手机上报读到 3，电脑接着读到 5 —— 同一条位点，不是各存一份
            expect(world.cursors.markRead('alice', 'c1', 3)).toBe(3);
            expect(world.cursors.markRead('alice', 'c1', 5)).toBe(5);

            expect(world.cursors.readSeq('alice', 'c1')).toBe(5);
            expect(world.cursors.unreadOf('alice', 'c1')).toBe(0);
          });

          it('落后的设备上报旧位点，已读不会变回未读', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            post(world, 'c1', 'bob', 10);

            world.cursors.markRead('alice', 'c1', 9);
            expect(world.cursors.markRead('alice', 'c1', 3)).toBe(9);

            expect(world.cursors.readSeq('alice', 'c1')).toBe(9);
            expect(world.cursors.unreadOf('alice', 'c1')).toBe(1);
          });

          it('上报超过末尾的位点会被夹到末尾', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            post(world, 'c1', 'bob', 20);

            expect(world.cursors.markRead('alice', 'c1', 999)).toBe(20);
            expect(world.cursors.readSeq('alice', 'c1')).toBe(20);
          });

          it('夹住之后新到的消息仍然算未读', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            post(world, 'c1', 'bob', 20);
            world.cursors.markRead('alice', 'c1', 999);

            post(world, 'c1', 'bob', 5);

            expect(world.cursors.unreadOf('alice', 'c1')).toBe(5);
          });

          it('自己发的消息不算自己的未读', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            post(world, 'c1', 'bob', 2);
            world.cursors.markRead('alice', 'c1', 2);

            post(world, 'c1', 'alice', 3);

            expect(world.cursors.unreadOf('alice', 'c1')).toBe(0);
            expect(world.cursors.unreadOf('bob', 'c1')).toBe(3);
          });

          it('不同用户的位点互不影响', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            post(world, 'c1', 'carol', 6);

            world.cursors.markRead('alice', 'c1', 6);

            expect(world.cursors.unreadOf('alice', 'c1')).toBe(0);
            expect(world.cursors.unreadOf('bob', 'c1')).toBe(6);
          });

          it('summary 列出有未读的会话和总数', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            conversation(world, 'c2', ['alice', 'carol']);
            conversation(world, 'c3', ['alice', 'dave']);
            post(world, 'c1', 'bob', 3);
            post(world, 'c2', 'carol', 5);
            post(world, 'c3', 'dave', 2);
            world.cursors.markRead('alice', 'c3', 2);

            const summary = world.cursors.summary('alice');

            expect(summary.total).toBe(8);
            expect(summary.conversations.map((state: any) => state.conversationId)).toEqual(['c1', 'c2']);
            expect(summary.conversations[1].unread).toBe(5);
            expect(summary.conversations[1].readSeq).toBe(0);
          });

          it('不是成员的会话不出现在 summary 里', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            conversation(world, 'secret', ['bob', 'carol']);
            post(world, 'c1', 'bob', 2);
            post(world, 'secret', 'bob', 9);

            const summary = world.cursors.summary('alice');

            expect(summary.total).toBe(2);
            expect(summary.conversations).toHaveLength(1);
          });

          it('没见过的会话未读是 0，不抛', () => {
            const world = makeWorld();

            expect(world.cursors.unreadOf('alice', 'nope')).toBe(0);
            expect(world.cursors.readSeq('alice', 'nope')).toBe(0);
            expect(world.cursors.summary('alice')).toEqual({ conversations: [], total: 0 });
          });

          it('五十个会话算一遍未读，一条记录都不读 [gate:summary]', () => {
            const world = makeWorld();
            for (let index = 1; index <= 50; index += 1) {
              const id = 'k' + index;
              conversation(world, id, ['alice', 'bob']);
              post(world, id, 'bob', 20);
              world.cursors.markRead('alice', id, 12);
            }

            const summary = world.cursors.summary('alice');

            expect(summary.total).toBe(400);
            expect(summary.conversations).toHaveLength(50);
          });
        });
      `
    ),
  ],

  gates: [
    gate({
      metric: 'counters.cursorRegressions',
      op: 'eq',
      value: 0,
      zh: '已读位点一次都没有被拉回去',
      en: 'The read cursor was never dragged back',
      dimension: 'correctness',
    }),
    gate({
      metric: 'counters.messagesScanned',
      op: 'eq',
      value: 0,
      zh: '五十个会话的未读总数不读一条消息',
      en: 'Unread across fifty conversations reads no messages',
      dimension: 'latency',
      scope: 'gate:summary',
    }),
  ],

  referenceFiles: [
    file(
      'src/conversation/readCursor.ts',
      code`
        import type { Store } from '../support/store';

        export const READ_CURSOR = 'read';

        export interface ReadState {
          conversationId: string;
          readSeq: number;
          unread: number;
        }

        export interface UnreadSummary {
          conversations: ReadState[];
          total: number;
        }

        export interface ReadCursors {
          markRead(userId: string, conversationId: string, seq: number): number;
          readSeq(userId: string, conversationId: string): number;
          unreadOf(userId: string, conversationId: string): number;
          summary(userId: string): UnreadSummary;
        }

        export function createReadCursors(store: Store): ReadCursors {
          function readSeq(userId: string, conversationId: string): number {
            return store.getCursor(READ_CURSOR, userId, conversationId);
          }

          /** Derived, never stored: two pieces of free metadata subtracted. */
          function unreadOf(userId: string, conversationId: string): number {
            return Math.max(0, store.messageCount(conversationId) - readSeq(userId, conversationId));
          }

          return {
            markRead(userId: string, conversationId: string, seq: number): number {
              // Clamp first. A client reporting past the end would otherwise make every
              // future message arrive already read, permanently and undetectably.
              const capped = Math.min(seq, store.messageCount(conversationId));
              const current = readSeq(userId, conversationId);
              if (capped > current) {
                store.putCursor(READ_CURSOR, userId, conversationId, capped);
                return capped;
              }
              return current;
            },

            readSeq,
            unreadOf,

            summary(userId: string): UnreadSummary {
              const conversations: ReadState[] = [];
              let total = 0;

              for (const conversationId of store.conversationsOf(userId)) {
                const unread = unreadOf(userId, conversationId);
                if (unread === 0) continue;
                conversations.push({ conversationId, readSeq: readSeq(userId, conversationId), unread });
                total += unread;
              }

              return { conversations, total };
            },
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 6 关 · 送达与已读回执                                              */
/* ------------------------------------------------------------------ */

const stage6 = {
  id: 'receipts',
  title: t('第 6 关 · 送达与已读回执', 'Stage 6 · Delivery and read receipts'),
  goal: t(
    [
      '第 5 关让**接收方**知道自己有多少没读。这一关反过来：',
      '让**发送方**知道对面到底收到没有、看了没有。',
      '',
      '两个状态，两种粒度，这是这一关最容易搞混的地方：',
      '',
      '- **送达**是按人聚合的**设备状态**。「送到张三了」的意思是',
      '  张三的**任意一台**设备拿到了 —— 所以成员层面取所有设备里最大的那个位点；',
      '- **已读**是纯粹的**人的状态**，第 5 关那条位点直接就是答案。',
      '',
      '还有一条隐含关系要处理：**读过就一定送达过**。',
      '一台设备可能因为回执丢包而没上报送达，但它上报了已读 ——',
      '这时候还显示「未送达」就自相矛盾了。',
      '',
      '## 真正的难点是量',
      '',
      '一个 200 人的群，一条消息发出去，会产生多少个回执事件？',
      '199 个送达 + 199 个已读，将近 400 个。',
      '如果每个事件都立刻推一帧给在线的人，而在线的有 M 个，',
      '那就是 400 × M 帧 —— 一条消息引发几百上千帧，',
      '而这些帧携带的信息只有一句话：「已读 12/199」。',
      '',
      '所以回执必须**聚合**（推一个数，不推一串事件）',
      '并且**攒批**（一次 flush 推一轮，不是每个事件推一次）。',
      '',
      '## 要实现什么',
      '',
      '在 `src/conversation/receipts.ts` 实现 `createReceipts(...)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `noteDelivered(userId, conversationId, seq)` | 这个人的某台设备拿到了，位点取 max |',
      '| `noteRead(userId, conversationId, seq)` | 这个人读到了，委托给第 5 关的位点 |',
      '| `stateOf(conversationId, seq)` | 这条消息的聚合状态 |',
      '| `flush()` | 把有变化的会话各推一轮，返回推了几帧 |',
      '',
      '`stateOf` 里 `audience` 是**除发送者以外**的成员数 ——',
      '发送者不给自己发回执。',
      '',
      '## 怎么算过',
      '',
      '- 同一个人的两台设备分别报 3 和 5，这个人的送达状态是 5；',
      '- 只报了已读没报送达的人，`delivered` 里也算上；',
      '- 200 人的群里 199 个人读了，只有 3 个人在线，一轮 flush **最多 6 帧**',
      '  （门槛 `counters.framesPushed ≤ 6`）；',
      '- 没有新变化时 flush 推 0 帧；',
      '- 迟到的回执不会让已读人数**变少**（门槛 `counters.receiptRegressions = 0`），',
      '  也不会让 flush 白推一轮。',
      '',
      '## 那个坑',
      '',
      '在 `noteRead` 里直接推帧。',
      '',
      '这样写代码最短，语义看起来也最「实时」。代价是回执帧数变成',
      '**事件数 × 在线人数**，而回执事件的数量本身就是成员数的两倍。',
      '一个 500 人的群、一条早上九点发的通知，会在几分钟内产生几十万帧，',
      '每一帧都只是为了把「已读 217」改成「已读 218」。',
      '',
      '这个数字有一个特别恶劣的性质：**它和消息量无关，只和群大小的平方有关**。',
      '所以它在小群里完全看不出来，在大群里突然就把接入层打满了。',
    ].join('\n'),
    [
      'Stage 5 told the **recipient** how much they have not read. This stage is the other direction:',
      'telling the **sender** whether it arrived and whether it was seen.',
      '',
      'Two states at two granularities, which is the thing most easily confused here:',
      '',
      '- **Delivered** is a **device** fact aggregated per person. "Delivered to Alice" means **any one of**',
      '  Alice\'s devices has it, so the member-level value is the maximum across her devices;',
      '- **Read** is purely a **person** fact, and stage 5\'s cursor already is the answer.',
      '',
      'There is one implied relation to handle: **reading implies delivery.** A device may have lost its',
      'delivery receipt in transit while its read receipt got through, and showing "not delivered" for a',
      'message someone demonstrably read is self-contradictory.',
      '',
      '## The real difficulty is volume',
      '',
      'How many receipt events does one message in a 200-person group produce? 199 deliveries plus 199',
      'reads — close to 400. Push a frame for each event to each of the M people online and that is 400 × M',
      'frames, hundreds or thousands per message, all of them carrying one sentence: "read by 12 of 199".',
      '',
      'So receipts have to be **aggregated** — push a number, not a stream of events — and **batched**: one',
      'round per flush, not one push per event.',
      '',
      '## What to build',
      '',
      'Implement `createReceipts(...)` in `src/conversation/receipts.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `noteDelivered(userId, conversationId, seq)` | One of this person\'s devices has it; take the max |',
      '| `noteRead(userId, conversationId, seq)` | This person read to seq; delegate to stage 5 |',
      '| `stateOf(conversationId, seq)` | The aggregate state of one message |',
      '| `flush()` | Push one round for each changed conversation; return frames sent |',
      '',
      'In `stateOf`, `audience` is the member count **excluding the sender** — nobody sends themselves a',
      'receipt.',
      '',
      '## What counts as passing',
      '',
      '- Two devices of one person reporting 3 and 5 leaves that person at 5;',
      '- Someone who reported a read but never a delivery still counts as delivered;',
      '- In a 200-person group where 199 read and only 3 are online, one flush costs **at most 6 frames**',
      '  (the `counters.framesPushed ≤ 6` gate);',
      '- A flush with nothing new sends zero frames;',
      '- A late receipt never **lowers** the read count (the `counters.receiptRegressions = 0` gate) and',
      '  never causes a pointless flush round.',
      '',
      '## The trap',
      '',
      'Pushing a frame from inside `noteRead`.',
      '',
      'It is the shortest code and it looks the most real-time. The cost is that the frame count becomes',
      '**events × people online**, when the event count is already twice the member count. One announcement',
      'posted to a 500-person group at nine in the morning produces hundreds of thousands of frames within',
      'a few minutes, every one of them to change "read by 217" into "read by 218".',
      '',
      'That number has a particularly nasty property: **it is independent of message volume and quadratic',
      'in group size.** So it is invisible in small groups and saturates the access layer in large ones.',
    ].join('\n')
  ),

  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  ND["noteDelivered(userId, 会话, seq)"] --> MAXD{"比这个人的有效送达位点大？<br/>有效 = max(送达位点, 已读位点)"}',
      '  MAXD -- 不大 --> DROP["什么都不做<br/>连 dirty 都不标"]',
      '  MAXD -- 大 --> WD["putCursor(delivered, userId, 会话, seq)"]',
      '  WD --> DIRTY["把会话标记为有变化"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  NR["noteRead(userId, 会话, seq)"] --> MR["readCursors.markRead(...)<br/>第 5 关那条位点，自带夹上限和 max"]',
      '  MR --> ADV{"位点真的前进了？"}',
      '  ADV -- 没有 --> DROP',
      '  ADV -- 前进了 --> DIRTY',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  ST["stateOf(会话, seq)"] --> REC["读出这一条，拿到 senderId"]',
      '  REC --> AUD["audience = 成员里去掉发送者"]',
      '  AUD --> CNT["逐个成员看两条位点<br/>读位点是免费的"]',
      '  CNT --> IMP["送达 = max(送达位点, 已读位点) 到了 seq<br/>读过就一定送达过"]',
      '  IMP --> OUT["返回 delivered / read / audience"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  F["flush()"] --> LOOP["逐个有变化的会话"]',
      '  LOOP --> HEAD["取会话最后一条的 seq"]',
      '  HEAD --> AGG["stateOf(会话, head) 算一次"]',
      '  AGG --> SEND["每个成员的每条活连接推一帧<br/>帧里是聚合数，不是事件流"]',
      '  SEND --> CLEAR["清空变化标记"]',
      '```',
      '',
      '要点：推帧只出现在 `flush` 里。',
      '`noteRead` 和 `noteDelivered` 只改位点、只标记，一帧都不推。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  ND["noteDelivered(userId, conversation, seq)"] --> MAXD{"above the effective delivered position?<br/>effective = max(delivered, read)"}',
      '  MAXD -- no --> DROP["do nothing<br/>do not even mark it dirty"]',
      '  MAXD -- yes --> WD["putCursor(delivered, userId, conversation, seq)"]',
      '  WD --> DIRTY["mark the conversation changed"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  NR["noteRead(userId, conversation, seq)"] --> MR["readCursors.markRead(...)<br/>stage 5\'s cursor, clamp and max included"]',
      '  MR --> ADV{"did it actually advance?"}',
      '  ADV -- no --> DROP',
      '  ADV -- yes --> DIRTY',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  ST["stateOf(conversation, seq)"] --> REC["read the record for its senderId"]',
      '  REC --> AUD["audience = members minus the sender"]',
      '  AUD --> CNT["check two cursors per member<br/>cursor reads are free"]',
      '  CNT --> IMP["delivered = max(delivered, read) reaches seq<br/>reading implies delivery"]',
      '  IMP --> OUT["return delivered / read / audience"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  F["flush()"] --> LOOP["for each changed conversation"]',
      '  LOOP --> HEAD["take the seq of the last message"]',
      '  HEAD --> AGG["compute stateOf(conversation, head) once"]',
      '  AGG --> SEND["one frame per live connection per member<br/>carrying counts, not an event stream"]',
      '  SEND --> CLEAR["clear the change marks"]',
      '```',
      '',
      'The point: pushing happens only inside `flush`. `noteRead` and `noteDelivered` move cursors and set',
      'a flag, and send nothing.',
    ].join('\n')
  ),

  checklist: [
    t('送达按人取设备里的最大位点', 'Delivered is the max across a person\'s devices'),
    t('读过的人一定也算送达', 'Anyone who read also counts as delivered'),
    t('audience 不含发送者', 'The audience excludes the sender'),
    t('推帧只发生在 flush 里', 'Frames are pushed only inside flush'),
    t('没前进的回执不标记变化', 'A receipt that advances nothing marks nothing dirty'),
  ],

  pitfalls: [
    t(
      '在 `noteRead` 或 `noteDelivered` 里直接推帧。帧数会变成「回执事件数 × 在线人数」，而回执事件数是成员数的两倍 —— 一个 500 人群里一条消息能产生几十万帧，每帧只为了把已读数加一。这个开销和消息量无关、和群大小的平方相关，所以它在测试群里永远看不出来。',
      'Pushing a frame from inside `noteRead` or `noteDelivered`. The frame count becomes receipt events times people online, and the event count is already twice the member count — hundreds of thousands of frames for one message in a 500-person group, each one incrementing a number by one. The cost is independent of message volume and quadratic in group size, so a test group never reveals it.'
    ),
    t(
      '把回执做成「谁读了」的事件流推给所有人。除了帧数爆炸，它还泄露了不该泄露的东西：群成员之间通常不该知道彼此的阅读时间线。真实产品里只给发送者看聚合数（「已读 12 人」），点开才展开名单，而且那是一次单独的请求。',
      'Modelling receipts as a "who read it" event stream broadcast to everyone. Besides the frame explosion it leaks something it should not: members generally have no business seeing each other\'s reading timeline. Real products show the sender an aggregate — "read by 12" — and expand the list only on tap, as a separate request.'
    ),
    t(
      '把送达状态按设备存、按设备展示。「张三的手机收到了、平板没收到」对发送者毫无意义，他关心的是张三这个人。按设备展示还会让状态在张三打开另一台设备时反复跳变。设备粒度用来算，人的粒度用来展示。',
      'Storing and displaying delivery per device. "Alice\'s phone has it but her tablet does not" is meaningless to the sender, who cares about Alice. Per-device display also makes the indicator flicker every time she opens another device. Device granularity is for computing; person granularity is for showing.'
    ),
    t(
      '迟到的回执照样标记会话「有变化」。回执乱序到达是常态，如果一个没有让任何位点前进的回执也触发一轮 flush，那么在一个活跃群里 flush 永远不会是空的 —— 攒批的效果就没了，只是把每事件一帧改成了每事件一轮。判断「真的前进了」和写入位点是同一个判断，顺手就能拿到。',
      'Marking a conversation dirty for a late receipt. Out-of-order receipts are normal, and if one that advances no cursor still triggers a flush round, then in an active group flush is never empty — the batching is gone and you have merely turned one frame per event into one round per event. "Did it actually advance" is the same test as "should I write", and comes for free.'
    ),
  ],

  hints: [
    t(
      '`noteRead` 委托给第 5 关的 `markRead`，它已经带了夹上限和 max。用它的返回值和调用前的 `readSeq` 一比，就知道有没有真的前进。',
      'Delegate `noteRead` to stage 5\'s `markRead`, which already clamps and maxes. Compare its return value with `readSeq` from before the call to learn whether anything advanced.'
    ),
    t(
      '「读过就一定送达过」写成 `Math.max(送达位点, 已读位点) >= seq` 就够了，不需要在 `noteRead` 里再去写一遍送达位点 —— 那会让两条位点之间产生需要维护的一致性。',
      '"Reading implies delivery" is just `Math.max(deliveredCursor, readCursor) >= seq`. There is no need to also write the delivered cursor inside `noteRead`, which would create a consistency relation between two cursors that then has to be maintained.'
    ),
  ],

  extension: t(
    [
      '回执是 IM 里少数**产品决策比技术决策更重的**功能。',
      '',
      'WhatsApp 的双蓝勾可以关掉，关掉之后自己也看不到别人的 —— 这是对称性设计，',
      '因为「我能看你的但你看不到我的」会立刻被用户识别为不公平。',
      'Signal 同理。iMessage 的已读回执是**按会话**开关的，',
      '这样你可以对家人开着、对同事关着。',
      '',
      '技术上有几个这一关没做的东西：',
      '',
      '- **群里的已读名单**通常有人数上限（微信群超过一定人数就不显示已读），',
      '  因为名单的存储和展示成本都是 O(成员数 × 消息数)；',
      '- **回执的合并窗口**：真实系统会把几百毫秒内的回执攒成一批，',
      '  这一关的 `flush` 就是它的简化版，区别只是真实系统由定时器驱动；',
      '- **回执本身也要重试**，而重试的回执一定是乱序的 ——',
      '  这就是为什么位点必须只涨不落，第 4 关和第 5 关已经铺过两遍了。',
      '',
      '还有一个反直觉的点：端到端加密**不能**保护回执。',
      '服务端必须知道谁读到了第几条才能做聚合和展示，',
      '所以「谁在什么时候读了谁的消息」这张社交图始终是服务端可见的。',
      '第 10 关会看到，加密保护的是**内容**，不是**元数据**，',
      '而元数据往往才是更敏感的那部分。',
    ].join('\n'),
    [
      'Receipts are one of the few features here where the product decision outweighs the technical one.',
      '',
      'WhatsApp\'s blue ticks can be turned off, and turning them off also hides everyone else\'s — a',
      'deliberate symmetry, because "I can see yours but you cannot see mine" is recognised as unfair',
      'immediately. Signal does the same. iMessage makes read receipts a **per-conversation** switch, so',
      'they can be on for family and off for colleagues.',
      '',
      'A few technical pieces this stage leaves out:',
      '',
      '- **The read-by list in groups** usually has a size ceiling, because storing and rendering it costs',
      '  O(members × messages);',
      '- **The receipt coalescing window**: real systems batch a few hundred milliseconds of receipts',
      '  together, which is what `flush` is a simplification of — the difference is that production drives',
      '  it from a timer;',
      '- **Receipts get retried too**, and a retried receipt is by definition out of order, which is why',
      '  cursors have to be monotonic. Stages 4 and 5 laid that groundwork twice already.',
      '',
      'One counter-intuitive point: end-to-end encryption **cannot** protect receipts. The server has to',
      'know who has read up to which message in order to aggregate and display it, so the social graph of',
      'who read whose message when stays visible to the server throughout. Stage 10 makes the same point',
      'from the other side: encryption protects **content**, not **metadata**, and metadata is frequently',
      'the more sensitive half.',
    ].join('\n')
  ),

  focus: ['correctness', 'latency', 'concurrency'],
  lab: {},

  starterFiles: [
    file(
      'src/conversation/receipts.ts',
      code`
        import type { ReadCursors } from './readCursor';
        import type { ConnectionRegistry } from '../session/registry';
        import type { Store } from '../support/store';
        import type { Transport } from '../support/transport';

        /** Cursor table: how far a member has been delivered, across all their devices. */
        export const DELIVERED_CURSOR = 'delivered';

        export interface ReceiptState {
          conversationId: string;
          seq: number;
          /** Members other than the sender holding it on at least one device */
          delivered: number;
          /** Members other than the sender who have read to at least seq */
          read: number;
          /** Members the receipt is about: everyone except the sender */
          audience: number;
        }

        export interface Receipts {
          /** One of this person's devices holds up to seq. */
          noteDelivered(userId: string, conversationId: string, seq: number): void;
          /** This person read up to seq. */
          noteRead(userId: string, conversationId: string, seq: number): void;
          stateOf(conversationId: string, seq: number): ReceiptState;
          /** Push one summary round per changed conversation. Returns frames sent. */
          flush(): number;
        }

        export function createReceipts(
          store: Store,
          transport: Transport,
          registry: ConnectionRegistry,
          readCursors: ReadCursors
        ): Receipts {
          // TODO: implement
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
        import { createReadCursors } from '../src/conversation/readCursor';
        import { createReceipts } from '../src/conversation/receipts';
        import { createSequencer } from '../src/conversation/sequence';
        import { createRegistry } from '../src/session/registry';
        import { createStore } from '../src/support/store';
        import { createTransport } from '../src/support/transport';
        import { count } from '@lab/metrics';

        function makeWorld() {
          const store = createStore();
          const transport = createTransport();
          const registry = createRegistry(transport, { idleMs: 100000 });
          const readCursors = createReadCursors(store);
          const sequencer = createSequencer(store);
          const receipts = createReceipts(store, transport, registry, readCursors);
          return { store, transport, registry, readCursors, sequencer, receipts };
        }

        function conversation(world: any, id: string, members: string[]): void {
          world.store.putConversation({ conversationId: id, kind: 'group', members });
        }

        function post(world: any, conversationId: string, sender: string, howMany: number): void {
          const base = world.store.messageCount(conversationId);
          for (let index = 1; index <= howMany; index += 1) {
            world.sequencer.send({
              conversationId,
              senderId: sender,
              clientMsgId: conversationId + '-m' + (base + index),
              payload: 'text',
              sentAt: base + index,
            });
          }
        }

        function receiptFrames(world: any, connectionId: string) {
          return world.transport.inbox(connectionId).filter((frame: any) => frame.kind === 'receipt');
        }

        describe('阶段6 · 送达与已读回执', () => {
          it('送达按人聚合，两台设备取大的那个位点', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            post(world, 'c1', 'alice', 5);

            world.receipts.noteDelivered('bob', 'c1', 5);
            world.receipts.noteDelivered('bob', 'c1', 3);

            expect(world.receipts.stateOf('c1', 5).delivered).toBe(1);
          });

          it('读过的人也算送达', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            post(world, 'c1', 'alice', 3);

            // 只上报了已读，送达回执丢了
            world.receipts.noteRead('bob', 'c1', 3);

            const state = world.receipts.stateOf('c1', 3);
            expect(state.delivered).toBe(1);
            expect(state.read).toBe(1);
          });

          it('audience 不含发送者', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob', 'carol']);
            post(world, 'c1', 'alice', 1);

            const state = world.receipts.stateOf('c1', 1);

            expect(state.audience).toBe(2);
            expect(state.conversationId).toBe('c1');
            expect(state.seq).toBe(1);
          });

          it('发送者自己的位点不计入已读人数', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            post(world, 'c1', 'alice', 2);

            world.receipts.noteRead('alice', 'c1', 2);

            expect(world.receipts.stateOf('c1', 2).read).toBe(0);
          });

          it('部分已读时只数那部分人', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob', 'carol', 'dave']);
            post(world, 'c1', 'alice', 4);

            world.receipts.noteRead('bob', 'c1', 4);
            world.receipts.noteRead('carol', 'c1', 2);
            world.receipts.noteDelivered('dave', 'c1', 4);

            const state = world.receipts.stateOf('c1', 4);
            expect(state.read).toBe(1);
            expect(state.delivered).toBe(2);
            expect(state.audience).toBe(3);
          });

          it('flush 之前一帧都不推', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            post(world, 'c1', 'alice', 1);
            const aliceConn = world.registry.attach('alice', 'alice-phone');

            world.receipts.noteRead('bob', 'c1', 1);

            expect(receiptFrames(world, aliceConn)).toEqual([]);
          });

          it('回执帧带着会话、seq 和聚合结果', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            post(world, 'c1', 'alice', 2);
            const aliceConn = world.registry.attach('alice', 'alice-phone');

            world.receipts.noteRead('bob', 'c1', 2);
            world.receipts.flush();

            const frames = receiptFrames(world, aliceConn);
            expect(frames).toHaveLength(1);
            expect(frames[0].conversationId).toBe('c1');
            expect(frames[0].seq).toBe(2);
            expect(frames[0].payload.read).toBe(1);
            expect(frames[0].payload.audience).toBe(1);
          });

          it('没有变化时 flush 推 0 帧', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            post(world, 'c1', 'alice', 1);
            world.registry.attach('alice', 'alice-phone');

            world.receipts.noteRead('bob', 'c1', 1);
            expect(world.receipts.flush()).toBeGreaterThan(0);
            expect(world.receipts.flush()).toBe(0);
          });

          it('迟到的回执不会让已读人数变少', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob', 'carol']);
            post(world, 'c1', 'alice', 5);
            world.receipts.noteRead('bob', 'c1', 5);
            world.receipts.noteRead('carol', 'c1', 5);

            const before = world.receipts.stateOf('c1', 5).read;
            world.receipts.noteRead('bob', 'c1', 2);
            const after = world.receipts.stateOf('c1', 5).read;

            if (after < before) count('receiptRegressions');
            expect(after).toBe(2);
          });

          it('迟到的回执不会让 flush 白推一轮', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            post(world, 'c1', 'alice', 5);
            world.registry.attach('alice', 'alice-phone');

            world.receipts.noteRead('bob', 'c1', 5);
            world.receipts.flush();

            world.receipts.noteRead('bob', 'c1', 2);
            world.receipts.noteDelivered('bob', 'c1', 1);

            expect(world.receipts.flush()).toBe(0);
          });

          it('不在线的成员不产生帧', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob', 'carol']);
            post(world, 'c1', 'alice', 1);

            world.receipts.noteRead('bob', 'c1', 1);

            expect(world.receipts.flush()).toBe(0);
          });

          it('只有变化过的会话才推', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            conversation(world, 'c2', ['alice', 'carol']);
            post(world, 'c1', 'alice', 1);
            post(world, 'c2', 'alice', 1);
            const aliceConn = world.registry.attach('alice', 'alice-phone');

            world.receipts.noteRead('bob', 'c1', 1);
            world.receipts.flush();

            const frames = receiptFrames(world, aliceConn);
            expect(frames).toHaveLength(1);
            expect(frames[0].conversationId).toBe('c1');
          });

          it('空会话不产生帧', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            world.registry.attach('alice', 'alice-phone');

            world.receipts.noteDelivered('bob', 'c1', 1);

            expect(world.receipts.flush()).toBe(0);
          });

          it('两百人群里一轮 flush 只推给在线的那几个 [gate:receipts]', () => {
            const world = makeWorld();
            const members = ['alice'];
            for (let index = 1; index <= 199; index += 1) members.push('u' + index);
            conversation(world, 'big', members);
            post(world, 'big', 'alice', 1);

            world.registry.attach('alice', 'alice-phone');
            world.registry.attach('u1', 'u1-phone');
            world.registry.attach('u2', 'u2-phone');

            for (let index = 1; index <= 199; index += 1) {
              world.receipts.noteRead('u' + index, 'big', 1);
            }

            expect(world.receipts.flush()).toBe(3);
            expect(world.receipts.flush()).toBe(0);
            expect(world.receipts.stateOf('big', 1).read).toBe(199);
          });
        });
      `
    ),
  ],

  gates: [
    gate({
      metric: 'counters.framesPushed',
      op: 'lte',
      value: 6,
      zh: '两百人群一轮回执最多六帧',
      en: 'One receipt round in a 200-person group costs at most six frames',
      dimension: 'latency',
      scope: 'gate:receipts',
    }),
    gate({
      metric: 'counters.receiptRegressions',
      op: 'eq',
      value: 0,
      zh: '已读人数一次都没有变少过',
      en: 'The read count never went down',
      dimension: 'correctness',
    }),
  ],

  referenceFiles: [
    file(
      'src/conversation/receipts.ts',
      code`
        import type { ReadCursors } from './readCursor';
        import type { ConnectionRegistry } from '../session/registry';
        import type { Store } from '../support/store';
        import type { Transport } from '../support/transport';

        export const DELIVERED_CURSOR = 'delivered';

        export interface ReceiptState {
          conversationId: string;
          seq: number;
          delivered: number;
          read: number;
          audience: number;
        }

        export interface Receipts {
          noteDelivered(userId: string, conversationId: string, seq: number): void;
          noteRead(userId: string, conversationId: string, seq: number): void;
          stateOf(conversationId: string, seq: number): ReceiptState;
          flush(): number;
        }

        export function createReceipts(
          store: Store,
          transport: Transport,
          registry: ConnectionRegistry,
          readCursors: ReadCursors
        ): Receipts {
          /** Conversations whose aggregate changed since the last flush. */
          const changed = new Set<string>();

          function deliveredSeq(userId: string, conversationId: string): number {
            // Reading implies delivery: a lost delivery receipt must not contradict
            // a read receipt that did get through.
            return Math.max(
              store.getCursor(DELIVERED_CURSOR, userId, conversationId),
              readCursors.readSeq(userId, conversationId)
            );
          }

          function stateOf(conversationId: string, seq: number): ReceiptState {
            const empty = { conversationId, seq, delivered: 0, read: 0, audience: 0 };
            const meta = store.getConversation(conversationId);
            if (!meta) return empty;
            const record = store.readMessages(conversationId, seq - 1, 1)[0];
            if (!record) return empty;

            let delivered = 0;
            let read = 0;
            let audience = 0;

            for (const member of meta.members) {
              if (member === record.senderId) continue;
              audience += 1;
              if (deliveredSeq(member, conversationId) >= seq) delivered += 1;
              if (readCursors.readSeq(member, conversationId) >= seq) read += 1;
            }

            return { conversationId, seq, delivered, read, audience };
          }

          return {
            noteDelivered(userId: string, conversationId: string, seq: number): void {
              // Compare against the effective position, not the raw cursor: someone who
              // already read to 5 is delivered to 5, so a delivery receipt for 1 changes
              // nothing. A receipt that advances nothing must not mark the conversation
              // dirty, or batching collapses back to one round per event.
              const current = deliveredSeq(userId, conversationId);
              if (seq <= current) return;
              store.putCursor(DELIVERED_CURSOR, userId, conversationId, seq);
              changed.add(conversationId);
            },

            noteRead(userId: string, conversationId: string, seq: number): void {
              const before = readCursors.readSeq(userId, conversationId);
              const after = readCursors.markRead(userId, conversationId, seq);
              if (after > before) changed.add(conversationId);
            },

            stateOf,

            flush(): number {
              let frames = 0;

              for (const conversationId of Array.from(changed)) {
                const head = store.messageCount(conversationId);
                if (head === 0) continue;

                // One aggregate, computed once, sent as a number rather than a stream
                const state = stateOf(conversationId, head);
                const meta = store.getConversation(conversationId);
                if (!meta) continue;

                for (const member of meta.members) {
                  for (const connectionId of registry.connectionsOf(member)) {
                    transport.push(connectionId, {
                      kind: 'receipt',
                      conversationId,
                      seq: head,
                      payload: state,
                    });
                    frames += 1;
                  }
                }
              }

              changed.clear();
              return frames;
            },
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 7 关 · 群扇出：写扩散还是读扩散                                     */
/* ------------------------------------------------------------------ */

const stage7 = {
  id: 'group-fanout',
  title: t('第 7 关 · 写扩散与读扩散', 'Stage 7 · Write fan-out versus read fan-out'),
  goal: t(
    [
      '前六关有一个共同的隐含假设：会话的成员是可以**逐个走一遍**的。',
      '',
      '在两个人的对话里，这个假设显然成立。在一个 5000 人的公司全员群里，',
      '它变成了每发一条消息就要做 5000 次写入 —— 而全员群一天可能只发三条消息。',
      '',
      '反过来，如果什么都不预先写，那么「打开 App 看会话列表」就要',
      '临时遍历你所在的每一个会话去取最后一条消息。一个在 200 个会话里的人，',
      '每次切前台都要读 200 条记录，而切前台是这个产品里最高频的动作。',
      '',
      '这是同一个权衡的两端，业界的名字叫**写扩散**和**读扩散**：',
      '',
      '| | 写的时候 | 读的时候 |',
      '| --- | --- | --- |',
      '| 写扩散 | 每个成员的收件箱各写一条，O(成员数) | 读自己收件箱的尾巴，O(要展示的条数) |',
      '| 读扩散 | 什么都不写，O(1) | 遍历自己的会话取最后一条，O(会话数) |',
      '',
      '两种都不是「对的」。**按会话规模选**才是：',
      '小会话写扩散（成员少，写得起），大群读扩散（成员多，写不起）。',
      '',
      '## 要实现什么',
      '',
      '在 `src/group/fanout.ts` 实现 `createFanout(store, options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `modeOf(conversationId)` | 这个会话用哪种策略 |',
      '| `onMessage(conversationId, seq, sentAt)` | 按策略处理一条新消息，返回写了几条收件箱 |',
      '| `recent(userId, limit)` | 这个人最近有动静的会话，**按时间倒序**，最多 limit 个 |',
      '',
      '成员数超过 `fanoutThreshold` 的会话走读扩散，否则走写扩散。',
      '',
      '**`recent` 必须把两种来源合并成一个结果**，而且调用方不该看得出来',
      '哪个会话走的哪条路 —— 这是这一关真正的考点。',
      '',
      '## 怎么算过',
      '',
      '- 一个 400 人的群发一条消息，**一条收件箱都不写**',
      '  （门槛 `counters.inboxWrites ≤ 4`）；',
      '- 一个人在 60 个双人会话里，取最近 10 个，**最多读 25 条记录**',
      '  （门槛 `counters.messagesScanned ≤ 25`）—— 靠的是收件箱本身就是按时间',
      '  排好的，从尾巴往前读一小段就够；',
      '- 两种策略下 `recent` 的语义完全一致：都按最后一条消息的时间倒序，',
      '  同一个会话只出现一次；',
      '- 收件箱尾部被一个会话刷屏时，仍然要能凑够 `limit` 个不同会话。',
      '',
      '## 那个坑',
      '',
      '`recent` 里只读收件箱。',
      '',
      '看起来完全合理 —— 收件箱就是为这个准备的。但大群走的是读扩散，',
      '它**从来没往收件箱里写过东西**，于是它永远不出现在会话列表里。',
      '表现是：全员群发了公告，你的会话列表纹丝不动，直到你手动点进去。',
      '',
      '这个 bug 有一个特别难查的地方：它只影响大群，而大群通常是',
      '「消息最少但最重要」的那些会话。测试环境里的群都很小，全都走写扩散，',
      '于是这条路径在上线之前一次都没被执行过。',
    ].join('\n'),
    [
      'The first six stages share an unstated assumption: that you can **walk the member list**.',
      '',
      'For a two-person conversation that is obviously fine. For a 5000-person all-hands group it means',
      '5000 writes per message — and that group might carry three messages a day.',
      '',
      'Invert it and write nothing ahead of time, and "open the app and look at the conversation list"',
      'has to walk every conversation you are in to fetch its last message. Someone in 200 conversations',
      'reads 200 records every time the app comes to the foreground, which is the single most frequent',
      'action in the product.',
      '',
      'These are the two ends of one trade-off, and the industry calls them **write fan-out** and **read',
      'fan-out**:',
      '',
      '| | On write | On read |',
      '| --- | --- | --- |',
      '| Write fan-out | One inbox row per member, O(members) | Read the tail of your own inbox, O(rows shown) |',
      '| Read fan-out | Nothing, O(1) | Walk your conversations for their last message, O(conversations) |',
      '',
      'Neither is "correct". **Choosing by conversation size** is: write fan-out for small conversations,',
      'where the writes are affordable, read fan-out for large ones, where they are not.',
      '',
      '## What to build',
      '',
      'Implement `createFanout(store, options)` in `src/group/fanout.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `modeOf(conversationId)` | Which strategy this conversation uses |',
      '| `onMessage(conversationId, seq, sentAt)` | Handle a new message; return inbox rows written |',
      '| `recent(userId, limit)` | This person\'s recently active conversations, **newest first**, at most limit |',
      '',
      'Conversations with more members than `fanoutThreshold` use read fan-out; the rest use write',
      'fan-out.',
      '',
      '**`recent` has to merge both sources into one answer**, and the caller must not be able to tell',
      'which conversation took which path. That is what this stage is really about.',
      '',
      '## What counts as passing',
      '',
      '- A message in a 400-person group writes **no inbox rows at all**',
      '  (the `counters.inboxWrites ≤ 4` gate);',
      '- Someone in 60 two-person conversations asking for the 10 most recent **reads at most 25 records**',
      '  (the `counters.messagesScanned ≤ 25` gate) — which works because the inbox is already in time',
      '  order, so a short read from its tail is enough;',
      '- `recent` means exactly the same thing under both strategies: newest first by the last message,',
      '  each conversation appearing once;',
      '- When one conversation floods the tail of the inbox, `limit` distinct conversations still come',
      '  back.',
      '',
      '## The trap',
      '',
      'Reading only the inbox in `recent`.',
      '',
      'It looks entirely reasonable — the inbox exists for this. But a large group uses read fan-out and',
      '**never wrote to the inbox at all**, so it never appears in the conversation list. What people see',
      'is: the all-hands group posts an announcement and their conversation list does not move until they',
      'open it by hand.',
      '',
      'This bug is unusually hard to catch because it only affects large groups, which tend to be the',
      '"lowest volume, highest importance" conversations. Every group in a test environment is small, so',
      'every one of them takes the write path, and the other branch is never executed before release.',
    ].join('\n')
  ),

  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  M["onMessage(会话, seq, sentAt)"] --> SIZE["成员数 = getConversation(会话).members.length"]',
      '  SIZE --> PICK{"成员数 大于 fanoutThreshold？"}',
      '  PICK -- 是（大群） --> NOOP["读扩散：什么都不写<br/>返回 0"]',
      '  PICK -- 否（小会话） --> WRITE["写扩散：每个成员 appendInbox<br/>条目里带上 sentAt"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  R["recent(userId, limit)"] --> TAIL["从收件箱**尾部**往前读"]',
      '  TAIL --> CHUNK["每次读一小段<br/>倒着遍历，会话第一次出现的那条最新"]',
      '  CHUNK --> ENOUGH{"凑够 limit 个不同会话？<br/>或者收件箱读完了？"}',
      '  ENOUGH -- 没有 --> CHUNK',
      '  ENOUGH -- 够了 --> MERGE["再补上读扩散的会话"]',
      '  MERGE --> SCAN["conversationsOf(userId) 里挑出读扩散的<br/>各读一条最后的记录"]',
      '  SCAN --> SORT["两路合并，按 sentAt 倒序"]',
      '  SORT --> CUT["截到 limit 条"]',
      '```',
      '',
      '要点：`recent` 有**两个**数据源，缺了下面那条，大群就从会话列表里消失了。',
      '而这条路径在小群里永远不会被执行到。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  M["onMessage(conversation, seq, sentAt)"] --> SIZE["members = getConversation(...).members.length"]',
      '  SIZE --> PICK{"members above fanoutThreshold?"}',
      '  PICK -- large --> NOOP["read fan-out: write nothing<br/>return 0"]',
      '  PICK -- small --> WRITE["write fan-out: appendInbox per member<br/>carrying sentAt"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  R["recent(userId, limit)"] --> TAIL["read backwards from the **end** of the inbox"]',
      '  TAIL --> CHUNK["a short chunk at a time<br/>walking back, first sighting is the newest"]',
      '  CHUNK --> ENOUGH{"limit distinct conversations?<br/>or inbox exhausted?"}',
      '  ENOUGH -- no --> CHUNK',
      '  ENOUGH -- yes --> MERGE["now add the read fan-out conversations"]',
      '  MERGE --> SCAN["pick the read-mode ones out of conversationsOf<br/>one last record each"]',
      '  SCAN --> SORT["merge both sources, newest sentAt first"]',
      '  SORT --> CUT["cut to limit"]',
      '```',
      '',
      'The point: `recent` has **two** sources. Drop the lower one and large groups vanish from the',
      'conversation list — along a path that small groups never execute.',
    ].join('\n')
  ),

  checklist: [
    t('策略按成员数选，不是全局二选一', 'The strategy is chosen per conversation, not globally'),
    t('大群一条收件箱都不写', 'A large group writes no inbox rows'),
    t('recent 合并收件箱和读扩散两路', 'recent merges the inbox and the read-mode conversations'),
    t('收件箱从尾部往前读，不整份读', 'The inbox is read backwards from its end, never whole'),
    t('同一个会话只出现一次，取最新那条', 'Each conversation appears once, at its newest entry'),
  ],

  pitfalls: [
    t(
      '`recent` 只读收件箱。大群走读扩散、从没写过收件箱，于是它永远不出现在会话列表里 —— 全员群发了公告，列表纹丝不动。这个 bug 只在大群上出现，而测试环境里的群都很小，所以这条分支在上线之前一次都没跑过。',
      'Reading only the inbox in `recent`. Large groups use read fan-out and never wrote a row, so they never appear in the conversation list: the all-hands group posts and the list does not move. The bug only manifests in large groups, and every group in a test environment is small, so the branch never runs before release.'
    ),
    t(
      '全局选一种策略。全写扩散会让大群发一条消息产生几千次写入，而大群往往是消息最少的那些 —— 花最大的代价服务最低的流量。全读扩散会让每次打开 App 遍历所有会话，而打开 App 是最高频的动作。这个权衡没有全局最优解，只有按会话规模的分段解。',
      'Picking one strategy globally. All-write means thousands of writes for a message in a large group, and large groups tend to carry the least traffic — the highest cost serving the lowest volume. All-read means walking every conversation each time the app opens, which is the most frequent action there is. There is no global optimum here, only a piecewise one by conversation size.'
    ),
    t(
      '把整个收件箱读出来再排序。功能正确，但收件箱是**只增不减**的：一个用了两年的账号收件箱里有几十万条，而你只需要最后十几条。收件箱天然按时间有序，从尾部往前读一小段就够 —— 这也是它相对读扩散的全部优势所在，整份读会把这个优势正好抵消掉。',
      'Reading the whole inbox and sorting it. Correct, and the inbox only ever grows: a two-year-old account has hundreds of thousands of rows and you need the last dozen. The inbox is already in time order, so a short read from the tail suffices — that is the entire advantage it has over read fan-out, and reading it whole cancels exactly that advantage.'
    ),
    t(
      '从尾部只读固定的 limit 条就收工。一个活跃会话可以把收件箱尾部刷满：最后 10 条全来自同一个群，于是「最近 10 个会话」只返回 1 个。要往前继续读到凑够为止（或者读完），而这个循环的存在本身就说明了为什么这个来源需要一个上限 —— 极端情况下它会退化成整份读。',
      'Reading a fixed `limit` rows from the tail and stopping. One active conversation can fill the tail: the last ten rows all come from the same group, so "ten most recent conversations" returns one. You have to keep walking back until you have enough or run out — and the existence of that loop is exactly why this source needs a ceiling, because in the worst case it degenerates into reading everything.'
    ),
  ],

  hints: [
    t(
      '`store.inboxSize(userId)` 是免费的，用它算出尾部的下标：`readInbox(userId, size - chunk, chunk)`。倒着遍历这一段，某个会话**第一次**出现的那条就是它最新的一条。',
      '`store.inboxSize(userId)` is free; use it to compute the tail offset with `readInbox(userId, size - chunk, chunk)`. Walk that slice backwards, and the **first** time a conversation appears is its newest row.'
    ),
    t(
      '两路合并用一个 `Map<会话 id, 条目>`：收件箱那路先填（它已经是最新优先），读扩散那路直接覆盖同名的键。最后统一按 `sentAt` 倒序截断。',
      'Merge with a single `Map` keyed by conversation id: fill it from the inbox first, since that source is already newest-first, then let the read-mode conversations overwrite the same keys. Sort by `sentAt` descending and cut at the end.'
    ),
  ],

  extension: t(
    [
      '写扩散/读扩散最有名的战场是 Twitter 的时间线。早期是纯写扩散',
      '（发一条推文写进所有粉丝的时间线），但 Lady Gaga 有几千万粉丝，',
      '她发一条推要写几千万次。后来改成混合：普通用户写扩散，',
      '大 V 读扩散 —— 读时间线的时候把大 V 的推文临时合并进来。',
      '这和这一关的结构完全一样，只是「会话成员数」换成了「粉丝数」。',
      '',
      'IM 里还有一个额外的约束是时间线没有的：**顺序**。',
      '时间线乱一点没人在意，会话列表乱一点也还好，但**会话内部**的顺序不能乱 ——',
      '这就是为什么第 2 关的 seq 是服务端分配的，而扇出策略只影响',
      '「会话列表怎么排」，碰不到「会话内部怎么排」。两件事分开，',
      '扇出策略才可以随时切换。',
      '',
      '真实系统里阈值不是一个固定数字，还会看：',
      '',
      '- **活跃度**：一个 500 人但每天几百条消息的工作群，写扩散的成本',
      '  是 500 × 几百；一个 5000 人但每周一条的公告群，写扩散反而更划算；',
      '- **成员的在线比例**：给三个月没登录的成员写收件箱是纯浪费，',
      '  很多系统只给最近活跃过的成员做写扩散，其余的降级成读扩散。',
      '',
      '还有一个这一关没做但很关键的东西：**切换策略的那一刻**。',
      '一个群从 8 个人涨到 9 个人，策略变了，但历史消息还留在旧路径上。',
      '真实系统要么做一次迁移，要么让 `recent` 同时兼容两种历史 ——',
      '这一关的实现恰好是后者，因为它本来就要合并两路。',
    ].join('\n'),
    [
      'The most famous battleground for this trade-off is the Twitter timeline. It started as pure write',
      'fan-out — a tweet written into every follower\'s timeline — until accounts with tens of millions of',
      'followers made that tens of millions of writes per tweet. The answer was a hybrid: write fan-out for',
      'ordinary accounts, read fan-out for the very large ones, merged in at read time. Structurally',
      'identical to this stage, with "followers" in place of "members".',
      '',
      'IM adds a constraint timelines do not have: **order.** A slightly out-of-order timeline bothers',
      'nobody, and a slightly out-of-order conversation list is survivable, but the order **inside a',
      'conversation** is not negotiable. That is why stage 2 has the server assign the sequence, and why',
      'fan-out strategy only affects how the conversation list is sorted and never touches ordering within',
      'a conversation. Keeping those separate is what makes the strategy switchable at all.',
      '',
      'In production the threshold is not a fixed number. It also weighs:',
      '',
      '- **activity**: a 500-person work group carrying hundreds of messages a day costs 500 × hundreds',
      '  under write fan-out, while a 5000-person announcement group with one message a week is cheaper to',
      '  write than to read;',
      '- **the share of members who are active**: writing inbox rows for people who have not signed in for',
      '  three months is pure waste, so many systems write-fan-out only to recently active members and',
      '  degrade the rest to read fan-out.',
      '',
      'One important piece this stage leaves out: **the moment the strategy flips.** A group grows from',
      'eight members to nine, the strategy changes, and the history is still on the old path. Production',
      'either migrates it or makes `recent` tolerate both — and this stage\'s implementation happens to be',
      'the latter, because merging two sources is what it does anyway.',
    ].join('\n')
  ),

  focus: ['latency', 'elegance', 'encapsulation'],
  lab: {},

  starterFiles: [
    file(
      'src/group/fanout.ts',
      code`
        import type { Store } from '../support/store';

        export interface FanoutOptions {
          /** Conversations with more members than this use read fan-out */
          fanoutThreshold: number;
        }

        export type FanoutMode = 'write' | 'read';

        export interface RecentEntry {
          conversationId: string;
          /** The newest seq in that conversation */
          seq: number;
          sentAt: number;
        }

        export interface Fanout {
          modeOf(conversationId: string): FanoutMode;
          /** Handle one new message. Returns how many inbox rows were written. */
          onMessage(conversationId: string, seq: number, sentAt: number): number;
          /** Recently active conversations, newest first, at most limit of them. */
          recent(userId: string, limit: number): RecentEntry[];
        }

        export function createFanout(store: Store, options: FanoutOptions): Fanout {
          // TODO: implement
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
        import { createSequencer } from '../src/conversation/sequence';
        import { createFanout } from '../src/group/fanout';
        import { createStore } from '../src/support/store';

        const THRESHOLD = 8;

        function makeWorld(fanoutThreshold = THRESHOLD) {
          const store = createStore();
          const sequencer = createSequencer(store);
          return { store, sequencer, fanout: createFanout(store, { fanoutThreshold }) };
        }

        function conversation(world: any, id: string, members: string[]): void {
          world.store.putConversation({
            conversationId: id,
            kind: members.length > 2 ? 'group' : 'direct',
            members,
          });
        }

        /** Send one message and let the fan-out do whatever its strategy requires. */
        function post(world: any, conversationId: string, sender: string, sentAt: number): number {
          const nth = world.store.messageCount(conversationId) + 1;
          const result = world.sequencer.send({
            conversationId,
            senderId: sender,
            clientMsgId: conversationId + '-m' + nth,
            payload: 'text',
            sentAt,
          });
          return world.fanout.onMessage(conversationId, result.seq, sentAt);
        }

        function members(count: number, prefix = 'u'): string[] {
          const list: string[] = [];
          for (let index = 1; index <= count; index += 1) list.push(prefix + index);
          return list;
        }

        describe('阶段7 · 写扩散与读扩散', () => {
          it('策略按成员数选', () => {
            const world = makeWorld();
            conversation(world, 'small', ['alice', 'bob']);
            conversation(world, 'edge', members(THRESHOLD));
            conversation(world, 'big', members(THRESHOLD + 1));

            expect(world.fanout.modeOf('small')).toBe('write');
            expect(world.fanout.modeOf('edge')).toBe('write');
            expect(world.fanout.modeOf('big')).toBe('read');
          });

          it('小会话写扩散：每个成员的收件箱各多一条', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob', 'carol']);

            expect(post(world, 'c1', 'alice', 10)).toBe(3);
            expect(world.store.inboxSize('bob')).toBe(1);
            expect(world.store.inboxSize('carol')).toBe(1);
          });

          it('大群读扩散：一条收件箱都不写 [gate:big]', () => {
            const world = makeWorld();
            const crowd = members(400);
            conversation(world, 'big', crowd);

            expect(post(world, 'big', 'u1', 10)).toBe(0);
            expect(world.store.inboxSize('u2')).toBe(0);

            // 读扩散的会话照样要出现在会话列表里
            const recent = world.fanout.recent('u2', 5);
            expect(recent).toHaveLength(1);
            expect(recent[0].conversationId).toBe('big');
            expect(recent[0].seq).toBe(1);
          });

          it('写扩散下 recent 按时间倒序', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            conversation(world, 'c2', ['alice', 'carol']);
            conversation(world, 'c3', ['alice', 'dave']);
            post(world, 'c1', 'bob', 10);
            post(world, 'c3', 'dave', 30);
            post(world, 'c2', 'carol', 20);

            const recent = world.fanout.recent('alice', 5);

            expect(recent.map((entry: any) => entry.conversationId)).toEqual(['c3', 'c2', 'c1']);
            expect(recent[0].sentAt).toBe(30);
          });

          it('同一个会话只出现一次，取最新那条', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            post(world, 'c1', 'bob', 10);
            post(world, 'c1', 'bob', 20);
            post(world, 'c1', 'bob', 30);

            const recent = world.fanout.recent('alice', 5);

            expect(recent).toHaveLength(1);
            expect(recent[0].sentAt).toBe(30);
            expect(recent[0].seq).toBe(3);
          });

          it('两种来源合并到同一个结果里，按时间统一排序', () => {
            const world = makeWorld();
            conversation(world, 'direct', ['alice', 'bob']);
            conversation(world, 'big', ['alice', ...members(400)]);
            post(world, 'direct', 'bob', 10);
            post(world, 'big', 'u1', 20);

            const recent = world.fanout.recent('alice', 5);

            expect(recent.map((entry: any) => entry.conversationId)).toEqual(['big', 'direct']);
          });

          it('大群的消息更旧时排在后面', () => {
            const world = makeWorld();
            conversation(world, 'direct', ['alice', 'bob']);
            conversation(world, 'big', ['alice', ...members(400)]);
            post(world, 'big', 'u1', 5);
            post(world, 'direct', 'bob', 50);

            const recent = world.fanout.recent('alice', 5);

            expect(recent.map((entry: any) => entry.conversationId)).toEqual(['direct', 'big']);
          });

          it('recent 尊重 limit', () => {
            const world = makeWorld();
            for (let index = 1; index <= 6; index += 1) {
              const id = 'c' + index;
              conversation(world, id, ['alice', 'peer' + index]);
              post(world, id, 'peer' + index, index * 10);
            }

            const recent = world.fanout.recent('alice', 3);

            expect(recent.map((entry: any) => entry.conversationId)).toEqual(['c6', 'c5', 'c4']);
          });

          it('收件箱尾部被一个会话刷屏时仍能凑够不同会话', () => {
            const world = makeWorld();
            conversation(world, 'quiet1', ['alice', 'bob']);
            conversation(world, 'quiet2', ['alice', 'carol']);
            conversation(world, 'noisy', ['alice', 'dave']);
            post(world, 'quiet1', 'bob', 1);
            post(world, 'quiet2', 'carol', 2);
            for (let index = 1; index <= 40; index += 1) {
              post(world, 'noisy', 'dave', 10 + index);
            }

            const recent = world.fanout.recent('alice', 3);

            expect(recent.map((entry: any) => entry.conversationId)).toEqual([
              'noisy',
              'quiet2',
              'quiet1',
            ]);
          });

          it('没有任何会话时返回空', () => {
            const world = makeWorld();

            expect(world.fanout.recent('nobody', 5)).toEqual([]);
          });

          it('一条消息都没有的会话不出现在 recent 里', () => {
            const world = makeWorld();
            conversation(world, 'empty', ['alice', 'bob']);
            conversation(world, 'bigEmpty', ['alice', ...members(400)]);

            expect(world.fanout.recent('alice', 5)).toEqual([]);
          });

          it('不是成员的会话不出现', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            conversation(world, 'secret', ['bob', 'carol']);
            conversation(world, 'bigSecret', members(400, 'x'));
            post(world, 'c1', 'bob', 10);
            post(world, 'secret', 'bob', 20);
            post(world, 'bigSecret', 'x1', 30);

            const recent = world.fanout.recent('alice', 5);

            expect(recent.map((entry: any) => entry.conversationId)).toEqual(['c1']);
          });

          it('六十个双人会话取最近十个，不扫全量 [gate:small]', () => {
            const world = makeWorld();
            for (let index = 1; index <= 60; index += 1) {
              conversation(world, 'd' + index, ['alice', 'peer' + index]);
            }
            // 轮流发三轮，收件箱尾部因此是 60 个各不相同的会话
            let stamp = 1;
            for (let round = 1; round <= 3; round += 1) {
              for (let index = 1; index <= 60; index += 1) {
                post(world, 'd' + index, 'peer' + index, stamp);
                stamp += 1;
              }
            }

            const recent = world.fanout.recent('alice', 10);

            expect(recent).toHaveLength(10);
            expect(recent[0].conversationId).toBe('d60');
            expect(recent[9].conversationId).toBe('d51');
          });
        });
      `
    ),
  ],

  gates: [
    gate({
      metric: 'counters.inboxWrites',
      op: 'lte',
      value: 4,
      zh: '四百人的群发一条消息不写收件箱',
      en: 'A message in a 400-person group writes no inbox rows',
      dimension: 'latency',
      scope: 'gate:big',
    }),
    gate({
      metric: 'counters.messagesScanned',
      op: 'lte',
      value: 25,
      zh: '六十个会话取最近十个最多读二十五条',
      en: 'Ten recent conversations out of sixty read at most 25 records',
      dimension: 'latency',
      scope: 'gate:small',
    }),
  ],

  referenceFiles: [
    file(
      'src/group/fanout.ts',
      code`
        import type { InboxEntry, Store } from '../support/store';

        export interface FanoutOptions {
          fanoutThreshold: number;
        }

        export type FanoutMode = 'write' | 'read';

        export interface RecentEntry {
          conversationId: string;
          seq: number;
          sentAt: number;
        }

        export interface Fanout {
          modeOf(conversationId: string): FanoutMode;
          onMessage(conversationId: string, seq: number, sentAt: number): number;
          recent(userId: string, limit: number): RecentEntry[];
        }

        /** How much of the inbox tail to read per round while collecting distinct conversations. */
        const MIN_CHUNK = 8;

        export function createFanout(store: Store, options: FanoutOptions): Fanout {
          function modeOf(conversationId: string): FanoutMode {
            const meta = store.getConversation(conversationId);
            if (!meta) return 'write';
            return meta.members.length > options.fanoutThreshold ? 'read' : 'write';
          }

          /**
           * Newest-first entries from the inbox.
           *
           * The inbox is append-ordered, so walking back from the end yields conversations
           * newest first, and one conversation flooding the tail only means another round.
           */
          function fromInbox(userId: string, limit: number, into: Map<string, RecentEntry>): void {
            const chunk = Math.max(limit, MIN_CHUNK);
            let end = store.inboxSize(userId);

            while (end > 0 && into.size < limit) {
              const start = Math.max(0, end - chunk);
              const batch = store.readInbox(userId, start, end - start);
              for (let index = batch.length - 1; index >= 0; index -= 1) {
                const entry: InboxEntry = batch[index];
                if (into.has(entry.conversationId)) continue;
                into.set(entry.conversationId, {
                  conversationId: entry.conversationId,
                  seq: entry.seq,
                  sentAt: entry.sentAt,
                });
              }
              end = start;
            }
          }

          /**
           * The conversations that never wrote an inbox row.
           *
           * Leaving this out is invisible in every small group and makes large groups
           * disappear from the conversation list entirely.
           */
          function fromReadMode(userId: string, into: Map<string, RecentEntry>): void {
            for (const conversationId of store.conversationsOf(userId)) {
              if (modeOf(conversationId) !== 'read') continue;
              const head = store.messageCount(conversationId);
              if (head === 0) continue;
              const record = store.readMessages(conversationId, head - 1, 1)[0];
              if (!record) continue;
              into.set(conversationId, { conversationId, seq: head, sentAt: record.sentAt });
            }
          }

          return {
            modeOf,

            onMessage(conversationId: string, seq: number, sentAt: number): number {
              if (modeOf(conversationId) === 'read') return 0;
              const meta = store.getConversation(conversationId);
              if (!meta) return 0;
              for (const member of meta.members) {
                store.appendInbox(member, { conversationId, seq, sentAt });
              }
              return meta.members.length;
            },

            recent(userId: string, limit: number): RecentEntry[] {
              const merged = new Map<string, RecentEntry>();
              fromInbox(userId, limit, merged);
              fromReadMode(userId, merged);

              return Array.from(merged.values())
                .sort((left, right) => {
                  if (right.sentAt !== left.sentAt) return right.sentAt - left.sentAt;
                  return left.conversationId < right.conversationId ? -1 : 1;
                })
                .slice(0, limit);
            },
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 8 关 · 在线状态与订阅                                              */
/* ------------------------------------------------------------------ */

const stage8 = {
  id: 'presence',
  title: t('第 8 关 · 在线状态与订阅', 'Stage 8 · Presence and subscriptions'),
  goal: t(
    [
      '第 7 关把大群的消息扇出压了下去。系统里还剩最后一处会随人数**平方**增长的东西：',
      '**在线状态**。',
      '',
      '它的麻烦在于两点：',
      '',
      '- **变化极其频繁。** 消息是人主动发的，一天几十条；',
      '  在线状态是设备被动产生的 —— 进地铁、锁屏、切 Wi-Fi、',
      '  应用切后台，一个人一天能产生几百次状态翻转；',
      '- **默认是广播的。** 「谁在线」听起来是个公开信息，',
      '  于是最自然的写法就是「谁变了就告诉所有人」。',
      '  N 个人互相可见，一次变化 N 帧，一天下来 N × N × 几百。',
      '',
      '真实系统的答案是两条：**只推给订阅者**，以及**攒批推**。',
      '这一关做的就是这两条。',
      '',
      '状态本身不需要落库 —— 它是从第 1 关的心跳算出来的，',
      '进程重启之后靠连接重建就能恢复。这也是为什么这一关的状态',
      '住在内存里而不是 store 里。',
      '',
      '## 要实现什么',
      '',
      '在 `src/presence/presence.ts` 实现 `createPresence(...)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `subscribe(watcherId, targets)` | 关注这些人的状态 |',
      '| `unsubscribe(watcherId, targets)` | 取消关注 |',
      '| `stateOf(userId)` | 现在的状态，从连接和心跳算出来 |',
      '| `sweep()` | 重新算一遍被关注的人，返回状态变了的那些 |',
      '| `flush()` | 把变化推给关注者，返回推了几帧 |',
      '',
      '三种状态：',
      '',
      '| 状态 | 条件 |',
      '| --- | --- |',
      '| `online` | 有活连接，且最近一次心跳在 `awayMs` 之内 |',
      '| `away` | 有活连接，但已经 `awayMs` 没心跳了 |',
      '| `offline` | 一条活连接都没有 |',
      '',
      '一个人有多台设备时，取**最近**那次心跳 —— 手机在睡觉不代表人不在。',
      '',
      '## 怎么算过',
      '',
      '- 没订阅过的人的状态，**一次都不会出现在你的帧里**',
      '  （门槛 `counters.presenceLeaks = 0`）；',
      '- 30 个人同时上线、3 个关注者各 1 条连接时，一轮 flush **最多 8 帧**',
      '  （门槛 `counters.framesPushed ≤ 8`）—— 一帧里带一批变化，',
      '  不是一个变化一帧；',
      '- 状态没变时 flush 推 0 帧；',
      '- `unsubscribe` 之后立刻停止收到。',
      '',
      '## 那个坑',
      '',
      '把在线状态当成公开信息广播出去。',
      '',
      '除了帧数按平方增长之外，它还是个**隐私问题**，而且是那种上线之后',
      '才会被发现的：在线状态泄露的是**作息**。谁几点睡、谁周末在加班、',
      '谁在开会的时候还在回消息 —— 这些从一串状态翻转里能直接读出来，',
      '而用户从来没有同意过把它告诉全公司。',
      '',
      '订阅关系不只是省流量的手段，它同时是**授权边界**：',
      '你能看到某个人的状态，是因为你和他有会话关系，而不是因为你们在同一个系统里。',
    ].join('\n'),
    [
      'Stage 7 brought the message fan-out of large groups under control. One thing in the system still',
      'grows with the **square** of the population: **presence.**',
      '',
      'It is awkward for two reasons:',
      '',
      '- **It changes constantly.** Messages are sent deliberately, a few dozen a day. Presence is emitted',
      '  by devices — entering a tunnel, locking the screen, switching to cellular, backgrounding the app —',
      '  and one person can flip state hundreds of times a day;',
      '- **It defaults to broadcast.** "Who is online" sounds like public information, so the natural',
      '  implementation tells everyone about every change. With N mutually visible people that is N frames',
      '  per change, and N × N × hundreds per day.',
      '',
      'Production answers with two rules: **only to subscribers**, and **in batches.** This stage is those',
      'two rules.',
      '',
      'The state itself does not need to be persisted — it is computed from stage 1\'s heartbeats and',
      'rebuilds itself as connections come back after a restart. That is why it lives in memory here rather',
      'than in the store.',
      '',
      '## What to build',
      '',
      'Implement `createPresence(...)` in `src/presence/presence.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `subscribe(watcherId, targets)` | Watch these people |',
      '| `unsubscribe(watcherId, targets)` | Stop watching them |',
      '| `stateOf(userId)` | The state right now, derived from connections and heartbeats |',
      '| `sweep()` | Recompute everyone being watched; return those whose state changed |',
      '| `flush()` | Push the changes to their watchers; return frames sent |',
      '',
      'Three states:',
      '',
      '| State | Condition |',
      '| --- | --- |',
      '| `online` | A live connection whose last heartbeat is within `awayMs` |',
      '| `away` | A live connection, silent for `awayMs` or more |',
      '| `offline` | No live connection at all |',
      '',
      'With several devices, take the **most recent** heartbeat — a sleeping phone does not mean the person',
      'is gone.',
      '',
      '## What counts as passing',
      '',
      '- The state of somebody you never subscribed to **never appears in a frame of yours**',
      '  (the `counters.presenceLeaks = 0` gate);',
      '- With 30 people coming online and 3 watchers holding one connection each, one flush costs **at most',
      '  8 frames** (the `counters.framesPushed ≤ 8` gate) — a batch of changes per frame, not a frame per',
      '  change;',
      '- A flush with nothing changed sends zero frames;',
      '- `unsubscribe` stops delivery immediately.',
      '',
      '## The trap',
      '',
      'Treating presence as public information and broadcasting it.',
      '',
      'Beyond the quadratic frame count it is a **privacy** problem, and the kind that is only discovered',
      'after release: presence leaks **routine.** Who sleeps when, who works weekends, who answers messages',
      'during meetings — all of it is readable straight off a stream of state flips, and nobody agreed to',
      'tell the whole company.',
      '',
      'Subscriptions are not only a bandwidth mechanism. They are also the **authorisation boundary**: you',
      'can see someone\'s state because you share a conversation with them, not because you share a system.',
    ].join('\n')
  ),

  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  S["stateOf(userId)"] --> CONN["registry.connectionsOf(userId)"]',
      '  CONN --> ANY{"一条活连接都没有？"}',
      '  ANY -- 是 --> OFF["offline"]',
      '  ANY -- 否 --> LAST["last = 所有连接里最近的一次心跳<br/>多设备取最大值"]',
      '  LAST --> FRESH{"now - last 小于 awayMs？"}',
      '  FRESH -- 是 --> ON["online"]',
      '  FRESH -- 否 --> AWAY["away"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  SW["sweep()"] --> WATCHED["被至少一个人关注的那些用户"]',
      '  WATCHED --> CALC["逐个 stateOf"]',
      '  CALC --> DIFF{"和上次记的不一样？"}',
      '  DIFF -- 一样 --> NOTHING["不记，也不进待推集合"]',
      '  DIFF -- 不一样 --> REMEMBER["更新记录<br/>放进待推集合"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  F["flush()"] --> GROUP["按关注者把待推的变化分组<br/>一个关注者一批"]',
      '  GROUP --> WHO["只看关注了这个人的关注者<br/>没订阅的拿不到，也就不会泄露"]',
      '  WHO --> PUSH["关注者的每条活连接推一帧<br/>帧里是一批变化"]',
      '  PUSH --> CLR["清空待推集合"]',
      '```',
      '',
      '要点：分组发生在推送**之前**。',
      '先推后分组就是「一个变化一帧」，帧数会乘上关注者数量。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  S["stateOf(userId)"] --> CONN["registry.connectionsOf(userId)"]',
      '  CONN --> ANY{"no live connection?"}',
      '  ANY -- right --> OFF["offline"]',
      '  ANY -- wrong --> LAST["last = newest heartbeat of all connections<br/>the max across devices"]',
      '  LAST --> FRESH{"now - last below awayMs?"}',
      '  FRESH -- yes --> ON["online"]',
      '  FRESH -- no --> AWAY["away"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  SW["sweep()"] --> WATCHED["users somebody subscribed to"]',
      '  WATCHED --> CALC["stateOf for each"]',
      '  CALC --> DIFF{"different from what was recorded?"}',
      '  DIFF -- no --> NOTHING["record nothing, queue nothing"]',
      '  DIFF -- yes --> REMEMBER["update the record<br/>queue it for the next flush"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  F["flush()"] --> GROUP["group the queued changes by watcher<br/>one batch per watcher"]',
      '  GROUP --> WHO["only watchers subscribed to that person<br/>no subscription, no frame, no leak"]',
      '  WHO --> PUSH["one frame per live connection of the watcher<br/>carrying the whole batch"]',
      '  PUSH --> CLR["clear the queue"]',
      '```',
      '',
      'The point: grouping happens **before** pushing. Push first and group later and you have one frame',
      'per change, multiplied by the number of watchers.',
    ].join('\n')
  ),

  checklist: [
    t('状态从连接和心跳算出来，不另存', 'State is derived from connections and heartbeats, not stored'),
    t('多设备取最近的一次心跳', 'Several devices means the most recent heartbeat wins'),
    t('只有订阅者收得到', 'Only subscribers receive anything'),
    t('一帧带一批变化', 'One frame carries a batch of changes'),
    t('没变化就不推', 'No change means no frame'),
  ],

  pitfalls: [
    t(
      '状态一变就推给所有在线的人。帧数是「变化数 × 在线人数」，而状态变化由设备被动产生 —— 锁屏、切网络、切后台，一个人一天几百次。这个量和消息量完全无关，它只跟人数的平方走，所以在小规模下彻底看不出来，到了几千人的组织里会直接把接入层吃掉。',
      'Pushing to everyone online whenever a state changes. The frame count is changes times people online, and changes are emitted passively by devices — screen locks, network switches, backgrounding — hundreds per person per day. The volume has nothing to do with message traffic and everything to do with the square of the population, so it is invisible at small scale and eats the access layer in an organisation of a few thousand.'
    ),
    t(
      '把在线状态当公开信息。它泄露的是作息：谁几点睡、谁周末在加班、谁开会时还在回消息，都能从一串状态翻转里直接读出来。订阅关系不只是省流量，它同时是授权边界 —— 能看到某人的状态应该是因为你们有会话关系，而不是因为你们在同一个系统里。',
      'Treating presence as public. What it leaks is routine: who sleeps when, who works weekends, who replies during meetings, all readable from a stream of state flips. The subscription is not only a bandwidth mechanism but an authorisation boundary — you should see someone\'s state because you share a conversation, not because you share a deployment.'
    ),
    t(
      '把状态存进数据库。状态是从心跳推导出来的，存下来就多了一份需要和心跳保持一致的副本，而它们一定会不一致：进程重启之后，数据库里还写着「在线」，而那条连接早就没了。真实系统里这表现为「幽灵在线」—— 一个离职半年的人头像一直亮着。推导出来的状态不需要清理，连接没了它自然就是 offline。',
      'Persisting the state. It is derived from heartbeats, so storing it creates a second copy that has to agree with them, and eventually will not: after a restart the database still says online while the connection is long gone. In production this is the "ghost online" bug, where someone who left six months ago still shows a green dot. A derived state needs no cleanup — no connection, no presence.'
    ),
    t(
      '多设备时取第一条连接的心跳，或者要求所有设备都活跃才算 online。一个人的手机在口袋里睡着、电脑上正在打字，取第一条可能拿到手机那条，于是显示 away；要求全部活跃则永远不会 online。人的状态是设备状态的**并集**，取最近的那次心跳。',
      'Taking the first connection\'s heartbeat with several devices, or requiring all of them to be active. Someone\'s phone sleeps in a pocket while they type on a laptop: take the first and you may get the phone and show away; require all and online never happens. A person\'s state is the **union** of their devices\' — take the most recent heartbeat.'
    ),
  ],

  hints: [
    t(
      '维护一张反向表 `被关注者 -> 关注者集合`。`sweep` 需要「谁被关注了」，`flush` 需要「这个变化该给谁」，两个问题同一张表就能回答。',
      'Keep a reverse map from watched user to the set of watchers. `sweep` needs "who is being watched" and `flush` needs "who should hear about this change" — one map answers both.'
    ),
    t(
      '`flush` 里先建一个 `关注者 -> 变化数组` 的临时 Map，全部填完再统一推。先推后分组的写法从代码上看几乎一样，帧数差一个数量级。',
      'Build a temporary map from watcher to an array of updates inside `flush`, fill it completely, then push. Pushing before grouping looks almost identical in code and differs by an order of magnitude in frames.'
    ),
  ],

  extension: t(
    [
      '在线状态是 IM 里少数**先做减法的**功能。',
      '',
      'Slack 只有 active / away 两态，而且 away 是客户端自己算的（几分钟没操作）；',
      'Signal 干脆不做在线状态；微信只在「正在输入」这种极短时效的场景里',
      '暴露一点点。做得最细的反而是游戏和协作工具，因为在那里',
      '「谁在线」是**功能的一部分**，而不是社交信号。',
      '',
      '工程上有几个这一关没做的东西：',
      '',
      '- **订阅的生命周期**：真实系统的订阅通常跟着「当前打开的会话列表」走，',
      '  滑出屏幕就退订，否则一个在 500 个会话里的用户会订阅 500 个人的状态；',
      '- **状态的合并窗口**：这一关的 flush 由调用方驱动，真实系统由定时器驱动，',
      '  通常是 1 到 5 秒。窗口越大越省，但「正在输入」这种状态窗口大了就没意义了，',
      '  所以经常是两条通道：慢通道走在线状态，快通道走输入状态；',
      '- **跨机房的状态同步**：连接分布在几十台接入机上，「谁在线」这张表',
      '  是分散的。常见做法是每台接入机把自己的连接表写进一个共享的 KV，',
      '  带 TTL，机器挂了状态自动过期 —— 这正好也是「不落库、可推导」',
      '  这个性质带来的好处。',
      '',
      '最后一个细节：`away` 到底该由服务端算还是客户端算？',
      '服务端只知道心跳，客户端知道用户有没有在动键盘。',
      '大部分系统是两者结合 —— 服务端算连接层面的 away，',
      '客户端主动上报「我要显示为离开」，后者优先。',
    ].join('\n'),
    [
      'Presence is one of the few features here where the industry moved toward doing less.',
      '',
      'Slack has only active and away, and away is computed client-side from a few minutes of inactivity.',
      'Signal does not do presence at all. WeChat exposes a sliver of it only through very short-lived',
      'signals like "typing". The richest implementations are in games and collaborative tools, where "who',
      'is here" is **part of the feature** rather than a social signal.',
      '',
      'A few engineering pieces this stage leaves out:',
      '',
      '- **Subscription lifetime**: real subscriptions usually follow the visible conversation list and are',
      '  dropped when a row scrolls off screen, or somebody in 500 conversations subscribes to 500 people;',
      '- **The coalescing window**: `flush` here is driven by the caller, and in production by a timer,',
      '  usually one to five seconds. A wider window saves more, but a signal like "typing" is meaningless',
      '  with a wide window, so there are often two channels — a slow one for presence and a fast one for',
      '  typing;',
      '- **Cross-node presence**: connections are spread over dozens of access nodes, so "who is online" is',
      '  a distributed table. The usual answer is for each node to publish its connection table into a',
      '  shared key-value store with a TTL, so a node failure expires its presence automatically — which is',
      '  exactly the benefit of keeping the state derived rather than stored.',
      '',
      'One last detail: should `away` be decided by the server or the client? The server knows only about',
      'heartbeats; the client knows whether anyone is touching the keyboard. Most systems combine both —',
      'the server computes connection-level away, the client can assert "show me as away", and the client',
      'wins.',
    ].join('\n')
  ),

  focus: ['latency', 'concurrency', 'encapsulation'],
  lab: {},

  starterFiles: [
    file(
      'src/presence/presence.ts',
      code`
        import type { ConnectionRegistry } from '../session/registry';
        import type { Transport } from '../support/transport';

        export type PresenceState = 'online' | 'away' | 'offline';

        export interface PresenceOptions {
          /** A live connection silent for this long is 'away' rather than 'online' */
          awayMs: number;
        }

        export interface PresenceUpdate {
          userId: string;
          state: PresenceState;
          /** Virtual-clock time of the most recent heartbeat, 0 when offline */
          since: number;
        }

        export interface Presence {
          subscribe(watcherId: string, targets: string[]): void;
          unsubscribe(watcherId: string, targets: string[]): void;
          stateOf(userId: string): PresenceState;
          /** Recompute every watched user. Returns the ids whose state changed. */
          sweep(): string[];
          /** Push queued changes to their watchers, batched. Returns frames pushed. */
          flush(): number;
        }

        export function createPresence(
          transport: Transport,
          registry: ConnectionRegistry,
          options: PresenceOptions
        ): Presence {
          // TODO: implement
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
        import { createPresence } from '../src/presence/presence';
        import { createRegistry } from '../src/session/registry';
        import { createTransport } from '../src/support/transport';
        import { sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const AWAY_MS = 1000;
        const IDLE_MS = 5000;

        function makeWorld() {
          const transport = createTransport();
          const registry = createRegistry(transport, { idleMs: IDLE_MS });
          const presence = createPresence(transport, registry, { awayMs: AWAY_MS });
          return { transport, registry, presence };
        }

        function presenceFrames(world: any, connectionId: string) {
          return world.transport.inbox(connectionId).filter((frame: any) => frame.kind === 'presence');
        }

        /** Every user id mentioned in the frames a connection received. */
        function mentioned(world: any, connectionId: string): string[] {
          const seen: string[] = [];
          for (const frame of presenceFrames(world, connectionId)) {
            for (const update of frame.payload) seen.push(update.userId);
          }
          return seen;
        }

        describe('阶段8 · 在线状态与订阅', () => {
          it('有活连接是 online，没有是 offline', () => {
            const world = makeWorld();

            expect(world.presence.stateOf('bob')).toBe('offline');
            world.registry.attach('bob', 'bob-phone');
            expect(world.presence.stateOf('bob')).toBe('online');
          });

          it('心跳静默超过 awayMs 变成 away', async () => {
            const world = makeWorld();
            world.registry.attach('bob', 'bob-phone');

            await sleep(AWAY_MS);

            expect(world.presence.stateOf('bob')).toBe('away');
          });

          it('重新心跳之后回到 online', async () => {
            const world = makeWorld();
            const connectionId = world.registry.attach('bob', 'bob-phone');

            await sleep(AWAY_MS);
            world.registry.beat(connectionId);

            expect(world.presence.stateOf('bob')).toBe('online');
          });

          it('多设备取最近的那次心跳', async () => {
            const world = makeWorld();
            world.registry.attach('bob', 'bob-phone');
            await sleep(AWAY_MS - 1);
            world.registry.attach('bob', 'bob-laptop');
            await sleep(1);

            // 手机已经静默了 awayMs，但电脑刚接入
            expect(world.presence.stateOf('bob')).toBe('online');
          });

          it('订阅之后 sweep + flush 能收到状态', () => {
            const world = makeWorld();
            const aliceConn = world.registry.attach('alice', 'alice-phone');
            world.presence.subscribe('alice', ['bob']);
            world.presence.sweep();
            world.presence.flush();

            world.registry.attach('bob', 'bob-phone');
            expect(world.presence.sweep()).toEqual(['bob']);
            expect(world.presence.flush()).toBe(1);

            const frames = presenceFrames(world, aliceConn);
            const last = frames[frames.length - 1];
            expect(last.payload).toEqual([{ userId: 'bob', state: 'online', since: 0 }]);
          });

          it('没订阅的人的状态一次都不会出现在帧里', () => {
            const world = makeWorld();
            const aliceConn = world.registry.attach('alice', 'alice-phone');
            world.presence.subscribe('alice', ['bob']);
            world.registry.attach('bob', 'bob-phone');
            world.registry.attach('carol', 'carol-phone');
            world.registry.attach('dave', 'dave-phone');

            world.presence.sweep();
            world.presence.flush();

            for (const userId of mentioned(world, aliceConn)) {
              if (userId !== 'bob') count('presenceLeaks');
            }
            expect(mentioned(world, aliceConn)).toEqual(['bob']);
          });

          it('完全没订阅的观察者一帧都收不到', () => {
            const world = makeWorld();
            const nosyConn = world.registry.attach('nosy', 'nosy-phone');
            world.presence.subscribe('alice', ['bob']);
            world.registry.attach('bob', 'bob-phone');

            world.presence.sweep();
            world.presence.flush();

            expect(presenceFrames(world, nosyConn)).toEqual([]);
          });

          it('unsubscribe 之后不再收到', () => {
            const world = makeWorld();
            const aliceConn = world.registry.attach('alice', 'alice-phone');
            world.presence.subscribe('alice', ['bob']);
            world.registry.attach('bob', 'bob-phone');
            world.presence.sweep();
            world.presence.flush();

            world.presence.unsubscribe('alice', ['bob']);
            const before = presenceFrames(world, aliceConn).length;

            world.registry.reap();
            world.transport.close(world.registry.connectionsOf('bob')[0]);
            world.presence.sweep();
            world.presence.flush();

            expect(presenceFrames(world, aliceConn)).toHaveLength(before);
          });

          it('状态没变时 flush 推 0 帧', () => {
            const world = makeWorld();
            world.registry.attach('alice', 'alice-phone');
            world.presence.subscribe('alice', ['bob']);
            world.registry.attach('bob', 'bob-phone');

            world.presence.sweep();
            expect(world.presence.flush()).toBe(1);

            expect(world.presence.sweep()).toEqual([]);
            expect(world.presence.flush()).toBe(0);
          });

          it('下线也是一次变化', () => {
            const world = makeWorld();
            const aliceConn = world.registry.attach('alice', 'alice-phone');
            world.presence.subscribe('alice', ['bob']);
            const bobConn = world.registry.attach('bob', 'bob-phone');
            world.presence.sweep();
            world.presence.flush();

            world.transport.close(bobConn);
            expect(world.presence.sweep()).toEqual(['bob']);
            world.presence.flush();

            const frames = presenceFrames(world, aliceConn);
            expect(frames[frames.length - 1].payload[0].state).toBe('offline');
          });

          it('重复订阅同一个人不会推两帧', () => {
            const world = makeWorld();
            world.registry.attach('alice', 'alice-phone');
            world.presence.subscribe('alice', ['bob']);
            world.presence.subscribe('alice', ['bob']);
            world.registry.attach('bob', 'bob-phone');

            world.presence.sweep();

            expect(world.presence.flush()).toBe(1);
          });

          it('关注者不在线时不推', () => {
            const world = makeWorld();
            world.presence.subscribe('alice', ['bob']);
            world.registry.attach('bob', 'bob-phone');

            expect(world.presence.sweep()).toEqual(['bob']);
            expect(world.presence.flush()).toBe(0);
          });

          it('三十个人同时上线，一轮 flush 只推一批 [gate:batch]', () => {
            const world = makeWorld();
            const targets: string[] = [];
            for (let index = 1; index <= 30; index += 1) targets.push('t' + index);

            const watcherConns: string[] = [];
            for (let index = 1; index <= 3; index += 1) {
              const watcher = 'w' + index;
              watcherConns.push(world.registry.attach(watcher, watcher + '-phone'));
              world.presence.subscribe(watcher, targets);
            }
            for (const target of targets) world.registry.attach(target, target + '-phone');

            expect(world.presence.sweep()).toHaveLength(30);
            expect(world.presence.flush()).toBe(3);

            for (const connectionId of watcherConns) {
              expect(presenceFrames(world, connectionId)).toHaveLength(1);
              expect(presenceFrames(world, connectionId)[0].payload).toHaveLength(30);
            }
          });
        });
      `
    ),
  ],

  gates: [
    gate({
      metric: 'counters.presenceLeaks',
      op: 'eq',
      value: 0,
      zh: '没订阅过的状态一次都没漏出去',
      en: 'Not one unsubscribed state ever leaked',
      dimension: 'correctness',
    }),
    gate({
      metric: 'counters.framesPushed',
      op: 'lte',
      value: 8,
      zh: '三十个变化攒成一批，每个关注者一帧',
      en: 'Thirty changes batch into one frame per watcher',
      dimension: 'latency',
      scope: 'gate:batch',
    }),
  ],

  referenceFiles: [
    file(
      'src/presence/presence.ts',
      code`
        import type { ConnectionRegistry } from '../session/registry';
        import type { Transport } from '../support/transport';
        import { now } from '@lab/env';

        export type PresenceState = 'online' | 'away' | 'offline';

        export interface PresenceOptions {
          awayMs: number;
        }

        export interface PresenceUpdate {
          userId: string;
          state: PresenceState;
          since: number;
        }

        export interface Presence {
          subscribe(watcherId: string, targets: string[]): void;
          unsubscribe(watcherId: string, targets: string[]): void;
          stateOf(userId: string): PresenceState;
          sweep(): string[];
          flush(): number;
        }

        export function createPresence(
          transport: Transport,
          registry: ConnectionRegistry,
          options: PresenceOptions
        ): Presence {
          /** watched user -> the people allowed to hear about them */
          const watchers = new Map<string, Set<string>>();
          /** the last state we told anybody about */
          const known = new Map<string, PresenceUpdate>();
          /** watched users whose state changed since the last flush */
          const queued = new Set<string>();

          /** The newest heartbeat across a person's devices, or 0 when they have none. */
          function lastSeen(userId: string): number {
            const connections = registry.connectionsOf(userId);
            let newest = 0;
            for (const connectionId of connections) {
              newest = Math.max(newest, transport.lastSeenAt(connectionId));
            }
            return connections.length ? newest : 0;
          }

          function stateOf(userId: string): PresenceState {
            const connections = registry.connectionsOf(userId);
            if (connections.length === 0) return 'offline';
            return now() - lastSeen(userId) < options.awayMs ? 'online' : 'away';
          }

          return {
            subscribe(watcherId: string, targets: string[]): void {
              for (const target of targets) {
                const set = watchers.get(target) || new Set<string>();
                set.add(watcherId);
                watchers.set(target, set);
              }
            },

            unsubscribe(watcherId: string, targets: string[]): void {
              for (const target of targets) {
                const set = watchers.get(target);
                if (!set) continue;
                set.delete(watcherId);
                if (set.size === 0) watchers.delete(target);
              }
            },

            stateOf,

            sweep(): string[] {
              const changed: string[] = [];

              for (const userId of Array.from(watchers.keys())) {
                const state = stateOf(userId);
                const since = state === 'offline' ? 0 : lastSeen(userId);
                const previous = known.get(userId);
                if (previous && previous.state === state && previous.since === since) continue;
                known.set(userId, { userId, state, since });
                queued.add(userId);
                changed.push(userId);
              }

              return changed;
            },

            flush(): number {
              // Group first, push second. The other order is one frame per change,
              // multiplied by the number of watchers.
              const batches = new Map<string, PresenceUpdate[]>();

              for (const userId of Array.from(queued)) {
                const update = known.get(userId);
                if (!update) continue;
                for (const watcherId of Array.from(watchers.get(userId) || [])) {
                  const batch = batches.get(watcherId) || [];
                  batch.push(update);
                  batches.set(watcherId, batch);
                }
              }

              let frames = 0;
              for (const entry of Array.from(batches.entries())) {
                for (const connectionId of registry.connectionsOf(entry[0])) {
                  transport.push(connectionId, { kind: 'presence', payload: entry[1] });
                  frames += 1;
                }
              }

              queued.clear();
              return frames;
            },
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 9 关 · 撤回与编辑的一致性                                          */
/* ------------------------------------------------------------------ */

const stage9 = {
  id: 'edit-recall',
  title: t('第 9 关 · 撤回与编辑', 'Stage 9 · Recall and edit'),
  goal: t(
    [
      '前八关里，一条消息发出去就不再变了。这一关把这个假设拿掉。',
      '',
      '撤回听起来很简单：把那条消息删掉。难的是**已经出去的那些副本**：',
      '',
      '| 谁 | 状态 | 怎么让它知道 |',
      '| --- | --- | --- |',
      '| 在线的设备 | 已经渲染在屏幕上了 | 推一帧过去 |',
      '| 离线的设备 | 还没拿到那条消息 | 它拉的时候别给原文 |',
      '| **离线且已经拿到过的设备** | 屏幕上有，但现在联系不上 | ← 这个才是难点 |',
      '',
      '第三种情况是这一关的全部内容。这台设备的拉取位点已经**越过**了',
      '那条消息，所以第 3 关的增量拉取永远不会再把它返回一次 ——',
      '设备重新上线之后，屏幕上那条应该消失的消息会一直留着。',
      '',
      '## 解法不需要新机制',
      '',
      '把撤回**表达成一条新消息**。',
      '',
      '它有自己的 seq，排在会话末尾，内容是「第 N 条被撤回了」。',
      '于是它就是一条普通消息：第 3 关的拉取会给它，第 4 关的推送会推它，',
      '第 7 关的扇出会扇它。不需要第二条通道，不需要第二个位点，',
      '不需要「修订日志」这种东西。',
      '',
      '同时，原来那条记录**在原位被改写**：内容清空、状态标成 `recalled`。',
      '位置留着 —— 会话里那一格变成「消息已撤回」，而不是凭空少一条。',
      '',
      '## 要实现什么',
      '',
      '在 `src/conversation/revision.ts` 实现 `createRevisions(...)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `recall(conversationId, seq, byUserId)` | 撤回，返回修订事件的 seq |',
      '| `edit(conversationId, seq, byUserId, payload)` | 编辑，位置不变 |',
      '| `visible(conversationId, seq)` | 读者该看到什么；撤回了就是 undefined |',
      '',
      '规则：',
      '',
      '- 只有**原发送者**能撤回或编辑；',
      '- 超过 `recallWindowMs` 之后不能撤回；',
      '- 已撤回的消息不能再撤回，也不能编辑。',
      '',
      '## 怎么算过',
      '',
      '- 撤回之后，原文在**任何一条读路径上都取不到**：',
      '  `visible`、`store.readMessages`、第 3 关的增量拉取，都不行',
      '  （门槛 `counters.recalledStillVisible = 0`）；',
      '- 一个全新设备从头拉整个会话，也拿不到原文；',
      '- 撤回一条 500 条会话里的旧消息，**最多读 8 条记录**',
      '  （门槛 `counters.messagesScanned ≤ 8`）—— seq 稠密，位置是算出来的，',
      '  不是找出来的；',
      '- 修订事件让 seq 继续稠密，`counters.seqGaps` 仍然是 0。',
      '',
      '## 那个坑',
      '',
      '只改状态，不清内容。',
      '',
      '`state = "recalled"` 加上一句「读的时候过滤掉」，功能上完全正确 ——',
      '直到某条读路径忘了过滤。而读路径不止一条：`visible` 一条、',
      '增量拉取一条、会话列表的最后一条消息预览一条、搜索索引一条、',
      '导出功能一条。只要有一条漏了，撤回就是假的。',
      '',
      '更重要的是：用户点「撤回」的意思是**让它消失**，不是「标记为不显示」。',
      '内容还躺在服务端的数据库里、还会进当天的备份、还会出现在',
      '下一次数据导出里 —— 这在很多地区是合规问题，不只是产品问题。',
      '',
      '删掉就不用记得过滤了。',
    ].join('\n'),
    [
      'For eight stages a message never changed once it was sent. This stage removes that assumption.',
      '',
      'Recall sounds simple: delete the message. The difficulty is **the copies that already left:**',
      '',
      '| Who | State | How they find out |',
      '| --- | --- | --- |',
      '| An online device | Already rendered on screen | Push it a frame |',
      '| An offline device | Has not received the message yet | Do not hand it the text when it pulls |',
      '| **Offline and already holding it** | On screen, unreachable right now | ← this is the hard one |',
      '',
      'The third row is the whole stage. That device\'s pull cursor is already **past** the message, so',
      'stage 3\'s incremental pull will never return it again — the device comes back online and the',
      'message that should have vanished stays on screen forever.',
      '',
      '## The answer needs no new machinery',
      '',
      'Express the recall **as a message.**',
      '',
      'It gets its own seq at the end of the conversation and says "number N was recalled". At that point',
      'it is an ordinary message: stage 3\'s pull delivers it, stage 4\'s push pushes it, stage 7\'s fan-out',
      'fans it out. No second channel, no second cursor, no "revision log".',
      '',
      'At the same time the original record is **rewritten in place**: content cleared, state set to',
      '`recalled`. The position stays, so the conversation shows "message recalled" in that slot rather',
      'than silently losing a row.',
      '',
      '## What to build',
      '',
      'Implement `createRevisions(...)` in `src/conversation/revision.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `recall(conversationId, seq, byUserId)` | Recall it; return the revision event\'s seq |',
      '| `edit(conversationId, seq, byUserId, payload)` | Edit it; the position does not move |',
      '| `visible(conversationId, seq)` | What a reader should see; undefined once recalled |',
      '',
      'Rules:',
      '',
      '- Only the **original sender** may recall or edit;',
      '- Recall is refused after `recallWindowMs`;',
      '- A recalled message cannot be recalled again, nor edited.',
      '',
      '## What counts as passing',
      '',
      '- After a recall the original text is **unreachable on every read path**: `visible`,',
      '  `store.readMessages`, and stage 3\'s incremental pull (the',
      '  `counters.recalledStillVisible = 0` gate);',
      '- A brand-new device pulling the whole conversation from zero does not get it either;',
      '- Recalling an old message in a 500-message conversation **reads at most 8 records**',
      '  (the `counters.messagesScanned ≤ 8` gate) — sequences are dense, so the position is computed,',
      '  not searched for;',
      '- The revision event keeps sequences dense, so `counters.seqGaps` is still 0.',
      '',
      '## The trap',
      '',
      'Setting the state without clearing the content.',
      '',
      '`state = "recalled"` plus "filter it out on read" is functionally correct — until one read path',
      'forgets to filter. And there is never one read path: `visible` is one, the incremental pull is',
      'another, the last-message preview in the conversation list is a third, then the search index, then',
      'the export. One omission and the recall was never real.',
      '',
      'More importantly: when someone taps recall they mean **make it go away**, not "mark it as not',
      'displayed". The text is still in the server\'s database, still goes into tonight\'s backup, still',
      'shows up in the next data export — which in many jurisdictions is a compliance question rather than',
      'a product one.',
      '',
      'Delete it and there is nothing left to remember to filter.',
    ].join('\n')
  ),

  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  R["recall(会话, seq, 谁)"] --> IDX["下标 = seq - 1<br/>seq 稠密，位置是算出来的"]',
      '  IDX --> READ["store.readMessages(会话, 下标, 1) 读出这一条"]',
      '  READ --> WHO{"是原发送者吗？"}',
      '  WHO -- 不是 --> NO1["拒绝"]',
      '  WHO -- 是 --> STATE{"已经撤回过了？"}',
      '  STATE -- 是 --> NO2["拒绝"]',
      '  STATE -- 否 --> WIN{"还在 recallWindowMs 之内？"}',
      '  WIN -- 超时 --> NO3["拒绝"]',
      '  WIN -- 在窗口内 --> WIPE["store.replaceMessage(会话, 下标, 清空内容的记录)<br/>state = recalled，位置留着"]',
      '  WIPE --> EVENT["sequencer.send(一条修订消息)<br/>内容是「第 N 条被撤回了」"]',
      '  EVENT --> WHY["它就是一条普通消息：<br/>拉取会给它，推送会推它，扇出会扇它"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  V["visible(会话, seq)"] --> VR["读出这一条"]',
      '  VR --> VS{"state 是什么？"}',
      '  VS -- recalled --> UNDEF["返回 undefined"]',
      '  VS -- edited --> NEW["返回改过之后的内容"]',
      '  VS -- live --> ORIG["返回原内容"]',
      '```',
      '',
      '要点：`WIPE` 是**清空**，不是打标记。',
      '打标记的话，正确性就取决于每一条读路径都记得过滤，而读路径会越来越多。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  R["recall(conversation, seq, who)"] --> IDX["index = seq - 1<br/>dense sequences: computed, not searched"]',
      '  IDX --> READ["store.readMessages(conversation, index, 1)"]',
      '  READ --> WHO{"the original sender?"}',
      '  WHO -- no --> NO1["refuse"]',
      '  WHO -- yes --> STATE{"already recalled?"}',
      '  STATE -- yes --> NO2["refuse"]',
      '  STATE -- no --> WIN{"still inside recallWindowMs?"}',
      '  WIN -- expired --> NO3["refuse"]',
      '  WIN -- inside --> WIPE["store.replaceMessage(conversation, index, cleared record)<br/>state = recalled, slot preserved"]',
      '  WIPE --> EVENT["sequencer.send(a revision message)<br/>saying number N was recalled"]',
      '  EVENT --> WHY["now it is an ordinary message:<br/>pull delivers it, push pushes it, fan-out fans it"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  V["visible(conversation, seq)"] --> VR["read the record"]',
      '  VR --> VS{"which state?"}',
      '  VS -- recalled --> UNDEF["return undefined"]',
      '  VS -- edited --> NEW["return the edited content"]',
      '  VS -- live --> ORIG["return the original"]',
      '```',
      '',
      'The point: `WIPE` **clears**, it does not flag. With a flag, correctness depends on every read path',
      'remembering to filter, and read paths only ever multiply.',
    ].join('\n')
  ),

  checklist: [
    t('撤回清空内容，不只是打标记', 'A recall clears the content rather than flagging it'),
    t('原来的位置留着，会话不少一格', 'The slot stays so the conversation does not lose a row'),
    t('修订本身是一条消息，走现成的投递链路', 'The revision is a message and rides the existing delivery path'),
    t('只有原发送者能改，且有时间窗口', 'Only the original sender may act, and only inside the window'),
    t('下标由 seq 算出来，不靠遍历', 'The index is computed from seq, never searched for'),
  ],

  pitfalls: [
    t(
      '只把 state 改成 recalled，内容原样留着，靠读的时候过滤。功能上正确，直到某一条读路径忘了过滤 —— 而读路径永远不止一条：单条读、增量拉取、会话列表的预览、搜索索引、数据导出。更根本的是，用户点撤回的意思是让它消失，而不是标记为不显示；内容留在库里还会进备份、进导出，在很多地区这是合规问题。',
      'Flipping the state to recalled while leaving the content in place and filtering on read. Correct until one read path forgets, and there is never one read path: single reads, incremental pull, the conversation-list preview, the search index, the export. More fundamentally, "recall" means make it go away rather than mark it hidden; content left in the database still reaches the backup and the export, which in many jurisdictions is a compliance question.'
    ),
    t(
      '把撤回做成一条独立的「修订通道」，自己的存储、自己的位点、自己的推送逻辑。它需要重新解决第 3 关到第 7 关已经解决过的每一个问题：离线怎么补、多端怎么同步、大群怎么扇出。表达成一条普通消息则一个都不用重做 —— 这也是「只追加」这个约定最大的一次回报。',
      'Building recalls as a separate revision channel with its own storage, cursor and delivery logic. It has to re-solve every problem stages 3 through 7 already solved: offline catch-up, multi-device convergence, large-group fan-out. Expressing it as an ordinary message re-solves none of them, which is the biggest single payoff of the append-only convention.'
    ),
    t(
      '为了找到第 N 条而遍历会话。第 2 关已经保证 seq 稠密，下标就是 seq - 1 —— 这是当初坚持稠密的原因之一。遍历在小会话里看不出来，在一个几十万条的大群里，撤回一条消息会读几十万条记录，而撤回通常发生在发出后几秒，正是这个群最忙的时候。',
      'Scanning the conversation to find message N. Stage 2 guaranteed dense sequences precisely so the index is `seq - 1`. A scan is invisible in a small conversation; in a group with hundreds of thousands of messages, recalling one reads all of them — and recalls happen seconds after sending, which is exactly when that group is busiest.'
    ),
    t(
      '不校验发送者，或者不做时间窗口。撤回别人的消息是显而易见的权限漏洞；没有时间窗口则是个产品陷阱 —— 一条三个月前的消息突然消失，对已经读过它的人来说是记忆错乱，而且会被当成系统丢数据。真实产品普遍是两分钟到几分钟，管理员另有单独的删除权限。',
      'Skipping the sender check or the time window. Recalling somebody else\'s message is an obvious authorisation hole; skipping the window is a product trap — a message vanishing three months later reads as memory corruption to everyone who already saw it, and gets reported as data loss. Real products settle on two to a few minutes, with administrator deletion as a separate power.'
    ),
  ],

  hints: [
    t(
      '修订事件的 `clientMsgId` 可以直接用它自己的 seq 拼出来（`store.messageCount(会话) + 1`），天然在会话内唯一，不会撞上第 2 关的去重。',
      'Mint the revision event\'s `clientMsgId` from its own sequence — `store.messageCount(conversation) + 1` — which is unique within the conversation by construction and cannot collide with stage 2\'s deduplication.'
    ),
    t(
      '撤回和编辑的前置校验完全一样（是不是发送者、是不是已撤回、在不在窗口内），抽成一个私有函数返回那条记录，两个方法各自只剩三四行。',
      'Recall and edit share every precondition — sender, already-recalled, inside the window. Factor them into one private function that returns the record, and each method is three or four lines.'
    ),
  ],

  extension: t(
    [
      '「撤回」在不同产品里是完全不同的承诺，这是个值得留意的差别：',
      '',
      '- **微信**的撤回是两分钟内、双方都删除、留一行「撤回了一条消息」；',
      '- **Telegram** 可以删除任意时间的消息，而且可以选择「同时为对方删除」，',
      '  删掉之后连痕迹都不留；',
      '- **Slack** 的删除会留下审计记录，管理员能看到 —— 因为它是企业产品，',
      '  合规要求和消费级产品正好相反：消费级要求「真的删掉」，',
      '  企业级经常要求「删了也要留证据」。',
      '',
      '这三种承诺对应三种完全不同的存储实现，而它们的分歧不在技术上，在法律上。',
      '企业 IM 尤其要注意：**撤回**和**合规留存**是直接冲突的两个需求，',
      '常见的做法是撤回对用户生效、但原文进入一个只有合规审计能访问的归档。',
      '',
      '技术上还有一个这一关简化掉的东西：**修订的顺序**。',
      '如果两台设备几乎同时编辑同一条消息，最后哪一版赢？',
      '这一关里修订本身有 seq，所以「后面那条赢」是天然的 ——',
      '这正是把修订表达成消息带来的又一个好处：',
      '冲突解决直接复用了会话内的全序，不需要额外的向量时钟或者 CRDT。',
      '',
      '端到端加密之后撤回会变得更微妙：服务端读不懂内容，',
      '也就没法确认「这条修订确实是原发送者发的」——',
      '这个校验必须挪到客户端，用签名来做。第 10 关会遇到这个边界。',
    ].join('\n'),
    [
      '"Recall" is a different promise in different products, and the difference is worth noticing:',
      '',
      '- **WeChat**: within two minutes, deleted for everyone, leaving a "message recalled" line;',
      '- **Telegram**: delete anything at any time, optionally for the other party too, leaving no trace at',
      '  all;',
      '- **Slack**: deletion leaves an audit record administrators can see, because it is an enterprise',
      '  product where compliance points the opposite way from consumer software — consumers want it really',
      '  gone, enterprises frequently require evidence that it was removed.',
      '',
      'Three promises, three storage designs, and the disagreement between them is legal rather than',
      'technical. Enterprise IM in particular has to reconcile **recall** and **retention**, which conflict',
      'directly; the usual compromise is that the recall is real for users while the original moves into an',
      'archive only compliance auditing can reach.',
      '',
      'One thing simplified away here: **the order of revisions.** If two devices edit the same message at',
      'nearly the same moment, which version wins? Because the revision carries a seq, "the later one wins"',
      'falls out for free — another benefit of expressing revisions as messages, since conflict resolution',
      'reuses the total order inside the conversation instead of needing a vector clock or a CRDT.',
      '',
      'End-to-end encryption makes recall subtler still: a server that cannot read the content also cannot',
      'confirm that a revision genuinely came from the original sender, so that check has to move to the',
      'client and be carried by a signature. Stage 10 runs into that boundary.',
    ].join('\n')
  ),

  focus: ['correctness', 'resilience', 'encapsulation'],
  lab: {},

  starterFiles: [
    file(
      'src/conversation/revision.ts',
      code`
        import type { Sequencer } from './sequence';
        import type { Store } from '../support/store';

        export interface RevisionOptions {
          /** A message can no longer be recalled once this long has passed */
          recallWindowMs: number;
        }

        export type RevisionKind = 'recall' | 'edit';

        /** The body of the revision message appended to the conversation. */
        export interface RevisionEvent {
          kind: RevisionKind;
          /** The seq being revised */
          targetSeq: number;
          /** The new content, for an edit */
          payload?: unknown;
        }

        export interface RevisionResult {
          /** The seq of the revision message itself */
          seq: number;
          targetSeq: number;
        }

        export interface VisibleMessage {
          conversationId: string;
          seq: number;
          senderId: string;
          payload: unknown;
          sentAt: number;
          edited: boolean;
        }

        export interface Revisions {
          recall(conversationId: string, seq: number, byUserId: string): RevisionResult;
          edit(
            conversationId: string,
            seq: number,
            byUserId: string,
            payload: unknown
          ): RevisionResult;
          /** What a reader should see. Undefined once the message is recalled. */
          visible(conversationId: string, seq: number): VisibleMessage | undefined;
        }

        export function createRevisions(
          store: Store,
          sequencer: Sequencer,
          options: RevisionOptions
        ): Revisions {
          // TODO: implement
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
        import { createBacklog } from '../src/conversation/backlog';
        import { createRevisions } from '../src/conversation/revision';
        import { createSequencer } from '../src/conversation/sequence';
        import { createStore } from '../src/support/store';
        import { now, sleep } from '@lab/env';
        import { count } from '@lab/metrics';

        const WINDOW_MS = 2000;
        const SECRET = 'the-original-text';

        function makeWorld(recallWindowMs = WINDOW_MS) {
          const store = createStore();
          const sequencer = createSequencer(store);
          const backlog = createBacklog(store);
          const revisions = createRevisions(store, sequencer, { recallWindowMs });
          return { store, sequencer, backlog, revisions };
        }

        function conversation(world: any, id: string, members: string[]): void {
          world.store.putConversation({ conversationId: id, kind: 'direct', members });
        }

        function post(world: any, conversationId: string, sender: string, text: string): number {
          const nth = world.store.messageCount(conversationId) + 1;
          return world.sequencer.send({
            conversationId,
            senderId: sender,
            clientMsgId: conversationId + '-m' + nth,
            payload: text,
            sentAt: now(),
          }).seq;
        }

        /** Every place a reader could get at a message, checked for the original text. */
        function leakedAnywhere(world: any, conversationId: string, seq: number): boolean {
          if (world.revisions.visible(conversationId, seq) !== undefined) return true;

          const stored = world.store.readMessages(conversationId, seq - 1, 1)[0];
          if (stored && JSON.stringify(stored.payload || '').indexOf(SECRET) >= 0) return true;

          const page = world.backlog.pull({ userId: 'alice', since: {}, limit: 500 });
          for (const entry of page.entries) {
            if (JSON.stringify(entry.payload || '').indexOf(SECRET) >= 0) return true;
          }
          return false;
        }

        describe('阶段9 · 撤回与编辑', () => {
          it('撤回之后原文从存储里消失，位置还留着', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const seq = post(world, 'c1', 'alice', SECRET);

            world.revisions.recall('c1', seq, 'alice');

            const stored = world.store.readMessages('c1', seq - 1, 1)[0];
            expect(stored.seq).toBe(seq);
            expect(stored.state).toBe('recalled');
            expect(JSON.stringify(stored.payload || '')).not.toContain(SECRET);
          });

          it('撤回会追加一条修订消息，序号继续稠密', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            post(world, 'c1', 'alice', 'one');
            const target = post(world, 'c1', 'alice', SECRET);

            const result = world.revisions.recall('c1', target, 'alice');

            expect(result.targetSeq).toBe(target);
            expect(result.seq).toBe(3);
            expect(world.store.messageCount('c1')).toBe(3);

            const event = world.store.readMessages('c1', 2, 1)[0];
            expect(event.payload.kind).toBe('recall');
            expect(event.payload.targetSeq).toBe(target);
          });

          it('离线设备靠现成的增量拉取就能知道撤回', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const target = post(world, 'c1', 'alice', SECRET);

            // 这台设备已经拿到过第 1 条，位点越过了它
            world.revisions.recall('c1', target, 'alice');
            const page = world.backlog.pull({ userId: 'alice', since: { c1: target }, limit: 10 });

            expect(page.entries).toHaveLength(1);
            expect(page.entries[0].payload.kind).toBe('recall');
            expect(page.entries[0].payload.targetSeq).toBe(target);
          });

          it('全新设备从头拉也拿不到原文 [gate:recall]', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            post(world, 'c1', 'alice', 'before');
            const target = post(world, 'c1', 'alice', SECRET);
            post(world, 'c1', 'alice', 'after');

            world.revisions.recall('c1', target, 'alice');

            if (leakedAnywhere(world, 'c1', target)) count('recalledStillVisible');
            expect(leakedAnywhere(world, 'c1', target)).toBe(false);
          });

          it('visible 对撤回过的消息返回 undefined', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const seq = post(world, 'c1', 'alice', SECRET);

            expect(world.revisions.visible('c1', seq)).toBeDefined();
            world.revisions.recall('c1', seq, 'alice');
            expect(world.revisions.visible('c1', seq)).toBeUndefined();
          });

          it('编辑改内容不改位置', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const seq = post(world, 'c1', 'alice', 'typo');

            world.revisions.edit('c1', seq, 'alice', 'fixed');

            const visible = world.revisions.visible('c1', seq);
            expect(visible.seq).toBe(seq);
            expect(visible.payload).toBe('fixed');
            expect(visible.edited).toBe(true);
          });

          it('编辑也追加修订消息，带着新内容', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const seq = post(world, 'c1', 'alice', 'typo');

            const result = world.revisions.edit('c1', seq, 'alice', 'fixed');

            const event = world.store.readMessages('c1', result.seq - 1, 1)[0];
            expect(event.payload.kind).toBe('edit');
            expect(event.payload.targetSeq).toBe(seq);
            expect(event.payload.payload).toBe('fixed');
          });

          it('没被改过的消息 visible 返回原样', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const seq = post(world, 'c1', 'bob', 'hello');

            const visible = world.revisions.visible('c1', seq);
            expect(visible.payload).toBe('hello');
            expect(visible.senderId).toBe('bob');
            expect(visible.edited).toBe(false);
          });

          it('不存在的位置 visible 返回 undefined', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);

            expect(world.revisions.visible('c1', 1)).toBeUndefined();
            expect(world.revisions.visible('nope', 1)).toBeUndefined();
          });

          it('只有原发送者能撤回', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const seq = post(world, 'c1', 'alice', SECRET);

            expect(() => world.revisions.recall('c1', seq, 'bob')).toThrow();
            expect(world.revisions.visible('c1', seq)).toBeDefined();
          });

          it('只有原发送者能编辑', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const seq = post(world, 'c1', 'alice', 'mine');

            expect(() => world.revisions.edit('c1', seq, 'bob', 'yours')).toThrow();
            expect(world.revisions.visible('c1', seq).payload).toBe('mine');
          });

          it('超过时间窗口不能撤回', async () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const seq = post(world, 'c1', 'alice', SECRET);

            await sleep(WINDOW_MS + 1);

            expect(() => world.revisions.recall('c1', seq, 'alice')).toThrow();
          });

          it('撤回过的消息不能再撤回，也不能编辑', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const seq = post(world, 'c1', 'alice', SECRET);
            world.revisions.recall('c1', seq, 'alice');

            expect(() => world.revisions.recall('c1', seq, 'alice')).toThrow();
            expect(() => world.revisions.edit('c1', seq, 'alice', 'back')).toThrow();
          });

          it('五百条会话里撤回一条旧消息，不重扫会话 [gate:cost]', () => {
            const world = makeWorld(1000000);
            conversation(world, 'c1', ['alice', 'bob']);
            for (let index = 1; index <= 500; index += 1) {
              post(world, 'c1', 'alice', 'text-' + index);
            }

            const result = world.revisions.recall('c1', 7, 'alice');

            expect(result.seq).toBe(501);
            expect(world.revisions.visible('c1', 7)).toBeUndefined();
          });
        });
      `
    ),
  ],

  gates: [
    gate({
      metric: 'counters.recalledStillVisible',
      op: 'eq',
      value: 0,
      zh: '撤回之后原文在任何读路径上都取不到',
      en: 'Recalled text is unreachable on every read path',
      dimension: 'correctness',
    }),
    gate({
      metric: 'counters.messagesScanned',
      op: 'lte',
      value: 8,
      zh: '撤回一条消息最多读八条记录',
      en: 'Recalling one message reads at most eight records',
      dimension: 'latency',
      scope: 'gate:cost',
    }),
    gate({
      metric: 'counters.seqGaps',
      op: 'eq',
      value: 0,
      zh: '修订事件让序号继续稠密',
      en: 'Revision events keep the sequence dense',
      dimension: 'correctness',
    }),
  ],

  referenceFiles: [
    file(
      'src/conversation/revision.ts',
      code`
        import type { Sequencer } from './sequence';
        import type { MessageRecord, Store } from '../support/store';
        import { now } from '@lab/env';

        export interface RevisionOptions {
          recallWindowMs: number;
        }

        export type RevisionKind = 'recall' | 'edit';

        export interface RevisionEvent {
          kind: RevisionKind;
          targetSeq: number;
          payload?: unknown;
        }

        export interface RevisionResult {
          seq: number;
          targetSeq: number;
        }

        export interface VisibleMessage {
          conversationId: string;
          seq: number;
          senderId: string;
          payload: unknown;
          sentAt: number;
          edited: boolean;
        }

        export interface Revisions {
          recall(conversationId: string, seq: number, byUserId: string): RevisionResult;
          edit(
            conversationId: string,
            seq: number,
            byUserId: string,
            payload: unknown
          ): RevisionResult;
          visible(conversationId: string, seq: number): VisibleMessage | undefined;
        }

        export function createRevisions(
          store: Store,
          sequencer: Sequencer,
          options: RevisionOptions
        ): Revisions {
          /** Dense sequences from stage 2 mean the position is arithmetic, not a search. */
          function recordAt(conversationId: string, seq: number): MessageRecord | undefined {
            if (seq < 1) return undefined;
            return store.readMessages(conversationId, seq - 1, 1)[0];
          }

          /** Everything recall and edit both have to establish before touching anything. */
          function authorise(
            conversationId: string,
            seq: number,
            byUserId: string,
            checkWindow: boolean
          ): MessageRecord {
            const record = recordAt(conversationId, seq);
            if (!record) throw new Error('no message at seq ' + seq);
            if (record.senderId !== byUserId) throw new Error('only the sender may revise a message');
            if (record.state === 'recalled') throw new Error('message is already recalled');
            if (checkWindow && now() - record.sentAt > options.recallWindowMs) {
              throw new Error('the recall window has closed');
            }
            return record;
          }

          /**
           * The revision is an ordinary message.
           *
           * That is the whole trick: incremental pull, multi-device push and group
           * fan-out already deliver messages, so a device that is offline right now
           * learns about the recall the same way it learns about anything else.
           */
          function announce(
            conversationId: string,
            byUserId: string,
            event: RevisionEvent
          ): RevisionResult {
            const nextSeq = store.messageCount(conversationId) + 1;
            const result = sequencer.send({
              conversationId,
              senderId: byUserId,
              clientMsgId: 'rev-' + nextSeq,
              payload: event,
              sentAt: now(),
            });
            return { seq: result.seq, targetSeq: event.targetSeq };
          }

          return {
            recall(conversationId: string, seq: number, byUserId: string): RevisionResult {
              const record = authorise(conversationId, seq, byUserId, true);

              // Clear it, do not flag it. A flag leaves the text for every read path
              // to remember to filter, and one of them eventually will not.
              store.replaceMessage(conversationId, seq - 1, {
                ...record,
                payload: undefined,
                state: 'recalled',
                revisedAt: now(),
              });

              return announce(conversationId, byUserId, { kind: 'recall', targetSeq: seq });
            },

            edit(
              conversationId: string,
              seq: number,
              byUserId: string,
              payload: unknown
            ): RevisionResult {
              const record = authorise(conversationId, seq, byUserId, false);

              store.replaceMessage(conversationId, seq - 1, {
                ...record,
                payload,
                state: 'edited',
                revisedAt: now(),
              });

              return announce(conversationId, byUserId, { kind: 'edit', targetSeq: seq, payload });
            },

            visible(conversationId: string, seq: number): VisibleMessage | undefined {
              const record = recordAt(conversationId, seq);
              if (!record || record.state === 'recalled') return undefined;
              return {
                conversationId,
                seq: record.seq,
                senderId: record.senderId,
                payload: record.payload,
                sentAt: record.sentAt,
                edited: record.state === 'edited',
              };
            },
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 10 关 · 端到端加密                                                 */
/* ------------------------------------------------------------------ */

const stage10 = {
  id: 'e2ee-session',
  title: t('第 10 关 · 端到端加密与密钥协商', 'Stage 10 · End-to-end encryption'),
  goal: t(
    [
      '前九关里，服务端能读到每一条消息的内容。这一关把这件事拿掉，',
      '而**前九关的功能一个都不能少**。',
      '',
      '这是全项目最能说明「元数据和内容是两回事」的一关。',
      '把明文拿走之后，你会发现服务端其实一直在靠元数据工作：',
      '',
      '| 功能 | 需要内容吗 |',
      '| --- | --- |',
      '| 会话序号（2）、增量拉取（3） | 不需要，只要 seq |',
      '| 多端同步（4）、已读位点（5） | 不需要，只要位点 |',
      '| 回执聚合（6）、群扇出（7） | 不需要，只要成员和位点 |',
      '| 在线状态（8） | 不需要，只要连接 |',
      '| 撤回（9） | 不需要，只要位置和发送者 |',
      '',
      '一条都不需要。这不是巧合 —— 一个设计良好的 IM 服务端本来就不该',
      '依赖消息内容，端到端加密只是把这条纪律变成了强制的。',
      '',
      '## 关键结构：一条消息，N 个信封',
      '',
      '加密的单位是**设备**，不是人。张三的手机和电脑是两把不同的钥匙，',
      '所以一条发给三个人的消息，如果这三个人一共有六台设备，',
      '就要封六份（减去写这条消息的那台，它本来就有明文）。',
      '',
      '**每台设备恰好一份**。多封了是浪费，少封了那台设备就永远解不开。',
      '',
      '服务端拿到的是一张 `设备 id -> 密文信封` 的表。推送的时候，',
      '它必须**挑出这台设备的那一份**推过去 —— 把整张表推给每台设备，',
      '等于把所有人的密文都发给所有人。',
      '',
      '## 要实现什么',
      '',
      '在 `src/crypto/e2eeSession.ts` 实现 `createE2eeSession(store, keyRing)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `register(userId, deviceId)` | 设备上线并发布公钥，返回它的密钥对 |',
      '| `devicesOf(userId)` | 这个人有哪些设备 |',
      '| `sealFor(conversationId, senderId, senderDeviceId, plaintext)` | 给每台接收设备各封一份 |',
      '| `envelopeFor(sealed, deviceId)` | 取出寄给这台设备的那一份 |',
      '| `open(keyPair, envelope)` | 设备用自己的私钥拆开 |',
      '',
      '`seal` 要带一个**棘轮位置**：同一台设备的每一次封装用一个新的位置。',
      '重复使用同一个位置在真实的流密码里等于 nonce 复用，',
      '两条密文异或一下就能消掉密钥流。',
      '',
      '## 怎么算过',
      '',
      '- 推到线上的每一个消息帧都是密文（门槛 `counters.plaintextOnWire = 0`，',
      '  hub 只认这个模块造出来的信封，「假装加密」过不去）；',
      '- 3 个成员共 6 台设备，发一条消息**恰好封 5 次**',
      '  （门槛 `counters.sealOperations ≤ 5`）；',
      '- 棘轮位置从不复用（门槛 `counters.keyReuse = 0`）；',
      '- 自己的另一台设备能解开 —— 第 4 关的多端同步在加密之后仍然成立；',
      '- 后加入的设备解不开之前的消息。',
      '',
      '## 那个坑',
      '',
      '按**人**加密，不是按**设备**。',
      '',
      '「给张三加密一份」听起来很自然，但张三不持有钥匙，张三的**设备**才持有。',
      '按人封装意味着三台设备共用一把密钥 —— 那把密钥必须在设备之间同步，',
      '而同步它的通道又需要加密，问题就绕回来了。',
      '',
      '更实际的后果是：任何一台设备丢失或被攻破，撤销它就要换掉这个人的密钥，',
      '于是**这个人所有的设备**都要重新协商。按设备加密的话，',
      '丢一台就撤一台，其余的完全不受影响。',
      '',
      '这也解释了一个用户经常抱怨的现象：新装的设备看不到历史消息。',
      '因为历史消息的信封是封给旧设备的，服务端**没有明文**可以补给新设备 ——',
      '这不是产品偷懒，是端到端加密的直接后果。',
    ].join('\n'),
    [
      'For nine stages the server could read every message. This stage takes that away, and **not one of',
      'those nine features is allowed to break.**',
      '',
      'It is the clearest demonstration in the project that metadata and content are different things.',
      'Remove the plaintext and it turns out the server was working from metadata all along:',
      '',
      '| Feature | Needs content? |',
      '| --- | --- |',
      '| Sequencing (2), incremental pull (3) | No, only the seq |',
      '| Multi-device sync (4), read cursors (5) | No, only cursors |',
      '| Receipt aggregation (6), group fan-out (7) | No, only members and cursors |',
      '| Presence (8) | No, only connections |',
      '| Recall (9) | No, only the position and the sender |',
      '',
      'Not one of them. That is not a coincidence — a well-built IM server should not depend on message',
      'content in the first place, and end-to-end encryption merely makes the discipline mandatory.',
      '',
      '## The key structure: one message, N envelopes',
      '',
      'Encryption is per **device**, not per person. Alice\'s phone and Alice\'s laptop hold different keys,',
      'so a message to three people who own six devices between them is sealed six times — minus the device',
      'that wrote it, which already has the plaintext.',
      '',
      '**Exactly one envelope per device.** More is waste; fewer and that device can never read it.',
      '',
      'The server holds a map from device id to ciphertext. When it pushes, it has to **pick out the',
      'envelope for that device** — pushing the whole map to everyone means handing everybody else\'s',
      'ciphertext to everybody.',
      '',
      '## What to build',
      '',
      'Implement `createE2eeSession(store, keyRing)` in `src/crypto/e2eeSession.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `register(userId, deviceId)` | A device comes online and publishes its key |',
      '| `devicesOf(userId)` | Which devices this person has |',
      '| `sealFor(conversationId, senderId, senderDeviceId, plaintext)` | One envelope per recipient device |',
      '| `envelopeFor(sealed, deviceId)` | The envelope addressed to this device |',
      '| `open(keyPair, envelope)` | The device opens it with its own private key |',
      '',
      '`seal` takes a **ratchet position**, and every seal for one device must use a new one. Reusing a',
      'position is nonce reuse in a real stream cipher, where xoring two ciphertexts cancels the keystream.',
      '',
      '## What counts as passing',
      '',
      '- Every message frame on the wire is ciphertext (the `counters.plaintextOnWire = 0` gate — the hub',
      '  only recognises envelopes this module produced, so "pretend to encrypt" does not pass);',
      '- Three members with six devices between them cost **exactly five seals** for one message',
      '  (the `counters.sealOperations ≤ 5` gate);',
      '- Ratchet positions are never reused (the `counters.keyReuse = 0` gate);',
      '- Your own other device can open it — stage 4\'s multi-device sync survives encryption;',
      '- A device added later cannot read earlier messages.',
      '',
      '## The trap',
      '',
      'Encrypting per **person** instead of per **device**.',
      '',
      '"Seal one copy for Alice" sounds natural, but Alice does not hold a key — Alice\'s **devices** do.',
      'Per-person sealing means three devices share one key, that key has to be synchronised between them,',
      'and the channel that synchronises it needs encryption, which is where you came in.',
      '',
      'The practical consequence is worse: losing or compromising one device means rotating that person\'s',
      'key, so **all of their devices** have to renegotiate. Per-device, you revoke the one that was lost',
      'and nothing else notices.',
      '',
      'It also explains something users complain about: a newly installed device shows no history. The',
      'envelopes for old messages were sealed for the old devices, and the server **has no plaintext** to',
      'backfill from. That is not laziness, it is a direct consequence of the guarantee.',
    ].join('\n')
  ),

  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  S["sealFor(会话, 发送人, 发送设备, 明文)"] --> MEM["store.getConversation(会话).members"]',
      '  MEM --> EACH["每个成员的每一台设备"]',
      '  EACH --> SELF{"就是写这条消息的那台？"}',
      '  SELF -- 是 --> SKIP["跳过，它本来就有明文"]',
      '  SELF -- 否 --> KEY{"发布过公钥吗？"}',
      '  KEY -- 没有 --> SKIP2["跳过"]',
      '  KEY -- 有 --> TICK["棘轮位置加一<br/>按设备各自计数"]',
      '  TICK --> SEAL["keyRing.seal(设备, 明文, 位置)"]',
      '  SEAL --> PUT["放进 设备 id -> 信封 表"]',
      '  PUT --> MORE{"还有设备吗？"}',
      '  MORE -- 有 --> EACH',
      '  MORE -- 没有 --> OUT["返回这张表"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  P["服务端要推给某台设备"] --> PICK["envelopeFor(表, 设备 id)"]',
      '  PICK --> HIT{"有它的那一份吗？"}',
      '  HIT -- 没有 --> NONE["不是收件人，什么都不推"]',
      '  HIT -- 有 --> ONE["只推它自己那一个信封<br/>整张表推过去等于泄露给所有人"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  O["设备收到之后"] --> OPEN["open(自己的密钥对, 信封)"]',
      '  OPEN --> CHK{"信封是寄给这台设备的吗？"}',
      '  CHK -- 不是 --> THROW["抛错"]',
      '  CHK -- 是 --> TXT["拿到明文"]',
      '```',
      '',
      '要点：循环的最内层是**设备**，不是人。',
      '写成按人循环，一个人的多台设备就只能共用一把钥匙。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  S["sealFor(conversation, sender, sending device, plaintext)"] --> MEM["store.getConversation(...).members"]',
      '  MEM --> EACH["every device of every member"]',
      '  EACH --> SELF{"is it the device that wrote it?"}',
      '  SELF -- yes --> SKIP["skip, it already has the plaintext"]',
      '  SELF -- no --> KEY{"has it published a key?"}',
      '  KEY -- no --> SKIP2["skip"]',
      '  KEY -- yes --> TICK["advance the ratchet<br/>counted per device"]',
      '  TICK --> SEAL["keyRing.seal(device, plaintext, position)"]',
      '  SEAL --> PUT["store it in the device-to-envelope map"]',
      '  PUT --> MORE{"more devices?"}',
      '  MORE -- yes --> EACH',
      '  MORE -- no --> OUT["return the map"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  P["the server wants to push to one device"] --> PICK["envelopeFor(map, deviceId)"]',
      '  PICK --> HIT{"is there one for it?"}',
      '  HIT -- no --> NONE["not a recipient, push nothing"]',
      '  HIT -- yes --> ONE["push only its own envelope<br/>the whole map would leak everyone\'s"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  O["the device receives it"] --> OPEN["open(its own key pair, envelope)"]',
      '  OPEN --> CHK{"was it addressed to this device?"}',
      '  CHK -- no --> THROW["throw"]',
      '  CHK -- yes --> TXT["plaintext"]',
      '```',
      '',
      'The point: the innermost loop is over **devices**, not people. Loop over people and a person\'s',
      'devices are forced to share one key.',
    ].join('\n')
  ),

  checklist: [
    t('加密单位是设备，不是人', 'The unit of encryption is the device, not the person'),
    t('每台接收设备恰好一个信封', 'Exactly one envelope per recipient device'),
    t('写这条消息的那台设备不封', 'The device that composed it is not sealed for'),
    t('棘轮位置按设备各自递增', 'The ratchet advances per device'),
    t('推送时只推这台设备的那一份', 'Push only the envelope belonging to that device'),
  ],

  pitfalls: [
    t(
      '按人加密而不是按设备。人不持有钥匙，设备才持有。按人封装意味着一个人的几台设备要共用一把密钥，而同步这把密钥的通道本身又需要加密。实际后果是撤销粒度变粗：丢一台设备要换掉这个人所有设备的密钥。',
      'Encrypting per person rather than per device. People do not hold keys, devices do. Per-person sealing forces one person\'s devices to share a key, and the channel that would synchronise that key needs encryption itself. The practical damage is the revocation granularity: losing one device rotates the keys of all of them.'
    ),
    t(
      '把整张「设备 id 到信封」的表推给每一台设备。功能上能跑 —— 每台设备挑出自己那份就行。代价是每台设备都拿到了所有人的密文，流量按设备数平方增长，而且一旦将来某把私钥泄露，攻击者手上正好有一份完整的历史密文可以离线解。只推它自己的那一个。',
      'Pushing the whole device-to-envelope map to every device. It works, since each device can pick out its own. The cost is that every device now holds everyone\'s ciphertext, traffic grows with the square of the device count, and a private key compromised later comes with a complete archive of ciphertext to decrypt offline. Push one envelope.'
    ),
    t(
      '棘轮位置固定不变，或者所有设备共用一个计数器。固定位置在真实的流密码里是 nonce 复用：两条用同一密钥流加密的密文异或一下，密钥流就消掉了，剩下两条明文的异或 —— 对自然语言来说这基本等于明文。共用计数器则会让某些设备跳号，虽然不复用，但把「位置」和「这台设备收了几条」解耦了，出问题时无从对账。',
      'Fixing the ratchet position, or sharing one counter across devices. A fixed position is nonce reuse: xor two ciphertexts encrypted under the same keystream and the keystream cancels, leaving the xor of two plaintexts, which for natural language is close to plaintext. A shared counter avoids reuse but decouples the position from how many messages that device received, leaving nothing to reconcile against when something goes wrong.'
    ),
    t(
      '因为服务端读不到内容，就把已读位点、回执、扇出这些也一并交给客户端做。加密保护的是内容，不是元数据 —— 服务端仍然知道谁在什么时候给谁发了消息、谁读到了第几条，而且它必须知道，否则前九关的功能全部失效。把元数据也藏起来是另一个量级的问题（需要 sealed sender、混淆路由这类机制），不在这一关的范围里，但要清楚地知道边界在哪。',
      'Handing read cursors, receipts and fan-out to the client because the server cannot read content. Encryption protects content, not metadata — the server still knows who messaged whom and when, and who has read up to where, and it has to, or all nine previous stages stop working. Hiding metadata as well is a different order of problem, needing sealed sender and routing obfuscation, and is out of scope here; what matters is knowing exactly where the boundary is.'
    ),
  ],

  hints: [
    t(
      '棘轮用一张 `设备 id -> 下一个位置` 的表，封装前先加一。这样同一台设备的位置严格递增，而不同设备之间互不影响。',
      'Keep the ratchet as a map from device id to its next position and increment before sealing. Each device\'s positions then increase strictly while devices stay independent of each other.'
    ),
    t(
      '「后加入的设备解不开历史消息」不需要专门写代码去阻止 —— 封装发生在发送那一刻，那时这台设备还不存在，自然就没有它的信封。这个性质是结构自带的。',
      'Nothing has to be written to stop a later device from reading history — sealing happens at send time, when that device did not exist, so no envelope was ever made for it. The property comes from the structure.'
    ),
  ],

  extension: t(
    [
      'Signal 协议是这一关的完整版。它的两个核心组件：',
      '',
      '- **X3DH**（Extended Triple Diffie-Hellman）解决「对方不在线怎么协商密钥」——',
      '  设备提前把一批一次性预密钥传到服务器，发送方取一个就能单向建立会话，',
      '  收件人上线之后才真正参与。这解决的正是 IM 的异步性；',
      '- **Double Ratchet** 是这一关棘轮的完整版。它每条消息都换密钥，',
      '  并且是双向的：收到对方的消息也会推进棘轮。',
      '  这带来两个性质 —— **前向保密**（今天的密钥泄露解不开昨天的消息）',
      '  和**后向恢复**（泄露之后，只要有一次正常往返就能恢复安全）。',
      '',
      '群聊是另一个大问题。给 N 台设备各封一份在 N 很大时不可行，',
      '所以有 **Sender Keys**：每个发送者持有一把群密钥，只在成员变化时',
      '重新分发一次，平时一条消息只加密一次。代价是成员退群时必须换钥匙，',
      '否则退群的人还能解开后续消息 —— 这就是为什么大群退人有时会卡一下。',
      '',
      'MLS（RFC 9420）是 IETF 在 2023 年标准化的方案，用一棵二叉树把群密钥',
      '更新的代价从 O(N) 降到 O(log N)，目标就是让端到端加密能撑到几千人的群。',
      '',
      '最后，值得记住这一关最重要的那句话：**加密保护内容，不保护元数据**。',
      '「谁在凌晨三点给谁发了消息」这条信息，在这一关做完之后仍然完整地',
      '留在服务端 —— 而在很多场景下，它比内容更能说明问题。',
      'Signal 的 sealed sender 就是专门为了削弱这一点设计的。',
    ].join('\n'),
    [
      'The Signal protocol is the complete version of this stage, built from two pieces:',
      '',
      '- **X3DH** (Extended Triple Diffie-Hellman) answers "how do you agree on a key with someone who is',
      '  offline": devices upload a batch of one-time prekeys in advance, a sender takes one and',
      '  establishes the session unilaterally, and the recipient participates when they come back. That is',
      '  precisely the asynchrony problem IM has;',
      '- **The Double Ratchet** is the full version of the ratchet here. It changes keys every message and',
      '  runs both ways, advancing when messages are received too. That yields **forward secrecy** — a key',
      '  compromised today does not open yesterday\'s messages — and **post-compromise recovery**, where one',
      '  clean round trip restores security.',
      '',
      'Groups are the other hard problem. One envelope per device does not scale for large N, hence',
      '**Sender Keys**: each sender holds a group key redistributed only when membership changes, so an',
      'ordinary message is encrypted once. The price is that removing a member forces a key rotation, or',
      'they could still read what follows — which is why removing someone from a large group sometimes',
      'takes a moment.',
      '',
      'MLS (RFC 9420), standardised by the IETF in 2023, uses a binary tree to bring the cost of a group',
      'key update from O(N) down to O(log N), specifically so end-to-end encryption can reach groups of',
      'thousands.',
      '',
      'Finally, the sentence worth keeping from this stage: **encryption protects content, not metadata.**',
      '"Who messaged whom at three in the morning" survives everything built here, intact on the server —',
      'and in many situations it is more revealing than the content. Signal\'s sealed sender exists',
      'specifically to weaken that.',
    ].join('\n')
  ),

  focus: ['correctness', 'resilience', 'encapsulation'],
  lab: {},

  starterFiles: [
    file(
      'src/crypto/e2eeSession.ts',
      code`
        import type { DeviceKeyPair, KeyRing, SealedEnvelope } from '../support/crypto';
        import type { Store } from '../support/store';

        /** What the server is allowed to hold: one ciphertext per recipient device. */
        export interface SealedMessage {
          envelopes: Record<string, SealedEnvelope>;
        }

        export interface E2eeSession {
          /** A device comes online and publishes its public key. */
          register(userId: string, deviceId: string): DeviceKeyPair;
          devicesOf(userId: string): string[];
          /**
           * Seal one plaintext for every device that should be able to read it:
           * every device of every member, except the one that composed it.
           */
          sealFor(
            conversationId: string,
            senderId: string,
            senderDeviceId: string,
            plaintext: string
          ): SealedMessage;
          /** The envelope addressed to this device, or undefined if it is not a recipient. */
          envelopeFor(sealed: SealedMessage, deviceId: string): SealedEnvelope | undefined;
          open(keyPair: DeviceKeyPair, envelope: SealedEnvelope): string;
        }

        export function createE2eeSession(store: Store, keyRing: KeyRing): E2eeSession {
          // TODO: implement
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
        import { createSequencer } from '../src/conversation/sequence';
        import { createE2eeSession } from '../src/crypto/e2eeSession';
        import { createRegistry } from '../src/session/registry';
        import { createKeyRing } from '../src/support/crypto';
        import { createStore } from '../src/support/store';
        import { createTransport } from '../src/support/transport';

        const TEXT = 'meet me at the usual place';

        function makeWorld() {
          const store = createStore();
          const transport = createTransport();
          const registry = createRegistry(transport, { idleMs: 100000 });
          const keyRing = createKeyRing();
          const sequencer = createSequencer(store);
          const session = createE2eeSession(store, keyRing);
          return { store, transport, registry, keyRing, sequencer, session };
        }

        function conversation(world: any, id: string, members: string[]): void {
          world.store.putConversation({ conversationId: id, kind: 'group', members });
        }

        /** Register two devices for one person and return their key pairs. */
        function twoDevices(world: any, userId: string) {
          return {
            phone: world.session.register(userId, userId + '-phone'),
            laptop: world.session.register(userId, userId + '-laptop'),
          };
        }

        describe('阶段10 · 端到端加密与密钥协商', () => {
          it('注册之后能列出这个人的设备', () => {
            const world = makeWorld();
            twoDevices(world, 'alice');

            expect(world.session.devicesOf('alice')).toEqual(['alice-phone', 'alice-laptop']);
            expect(world.session.devicesOf('nobody')).toEqual([]);
          });

          it('给每台接收设备各封一份，写这条消息的那台除外', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            twoDevices(world, 'alice');
            twoDevices(world, 'bob');

            const sealed = world.session.sealFor('c1', 'alice', 'alice-phone', TEXT);

            expect(Object.keys(sealed.envelopes).sort()).toEqual([
              'alice-laptop',
              'bob-laptop',
              'bob-phone',
            ]);
          });

          it('收件设备能解开，明文一致', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            twoDevices(world, 'alice');
            const bob = twoDevices(world, 'bob');

            const sealed = world.session.sealFor('c1', 'alice', 'alice-phone', TEXT);
            const envelope = world.session.envelopeFor(sealed, 'bob-phone');

            expect(world.session.open(bob.phone, envelope)).toBe(TEXT);
          });

          it('自己的另一台设备也能解开', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const alice = twoDevices(world, 'alice');
            twoDevices(world, 'bob');

            const sealed = world.session.sealFor('c1', 'alice', 'alice-phone', TEXT);
            const envelope = world.session.envelopeFor(sealed, 'alice-laptop');

            expect(world.session.open(alice.laptop, envelope)).toBe(TEXT);
            expect(world.session.envelopeFor(sealed, 'alice-phone')).toBeUndefined();
          });

          it('不是收件人的设备拿不到信封', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            twoDevices(world, 'alice');
            twoDevices(world, 'bob');
            world.session.register('mallory', 'mallory-phone');

            const sealed = world.session.sealFor('c1', 'alice', 'alice-phone', TEXT);

            expect(world.session.envelopeFor(sealed, 'mallory-phone')).toBeUndefined();
          });

          it('拿别人的信封打不开', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            twoDevices(world, 'alice');
            twoDevices(world, 'bob');
            const mallory = world.session.register('mallory', 'mallory-phone');

            const sealed = world.session.sealFor('c1', 'alice', 'alice-phone', TEXT);
            const notHers = world.session.envelopeFor(sealed, 'bob-phone');

            expect(() => world.session.open(mallory, notHers)).toThrow();
          });

          it('推到线上的每一帧都是密文 [gate:wire]', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            twoDevices(world, 'alice');
            const bob = twoDevices(world, 'bob');
            const bobPhoneConn = world.registry.attach('bob', 'bob-phone');
            const bobLaptopConn = world.registry.attach('bob', 'bob-laptop');

            const result = world.sequencer.send({
              conversationId: 'c1',
              senderId: 'alice',
              clientMsgId: 'm1',
              payload: world.session.sealFor('c1', 'alice', 'alice-phone', TEXT),
              sentAt: 0,
            });
            const stored = world.store.readMessages('c1', 0, 1)[0];

            // 服务端只能挑出这台设备的那一份推过去
            for (const entry of [
              { connectionId: bobPhoneConn, deviceId: 'bob-phone' },
              { connectionId: bobLaptopConn, deviceId: 'bob-laptop' },
            ]) {
              const envelope = world.session.envelopeFor(stored.payload, entry.deviceId);
              world.transport.push(entry.connectionId, {
                kind: 'message',
                conversationId: 'c1',
                seq: result.seq,
                payload: envelope,
              });
            }

            const frame = world.transport.inbox(bobPhoneConn)[0];
            expect(world.session.open(bob.phone, frame.payload)).toBe(TEXT);
            expect(JSON.stringify(frame.payload)).not.toContain('usual place');
          });

          it('三个成员六台设备，一条消息恰好封五次 [gate:seal]', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob', 'carol']);
            twoDevices(world, 'alice');
            twoDevices(world, 'bob');
            twoDevices(world, 'carol');

            const sealed = world.session.sealFor('c1', 'alice', 'alice-phone', TEXT);

            expect(Object.keys(sealed.envelopes)).toHaveLength(5);
          });

          it('棘轮位置每次前进，同一台设备不复用', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            twoDevices(world, 'alice');
            twoDevices(world, 'bob');

            const first = world.session.sealFor('c1', 'alice', 'alice-phone', 'one');
            const second = world.session.sealFor('c1', 'alice', 'alice-phone', 'two');

            expect(second.envelopes['bob-phone'].counter).toBeGreaterThan(
              first.envelopes['bob-phone'].counter
            );
          });

          it('同样的明文封两次，密文不一样', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            twoDevices(world, 'alice');
            twoDevices(world, 'bob');

            const first = world.session.sealFor('c1', 'alice', 'alice-phone', TEXT);
            const second = world.session.sealFor('c1', 'alice', 'alice-phone', TEXT);

            expect(second.envelopes['bob-phone'].ciphertext).not.toBe(
              first.envelopes['bob-phone'].ciphertext
            );
          });

          it('后加入的设备解不开之前的消息', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            twoDevices(world, 'alice');
            world.session.register('bob', 'bob-phone');

            const sealed = world.session.sealFor('c1', 'alice', 'alice-phone', TEXT);
            world.session.register('bob', 'bob-tablet');

            expect(world.session.envelopeFor(sealed, 'bob-tablet')).toBeUndefined();
            expect(world.session.envelopeFor(sealed, 'bob-phone')).toBeDefined();
          });

          it('一台设备都没注册的成员不产生信封', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob', 'ghost']);
            twoDevices(world, 'alice');
            world.session.register('bob', 'bob-phone');

            const sealed = world.session.sealFor('c1', 'alice', 'alice-phone', TEXT);

            expect(Object.keys(sealed.envelopes).sort()).toEqual(['alice-laptop', 'bob-phone']);
          });

          it('不存在的会话封不出任何东西', () => {
            const world = makeWorld();
            twoDevices(world, 'alice');

            expect(world.session.sealFor('nope', 'alice', 'alice-phone', TEXT).envelopes).toEqual({});
          });

          it('服务端仍然能做元数据的事', () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            twoDevices(world, 'alice');
            twoDevices(world, 'bob');

            const result = world.sequencer.send({
              conversationId: 'c1',
              senderId: 'alice',
              clientMsgId: 'm1',
              payload: world.session.sealFor('c1', 'alice', 'alice-phone', TEXT),
              sentAt: 7,
            });

            // 序号、发送者、时间戳都还在，只有内容读不懂
            const stored = world.store.readMessages('c1', 0, 1)[0];
            expect(result.seq).toBe(1);
            expect(stored.senderId).toBe('alice');
            expect(stored.sentAt).toBe(7);
            expect(world.store.messageCount('c1')).toBe(1);
          });
        });
      `
    ),
  ],

  gates: [
    gate({
      metric: 'counters.plaintextOnWire',
      op: 'eq',
      value: 0,
      zh: '线上没有出现过一次明文消息帧',
      en: 'Not one plaintext message frame reached the wire',
      dimension: 'correctness',
    }),
    gate({
      metric: 'counters.sealOperations',
      op: 'lte',
      value: 5,
      zh: '六台设备的群里一条消息恰好封五次',
      en: 'One message among six devices costs exactly five seals',
      dimension: 'latency',
      scope: 'gate:seal',
    }),
    gate({
      metric: 'counters.keyReuse',
      op: 'eq',
      value: 0,
      zh: '棘轮位置一次都没有复用',
      en: 'No ratchet position was ever reused',
      dimension: 'resilience',
    }),
  ],

  referenceFiles: [
    file(
      'src/crypto/e2eeSession.ts',
      code`
        import type { DeviceKeyPair, KeyRing, SealedEnvelope } from '../support/crypto';
        import type { Store } from '../support/store';

        export interface SealedMessage {
          envelopes: Record<string, SealedEnvelope>;
        }

        export interface E2eeSession {
          register(userId: string, deviceId: string): DeviceKeyPair;
          devicesOf(userId: string): string[];
          sealFor(
            conversationId: string,
            senderId: string,
            senderDeviceId: string,
            plaintext: string
          ): SealedMessage;
          envelopeFor(sealed: SealedMessage, deviceId: string): SealedEnvelope | undefined;
          open(keyPair: DeviceKeyPair, envelope: SealedEnvelope): string;
        }

        export function createE2eeSession(store: Store, keyRing: KeyRing): E2eeSession {
          /** user id -> the devices that published a key, in registration order */
          const devices = new Map<string, string[]>();
          /** device id -> the next ratchet position to use for it */
          const ratchet = new Map<string, number>();

          function nextPosition(deviceId: string): number {
            const next = (ratchet.get(deviceId) || 0) + 1;
            ratchet.set(deviceId, next);
            return next;
          }

          return {
            register(userId: string, deviceId: string): DeviceKeyPair {
              const owned = devices.get(userId) || [];
              if (owned.indexOf(deviceId) < 0) devices.set(userId, [...owned, deviceId]);
              return keyRing.register(deviceId);
            },

            devicesOf(userId: string): string[] {
              return [...(devices.get(userId) || [])];
            },

            sealFor(
              conversationId: string,
              senderId: string,
              senderDeviceId: string,
              plaintext: string
            ): SealedMessage {
              const envelopes: Record<string, SealedEnvelope> = {};
              const meta = store.getConversation(conversationId);
              if (!meta) return { envelopes };

              // The inner loop is over devices. Looping over people instead would force
              // one person's devices to share a key, and revoking one would rotate all.
              for (const member of meta.members) {
                for (const deviceId of devices.get(member) || []) {
                  // The composing device already holds the plaintext
                  if (deviceId === senderDeviceId) continue;
                  if (!keyRing.publicKeyOf(deviceId)) continue;
                  envelopes[deviceId] = keyRing.seal(deviceId, plaintext, nextPosition(deviceId));
                }
              }

              return { envelopes };
            },

            envelopeFor(sealed: SealedMessage, deviceId: string): SealedEnvelope | undefined {
              return sealed.envelopes[deviceId];
            },

            open(keyPair: DeviceKeyPair, envelope: SealedEnvelope): string {
              return keyRing.open(keyPair, envelope);
            },
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 11 关 · 推送与唤醒                                                 */
/* ------------------------------------------------------------------ */

const stage11 = {
  id: 'push-wakeup',
  title: t('第 11 关 · 推送与唤醒', 'Stage 11 · Waking a sleeping device'),
  goal: t(
    [
      '到这里，所有功能都建立在「设备连着」这个前提上。而手机大部分时间',
      '**并没有连着** —— 屏幕一黑，系统就会把长连接掐掉，省电。',
      '',
      '要让消息在这时候还能到达，只剩一条路：走系统推送（APNs / FCM）。',
      '而这条路有两个前九关都没有的约束：',
      '',
      '- **它出你的系统了。** 通知内容会经过苹果或者谷歌的服务器，',
      '  会被渲染在一块你不控制的锁屏上。第 10 关刚把内容加密，',
      '  在这里把它明文塞进通知，前面白做。所以通知里只能有',
      '  **去哪看**（会话 id）和**几条没读**（角标），没有内容；',
      '- **它按次数计费，也按次数打扰人。** 一个群早上刷了 200 条，',
      '  推 200 条通知的结果是用户关掉这个群的通知 —— 甚至关掉整个 App 的。',
      '',
      '所以推送的核心不是「怎么发」，是**怎么少发**。',
      '',
      '## 要实现什么',
      '',
      '在 `src/push/notifier.ts` 实现 `createNotifier(...)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `enrol(userId, deviceId)` | 设备注册接收推送，返回它的 token |',
      '| `withdraw(deviceId)` | 退出登录或卸载，不再推 |',
      '| `onMessage(conversationId, seq, senderId)` | 一条新消息，安排唤醒该唤醒的设备 |',
      '| `pending()` | 还有几台设备在等这一轮 |',
      '',
      '合并规则：第一条消息到达时开一个 `coalesceMs` 的窗口，',
      '窗口内后来的消息**不再另开窗口**；窗口到点，每台该唤醒的设备**推一条**，',
      '带的是最近那个会话的 id 和当前的未读总数。',
      '',
      '谁该被唤醒：会话成员里，**没有活连接**的那些设备。',
      '在线的设备已经通过第 4 关的推送拿到了，发送者自己的设备也不该被打扰。',
      '',
      '## 怎么算过',
      '',
      '- 三轮各 50 条消息，一共**最多 3 条通知**',
      '  （门槛 `counters.pushNotifications ≤ 3`）；',
      '- 通知里除了 `conversationId` / `badge` / `reason` 没有别的东西',
      '  （门槛 `counters.pushLeakedContent = 0`，网关会检查字段）；',
      '- 角标来自第 5 关的未读总数，不是自己数的；',
      '- 窗口期间设备重新连上来了，就不再唤醒它。',
      '',
      '## 那个坑',
      '',
      '把消息预览放进通知里。',
      '',
      '这是产品同学一定会提的需求，因为锁屏上只显示「你有一条新消息」',
      '确实难用。但在端到端加密的系统里**服务端根本没有明文** ——',
      '它想放也放不进去。',
      '',
      '真实产品的做法是：通知只带路由信息，客户端收到之后被系统唤醒，',
      '在**本地**解密并重写通知内容（iOS 的 Notification Service Extension',
      '就是干这个的）。所以锁屏上那句预览是**你自己的手机**写上去的，',
      '不是服务器发过来的。',
      '',
      '这个约束不是加密带来的额外负担，它反过来说明了一件事：',
      '**通知是一个唤醒信号，不是一个消息通道**。',
      '把它当消息通道用，除了泄露内容，还会撞上它本来就不保证送达这个事实。',
    ].join('\n'),
    [
      'Everything so far assumes the device is connected. A phone mostly **is not** — the screen goes dark',
      'and the operating system tears the long-lived connection down to save power.',
      '',
      'The only way to reach it then is the platform push service, APNs or FCM, and that path has two',
      'constraints none of the previous nine stages had:',
      '',
      '- **It leaves your system.** The notification passes through Apple\'s or Google\'s servers and is',
      '  rendered on a lock screen you do not control. Stage 10 just encrypted the content; putting it in',
      '  plaintext here undoes that. A notification may carry **where to look** — a conversation id — and',
      '  **how many are unread** — a badge. Not content;',
      '- **It costs per send, and it interrupts a person per send.** Two hundred messages in a group before',
      '  breakfast, sent as two hundred notifications, ends with the group muted. Possibly the app.',
      '',
      'So the central question is not how to send. It is **how to send less.**',
      '',
      '## What to build',
      '',
      'Implement `createNotifier(...)` in `src/push/notifier.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `enrol(userId, deviceId)` | Register a device for wake-ups; return its token |',
      '| `withdraw(deviceId)` | Signed out or uninstalled; stop pushing |',
      '| `onMessage(conversationId, seq, senderId)` | Arrange to wake whoever needs waking |',
      '| `pending()` | How many devices are waiting for this round |',
      '',
      'The coalescing rule: the first message opens a `coalesceMs` window, later messages inside it do',
      '**not** open another, and when it closes each device that needs waking gets **one** notification',
      'carrying the most recent conversation id and the current unread total.',
      '',
      'Who needs waking: members of the conversation whose devices have **no live connection**. Connected',
      'devices already received it through stage 4, and the sender\'s own devices should not be disturbed.',
      '',
      '## What counts as passing',
      '',
      '- Three rounds of fifty messages cost **at most three notifications**',
      '  (the `counters.pushNotifications ≤ 3` gate);',
      '- A notification carries nothing besides `conversationId`, `badge` and `reason`',
      '  (the `counters.pushLeakedContent = 0` gate, checked field by field by the gateway);',
      '- The badge comes from stage 5\'s unread total rather than being counted again here;',
      '- A device that reconnects during the window is not woken.',
      '',
      '## The trap',
      '',
      'Putting a message preview in the notification.',
      '',
      'Product will ask for it, because "you have a new message" on a lock screen is genuinely poor. But in',
      'an end-to-end encrypted system **the server has no plaintext** — it could not comply if it wanted',
      'to.',
      '',
      'What real products do: the notification carries routing only, the client is woken by the system,',
      'decrypts **locally** and rewrites the notification body. That is what an iOS Notification Service',
      'Extension is for. The preview on the lock screen was written by **your own phone**, not sent by the',
      'server.',
      '',
      'This constraint is not overhead imposed by encryption. It makes a point that was always true:',
      '**a notification is a wake-up signal, not a message channel.** Used as a channel it leaks content,',
      'and it collides with the fact that it was never guaranteed to arrive in the first place.',
    ].join('\n')
  ),

  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  M["onMessage(会话, seq, 发送人)"] --> MEM["store.getConversation(会话).members"]',
      '  MEM --> SKIPSELF["去掉发送人自己"]',
      '  SKIPSELF --> DEV["每个成员注册过的每一台设备"]',
      '  DEV --> LIVE{"这台设备有活连接吗？"}',
      '  LIVE -- 有 --> NOP["不推<br/>第 4 关已经把消息送过去了"]',
      '  LIVE -- 没有 --> Q["排进待唤醒表<br/>键是设备，值覆盖成最近这个会话"]',
      '  Q --> ARM{"窗口已经开着了？"}',
      '  ARM -- 开着 --> WAIT["什么都不做<br/>合并就发生在这里"]',
      '  ARM -- 没开 --> TIMER["setTimeout(coalesceMs)"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  T["窗口到点"] --> EACH["待唤醒表里的每一台设备"]',
      '  EACH --> BACK{"这会儿又连上了？"}',
      '  BACK -- 连上了 --> DROP["不推"]',
      '  BACK -- 还没有 --> BADGE["badge = readCursors.summary(这个人).total"]',
      '  BADGE --> SEND["gateway.send(token, 会话 id + 角标 + 原因)<br/>没有内容，服务端也拿不到内容"]',
      '  SEND --> CLR["清空待唤醒表"]',
      '```',
      '',
      '要点：`Q` 用**设备**做键。用消息做键就是一条消息一条通知，',
      '合并根本没发生 —— 而这正是最容易写成的样子。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  M["onMessage(conversation, seq, sender)"] --> MEM["store.getConversation(...).members"]',
      '  MEM --> SKIPSELF["drop the sender"]',
      '  SKIPSELF --> DEV["every enrolled device of every member"]',
      '  DEV --> LIVE{"does this device have a live connection?"}',
      '  LIVE -- yes --> NOP["do not push<br/>stage 4 already delivered it"]',
      '  LIVE -- no --> Q["queue it, keyed by device<br/>the value becomes the newest conversation"]',
      '  Q --> ARM{"is a window already open?"}',
      '  ARM -- yes --> WAIT["do nothing<br/>this is where coalescing happens"]',
      '  ARM -- no --> TIMER["setTimeout(coalesceMs)"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  T["the window closes"] --> EACH["for each queued device"]',
      '  EACH --> BACK{"has it reconnected in the meantime?"}',
      '  BACK -- yes --> DROP["do not push"]',
      '  BACK -- no --> BADGE["badge = readCursors.summary(person).total"]',
      '  BADGE --> SEND["gateway.send(token, conversation id + badge + reason)<br/>no content, and the server has none anyway"]',
      '  SEND --> CLR["clear the queue"]',
      '```',
      '',
      'The point: the queue is keyed by **device**. Key it by message and you get one notification per',
      'message with no coalescing at all — which is exactly what it turns into if you are not deliberate.',
    ].join('\n')
  ),

  checklist: [
    t('待唤醒表按设备去重，不按消息', 'The queue is deduplicated by device, not by message'),
    t('窗口只开一次，窗口内不再另开', 'One window at a time, never a second inside it'),
    t('在线设备和发送者自己的设备不推', 'Connected devices and the sender\'s own devices get nothing'),
    t('通知只带会话 id、角标和原因', 'A notification carries conversation id, badge and reason only'),
    t('角标复用第 5 关的未读总数', 'The badge reuses stage 5\'s unread total'),
  ],

  pitfalls: [
    t(
      '把消息预览塞进通知。在端到端加密之后服务端根本没有明文，想放也放不进去；即使没有加密，通知也会经过苹果或谷歌的服务器并渲染在一块你不控制的屏幕上。真实做法是通知只带路由，客户端被唤醒之后在本地解密并重写通知内容 —— 锁屏上那句预览是手机自己写的。',
      'Putting a message preview into the notification. After stage 10 the server has no plaintext to put there; even without encryption the notification passes through Apple or Google and renders on a screen you do not control. The real approach is routing-only, with the woken client decrypting locally and rewriting the body — the preview on the lock screen was written by the phone.'
    ),
    t(
      '一条消息推一条通知。一个活跃群一早上两百条，用户会先静音这个群，再静音这个 App，然后就再也收不到真正重要的那条了。推送的成本不只是钱，是**用户的注意力配额**，而这个配额一旦花光就要不回来。合并窗口不是优化，是这个功能能不能长期存在的前提。',
      'One notification per message. Two hundred messages in an active group before lunch and the user mutes the group, then the app, and then misses the one that mattered. The cost of a push is not only money but the user\'s **attention budget**, and that budget does not refill once spent. The coalescing window is not an optimisation, it is the condition for the feature surviving at all.'
    ),
    t(
      '窗口到点时不再检查设备是否已经连回来。用户在窗口期间打开了 App，消息已经通过长连接到了眼前，几百毫秒之后手机又震了一下 —— 通知栏里躺着一条他刚刚读过的消息。这个体验非常廉价地就能避免：发之前再问一次连接状态。',
      'Not rechecking connectivity when the window closes. The user opened the app during the window, the message arrived over the live connection and is on screen, and half a second later the phone buzzes about a message they just read. Avoiding it is nearly free: ask about the connection once more before sending.'
    ),
    t(
      '在推送里自己数一遍未读。角标必须和 App 里显示的未读数一致，否则用户会看到「角标 3，点进去没有」—— 第 5 关专门讲过这个数为什么必须是推导出来的。推送这条路径再数一遍，就等于凭空多出了第二个真相来源，而它迟早和第一个不一致。',
      'Counting unread again inside the notifier. The badge has to agree with what the app shows, or the user gets "badge says three, nothing inside" — the bug stage 5 exists to prevent. Counting it a second time on the push path creates a second source of truth, and eventually the two disagree.'
    ),
  ],

  hints: [
    t(
      '待唤醒表用 `Map<设备 id, 会话 id>`：同一台设备在窗口内被排队多次，只会覆盖成最近那个会话，天然就完成了合并。',
      'Use a `Map` from device id to conversation id: a device queued several times inside the window simply overwrites with the newest conversation, and the coalescing falls out.'
    ),
    t(
      '判断「这台设备有没有活连接」= `registry.connectionsOf(userId)` 里有没有一条 `transport.deviceOf(...)` 等于它。这个判断在排队时和真正发送前各要做一次。',
      '"Does this device have a live connection" is whether any of `registry.connectionsOf(userId)` has `transport.deviceOf(...)` equal to it. Ask once when queueing and once more before sending.'
    ),
  ],

  extension: t(
    [
      '推送这条路径有一个和系统内其他部分完全不同的性质：**它不保证送达**。',
      'APNs 和 FCM 都明确说明通知可能被丢弃 —— 设备长时间离线、',
      '同一个 App 堆积过多、系统判定为低优先级，都会丢。',
      '',
      '所以推送**不能**作为消息通道，它只能是一个「你该来看看了」的提示。',
      '真正保证不丢的是第 3 关的增量拉取：设备一旦连上来，',
      '不管收到过几条通知，都会按位点把欠的补齐。',
      '这两条路径的分工是 IM 里一个很关键的设计：',
      '**推送负责及时性，拉取负责完整性**。',
      '',
      '几个真实系统里的细节：',
      '',
      '- **静默推送**（content-available）用来在不打扰用户的前提下唤醒 App',
      '  去拉取，iOS 对它的频率限制很严，而且会根据用户使用习惯动态调整；',
      '- **优先级**：APNs 的 priority 10 是立即送达，priority 5 会被系统攒着批量送。',
      '  聊天消息用 10，回执、在线状态这些用 5 或者干脆不推；',
      '- **通知的折叠**：APNs 的 `apns-collapse-id` 让新通知替换掉同一个 id 的旧通知，',
      '  这是这一关合并窗口的客户端侧对应物 —— 服务端合并窗口内的，',
      '  客户端折叠窗口之间的；',
      '- **免打扰和时区**：企业 IM 通常要按接收方的工作时间抑制推送，',
      '  而「接收方的时区」是个比想象中麻烦得多的字段。',
      '',
      '最后，角标这个数在 iOS 上是由服务端下发的（`badge` 字段直接设定），',
      '而在 Android 上通常由客户端自己算。这就是为什么',
      '「未读数必须是推导出来的」在这一关又一次变得重要：',
      '两个平台从两条路径算同一个数，只有当它可推导时才可能一致。',
    ].join('\n'),
    [
      'This path has a property nothing else in the system has: **it does not guarantee delivery.** Both',
      'APNs and FCM state plainly that notifications may be dropped — a device offline too long, too many',
      'queued for one app, a system decision that it is low priority.',
      '',
      'So push **cannot** be a message channel. It is a "you should come and look" hint. What guarantees',
      'nothing is lost is stage 3\'s incremental pull: once a device connects it reconciles against its',
      'cursor regardless of how many notifications it did or did not receive. The division of labour',
      'between the two is one of the important design decisions in this domain: **push provides timeliness,',
      'pull provides completeness.**',
      '',
      'A few details from production systems:',
      '',
      '- **Silent pushes** (content-available) wake the app to fetch without disturbing anyone; iOS rate',
      '  limits them tightly and adapts the limit to how the person uses the app;',
      '- **Priority**: APNs priority 10 is immediate, priority 5 is batched by the system. Chat messages',
      '  use 10, while receipts and presence use 5 or are not pushed at all;',
      '- **Collapsing**: `apns-collapse-id` lets a new notification replace an older one with the same id,',
      '  the client-side counterpart of the window here — the server coalesces within a window, the client',
      '  collapses across them;',
      '- **Quiet hours and time zones**: enterprise IM usually suppresses pushes outside the recipient\'s',
      '  working hours, and "the recipient\'s time zone" is a far more troublesome field than it sounds.',
      '',
      'Finally, the badge number is set by the server on iOS through the `badge` field, while Android',
      'clients typically compute it themselves. Which is why "unread has to be derived" matters again here:',
      'two platforms compute the same number by two routes, and they can only agree if it is derivable.',
    ].join('\n')
  ),

  focus: ['latency', 'resilience', 'encapsulation'],
  lab: {},

  starterFiles: [
    file(
      'src/push/notifier.ts',
      code`
        import type { ReadCursors } from '../conversation/readCursor';
        import type { ConnectionRegistry } from '../session/registry';
        import type { PushGateway } from '../support/push';
        import type { Store } from '../support/store';
        import type { Transport } from '../support/transport';

        export interface NotifierOptions {
          /** Messages arriving inside this window collapse into one notification */
          coalesceMs: number;
        }

        export interface Notifier {
          /** A device registers for wake-ups. Returns its push token. */
          enrol(userId: string, deviceId: string): string;
          /** Signed out or uninstalled: stop waking this device. */
          withdraw(deviceId: string): void;
          /** A message landed. Arrange to wake the devices that need it. */
          onMessage(conversationId: string, seq: number, senderId: string): void;
          /** How many devices are waiting for the current window to close. */
          pending(): number;
        }

        export function createNotifier(
          store: Store,
          transport: Transport,
          registry: ConnectionRegistry,
          readCursors: ReadCursors,
          gateway: PushGateway,
          options: NotifierOptions
        ): Notifier {
          // TODO: implement
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
        import { createReadCursors } from '../src/conversation/readCursor';
        import { createSequencer } from '../src/conversation/sequence';
        import { createNotifier } from '../src/push/notifier';
        import { createRegistry } from '../src/session/registry';
        import { createPushGateway } from '../src/support/push';
        import { createStore } from '../src/support/store';
        import { createTransport } from '../src/support/transport';
        import { sleep } from '@lab/env';

        const COALESCE_MS = 1000;
        const SECRET = 'the quick brown fox jumped';

        function makeWorld(coalesceMs = COALESCE_MS) {
          const store = createStore();
          const transport = createTransport();
          const registry = createRegistry(transport, { idleMs: 100000 });
          const readCursors = createReadCursors(store);
          const sequencer = createSequencer(store);
          const gateway = createPushGateway();
          const notifier = createNotifier(store, transport, registry, readCursors, gateway, {
            coalesceMs,
          });
          return { store, transport, registry, readCursors, sequencer, gateway, notifier };
        }

        function conversation(world: any, id: string, members: string[]): void {
          world.store.putConversation({ conversationId: id, kind: 'group', members });
        }

        /** Send one message and hand it to the notifier, the way the server would. */
        function post(world: any, conversationId: string, sender: string, text = SECRET): void {
          const nth = world.store.messageCount(conversationId) + 1;
          const result = world.sequencer.send({
            conversationId,
            senderId: sender,
            clientMsgId: conversationId + '-m' + nth,
            payload: text,
            sentAt: nth,
          });
          world.notifier.onMessage(conversationId, result.seq, sender);
        }

        describe('阶段11 · 推送与唤醒', () => {
          it('离线设备会被唤醒', async () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const token = world.notifier.enrol('bob', 'bob-phone');

            post(world, 'c1', 'alice');
            await sleep(COALESCE_MS);

            const delivered = world.gateway.delivered(token);
            expect(delivered).toHaveLength(1);
            expect(delivered[0].conversationId).toBe('c1');
          });

          it('在线设备不会被唤醒', async () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const token = world.notifier.enrol('bob', 'bob-phone');
            world.registry.attach('bob', 'bob-phone');

            post(world, 'c1', 'alice');
            await sleep(COALESCE_MS);

            expect(world.gateway.delivered(token)).toEqual([]);
          });

          it('发送者自己的设备不会被唤醒', async () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const aliceToken = world.notifier.enrol('alice', 'alice-laptop');
            const bobToken = world.notifier.enrol('bob', 'bob-phone');

            post(world, 'c1', 'alice');
            await sleep(COALESCE_MS);

            expect(world.gateway.delivered(aliceToken)).toEqual([]);
            expect(world.gateway.delivered(bobToken)).toHaveLength(1);
          });

          it('窗口内的一批消息合并成一条通知 [gate:burst]', async () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const token = world.notifier.enrol('bob', 'bob-phone');

            for (let round = 1; round <= 3; round += 1) {
              for (let index = 1; index <= 50; index += 1) post(world, 'c1', 'alice');
              await sleep(COALESCE_MS);
            }

            expect(world.gateway.delivered(token)).toHaveLength(3);
          });

          it('通知里没有消息内容', async () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const token = world.notifier.enrol('bob', 'bob-phone');

            post(world, 'c1', 'alice');
            await sleep(COALESCE_MS);

            const notification = world.gateway.delivered(token)[0];
            expect(Object.keys(notification).sort()).toEqual(['badge', 'conversationId', 'reason']);
            expect(JSON.stringify(notification)).not.toContain('brown fox');
          });

          it('角标是第 5 关算出来的未读总数', async () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            conversation(world, 'c2', ['carol', 'bob']);
            const token = world.notifier.enrol('bob', 'bob-phone');

            for (let index = 1; index <= 4; index += 1) post(world, 'c1', 'alice');
            for (let index = 1; index <= 3; index += 1) post(world, 'c2', 'carol');
            await sleep(COALESCE_MS);

            expect(world.gateway.delivered(token)[0].badge).toBe(7);
            expect(world.readCursors.summary('bob').total).toBe(7);
          });

          it('通知带的是最近那个会话', async () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            conversation(world, 'c2', ['carol', 'bob']);
            const token = world.notifier.enrol('bob', 'bob-phone');

            post(world, 'c1', 'alice');
            post(world, 'c2', 'carol');
            await sleep(COALESCE_MS);

            const delivered = world.gateway.delivered(token);
            expect(delivered).toHaveLength(1);
            expect(delivered[0].conversationId).toBe('c2');
          });

          it('窗口期间连回来的设备不再被唤醒', async () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const token = world.notifier.enrol('bob', 'bob-phone');

            post(world, 'c1', 'alice');
            world.registry.attach('bob', 'bob-phone');
            await sleep(COALESCE_MS);

            expect(world.gateway.delivered(token)).toEqual([]);
          });

          it('一个人的两台离线设备各收到一条', async () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const phone = world.notifier.enrol('bob', 'bob-phone');
            const tablet = world.notifier.enrol('bob', 'bob-tablet');

            post(world, 'c1', 'alice');
            await sleep(COALESCE_MS);

            expect(world.gateway.delivered(phone)).toHaveLength(1);
            expect(world.gateway.delivered(tablet)).toHaveLength(1);
          });

          it('没注册过的设备不会被推', async () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);

            post(world, 'c1', 'alice');
            await sleep(COALESCE_MS);

            expect(world.notifier.pending()).toBe(0);
          });

          it('withdraw 之后不再被推', async () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const token = world.notifier.enrol('bob', 'bob-phone');
            world.notifier.withdraw('bob-phone');

            post(world, 'c1', 'alice');
            await sleep(COALESCE_MS);

            expect(world.gateway.delivered(token)).toEqual([]);
          });

          it('不是会话成员的人不会被唤醒', async () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const outsider = world.notifier.enrol('mallory', 'mallory-phone');

            post(world, 'c1', 'alice');
            await sleep(COALESCE_MS);

            expect(world.gateway.delivered(outsider)).toEqual([]);
          });

          it('pending 反映还在等窗口的设备数', async () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob', 'carol']);
            world.notifier.enrol('bob', 'bob-phone');
            world.notifier.enrol('carol', 'carol-phone');

            post(world, 'c1', 'alice');
            expect(world.notifier.pending()).toBe(2);

            await sleep(COALESCE_MS);
            expect(world.notifier.pending()).toBe(0);
          });

          it('窗口关掉之后新的一批会另开一个窗口', async () => {
            const world = makeWorld();
            conversation(world, 'c1', ['alice', 'bob']);
            const token = world.notifier.enrol('bob', 'bob-phone');

            post(world, 'c1', 'alice');
            await sleep(COALESCE_MS);
            expect(world.gateway.delivered(token)).toHaveLength(1);

            post(world, 'c1', 'alice');
            await sleep(COALESCE_MS);
            expect(world.gateway.delivered(token)).toHaveLength(2);
          });
        });
      `
    ),
  ],

  gates: [
    gate({
      metric: 'counters.pushNotifications',
      op: 'lte',
      value: 3,
      zh: '三轮共一百五十条消息最多推三条通知',
      en: 'Three rounds of 150 messages cost at most three notifications',
      dimension: 'latency',
      scope: 'gate:burst',
    }),
    gate({
      metric: 'counters.pushLeakedContent',
      op: 'eq',
      value: 0,
      zh: '通知里一次都没有夹带内容',
      en: 'No notification ever carried content',
      dimension: 'correctness',
    }),
  ],

  referenceFiles: [
    file(
      'src/push/notifier.ts',
      code`
        import type { ReadCursors } from '../conversation/readCursor';
        import type { ConnectionRegistry } from '../session/registry';
        import type { PushGateway } from '../support/push';
        import type { Store } from '../support/store';
        import type { Transport } from '../support/transport';

        export interface NotifierOptions {
          coalesceMs: number;
        }

        export interface Notifier {
          enrol(userId: string, deviceId: string): string;
          withdraw(deviceId: string): void;
          onMessage(conversationId: string, seq: number, senderId: string): void;
          pending(): number;
        }

        interface Enrolment {
          userId: string;
          token: string;
        }

        export function createNotifier(
          store: Store,
          transport: Transport,
          registry: ConnectionRegistry,
          readCursors: ReadCursors,
          gateway: PushGateway,
          options: NotifierOptions
        ): Notifier {
          const enrolments = new Map<string, Enrolment>();
          /**
           * Keyed by device, so a burst of fifty messages leaves one entry.
           * Keyed by message it would be fifty notifications, which is the whole bug.
           */
          const waiting = new Map<string, string>();
          let windowOpen = false;

          function connected(userId: string, deviceId: string): boolean {
            return registry
              .connectionsOf(userId)
              .some((connectionId) => transport.deviceOf(connectionId) === deviceId);
          }

          function closeWindow(): void {
            windowOpen = false;

            for (const entry of Array.from(waiting.entries())) {
              const enrolment = enrolments.get(entry[0]);
              if (!enrolment) continue;
              // It may have come back while the window was open, in which case it
              // already has the message and a buzz would be about something just read.
              if (connected(enrolment.userId, entry[0])) continue;

              gateway.send(enrolment.token, {
                conversationId: entry[1],
                badge: readCursors.summary(enrolment.userId).total,
                reason: 'message',
              });
            }

            waiting.clear();
          }

          return {
            enrol(userId: string, deviceId: string): string {
              const token = gateway.register(deviceId);
              enrolments.set(deviceId, { userId, token });
              return token;
            },

            withdraw(deviceId: string): void {
              enrolments.delete(deviceId);
              waiting.delete(deviceId);
            },

            onMessage(conversationId: string, seq: number, senderId: string): void {
              const meta = store.getConversation(conversationId);
              if (!meta) return;

              for (const entry of Array.from(enrolments.entries())) {
                const deviceId = entry[0];
                const enrolment = entry[1];
                if (enrolment.userId === senderId) continue;
                if (meta.members.indexOf(enrolment.userId) < 0) continue;
                if (connected(enrolment.userId, deviceId)) continue;
                waiting.set(deviceId, conversationId);
              }

              if (waiting.size === 0 || windowOpen) return;
              windowOpen = true;
              setTimeout(closeWindow, options.coalesceMs);
            },

            pending(): number {
              return waiting.size;
            },
          };
        }
      `
    ),
  ],
};

/* ------------------------------------------------------------------ */
/* 第 12 关 · 接成一台服务器                                             */
/* ------------------------------------------------------------------ */

const stage12 = {
  id: 'im-server-e2e',
  title: t('第 12 关 · 组装：一台 IM 服务器', 'Stage 12 · Assembly: one IM server'),
  goal: t(
    [
      '十一个模块，一个入口。这一关把它们接成一台服务器，',
      '并且回答那个每次打开 App 都要回答一遍的问题：**会话列表长什么样**。',
      '',
      '## 会话列表是这个产品最贵的一次查询',
      '',
      '它一屏要显示十几行，每行要有：最后一条消息、时间、未读数、',
      '对方在不在线、自己发的那条对方读了没有。五种信息来自五个模块，',
      '而这个查询在每次切前台、每次收到推送、每次下拉刷新时都要跑一遍。',
      '',
      '所以它的代价必须**有上限**，而且上限只能和「显示几行」有关，',
      '不能和「这个人在多少个会话里」有关。',
      '',
      '## 加密改变了投递这一步',
      '',
      '第 4 关的 `publish` 是在加密之前写的：它把消息的 payload 原样推给每台设备。',
      '第 10 关之后 payload 变成了一张「设备 id → 信封」的表，',
      '原样推过去就等于**把所有人的密文发给所有人**。',
      '',
      '所以组装的时候，投递这一步要自己写：走一遍活连接，',
      '按设备取出它自己那一份信封再推。第 4 关有价值的那部分 —— ',
      '位点判断和「已经有了就跳过」—— 通过 `cursorOf` 和 `acknowledge` 原样复用。',
      '',
      '撤回事件不是消息内容，服务端本来就该读得懂它，所以它走 `control` 帧。',
      '',
      '## 要实现什么',
      '',
      '在 `src/imServer.ts` 实现 `createImServer(store, transport, keyRing, gateway, options)`：',
      '',
      '| 方法 | 行为 |',
      '| --- | --- |',
      '| `createConversation(id, kind, members)` | 建会话 |',
      '| `connect(userId, deviceId)` | 注册公钥、接入、订阅推送、补齐离线消息 |',
      '| `disconnect` / `heartbeat` | 连接生命周期 |',
      '| `send(command)` | 封装 → 落号 → 扇出 → 按设备投递 → 安排唤醒 |',
      '| `recall(conversationId, seq, byUserId)` | 撤回并广播 |',
      '| `read(userId, conversationId, seq)` | 上报已读 |',
      '| `watch(watcherId, targets)` | 订阅在线状态 |',
      '| `conversationList(userId, limit)` | 会话列表 |',
      '| `lag(userId, deviceId)` | 这台设备还欠多少条 |',
      '| `tick()` | 定时维护：摘连接、扫状态、推回执 |',
      '',
      '## 怎么算过',
      '',
      '- 线上**没有出现过一次明文消息帧**（门槛 `counters.plaintextOnWire = 0`）——',
      '  这条门槛卡的正是「有没有按设备取信封」：把整张表推出去就会被记一笔；',
      '- 3 个成员共 6 台在线设备，一条消息**推 5 帧**',
      '  （门槛 `counters.framesPushed ≤ 8`）；',
      '- 一个在 40 个会话里的人取 10 行会话列表，**最多读 60 条记录**',
      '  （门槛 `counters.messagesScanned ≤ 60`）；',
      '- 重发幂等、离线补齐、撤回收敛、大群仍然出现在列表里，全部照旧。',
      '',
      '## 那个坑',
      '',
      '会话列表里对每个会话都调一次「这个人在这个会话里有多少未读」，',
      '而那个实现是遍历消息算出来的。',
      '',
      '第 5 关专门把未读做成了推导式的，就是为了让这一步是免费的。',
      '但在组装阶段很容易不假思索地写成「先拿到所有会话，再逐个算」——',
      '于是 40 个会话每个算一遍，代价重新回到了和会话总数成正比。',
      '',
      '这一关的门槛不是在考新东西，是在检查**前十一关的性质有没有在组装时被浪费掉**。',
      '一个模块单独测的时候是 O(1)，接起来之后被放进一个 O(n) 的循环里，',
      '这是系统集成里最常见的性能退化，而且每个模块的单元测试都还是绿的。',
    ].join('\n'),
    [
      'Eleven modules, one entry point. This stage wires them into a server and answers the question the',
      'app asks every single time it opens: **what does the conversation list look like?**',
      '',
      '## The conversation list is the most expensive query in the product',
      '',
      'One screen shows a dozen rows, and each row needs the last message, its time, the unread count,',
      'whether the other person is online, and whether they read what you sent. Five kinds of information',
      'from five modules — and the query runs on every foreground, every notification, every pull to',
      'refresh.',
      '',
      'So its cost has to be **bounded**, and bounded by how many rows are shown rather than by how many',
      'conversations the person is in.',
      '',
      '## Encryption changed the delivery step',
      '',
      'Stage 4\'s `publish` was written before encryption existed: it pushes a message\'s payload to every',
      'device as-is. After stage 10 that payload is a map from device id to envelope, and pushing it as-is',
      'means **handing everyone\'s ciphertext to everyone.**',
      '',
      'So the delivery step is written here: walk the live connections and push each device the envelope',
      'addressed to it. The valuable half of stage 4 — the cursor test and "skip anyone who already has',
      'it" — is reused unchanged through `cursorOf` and `acknowledge`.',
      '',
      'A recall is not message content and the server is supposed to understand it, so it travels as a',
      '`control` frame.',
      '',
      '## What to build',
      '',
      'Implement `createImServer(store, transport, keyRing, gateway, options)` in `src/imServer.ts`:',
      '',
      '| Method | Behaviour |',
      '| --- | --- |',
      '| `createConversation(id, kind, members)` | Create a conversation |',
      '| `connect(userId, deviceId)` | Publish keys, attach, enrol for push, catch up |',
      '| `disconnect` / `heartbeat` | Connection lifecycle |',
      '| `send(command)` | Seal, sequence, fan out, address per device, arrange wake-ups |',
      '| `recall(conversationId, seq, byUserId)` | Recall and broadcast it |',
      '| `read(userId, conversationId, seq)` | Report a read position |',
      '| `watch(watcherId, targets)` | Subscribe to presence |',
      '| `conversationList(userId, limit)` | The conversation list |',
      '| `lag(userId, deviceId)` | How far behind this device is |',
      '| `tick()` | Periodic upkeep: reap, sweep presence, flush receipts |',
      '',
      '## What counts as passing',
      '',
      '- **Not one plaintext message frame** reaches the wire (the `counters.plaintextOnWire = 0` gate) —',
      '  which is exactly the "did you address each device" test, since pushing the whole map is counted;',
      '- Three members with six connected devices cost **five frames** for one message',
      '  (the `counters.framesPushed ≤ 8` gate);',
      '- Someone in 40 conversations asking for 10 rows **reads at most 60 records**',
      '  (the `counters.messagesScanned ≤ 60` gate);',
      '- Idempotent resends, offline catch-up, recall convergence and large groups appearing in the list',
      '  all still hold.',
      '',
      '## The trap',
      '',
      'Calling "how many unread does this person have here" per conversation, where that implementation',
      'walks the messages.',
      '',
      'Stage 5 made unread derived precisely so this step would be free. But at assembly time it is easy to',
      'write "fetch every conversation, then compute each one" without thinking, and the cost goes back to',
      'being proportional to the total number of conversations.',
      '',
      'The gates here are not testing anything new. They check whether **the properties of the previous',
      'eleven stages survived being wired together.** A module that is O(1) on its own, dropped into an',
      'O(n) loop during integration, is the most common performance regression in systems work — and every',
      'unit test stays green while it happens.',
    ].join('\n')
  ),

  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  S["send(命令)"] --> SEAL["session.sealFor(...)<br/>每台接收设备一个信封"]',
      '  SEAL --> SEQ["sequencer.send(payload = 信封表)"]',
      '  SEQ --> DUP{"是重发吗？"}',
      '  DUP -- 是 --> RET["返回原来的 seq，什么都不做"]',
      '  DUP -- 否 --> FAN["fanout.onMessage(...)<br/>大群不写收件箱"]',
      '  FAN --> SELF["readCursors.markRead(发送人)<br/>自己写的不算自己未读"]',
      '  SELF --> DELIV["逐台活设备投递"]',
      '  DELIV --> CUR{"deviceSync.cursorOf 已经到 seq？"}',
      '  CUR -- 到了 --> SKIP["跳过"]',
      '  CUR -- 没到 --> PICK["session.envelopeFor(信封表, 这台设备)"]',
      '  PICK --> HAS{"有它的那一份吗？"}',
      '  HAS -- 没有 --> SKIP',
      '  HAS -- 有 --> PUSH["push 消息帧（只带这一个信封）<br/>deviceSync.acknowledge 记上位点"]',
      '  PUSH --> WAKE["notifier.onMessage(...)<br/>没连接的设备排进合并窗口"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  L["conversationList(userId, limit)"] --> REC["fanout.recent(userId, limit)<br/>代价只和 limit 有关"]',
      '  REC --> ROW["每一行"]',
      '  ROW --> VIS["revisions.visible(...) 拿最后一条"]',
      '  VIS --> UNR["readCursors.unreadOf(...) 免费"]',
      '  UNR --> RCP["receipts.stateOf(...) 拿送达已读"]',
      '  RCP --> PRS["presence.stateOf(对方) 免费"]',
      '  PRS --> OUT["拼成一行"]',
      '```',
      '',
      '要点：`PICK` 那一步是加密之后新增的，也是这一关唯一没法直接复用第 4 关的地方。',
      '省掉它，`plaintextOnWire` 立刻就会记账。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  S["send(command)"] --> SEAL["session.sealFor(...)<br/>one envelope per recipient device"]',
      '  SEAL --> SEQ["sequencer.send(payload = the envelope map)"]',
      '  SEQ --> DUP{"a resend?"}',
      '  DUP -- yes --> RET["return the original seq, do nothing else"]',
      '  DUP -- no --> FAN["fanout.onMessage(...)<br/>large groups write no inbox rows"]',
      '  FAN --> SELF["readCursors.markRead(sender)<br/>you have read what you wrote"]',
      '  SELF --> DELIV["walk the live devices"]',
      '  DELIV --> CUR{"deviceSync.cursorOf already at seq?"}',
      '  CUR -- yes --> SKIP["skip"]',
      '  CUR -- no --> PICK["session.envelopeFor(map, this device)"]',
      '  PICK --> HAS{"is there one for it?"}',
      '  HAS -- no --> SKIP',
      '  HAS -- yes --> PUSH["push a message frame carrying that one envelope<br/>deviceSync.acknowledge records the cursor"]',
      '  PUSH --> WAKE["notifier.onMessage(...)<br/>disconnected devices join the coalescing window"]',
      '```',
      '',
      '```mermaid',
      'flowchart TD',
      '  L["conversationList(userId, limit)"] --> REC["fanout.recent(userId, limit)<br/>cost depends only on limit"]',
      '  REC --> ROW["for each row"]',
      '  ROW --> VIS["revisions.visible(...) for the last message"]',
      '  VIS --> UNR["readCursors.unreadOf(...) is free"]',
      '  UNR --> RCP["receipts.stateOf(...) for delivered and read"]',
      '  RCP --> PRS["presence.stateOf(peer) is free"]',
      '  PRS --> OUT["assemble the row"]',
      '```',
      '',
      'The point: `PICK` is what encryption added, and the one step that cannot be reused from stage 4 as',
      'written. Leave it out and `plaintextOnWire` starts counting immediately.',
    ].join('\n')
  ),

  checklist: [
    t('投递时按设备取信封，不推整张表', 'Delivery addresses one envelope per device, never the whole map'),
    t('位点判断复用第 4 关，不重写', 'The cursor test is reused from stage 4 rather than rewritten'),
    t('会话列表的代价只和 limit 有关', 'The conversation list costs scale with limit only'),
    t('撤回事件走 control 帧', 'Revision events travel as control frames'),
    t('tick 一次做完摘连接、扫状态、推回执', 'One tick reaps, sweeps presence and flushes receipts'),
  ],

  pitfalls: [
    t(
      '把第 4 关的 publish 原样拿来推加密之后的消息。它推的是整个 payload，而加密之后 payload 是一张「设备 id → 信封」的表 —— 于是每台设备都拿到了所有人的密文。流量按设备数平方增长，而且任何一把私钥将来泄露，攻击者手上正好有整份历史密文可以离线解。',
      'Reusing stage 4\'s publish for encrypted messages. It pushes the whole payload, which after stage 10 is a device-to-envelope map, so every device receives everyone\'s ciphertext. Traffic grows with the square of the device count, and any private key compromised later arrives with a complete ciphertext archive to decrypt offline.'
    ),
    t(
      '会话列表先取出这个人的所有会话，再逐个算未读和最后一条。第 5 关和第 7 关分别把这两件事做成了 O(1) 和「只和 limit 有关」，在组装的时候套进一个遍历所有会话的循环里，两个优化就同时作废了。每个模块的单元测试仍然全绿 —— 这是系统集成里最典型的性能退化方式。',
      'Fetching all of a person\'s conversations and then computing unread and the last message for each. Stages 5 and 7 made those O(1) and limit-bounded respectively, and wrapping them in a loop over every conversation cancels both at once. Every module\'s unit tests stay green, which is how this class of integration regression usually goes unnoticed.'
    ),
    t(
      '把撤回事件当成普通消息推出去。撤回的 payload 是元数据而不是密文，走消息帧会被记一笔明文上线；更重要的是客户端需要区分「这是一条新消息」和「这是一条关于旧消息的指令」，用同一种帧类型会让客户端不得不去猜。',
      'Pushing revision events as ordinary messages. A revision payload is metadata rather than ciphertext, so a message frame records a plaintext crossing — and more importantly, the client needs to distinguish "a new message" from "an instruction about an old one", which one frame type forces it to guess at.'
    ),
    t(
      '`send` 里发现是重发之后仍然继续扇出和投递。第 2 关保证了 seq 幂等，但如果后面的步骤照跑，收件箱会多一条、通知会多一次、回执会多推一轮 —— 幂等只做了一半，而重发恰恰发生在网络最差的时候，也就是重复最多的时候。',
      'Continuing to fan out and deliver after `send` detects a resend. Stage 2 makes the sequence idempotent, but running the rest anyway adds an inbox row, another notification and another receipt round. Half-idempotent, and resends happen exactly when the network is worst, which is when there are most of them.'
    ),
  ],

  hints: [
    t(
      '投递那一步抽成一个私有函数，`send` 和 `recall` 都调它 —— 区别只是一个走消息帧、一个走 control 帧。判断依据可以是 payload 上有没有 `envelopes` 字段。',
      'Factor delivery into one private function called by both `send` and `recall`; the only difference is the frame kind. Whether the payload has an `envelopes` field is enough to decide.'
    ),
    t(
      '`connect` 里的补齐直接用 `backlog.pull` 加上同一个按设备取信封的逻辑，别再调 `deviceSync.resume` —— 它推的也是整个 payload。',
      'Do the catch-up in `connect` with `backlog.pull` plus the same per-device addressing, rather than calling `deviceSync.resume`, which also pushes the whole payload.'
    ),
  ],

  extension: t(
    [
      '十二关做完，这台服务器有以下性质：',
      '',
      '- 消息在会话内**全序**，重发**幂等**，序号**稠密**；',
      '- 离线设备靠**位点**补齐，代价和欠的条数成正比，不和历史长度成正比；',
      '- 一个人的**多台设备**各自收敛，已读位点**按人**共享；',
      '- 群按规模在**写扩散和读扩散**之间切换，两种路径对上层不可见；',
      '- 回执和在线状态**聚合并攒批**，代价不随成员数平方增长；',
      '- 撤回表达成**一条消息**，因此自动获得离线补齐和多端同步；',
      '- 内容**端到端加密**，服务端只靠元数据工作；',
      '- 睡着的设备靠**合并过的推送**唤醒，通知里没有内容。',
      '',
      '真实系统在这之上还有几层这里没做的：',
      '',
      '- **分片与路由**：会话按 id 分片到不同的机器，连接落在接入层，',
      '  两者之间需要一层路由。这一关的单进程实现把这个问题整个跳过了；',
      '- **消息搜索**：端到端加密之后服务端搜不了，只能客户端本地建索引，',
      '  于是「换新设备搜不到历史」成了必然结果；',
      '- **合规留存**：企业 IM 常常被要求保留可审计的消息副本，',
      '  这和端到端加密直接冲突，通常的妥协是给合规方一把额外的密钥',
      '  （也就是一个官方的中间人），而这件事必须对用户明示；',
      '- **会话成员变更的语义**：新成员能不能看到入群前的消息？',
      '  加密之后这不是策略问题而是能力问题 —— 服务端没有明文可以补给他。',
      '',
      '最后一件值得想的事：这十二关里，**没有一关的核心难点是「怎么把消息送到」**。',
      '送到是最简单的部分。难的全是「送到之后，几台设备、几个人、几种状态',
      '怎么保持一致」—— 这就是 IM 和消息队列的根本区别，',
      '也是为什么把消息中间件做熟了之后，做 IM 仍然要重新想一遍。',
    ].join('\n'),
    [
      'Twelve stages later, the server has these properties:',
      '',
      '- Messages are **totally ordered** within a conversation, resends are **idempotent**, sequences are',
      '  **dense**;',
      '- Offline devices reconcile through a **cursor**, at a cost proportional to what they missed rather',
      '  than to how much history exists;',
      '- A person\'s **several devices** each converge, while the read cursor is shared **per person**;',
      '- Groups switch between **write and read fan-out** by size, invisibly to everything above;',
      '- Receipts and presence are **aggregated and batched**, so neither grows with the square of the',
      '  member count;',
      '- A recall is expressed as **a message**, and therefore inherits offline catch-up and multi-device',
      '  convergence for free;',
      '- Content is **end-to-end encrypted** and the server runs on metadata alone;',
      '- Sleeping devices are woken by **coalesced pushes** that carry no content.',
      '',
      'Production adds layers this does not have:',
      '',
      '- **Sharding and routing**: conversations shard by id across machines while connections land on the',
      '  access layer, and something has to route between them. A single-process implementation skips the',
      '  problem entirely;',
      '- **Search**: an end-to-end encrypted server cannot search, so the index has to be built on the',
      '  client, which makes "my new device cannot find old messages" an inevitability rather than a bug;',
      '- **Retention and compliance**: enterprise deployments are frequently required to keep auditable',
      '  copies, which conflicts directly with end-to-end encryption. The usual compromise hands compliance',
      '  an additional key — an official man in the middle — and that has to be disclosed to users;',
      '- **Membership change semantics**: can a new member see messages from before they joined? After',
      '  encryption that is no longer a policy question but a capability one, because the server has no',
      '  plaintext to give them.',
      '',
      'One last thing worth sitting with: in twelve stages, **not one of them was fundamentally about',
      'getting a message delivered.** Delivery was the easy part. The difficulty was always what happens',
      'afterwards — keeping several devices, several people and several kinds of state in agreement. That',
      'is the real difference between IM and a message queue, and why knowing brokers well still leaves you',
      'with a fresh problem here.',
    ].join('\n')
  ),

  focus: ['correctness', 'latency', 'encapsulation', 'elegance'],
  lab: {},

  starterFiles: [
    file(
      'src/imServer.ts',
      code`
        import type { PresenceState } from './presence/presence';
        import type { ReceiptState } from './conversation/receipts';
        import type { DeviceKeyPair, KeyRing } from './support/crypto';
        import type { PushGateway } from './support/push';
        import type { Store } from './support/store';
        import type { Transport } from './support/transport';

        export interface ImServerOptions {
          /** Connection idle timeout for the registry */
          idleMs: number;
          /** How long before a live connection counts as away */
          awayMs: number;
          /** Most messages pushed to one device in one catch-up */
          catchUpLimit: number;
          /** Conversations larger than this use read fan-out */
          fanoutThreshold: number;
          recallWindowMs: number;
          coalesceMs: number;
        }

        export interface SendCommand {
          conversationId: string;
          senderId: string;
          /** The device composing the message; it receives no envelope */
          senderDeviceId: string;
          clientMsgId: string;
          text: string;
        }

        export interface SendOutcome {
          seq: number;
          deduplicated: boolean;
          /** Connections that received a body */
          delivered: number;
        }

        export interface ConnectOutcome {
          connectionId: string;
          keyPair: DeviceKeyPair;
          /** Messages pushed as catch-up */
          caughtUp: number;
        }

        export interface ConversationSummary {
          conversationId: string;
          /** The newest seq in the conversation */
          seq: number;
          sentAt: number;
          /** Who sent the newest message; undefined once it is recalled */
          senderId?: string;
          recalled: boolean;
          unread: number;
          receipt: ReceiptState;
          /** For a direct conversation, the other party's presence */
          peerState?: PresenceState;
        }

        export interface TickResult {
          reaped: number;
          presenceFrames: number;
          receiptFrames: number;
        }

        export interface ImServer {
          createConversation(
            conversationId: string,
            kind: 'direct' | 'group',
            members: string[]
          ): void;
          connect(userId: string, deviceId: string): ConnectOutcome;
          disconnect(connectionId: string): void;
          heartbeat(connectionId: string): void;
          send(command: SendCommand): SendOutcome;
          recall(conversationId: string, seq: number, byUserId: string): number;
          read(userId: string, conversationId: string, seq: number): void;
          watch(watcherId: string, targets: string[]): void;
          /** Everything the home screen needs, in a pass bounded by limit. */
          conversationList(userId: string, limit: number): ConversationSummary[];
          /** How many messages this device is still missing. */
          lag(userId: string, deviceId: string): number;
          tick(): TickResult;
        }

        export function createImServer(
          store: Store,
          transport: Transport,
          keyRing: KeyRing,
          gateway: PushGateway,
          options: ImServerOptions
        ): ImServer {
          // TODO: implement
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
        import { createImServer } from '../src/imServer';
        import { createKeyRing } from '../src/support/crypto';
        import { createPushGateway } from '../src/support/push';
        import { createStore } from '../src/support/store';
        import { createTransport } from '../src/support/transport';
        import { sleep } from '@lab/env';

        const TEXT = 'the quarterly numbers are attached';
        const OPTIONS = {
          idleMs: 100000,
          awayMs: 50000,
          catchUpLimit: 50,
          fanoutThreshold: 8,
          recallWindowMs: 100000,
          coalesceMs: 500,
        };

        function makeServer(overrides: any = {}) {
          const store = createStore();
          const transport = createTransport();
          const keyRing = createKeyRing();
          const gateway = createPushGateway();
          const server = createImServer(store, transport, keyRing, gateway, {
            ...OPTIONS,
            ...overrides,
          });
          return { store, transport, keyRing, gateway, server };
        }

        function messageFrames(world: any, connectionId: string) {
          return world.transport.inbox(connectionId).filter((frame: any) => frame.kind === 'message');
        }

        function send(world: any, conversationId: string, senderId: string, deviceId: string, nth: number) {
          return world.server.send({
            conversationId,
            senderId,
            senderDeviceId: deviceId,
            clientMsgId: conversationId + '-m' + nth,
            text: TEXT,
          });
        }

        describe('阶段12 · 组装：一台 IM 服务器', () => {
          it('发出去的消息端到端加密，收件设备能解开', () => {
            const world = makeServer();
            world.server.createConversation('c1', 'direct', ['alice', 'bob']);
            const alice = world.server.connect('alice', 'alice-phone');
            const bob = world.server.connect('bob', 'bob-phone');

            send(world, 'c1', 'alice', 'alice-phone', 1);

            const frames = messageFrames(world, bob.connectionId);
            expect(frames).toHaveLength(1);
            expect(JSON.stringify(frames[0].payload)).not.toContain('quarterly');
            expect(world.keyRing.open(bob.keyPair, frames[0].payload)).toBe(TEXT);
            expect(messageFrames(world, alice.connectionId)).toHaveLength(0);
          });

          it('同一个人的另一台设备也收得到', () => {
            const world = makeServer();
            world.server.createConversation('c1', 'direct', ['alice', 'bob']);
            world.server.connect('alice', 'alice-phone');
            const laptop = world.server.connect('alice', 'alice-laptop');
            world.server.connect('bob', 'bob-phone');

            send(world, 'c1', 'alice', 'alice-phone', 1);

            const frames = messageFrames(world, laptop.connectionId);
            expect(frames).toHaveLength(1);
            expect(world.keyRing.open(laptop.keyPair, frames[0].payload)).toBe(TEXT);
          });

          it('重发同一个 clientMsgId 是幂等的', () => {
            const world = makeServer();
            world.server.createConversation('c1', 'direct', ['alice', 'bob']);
            world.server.connect('alice', 'alice-phone');
            const bob = world.server.connect('bob', 'bob-phone');

            const first = send(world, 'c1', 'alice', 'alice-phone', 1);
            const again = send(world, 'c1', 'alice', 'alice-phone', 1);

            expect(again.seq).toBe(first.seq);
            expect(again.deduplicated).toBe(true);
            expect(again.delivered).toBe(0);
            expect(messageFrames(world, bob.connectionId)).toHaveLength(1);
            expect(world.store.messageCount('c1')).toBe(1);
          });

          it('离线期间的消息在重连时补齐', () => {
            const world = makeServer();
            world.server.createConversation('c1', 'direct', ['alice', 'bob']);
            world.server.connect('alice', 'alice-phone');
            const first = world.server.connect('bob', 'bob-phone');
            world.server.disconnect(first.connectionId);

            send(world, 'c1', 'alice', 'alice-phone', 1);
            send(world, 'c1', 'alice', 'alice-phone', 2);

            const back = world.server.connect('bob', 'bob-phone');
            expect(back.caughtUp).toBe(2);
            expect(messageFrames(world, back.connectionId)).toHaveLength(2);
            expect(world.keyRing.open(back.keyPair, messageFrames(world, back.connectionId)[0].payload)).toBe(
              TEXT
            );
          });

          it('lag 报告这台设备还欠多少条', () => {
            const world = makeServer();
            world.server.createConversation('c1', 'direct', ['alice', 'bob']);
            world.server.connect('alice', 'alice-phone');
            const bob = world.server.connect('bob', 'bob-phone');
            world.server.disconnect(bob.connectionId);

            send(world, 'c1', 'alice', 'alice-phone', 1);
            send(world, 'c1', 'alice', 'alice-phone', 2);

            expect(world.server.lag('bob', 'bob-phone')).toBe(2);
            const back = world.server.connect('bob', 'bob-phone');
            expect(back.caughtUp).toBe(2);
            expect(world.server.lag('bob', 'bob-phone')).toBe(0);
          });

          it('会话列表带着未读、时间和对方的在线状态', async () => {
            const world = makeServer();
            world.server.createConversation('c1', 'direct', ['alice', 'bob']);
            world.server.createConversation('c2', 'direct', ['alice', 'carol']);
            world.server.connect('alice', 'alice-phone');
            world.server.connect('bob', 'bob-phone');
            world.server.watch('alice', ['bob', 'carol']);

            send(world, 'c1', 'bob', 'bob-phone', 1);
            await sleep(10);
            send(world, 'c2', 'alice', 'alice-phone', 1);

            const list = world.server.conversationList('alice', 10);

            expect(list.map((row: any) => row.conversationId)).toEqual(['c2', 'c1']);
            expect(list[1].unread).toBe(1);
            expect(list[1].peerState).toBe('online');
            expect(list[0].unread).toBe(0);
            expect(list[0].peerState).toBe('offline');
            expect(list[0].senderId).toBe('alice');
          });

          it('上报已读之后未读归零，回执跟着走', () => {
            const world = makeServer();
            world.server.createConversation('c1', 'direct', ['alice', 'bob']);
            world.server.connect('alice', 'alice-phone');
            world.server.connect('bob', 'bob-phone');

            const sent = send(world, 'c1', 'alice', 'alice-phone', 1);
            world.server.read('bob', 'c1', sent.seq);

            const forBob = world.server.conversationList('bob', 5);
            expect(forBob[0].unread).toBe(0);

            const forAlice = world.server.conversationList('alice', 5);
            expect(forAlice[0].receipt.read).toBe(1);
            expect(forAlice[0].receipt.audience).toBe(1);
          });

          it('撤回之后列表显示为已撤回，原文取不到', () => {
            const world = makeServer();
            world.server.createConversation('c1', 'direct', ['alice', 'bob']);
            world.server.connect('alice', 'alice-phone');
            const bob = world.server.connect('bob', 'bob-phone');

            const sent = send(world, 'c1', 'alice', 'alice-phone', 1);
            world.server.recall('c1', sent.seq, 'alice');

            const stored = world.store.readMessages('c1', sent.seq - 1, 1)[0];
            expect(stored.state).toBe('recalled');
            expect(JSON.stringify(stored.payload || '')).not.toContain('envelopes');

            // 撤回作为一条 control 帧到达已经在线的设备
            const control = world.transport
              .inbox(bob.connectionId)
              .filter((frame: any) => frame.kind === 'control');
            expect(control).toHaveLength(1);
            expect(control[0].payload.kind).toBe('recall');
            expect(control[0].payload.targetSeq).toBe(sent.seq);
          });

          it('撤回之后会话列表那一行标成 recalled', () => {
            const world = makeServer();
            world.server.createConversation('c1', 'direct', ['alice', 'bob']);
            world.server.connect('alice', 'alice-phone');
            const sent = send(world, 'c1', 'alice', 'alice-phone', 1);

            const before = world.server.conversationList('alice', 5);
            expect(before[0].recalled).toBe(false);

            world.server.recall('c1', sent.seq, 'alice');

            const after = world.server.conversationList('alice', 5);
            expect(after[0].seq).toBe(2);
            expect(after[0].recalled).toBe(false);
            expect(world.server.conversationList('bob', 5)[0].conversationId).toBe('c1');
          });

          it('大群走读扩散但仍然出现在会话列表里', () => {
            const world = makeServer();
            const crowd = ['alice'];
            for (let index = 1; index <= 40; index += 1) crowd.push('u' + index);
            world.server.createConversation('big', 'group', crowd);
            world.server.connect('u1', 'u1-phone');

            send(world, 'big', 'u1', 'u1-phone', 1);

            expect(world.store.inboxSize('alice')).toBe(0);
            const list = world.server.conversationList('alice', 5);
            expect(list).toHaveLength(1);
            expect(list[0].conversationId).toBe('big');
            expect(list[0].unread).toBe(1);
          });

          it('离线的成员收到系统推送，通知里没有内容', async () => {
            const world = makeServer();
            world.server.createConversation('c1', 'direct', ['alice', 'bob']);
            world.server.connect('alice', 'alice-phone');
            const bob = world.server.connect('bob', 'bob-phone');
            world.server.disconnect(bob.connectionId);

            send(world, 'c1', 'alice', 'alice-phone', 1);
            send(world, 'c1', 'alice', 'alice-phone', 2);
            await sleep(OPTIONS.coalesceMs);

            const delivered = world.gateway.delivered('tok-bob-phone');
            expect(delivered).toHaveLength(1);
            expect(delivered[0].badge).toBe(2);
            expect(JSON.stringify(delivered[0])).not.toContain('quarterly');
          });

          it('tick 摘掉死连接并推出在线状态和回执', () => {
            const world = makeServer();
            world.server.createConversation('c1', 'direct', ['alice', 'bob']);
            const alice = world.server.connect('alice', 'alice-phone');
            const bob = world.server.connect('bob', 'bob-phone');
            world.server.watch('alice', ['bob']);
            world.server.tick();

            const sent = send(world, 'c1', 'alice', 'alice-phone', 1);
            world.server.read('bob', 'c1', sent.seq);
            world.transport.close(bob.connectionId);

            const result = world.server.tick();

            expect(result.reaped).toBe(1);
            expect(result.presenceFrames).toBe(1);
            expect(result.receiptFrames).toBe(1);

            // 第一次 tick 已经播过一次「bob 上线」，这次是「bob 下线」
            const announced = world.transport
              .inbox(alice.connectionId)
              .filter((frame: any) => frame.kind === 'presence');
            expect(announced).toHaveLength(2);
            expect(announced[1].payload[0].state).toBe('offline');
          });

          it('后加入的设备收不到之前的消息体', () => {
            const world = makeServer();
            world.server.createConversation('c1', 'direct', ['alice', 'bob']);
            world.server.connect('alice', 'alice-phone');
            world.server.connect('bob', 'bob-phone');

            send(world, 'c1', 'alice', 'alice-phone', 1);

            const tablet = world.server.connect('bob', 'bob-tablet');
            expect(messageFrames(world, tablet.connectionId)).toHaveLength(0);
          });

          it('三个成员六台在线设备，一条消息推五帧 [gate:fanout]', () => {
            const world = makeServer();
            world.server.createConversation('c1', 'group', ['alice', 'bob', 'carol']);
            for (const person of ['alice', 'bob', 'carol']) {
              world.server.connect(person, person + '-phone');
              world.server.connect(person, person + '-laptop');
            }

            const outcome = send(world, 'c1', 'alice', 'alice-phone', 1);

            expect(outcome.delivered).toBe(5);
          });

          it('四十个会话取十行，读取有上限 [gate:list]', () => {
            const world = makeServer();
            world.server.connect('alice', 'alice-phone');
            for (let index = 1; index <= 40; index += 1) {
              const id = 'd' + index;
              world.server.createConversation(id, 'direct', ['alice', 'peer' + index]);
            }
            for (let round = 1; round <= 2; round += 1) {
              for (let index = 1; index <= 40; index += 1) {
                send(world, 'd' + index, 'alice', 'alice-phone', round);
              }
            }

            const list = world.server.conversationList('alice', 10);

            // 全部发生在同一个虚拟毫秒上，所以只断言取到的是最近的那十个
            expect(list.map((row: any) => row.conversationId).sort()).toEqual([
              'd31', 'd32', 'd33', 'd34', 'd35', 'd36', 'd37', 'd38', 'd39', 'd40',
            ]);
          });
        });
      `
    ),
  ],

  gates: [
    gate({
      metric: 'counters.plaintextOnWire',
      op: 'eq',
      value: 0,
      zh: '组装之后线上依然没有一次明文',
      en: 'Assembly kept every message frame ciphertext',
      dimension: 'correctness',
    }),
    gate({
      metric: 'counters.framesPushed',
      op: 'lte',
      value: 8,
      zh: '六台设备的群里一条消息推五帧',
      en: 'One message among six devices costs five frames',
      dimension: 'latency',
      scope: 'gate:fanout',
    }),
    gate({
      metric: 'counters.messagesScanned',
      op: 'lte',
      value: 60,
      zh: '四十个会话取十行最多读六十条记录',
      en: 'Ten rows out of forty conversations read at most sixty records',
      dimension: 'latency',
      scope: 'gate:list',
    }),
  ],

  referenceFiles: [
    file(
      'src/imServer.ts',
      code`
        import { createBacklog } from './conversation/backlog';
        import { createReadCursors } from './conversation/readCursor';
        import { createReceipts } from './conversation/receipts';
        import { createSequencer } from './conversation/sequence';
        import { createRevisions } from './conversation/revision';
        import { createE2eeSession } from './crypto/e2eeSession';
        import { createDeviceSync } from './device/deviceSync';
        import { createFanout } from './group/fanout';
        import { createPresence } from './presence/presence';
        import type { PresenceState } from './presence/presence';
        import { createNotifier } from './push/notifier';
        import { createRegistry } from './session/registry';
        import type { ReceiptState } from './conversation/receipts';
        import type { SyncPoint } from './conversation/backlog';
        import type { DeviceKeyPair, KeyRing } from './support/crypto';
        import type { PushGateway } from './support/push';
        import type { Store } from './support/store';
        import type { Frame, Transport } from './support/transport';
        import { now } from '@lab/env';

        export interface ImServerOptions {
          idleMs: number;
          awayMs: number;
          catchUpLimit: number;
          fanoutThreshold: number;
          recallWindowMs: number;
          coalesceMs: number;
        }

        export interface SendCommand {
          conversationId: string;
          senderId: string;
          senderDeviceId: string;
          clientMsgId: string;
          text: string;
        }

        export interface SendOutcome {
          seq: number;
          deduplicated: boolean;
          delivered: number;
        }

        export interface ConnectOutcome {
          connectionId: string;
          keyPair: DeviceKeyPair;
          caughtUp: number;
        }

        export interface ConversationSummary {
          conversationId: string;
          seq: number;
          sentAt: number;
          senderId?: string;
          recalled: boolean;
          unread: number;
          receipt: ReceiptState;
          peerState?: PresenceState;
        }

        export interface TickResult {
          reaped: number;
          presenceFrames: number;
          receiptFrames: number;
        }

        export interface ImServer {
          createConversation(
            conversationId: string,
            kind: 'direct' | 'group',
            members: string[]
          ): void;
          connect(userId: string, deviceId: string): ConnectOutcome;
          disconnect(connectionId: string): void;
          heartbeat(connectionId: string): void;
          send(command: SendCommand): SendOutcome;
          recall(conversationId: string, seq: number, byUserId: string): number;
          read(userId: string, conversationId: string, seq: number): void;
          watch(watcherId: string, targets: string[]): void;
          conversationList(userId: string, limit: number): ConversationSummary[];
          lag(userId: string, deviceId: string): number;
          tick(): TickResult;
        }

        export function createImServer(
          store: Store,
          transport: Transport,
          keyRing: KeyRing,
          gateway: PushGateway,
          options: ImServerOptions
        ): ImServer {
          const registry = createRegistry(transport, { idleMs: options.idleMs });
          const sequencer = createSequencer(store);
          const backlog = createBacklog(store);
          const deviceSync = createDeviceSync(store, transport, registry, backlog, {
            catchUpLimit: options.catchUpLimit,
          });
          const readCursors = createReadCursors(store);
          const receipts = createReceipts(store, transport, registry, readCursors);
          const fanout = createFanout(store, { fanoutThreshold: options.fanoutThreshold });
          const presence = createPresence(transport, registry, { awayMs: options.awayMs });
          const revisions = createRevisions(store, sequencer, {
            recallWindowMs: options.recallWindowMs,
          });
          const session = createE2eeSession(store, keyRing);
          const notifier = createNotifier(store, transport, registry, readCursors, gateway, {
            coalesceMs: options.coalesceMs,
          });

          /**
           * The step encryption added.
           *
           * A message payload is a device-to-envelope map, so each device gets the one
           * addressed to it. Anything the server itself minted — a recall, an edit —
           * is metadata rather than ciphertext and travels as a control frame.
           */
          function frameFor(
            conversationId: string,
            seq: number,
            payload: unknown,
            deviceId: string
          ): Frame | undefined {
            const sealed = payload as { envelopes?: Record<string, unknown> };
            if (sealed && sealed.envelopes) {
              const envelope = session.envelopeFor(sealed as any, deviceId);
              if (!envelope) return undefined;
              return { kind: 'message', conversationId, seq, payload: envelope };
            }
            return { kind: 'control', conversationId, seq, payload };
          }

          /** Push one conversation position to every live device that lacks it. */
          function deliver(conversationId: string, seq: number, payload: unknown): number {
            const meta = store.getConversation(conversationId);
            if (!meta) return 0;

            let delivered = 0;
            for (const member of meta.members) {
              for (const connectionId of registry.connectionsOf(member)) {
                const deviceId = transport.deviceOf(connectionId);
                if (!deviceId) continue;
                // Stage 4's rule, reused unchanged
                if (deviceSync.cursorOf(deviceId, conversationId) >= seq) continue;
                const frame = frameFor(conversationId, seq, payload, deviceId);
                if (!frame) continue;
                transport.push(connectionId, frame);
                deviceSync.acknowledge(deviceId, conversationId, seq);
                delivered += 1;
              }
            }
            return delivered;
          }

          function syncPointOf(userId: string, deviceId: string): SyncPoint {
            const since: SyncPoint = {};
            for (const conversationId of store.conversationsOf(userId)) {
              since[conversationId] = deviceSync.cursorOf(deviceId, conversationId);
            }
            return since;
          }

          function catchUp(userId: string, deviceId: string, connectionId: string): number {
            const page = backlog.pull({
              userId,
              since: syncPointOf(userId, deviceId),
              limit: options.catchUpLimit,
            });

            let pushed = 0;
            for (const entry of page.entries) {
              const frame = frameFor(entry.conversationId, entry.seq, entry.payload, deviceId);
              // No envelope means this device was not a recipient — a device added after
              // the message was sealed, which by construction can never read it.
              deviceSync.acknowledge(deviceId, entry.conversationId, entry.seq);
              if (!frame) continue;
              transport.push(connectionId, frame);
              pushed += 1;
            }
            return pushed;
          }

          return {
            createConversation(
              conversationId: string,
              kind: 'direct' | 'group',
              members: string[]
            ): void {
              store.putConversation({ conversationId, kind, members });
            },

            connect(userId: string, deviceId: string): ConnectOutcome {
              const keyPair = session.register(userId, deviceId);
              const connectionId = registry.attach(userId, deviceId);
              notifier.enrol(userId, deviceId);
              return { connectionId, keyPair, caughtUp: catchUp(userId, deviceId, connectionId) };
            },

            disconnect(connectionId: string): void {
              transport.close(connectionId);
              registry.reap();
            },

            heartbeat(connectionId: string): void {
              registry.beat(connectionId);
            },

            send(command: SendCommand): SendOutcome {
              const sealed = session.sealFor(
                command.conversationId,
                command.senderId,
                command.senderDeviceId,
                command.text
              );
              const sentAt = now();
              const result = sequencer.send({
                conversationId: command.conversationId,
                senderId: command.senderId,
                clientMsgId: command.clientMsgId,
                payload: sealed,
                sentAt,
              });

              // A resend already did all of this. Doing it again would add an inbox row,
              // another notification and another receipt round.
              if (result.deduplicated) return { seq: result.seq, deduplicated: true, delivered: 0 };

              fanout.onMessage(command.conversationId, result.seq, sentAt);
              readCursors.markRead(command.senderId, command.conversationId, result.seq);
              deviceSync.acknowledge(command.senderDeviceId, command.conversationId, result.seq);

              const delivered = deliver(command.conversationId, result.seq, sealed);
              notifier.onMessage(command.conversationId, result.seq, command.senderId);

              return { seq: result.seq, deduplicated: false, delivered };
            },

            recall(conversationId: string, seq: number, byUserId: string): number {
              const result = revisions.recall(conversationId, seq, byUserId);
              const record = store.readMessages(conversationId, result.seq - 1, 1)[0];
              if (!record) return result.seq;

              fanout.onMessage(conversationId, result.seq, record.sentAt);
              readCursors.markRead(byUserId, conversationId, result.seq);
              deliver(conversationId, result.seq, record.payload);
              return result.seq;
            },

            read(userId: string, conversationId: string, seq: number): void {
              receipts.noteRead(userId, conversationId, seq);
            },

            watch(watcherId: string, targets: string[]): void {
              presence.subscribe(watcherId, targets);
            },

            conversationList(userId: string, limit: number): ConversationSummary[] {
              // fanout.recent is already bounded by limit; everything below is per row
              return fanout.recent(userId, limit).map((entry) => {
                const visible = revisions.visible(entry.conversationId, entry.seq);
                const meta = store.getConversation(entry.conversationId);
                const peer =
                  meta && meta.kind === 'direct'
                    ? meta.members.filter((member) => member !== userId)[0]
                    : undefined;

                return {
                  conversationId: entry.conversationId,
                  seq: entry.seq,
                  sentAt: entry.sentAt,
                  senderId: visible ? visible.senderId : undefined,
                  recalled: !visible,
                  // Derived from two free numbers, exactly as stage 5 arranged
                  unread: readCursors.unreadOf(userId, entry.conversationId),
                  receipt: receipts.stateOf(entry.conversationId, entry.seq),
                  peerState: peer ? presence.stateOf(peer) : undefined,
                };
              });
            },

            lag(userId: string, deviceId: string): number {
              return backlog.pendingCount(userId, syncPointOf(userId, deviceId));
            },

            tick(): TickResult {
              const reaped = registry.reap().length;
              presence.sweep();
              return {
                reaped,
                presenceFrames: presence.flush(),
                receiptFrames: receipts.flush(),
              };
            },
          };
        }
      `
    ),
  ],
};

module.exports = {
  id: 'enterprise-im',
  title: t('企业级 IM 通讯系统', 'An enterprise IM system'),
  summary: t(
    '十二关造出一个企业级 IM：连接与心跳、会话序号与幂等、离线增量拉取、多端同步、已读位点与未读数、送达与已读回执、写扩散与读扩散、在线状态订阅、撤回与编辑、端到端加密、合并推送，最后组装成一台能在有界代价内答出会话列表的服务器。',
    'Twelve stages building an enterprise IM system: connections and heartbeats, idempotent conversation sequencing, bounded offline catch-up, multi-device sync, read cursors and unread counts, delivery and read receipts, write versus read fan-out, subscribed presence, recall and edit, end-to-end encryption, coalesced push, and finally a server that answers the conversation list at a bounded cost.'
  ),
  difficulty: 'Hard',
  domain: 'messaging',
  tags: [
    'instant-messaging',
    'multi-device',
    'read-receipts',
    'presence',
    'fanout',
    'end-to-end-encryption',
    'push-notifications',
    'offline-sync',
  ],
  estimatedMinutes: 600,
  language: 'typescript',
  weights: {
    correctness: 3,
    latency: 2.5,
    resilience: 2,
    encapsulation: 1.5,
    elegance: 1.5,
    concurrency: 1,
  },
  brief: t(
    [
      '## 背景',
      '',
      '这道题不是「造一个消息中间件」，是造一个**给人用的聊天系统**。',
      '',
      '两者的差别比看上去大。消息队列里，一条消息被一个消费者取走就结束了；',
      'IM 里，一条消息要同时出现在收件人的三台设备上、',
      '要让发送方看到「已读」、要在群里被 500 个人看到、',
      '要在其中一个人撤回时从所有屏幕上消失，',
      '而这一切还要在服务端读不懂消息内容的前提下成立。',
      '',
      '难点从来不是「怎么把消息送到」。送到是最简单的一步。',
      '难的是**送到之后，几台设备、几个人、几种状态怎么保持一致**。',
      '',
      '## 十二关怎么分组',
      '',
      '| 层 | 关卡 | 回答的问题 |',
      '| --- | --- | --- |',
      '| 会话 | 1-3 | 一个人是好几台设备，消息怎么定位，离线了怎么补 |',
      '| 人 | 4-6 | 多端怎么收敛，「读了」是什么意思，发送方怎么知道 |',
      '| 群 | 7-8 | 五千人的群怎么扇出，在线状态怎么不炸 |',
      '| 一致性与收口 | 9-12 | 撤回怎么收敛，加密之后还剩什么，最后接成什么 |',
      '',
      '## 平台提供什么',
      '',
      '四个只读模块，工程门槛全部由它们内部计量，学员改不到：',
      '',
      '```ts',
      'transport.push(connectionId, frame);  // 帧数、死连接、重复推送、明文上线',
      'store.readMessages(conv, index, max); // 每交出一条记录记一笔 messagesScanned',
      'keyRing.seal(deviceId, text, n);      // 封装次数与棘轮复用',
      'gateway.send(token, notification);    // 通知条数与内容夹带',
      '```',
      '',
      '`store` 还会在写入时核对三件事：同一个 clientMsgId 是不是被写了两次、',
      '序号有没有跳洞、位点有没有倒退。这三个数就是第 2、4、5 关的门槛。',
      '',
      '元数据（条数、成员、位点）读起来是免费的，消息记录不是 ——',
      '这条分界线是全项目大部分延迟门槛的来源。',
      '',
      '## 依赖链',
      '',
      '每一关解决的都是上一关留下的问题：',
      '',
      '- 弱网重发在第 1 关会变成两条消息，所以有了第 2 关的幂等落号；',
      '- 有了序号才能表达「我漏了哪一段」，于是有了第 3 关的增量拉取；',
      '- 拉取按设备走，但推送还在无差别广播，于是有了第 4 关的每设备位点；',
      '- 设备收齐了不等于人读了，于是有了第 5 关的已读位点；',
      '- 自己知道未读，发送方还不知道，于是有了第 6 关的回执聚合；',
      '- 前六关都假设能逐个成员写收件箱，第 7 关在大群里把这个假设拆掉；',
      '- 大群通了，最后一处按平方增长的是在线状态，那是第 8 关；',
      '- 会话一致了，直到有人撤回 —— 第 9 关把撤回表达成一条消息，',
      '  于是离线补齐和多端同步全部免费复用；',
      '- 前九关都建立在服务端能读明文上，第 10 关把这个前提拿掉；',
      '- 内容读不懂、设备还睡着，通知只剩一个壳，那是第 11 关；',
      '- 第 12 关把十一个模块接成一台服务器，并证明它们的性质没有在组装时丢掉。',
      '',
      '## 硬性约束',
      '',
      '1. 会话内的顺序由**服务端**决定，客户端时间戳不作数；',
      '2. 同一次发送永远拿到同一个位置，重试不产生第二条消息；',
      '3. 所有位点都是**只涨不落**的水位线；',
      '4. 代价要和「要展示多少」成正比，不能和「一共有多少」成正比；',
      '5. 第 10 关之后，服务端不得接触消息明文。',
      '',
      '## 非目标',
      '',
      '- 不做分片与路由：全部在一个进程里，跨机的连接路由不在范围内；',
      '- 不做限流与反垃圾（那是 `rate-limited-gateway` 那道题）；',
      '- 不做底层存储引擎：分段日志、索引、投递语义是 `message-broker` 那道题；',
      '- 不做媒体文件的断点续传；',
      '- 不做真正的多线程：并发用协作式 async 模拟，时序语义完全一致。',
      '',
      '## 术语',
      '',
      '- **会话（conversation）**：一组人和他们之间的消息序列，可以是两人也可以是群。',
      '- **seq**：一条消息在会话里的位置，从 1 开始稠密递增，由服务端分配。',
      '- **clientMsgId**：客户端发送前自己生成的 id，重试时不变，用来识别重发。',
      '- **设备位点**：服务端记的「这台设备已经拿到哪了」，每设备一份。',
      '- **已读位点**：这个人看到哪了，每人一份，多台设备共享同一条。',
      '- **写扩散 / 读扩散**：发消息时预先写进每个成员的收件箱，还是读的时候现算。',
      '- **信封（envelope）**：加密给某一台设备的密文，一条消息对应 N 个信封。',
      '- **棘轮（ratchet）**：每封一次就前进的密钥位置，防止 nonce 复用。',
      '- **合并窗口**：一段时间内的多次事件只产生一次推送或一轮回执。',
    ].join('\n'),
    [
      '## Context',
      '',
      'This project is not about building a message broker. It is about building **a chat system people',
      'use.**',
      '',
      'The difference is larger than it looks. In a queue, one message taken by one consumer ends the',
      'story. Here a message has to appear on all three of the recipient\'s devices at once, show the sender',
      'that it was read, reach 500 people in a group, and vanish from every screen when one person recalls',
      'it — all while the server cannot read what it is routing.',
      '',
      'The difficulty was never getting a message delivered. Delivery is the easy step. It is **what happens',
      'afterwards: keeping several devices, several people and several kinds of state in agreement.**',
      '',
      '## How the twelve stages group',
      '',
      '| Layer | Stages | Questions it answers |',
      '| --- | --- | --- |',
      '| The session | 1-3 | A person is several devices; how a message is located; how you catch up |',
      '| The person | 4-6 | How devices converge, what "read" means, how the sender finds out |',
      '| The group | 7-8 | How a 5000-person group fans out; how presence avoids exploding |',
      '| Consistency and closure | 9-12 | How a recall converges, what survives encryption, what it all becomes |',
      '',
      '## What the platform gives you',
      '',
      'Four read-only modules. Every engineering gate is measured inside them, out of reach of your code:',
      '',
      '```ts',
      'transport.push(connectionId, frame);  // frames, dead sockets, duplicates, plaintext on the wire',
      'store.readMessages(conv, index, max); // one messagesScanned per record handed back',
      'keyRing.seal(deviceId, text, n);      // seal count and ratchet reuse',
      'gateway.send(token, notification);    // notification count and content leakage',
      '```',
      '',
      'The store also audits three things as you write: whether one clientMsgId was written twice, whether',
      'a sequence skipped, and whether a cursor moved backwards. Those three numbers are the gates of',
      'stages 2, 4 and 5.',
      '',
      'Metadata — counts, members, cursors — is free to read; message records are not. That line is where',
      'most of the latency gates in this project come from.',
      '',
      '## The dependency chain',
      '',
      'Every stage solves what the previous one left behind:',
      '',
      '- a retry over a bad connection becomes two messages in stage 1, hence idempotent sequencing in 2;',
      '- sequences make "which part did I miss" expressible, hence the incremental pull in 3;',
      '- the pull is per device while the push still broadcasts, hence per-device cursors in 4;',
      '- devices holding a message is not a person reading it, hence read cursors in 5;',
      '- you know your own unread, the sender does not, hence aggregated receipts in 6;',
      '- the first six stages assume you can write to every member, and stage 7 removes that assumption;',
      '- with large groups working, the last quadratic surface is presence, which is stage 8;',
      '- the conversation is consistent until someone deletes a message — stage 9 expresses a recall as a',
      '  message, so offline catch-up and multi-device convergence come for free;',
      '- all nine rested on the server reading plaintext, and stage 10 takes that away;',
      '- content unreadable and devices asleep leaves the notification as a shell, which is stage 11;',
      '- stage 12 wires eleven modules into one server and proves their properties survived the wiring.',
      '',
      '## Hard constraints',
      '',
      '1. Order within a conversation is decided by **the server**; client timestamps do not count;',
      '2. One send always receives the same position, and a retry never produces a second message;',
      '3. Every cursor is a high-water mark that only rises;',
      '4. Cost scales with how much is displayed, never with how much exists;',
      '5. After stage 10 the server must not touch plaintext.',
      '',
      '## Non-goals',
      '',
      '- No sharding or routing: everything runs in one process, cross-node connection routing is out;',
      '- No rate limiting or anti-spam — that is the `rate-limited-gateway` project;',
      '- No storage engine: segmented logs, indexes and delivery semantics are `message-broker`;',
      '- No resumable media uploads;',
      '- No real threads: concurrency is cooperative async with identical ordering semantics.',
      '',
      '## Glossary',
      '',
      '- Conversation: a set of people and the sequence of messages between them, two or many.',
      '- seq: a message\'s position in its conversation, dense from 1, assigned by the server.',
      '- clientMsgId: minted by the client before sending and unchanged across retries, so a resend is',
      '  recognisable.',
      '- Device cursor: how far the server has served one device; one per device.',
      '- Read cursor: how far a person has read; one per person, shared by their devices.',
      '- Write / read fan-out: writing into every member\'s inbox on send, versus computing it on read.',
      '- Envelope: ciphertext sealed for one device; one message becomes N envelopes.',
      '- Ratchet: the key position that advances on every seal, preventing nonce reuse.',
      '- Coalescing window: a period in which many events produce one push or one receipt round.',
    ].join('\n')
  ),
  architecture: t(
    [
      '```mermaid',
      'flowchart TD',
      '  DEV["设备"] --> C1["1 连接注册与心跳"]',
      '  C1 --> C2["2 会话序号与幂等落号"]',
      '  C2 --> C3["3 离线消息与增量拉取"]',
      '  C3 --> C4["4 每设备位点与多端同步"]',
      '  C4 --> C5["5 已读位点与未读数"]',
      '  C5 --> C6["6 送达与已读回执"]',
      '  C6 --> C7["7 写扩散与读扩散"]',
      '  C7 --> C8["8 在线状态与订阅"]',
      '  C8 --> C9["9 撤回与编辑"]',
      '  C9 --> C10["10 端到端加密"]',
      '  C10 --> C11["11 推送与唤醒"]',
      '  C11 --> C12["12 组装：一台 IM 服务器"]',
      '  C12 --> OUT["会话列表<br/>最后一条 + 未读 + 在线 + 回执"]',
      '```',
      '',
      '这是一条真正的依赖链，不是十二个并列的主题：',
      '箭头的意思是「后一关解决前一关留下的问题」。',
    ].join('\n'),
    [
      '```mermaid',
      'flowchart TD',
      '  DEV["a device"] --> C1["1 connections and heartbeats"]',
      '  C1 --> C2["2 conversation sequence, assigned once"]',
      '  C2 --> C3["3 offline backlog, bounded pull"]',
      '  C3 --> C4["4 per-device cursors and multi-device sync"]',
      '  C4 --> C5["5 read cursors and unread counts"]',
      '  C5 --> C6["6 delivery and read receipts"]',
      '  C6 --> C7["7 write versus read fan-out"]',
      '  C7 --> C8["8 presence and subscriptions"]',
      '  C8 --> C9["9 recall and edit"]',
      '  C9 --> C10["10 end-to-end encryption"]',
      '  C10 --> C11["11 waking a sleeping device"]',
      '  C11 --> C12["12 assembly: one IM server"]',
      '  C12 --> OUT["the conversation list<br/>last message + unread + presence + receipts"]',
      '```',
      '',
      'This is a real dependency chain rather than twelve parallel topics: each arrow means the next stage',
      'solves what the previous one left behind.',
    ].join('\n')
  ),
  files: [crypto, transport, store, pushGateway],
  stages: [
    stage1,
    stage2,
    stage3,
    stage4,
    stage5,
    stage6,
    stage7,
    stage8,
    stage9,
    stage10,
    stage11,
    stage12,
  ],
};
