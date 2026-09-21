import { createModuleRuntime } from './moduleRuntime';
import type { TranspileFn } from './moduleRuntime';

export interface PreviewFrame {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

/** The same draft module graph as acceptance tests, with a real-time frame entry. */
export function createPreviewRenderer(files: Record<string, string>, entry: string, transpile: TranspileFn) {
  const runtime = createModuleRuntime({ files, transpile });
  const module = runtime.require(entry) as { renderFrame?: (time: number, width: number, height: number) => PreviewFrame };
  if (typeof module.renderFrame !== 'function') throw new Error(`${entry}: export renderFrame(time, width, height)`);
  return (time: number, width: number, height: number): PreviewFrame => {
    const frame = module.renderFrame!(time, width, height);
    if (!frame || frame.width !== width || frame.height !== height ||
        !(frame.pixels instanceof Uint8ClampedArray) || frame.pixels.length !== width * height * 4) {
      throw new Error('renderFrame must return { width, height, pixels: Uint8ClampedArray(width * height * 4) }');
    }
    return frame;
  };
}
