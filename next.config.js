const webpack = require('webpack');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Support both server and static output
  output: process.env.NEXT_OUTPUT === 'export' ? 'export' : undefined,
  // Disable image optimization for Electron compatibility
  images: {
    unoptimized: true
  },
  // i18n 国际化配置
  i18n: {
    locales: ['zh', 'en'],
    defaultLocale: 'zh',
    localeDetection: false
  },
  // Webpack configuration for WASM support
  webpack: (config, { isServer }) => {
    // Enable WebAssembly
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };
    
    // Handle .wasm files
    config.module.rules.push({
      test: /\.wasm$/,
      exclude: /node_modules[\\/]web-tree-sitter[\\/]/,
      type: 'webassembly/async',
    });

    // web-tree-sitter 的 wasm 是 emscripten 产物，导入 GOT.mem / env 这些
    // 只有它自己的胶水代码才提供的东西。当成 webpack 的 wasm 模块去解析必然失败，
    // 按普通资源拷出去就行 —— 运行期我们本来就是自己按 URL 取的
    // （见 scripts/copy-opslab-assets.js）。
    config.module.rules.push({
      test: /\.wasm$/,
      include: /node_modules[\\/]web-tree-sitter[\\/]/,
      type: 'asset/resource',
    });

    // Web Worker 里没有 window/document，默认的 JSONP chunk 加载会直接崩。
    // 工程实战的关卡运行器跑在 Worker 里，这里改用 importScripts。
    if (!isServer) {
      config.output = {
        ...config.output,
        workerChunkLoading: 'import-scripts',
      };

      // 工程实战要在浏览器里转译 TypeScript，于是 typescript.js 被打进了客户端 bundle。
      // 它内部引用了一批 Node 内置模块（做计时、读文件等），这些代码路径在
      // transpileModule 下根本不会执行，指向一个空模块即可，不必引入 polyfill。
      //
      // 只对 typescript 包生效：写成全局的 resolve.fallback 的话，整个客户端 bundle
      // 里任何一处误引 Node 模块都会从「构建期报错」变成「运行期 path.join is not a
      // function」—— 把一个一眼能看见的问题藏到线上去。
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /^(perf_hooks|fs|os|path|crypto|inspector|child_process)$/,
          (resource) => {
            if (/node_modules[\\/]typescript[\\/]/.test(resource.context || '')) {
              resource.request = require.resolve('./src/lib/emptyModule.js');
            }
          }
        )
      );

      // web-tree-sitter 同理：它的 ESM 产物里有 Node 分支，会 import fs/promises
      // 和 module。这些分支被 ENVIRONMENT_IS_NODE 挡着，浏览器里不会走到。
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /^(fs\/promises|module)$/,
          (resource) => {
            if (/node_modules[\\/]web-tree-sitter(?:[\\/]|$)/.test(resource.context || '')) {
              resource.request = require.resolve('./src/lib/emptyModule.js');
            }
          }
        )
      );

      // typescript.js 里有 require(变量) 这种动态依赖，webpack 会警告
      // 「Critical dependency」。同样是不会走到的分支，屏蔽掉以免淹没真正的警告。
      config.ignoreWarnings = [
        ...(config.ignoreWarnings || []),
        { module: /node_modules\/typescript\/lib\/typescript\.js$/ },
      ];
    }

    return config;
  },
  // Transpile packages that need it
  transpilePackages: [],
  // Disable telemetry for desktop app
  env: {
    NEXT_TELEMETRY_DISABLED: '1'
  }
};

module.exports = nextConfig;
