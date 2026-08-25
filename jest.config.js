const nextJest = require('next/jest')

const createJestConfig = nextJest({
  // Provide the path to your Next.js app to load next.config.js and .env files
  dir: './',
})

// Add any custom config to be passed to Jest
const customJestConfig = {
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  testEnvironment: 'node',
  testMatch: [
    '<rootDir>/tests/**/*.test.js',
    '<rootDir>/tests/**/*.test.ts'
  ],
  collectCoverageFrom: [
    'pages/api/**/*.{js,ts}',
    'src/**/*.{js,ts,tsx}',
    '!**/*.d.ts',
    '!**/node_modules/**',
  ],
  coverageReporters: ['text', 'lcov', 'html'],
  testTimeout: 30000, // 30 seconds timeout for API tests
  maxWorkers: 1, // Run tests sequentially to avoid conflicts
}

/**
 * createJestConfig 返回的是一个异步函数（next/jest 要先读 next.config.js）。
 * 这里再包一层是为了改 transformIgnorePatterns —— next/jest 默认整个
 * node_modules 都不转译，而 @marcbachmann/cel-js 是纯 ESM 包，
 * 不转译的话 require 它会直接报「Cannot use import statement outside a module」。
 */
module.exports = async () => {
  const config = await createJestConfig(customJestConfig)()
  config.transformIgnorePatterns = (config.transformIgnorePatterns || []).map((pattern) =>
    pattern === '/node_modules/' ? '/node_modules/(?!@marcbachmann/)' : pattern
  )
  return config
}