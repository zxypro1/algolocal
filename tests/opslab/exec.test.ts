/**
 * kubectl exec 的通道
 *
 * 分三层：WebSocket 本身（握手 + 分帧）、k8s 的通道协议（v5.channel.k8s.io）、
 * 以及 Pod 里那个真的会跑命令的 shell。
 *
 * 真 kubectl 打进来的那一遍在 kubectl-integration.test.ts —— 这里证明的是
 * 「协议写对了」，那里证明的是「kubectl 接受」。
 */
import {
  OPCODE, WebSocketConnection, parseUpgrade, readFrame, upgradeResponse, writeFrame,
  type StreamServer,
} from '../../src/lib/opslab/net';
import { CHANNEL, EXEC_PROTOCOL, parseExecRequest, statusOf } from '../../src/lib/opslab/apiserver';
import { createExecHandler, normalizeCommand } from '../../src/lib/opslab/lab';
import { createOpsWorld } from '../../src/lib/opslab/lab';
import type { OpsWorldSpec } from '../../src/lib/engineering/types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function handshake(path = '/api/v1/namespaces/default/pods/web/exec?command=echo&command=hi'): string {
  return [
    `GET ${path} HTTP/1.1`,
    'Host: apiserver.opslab:6443',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    `Sec-WebSocket-Protocol: ${EXEC_PROTOCOL}`,
    '', '',
  ].join('\r\n');
}

