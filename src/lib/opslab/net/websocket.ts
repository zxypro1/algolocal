/**
 * 内存里的 WebSocket 服务端
 *
 * `kubectl exec` / `logs -f` / `port-forward` 走的都是 WebSocket。客户端那边
 * 是真的 gorilla + 真的 client-go remotecommand，所以这一侧必须把协议真的实现：
 * 握手要算对 `Sec-WebSocket-Accept`，帧要真的分（客户端发来的帧带掩码，
 * 服务端回的不带）。
 *
 * 只做够用的那部分：文本/二进制帧、close、ping/pong，不做分片续帧
 * （k8s 的通道协议不会用到）。
 */
import { sha1 } from '../crypto/sha1';

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface UpgradeRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  /** 客户端要求的子协议，按优先级 */
  protocols: string[];
}

/** 把 HTTP 升级请求解出来。收到的字节不完整就返回 undefined，等下一批。 */
export function parseUpgrade(text: string): UpgradeRequest | undefined {
  const end = text.indexOf('\r\n\r\n');
  if (end < 0) return undefined;

  const lines = text.slice(0, end).split('\r\n');
  const [method, path] = lines[0].split(' ');
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':');
    if (index < 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return {
    method,
    path,
    headers,
    protocols: (headers['sec-websocket-protocol'] ?? '')
      .split(',').map((entry) => entry.trim()).filter(Boolean),
  };
}

/** 101 响应。`Sec-WebSocket-Accept` 算错的话 gorilla 会直接拒绝握手。 */
export function upgradeResponse(request: UpgradeRequest, protocol?: string): string {
  const accept = base64(sha1(`${request.headers['sec-websocket-key'] ?? ''}${MAGIC}`));
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []),
    '', '',
  ].join('\r\n');
}

export function rejectResponse(status: number, reason: string, body: string): string {
  return [
    `HTTP/1.1 ${status} ${reason}`,
    'Content-Type: application/json',
    `Content-Length: ${body.length}`,
    '', body,
  ].join('\r\n');
}

export const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa } as const;

export interface Frame {
  opcode: number;
  payload: Uint8Array;
  fin: boolean;
}

/** 从缓冲区里拆出一帧。不够一帧就返回 undefined。 */
export function readFrame(buffer: Uint8Array): { frame: Frame; consumed: number } | undefined {
  if (buffer.length < 2) return undefined;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return undefined;
    length = (buffer[offset] << 8) | buffer[offset + 1];
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return undefined;
    // 高 4 字节我们不会用到（帧不会大到 4GB）
    length = 0;
    for (let i = 4; i < 8; i += 1) length = (length << 8) | buffer[offset + i];
    offset += 8;
  }

  const maskStart = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return undefined;

  const payload = buffer.slice(offset, offset + length);
  if (masked) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= buffer[maskStart + (i % 4)];
  }
  return { frame: { opcode, payload, fin }, consumed: offset + length };
}

/** 服务端发出去的帧不带掩码 */
export function writeFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const header: number[] = [0x80 | opcode];
  if (payload.length < 126) header.push(payload.length);
  else if (payload.length < 65536) header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
  else {
    header.push(127, 0, 0, 0, 0,
      (payload.length >>> 24) & 0xff, (payload.length >>> 16) & 0xff,
      (payload.length >>> 8) & 0xff, payload.length & 0xff);
  }
  const out = new Uint8Array(header.length + payload.length);
  out.set(header);
  out.set(payload, header.length);
  return out;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* ------------------------------------------------------------------ */
/* 一条连接                                                            */
/* ------------------------------------------------------------------ */

export interface StreamSession {
  /** 服务端选中的子协议 */
  protocol?: string;
  /** 客户端发来的一帧 */
  onFrame?(opcode: number, payload: Uint8Array): void;
  /** 握手完成，可以往回推数据了 */
  start?(send: (opcode: number, payload: Uint8Array) => void, close: () => void): void;
  /** 连接断了 */
  onClose?(): void;
}

export interface StreamServer {
  /** 收到升级请求。返回 undefined 表示拒绝（会回一个 HTTP 错误）。 */
  open(request: UpgradeRequest): StreamSession | { status: number; reason: string; body: string } | undefined;
}

/**
 * 宿主这边的一条 WebSocket 连接。
 *
 * 客户端（wasm 里的 gorilla）把字节写进来，这里做握手与分帧，再把 payload
 * 交给会话。会话往回写的东西同样要打成帧。
 */
export class WebSocketConnection {
  private buffer = new Uint8Array(0);
  private session?: StreamSession;
  private upgraded = false;
  private closed = false;
  private closeSent = false;

  constructor(
    private readonly server: StreamServer,
    private readonly emit: (bytes: Uint8Array) => void,
    private readonly onClosed: () => void
  ) {}

  /** 客户端写进来的字节 */
  receive(bytes: Uint8Array): void {
    if (this.closed) return;
    this.buffer = concatBytes(this.buffer, bytes);
    if (!this.upgraded) {
      this.tryUpgrade();
      return;
    }
    this.drainFrames();
  }

  /**
   * 收尾。
   *
   * 必须先发一个 CLOSE 帧再断。直接断链的话对端看到的是 1006
   * abnormal closure —— kubectl 会把它当成「连接出问题了」报错，
   * 而不是「命令跑完了」，退出码也就丢了。
   */
  close(code = 1000): void {
    if (this.closed) return;
    if (this.upgraded && !this.closeSent) {
      this.closeSent = true;
      this.emit(writeFrame(OPCODE.CLOSE, Uint8Array.from([(code >> 8) & 0xff, code & 0xff])));
    }
    this.closed = true;
    this.session?.onClose?.();
    this.onClosed();
  }

  private tryUpgrade(): void {
    const text = new TextDecoder().decode(this.buffer);
    const request = parseUpgrade(text);
    if (!request) return;

    const outcome = this.server.open(request);
    if (!outcome || 'status' in outcome) {
      const error = outcome ?? { status: 404, reason: 'Not Found', body: '{}' };
      this.emit(new TextEncoder().encode(rejectResponse(error.status, error.reason, error.body)));
      this.close();
      return;
    }

    this.session = outcome;
    this.upgraded = true;
    this.buffer = this.buffer.subarray(text.indexOf('\r\n\r\n') + 4);
    this.emit(new TextEncoder().encode(upgradeResponse(request, outcome.protocol)));

    outcome.start?.(
      (opcode, payload) => { if (!this.closed) this.emit(writeFrame(opcode, payload)); },
      () => this.close()
    );
    this.drainFrames();
  }

  private drainFrames(): void {
    for (;;) {
      const next = readFrame(this.buffer);
      if (!next) return;
      this.buffer = this.buffer.subarray(next.consumed);

      const { opcode, payload } = next.frame;
      if (opcode === OPCODE.CLOSE) {
        // 对端先关：把它的状态码原样回过去，这是 RFC 6455 的握手收尾
        this.emit(writeFrame(OPCODE.CLOSE, payload));
        this.closeSent = true;
        this.close();
        return;
      }
      if (opcode === OPCODE.PING) { this.emit(writeFrame(OPCODE.PONG, payload)); continue; }
      if (opcode === OPCODE.PONG) continue;
      this.session?.onFrame?.(opcode, payload);
    }
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}
