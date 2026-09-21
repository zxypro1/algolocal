const { t, code, readonlyFile } = require('./_helpers');

const scale = code`
  import type { Vec4 } from './types';
  export function scalePoint(point: Vec4, size: number): Vec4 {
    const [x,y,z,w] = point;
    return [x*size,y*size,z*size,w];
  }
`;
const translation = code`
  import type { Vec4 } from './types';
  export function translatePoint(point: Vec4, offset: number[]): Vec4 {
    const [x,y,z,w] = point;
    return [x+offset[0],y+offset[1],z+offset[2],w];
  }
`;
const camera = code`
  import type { Vec4 } from './types';
  export function toCamera(point: Vec4, distance: number): Vec4 {
    if (!Number.isFinite(distance) || distance <= 0) throw new Error('Camera distance must be positive');
    const [x,y,z,w] = point;
    return [x,y,z-distance,w];
  }
`;
const checker = code`
  import type { Color } from './types';
  export function checkerColor(u: number, v: number, cells: number, a: Color, b: Color): Color {
    if (!Number.isInteger(cells) || cells < 1) throw new Error('Cell count must be a positive integer');
    // Supplied tool: locate a square on the surface, clamping the outer border.
    const column = Math.min(cells-1,Math.floor(Math.max(0,Math.min(1,u))*cells));
    const row = Math.min(cells-1,Math.floor(Math.max(0,Math.min(1,v))*cells));
    const parity = (column+row) % 2;
    return parity === 0 ? a : b;
  }
`;
const fog = code`
  import type { Color } from './types';
  export function applyFog(color: Color, fogColor: Color, distance: number, near: number, far: number): Color {
    if (!(far > near)) throw new Error('Fog end must be farther than its start');
    const amount = Math.max(0,Math.min(1,(distance-near)/(far-near)));
    return [0,1,2].map(i => color[i]*(1-amount)+fogColor[i]*amount).concat(color[3]) as Color;
  }
`;

// Mesh submission and UV transport are supplied so each new exercise stays small.
const cubeScene = readonlyFile('src/cube-scene.ts', code`
  import { createRenderer } from './renderer';
  import { rotateY } from './rotation';
  import { perspective,transform } from './math';
  import { lambert } from './shader';
  import { scene } from './scene';
  import type { Color,Vec4,Vertex } from './types';
  export interface Cube { size: number; offset: number[]; color: Color; }
  export interface SceneTools {
    scale: (p: Vec4,size: number) => Vec4;
    translate?: (p: Vec4,offset: number[]) => Vec4;
    camera?: (p: Vec4,distance: number) => Vec4;
    material?: (u: number,v: number,color: Color) => Color;
    fog?: (color: Color,distance: number) => Color;
  }
  export function renderCubes(time: number,width: number,height: number,tools: SceneTools,cubes: Cube[],distance=5) {
    const r=createRenderer(width,height); r.clear(scene.background);
    const projection=perspective(1,width/height,.1,30);
    const c=Math.cos(.35),s=Math.sin(.35);
    const tilt=[1,0,0,0,0,c,-s,0,0,s,c,0,0,0,0,1];
    const positions=[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]];
    const faces=[[0,3,2,1],[4,5,6,7],[0,4,7,3],[1,2,6,5],[3,7,6,2],[0,1,5,4]];
    const normals=[[0,0,-1],[0,0,1],[-1,0,0],[1,0,0],[0,1,0],[0,-1,0]];
    // RGB carries face coordinates through the existing perspective interpolation.
    // The material callback then converts those coordinates into a visible color.
    const uv: Color[]=[[0,0,0,255],[255,0,0,255],[255,255,0,255],[0,255,0,255]];
    for (const cube of cubes) for (let face=0;face<faces.length;face++) {
      const normal=transform(tilt,rotateY([...normals[face],0] as Vec4,time*scene.speed)).slice(0,3);
      const vertices=faces[face].map((index,i)=>({position:[...positions[index],1],color:uv[i]})) as Vertex[];
      r.drawTriangles(vertices,[0,1,2,0,2,3],{
        vertex: v => {
          const scaled=tools.scale(v.position,cube.size);
          const rotated=transform(tilt,rotateY(scaled,time*scene.speed));
          const placed=tools.translate ? tools.translate(rotated,cube.offset) : rotated;
          const viewed=tools.camera ? tools.camera(placed,distance) : [placed[0],placed[1],placed[2]-distance,placed[3]] as Vec4;
          return {...v,position:transform(projection,viewed)};
        },
        fragment: uv => {
          const color=tools.material ? tools.material(uv[0]/255,uv[1]/255,cube.color) : cube.color;
          const shaded=lambert(color,normal,[.5,1,2]);
          // Beginner approximation: one distance per object, not per fragment.
          return tools.fog ? tools.fog(shaded,distance-cube.offset[2]) : shaded;
        }
      });
    }
    return r.frame;
  }
`);

