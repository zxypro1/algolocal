import * as ts from 'typescript';
import { createPreviewRenderer } from '../../src/lib/engineering/renderPreview';
import { createTranspiler } from '../../src/lib/engineering/transpile';
import { buildStageFiles, projectView, toFileMap } from '../../src/lib/engineering/workspace';
import type { EngineeringProject, WorkspaceLanguage } from '../../src/lib/engineering/types';

const projects: EngineeringProject[] = require('../../projects/projects.json');
const project = projects.find(p => p.id === 'minigl-renderer')!;
const transpile = createTranspiler(ts);

function reference(stageIndex: number, language: WorkspaceLanguage) {
  const view = projectView(project, language);
  const files = toFileMap(buildStageFiles(view, stageIndex));
  for (const stage of view.stages.slice(0, stageIndex + 1)) Object.assign(files, toFileMap(stage.referenceFiles || []));
  return files;
}

describe.each<WorkspaceLanguage>(['typescript', 'javascript'])('MiniGL preview (%s)', language => {
  it.each(project.stages.map((_, index) => index))('renders actual reference pixels for stage %i', index => {
    const render = createPreviewRenderer(reference(index, language), `preview/stage-${index + 1}`, transpile);
    const frame = render(0.5, 120, 100);
    const colored = Array.from(frame.pixels).filter((v, i) => i % 4 === 0 && v !== 15);
    expect(colored.length).toBeGreaterThan(20);
    expect(frame.pixels.length).toBe(120 * 100 * 4);
  });

  it.each([7, 8, 9, 10, 11])('shows the result of the learner edit in stage %i', index => {
    const view = projectView(project, language);
    const solved = reference(index, language);
    const starter = { ...solved };
    const exercise = view.stages[index].starterFiles!.find(file => !file.readonly)!;
    starter[exercise.path] = exercise.content;
    const entry = `preview/stage-${index + 1}`;
    const render = (files: Record<string, string>) => createPreviewRenderer(files, entry, transpile)(0.5, 120, 100).pixels;
    expect(render(starter)).not.toEqual(render(solved));
  });

  it('changes cube pixels over time and responds to scene edits', () => {
    const last = project.stages.length - 1;
    const entry = `preview/stage-${last + 1}`;
    const files = reference(last, language);
    const render = createPreviewRenderer(files, entry, transpile);
    const before = render(0, 120, 100).pixels;
    expect(render(1, 120, 100).pixels).not.toEqual(before);
    const scene = language === 'typescript' ? 'src/scene.ts' : 'src/scene.js';
    files[scene] = files[scene].replace(/70,\s*205,\s*235/, '255,80,40');
    expect(createPreviewRenderer(files, entry, transpile)(0, 120, 100).pixels).not.toEqual(before);
  });
});

it('rejects missing entry contracts and invalid frame buffers', () => {
  expect(() => createPreviewRenderer({ 'main.js': 'exports.noFrame = true;' }, 'main', transpile)).toThrow('renderFrame');
  const render = createPreviewRenderer({ 'main.js': 'exports.renderFrame = () => ({width:2,height:2,pixels:new Uint8ClampedArray(4)});' }, 'main', transpile);
  expect(() => render(0, 2, 2)).toThrow('Uint8ClampedArray');
});

it('preserves file context on user code exceptions', () => {
  expect(() => createPreviewRenderer({ 'main.ts': 'throw new Error("broken scene");' }, 'main', transpile)).toThrow('main.ts: broken scene');
});
