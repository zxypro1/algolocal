/**
 * 内网机器的终端
 *
 * xterm.js 负责渲染与行编辑，命令怎么执行由外面传进来的 onCommand 决定。
 * 这一层只管终端本身：提示符、历史、Ctrl+C、退格、自适应大小。
 */
import { useCallback, useEffect, useRef } from 'react';
import type { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

// 键盘输入用显式转义写，源码里放字面控制字符不可读也容易被编辑器改坏
const KEY_ENTER = '\r';
const KEY_BACKSPACE = '\x7f';
const KEY_CTRL_C = '\x03';
const KEY_UP = '\x1b[A';
const KEY_DOWN = '\x1b[B';

const ESC = '\x1b';
const BLUE = `${ESC}[1;34m`;
const RED = `${ESC}[31m`;
const RESET = `${ESC}[0m`;
const CLEAR_LINE = `${ESC}[K`;

export interface OpsTerminalProps {
  /** 提示符，例如 `ops@ops-ws:~/infra$ ` */
  prompt: string;
  /** 执行一条命令，返回要打印的文本 */
  onCommand: (line: string) => Promise<string>;
  /** 终端就绪后打印的欢迎信息 */
  banner?: string;
}

export default function OpsTerminal({ prompt, onCommand, banner }: OpsTerminalProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  // 命令执行期间不接受新输入，也不重画提示符
  const busyRef = useRef(false);
  const lineRef = useRef('');
  const historyRef = useRef<string[]>([]);
  const historyPosRef = useRef(0);
  const onCommandRef = useRef(onCommand);
  onCommandRef.current = onCommand;

  const writePrompt = useCallback(
    (term: Terminal) => term.write(`\r\n${BLUE}${prompt}${RESET}`),
    [prompt]
  );

  useEffect(() => {
    if (!hostRef.current) return;
    let disposed = false;
    let term: Terminal | null = null;
    let resizeObserver: ResizeObserver | null = null;

    (async () => {
      // xterm 只能在浏览器里加载
      const [{ Terminal: XTerm }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      if (disposed || !hostRef.current) return;

      term = new XTerm({
        fontFamily: '"JetBrains Mono", SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 13,
        cursorBlink: true,
        convertEol: true,
        theme: { background: '#12161f', foreground: '#c8d2e4', cursor: '#c8d2e4' },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      fit.fit();

      resizeObserver = new ResizeObserver(() => {
        // 容器还没完成布局时 fit 会抛，忽略即可
        try { fit.fit(); } catch { /* noop */ }
      });
      resizeObserver.observe(hostRef.current);

      if (banner) term.write(banner);
      writePrompt(term);

      term.onData(async (data) => {
        const active = term;
        if (!active || busyRef.current) return;

        if (data === KEY_ENTER) {
          const line = lineRef.current.trim();
          lineRef.current = '';
          active.write('\r\n');
          if (!line) {
            writePrompt(active);
            return;
          }

          historyRef.current.push(line);
          historyPosRef.current = historyRef.current.length;
          busyRef.current = true;
          try {
            const out = await onCommandRef.current(line);
            if (out) active.write(out);
          } catch (error) {
            active.write(`${RED}${String((error as Error)?.message || error)}${RESET}`);
          } finally {
            busyRef.current = false;
            writePrompt(active);
          }
          return;
        }

        if (data === KEY_BACKSPACE) {
          if (lineRef.current.length > 0) {
            lineRef.current = lineRef.current.slice(0, -1);
            active.write('\b \b');
          }
          return;
        }

        if (data === KEY_CTRL_C) {
          active.write('^C');
          lineRef.current = '';
          writePrompt(active);
          return;
        }

        if (data === KEY_UP || data === KEY_DOWN) {
          const history = historyRef.current;
          if (!history.length) return;
          historyPosRef.current = data === KEY_UP
            ? Math.max(0, historyPosRef.current - 1)
            : Math.min(history.length, historyPosRef.current + 1);
          const next = history[historyPosRef.current] ?? '';
          active.write(`\r${CLEAR_LINE}${BLUE}${prompt}${RESET}${next}`);
          lineRef.current = next;
          return;
        }

        if (data >= ' ') {
          lineRef.current += data;
          active.write(data);
        }
      });
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      term?.dispose();
    };
  }, [banner, prompt, writePrompt]);

  return <div ref={hostRef} style={{ width: '100%', height: '100%', background: '#12161f', padding: 8 }} />;
}