const imports = `import { renderCubes } from '../src/cube-scene';\nimport { scalePoint } from '../src/scale';\nimport { scene } from '../src/scene';\n`;
const moveImport = `import { translatePoint } from '../src/translation';\n`;
const cameraImport = `import { toCamera } from '../src/camera';\n`;
const checkerImport = `import { checkerColor } from '../src/checker';\n`;
const material = `(u,v,color)=>checkerColor(u,v,6,color,[245,185,85,255])`;

module.exports = function extension(lesson) {
  return [
    lesson({id:'scale',title:t('让方块变大变小','Make the cube bigger or smaller'),
      intro:t('上一关已经能画出方块了。现在想做一个大方块，不需要重新画八个角，只要让每个角离中心更远一点。把位置中的 x、y、z 同时乘一个数，叫作“缩放”。乘 2 就放大两倍，乘 0.5 就缩小一半；乘 1 则保持原样。\n\n例如 [1,2,3] 缩小一半，得到 [0.5,1,1.5]。这里始终围绕方块自己的中心缩放，之后再旋转和移动。第四个数 w 不是长度，不要跟着乘。预览工具已经负责画图，你只需要补回三个乘法。',
        'You can already draw a cube. Making it bigger does not require a new mesh: move every corner farther from its center. Multiplying x, y and z by the same number is scaling. Two doubles the size, one half halves it, and one keeps it unchanged.\n\nFor example, [1,2,3] at half size becomes [0.5,1,1.5]. Scale around the cube’s own center before rotating and moving it. The fourth number w is not a length and stays unchanged. The preview helper handles drawing; add only the three multiplications.'),
      task:t('在 scalePoint 的返回数组中，让 x、y、z 各乘 size，w 保持不变：`[x*size,y*size,z*size,w]`。本关参考中的 size 是 1.35，因此方块会比起始画面大一些。',
        'Return `[x*size,y*size,z*size,w]` from scalePoint. The reference uses size 1.35, making the cube visibly larger than the starter.'),
      path:'src/scale.ts',starter:scale.replace('return [x*size,y*size,z*size,w];','// TODO: 让三个位置分量乘缩放倍数 / Scale all three coordinates.\n    return [x,y,z,w];'),reference:scale,
      tools:[cubeScene],
      tests:code`
        import { scalePoint } from '../src/scale';
        it('doubles all three lengths, keeping w',()=>{expect(scalePoint([1,2,-3,1],2)).toEqual([2,4,-6,1]);});
        it('shrinks without changing the original point',()=>{const p:any=[2,4,6,1];expect(scalePoint(p,.5)).toEqual([1,2,3,1]);expect(p).toEqual([2,4,6,1]);expect(scalePoint(p,0)).toEqual([0,0,0,1]);});
      `,
      hint:t('前三项是位置，需要乘倍数；第四项 w 原样放回。返回一个新数组，不要修改传入的点。', 'Multiply the first three entries and keep w. Return a new array instead of changing the input.'),
      result:t('方块变得更大，旋转和明暗仍然正常。之后可以用同一张模型数据画不同大小的物体。', 'The cube grows while rotation and lighting still work. One mesh can now produce different object sizes.'),
      demo:imports+`export function renderFrame(time:number,width:number,height:number) { return renderCubes(time,width,height,{scale:scalePoint},[{size:1.35,offset:[0,0,0],color:scene.color}]); }`,
    }),
    lesson({id:'translation',title:t('把方块移到旁边','Move the cube to the side'),
      intro:t('移动一个物体，意味着它所有的点都沿同样的方向走同样远。这叫“平移”。offset 是一个装着三个移动量的数组，分别表示向右、向上、向前移动多少；负数表示反方向。\n\n例如点 [1,2,3] 加上移动量 [2,−1,0]，得到 [3,1,3]：向右两步、向下一步、前后不变。和缩放不同，平移做的是加法。顺序也很重要：先在原地缩放和旋转，再移到指定位置，物体就不会绕着世界中心兜圈。本关的绘制工具已经排好这个顺序。',
        'Moving an object means moving every point in the same direction by the same amount. This is translation. The offset array contains rightward, upward and forward movement; negative values mean the opposite direction.\n\nAdding [2,−1,0] to [1,2,3] gives [3,1,3]: two steps right and one down. Translation uses addition instead of multiplication. Order matters: scale and rotate locally first, then move into place, so the object spins around its own center. The supplied drawing helper already uses this order.'),
      task:t('返回 `[x+offset[0],y+offset[1],z+offset[2],w]`。只补三个加法。预览的 offset 是 [1.1,0.35,0]，表示往右并稍微往上移动。',
        'Return `[x+offset[0],y+offset[1],z+offset[2],w]`. Add three offsets. The preview uses [1.1,0.35,0] to move right and slightly upward.'),
      path:'src/translation.ts',starter:translation.replace('return [x+offset[0],y+offset[1],z+offset[2],w];','// TODO: 分别加上三个方向的移动量 / Add the offsets.\n    return [x,y,z,w];'),reference:translation,
      tests:code`
        import { translatePoint } from '../src/translation';
        it('moves right, down and forward independently',()=>{expect(translatePoint([1,2,3,1],[2,-1,4])).toEqual([3,1,7,1]);});
        it('keeps the mesh reusable instead of moving its input',()=>{const p:any=[1,2,3,1],offset=[-2,1,-3];expect(translatePoint(p,offset)).toEqual([-1,3,0,1]);expect(p).toEqual([1,2,3,1]);expect(offset).toEqual([-2,1,-3]);});
      `,
      hint:t('offset[0] 加到 x，offset[1] 加到 y，offset[2] 加到 z。w 仍然不变。', 'Add offset[0] to x, offset[1] to y, and offset[2] to z. Keep w.'),
      result:t('方块从画布中心移到右上方，并且继续围绕自己的中心旋转。第八关写的缩放函数仍在使用。', 'The cube moves to the upper right while spinning around its own center. Your scaling function is still in use.'),
      demo:imports+moveImport+`export function renderFrame(time:number,width:number,height:number) { return renderCubes(time,width,height,{scale:scalePoint,translate:translatePoint},[{size:.85,offset:[1.1,.35,0],color:scene.color}]); }`,
    }),
    lesson({id:'camera-distance',title:t('让相机退后一点','Move the camera back'),
      intro:t('观察一个物体时，你往后退，它看起来就会变小，但物体本身的大小没有改变。这和第八关直接缩小模型是两件事。计算机里的相机先问：每个点相对于我在哪里？\n\n本课相机只沿前后方向移动，始终朝负 Z 方向看。如果相机位于 z=6，而物体的点位于 z=1，这个点相对相机的位置就是 1−6=−5。所以只要把每个点的 z 减去相机距离，后面的透视工具就会自动产生近大远小。左右和上下不用改变，也不需要自己重写投影矩阵。',
        'When you step away from an object, it looks smaller even though its physical size stays the same. This differs from scaling the mesh. A virtual camera first asks where each point is relative to itself.\n\nOur camera moves only along Z and always looks toward negative Z. If the camera is at z=6 and a point is at z=1, the relative coordinate is 1−6=−5. Subtract the camera distance from z and the supplied perspective tool handles apparent size. Keep x and y unchanged; no projection-matrix work is required.'),
      task:t('将返回数组改为 `[x,y,z-distance,w]`。预览中的相机距离随时间在 5 到 8 之间变化，方便观察同一个方块的远近变化。',
        'Return `[x,y,z-distance,w]`. The preview varies camera distance between 5 and 8 over time so you can observe the same cube at different distances.'),
      path:'src/camera.ts',starter:camera.replace('return [x,y,z-distance,w];','// TODO: 用点的 z 减去相机的位置 / Subtract the camera distance.\n    return [x,y,z,w];'),reference:camera,
      tests:code`
        import { toCamera } from '../src/camera';
        it('expresses a point relative to the camera',()=>{expect(toCamera([1,2,1,1],6)).toEqual([1,2,-5,1]);});
        it('moves points farther away as camera distance grows',()=>{const p:any=[0,1,-2,1];expect(toCamera(p,3)).toEqual([0,1,-5,1]);expect(toCamera(p,8)).toEqual([0,1,-10,1]);expect(p).toEqual([0,1,-2,1]);expect(()=>toCamera(p,0)).toThrow();});
      `,
      hint:t('计算的是“点的位置 − 相机的位置”，不是相加。正距离的相机后退后，物体的相对 z 应该更负。', 'Compute point position minus camera position. Moving the camera back makes the relative z more negative.'),
      result:t('能看清完整的旋转方块，并且它随着相机退后缩小、靠近放大。起始代码中相机留在方块内部，画面可能被裁开。', 'The full rotating cube shrinks as the camera retreats and grows as it approaches. The starter leaves the camera inside the cube, so parts may be clipped.'),
      demo:imports+moveImport+cameraImport+`export function renderFrame(time:number,width:number,height:number) { return renderCubes(time,width,height,{scale:scalePoint,translate:translatePoint,camera:toCamera},[{size:1,offset:[0,0,0],color:scene.color}],6.5+Math.sin(time*scene.speed)*1.5); }`,
    }),
    lesson({id:'checker-material',title:t('给方块穿上格子外衣','Give the cube a checker pattern'),
      intro:t('之前每个面只有一种颜色，现在给它画格子。想象把一张方格纸贴在方块表面，u 表示纸上从左到右的位置，v 表示从上到下的位置，范围都是 0 到 1。这两个数叫“表面坐标”，和屏幕上的 x、y 不同，所以物体转动时花纹也能跟着转。\n\n工具已经把位置换成格子的行号和列号。只要让行号加列号为偶数时选颜色 a，奇数时选颜色 b，相邻格子就会交替换色。例如第 0 行第 0 列是 a，第 0 行第 1 列是 b，第 1 行第 1 列又是 a。这里直接算颜色，不需要下载任何图片。',
        'Instead of one color per face, attach imaginary graph paper to its surface. u measures left to right and v top to bottom, both from zero to one. These are surface coordinates, different from screen x and y, so the pattern rotates with the cube.\n\nThe helper converts u and v into grid row and column numbers. Choose color a when their sum is even and b when odd. Row zero, column zero is a; row zero, column one is b; row one, column one is a again. The pattern is generated from numbers, with no image download needed.'),
      task:t('把最后一行改为 `return parity === 0 ? a : b;`。`% 2` 已经帮你判断了奇偶，取格子行列的工具也已经写好。',
        'Change the last line to `return parity === 0 ? a : b;`. The supplied `% 2` calculates parity, and the grid lookup is already implemented.'),
      path:'src/checker.ts',starter:checker.replace('return parity === 0 ? a : b;','// TODO: 奇偶格子选择不同颜色 / Alternate the two colors.\n    return a;'),reference:checker,
      tests:code`
        import { checkerColor } from '../src/checker';
        const a:any=[20,160,220,255],b:any=[240,180,60,255];
        it('alternates neighboring columns and rows',()=>{expect(checkerColor(.1,.1,4,a,b)).toEqual(a);expect(checkerColor(.3,.1,4,a,b)).toEqual(b);expect(checkerColor(.1,.3,4,a,b)).toEqual(b);expect(checkerColor(.3,.3,4,a,b)).toEqual(a);});
        it('keeps the outer border in the final grid cell',()=>{expect(checkerColor(1,0,4,a,b)).toEqual(b);expect(checkerColor(0,1,4,a,b)).toEqual(b);expect(checkerColor(-1,0,4,a,b)).toEqual(a);expect(()=>checkerColor(0,0,0,a,b)).toThrow();});
      `,
      hint:t('parity 为 0 表示偶数格，选 a；否则选 b。这就是一条普通的条件表达式。', 'Parity zero means choose a; otherwise choose b. It is an ordinary conditional expression.'),
      result:t('青色与金色的格子贴在方块表面，跟随旋转并保留各个面的明暗。它不会像屏幕贴纸一样停在原地。', 'Cyan and gold squares stick to the cube, rotate with it, and retain face lighting instead of remaining fixed on the screen.'),
      demo:imports+moveImport+cameraImport+checkerImport+`export function renderFrame(time:number,width:number,height:number) { return renderCubes(time,width,height,{scale:scalePoint,translate:translatePoint,camera:toCamera,material:${material}},[{size:1.15,offset:[0,0,0],color:scene.color}],5.5); }`,
    }),
    lesson({id:'distance-fog',title:t('让远处的物体融入雾中','Fade distant objects into fog'),
      intro:t('看远处的山时，颜色会逐渐接近天空的颜色。我们也能用很简单的混色做出这种远近感：近处保留物体颜色，远处多混入一点雾的颜色。amount 表示雾占多少，0 是没有雾，1 是完全变成雾的颜色。\n\n例如红色通道为 100，雾的红色通道为 20，amount=0.5 时得到 100×0.5+20×0.5=60。先用 1−amount 乘物体颜色，再用 amount 乘雾色，最后相加。工具已根据距离算好并限制 amount 的范围。本关为了好理解，每个物体用中心距离算一次雾；更真实的逐像素雾留到进阶再研究。',
        'Distant mountains gradually approach the sky color. A simple color blend can create the same depth cue: keep nearby object colors and mix in more fog color at greater distance. amount is the fog fraction: zero means none and one means full fog.\n\nFor an object red channel of 100, fog red channel of 20 and amount 0.5, the result is 60. Multiply the object by 1−amount and the fog by amount, then add them. Distance conversion and clamping are supplied. This beginner model uses one center distance per object; per-fragment fog is a later extension.'),
      task:t('将返回值改为 `[0,1,2].map(i => color[i]*(1-amount)+fogColor[i]*amount).concat(color[3]) as Color`。前三个通道做混色，透明度保留。JS 版省略末尾的 `as Color`。',
        'Return `[0,1,2].map(i => color[i]*(1-amount)+fogColor[i]*amount).concat(color[3]) as Color`. Blend RGB and keep opacity. Omit `as Color` in JavaScript.'),
      path:'src/fog.ts',starter:fog.replace('return [0,1,2].map(i => color[i]*(1-amount)+fogColor[i]*amount).concat(color[3]) as Color;','// TODO: 按 amount 混合物体颜色和雾色 / Blend the two RGB colors.\n    return color;'),reference:fog,
      tests:code`
        import { applyFog } from '../src/fog';
        it('mixes colors halfway without changing opacity',()=>{expect(applyFog([100,200,80,128],[20,40,0,255],6,2,10)).toEqual([60,120,40,128]);});
        it('clamps near and far distances without changing inputs',()=>{const color:any=[100,200,80,128],fog:any=[20,40,0,255];expect(applyFog(color,fog,0,2,10)).toEqual(color);expect(applyFog(color,fog,20,2,10)).toEqual([20,40,0,128]);expect(color).toEqual([100,200,80,128]);expect(fog).toEqual([20,40,0,255]);expect(()=>applyFog(color,fog,5,10,2)).toThrow();});
      `,
      hint:t('amount=0 时必须等于原色，amount=1 时 RGB 必须等于雾色。用这两个端点检查是否把权重写反了。', 'At amount zero return the original RGB; at one return fog RGB. These endpoints catch reversed weights.'),
      result:t('三个格子方块同时旋转：近处清晰，远处逐渐融入背景。场景复用了你写的缩放、平移、相机、花纹和雾化函数，十二关至此完成。', 'Three checker cubes rotate together: the nearest stays clear while farther cubes fade toward the background. Your scaling, translation, camera, material and fog functions now work together, completing all twelve lessons.'),
      demo:imports+moveImport+cameraImport+checkerImport+`import { applyFog } from '../src/fog';
        export function renderFrame(time:number,width:number,height:number) { return renderCubes(time,width,height,{
          scale:scalePoint,translate:translatePoint,camera:toCamera,material:${material},fog:(color,distance)=>applyFog(color,scene.background,distance,4,12)
        },[{size:.62,offset:[-1.5,-.25,2.2],color:scene.color},{size:.85,offset:[0,.05,-.8],color:scene.color},{size:1.1,offset:[2.5,.5,-3.8],color:scene.color}],7); }`,
    }),
  ];
};
