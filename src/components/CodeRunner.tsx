import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { 
  Button, 
  Paper, 
  Text, 
  Title, 
  Stack,
  Group, 
  Badge, 
  LoadingOverlay,
  Alert,
  Code,
  Select,
  Tooltip,
  Modal,
  Loader,
  ActionIcon,
  Box,
  Menu,
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconArrowBackUp,
  IconDeviceFloppy,
  IconDotsVertical,
  IconMap2,
  IconPlayerPlay,
  IconTextWrap,
  IconWand,
} from '@tabler/icons-react';
import Editor from '@monaco-editor/react';
import { IconBug } from '@tabler/icons-react';
import { Modal as TraceModal } from '@mantine/core';
import TracePlayer from './TracePlayer';
import { useTranslation, useI18n } from '../contexts/I18nContext';
import { useTheme } from '../contexts/ThemeContext';
import { useWasmExecutor } from '../hooks/useWasmExecutor';
import ConsoleOutput from './ConsoleOutput';
import {
  DEFAULT_PREFS,
  EditorPrefs,
  FONT_SIZE_RANGE,
  loadEditorPrefs,
  saveEditorPrefs,
} from '../lib/editorPrefs';
import { clearDraft, loadDraft, saveDraft } from '../lib/problemDrafts';
import { useAiConfig } from '../hooks/useAiConfig';

// WASM 支持的语言配置
const WASM_SUPPORTED_LANGUAGES = [
  { value: 'javascript', label: 'JavaScript', monacoLang: 'javascript', templateKey: 'js' },
  { value: 'typescript', label: 'TypeScript', monacoLang: 'typescript', templateKey: 'typescript' },
  { value: 'python', label: 'Python', monacoLang: 'python', templateKey: 'python' }
];

