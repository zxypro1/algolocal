import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActionIcon, Badge, Box, Group, Menu, ScrollArea, Text, Tooltip } from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconChevronDown,
  IconChevronRight,
  IconDeviceFloppy,
  IconDotsVertical,
  IconGitCompare,
  IconFileCode,
  IconFolder,
  IconFolderOpen,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconLock,
  IconMap2,
  IconSearch,
  IconTextWrap,
  IconWand,
  IconX,
} from '@tabler/icons-react';
import Editor, { DiffEditor, useMonaco } from '@monaco-editor/react';
import { useTheme } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/I18nContext';
import {
  buildFileTree,
  defaultOpenPath,
  fileLanguage,
  FileTreeNode,
  reconcileOpenFiles,
} from '../../lib/engineering/workspace';
import { configureMonacoForWorkspace } from './labTypings';
import {
  DEFAULT_PREFS,
  EditorPrefs,
  fileAccent,
  FONT_SIZE_RANGE,
  loadEditorPrefs,
  saveEditorPrefs,
} from '../../lib/editorPrefs';
import QuickOpen from './QuickOpen';
import type { WorkspaceFile } from '../../lib/engineering/types';

interface WorkspaceEditorProps {
  files: WorkspaceFile[];
  /** 各文件的初始内容，用来判断「改过没有」和支持单文件还原 */
  pristine: Record<string, string>;
  onChange: (path: string, content: string) => void;
  onResetFile?: (path: string) => void;
  /** Cmd/Ctrl + S 或 Cmd/Ctrl + Enter 触发 */
  onRun?: () => void;
  isRunning?: boolean;
  /** 最近一次写入本地存储的时间，用来告诉用户「已经存好了」 */
  savedAt?: number;
  /** 还没落盘的文件。落盘是防抖的，所以这个状态是真实存在的 */
  unsavedPaths?: Set<string>;
  /** Cmd/Ctrl + S：立刻落盘 */
  onSaveNow?: () => void;
}

const EMPTY_SET: Set<string> = new Set();

interface MarkerCount {
  errors: number;
  warnings: number;
}

/* ------------------------------------------------------------------ */
/* 文件树                                                              */
/* ------------------------------------------------------------------ */

