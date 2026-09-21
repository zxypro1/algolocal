const { t, code, file, readonlyFile, spec } = require('./_helpers');

const contract = readonlyFile('src/types.ts', code`
  export type Vec4 = [number, number, number, number];
  export type Color = [number, number, number, number]; // RGBA, 0..255
  export type Mat4 = number[]; // row-major, column vectors: out = M * v
  export interface Frame { width: number; height: number; pixels: Uint8ClampedArray; }
  export interface Vertex { position: Vec4; color: Color; }
  export interface Sample { x: number; y: number; weights: [number, number, number]; }
`);
const framebuffer = code`
  import type { Frame, Color } from './types';
  export function createFrame(width: number, height: number): Frame {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('Invalid frame size');
    return { width, height, pixels: new Uint8ClampedArray(width * height * 4) };
  }
  export function clear(frame: Frame, color: Color): void {
    for (let i = 0; i < frame.pixels.length; i += 4) frame.pixels.set(color, i);
  }
  export function putPixel(frame: Frame, x: number, y: number, color: Color): void {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= frame.width || y >= frame.height) return;
    frame.pixels.set(color, (y * frame.width + x) * 4);
  }
`;
const math = code`
  import type { Mat4, Vec4 } from './types';
  export function multiply(a: Mat4, b: Mat4): Mat4 {
    const out = Array(16).fill(0);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) out[r*4+c] += a[r*4+k] * b[k*4+c];
    return out;
  }
  export function transform(m: Mat4, v: Vec4): Vec4 {
    return [0,1,2,3].map(r => v.reduce((s, n, c) => s + m[r*4+c] * n, 0)) as Vec4;
  }
  export function perspective(fov: number, aspect: number, near: number, far: number): Mat4 {
    if (!(fov > 0 && fov < Math.PI && aspect > 0 && near > 0 && far > near)) throw new Error('Invalid camera');
    const f = 1 / Math.tan(fov / 2);
    return [f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)/(near-far),2*far*near/(near-far), 0,0,-1,0];
  }
`;
const raster = code`
  import type { Sample } from './types';
  export function rasterize(vertices: number[][], width: number, height: number): Sample[] {
    const [a,b,c] = vertices;
    const edge = (u: number[], v: number[], x: number, y: number) => (v[0]-u[0])*(y-u[1])-(v[1]-u[1])*(x-u[0]);
    const area = edge(a,b,c[0],c[1]);
    if (!Number.isFinite(area) || Math.abs(area) < 1e-10) return [];
    const samples: Sample[] = [];
    const x0 = Math.max(0, Math.floor(Math.min(a[0],b[0],c[0])));
    const x1 = Math.min(width-1, Math.ceil(Math.max(a[0],b[0],c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1],b[1],c[1])));
    const y1 = Math.min(height-1, Math.ceil(Math.max(a[1],b[1],c[1])));
    for (let y=y0; y<=y1; y++) for (let x=x0; x<=x1; x++) {
      const u = edge(b,c,x+0.5,y+0.5)/area;
      const v = edge(c,a,x+0.5,y+0.5)/area;
      const w = 1-u-v;
      if (u >= -1e-10 && v >= -1e-10 && w >= -1e-10) samples.push({ x, y, weights: [u,v,w] });
    }
    return samples;
  }
`;
const depth = code`
  export function createDepth(width: number, height: number): Float64Array {
    return new Float64Array(width * height).fill(Infinity);
  }
  export function depthTest(buffer: Float64Array, index: number, z: number): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= buffer.length || !Number.isFinite(z) || z < 0 || z > 1 || z >= buffer[index]) return false;
    buffer[index] = z;
    return true;
  }
`;
const clipping = code`
  import type { Vertex, Vec4, Color } from './types';
  export function clipTriangle(triangle: Vertex[]): Vertex[][] {
    // Sutherland–Hodgman against all six homogeneous clip planes.
    const planes = [(p: Vec4) => p[3]+p[0], (p: Vec4) => p[3]-p[0],
      (p: Vec4) => p[3]+p[1], (p: Vec4) => p[3]-p[1],
      (p: Vec4) => p[3]+p[2], (p: Vec4) => p[3]-p[2]];
    let polygon = triangle;
    for (const distance of planes) {
      const next: Vertex[] = [];
      for (let i=0; i<polygon.length; i++) {
        const a = polygon[i], b = polygon[(i+1)%polygon.length];
        const da = distance(a.position), db = distance(b.position);
        if (da >= 0) next.push(a);
        if ((da >= 0) !== (db >= 0)) {
          const t = da/(da-db);
          next.push({ position: a.position.map((v,j) => v+(b.position[j]-v)*t) as Vec4,
            color: a.color.map((v,j) => v+(b.color[j]-v)*t) as Color });
        }
      }
      polygon = next;
    }
    const result: Vertex[][] = [];
    for (let i=1; i+1<polygon.length; i++) result.push([polygon[0],polygon[i],polygon[i+1]]);
    return result;
  }
`;
const shader = code`
  import type { Color, Vertex } from './types';
  export function interpolateColor(vertices: Vertex[], weights: number[]): Color {
    const q = weights.map((v,i) => v / vertices[i].position[3]);
    const sum = q.reduce((a,b) => a+b, 0);
    return [0,1,2,3].map(c => q.reduce((s,v,i) => s+v*vertices[i].color[c], 0)/sum) as Color;
  }
  export function lambert(color: Color, normal: number[], light: number[]): Color {
    const length = (v: number[]) => Math.hypot(...v);
    const denominator = length(normal)*length(light);
    const diffuse = denominator ? Math.max(0, Math.min(1, normal.reduce((s,v,i) => s+v*light[i],0)/denominator)) : 0;
    return [color[0]*(0.2+0.8*diffuse),color[1]*(0.2+0.8*diffuse),color[2]*(0.2+0.8*diffuse),color[3]];
  }
`;
const renderer = code`
  import { createFrame, clear, putPixel } from './framebuffer';
  import { createDepth, depthTest } from './depth';
  import { clipTriangle } from './clipping';
  import { rasterize } from './rasterizer';
  import { interpolateColor } from './shader';
  import { toScreen } from './viewport';
  import type { Vertex, Color } from './types';
  export function createRenderer(width: number, height: number) {
    const frame = createFrame(width,height);
    const depth = createDepth(width,height);
    return {
      frame,
      clear(color: Color) { clear(frame,color); depth.fill(Infinity); },
      drawTriangles(vertices: Vertex[], indices: number[], program: {
        vertex: (v: Vertex) => Vertex;
        fragment: (color: Color) => Color;
      }) {
        if (indices.length % 3 || indices.some(i => !Number.isInteger(i) || i < 0 || i >= vertices.length)) throw new Error('Invalid triangle indices');
        const transformed = vertices.map(v => program.vertex(v));
        for (let i=0; i<indices.length; i+=3) {
          const input = indices.slice(i,i+3).map(j => transformed[j]);
          for (const tri of clipTriangle(input)) {
            if (tri.some(v => v.position[3] <= 1e-8)) continue;
            const screen = tri.map(v => toScreen(v.position,width,height));
            for (const sample of rasterize(screen,width,height)) {
              const z = sample.weights.reduce((sum,w,j) => sum+w*tri[j].position[2]/tri[j].position[3],0)*0.5+0.5;
              if (depthTest(depth,sample.y*width+sample.x,z)) putPixel(frame,sample.x,sample.y,program.fragment(interpolateColor(tri,sample.weights)));
            }
          }
        }
      }
    };
  }
`;

