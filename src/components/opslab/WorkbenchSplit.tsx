/**
 * 左右两栏，中间一根能拖的分隔条
 *
 * 之前这块布局是写死的（左边 340px、右边按百分比分），学员想把任务描述收起来
 * 多看两眼终端都做不到。这里补上三件事：拖动改宽度、一键收起左栏、
 * 以及把这两样记在 localStorage 里 —— 换一关、重开应用都还在。
 *
 * 没有引第三方的分栏库：需要的行为就这么点，而多一个依赖就多一份要跟着
 * React / Mantine 版本走的东西。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionIcon, Tooltip } from '@mantine/core';
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from '@tabler/icons-react';

export interface WorkbenchSplitProps {
  /** localStorage 的键。不同工作台各记各的。 */
  storageKey: string;
  left: React.ReactNode;
  right: React.ReactNode;
  defaultLeftWidth?: number;
  minLeftWidth?: number;
  /** 右栏至少留这么宽，拖到头就不让再拖了 */
  minRightWidth?: number;
  /** 收起时鼠标悬停在展开按钮上的提示 */
  collapseLabel?: string;
}

interface Persisted {
  width: number;
  collapsed: boolean;
}

function read(storageKey: string): Persisted | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    if (typeof parsed.width !== 'number' || !Number.isFinite(parsed.width)) return null;
    return { width: parsed.width, collapsed: Boolean(parsed.collapsed) };
  } catch {
    // 隐私模式下 localStorage 会抛。读不到就用默认布局，不该因此白屏。
    return null;
  }
}

function write(storageKey: string, value: Persisted): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    /* noop */
  }
}

export default function WorkbenchSplit({
  storageKey,
  left,
  right,
  defaultLeftWidth = 340,
  minLeftWidth = 240,
  minRightWidth = 480,
  collapseLabel = '展开左栏',
}: WorkbenchSplitProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(defaultLeftWidth);
  const [collapsed, setCollapsed] = useState(false);
  const [dragging, setDragging] = useState(false);

  /**
   * 存的值只能在挂载之后读。
   *
   * 服务端没有 localStorage，直接在 useState 的初值里读会让首屏 HTML 和
   * 客户端第一次渲染对不上，React 会整棵子树重画（hydration mismatch）。
   */
  useEffect(() => {
    const saved = read(storageKey);
    if (!saved) return;
    setWidth(saved.width);
    setCollapsed(saved.collapsed);
  }, [storageKey]);

  // 落盘要读「此刻」的值，但不该因此把 persist 变成每次渲染都新建的函数
  const widthRef = useRef(width);
  widthRef.current = width;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  const persist = useCallback((next: Partial<Persisted>) => {
    write(storageKey, {
      width: next.width ?? widthRef.current,
      collapsed: next.collapsed ?? collapsedRef.current,
    });
  }, [storageKey]);

  const clamp = useCallback((value: number) => {
    const total = containerRef.current?.getBoundingClientRect().width ?? 0;
    const max = Math.max(minLeftWidth, total - minRightWidth);
    return Math.min(Math.max(value, minLeftWidth), max);
  }, [minLeftWidth, minRightWidth]);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (collapsed) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    setDragging(true);

    const startX = event.clientX;
    const startWidth = width;

    const onMove = (move: PointerEvent) => {
      setWidth(clamp(startWidth + (move.clientX - startX)));
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      setDragging(false);
      // 拖完才落盘：拖动过程中每帧写一次 localStorage 是纯浪费
      persist({ width: widthRef.current });
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }, [clamp, collapsed, persist, width]);

  const toggle = useCallback(() => {
    const next = !collapsedRef.current;
    setCollapsed(next);
    persist({ collapsed: next });
  }, [persist]);

  return (
    <div ref={containerRef} style={{ flex: 1, display: 'flex', minHeight: 0, minWidth: 0 }}>
      {!collapsed && (
        <div
          style={{
            width,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            minWidth: 0,
            overflow: 'hidden',
          }}
        >
          {left}
        </div>
      )}

      {/**
       * 分隔条兼作收起按钮的锚点。
       *
       * 命中区域比看到的那条线宽（6px），不然要精确对准 1px 才拖得动。
       */}
      <div
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onPointerDown}
        onDoubleClick={toggle}
        style={{
          width: 6,
          flexShrink: 0,
          cursor: collapsed ? 'default' : 'col-resize',
          background: dragging ? 'var(--mantine-color-blue-5)' : 'var(--app-border)',
          position: 'relative',
          transition: dragging ? undefined : 'background 120ms',
        }}
      >
        <Tooltip label={collapsed ? collapseLabel : '收起左栏（也可以双击分隔条）'} position="right">
          <ActionIcon
            size="xs"
            variant="default"
            onClick={toggle}
            onPointerDown={(event) => event.stopPropagation()}
            /**
             * 收起之后分隔条贴在窗口最左边，按钮再往左偏 9px 就跑到屏幕外面去了 ——
             * 那样这一栏就再也展不开（只剩双击那 6px 一条缝）。收起时把它挪到右边。
             */
            style={{ position: 'absolute', top: 8, left: collapsed ? 4 : -9, zIndex: 2 }}
          >
            {collapsed
              ? <IconLayoutSidebarLeftExpand size={12} />
              : <IconLayoutSidebarLeftCollapse size={12} />}
          </ActionIcon>
        </Tooltip>
      </div>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {right}
      </div>
    </div>
  );
}