describe('WebSocket 握手', () => {
  it('Sec-WebSocket-Accept 是 RFC 6455 里那个值', () => {
    const request = parseUpgrade(handshake())!;
    expect(request).toBeDefined();
    const response = upgradeResponse(request, EXEC_PROTOCOL);
    // RFC 6455 §1.3 的例子：key dGhlIHNhbXBsZSBub25jZQ== 对应这个 accept
    expect(response).toContain('Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    expect(response.startsWith('HTTP/1.1 101 Switching Protocols\r\n')).toBe(true);
    expect(response).toContain(`Sec-WebSocket-Protocol: ${EXEC_PROTOCOL}`);
  });

  it('请求没收全时先不动 —— 半个头不能当成握手失败', () => {
    expect(parseUpgrade('GET /x HTTP/1.1\r\nHost: a\r\n')).toBeUndefined();
  });
});

describe('分帧', () => {
  it('服务端发出去的帧不带掩码', () => {
    const frame = writeFrame(OPCODE.BINARY, encoder.encode('hi'));
    expect(frame[0]).toBe(0x82);
    expect(frame[1] & 0x80).toBe(0); // MASK 位是 0
    expect(frame[1] & 0x7f).toBe(2);
  });

  it('客户端发来的帧要解掩码', () => {
    const payload = encoder.encode('hello world');
    const mask = Uint8Array.from([0x1a, 0x2b, 0x3c, 0x4d]);
    const frame = new Uint8Array(6 + payload.length);
    frame[0] = 0x80 | OPCODE.BINARY;
    frame[1] = 0x80 | payload.length;
    frame.set(mask, 2);
    for (let i = 0; i < payload.length; i += 1) frame[6 + i] = payload[i] ^ mask[i % 4];

    const read = readFrame(frame)!;
    expect(read.consumed).toBe(frame.length);
    expect(decoder.decode(read.frame.payload)).toBe('hello world');
  });

  it('126~65535 字节用两字节长度', () => {
    const frame = writeFrame(OPCODE.BINARY, new Uint8Array(300));
    expect(frame[1] & 0x7f).toBe(126);
    expect((frame[2] << 8) | frame[3]).toBe(300);
    expect(readFrame(frame)!.frame.payload.length).toBe(300);
  });

  it('字节没到齐就返回 undefined，等下一批', () => {
    const frame = writeFrame(OPCODE.BINARY, encoder.encode('abcdef'));
    expect(readFrame(frame.subarray(0, 4))).toBeUndefined();
  });
});

describe('exec 请求的解析', () => {
  it('命名空间、Pod、容器、命令都从 URL 里来', () => {
    const request = parseExecRequest({
      method: 'GET', path: '/api/v1/namespaces/shop/pods/web-1/exec?container=app&command=sh&command=-c&command=ls+%2Ftmp&stdout=true&stderr=true',
      headers: {}, protocols: [],
    })!;
    expect(request).toMatchObject({
      namespace: 'shop', pod: 'web-1', container: 'app',
      command: ['sh', '-c', 'ls /tmp'], stdin: false, tty: false,
    });
  });

  it('不是 exec 的路径不认', () => {
    expect(parseExecRequest({
      method: 'GET', path: '/api/v1/namespaces/shop/pods/web-1/log', headers: {}, protocols: [],
    })).toBeUndefined();
  });
});

describe('3 号通道上的 Status', () => {
  const request = { namespace: 'default', pod: 'web', command: ['false'], stdin: false, tty: false };

  it('成功是 Success', () => {
    expect(statusOf(0, request)).toMatchObject({ status: 'Success' });
  });

  it('失败要带 NonZeroExitCode 和 ExitCode —— 少了退出码就永远是 0', () => {
    const status = statusOf(3, request) as any;
    expect(status.status).toBe('Failure');
    expect(status.reason).toBe('NonZeroExitCode');
    expect(status.details.causes).toContainEqual({ reason: 'ExitCode', message: '3' });
  });
});

describe('一整条连接', () => {
  /** 一个照着 gorilla 的样子说话的假客户端 */
  function connect(server: StreamServer) {
    const inbound: Uint8Array[] = [];
    let closed = false;
    const connection = new WebSocketConnection(server, (bytes) => inbound.push(bytes), () => { closed = true; });
    connection.receive(encoder.encode(handshake()));
    return {
      connection,
      get closed() { return closed; },
      /** 已经收到的东西：握手响应 + 之后的帧 */
      drain() {
        let all = new Uint8Array(0);
        for (const chunk of inbound) {
          const next = new Uint8Array(all.length + chunk.length);
          next.set(all); next.set(chunk, all.length);
          all = next;
        }
        const text = decoder.decode(all);
        const split = text.indexOf('\r\n\r\n');
        const head = text.slice(0, split + 4);
        let rest = all.subarray(encoder.encode(head).length);
        const frames: Array<{ channel: number; text: string }> = [];
        let closeCode: number | undefined;
        for (;;) {
          const read = readFrame(rest);
          if (!read) break;
          rest = rest.subarray(read.consumed);
          if (read.frame.opcode === OPCODE.CLOSE) {
            closeCode = (read.frame.payload[0] << 8) | read.frame.payload[1];
            continue;
          }
          frames.push({ channel: read.frame.payload[0], text: decoder.decode(read.frame.payload.subarray(1)) });
        }
        return { head, frames, closeCode };
      },
    };
  }

  it('stdout / stderr / Status 分在 1、2、3 号通道上', async () => {
    const server: StreamServer = {
      open: () => ({
        protocol: EXEC_PROTOCOL,
        start(send, close) {
          const write = (channel: number, text: string) => {
            const body = encoder.encode(text);
            const frame = new Uint8Array(body.length + 1);
            frame[0] = channel; frame.set(body, 1);
            send(OPCODE.BINARY, frame);
          };
          write(CHANNEL.STDOUT, 'out');
          write(CHANNEL.STDERR, 'err');
          write(CHANNEL.ERROR, JSON.stringify({ status: 'Success' }));
          close();
        },
      }),
    };
    const client = connect(server);
    const { head, frames, closeCode } = client.drain();
    expect(head).toContain('101 Switching Protocols');
    expect(frames).toEqual([
      { channel: CHANNEL.STDOUT, text: 'out' },
      { channel: CHANNEL.STDERR, text: 'err' },
      { channel: CHANNEL.ERROR, text: '{"status":"Success"}' },
    ]);
    // 收尾要发 CLOSE 帧。直接断链的话对端看到 1006 abnormal closure，
    // kubectl 会当成「连接坏了」报错，Status 里的退出码就丢了。
    expect(closeCode).toBe(1000);
    expect(client.closed).toBe(true);
  });

  it('服务端拒绝时回的是 HTTP 错误，不是 101', () => {
    const server: StreamServer = {
      open: () => ({ status: 404, reason: 'Not Found', body: '{"kind":"Status"}' }),
    };
    const client = connect(server);
    expect(client.drain().head).toContain('HTTP/1.1 404 Not Found');
    expect(client.closed).toBe(true);
  });
});

describe('argv 拼回一行', () => {
  it('sh -c 里那段本来就是一整条命令', () => {
    expect(normalizeCommand(['sh', '-c', 'curl -s portal | head -1'])).toBe('curl -s portal | head -1');
  });

  it('带空格的参数要包引号，不能被再拆一次', () => {
    expect(normalizeCommand(['echo', 'a b'])).toBe("echo 'a b'");
  });

  it('普通参数不加多余的引号', () => {
    expect(normalizeCommand(['curl', '-s', 'http://portal.shop.svc/health'])).toBe('curl -s http://portal.shop.svc/health');
  });
});

/* ------------------------------------------------------------------ */
/* Pod 里那个 shell                                                    */
/* ------------------------------------------------------------------ */

const WORLD: OpsWorldSpec = {
  namespaces: ['shop'],
  baseImages: { 'registry.corp.internal/portal:2.1': 'node' },
  objects: [
    {
      apiVersion: 'apps/v1', kind: 'Deployment',
      metadata: { name: 'portal', namespace: 'shop' },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app: 'portal' } },
        template: {
          metadata: { labels: { app: 'portal' } },
          spec: { containers: [{
            name: 'app', image: 'registry.corp.internal/portal:2.1',
            ports: [{ containerPort: 8080 }], env: [{ name: 'TIER', value: 'web' }],
          }] },
        },
      },
    },
    {
      apiVersion: 'v1', kind: 'Service',
      metadata: { name: 'portal', namespace: 'shop' },
      spec: { selector: { app: 'portal' }, ports: [{ port: 80, targetPort: 8080 }] },
    },
  ],
};