function FileTree({
  nodes,
  activePath,
  dirtyPaths,
  markers,
  collapsed,
  onToggleDir,
  onSelect,
  depth = 0,
}: {
  nodes: FileTreeNode[];
  activePath: string;
  dirtyPaths: Set<string>;
  markers: Record<string, MarkerCount>;
  collapsed: Record<string, boolean>;
  onToggleDir: (path: string) => void;
  onSelect: (path: string) => void;
  depth?: number;
}) {
  return (
    <>
      {nodes.map((node) => {
        if (node.type === 'directory') {
          const isCollapsed = collapsed[node.path];
          return (
            <Box key={node.path}>
              <Group
                className="ide-tree-row"
                gap={4}
                wrap="nowrap"
                py={3}
                style={{ paddingLeft: 6 + depth * 11, paddingRight: 6 }}
                onClick={() => onToggleDir(node.path)}
              >
                {isCollapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
                {isCollapsed ? (
                  <IconFolder size={13} opacity={0.75} />
                ) : (
                  <IconFolderOpen size={13} opacity={0.75} />
                )}
                <Text size="xs" fw={500} truncate>
                  {node.name}
                </Text>
              </Group>

              {!isCollapsed && (
                <FileTree
                  nodes={node.children || []}
                  activePath={activePath}
                  dirtyPaths={dirtyPaths}
                  markers={markers}
                  collapsed={collapsed}
                  onToggleDir={onToggleDir}
                  onSelect={onSelect}
                  depth={depth + 1}
                />
              )}
            </Box>
          );
        }

        const isActive = node.path === activePath;
        const isDirty = dirtyPaths.has(node.path);
        const marker = markers[node.path];

        return (
          <Group
            key={node.path}
            className="ide-tree-row"
            data-active={isActive || undefined}
            data-edited={isDirty || undefined}
            gap={5}
            wrap="nowrap"
            py={3}
            style={{ paddingLeft: 6 + depth * 11, paddingRight: 6 }}
            onClick={() => onSelect(node.path)}
          >
            <IconFileCode size={13} color={fileAccent(node.path)} style={{ flexShrink: 0 }} />
            <Text size="xs" truncate fw={isActive ? 600 : 400} style={{ flex: 1 }}>
              {node.name}
            </Text>

            {marker?.errors ? (
              <Text size="xs" c="red" fw={600}>
                {marker.errors}
              </Text>
            ) : null}
            {node.readonly && <IconLock size={10} style={{ flexShrink: 0, opacity: 0.55 }} />}
          </Group>
        );
      })}
    </>
  );
}

/* ------------------------------------------------------------------ */

/**
 * 把整个工作区都建成 Monaco model。
 *
 * 语言服务只看得见已经存在的 model。如果只给当前打开的文件建 model，题目自带的
 * `import type { PageResult } from './contract'` 一进来就报「Cannot find module」，
 * 跨文件补全和跳转也一并失效。
 *
 * 同时清掉不属于当前工作区的旧 model（换关卡、换语言、换工程留下的）：留着的话它们
 * 会继续参与类型检查，而且下次打开同名文件时会被复用，把上一个工程的内容带回来。
 *
 * `keep` 是编辑器当前挂着的那个 model，它的内容归编辑器自己管，不在这里改也不销毁。
 */
function syncWorkspaceModels(monaco: any, files: WorkspaceFile[], keep?: any): void {
  const wanted = new Set<string>();

  for (const file of files) {
    const uri = monaco.Uri.parse(`file:///${file.path}`);
    wanted.add(uri.toString());

    const existing = monaco.editor.getModel(uri);
    if (!existing) {
      monaco.editor.createModel(file.content, fileLanguage(file.path), uri);
    } else if (existing !== keep && existing.getValue() !== file.content) {
      existing.setValue(file.content);
    }
  }

  for (const model of monaco.editor.getModels()) {
    // 算法题那边用的是 problem:// ，只清自己的
    if (model === keep || model.uri.scheme !== 'file') continue;
    if (!wanted.has(model.uri.toString())) model.dispose();
  }
}

export default function WorkspaceEditor({
  files,
  pristine,
  onChange,
  onResetFile,
  onRun,
  isRunning,
  savedAt,
  unsavedPaths,
  onSaveNow,
}: WorkspaceEditorProps) {
  const { colorScheme } = useTheme();
  const { t } = useTranslation();

  const [prefs, setPrefs] = useState<EditorPrefs>(DEFAULT_PREFS);
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({});
  const [quickOpen, setQuickOpen] = useState(false);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [markers, setMarkers] = useState<Record<string, MarkerCount>>({});
  const [draggingSidebar, setDraggingSidebar] = useState(false);
  const [diffMode, setDiffMode] = useState(false);

  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const disposablesRef = useRef<any[]>([]);
  // onRun 会随页面状态重建，用 ref 保证 Monaco 里注册的命令始终调到最新的那个
  const runRef = useRef(onRun);
  runRef.current = onRun;
  const saveRef = useRef(onSaveNow);
  saveRef.current = onSaveNow;
  // beforeMount 拿不到当前渲染的 props，用 ref 带过去
  const filesRef = useRef(files);
  filesRef.current = files;

  const unsaved = unsavedPaths ?? EMPTY_SET;

  /* ---------------- 工作区的 Monaco model ---------------- */

  const monaco = useMonaco();

  useEffect(() => {
    if (!monaco) return;
    syncWorkspaceModels(monaco, files, editorRef.current?.getModel());
  }, [monaco, files]);

  /** 必须在编辑器创建之前跑一次：它会按路径复用已有 model，而旧 model 可能带着上一个工程的内容 */
  const handleBeforeMount = useCallback((monacoInstance: any) => {
    configureMonacoForWorkspace(monacoInstance);
    syncWorkspaceModels(monacoInstance, filesRef.current);
  }, []);

  useEffect(() => {
    setPrefs(loadEditorPrefs());
  }, []);

  const updatePrefs = useCallback((patch: Partial<EditorPrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      saveEditorPrefs(next);
      return next;
    });
  }, []);

  /* ---------------- 打开的文件 ---------------- */

  const defaultPath = useMemo(() => defaultOpenPath(files), [files]);

  const [activePath, setActivePath] = useState(defaultPath);
  const [openPaths, setOpenPaths] = useState<string[]>(defaultPath ? [defaultPath] : []);

  /** 文件集合的指纹。打字只改内容不改它，所以下面这段不会被每次输入触发 */
  const pathsKey = useMemo(() => files.map((file) => file.path).join('|'), [files]);
  const knownPathsRef = useRef(pathsKey);

  /**
   * 文件集合变了：换关卡、换语言或换工程。标签和当前文件一起算，一起写。
   *
   * 早先这里是两个 effect，各自读一遍 openPaths。后一个读到的是同一次提交里的
   * 旧值，于是把默认文件塞了两遍：标签栏出现两个同名标签（React 还会因为 key
   * 重复报警），点哪一个都是同一个文件。
   */
  useEffect(() => {
    if (pathsKey === knownPathsRef.current) return;
    const previousPaths = knownPathsRef.current.split('|').filter(Boolean);
    knownPathsRef.current = pathsKey;

    const next = reconcileOpenFiles({
      previousPaths,
      paths: pathsKey.split('|').filter(Boolean),
      defaultPath,
      openPaths,
      activePath,
    });
    setOpenPaths(next.openPaths);
    setActivePath(next.activePath);
  }, [pathsKey, defaultPath, openPaths, activePath]);

  const activeFile = files.find((file) => file.path === activePath);

  const openFile = useCallback((path: string) => {
    setActivePath(path);
    setDiffMode(false);
    setOpenPaths((prev) => (prev.includes(path) ? prev : [...prev, path]));
  }, []);

  const closeFile = useCallback(
    (path: string) => {
      setOpenPaths((prev) => {
        const next = prev.filter((item) => item !== path);
        if (path === activePath) setActivePath(next[next.length - 1] || '');
        return next;
      });
    },
    [activePath]
  );

  /* ---------------- 改动状态 ---------------- */

  const dirtyPaths = useMemo(() => {
    const dirty = new Set<string>();
    for (const file of files) {
      if (file.readonly) continue;
      const original = pristine[file.path];
      if (original !== undefined && original !== file.content) dirty.add(file.path);
    }
    return dirty;
  }, [files, pristine]);

  const totalProblems = useMemo(
    () => Object.values(markers).reduce((sum, item) => sum + item.errors, 0),
    [markers]
  );

  /* ---------------- 快捷键 ---------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;

      // AI 聊天框里 Cmd+Enter 是「发送」，别把它抢过来当运行
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        const inMonaco = target.closest('.monaco-editor');
        if (!inMonaco && (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable)) {
          return;
        }
      }

      if (event.key === 'p' || event.key === 'P') {
        event.preventDefault();
        setQuickOpen((open) => !open);
      } else if (event.key === 'b' || event.key === 'B') {
        event.preventDefault();
        updatePrefs({ sidebarCollapsed: !prefs.sidebarCollapsed });
      } else if (event.key === 's' || event.key === 'S') {
        // ⌘S 就该是保存，不要挪用
        event.preventDefault();
        saveRef.current?.();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        runRef.current?.();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [prefs.sidebarCollapsed, updatePrefs]);

  /* ---------------- 侧栏拖拽 ---------------- */

  useEffect(() => {
    if (!draggingSidebar) return;

    const onMove = (event: MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      updatePrefs({ sidebarWidth: Math.max(160, Math.min(420, event.clientX - rect.left)) });
    };
    const onUp = () => setDraggingSidebar(false);

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [draggingSidebar, updatePrefs]);

  /* ---------------- Monaco ---------------- */

  const handleMount = useCallback((editor: any, monaco: any) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    editor.onDidChangeCursorPosition((event: any) => {
      setCursor({ line: event.position.lineNumber, column: event.position.column });
    });

    // 编辑器内部也绑一份，否则焦点在 Monaco 里时浏览器快捷键会被它吃掉
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current?.());
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current?.());

    const syncMarkers = () => {
      const all = monaco.editor.getModelMarkers({});
      const next: Record<string, MarkerCount> = {};
      for (const marker of all) {
        const path = String(marker.resource?.path || '').replace(/^\//, '');
        if (!path) continue;
        const entry = next[path] || (next[path] = { errors: 0, warnings: 0 });
        if (marker.severity === monaco.MarkerSeverity.Error) entry.errors += 1;
        else if (marker.severity === monaco.MarkerSeverity.Warning) entry.warnings += 1;
      }
      setMarkers(next);
    };

    disposablesRef.current.push(monaco.editor.onDidChangeMarkers(syncMarkers));
    syncMarkers();
  }, []);

  useEffect(
    () => () => {
      disposablesRef.current.forEach((item) => item?.dispose?.());
      disposablesRef.current = [];
    },
    []
  );

  const formatDocument = useCallback(() => {
    editorRef.current?.getAction('editor.action.formatDocument')?.run();
  }, []);

  // 相对时间要自己走，否则停在「刚刚」不动，反而更像没保存
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [savedAt]);

  const savedLabel = useMemo(() => {
    if (!savedAt) return t('engineering.workspace.savedIdle');
    const seconds = Math.max(0, Math.round((now - savedAt) / 1000));
    if (seconds < 45) return t('engineering.workspace.savedJustNow');
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return t('engineering.workspace.savedMinutes', { minutes });
    return t('engineering.workspace.savedHours', { hours: Math.round(minutes / 60) });
  }, [now, savedAt, t]);

  const tree = useMemo(() => buildFileTree(files), [files]);
  const activeMarker = activeFile ? markers[activeFile.path] : undefined;
  const isActiveDirty = activeFile ? dirtyPaths.has(activeFile.path) : false;

  return (
    <div ref={containerRef} className="ide-root">
      {/* ---------------- 侧栏 ---------------- */}
      {!prefs.sidebarCollapsed && (
        <>
          <div className="ide-sidebar" style={{ width: prefs.sidebarWidth }}>
            <Group px="sm" py={7} justify="space-between" wrap="nowrap" className="ide-sidebar-head">
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: '.04em' }}>
                {t('engineering.workspace.files')}
              </Text>
              <Group gap={2} wrap="nowrap">
                {dirtyPaths.size > 0 && (
                  <Tooltip label={t('engineering.workspace.editedCount', { count: dirtyPaths.size })}>
                    <Badge size="xs" variant="light" color="brand">
                      {dirtyPaths.size}
                    </Badge>
                  </Tooltip>
                )}
                <Tooltip label={`${t('engineering.workspace.quickOpen')} ⌘P`}>
                  <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => setQuickOpen(true)}>
                    <IconSearch size={13} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label={`${t('engineering.workspace.hideSidebar')} ⌘B`}>
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="gray"
                    onClick={() => updatePrefs({ sidebarCollapsed: true })}
                  >
                    <IconLayoutSidebarLeftCollapse size={14} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Group>

            <ScrollArea style={{ flex: 1 }} type="hover">
              <Box pb="sm" pt={2}>
                <FileTree
                  nodes={tree}
                  activePath={activePath}
                  dirtyPaths={dirtyPaths}
                  markers={markers}
                  collapsed={collapsedDirs}
                  onToggleDir={(path) =>
                    setCollapsedDirs((prev) => ({ ...prev, [path]: !prev[path] }))
                  }
                  onSelect={openFile}
                />
              </Box>
            </ScrollArea>
          </div>

          <div
            className="ide-sidebar-resizer"
            data-dragging={draggingSidebar || undefined}
            onMouseDown={(event) => {
              event.preventDefault();
              setDraggingSidebar(true);
            }}
            role="separator"
            aria-orientation="vertical"
          />
        </>
      )}

      {/* ---------------- 主区 ---------------- */}
      <div className="ide-main">
        {/* 标签栏 */}
        <div className="ide-tabs">
          {prefs.sidebarCollapsed && (
            <Tooltip label={`${t('engineering.workspace.showSidebar')} ⌘B`}>
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                m={4}
                onClick={() => updatePrefs({ sidebarCollapsed: false })}
              >
                <IconLayoutSidebarLeftExpand size={15} />
              </ActionIcon>
            </Tooltip>
          )}

          <div className="ide-tabs-scroll">
            {openPaths.map((path) => {
              const file = files.find((item) => item.path === path);
              if (!file) return null;
              const isActive = path === activePath;

              return (
                <div
                  key={path}
                  className="ide-tab"
                  data-active={isActive || undefined}
                  // 走 openFile 而不是直接 setActivePath：diff 视图也要跟着退出，
                  // 否则从文件树点和从标签点会是两种行为
                  onClick={() => openFile(path)}
                  onAuxClick={(event) => {
                    // 中键关闭，和编辑器习惯一致
                    if (event.button === 1) {
                      event.preventDefault();
                      closeFile(path);
                    }
                  }}
                >
                  <IconFileCode size={13} color={fileAccent(path)} style={{ flexShrink: 0 }} />
                  <Text size="xs" fw={isActive ? 600 : 400} style={{ whiteSpace: 'nowrap' }}>
                    {path.split('/').pop()}
                  </Text>
                  {file.readonly && <IconLock size={10} opacity={0.55} />}

                  {/* 不放未保存圆点：工作区是自动保存的，
                      那个点只会在打字时不停闪，指示的又是不需要用户操心的事 */}
                  <ActionIcon
                    size={15}
                    variant="transparent"
                    color="gray"
                    className="ide-tab-close"
                    aria-label={t('engineering.workspace.closeTab')}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSaveNow?.();
                      closeFile(path);
                    }}
                  >
                    <IconX size={11} />
                  </ActionIcon>
                </div>
              );
            })}
          </div>

          {/* 编辑器工具条 */}
          <Group gap={2} px={6} wrap="nowrap" className="ide-toolbar">
            <Tooltip label={t('engineering.workspace.toggleWrap')}>
              <ActionIcon
                size="sm"
                variant={prefs.wordWrap ? 'light' : 'subtle'}
                color={prefs.wordWrap ? 'brand' : 'gray'}
                onClick={() => updatePrefs({ wordWrap: !prefs.wordWrap })}
              >
                <IconTextWrap size={14} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t('engineering.workspace.toggleMinimap')}>
              <ActionIcon
                size="sm"
                variant={prefs.minimap ? 'light' : 'subtle'}
                color={prefs.minimap ? 'brand' : 'gray'}
                onClick={() => updatePrefs({ minimap: !prefs.minimap })}
              >
                <IconMap2 size={14} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t('engineering.workspace.diff')}>
              <ActionIcon
                size="sm"
                variant={diffMode ? 'light' : 'subtle'}
                color={diffMode ? 'brand' : 'gray'}
                onClick={() => setDiffMode((value) => !value)}
                disabled={!isActiveDirty}
              >
                <IconGitCompare size={14} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t('engineering.workspace.format')}>
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                onClick={formatDocument}
                disabled={activeFile?.readonly}
              >
                <IconWand size={14} />
              </ActionIcon>
            </Tooltip>

            <Menu position="bottom-end" withinPortal>
              <Menu.Target>
                <ActionIcon size="sm" variant="subtle" color="gray">
                  <IconDotsVertical size={14} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{t('engineering.workspace.fontSize')}</Menu.Label>
                <Menu.Item
                  onClick={() =>
                    updatePrefs({ fontSize: Math.min(FONT_SIZE_RANGE.max, prefs.fontSize + 1) })
                  }
                >
                  {t('engineering.workspace.fontLarger')} ({prefs.fontSize}px)
                </Menu.Item>
                <Menu.Item
                  onClick={() =>
                    updatePrefs({ fontSize: Math.max(FONT_SIZE_RANGE.min, prefs.fontSize - 1) })
                  }
                >
                  {t('engineering.workspace.fontSmaller')}
                </Menu.Item>
                {onResetFile && activeFile && !activeFile.readonly && (
                  <>
                    <Menu.Divider />
                    <Menu.Item
                      color="orange"
                      leftSection={<IconArrowBackUp size={14} />}
                      disabled={!isActiveDirty}
                      onClick={() => onResetFile(activeFile.path)}
                    >
                      {t('engineering.workspace.resetFile')}
                    </Menu.Item>
                  </>
                )}
              </Menu.Dropdown>
            </Menu>
          </Group>
        </div>

        {/* 面包屑 */}
        {activeFile && (
          <Group gap={5} px="sm" py={4} className="ide-breadcrumb" wrap="nowrap">
            {activeFile.path.split('/').map((segment, index, all) => (
              <Group key={index} gap={5} wrap="nowrap">
                <Text size="xs" c={index === all.length - 1 ? undefined : 'dimmed'}>
                  {segment}
                </Text>
                {index < all.length - 1 && (
                  <IconChevronRight size={11} style={{ opacity: 0.45 }} />
                )}
              </Group>
            ))}
            {activeFile.readonly && (
              <Badge size="xs" variant="light" color="gray" leftSection={<IconLock size={9} />}>
                {t('engineering.workspace.readonly')}
              </Badge>
            )}
            {isActiveDirty && (
              <Tooltip label={t('engineering.workspace.editedHint')}>
                <Badge
                  size="xs"
                  variant={diffMode ? 'filled' : 'light'}
                  color="brand"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setDiffMode((value) => !value)}
                >
                  {diffMode ? t('engineering.workspace.diffMode') : t('engineering.workspace.edited')}
                </Badge>
              </Tooltip>
            )}
          </Group>
        )}

        {/* 编辑器 */}
        <div className="ide-editor">
          {activeFile && diffMode && isActiveDirty ? (
            // 左边是本关发下来的初始文件，右边是你现在的代码
            <DiffEditor
              height="100%"
              language={fileLanguage(activeFile.path)}
              original={pristine[activeFile.path] ?? ''}
              modified={activeFile.content}
              theme={colorScheme === 'dark' ? 'vs-dark' : 'light'}
              options={{
                readOnly: true,
                renderSideBySide: true,
                minimap: { enabled: false },
                fontSize: prefs.fontSize,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                wordWrap: prefs.wordWrap ? 'on' : 'off',
              }}
            />
          ) : activeFile ? (
            <Editor
              height="100%"
              path={`file:///${activeFile.path}`}
              language={fileLanguage(activeFile.path)}
              value={activeFile.content}
              theme={colorScheme === 'dark' ? 'vs-dark' : 'light'}
              beforeMount={handleBeforeMount}
              onMount={handleMount}
              onChange={(value) => {
                // 以真正发生变化的那个 model 为准，而不是渲染时闭包里的 activeFile，
                // 避免切换文件的瞬间把内容记到上一个文件头上
                const model = editorRef.current?.getModel();
                const modelPath = String(model?.uri?.path || '').replace(/^\//, '');
                const target = files.find((item) => item.path === (modelPath || activeFile.path));
                if (!target || target.readonly) return;
                onChange(target.path, value ?? '');
              }}
              options={{
                readOnly: activeFile.readonly,
                minimap: { enabled: prefs.minimap },
                fontSize: prefs.fontSize,
                fontLigatures: true,
                lineHeight: 1.6,
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
                wordWrap: prefs.wordWrap ? 'on' : 'off',
                renderLineHighlight: 'line',
                fixedOverflowWidgets: true,
                smoothScrolling: true,
                cursorBlinking: 'smooth',
                padding: { top: 10, bottom: 10 },
                bracketPairColorization: { enabled: true },
                guides: { bracketPairs: true, indentation: true },
                stickyScroll: { enabled: false },
                scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
              }}
            />
          ) : (
            <Group justify="center" style={{ height: '100%' }}>
              <Text size="sm" c="dimmed">
                {t('engineering.workspace.noFileOpen')}
              </Text>
            </Group>
          )}
        </div>

        {/* 状态栏 */}
        <Group className="ide-status" gap="md" px="sm" wrap="nowrap">
          <Group gap={4} wrap="nowrap">
            {totalProblems > 0 ? (
              <>
                <IconAlertTriangle size={11} color="var(--mantine-color-red-6)" />
                <Text size="xs" c="red">
                  {totalProblems}
                </Text>
              </>
            ) : (
              <Text size="xs" c="dimmed">
                {t('engineering.workspace.noProblems')}
              </Text>
            )}
            {activeMarker?.errors ? (
              <Text size="xs" c="dimmed">
                ({t('engineering.workspace.inThisFile')} {activeMarker.errors})
              </Text>
            ) : null}
          </Group>

          <Box style={{ flex: 1 }} />

          {isRunning && (
            <Text size="xs" c="brand">
              {t('engineering.workspace.running')}
            </Text>
          )}
          <Group gap={4} wrap="nowrap">
            <IconDeviceFloppy size={11} style={{ opacity: 0.6 }} />
            <Text size="xs" c="dimmed">
              {unsaved.size > 0 ? t('engineering.workspace.saving') : savedLabel}
            </Text>
          </Group>
          <Text size="xs" c="dimmed">
            {t('engineering.workspace.lineCol', { line: cursor.line, column: cursor.column })}
          </Text>
          <Text size="xs" c="dimmed">
            {activeFile ? fileLanguage(activeFile.path) : ''}
          </Text>
        </Group>
      </div>

      <QuickOpen
        opened={quickOpen}
        files={files}
        dirtyPaths={dirtyPaths}
        onClose={() => setQuickOpen(false)}
        onSelect={openFile}
      />
    </div>
  );
}
