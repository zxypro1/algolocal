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

export interface WorkbenchTerminalProps {
  /** 提示符，例如 `ops@ops-ws:~/infra$ ` */
  prompt: string;
  /** 执行一条命令，返回要打印的文本 */
  onCommand: (line: string) => Promise<string>;
  /** 终端就绪后打印的欢迎信息 */
  banner?: string;
  /**
   * 把「往输入行里插一条命令」这个能力交给外面。
   *
   * 拓扑图上点一个节点要把 `kubectl describe ...` 送进来 —— 但只是**填进去**，
   * 不替学员回车。命令是他自己敲下去的，这一点在教学上不能含糊。
   */
  registerInsert?: (insert: ((command: string) => void) | null) => void;
}

export default function WorkbenchTerminal(
  { prompt, onCommand, banner, registerInsert }: WorkbenchTerminalProps
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  // 命令执行期间不接受新输入，也不重画提示符
  const busyRef = useRef(false);
  /*
   * 每条命令一个编号，Ctrl+C 时 +1。
   *
   * 用来**放弃**一条还在跑的命令：它的 Promise 落地时编号已经不是自己那个了，
   * 于是输出被丢掉、提示符也不重画。少了这个，Ctrl+C 之后那条命令回来时
   * 会把输出打在新的提示符后面，看起来像凭空冒出来的。
   */
  const runIdRef = useRef(0);
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
      termRef.current = term;

      /**
       * 有尺寸了再 fit。
       *
       * 容器宽度为 0 的时候（首帧还没布局完、或者它待在一个隐藏的 tab 里）
       * fit 会算出一两列，于是提示符被压成每行两个字符 —— v0.16.0 里就是这个样子。
       * 这两种情况都会在拿到尺寸后触发 ResizeObserver，等那一下就行。
       */
      const fitIfSized = () => {
        const host = hostRef.current;
        const active = termRef.current;
        if (!host || !active) return false;
        const { width, height } = host.getBoundingClientRect();
        if (width < 80 || height < 40) return false;
        try {
          // 算出来跟现在一样就别 resize：fit 会改元素尺寸，而这个函数正是
          // ResizeObserver 调的 —— 白 resize 一次就多绕一圈，浏览器会刷
          // 「ResizeObserver loop completed with undelivered notifications」
          const proposed = fit.proposeDimensions();
          if (!proposed?.cols || !proposed?.rows) return false;
          if (proposed.cols === active.cols && proposed.rows === active.rows) {
            // 行列数没变，但走到这儿说明元素尺寸变了 —— 多半是从隐藏的 tab 里
            // 切回来。fit 会顺带触发重绘，跳过它就得自己补一次，
            // 否则 DOM 渲染器留着一屏空行。
            active.refresh(0, active.rows - 1);
            return true;
          }
          fit.fit();
          return true;
        } catch {
          return false;
        }
      };

      resizeObserver = new ResizeObserver(() => { fitIfSized(); });
      resizeObserver.observe(hostRef.current);

      // 开场白也要等宽度定下来再写，否则它按错误的列宽折行，之后再 fit 也回不去
      const openingScreen = () => {
        if (banner) term!.write(banner);
        writePrompt(term!);
      };
      if (fitIfSized()) {
        openingScreen();
      } else {
        let frames = 0;
        const wait = () => {
          if (disposed || !termRef.current) return;
          if (fitIfSized() || frames > 120) {
            openingScreen();
            return;
          }
          frames += 1;
          requestAnimationFrame(wait);
        };
        requestAnimationFrame(wait);
      }

      term.onData(async (data) => {
        const active = term;
        if (!active) return;

        /*
         * **Ctrl+C 要在 busy 检查之前处理。**
         *
         * 之前它在后面，于是命令一旦挂住（比如一段跑不完的用户代码），
         * 所有输入都被丢掉、包括 Ctrl+C —— 终端永久卡死，唯一的出路是刷新页面，
         * 而刷新会连带丢掉工作台里的状态。这是在 llmlab 手点时撞见的。
         */
        if (data === KEY_CTRL_C) {
          if (busyRef.current) {
            runIdRef.current += 1;   // 让那条还在跑的命令的输出作废
            busyRef.current = false;
            active.write('^C\r\n');
            lineRef.current = '';
            writePrompt(active);
            return;
          }
          active.write('^C');
          lineRef.current = '';
          writePrompt(active);
          return;
        }

        if (busyRef.current) return;

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
          const runId = (runIdRef.current += 1);
          busyRef.current = true;
          try {
            const out = await onCommandRef.current(line);
            // 期间按过 Ctrl+C 的话，这条命令已经被放弃了，输出不要再打出来
            if (runId !== runIdRef.current) return;
            if (out) active.write(out);
          } catch (error) {
            if (runId !== runIdRef.current) return;
            active.write(`${RED}${String((error as Error)?.message || error)}${RESET}`);
          } finally {
            if (runId === runIdRef.current) {
              busyRef.current = false;
              writePrompt(active);
            }
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
      termRef.current = null;
    };
  }, [banner, prompt, writePrompt]);

  // 只填进输入行，不替学员回车
  useEffect(() => {
    if (!registerInsert) return;
    registerInsert((command: string) => {
      const term = termRef.current;
      if (!term || busyRef.current) return;
      lineRef.current = command;
      term.write(`\r${CLEAR_LINE}${BLUE}${prompt}${RESET}${command}`);
      term.focus();
    });
    return () => registerInsert(null);
  }, [registerInsert, prompt]);

  /*
   * 点面板的任何地方都聚焦到终端。
   *
   * xterm 自己的元素只盖住它渲染的那几行 —— 底下的空白和外面这层 padding
   * 都不是它的，点上去焦点不会进来，于是**敲字有反应、回车没反应**
   * （字进了 xterm 的缓冲，Enter 却没被它的 keydown 接住）。
   * 对着一个黑框敲不动而又不报错，是最难自己想明白的那种卡住。
   *
   * 用 mouseup 而不是 mousedown，并且拖出了选区就不抢焦点 ——
   * 否则「拖着选一段输出去复制」会在松手时被清掉。
   */
  const focusTerminal = () => {
    const term = termRef.current;
    if (!term || term.hasSelection()) return;
    term.focus();
  };

  return (
    <div
      ref={hostRef}
      onMouseUp={focusTerminal}
      style={{ width: '100%', height: '100%', background: '#12161f', padding: 8, cursor: 'text' }}
    />
  );
}