async function podWorld() {
  const world = await createOpsWorld({ world: WORLD });
  await world.cluster.advanceBy(30_000);
  const pods = world.cluster.registry.list(
    world.cluster.scheme.get({ group: '', version: 'v1', resource: 'pods' })!, { namespace: 'shop' }
  );
  return { world, pod: pods.items[0] };
}

describe('Pod 里的 shell', () => {
  it('容器里能看到自己的 resolv.conf 和 hostname', async () => {
    const { world, pod } = await podWorld();
    const exec = createExecHandler(world.cluster);
    const result = await exec(
      { namespace: 'shop', pod: pod.metadata.name!, command: ['cat', '/etc/resolv.conf'], stdin: false, tty: false },
      ''
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('search shop.svc.cluster.local svc.cluster.local cluster.local');
    expect(result.stdout).toContain('options ndots:5');
  });

  it('stdin 喂得进去', async () => {
    const { world, pod } = await podWorld();
    const exec = createExecHandler(world.cluster);
    const result = await exec(
      { namespace: 'shop', pod: pod.metadata.name!, command: ['cat'], stdin: true, tty: false },
      'from outside\n'
    );
    expect(result.stdout).toBe('from outside\n');
  });

  it('容器的 env 进得来', async () => {
    const { world, pod } = await podWorld();
    const exec = createExecHandler(world.cluster);
    const result = await exec(
      { namespace: 'shop', pod: pod.metadata.name!, command: ['sh', '-c', 'echo $TIER'], stdin: false, tty: false },
      ''
    );
    expect(result.stdout.trim()).toBe('web');
  });

  it('从 Pod 里 curl 同命名空间的短名 —— 这条从跳板机上是打不通的', async () => {
    const { world, pod } = await podWorld();
    const exec = createExecHandler(world.cluster);
    const result = await exec(
      { namespace: 'shop', pod: pod.metadata.name!, command: ['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', 'http://portal'], stdin: false, tty: false },
      ''
    );
    expect(result.stdout).toBe('200');
    expect(result.code).toBe(0);
  });

  it('Pod 不存在时报的是 NotFound', async () => {
    const { world } = await podWorld();
    const exec = createExecHandler(world.cluster);
    const result = await exec(
      { namespace: 'shop', pod: 'nope', command: ['echo', 'hi'], stdin: false, tty: false },
      ''
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('pods "nope" not found');
  });

  it('指定了不存在的容器要报出来，不能悄悄换一个', async () => {
    const { world, pod } = await podWorld();
    const exec = createExecHandler(world.cluster);
    const result = await exec(
      { namespace: 'shop', pod: pod.metadata.name!, container: 'sidecar', command: ['echo', 'hi'], stdin: false, tty: false },
      ''
    );
    expect(result.stderr).toContain('container sidecar is not valid for pod');
  });
});