// The beginner route provides the machinery and asks for one small change per stage.
const rotation = code`
  import type { Vec4 } from './types';
  // position = [left/right, up/down, front/back, 1]. angle is measured in radians.
  export function rotateY(position: Vec4, angle: number): Vec4 {
    const [x,y,z,w] = position;
    const c = Math.cos(angle), s = Math.sin(angle);
    return [x*c + z*s, y, -x*s + z*c, w];
  }
`;
const viewport = code`
  import type { Vec4 } from './types';
  export function toScreen(position: Vec4, width: number, height: number): [number,number] {
    // The camera helper already calculated w. Dividing by w makes far objects smaller.
    const nx = position[0] / position[3];
    const ny = position[1] / position[3];
    return [(nx+1)*width/2, (1-ny)*height/2];
  }
`;
const background = `import { createFrame, clear, putPixel } from '../src/framebuffer';\nimport { scene } from '../src/scene';\n`;
const startFrame = `const frame=createFrame(width,height); clear(frame,scene.background);`;
const specs = {};
specs[0] = "import { createFrame, clear, putPixel } from '../src/framebuffer';\ndescribe('RGBA buffer', () => {\n  it('writes the correct row and channel order', () => {\n    const f = createFrame(3,2); clear(f,[2,3,4,255]); putPixel(f,2,1,[255,80,9,128]);\n    expect(Array.from(f.pixels.slice(20,24))).toEqual([255,80,9,128]);\n    expect(Array.from(f.pixels.slice(0,4))).toEqual([2,3,4,255]);\n  });\n  it('ignores invalid coordinates and rejects invalid sizes', () => {\n    const f=createFrame(2,2); putPixel(f,-1,1,[255,0,0,255]); putPixel(f,2,0,[255,0,0,255]); putPixel(f,0.5,0,[255,0,0,255]);\n    expect(Array.from(f.pixels).every(v=>v===0)).toBe(true); putPixel(f,1,1,[5,6,7,255]); expect(Array.from(f.pixels.slice(12,16))).toEqual([5,6,7,255]);\n    expect(()=>createFrame(0,2)).toThrow(); expect(()=>createFrame(2.5,2)).toThrow();\n  });\n});\n";
specs[2] = "import { rasterize } from '../src/rasterizer';\nit('samples centers with correct weights',()=>{\n  const s=rasterize([[0,0],[4,0],[0,4]],4,4), p=s.find(v=>v.x===0&&v.y===0)!;\n  expect(s.length).toBe(10); expect(p.weights).toEqual([0.75,0.125,0.125]);\n  expect(rasterize([[0,4],[4,0],[0,0]],4,4).length).toBe(10);\n});\nit('clips bounds and discards zero area',()=>{\n  expect(rasterize([[0,0],[1,1],[2,2]],8,8)).toEqual([]);\n  const s=rasterize([[-100,-100],[100,0],[0,100]],4,3);\n  expect(s.length>0).toBe(true); expect(s.every(p=>p.x>=0&&p.x<4&&p.y>=0&&p.y<3)).toBe(true); expect(s.some(p=>p.weights[1]>0)).toBe(true);\n});\n";
specs[3] = "import { createDepth, depthTest } from '../src/depth';\nit('keeps the nearest fragment independent of draw order',()=>{\n  const d=createDepth(2,2); expect(depthTest(d,0,0.8)).toBe(true); expect(depthTest(d,0,0.2)).toBe(true);\n  expect(depthTest(d,0,0.7)).toBe(false); expect(depthTest(d,0,0.2)).toBe(false); expect(d[0]).toBe(0.2);\n  expect(depthTest(d,1,0)).toBe(true); expect(depthTest(d,2,1)).toBe(true);\n});\nit('does not corrupt the buffer on invalid fragments',()=>{\n  const d=createDepth(1,1);\n  for(const z of [NaN,Infinity,-0.1,1.1]) expect(depthTest(d,0,z)).toBe(false);\n  expect(depthTest(d,-1,0)).toBe(false); expect(depthTest(d,0.5,0)).toBe(false); expect(d[0]).toBe(Infinity); depthTest(d,0,0.2); expect(depthTest(d,0,0.9)).toBe(false);\n});\n";
specs[5] = "import { interpolateColor,lambert } from '../src/shader';\nit('corrects attributes by reciprocal w',()=>{\n  const tri=[{position:[0,0,0,1],color:[240,0,0,255]},{position:[0,0,0,2],color:[0,240,0,255]},{position:[0,0,0,4],color:[0,0,240,255]}];\n  const c=interpolateColor(tri as any,[1/3,1/3,1/3]);\n  expect(c[0]).toBeCloseTo(240*4/7); expect(c[1]).toBeCloseTo(240*2/7); expect(c[2]).toBeCloseTo(240/7); expect(c[3]).toBeCloseTo(255); expect(lambert([100,50,25,128],[1,0,0],[0,0,1])).toEqual([20,10,5,128]);\n});\nit('normalizes vectors and keeps ambient and alpha',()=>{\n  expect(lambert([100,50,25,128],[0,0,2],[0,0,4])).toEqual([100,50,25,128]);\n  expect(lambert([100,50,25,128],[0,0,-1],[0,0,1])).toEqual([20,10,5,128]);\n  expect(lambert([100,50,25,128],[0,0,0],[0,0,1])).toEqual([20,10,5,128]);\n});\n";
specs[6] = "import { createRenderer } from '../src/renderer';\nconst vertices=(z:number,color:number[])=>[[-.8,-.8,z,1],[.8,-.8,z,1],[0,.8,z,1]].map(position=>({position,color}));\nconst pass={vertex:(v:any)=>v,fragment:(c:any)=>c};\nit('draws indexed triangles and invokes both shaders',()=>{\n  const r=createRenderer(20,20); r.clear([0,0,0,255]); let calls=0;\n  r.drawTriangles(vertices(0,[255,0,0,255]) as any,[0,1,2],{vertex:v=>{calls++;return v;},fragment:()=>[0,255,0,255]});\n  expect(calls).toBe(3); expect(Array.from(r.frame.pixels.slice((10*20+10)*4,(10*20+10)*4+4))).toEqual([0,255,0,255]);\n});\nit('resolves occlusion and clears depth for the next frame',()=>{\n  const r=createRenderer(20,20), pixel=()=>Array.from(r.frame.pixels.slice(840,844)); r.clear([0,0,0,255]);\n  r.drawTriangles(vertices(-.5,[255,0,0,255]) as any,[0,1,2],pass);\n  r.drawTriangles(vertices(.5,[0,0,255,255]) as any,[0,1,2],pass); expect(pixel()).toEqual([255,0,0,255]);\n  r.clear([0,0,0,255]); r.drawTriangles(vertices(.5,[0,0,255,255]) as any,[0,1,2],{...pass,fragment:()=>[30,60,90,255]}); expect(pixel()).toEqual([30,60,90,255]);\n});\nit('clips outside geometry and rejects invalid indices',()=>{\n  const r=createRenderer(8,8); r.clear([0,0,0,255]); r.drawTriangles(vertices(-2,[255,0,0,255]) as any,[0,1,2],pass);\n  expect(Array.from(r.frame.pixels).filter((_,i)=>i%4===0).every(v=>v===0)).toBe(true);\n  expect(()=>r.drawTriangles(vertices(0,[255,0,0,255]) as any,[0,1,9],pass)).toThrow(); r.drawTriangles(vertices(0,[255,0,0,255]) as any,[0,1,2],{...pass,fragment:()=>[10,20,30,255]}); expect(Array.from(r.frame.pixels.slice(144,148))).toEqual([10,20,30,255]);\n});\n";
const sharedPrimer = t(
  '这门课不要求你学过图形学或线性代数。只需要认识变量、数组、函数和 for 循环。代码中写着“工具”的文件已经能工作，不需要一次读懂。先观察本关参考画面，再只修改 TODO 标出的那一行，最后对照画面运行验收。即使还不理解全部公式，也可以先用给出的数字手算一次，确认代码确实表达了这件事。',
  'You do not need computer graphics or linear algebra knowledge for this course. You only need variables, arrays, functions and for loops. Files marked as tools already work; you do not need to understand all their internals yet. Look at the stage reference, change only the marked TODO, compare the image, then run acceptance tests. Treat a formula as a small recipe: substitute the example numbers once and check the result before trying to understand its general derivation. The goal is one visible success at a time, with the surrounding machinery supplied for you.'
);
function lesson({ id, title, intro, task, path, starter, reference, tests, demo, hint, result, tools = [] }) {
  return {
    id, title,
    primer: t(intro.zh + '\n\n' + sharedPrimer.zh, intro.en + '\n\n' + sharedPrimer.en),
    goal: t('## 这关只做一件事\n\n' + task.zh + '\n\n## 跟着做\n\n1. 点击右侧“本关参考”，看看目标画面。\n2. 切回“我的代码”，打开 `' + path + '`，找到唯一的 TODO。其他代码已准备好。\n3. 按上面的例子补完代码，停止输入后画面会自动更新。\n4. 点击“运行验收”，通过后进入下一关。\n\n## 做对后会看到什么\n\n' + result.zh,
      '## One small task\n\n' + task.en + '\n\n## Follow along\n\n1. Open Stage reference to see the target.\n2. Switch to My code, open `' + path + '` and find the only TODO. Everything around it is supplied.\n3. Complete that change; the preview updates automatically after typing stops.\n4. Run acceptance tests to unlock the next lesson.\n\n## What success looks like\n\n' + result.en),
    checklist: [t('先对照画面，再完成一处 TODO', 'Compare the image, then complete one TODO'), t('运行验收，确认这个小步骤正确', 'Run tests to check this small step')],
    hints: [hint, t('不用重写整个文件。工具函数、输入检查和循环已经提供；只替换 TODO 下面那一行。', 'Do not rewrite the file. Helpers, input checks and loops are supplied; replace only the line below TODO.')],
    pitfalls: [t('如果画面没变，先确认预览选择的是“我的代码”。“本关参考”和“最终效果”不会运行你的草稿。', 'If the image does not change, select My code. The two reference modes do not run your drafts.')],
    starterFiles: [file(path,starter,{openByDefault:true}), readonlyFile('preview/entry.ts',demo), ...tools],
    referenceFiles: [file(path,reference)], specs: [spec('spec/lesson.spec.ts',tests)],
    referenceNotes: t('先找到参考实现中与你的 TODO 对应的一行，代入本关例子验证。剩下的代码是课程提供的工具，完整算法可以学完入门路线后再研究。', 'Find the reference line matching your TODO and substitute the lesson example. The remaining code is supplied tooling; study its full algorithm after finishing the beginner route.'),
    extension: t('选学：读一读本文件已经提供的部分，再尝试不用骨架重写。这个挑战不影响通关。', 'Optional: study the supplied scaffolding and try rewriting it independently. This challenge is not required to advance.'),
    focus: ['correctness','encapsulation'],
  };
}
const stages = [
  lesson({id:'framebuffer', title:t('点亮一个像素','Light up one pixel'),
    intro:t('先把屏幕想成方格纸：每个小格叫“像素”。x 表示第几列，y 表示第几行，都从 0 开始。一种颜色用 [红,绿,蓝,不透明度] 四个数表示，每个数在 0 到 255 之间；[255,0,0,255] 就是不透明的红色。\n\n电脑把所有格子排成一条长数组，每格占 4 个位置。在宽度为 3 的画布中，(2,1) 前面有 1×3+2=5 个格子，所以它从数组的第 20 个位置开始。你只需要告诉电脑从哪里写颜色。',
      'Imagine the screen as graph paper. A square is a pixel. x is its column and y is its row, both starting at zero. A color is four numbers: [red, green, blue, opacity], each from 0 to 255. [255,0,0,255] is opaque red.\n\nThe computer stores the squares in one long array with four slots per pixel. In a frame three pixels wide, (2,1) has 1×3+2=5 pixels before it, so its color starts at slot 20. Your only job is to calculate that starting slot.'),
    task:t('在 putPixel 中，把写入位置 0 改为 `(y * frame.width + x) * 4`。不用修改创建画布、清屏和越界检查。先手算：宽 3，x=2，y=1，结果应为 20。', 'In putPixel, replace offset 0 with `(y * frame.width + x) * 4`. Allocation, clearing and bounds checks are already supplied. Check width=3, x=2, y=1: the answer is 20.'),
    path:'src/framebuffer.ts', starter:framebuffer.replace('frame.pixels.set(color, (y * frame.width + x) * 4);','// TODO: 把 0 换成这个像素在数组中的起始位置 / Calculate the pixel offset.\n    frame.pixels.set(color, 0);'), reference:framebuffer, tests:specs[0],
    hint:t('一行有 width 个像素，前面有 y 行；再加本行的 x 个像素，最后乘每个像素的 4 个通道。', 'Count y complete rows, add x pixels in this row, then multiply by four channels.'),
    result:t('一整块彩色渐变，而不再只有角落里的一个点。你已经掌握了渲染器最基本的输出方式。', 'A full color gradient instead of one pixel in the corner. You have built the renderer’s most basic output operation.'),
    demo:background+`export function renderFrame(time:number,width:number,height:number) { ${startFrame} for(let y=30;y<height-30;y++) for(let x=30;x<width-30;x++) putPixel(frame,x,y,[x/width*255,y/height*255,scene.color[2],255]); return frame; }`,
  }),
  lesson({id:'rotation', title:t('让几个点转起来','Make a few points rotate'),
    intro:t('三维位置只是比二维多了一个数：[x,y,z]。x 是左右，y 是上下，z 是前后。想象一根竖直的筷子，绕着它转动时，高度 y 不变，左右 x 和前后 z 会互相变化。这叫“绕 Y 轴旋转”。\n\n本关已经算好 c 和 s，你可以把它们当成旋转配方里的两个系数，不用先学习三角函数。配方是新 x=x×c+z×s，新 z=−x×s+z×c。转四分之一圈时 c=0、s=1，点 [1,0,0] 就会变成 [0,0,−1]。第四个数 w 原样保留即可。',
      'A 3D position adds one number to a 2D position: [x,y,z] means left/right, up/down and front/back. Imagine rotating around an upright stick. Height y stays the same, while x and z change together. This is rotation around the Y axis.\n\nThe code supplies coefficients c and s, so you can use the recipe without learning trigonometry first: new x=x×c+z×s and new z=−x×s+z×c. At a quarter turn c=0 and s=1, so [1,0,0] becomes [0,0,−1]. Keep the fourth number w unchanged.'),
    task:t('把返回的 `[x,y,z,w]` 换成 `[x*c + z*s, y, -x*s + z*c, w]`。相机和投影已经提供，本关只负责转动这些点。', 'Replace `[x,y,z,w]` with `[x*c + z*s, y, -x*s + z*c, w]`. The supplied camera handles projection; you only rotate the points.'),
    path:'src/rotation.ts', starter:rotation.replace('return [x*c + z*s, y, -x*s + z*c, w];','// TODO: 按配方计算新的 x、z / Apply the rotation recipe.\n    return [x,y,z,w];'),reference:rotation,
    tests:code`
      import { rotateY } from '../src/rotation';
      it('a quarter turn moves right toward the back',()=>{const p=rotateY([1,2,0,1],Math.PI/2);expect(p[0]).toBeCloseTo(0);expect(p[1]).toBe(2);expect(p[2]).toBeCloseTo(-1);expect(p[3]).toBe(1);});
      it('zero and full turns preserve a point',()=>{expect(rotateY([2,3,4,1],0)).toEqual([2,3,4,1]);const p=rotateY([2,3,4,1],Math.PI*2);expect(p[0]).toBeCloseTo(2);expect(p[2]).toBeCloseTo(4);const q=rotateY([2,3,4,1],Math.PI);expect(q[0]).toBeCloseTo(-2);expect(q[2]).toBeCloseTo(-4);});
    `,
    hint:t('只计算左右与前后两个分量，y 和 w 原样放回数组。负号不要漏掉。', 'Change only x and z. Return y and w unchanged, and keep the minus sign.'),
    result:t('八个彩色点开始转动，像一个透明方盒子的八个角。修改 src/scene.ts 中的 speed 可以调节速度。', 'Eight colored points rotate like the corners of a transparent box. Change speed in src/scene.ts to adjust the motion.'),
    demo:background+`import { rotateY } from '../src/rotation'; import { perspective,transform } from '../src/math';
      export function renderFrame(time:number,width:number,height:number) { ${startFrame} const camera=perspective(1,width/height,.1,20);
      for(const x of [-1,1]) for(const y of [-1,1]) for(const z of [-1,1]) { const p=rotateY([x,y,z,1],time*scene.speed); p[2]-=5; const v=transform(camera,p);
        const sx=Math.round((v[0]/v[3]+1)*width/2),sy=Math.round((1-v[1]/v[3])*height/2);
        for(let dy=-3;dy<=3;dy++) for(let dx=-3;dx<=3;dx++) putPixel(frame,sx+dx,sy+dy,scene.color); } return frame; }`,
  }),
  lesson({id:'viewport',title:t('把位置放到画布上','Place points on the canvas'),
    intro:t('相机工具把三维位置转换成“标准坐标”：左右和上下都用 −1 到 1 表示。0 是中间，−1 是左边或下边，1 是右边或上边。这样一来，相机不用关心窗口究竟有多少像素。\n\n你的任务是把这个刻度换成画布上的像素位置。宽度为 200 时，横坐标 −1、0、1 分别对应 0、100、200。公式是 (nx+1)×width÷2。屏幕的 y 向下增加，与标准坐标相反，因此纵坐标用 (1−ny)×height÷2。除以 w 的步骤已经提供，它会让远处物体看起来更小。',
      'The camera helper converts 3D positions into normalized coordinates. Horizontal and vertical positions range from −1 to 1, with zero at the center. This lets the camera ignore the actual window size.\n\nConvert this scale into pixel positions. For width 200, x values −1, 0 and 1 map to 0, 100 and 200. The recipe is (nx+1)×width÷2. Screen y increases downward, the opposite direction, so use (1−ny)×height÷2 vertically. Division by w is already supplied; it makes far objects look smaller.'),
    task:t('将固定返回的画布中心替换成 `[(nx+1)*width/2, (1-ny)*height/2]`。结果可以是小数，画点时工具会取整。', 'Replace the fixed canvas center with `[(nx+1)*width/2, (1-ny)*height/2]`. Fractional coordinates are fine; the point-drawing helper rounds them.'),
    path:'src/viewport.ts',starter:viewport.replace('return [(nx+1)*width/2, (1-ny)*height/2];','// TODO: 把标准坐标转换为像素位置 / Map to screen coordinates.\n    return [width/2,height/2];'),reference:viewport,
    tests:code`
      import { toScreen } from '../src/viewport';
      it('maps center and corners',()=>{expect(toScreen([0,0,0,1],200,100)).toEqual([100,50]);expect(toScreen([-1,1,0,1],200,100)).toEqual([0,0]);expect(toScreen([1,-1,0,1],200,100)).toEqual([200,100]);});
      it('divides by camera distance before mapping',()=>{expect(toScreen([1,1,0,2],200,100)).toEqual([150,25]);});
    `,
    hint:t('先加 1 把 [-1,1] 变成 [0,2]，再除以 2 变成 [0,1]，最后乘画布宽度。y 方向需要翻过来。', 'Add one to change [-1,1] to [0,2], halve it to get [0,1], then multiply by the size. Flip y.'),
    result:t('原来挤在中心的点分散成旋转方盒子的八个角。这个小函数会被最终渲染器继续使用。', 'Points previously piled at the center spread into eight rotating box corners. The final renderer reuses this function.'),
    demo:background+`import { rotateY } from '../src/rotation'; import { perspective,transform } from '../src/math'; import { toScreen } from '../src/viewport';
      export function renderFrame(time:number,width:number,height:number) { ${startFrame} const camera=perspective(1,width/height,.1,20);
      for(const x of [-1,1]) for(const y of [-1,1]) for(const z of [-1,1]) { const p=rotateY([x,y,z,1],time*scene.speed); p[2]-=5; const v=transform(camera,p); const [px,py]=toScreen(v,width,height);
        for(let dy=-3;dy<=3;dy++) for(let dx=-3;dx<=3;dx++) putPixel(frame,Math.round(px)+dx,Math.round(py)+dy,scene.color); } return frame; }`,
  }),
  lesson({id:'rasterization',title:t('给三角形填上颜色','Fill a triangle with color'),
    intro:t('三维模型通常由很多三角形拼成。先学会画一个，就能重复使用同样的方法画整个模型。把三角形覆盖的方格找出来叫“光栅化”。本关已经提供寻找方格的循环，你不用从头推导算法。\n\n每个方格还需要一种颜色。可以把三个顶点想成红、绿、蓝三桶颜料；u、v、w 表示各取多少，三者相加等于 1。靠近红顶点时，u 会更大。比如 [0.75,0.125,0.125] 表示 75% 红、12.5% 绿和 12.5% 蓝。工具已经算好这三个比例，你只要把它们交给画图代码。',
      '3D models are usually made of triangles. Learn to draw one and the same method can draw an entire model. Finding covered pixel squares is called rasterization. The pixel-search loop is supplied, so you do not have to derive the algorithm.\n\nEach square also needs a color. Think of the three vertices as buckets of red, green and blue paint. u, v and w say how much to use from each bucket and sum to one. Near the red vertex, u is larger. [0.75,0.125,0.125] means 75% red and 12.5% each of green and blue. The helper has calculated the proportions; pass them to the drawing code.'),
    task:t('找到 samples.push，把固定的 `weights: [1,0,0]` 改成 `weights: [u,v,w]`。其余用于判断哪些像素在三角形内的代码，作为工具直接使用。', 'In samples.push, replace fixed `weights: [1,0,0]` with `weights: [u,v,w]`. Use the supplied coverage calculations as a helper.'),
    path:'src/rasterizer.ts',starter:raster.replace('if (u >= -1e-10 && v >= -1e-10 && w >= -1e-10) samples.push({ x, y, weights: [u,v,w] });','// TODO: 传回算好的三种颜色比例 / Return the calculated weights.\n      if (u >= -1e-10 && v >= -1e-10 && w >= -1e-10) samples.push({ x, y, weights: [1,0,0] });'),reference:raster,tests:specs[2],
    hint:t('[1,0,0] 表示全用第一个顶点的颜色，所以现在整块都是红色。换成每个像素自己的比例即可。', '[1,0,0] uses only the first vertex color, making the whole triangle red. Return each pixel’s own proportions instead.'),
    result:t('纯红三角形变成平滑的红绿蓝渐变。这就是“插值”：根据位置混合几个已知值。', 'The solid red triangle becomes a smooth RGB gradient. This is interpolation: mixing known values according to position.'),
    demo:background+`import { rasterize } from '../src/rasterizer'; export function renderFrame(time:number,width:number,height:number) { ${startFrame} for(const s of rasterize([[width*.5,height*.12],[width*.15,height*.85],[width*.85,height*.85]],width,height)) putPixel(frame,s.x,s.y,[s.weights[0]*255,s.weights[1]*255,s.weights[2]*255,255]); return frame; }`,
  }),
  lesson({id:'depth',title:t('让前面的物体挡住后面','Keep the nearest surface visible'),
    intro:t('画两张重叠的三角形时，最后画的颜色会盖住前面的颜色。但真实世界里应该是“近的挡住远的”，和画图顺序无关。我们给每个像素再准备一张小纸条，记下目前最近的距离，这张表叫“深度缓冲”。\n\n本项目的深度 z 在 0 到 1 之间，数字越小越近。如果纸条写着 0.2，而新来的像素距离是 0.8，它更远，不能覆盖；新距离是 0.1 就可以覆盖，并把纸条改为 0.1。每一帧重新开始时都把纸条清成 Infinity，表示还没看到任何物体。',
      'When two triangles overlap, painting later normally overwrites earlier colors. Real visibility should depend on distance, not drawing order. Give each pixel a small note recording the nearest distance seen so far. This table is the depth buffer.\n\nDepth z ranges from zero to one, with smaller values closer. If the note says 0.2 and a new fragment arrives at 0.8, it is farther and must not overwrite the pixel. A new depth of 0.1 may replace it and update the note. Each frame starts with Infinity, meaning no surface has been seen yet.'),
    task:t('depthTest 已经负责检查输入和记录距离。只补一个判断：当 `z >= buffer[index]` 时返回 false，不让更远或相同距离的颜色覆盖。', 'Input validation and distance recording are provided. Add one check: return false when `z >= buffer[index]`, rejecting farther or equal-depth fragments.'),
    path:'src/depth.ts',starter:depth.replace(' || z >= buffer[index]','').replace('buffer[index] = z;','// TODO: false 换成“新像素没有更近”的判断 / Reject a fragment that is not closer.\n    if (false) return false;\n    buffer[index] = z;'),reference:depth,tests:specs[3],
    hint:t('“更近”意味着数字更小；所以新数字大于或等于旧数字时应该拒绝。', 'Closer means a smaller number. Reject the new number when it is greater than or equal to the old one.'),
    result:t('青色三角形稳稳挡住后面的橙色三角形，即使橙色是后画的。', 'The cyan triangle stays in front of the orange triangle even though orange is drawn later.'),
    demo:background+`import { rasterize } from '../src/rasterizer'; import { createDepth,depthTest } from '../src/depth'; export function renderFrame(time:number,width:number,height:number) { ${startFrame} const depth=createDepth(width,height);
      for(const [offset,z,color] of [[0,.25,scene.color],[.18,.8,[245,160,70,255]]] as any[]) for(const s of rasterize([[width*(.35+offset),height*.15],[width*(.1+offset),height*.8],[width*(.7+offset),height*.8]],width,height)) if(depthTest(depth,s.y*width+s.x,z)) putPixel(frame,s.x,s.y,color); return frame; }`,
  }),
  lesson({id:'lighting',title:t('给表面加一点明暗','Add light and shade'),
    intro:t('同样的颜色，有的面朝着灯就更亮，有的背着灯就更暗，物体因此显出立体感。你可以把“法线”理解成贴在表面、朝外指的小箭头；光方向是指向灯的小箭头。工具会比较两支箭头，得到 diffuse：正对灯时是 1，侧对或背对时接近 0。\n\n本关不要求你计算箭头。只需要把亮度用在红绿蓝三个通道上。我们保留 20% 基础亮度，避免背光面完全黑掉：亮度=0.2+0.8×diffuse。例如原来的红色通道是 100，diffuse=0 时变成 20，diffuse=1 时仍为 100。透明度不受光照影响。',
      'A surface facing a lamp looks brighter than one facing away, giving a flat color a 3D appearance. A normal is simply a small arrow pointing outward from the surface. A light direction is an arrow toward the lamp. The supplied helper compares them to produce diffuse: one when directly facing the lamp, near zero when sideways or facing away.\n\nYou do not calculate the arrows here. Apply brightness to red, green and blue. Keep 20% base light with brightness=0.2+0.8×diffuse. A red channel of 100 becomes 20 at diffuse=0 and stays 100 at diffuse=1. Opacity is unaffected.'),
    task:t('在 lambert 最后一行，让 color[0]、color[1]、color[2] 各乘 `(0.2+0.8*diffuse)`，color[3] 保持不变。上面的颜色混合和箭头计算都是已提供的工具。', 'In the final line of lambert, multiply color[0], color[1] and color[2] by `(0.2+0.8*diffuse)`. Keep color[3] unchanged. Color mixing and arrow calculations are supplied.'),
    path:'src/shader.ts',starter:shader.replace('return [color[0]*(0.2+0.8*diffuse),color[1]*(0.2+0.8*diffuse),color[2]*(0.2+0.8*diffuse),color[3]];','// TODO: 把亮度乘进三个颜色通道 / Apply brightness to RGB only.\n    return [color[0],color[1],color[2],color[3]];'),reference:shader,tests:specs[5],
    hint:t('四个数组元素中只改前三个。把三个颜色通道都乘以相同亮度，才不会改变物体本来的色调。', 'Change only the first three array elements. Multiply RGB by the same brightness to preserve the surface hue.'),
    result:t('彩色三角形随时间变亮、变暗，但不会消失。最终立方体的每个面也会使用这个函数。', 'The colored triangle brightens and dims over time without disappearing. Every face of the final cube will use this function.'),
    demo:background+`import { rasterize } from '../src/rasterizer'; import { interpolateColor,lambert } from '../src/shader'; export function renderFrame(time:number,width:number,height:number) { ${startFrame}
      const tri=[{position:[0,0,0,1],color:scene.color},{position:[0,0,0,2],color:[255,140,60,255]},{position:[0,0,0,4],color:[130,100,255,255]}];
      for(const s of rasterize([[width*.5,height*.1],[width*.12,height*.85],[width*.88,height*.85]],width,height)) putPixel(frame,s.x,s.y,lambert(interpolateColor(tri as any,s.weights),[Math.sin(time*scene.speed),0,Math.cos(time*scene.speed)],[0,0,1])); return frame; }`,
  }),
  lesson({id:'pipeline',title:t('拼出你的第一个 3D 渲染器','Assemble your first 3D renderer'),
    intro:t('现在你已经会让像素显示颜色、旋转顶点、换算屏幕位置、混合颜色、判断遮挡和添加明暗。渲染器只是按顺序把这些小工具接在一起。“顶点”是模型上的角，“片元”是准备写到某个像素的一次颜色候选。\n\n“着色器”在这里就是普通函数：vertex 把角的位置送到相机，fragment 决定像素最后是什么颜色。两者都由场景传进来，所以同一套框架可以画不同的物体。本关已经接好前面所有步骤，你只需要让最终颜色经过 fragment 函数。裁剪等较复杂的细节已作为工具提供，入门时不要求实现。',
      'You can now write pixels, rotate corners, map positions to the screen, mix colors, resolve overlap and add shading. A renderer just connects these small tools in order. A vertex is a model corner; a fragment is a candidate color for one pixel.\n\nA shader here is an ordinary function: vertex sends a corner through the camera, and fragment decides its final color. The scene supplies these functions, so the same framework can draw different objects. All earlier steps are connected for you. Pass the final color through fragment. Complex clipping is provided as a helper and is not a beginner requirement.'),
    task:t('找到绘制像素的最后一行，把 `interpolateColor(tri,sample.weights)` 包进 `program.fragment(...)`。只改这一处，让使用者传入的颜色处理函数真正生效。', 'On the pixel-writing line, wrap `interpolateColor(tri,sample.weights)` in `program.fragment(...)`. Make this one change so the caller’s color-processing function is actually used.'),
    path:'src/renderer.ts',starter:renderer.replace('if (depthTest(depth,sample.y*width+sample.x,z)) putPixel(frame,sample.x,sample.y,program.fragment(interpolateColor(tri,sample.weights)));','// TODO: 让颜色经过 program.fragment / Pass the color through the fragment callback.\n              if (depthTest(depth,sample.y*width+sample.x,z)) putPixel(frame,sample.x,sample.y,interpolateColor(tri,sample.weights));'),reference:renderer,tests:specs[6],
    hint:t('这是一次普通的函数调用：先得到颜色 c，再调用 program.fragment(c)，把返回的新颜色写进像素。', 'This is a normal function call: calculate color c, call program.fragment(c), then write the returned color.'),
    result:t('完整立方体开始以青色旋转，近处挡住远处，六个面有不同明暗。未接上 fragment 时它是灰色。你已经完成基础部分！接下来继续给这个渲染器添加缩放、移动、相机、花纹和雾化。', 'A complete cyan cube rotates with correct overlap and shaded faces. Before connecting fragment it is gray. You have finished the foundation. Continue with scaling, movement, camera distance, patterns and fog.'),
    demo:code`
      import { createRenderer } from '../src/renderer';
      import { transform,perspective,multiply } from '../src/math';
      import { rotateY } from '../src/rotation';
      import { lambert } from '../src/shader';
      import { scene } from '../src/scene';
      import type { Vertex,Color } from '../src/types';
      export function renderFrame(time:number,width:number,height:number) {
        const r=createRenderer(width,height); r.clear(scene.background);
        const a=time*scene.speed,ct=Math.cos(.4),st=Math.sin(.4);
        const tilt=[1,0,0,0,0,ct,-st,0,0,st,ct,0,0,0,0,1];
        const view=tilt.slice(); view[11]=-5;
        const camera=multiply(perspective(1,width/height,.1,30),view);
        const positions=[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
        const faces=[[0,3,2,1],[4,5,6,7],[0,4,7,3],[1,2,6,5],[3,7,6,2],[0,1,5,4]];
        const normals=[[0,0,-1],[0,0,1],[-1,0,0],[1,0,0],[0,1,0],[0,-1,0]];
        for(let i=0;i<faces.length;i++) {
          const normal=transform(tilt,rotateY([...normals[i],0] as any,a)).slice(0,3);
          const color=lambert(scene.color,normal,[.5,1,2]);
          const vertices=faces[i].map(j=>({position:[...positions[j],1],color:[190,190,190,255]})) as Vertex[];
          r.drawTriangles(vertices,[0,1,2,0,2,3],{vertex:v=>({...v,position:transform(camera,rotateY(v.position,a))}),fragment:()=>color});
        }
        return r.frame;
      }
    `,
  }),
];
stages.push(...require('./_minigl-extension')(lesson));
stages.forEach((stage,index)=>{
  stage.title=t(`第 ${index+1} 关 · ${stage.title.zh}`,`Stage ${index+1} · ${stage.title.en}`);
  stage.starterFiles[1].path=`preview/stage-${index+1}.ts`;
  stage.specs[0].path=`spec/stage-${index+1}.spec.ts`;
});
module.exports = {
  id:'minigl-renderer',title:t('从零认识 3D · MiniGL 入门实战','Your first 3D renderer · MiniGL for beginners'),
  summary:t('不需要图形学基础。每关只补一处代码，十二关从点亮像素到带花纹和雾化的多物体场景，边改边看实时画面。','No graphics background needed. One small edit per lesson, twelve stages from a pixel to patterned, foggy multi-object scenes with live feedback.'),
  difficulty:'Easy',domain:'graphics',tags:['3D','beginner','rendering','WebGL'],estimatedMinutes:210,language:'typescript',
  workspace:{kind:'code',preview:{kind:'minigl',entryPrefix:'preview/stage-'}},
  weights:{correctness:.8,encapsulation:.1,elegance:.1,concurrency:0,latency:0,resilience:0},
  brief:t('## 给图形学零基础的第一门实战课\n\n你只需要会变量、数组、函数和 for 循环；不用先学矩阵、三角函数或 WebGL。每关约 10 到 20 分钟，只修改一个 TODO。先看效果，再代入具体数字，最后补一行代码并运行验收。\n\n## 你会走过的十二小步\n\n1. 点亮一个像素：把颜色写到正确的格子。\n2. 让几个点转起来：按给出的配方改变位置。\n3. 把位置放到画布上：把标准刻度变成像素坐标。\n4. 给三角形填色：按比例混合红绿蓝。\n5. 判断谁在前面：只保留距离更近的颜色。\n6. 给表面加明暗：颜色乘上亮度。\n7. 拼成渲染器：把几个小工具接起来，看到旋转立方体。\n8. 缩放方块：让位置乘上大小倍数。\n9. 移动物体：把三个方向的移动量加到位置上。\n10. 相机退后：观察近大远小。\n11. 格子花纹：用表面坐标选择不同颜色。\n12. 远处雾化：混合颜色，把前面的小工具组合成多物体场景。\n\n## 哪些内容暂时不用掌握\n\n相机矩阵、齐次裁剪、完整光栅化推导、透视插值作为已提供的工具；不作为入门关卡的独立实现任务。学完后可阅读 src/math.ts 和 src/clipping.ts，尝试不用骨架重写，作为进阶挑战。\n\n这是借鉴 WebGL 思路的教学软件渲染器，CPU 计算像素，Canvas 只显示结果；不是 GPU 加速或完整 WebGL 实现。右侧“我的代码”会随编辑更新，“本关参考”和“最终效果”只用于对照，不修改你的代码与进度。',
    '## A first hands-on course for graphics beginners\n\nOnly variables, arrays, functions and for loops are required. No matrix, trigonometry or WebGL background is assumed. Each 10 to 20 minute lesson has one TODO: observe the target, substitute concrete numbers, make one small edit and run tests.\n\nThe twelve steps are pixels, rotation, screen coordinates, triangle colors, overlap, brightness, assembly, scaling, translation, camera distance, checker patterns and distance fog. Camera matrices, homogeneous clipping, full rasterization derivations and perspective interpolation are supplied tools rather than beginner implementation requirements. Study and rewrite them later as optional challenges.\n\nThis educational software renderer borrows WebGL concepts: the CPU computes pixels and Canvas displays them. It is not GPU accelerated or a complete WebGL implementation. My code previews drafts live; reference modes never overwrite code or progress.'),
  architecture:t('## 先记住这四步就够了\n\n```mermaid\nflowchart TD\n A[模型上的几个点] --> B[转一转，放到屏幕上]\n B --> C[给三角形里的格子涂色]\n C --> D[保留近处颜色，显示画面]\n```\n\n每关只练其中一个小动作。复杂工具已经提供，不用一次理解整条流水线。',
    '## Start with these four steps\n\n```mermaid\nflowchart TD\n A[Points on a model] --> B[Rotate and place on screen]\n B --> C[Color the pixels inside triangles]\n C --> D[Keep the nearer color and display]\n```\n\nPractice one small action per lesson. Complex helpers are supplied; understanding the entire pipeline at once is unnecessary.'),
  files:[contract,readonlyFile('src/math.ts','// 工具：相机与矩阵。本课程不用修改。 / Supplied camera and matrix tools.\n'+math),
    readonlyFile('src/clipping.ts','// 进阶工具：裁剪屏幕外的几何体。本课程不用修改。 / Supplied clipping tool.\n'+clipping),
    file('src/scene.ts',code`
      import type { Color } from './types';
      // Optional: change colors or speed and watch My code update.
      export const scene = {
        background: [15,23,42,255] as Color,
        color: [70,205,235,255] as Color,
        speed: 0.7,
      };
    `)],stages,
};
