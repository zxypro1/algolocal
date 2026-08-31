/**
 * Electron Builder Configuration
 * 支持 Windows、macOS 和 Linux 的跨平台构建
 */
// 有没有真正的 Developer ID 证书。release.yml 在没有配置证书时会把
// CSC_IDENTITY_AUTO_DISCOVERY 设成 'false'，那条路径下 electron-builder 会完全跳过签名，
// 改由 build/afterPack.js 补一个 ad-hoc 签名（见该文件里的说明）。
const hasSigningCertificate = process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false';

// 公证要求「Developer ID 签名 + 强化运行时」，缺一不可。
// 只有凭据齐全时才打开，否则 electron-builder 会拿一个 ad-hoc 包去公证，必然失败。
const canNotarize = Boolean(
  hasSigningCertificate &&
  process.env.APPLE_ID &&
  process.env.APPLE_APP_SPECIFIC_PASSWORD &&
  process.env.APPLE_TEAM_ID
);

module.exports = {
  // 应用标识
  appId: 'com.algolocal.app',
  productName: 'AlgoLocal',
  
  // 应用元数据
  copyright: 'Copyright © 2024-2025 zxypro1',
  
  // 构建目录
  directories: {
    output: 'dist',
    buildResources: 'build'
  },

  // macOS 产物在这里补 ad-hoc 签名。必须是 afterPack 而不是 afterSign——
  // electron-builder 在跳过签名时同样会跳过 afterSign。
  afterPack: 'build/afterPack.js',
  
  // 打包文件
  files: [
    'electron-main.js',
    'electron-menu.js',
    'electron-urls.js',
    'electron-preload.js',
    'next.config.js',
    'package.json',
    'pages/**/*',
    'src/**/*',
    'styles/**/*',
    '.next/**/*',
    'public/**/*',
    // public/{labkit,gpulab,opslab} 是构建产物的落脚点，不是源码目录。这里改成白名单：
    // 通配符会把别人工作区里遗留的旧产物一起打进包 —— 早先那个 120MB 的
    // kubectl.wasm（spike 时期的单 CLI 版本，代码里已经零引用）就是这么混进去的。
    // 新增资源要同时改 scripts/copy-lab-assets.js 与下面的 asarUnpack。
    '!public/labkit/*.wasm',
    '!public/gpulab/*.wasm',
    '!public/opslab/*.wasm',
    'public/labkit/web-tree-sitter.wasm',
    'public/labkit/tree-sitter-bash.wasm',
    'public/gpulab/tree-sitter-cuda.wasm',
    'public/opslab/opslab-cli.wasm',
    // llmlab 的算子核。和上面几个不同：它**在仓库里**（37KB，不是构建产物），
    // 所以没有对应的 `!public/llmlab/*.wasm` 排除行 —— 那条排除是用来挡
    // 别人工作区遗留的旧产物的，而这个文件根本不会有旧版本躺在那儿。
    'public/llmlab/llmlab-kernels.wasm',
    // Pyodide 的运行时（13.5MB）。这五个少一个 Python 都起不来，
    // 而「起不来」的表现是学员点进关卡看到一个转不完的圈。
    '!public/llmlab/pyodide/*',
    'public/llmlab/pyodide/pyodide.mjs',
    'public/llmlab/pyodide/pyodide.asm.mjs',
    'public/llmlab/pyodide/pyodide.asm.wasm',
    'public/llmlab/pyodide/python_stdlib.zip',
    'public/llmlab/pyodide/pyodide-lock.json',
    'problems/**/*',
    'projects/**/*',
    'locales/**/*',
    'node_modules/**/*',
    // 排除不必要的文件以减小体积
    '!node_modules/**/test/**',
    '!node_modules/**/tests/**',
    '!node_modules/**/__tests__/**',
    '!node_modules/**/testing/**',
    '!node_modules/**/*.md',
    '!node_modules/**/*.markdown',
    '!node_modules/**/LICENSE*',
    '!node_modules/**/license*',
    '!node_modules/**/CHANGELOG*',
    '!node_modules/**/changelog*',
    '!node_modules/**/HISTORY*',
    '!node_modules/**/history*',
    '!node_modules/**/.github/**',
    '!node_modules/**/.vscode/**',
    '!node_modules/**/*.map',
    '!node_modules/**/*.ts',
    '!node_modules/**/*.tsx',
    '!node_modules/**/tsconfig.json',
    '!node_modules/**/.eslintrc*',
    '!node_modules/**/.prettierrc*',
    '!node_modules/**/example/**',
    '!node_modules/**/examples/**',
    '!node_modules/**/docs/**',
    '!node_modules/**/doc/**',
    '!node_modules/**/*.d.ts.map',
    '!node_modules/**/Makefile',
    '!node_modules/**/Gruntfile.js',
    '!node_modules/**/gulpfile.js',
    '!node_modules/**/.travis.yml',
    '!node_modules/**/.npmignore',
    '!node_modules/**/.editorconfig',
    // 排除 devDependencies 相关
    '!node_modules/electron/**',
    '!node_modules/electron-builder/**',
    '!node_modules/jest/**',
    '!node_modules/@types/**',
    '!node_modules/typescript/**',
    '!node_modules/sharp/**',
    '!node_modules/png-to-ico/**'
  ],
  
  // 额外资源
  extraResources: [
    {
      from: 'problems',
      to: 'problems',
      filter: ['**/*']
    },
    {
      from: 'projects',
      to: 'projects',
      filter: ['**/*']
    }
  ],
  
  // ASAR 配置 - 启用 asar 大幅加速安装
  // 注意：如果遇到 React Context/useContext 为空的问题，可以尝试设置 asar: false
  asar: true,
  asarUnpack: [
    // 需要直接文件访问的资源
    'public/problems.json',
    'public/projects.json',
    // opslab 的 WebAssembly 制品（真 kubectl 与 helm）必须解包：
    // 一百多 MB 的文件留在 asar 里，WebAssembly.compileStreaming 读不到真实文件，
    // 只能整份读进内存再编译，启动慢一倍、峰值内存也翻倍。
    // 同样逐个列名，理由见上面 files 里那段。
    'public/opslab/opslab-cli.wasm',
    'public/labkit/web-tree-sitter.wasm',
    'public/labkit/tree-sitter-bash.wasm',
    'public/gpulab/tree-sitter-cuda.wasm',
    // 算子核也解包：`createKernels` 走的是同步的 `new WebAssembly.Module`，
    // 留在 asar 里要先整份读进内存。37KB 的代价不大，但没有理由不解。
    'public/llmlab/llmlab-kernels.wasm',
    // Pyodide 同样解包：9.6MB 的 wasm 留在 asar 里，编译前要先整份读进内存，
    // 启动慢一倍、峰值内存也翻倍（opslab 那个 142MB 的教训，量级小一点而已）。
    'public/llmlab/pyodide/pyodide.mjs',
    'public/llmlab/pyodide/pyodide.asm.mjs',
    'public/llmlab/pyodide/pyodide.asm.wasm',
    'public/llmlab/pyodide/python_stdlib.zip',
    'public/llmlab/pyodide/pyodide-lock.json',
    'public/icon.png',
    'public/favicon.ico'
  ],

  // ==================== Windows 配置 ====================
  win: {
    target: [
      {
        target: 'nsis',
        arch: ['x64']
      },
      {
        target: 'portable',
        arch: ['x64']
      }
    ],
    icon: 'build/icon.ico',
    artifactName: '${productName}-${version}-Windows-${arch}.${ext}',
    fileAssociations: [
      {
        ext: 'algo',
        name: 'Algorithm Problem',
        description: 'AlgoLocal Problem File',
        role: 'Editor'
      }
    ]
  },
  
  // NSIS 安装程序配置 - 优化安装速度
  nsis: {
    oneClick: true,                              // 一键安装，最快
    perMachine: false,                           // 仅当前用户，无需管理员权限
    allowToChangeInstallationDirectory: false,   // 禁用目录选择，加速安装
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'AlgoLocal',
    deleteAppDataOnUninstall: false,
    artifactName: '${productName}-${version}-Windows-Setup.${ext}'
  },

  // 便携版配置
  portable: {
    artifactName: '${productName}-${version}-Windows-Portable.${ext}'
  },

  // ==================== macOS 配置 ====================
  mac: {
    target: ['dmg', 'zip'],
    icon: 'public/icon.png',
    category: 'public.app-category.developer-tools',
    artifactName: '${productName}-${version}-macOS-${arch}.${ext}',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    /*
     * 这里**不要**写 bundleVersion / bundleShortVersion。
     *
     * 曾经硬编码成 '1' 与 '0.16.1'，于是 package.json 一路涨到 0.17.1、
     * 产物文件名与官网都对，唯独 macOS 包的 Info.plist 一直停在 0.16.1 ——
     * 「关于」面板和访达显示的都是三个版本之前的号，没人发现。
     *
     * 不写这两个键，electron-builder 就从 package.json 的 version 推导。
     * scripts/check-app-version.js 会在打包后断言两者一致，别再手写回来。
     */
    fileAssociations: [
      {
        ext: 'algo',
        name: 'Algorithm Problem',
        role: 'Editor'
      }
    ],
    darkModeSupport: true,
    notarize: canNotarize ? { teamId: process.env.APPLE_TEAM_ID } : false
  },
  
  // DMG 配置
  dmg: {
    contents: [
      {
        x: 130,
        y: 220
      },
      {
        x: 410,
        y: 220,
        type: 'link',
        path: '/Applications'
      }
    ],
    window: {
      width: 540,
      height: 380
    },
    backgroundColor: '#11182f',
    title: 'AlgoLocal',
    artifactName: '${productName}-${version}-macOS-${arch}.${ext}'
  },

  // ==================== Linux 配置 ====================
  linux: {
    target: [
      {
        target: 'AppImage',
        arch: ['x64']
      },
      {
        target: 'deb',
        arch: ['x64']
      },
      {
        target: 'rpm',
        arch: ['x64']
      }
    ],
    icon: 'public/icon.png',
    category: 'Development',
    artifactName: '${productName}-${version}-Linux-${arch}.${ext}',
    maintainer: 'zxypro1 <zxypro@example.com>',
    vendor: 'AlgoLocal',
    synopsis: 'Practice coding algorithms 100% offline with AI',
    description: '基于 WASM 的离线算法练习应用，支持 JavaScript、TypeScript 和 Python',
    desktop: {
      Name: 'AlgoLocal',
      Comment: '离线算法练习',
      Categories: 'Development;IDE;',
      Keywords: 'algorithm;code;practice;programming;'
    },
    fileAssociations: [
      {
        ext: 'algo',
        name: 'Algorithm Problem',
        mimeType: 'application/x-algorithm-problem'
      }
    ]
  },

  // AppImage 配置
  appImage: {
    artifactName: '${productName}-${version}-Linux.${ext}',
    category: 'Development'
  },

  // Deb 包配置
  deb: {
    depends: ['libnotify4', 'libxtst6', 'libnss3'],
    artifactName: '${productName}-${version}-Linux.${ext}'
  },

  // RPM 包配置
  rpm: {
    depends: ['libnotify', 'libXtst', 'nss'],
    artifactName: '${productName}-${version}-Linux.${ext}'
  },

  // 发布配置
  publish: null
};
