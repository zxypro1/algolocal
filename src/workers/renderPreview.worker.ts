import * as ts from 'typescript';
import { createPreviewRenderer } from '../lib/engineering/renderPreview';

const context = self as unknown as Worker;
let render: ReturnType<typeof createPreviewRenderer> | undefined;
context.onmessage = (event: MessageEvent) => {
  try {
    const { files, entry, time, width, height } = event.data;
    if (files) {
      render = createPreviewRenderer(files, entry, (source, path) => {
        const result = ts.transpileModule(source, {
          fileName: path,
          reportDiagnostics: true,
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, allowJs: true },
        });
        const errors = result.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) || [];
        if (errors.length) {
          const d = errors[0];
          const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 1;
          throw new Error(`${path}:${line}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
        }
        return result.outputText;
      });
    }
    if (!render) throw new Error('Preview has not been initialized');
    const start = performance.now();
    const frame = render(time, width, height);
    // Copy before transferring: a user renderer may retain and reuse its frame buffer.
    const pixels = new Uint8ClampedArray(frame.pixels);
    context.postMessage({ pixels, duration: performance.now() - start }, [pixels.buffer]);
  } catch (error) {
    context.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
export {};
