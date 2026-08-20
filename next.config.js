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
      type: 'webassembly/async',
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
  experimental: {
    /**
     * 题库是用 path.join(APP_ROOT, 'public', ...) 动态拼出来读的，Next 的依赖
     * 追踪看不出这层关系，打包到 Vercel 的函数里就会少掉这两个文件，网页版
     * 于是变成一个没有题目的空列表。这里显式告诉它带上。
     */
    outputFileTracingIncludes: {
      '/api/**/*': ['./public/problems.json', './public/projects.json'],
      '/': ['./public/problems.json'],
    },
  },
  // Disable telemetry for desktop app
  env: {
    NEXT_TELEMETRY_DISABLED: '1'
  }
};

module.exports = nextConfig;
