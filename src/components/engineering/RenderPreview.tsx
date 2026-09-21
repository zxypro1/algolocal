import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Badge, Button, Group, SegmentedControl, Stack, Text } from '@mantine/core';
import { IconPlayerPause, IconPlayerPlay, IconRefresh } from '@tabler/icons-react';
import { useI18n } from '../../contexts/I18nContext';
import { buildStageFiles, toFileMap } from '../../lib/engineering/workspace';
import type { EngineeringProject, WorkspaceFile } from '../../lib/engineering/types';
import styles from './RenderPreview.module.css';

interface Props {
  files: WorkspaceFile[];
  project: EngineeringProject;
  stageIndex: number;
  entryPrefix: string;
}

export default function RenderPreview({ files, project, stageIndex, entryPrefix }: Props) {
  const { locale } = useI18n();
  const zh = locale === 'zh';
  const [mode, setMode] = useState('draft');
  const [paused, setPaused] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('waiting');
  const [duration, setDuration] = useState<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const elapsedRef = useRef(0);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const sources = useMemo(() => {
    if (mode === 'draft') return toFileMap(files);
    const index = mode === 'final' ? project.stages.length - 1 : stageIndex;
    const result = toFileMap(buildStageFiles(project, index));
    for (const stage of project.stages.slice(0, index + 1)) {
      Object.assign(result, toFileMap(stage.referenceFiles || []));
    }
    return result;
  }, [files, project, stageIndex, mode]);
  const entry = `${entryPrefix}${mode === 'final' ? project.stages.length : stageIndex + 1}`;

  useEffect(() => {
    let disposed = false;
    let worker: Worker | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let nextFrame: ReturnType<typeof setTimeout> | undefined;
    let lastFrame = performance.now();
    let lastStats = 0;
    const width = 360, height = 260;
    setError(null);
    setDuration(null);
    setStatus('waiting');
    const canvas = canvasRef.current;
    canvas?.getContext('2d')?.clearRect(0, 0, width, height);
    const fail = (message: string) => {
      if (disposed) return;
      worker?.terminate();
      clearTimeout(timeout);
      clearTimeout(nextFrame);
      setError(message);
      setStatus('error');
    };
    const armTimeout = (ms: number) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fail(zh ? '预览超时，已停止运行。检查死循环或过重的逐帧计算，修改代码或点击重启即可恢复。' : 'Preview timed out and was stopped. Check loops or expensive frame work, then edit or restart.'), ms);
    };
    const start = setTimeout(() => {
      try {
        setStatus('compiling');
        worker = new Worker(new URL('../../workers/renderPreview.worker.ts', import.meta.url));
        worker.onerror = (event) => { event.preventDefault(); fail(event.message || 'Preview worker failed'); };
        worker.onmessage = (event) => {
          if (disposed) return;
          clearTimeout(timeout);
          if (event.data.error) { fail(event.data.error); return; }
          const pixels = event.data.pixels;
          if (!(pixels instanceof Uint8ClampedArray) || pixels.length !== width * height * 4) { fail('Invalid preview frame'); return; }
          canvasRef.current?.getContext('2d')?.putImageData(new ImageData(pixels, width, height), 0, 0);
          setStatus('live');
          const now = performance.now();
          if (now - lastStats > 500) { setDuration(event.data.duration); lastStats = now; }
          const schedule = () => {
            if (disposed) return;
            const current = performance.now();
            if (pausedRef.current) {
              lastFrame = current;
              nextFrame = setTimeout(schedule, 100);
              return;
            }
            elapsedRef.current += Math.min((current - lastFrame) / 1000, 0.1);
            lastFrame = current;
            armTimeout(4000);
            worker?.postMessage({ time: elapsedRef.current, width, height });
          };
          nextFrame = setTimeout(schedule, 33);
        };
        armTimeout(15000);
        worker.postMessage({ files: sources, entry, time: elapsedRef.current, width, height });
      } catch (cause) {
        fail(cause instanceof Error ? cause.message : String(cause));
      }
    }, 500);
    return () => {
      disposed = true;
      clearTimeout(start);
      clearTimeout(timeout);
      clearTimeout(nextFrame);
      worker?.terminate();
    };
  }, [sources, entry, revision, zh]);

  const label = error ? (zh ? '已停止' : 'Stopped') : paused ? (zh ? '已暂停' : 'Paused') :
    status === 'live' ? (zh ? '实时运行' : 'Live') : status === 'compiling' ? (zh ? '编译中' : 'Compiling') : (zh ? '等待更新' : 'Updating');
  return (
    <Stack gap="sm" p="sm" className={styles.contents}>
      <Group justify="space-between" gap="xs">
        <Text fw={600} size="sm">{zh ? '3D 实时预览' : '3D live preview'}</Text>
        <Badge size="sm" variant="light" color={error ? 'red' : 'teal'}>{label}</Badge>
      </Group>
      <SegmentedControl fullWidth size="xs" value={mode} onChange={setMode} data={[
        { value: 'draft', label: zh ? '我的代码' : 'My code' },
        { value: 'reference', label: zh ? '本关参考' : 'Stage reference' },
        { value: 'final', label: zh ? '最终效果' : 'Final reference' },
      ]} />
      <div style={{ background: '#0f172a', borderRadius: 8, overflow: 'hidden', position: 'relative', flex: '1 1 180px', minHeight: 100, maxHeight: 260 }}>
        <canvas ref={canvasRef} width={360} height={260} aria-label={zh ? '当前代码的渲染结果' : 'Rendered code output'} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block', imageRendering: 'pixelated' }} />
      </div>
      <Group justify="space-between" gap="xs">
        <Group gap={6}>
          <Button size="compact-xs" variant="subtle" leftSection={paused ? <IconPlayerPlay size={14} /> : <IconPlayerPause size={14} />} onClick={() => setPaused(value => !value)}>{paused ? (zh ? '继续' : 'Resume') : (zh ? '暂停' : 'Pause')}</Button>
          <Button size="compact-xs" variant="subtle" leftSection={<IconRefresh size={14} />} onClick={() => { elapsedRef.current = 0; setRevision(value => value + 1); }}>{zh ? '重启' : 'Restart'}</Button>
        </Group>
        <Text size="xs" c="dimmed">360 × 260{duration !== null ? ` · ${duration.toFixed(1)} ms` : ''}</Text>
      </Group>
      {error && <Alert color="red" title={zh ? '预览错误' : 'Preview error'} styles={{ message: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }}>{error}</Alert>}
      <Text size="xs" c="dimmed">{mode === 'draft'
        ? (zh ? '停止输入 500ms 后自动更新。编辑 src/scene 可调整颜色与转速；完成本关实现后画面会逐步出现。' : 'Updates 500ms after typing. Edit src/scene for colors and speed; implement this stage to build the image.')
        : (zh ? '正在运行参考实现，仅用于效果对照，不会修改草稿或通关进度。' : 'Running the reference for comparison. Drafts and progress are unchanged.')}</Text>
    </Stack>
  );
}