// Format output results
function formatOutput(value: any): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'number') return `${value}`;
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(formatOutput).join(',')}]`;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

interface CodeRunnerProps {
  problem: any;
  onTestResult?: (result: any) => void;
  showResults?: boolean;
  onCodeChange?: (code: string, language: string) => void;
}

export default function CodeRunner({ problem, onTestResult, showResults = true, onCodeChange }: CodeRunnerProps) {
  const { t } = useTranslation();
  const { locale } = useI18n();
  const { colorScheme } = useTheme();
  const [selectedLanguage, setSelectedLanguage] = useState('javascript');
  const [code, setCode] = useState('');
  const [result, setResult] = useState<any>(null);
  const [isRunning, setIsRunning] = useState(false);
  
  // AI Solution state
  const [isGeneratingSolution, setIsGeneratingSolution] = useState(false);
  const [solutionError, setSolutionError] = useState<string | null>(null);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  // AI 配置读取在 useAiConfig 里，别再在组件里抄一份
  const { config: aiConfig } = useAiConfig();
  
  // WASM 执行器 hook
  const { runTests: runWasmTests, traceExecution, runtimeStatus, preloadRuntime } = useWasmExecutor();

  // 编辑器偏好与工程实战工作区共用一份，改一次两边都生效
  const [prefs, setPrefs] = useState<EditorPrefs>(DEFAULT_PREFS);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [problemCount, setProblemCount] = useState(0);
  const [savedAt, setSavedAt] = useState<number | undefined>(undefined);
  const [isSaving, setIsSaving] = useState(false);

  const editorRef = useRef<any>(null);
  const disposablesRef = useRef<any[]>([]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ code: string; language: string } | null>(null);
  const runRef = useRef<() => void>(() => {});

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

  /** 当前语言对应的初始模板 */
  const template = useMemo(() => {
    const langConfig = WASM_SUPPORTED_LANGUAGES.find((l) => l.value === selectedLanguage);
    const templateKey = langConfig?.templateKey || 'js';
    return problem.template?.[templateKey] || problem.template?.js || '';
  }, [problem, selectedLanguage]);

  
  // 预加载选中语言的 WASM 运行时
  useEffect(() => {
    preloadRuntime(selectedLanguage);
  }, [selectedLanguage, preloadRuntime]);
  
  // 切题 / 切语言时：有草稿就接着写，没有才回到模板
  useEffect(() => {
    // 切换前先把上一份待写内容落盘，否则换语言会丢掉刚敲的东西
    flushDraft();
    setCode(loadDraft(problem.id, selectedLanguage) ?? template);
    // flushDraft 会随语言变化重建，这里只关心「题目/语言/模板」变了要重新载入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problem.id, selectedLanguage, template]);

  /** 立刻把草稿落盘（防抖之外的强制保存） */
  const flushDraft = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;

    if (pending.code === template) clearDraft(problem.id, pending.language);
    else saveDraft(problem.id, pending.language, pending.code);

    setIsSaving(false);
    setSavedAt(Date.now());
  }, [problem.id, template]);

  /**
   * 改代码的唯一入口：更新状态并安排一次延迟落盘。
   *
   * 这里刻意不用 useEffect 监听 code。effect 拿到的是本次渲染闭包里的 code，
   * 而首次挂载时「载入模板」和「保存」两个 effect 在同一次提交里依次执行，
   * 保存拿到的还是上一帧的空字符串，于是会存下一条空草稿，把模板顶掉。
   */
  const updateCode = useCallback(
    (next: string) => {
      setCode(next);
      pendingRef.current = { code: next, language: selectedLanguage };
      setIsSaving(true);
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(flushDraft, 800);
    },
    [flushDraft, selectedLanguage]
  );

  // 关页面、切后台、组件卸载前把待写内容落下去
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') flushDraft();
    };
    window.addEventListener('pagehide', flushDraft);
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      window.removeEventListener('pagehide', flushDraft);
      document.removeEventListener('visibilitychange', onHidden);
      flushDraft();
    };
  }, [flushDraft]);

  // Notify parent of code changes
  useEffect(() => {
    if (onCodeChange) {
      onCodeChange(code, selectedLanguage);
    }
  }, [code, selectedLanguage, onCodeChange]);
  
  // 过滤可用的 WASM 支持语言
  const availableLanguages = WASM_SUPPORTED_LANGUAGES.filter(
    lang => {
      // Check if the specific template exists
      if (problem.template?.[lang.templateKey]) {
        return true;
      }
      // For JavaScript, also check for 'js' key (backward compatibility)
      if (lang.value === 'javascript' && problem.template?.js) {
        return true;
      }
      // TypeScript is available when JavaScript template exists
      // (TypeScript is a superset of JavaScript)
      if (lang.value === 'typescript' && problem.template?.js) {
        return true;
      }
      return false;
    }
  );
  
  /** 轨迹回放：只跑第一条用例，录下每一步 */
  const [trace, setTrace] = useState<any>(null);
  const [tracing, setTracing] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);
  const [tracedSource, setTracedSource] = useState('');

  const runTrace = async () => {
    setTracing(true);
    setTraceOpen(true);
    // 记下这次录制用的源码：录完之后编辑器里的代码还能继续改，
    // 高亮必须对着录制那一刻的版本，不然行号会对不上
    setTracedSource(code);
    try {
      const outcome = await traceExecution(problem, code, selectedLanguage, 0);
      setTrace(outcome.trace);
    } catch (error: any) {
      setTrace({ steps: [], droppedSteps: 0, truncated: false, completed: false,
        error: error?.message || String(error) });
    } finally {
      setTracing(false);
    }
  };

  const runTests = async () => {
    setIsRunning(true);
    const runningStatus = { status: 'running' };
    setResult(runningStatus);
    
    // Call the callback with running status if provided
    if (onTestResult) {
      onTestResult(runningStatus);
    }
    
    try {
      // 使用 WASM 执行器
      const data = await runWasmTests(problem, code, selectedLanguage);
      
      setResult(data);
      
      // Call the callback if provided
      if (onTestResult) {
        onTestResult(data);
      }
    } catch (error: any) {
      const errorResult = { 
        status: 'error', 
        error: error.message || t('codeRunner.executionError') || '执行错误'
      };
      setResult(errorResult);
      
      // Call the callback with error if provided
      if (onTestResult) {
        onTestResult(errorResult);
      }
    } finally {
      setIsRunning(false);
    }
  };

  runRef.current = runTests;

  // ⌘/Ctrl + Enter 运行，⌘/Ctrl + S 保存草稿
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;

      const target = event.target as HTMLElement | null;
      const inMonaco = target?.closest('.monaco-editor');
      const typingElsewhere =
        !inMonaco &&
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typingElsewhere) return;

      if (event.key === 'Enter') {
        event.preventDefault();
        runRef.current();
      } else if (event.key === 's' || event.key === 'S') {
        event.preventDefault();
        flushDraft();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [flushDraft]);

  const handleEditorMount = useCallback((editor: any, monaco: any) => {
    editorRef.current = editor;

    disposablesRef.current.push(
      editor.onDidChangeCursorPosition((event: any) => {
        setCursor({ line: event.position.lineNumber, column: event.position.column });
      })
    );

    // 焦点在 Monaco 里时浏览器快捷键会被它吃掉，这里再绑一份
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runRef.current());

    const syncMarkers = () => {
      const errors = monaco.editor
        .getModelMarkers({})
        .filter((marker: any) => marker.severity === monaco.MarkerSeverity.Error);
      setProblemCount(errors.length);
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

  /** 把代码还原成初始模板 */
  const resetToTemplate = useCallback(() => {
    setCode(template);
    clearDraft(problem.id, selectedLanguage);
    pendingRef.current = null;
    setSavedAt(Date.now());
    setIsSaving(false);
  }, [problem.id, selectedLanguage, template]);

  const isModified = code !== template && code !== '';

  // 相对时间要自己走，否则「刚刚保存」会永远停在那儿 —— 这段 useMemo 只依赖
  // savedAt，而 savedAt 保存完就不再变了，没有 ticker 就再也不会重算
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [savedAt]);

  const savedLabel = useMemo(() => {
    if (isSaving) return t('editor.saving');
    if (!savedAt) return t('editor.autosaveOn');
    const seconds = Math.max(0, Math.round((now - savedAt) / 1000));
    if (seconds < 45) return t('editor.savedJustNow');
    return t('editor.savedMinutes', { minutes: Math.max(1, Math.round(seconds / 60)) });
  }, [isSaving, now, savedAt, t]);

  // Generate AI Solution
  const generateAISolution = async () => {
    setIsGeneratingSolution(true);
    setSolutionError(null);
    setConfirmModalOpen(false);

    try {
      const response = await fetch('/api/ai-solution', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          problem: {
            id: problem.id,
            title: problem.title,
            description: problem.description,
            difficulty: problem.difficulty,
            tags: problem.tags,
            examples: problem.examples,
            tests: problem.tests,
          },
          language: locale,
          codeLanguage: selectedLanguage,
          config: aiConfig, // Pass AI configuration
          stream: true,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        try {
          const data = JSON.parse(text);
          throw new Error(data.error || 'Failed to generate solution');
        } catch {
          throw new Error(text || 'Failed to generate solution');
        }
      }

      const reader = response.body?.getReader();
      if (!reader) {
        const text = await response.text();
        updateCode(cleanCodeFromResponse(text));
        return;
      }

      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        setCode(cleanCodeFromResponse(buffer));
      }

      buffer += decoder.decode();
      updateCode(cleanCodeFromResponse(buffer));
    } catch (error: any) {
      setSolutionError(error.message || 'Failed to generate AI solution');
    } finally {
      setIsGeneratingSolution(false);
    }
  };

  const cleanCodeFromResponse = (raw: string) => {
    const text = (raw || '').trim();
    const match = text.match(/```(?:javascript|typescript|python|js|ts|py)?\s*([\s\S]*?)```/);
    if (match) return match[1].trim();
    return text;
  };

  const handleAISolutionClick = () => {
    // If code has been modified from template, show confirmation
    const langConfig = WASM_SUPPORTED_LANGUAGES.find(l => l.value === selectedLanguage);
    const templateKey = langConfig?.templateKey || 'js';
    const template = problem.template?.[templateKey] || problem.template?.js || '';
    
    if (code.trim() !== template.trim() && code.trim() !== '') {
      setConfirmModalOpen(true);
    } else {
      generateAISolution();
    }
  };
  
  const renderResult = () => {
    if (!result) return null;
    
    if (result.status === 'running') {
      return (
        <Alert color="blue">
          {t('codeRunner.runningTests')}
        </Alert>
      );
    }
    
    if (result.error) {
      return (
        <Alert color="red" title={t('codeRunner.runError')}>
          <Code block>{result.error}</Code>
        </Alert>
      );
    }
    
    if (result.results) {
      const passedTests = result.passed || 0;
      const totalTests = result.total || result.results.length;
      const allPassed = passedTests === totalTests;
      console.log(result.results)
      
      return (
        <Stack gap={10}>
          <Group justify="space-between">
            <Title order={5}>
              {t('codeRunner.testResults')}
            </Title>
            <Badge 
              color={allPassed ? 'green' : 'red'} 
              variant="filled"
            >
              {passedTests}/{totalTests} {t('codeRunner.passed')}
            </Badge>
          </Group>
          
          {/* Performance Information */}
          {result.performance && (
            <Paper p="sm" withBorder style={{ background: 'var(--mantine-color-blue-light)' }}>
              <Stack gap="xs">
                <Group justify="space-between" wrap="wrap">
                  <div>
                    <Text size="xs" c="dimmed">{t('codeRunner.totalExecutionTime')}:</Text>
                    <Text size="sm" fw={500}>{result.performance.totalExecutionTime}ms</Text>
                  </div>
                  <div>
                    <Text size="xs" c="dimmed">{t('codeRunner.medianTime') || 'Median Time'}:</Text>
                    <Text size="sm" fw={500}>{result.performance.medianExecutionTime}ms</Text>
                  </div>
                  <div>
                    <Text size="xs" c="dimmed">{t('codeRunner.averageTime')}:</Text>
                    <Text size="sm" fw={500}>{result.performance.averageExecutionTime}ms</Text>
                  </div>
                  <div>
                    <Text size="xs" c="dimmed">{t('codeRunner.memoryUsed')}:</Text>
                    <Text size="sm" fw={500}>{result.performance.memoryUsage.heapUsed}MB</Text>
                  </div>
                </Group>
                <Group justify="space-between" wrap="wrap">
                  <div>
                    <Text size="xs" c="dimmed">{t('codeRunner.minTime') || 'Min'}:</Text>
                    <Text size="sm" fw={500}>{result.performance.minExecutionTime}ms</Text>
                  </div>
                  <div>
                    <Text size="xs" c="dimmed">{t('codeRunner.maxTime') || 'Max'}:</Text>
                    <Text size="sm" fw={500}>{result.performance.maxExecutionTime}ms</Text>
                  </div>
                  <div>
                    <Text size="xs" c="dimmed">{t('codeRunner.stdDev') || 'Std Dev'}:</Text>
                    <Text size="sm" fw={500}>±{result.performance.standardDeviation}ms</Text>
                  </div>
                  <div>
                    <Text size="xs" c="dimmed">{t('codeRunner.iterations') || 'Iterations'}:</Text>
                    <Text size="sm" fw={500}>{result.performance.iterations}x</Text>
                  </div>
                </Group>
              </Stack>
            </Paper>
          )}
          
          <Stack gap={8}>
            {result.results.map((testResult: any, index: number) => (
              <Paper key={index} p="sm" withBorder>
                <Group justify="space-between" mb={5}>
                  <Text size="sm" fw={500}>
                    {t('codeRunner.testCase')} {index + 1}
                  </Text>
                  <Badge 
                    color={testResult.passed ? 'green' : 'red'}
                    variant="light"
                    size="sm"
                  >
                    {testResult.passed ? t('codeRunner.passed') : t('codeRunner.failed')}
                  </Badge>
                </Group>
                
                <Stack gap={5}>
                  <div>
                    <Text size="xs" c="dimmed">{t('codeRunner.input')}:</Text>
                    <Code>{testResult.input}</Code>
                  </div>
                  <div>
                    <Text size="xs" c="dimmed">{t('codeRunner.expected')}:</Text>
                    <Code>{formatOutput(testResult.expected)}</Code>
                  </div>
                  <div>
                    <Text size="xs" c="dimmed">{t('codeRunner.actual')}:</Text>
                    <Code color={testResult.passed ? undefined : 'red'}>
                      {testResult.actual === null ? 'null' : 
                       testResult.actual === undefined ? 'undefined' : 
                       formatOutput(testResult.actual)}
                    </Code>
                  </div>
                  {testResult.error && (
                    <div>
                      <Text size="xs" c="red">{t('common.error')}:</Text>
                      <Code c="red">{testResult.error}</Code>
                    </div>
                  )}
                  {testResult.executionTime !== undefined && (
                    <div>
                      <Text size="xs" c="dimmed">{t('codeRunner.executionTime')}: {testResult.executionTime}ms</Text>
                    </div>
                  )}
                  <ConsoleOutput
                    entries={testResult.logs || []}
                    truncated={testResult.logsTruncated}
                    defaultOpen={!testResult.passed}
                  />
                </Stack>
              </Paper>
            ))}
          </Stack>
        </Stack>
      );
    }
    
    return (
      <Code block>
        {JSON.stringify(result, null, 2)}
      </Code>
    );
  };
  
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '15px' }}>
      <Paper
        shadow="sm"
        withBorder
        style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
      >
        <LoadingOverlay visible={isRunning} />
        
        <Group justify="space-between" p="md" pb="xs">
          <Title order={4}>
            {t('codeRunner.title')}
          </Title>
          <Group>
            {/* WASM 运行时状态指示器 */}
            <Tooltip 
              label={t('codeRunner.wasmEnabled') || 'WASM 浏览器端执行'}
              position="bottom"
            >
              <Badge 
                size="sm" 
                color={
                  runtimeStatus[selectedLanguage as 'javascript' | 'typescript' | 'python'] === 'ready' ? 'teal' :
                  runtimeStatus[selectedLanguage as 'javascript' | 'typescript' | 'python'] === 'loading' ? 'yellow' :
                  runtimeStatus[selectedLanguage as 'javascript' | 'typescript' | 'python'] === 'error' ? 'red' : 'gray'
                }
                variant="light"
              >
                {runtimeStatus[selectedLanguage as 'javascript' | 'typescript' | 'python'] === 'ready' ? 'WASM Ready' :
                 runtimeStatus[selectedLanguage as 'javascript' | 'typescript' | 'python'] === 'loading' ? 'Loading...' :
                 runtimeStatus[selectedLanguage as 'javascript' | 'typescript' | 'python'] === 'error' ? 'Error' : 
                 'WASM'}
              </Badge>
            </Tooltip>
            
            {/* AI Solution Button */}
            <Tooltip label={t('codeRunner.aiSolutionTooltip')} position="bottom">
              <Button
                onClick={handleAISolutionClick}
                disabled={isGeneratingSolution || isRunning}
                color="violet"
                variant="light"
                size="sm"
                leftSection={isGeneratingSolution ? <Loader size={14} /> : <IconWand size={16} />}
              >
                {isGeneratingSolution ? t('codeRunner.generating') : t('codeRunner.aiSolution')}
              </Button>
            </Tooltip>
            
            <Select
              value={selectedLanguage}
              onChange={(value) => setSelectedLanguage(value || 'javascript')}
              data={availableLanguages}
              size="sm"
              w={130}
            />
            <Button
              onClick={runTrace}
              disabled={tracing || isRunning || runtimeStatus[selectedLanguage as 'javascript' | 'typescript' | 'python'] === 'loading'}
              variant="default"
              leftSection={tracing ? <Loader size={14} /> : <IconBug size={15} />}
            >
              {tracing ? t('trace.running') : t('trace.button')}
            </Button>
            <Tooltip label="⌘/Ctrl + Enter" position="bottom">
              <Button
                onClick={runTests}
                disabled={isRunning || runtimeStatus[selectedLanguage as 'javascript' | 'typescript' | 'python'] === 'loading'}
                color="blue"
                variant="filled"
                leftSection={isRunning ? <Loader size={14} color="white" /> : <IconPlayerPlay size={15} />}
              >
                {isRunning ? t('codeRunner.running') : t('codeRunner.submit')}
              </Button>
            </Tooltip>
          </Group>
        </Group>
        
        {/* AI Solution Error */}
        {solutionError && (
          <Alert color="red" mx="md" mb="xs" withCloseButton onClose={() => setSolutionError(null)}>
            {solutionError}
          </Alert>
        )}
        
        {/* 编辑器工具条 */}
        <Group gap={2} justify="flex-end" px={4} py={2} className="ide-toolbar-inline">
          <Tooltip label={t('editor.toggleWrap')}>
            <ActionIcon
              size="sm"
              variant={prefs.wordWrap ? 'light' : 'subtle'}
              color={prefs.wordWrap ? 'brand' : 'gray'}
              onClick={() => updatePrefs({ wordWrap: !prefs.wordWrap })}
            >
              <IconTextWrap size={14} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t('editor.toggleMinimap')}>
            <ActionIcon
              size="sm"
              variant={prefs.minimap ? 'light' : 'subtle'}
              color={prefs.minimap ? 'brand' : 'gray'}
              onClick={() => updatePrefs({ minimap: !prefs.minimap })}
            >
              <IconMap2 size={14} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t('editor.format')}>
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              onClick={() => editorRef.current?.getAction('editor.action.formatDocument')?.run()}
            >
              <IconWand size={14} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={t('editor.resetToTemplate')}>
            <ActionIcon
              size="sm"
              variant="subtle"
              color="orange"
              onClick={resetToTemplate}
              disabled={!isModified}
            >
              <IconArrowBackUp size={14} />
            </ActionIcon>
          </Tooltip>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ActionIcon size="sm" variant="subtle" color="gray">
                <IconDotsVertical size={14} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>{t('editor.fontSize')}</Menu.Label>
              <Menu.Item
                onClick={() => updatePrefs({ fontSize: Math.min(FONT_SIZE_RANGE.max, prefs.fontSize + 1) })}
              >
                {t('editor.fontLarger')} ({prefs.fontSize}px)
              </Menu.Item>
              <Menu.Item
                onClick={() => updatePrefs({ fontSize: Math.max(FONT_SIZE_RANGE.min, prefs.fontSize - 1) })}
              >
                {t('editor.fontSmaller')}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>

        <div style={{ flex: 1, minHeight: '300px' }}>
          <Editor
            height="100%"
            path={`problem:///${problem.id}.${selectedLanguage}`}
            language={WASM_SUPPORTED_LANGUAGES.find(l => l.value === selectedLanguage)?.monacoLang || 'javascript'}
            value={code}
            onChange={(v) => updateCode(v || '')}
            onMount={handleEditorMount}
            theme={colorScheme === 'dark' ? 'vs-dark' : 'light'}
            options={{
              minimap: { enabled: prefs.minimap },
              fontSize: prefs.fontSize,
              fontLigatures: true,
              lineHeight: 1.6,
              lineNumbers: 'on',
              roundedSelection: false,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              insertSpaces: true,
              wordWrap: prefs.wordWrap ? 'on' : 'off',
              smoothScrolling: true,
              cursorBlinking: 'smooth',
              padding: { top: 10, bottom: 10 },
              bracketPairColorization: { enabled: true },
              guides: { bracketPairs: true, indentation: true },
              scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
            }}
          />
        </div>

        {/* 状态栏 */}
        <Group className="ide-status" gap="md" px="sm" wrap="nowrap">
          <Group gap={4} wrap="nowrap">
            {problemCount > 0 ? (
              <>
                <IconAlertTriangle size={11} color="var(--mantine-color-red-6)" />
                <Text size="xs" c="red">{problemCount}</Text>
              </>
            ) : (
              <Text size="xs" c="dimmed">{t('editor.noProblems')}</Text>
            )}
          </Group>

          <Box style={{ flex: 1 }} />

          {isModified && (
            <Text size="xs" c="dimmed">{t('editor.modifiedFromTemplate')}</Text>
          )}
          <Group gap={4} wrap="nowrap">
            <IconDeviceFloppy size={11} style={{ opacity: 0.6 }} />
            <Text size="xs" c="dimmed">{savedLabel}</Text>
          </Group>
          <Text size="xs" c="dimmed">
            {t('editor.lineCol', { line: cursor.line, column: cursor.column })}
          </Text>
        </Group>
      </Paper>
      
      {showResults && result && (
        <Paper shadow="sm" p="md" withBorder style={{ maxHeight: '300px', overflow: 'auto' }}>
          {renderResult()}
        </Paper>
      )}
      
      {/* AI Solution Confirmation Modal */}
      <Modal
        opened={confirmModalOpen}
        onClose={() => setConfirmModalOpen(false)}
        title={t('codeRunner.aiSolutionConfirmTitle')}
        size="sm"
      >
        <Stack gap="md">
          <Text size="sm">
            {t('codeRunner.aiSolutionConfirmMessage')}
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirmModalOpen(false)}>
              {t('manage.cancel')}
            </Button>
            <Button color="violet" onClick={generateAISolution} leftSection={<IconWand size={16} />}>
              {t('codeRunner.generateAnyway')}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <TraceModal
        opened={traceOpen}
        onClose={() => setTraceOpen(false)}
        title={t('trace.title')}
        size="xl"
      >
        {tracing ? (
          <Group gap="xs"><Loader size={16} /><Text size="sm">{t('trace.running')}</Text></Group>
        ) : trace ? (
          <TracePlayer trace={trace} source={tracedSource} />
        ) : null}
      </TraceModal>
    </div>
  );
}
