#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Comprehensive test runner for the OfflineLeetPractice API
 * Ensures environment is ready and runs all test suites
 */
class TestRunner {
  constructor() {
    this.testSuites = [
      {
        name: 'Problem Data Integrity',
        file: 'tests/api/problem-data.test.js',
        description: 'Validates problem structure and data integrity'
      },
      {
        name: 'Solution Validation',
        file: 'tests/api/solutions.test.ts',
        description: "Runs every reference solution against its own test cases, through the app's own executor"
      },
      {
        name: 'Editor Drafts',
        file: 'tests/editor',
        description: 'Per-problem, per-language code draft persistence'
      },
      {
        name: 'AI Provider & Streaming',
        file: 'tests/ai',
        description: 'Model capability handling, provider selection and the chat streaming protocol'
      },
      {
        name: 'Engineering Practice Runtime',
        file: 'tests/engineering',
        description: 'Virtual clock, module runtime, metric gates and preset project solvability'
      },
      {
        name: 'Project Generator',
        file: 'tests/generator',
        description: 'Structural validation, stage verification and the save path for generated projects'
      },
      {
        name: 'Labkit Foundation',
        file: 'tests/labkit',
        description: 'The deterministic kernel and machine layer both labs stand on: virtual clock ordering, settle/deadlock detection, snapshots, VFS and the shell'
      },
      {
        name: 'Opslab Cluster',
        file: 'tests/opslab',
        description: 'apiserver semantics, controllers, the real kubectl/helm WASM runtime, and byte-identical replay of dozens of concurrent entities'
      },
      {
        name: 'Gpulab CUDA VM',
        file: 'tests/gpulab',
        description: 'The CUDA frontend, the warp-lockstep VM, coalescing/bank-conflict measurement, racecheck, and the nvcc/ncu toolchain'
      },
      {
        name: 'Desktop Menus',
        file: 'tests/desktop',
        description: 'Application and context menus, including the edit roles that ⌘V depends on'
      },
      // tests/build 与 tests/trace 一直存在，却从来没进过这张表 ——
      // 写了不跑等于没写。补进来的时候三个文件都是绿的。
      {
        name: 'Build Artifacts',
        file: 'tests/build',
        description: 'Bundle-level failure detection and the packaged app version check that keeps Info.plist in step with package.json'
      },
      {
        name: 'Trace Instrumentation',
        file: 'tests/trace',
        description: 'Execution trace instrumentation and step navigation'
      }
    ];
  }

  /**
   * Check if required files exist
   */
  checkEnvironment() {
    console.log('Checking test environment...');
    
    // pages/api/run.ts 早就删掉了：代码现在在浏览器里执行（WASM / Web Worker）。
    // 把它留在这里的后果是 checkEnvironment 永远返回 false，
    // runAllTests 在跑任何一个套件之前就 exit(1) —— 整份套件列表形同虚设。
    const requiredFiles = [
      'public/problems.json',
      'jest.config.js',
      'jest.setup.js'
    ];

    const missingFiles = requiredFiles.filter(file => 
      !fs.existsSync(path.join(process.cwd(), file))
    );

    if (missingFiles.length > 0) {
      console.error('✗ Missing required files:');
      missingFiles.forEach(file => console.error(`   - ${file}`));
      return false;
    }

    console.log('✓ Environment check passed');
    return true;
  }

  /**
   * Validate problems.json structure
   */
  validateProblems() {
    console.log('Validating problems.json...');
    
    try {
      const problemsPath = path.join(process.cwd(), 'public', 'problems.json');
      const problems = JSON.parse(fs.readFileSync(problemsPath, 'utf8'));
      
      if (!Array.isArray(problems) || problems.length === 0) {
        console.error('✗ Invalid problems.json: must be non-empty array');
        return false;
      }

      const requiredFields = ['id', 'title', 'tests', 'template'];
      const invalidProblems = problems.filter(problem => 
        !requiredFields.every(field => problem.hasOwnProperty(field))
      );

      if (invalidProblems.length > 0) {
        console.error('✗ Invalid problems found (missing required fields):');
        invalidProblems.forEach(p => console.error(`   - ${p.id || 'Unknown'}`));
        return false;
      }

      console.log(`✓ Found ${problems.length} valid problems`);
      return true;
    } catch (error) {
      console.error('✗ Error validating problems.json:', error.message);
      return false;
    }
  }

  /**
   * Run a specific test suite
   */
  async runTestSuite(suite, options = {}) {
    console.log(`\nRunning ${suite.name}...`);
    console.log(`   ${suite.description}`);
    
    return new Promise((resolve) => {
      const jestArgs = [
        suite.file,
        '--verbose',
        '--no-cache',
        '--forceExit'
      ];

      if (options.coverage) {
        jestArgs.push('--coverage');
      }

      if (options.bail) {
        jestArgs.push('--bail');
      }

      /**
       * 给 jest 更大的堆。
       *
       * opslab 那套要把 142MB 的 CLI 产物编成 WebAssembly，每个测试文件各编一次
       * （jest 的模块注册表是按文件隔离的）。默认堆在机器同时干着别的活时会不够，
       * 表现成偶发的整套失败 —— 偶发的失败比稳定的失败更费人。
       */
      const jest = spawn('npx', ['jest', ...jestArgs], {
        stdio: 'inherit',
        shell: true,
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
        },
      });

      jest.on('close', (code) => {
        if (code === 0) {
          console.log(`✓ ${suite.name} passed`);
        } else {
          console.log(`✗ ${suite.name} failed with code ${code}`);
        }
        resolve(code === 0);
      });

      jest.on('error', (error) => {
        console.error(`✗ Error running ${suite.name}:`, error.message);
        resolve(false);
      });
    });
  }

  /**
   * Run all test suites
   */
  async runAllTests(options = {}) {
    console.log('Starting comprehensive API test suite\n');
    
    // Environment checks
    if (!this.checkEnvironment()) {
      process.exit(1);
    }

    if (!this.validateProblems()) {
      process.exit(1);
    }

    // Run test suites
    const results = [];
    for (const suite of this.testSuites) {
      const success = await this.runTestSuite(suite, options);
      results.push({ suite: suite.name, success });
      
      if (!success && options.bail) {
        console.log('\n✗ Test suite failed, stopping due to --bail flag');
        break;
      }
    }

    // Summary
    console.log('\nTest Results Summary:');
    console.log('========================');
    
    const passed = results.filter(r => r.success).length;
    const total = results.length;
    
    results.forEach(result => {
      const status = result.success ? '✓' : '✗';
      console.log(`${status} ${result.suite}`);
    });

    console.log(`\nOverall: ${passed}/${total} test suites passed`);
    
    if (passed === total) {
      console.log('All tests passed! API is working correctly.');
      process.exit(0);
    } else {
      console.log('Some tests failed. Please check the output above.');
      process.exit(1);
    }
  }

  /**
   * Run specific test by name or pattern
   */
  async runSpecificTest(pattern, options = {}) {
    const matchingSuites = this.testSuites.filter(suite => 
      suite.name.toLowerCase().includes(pattern.toLowerCase()) ||
      suite.file.includes(pattern)
    );

    if (matchingSuites.length === 0) {
      console.error(`✗ No test suites found matching pattern: ${pattern}`);
      console.log('\nAvailable test suites:');
      this.testSuites.forEach(suite => {
        console.log(`   - ${suite.name} (${suite.file})`);
      });
      process.exit(1);
    }

    console.log(`Running ${matchingSuites.length} matching test suite(s):\n`);
    
    for (const suite of matchingSuites) {
      await this.runTestSuite(suite, options);
    }
  }

  /**
   * Display help information
   */
  showHelp() {
    console.log(`
OfflineLeetPractice API Test Runner

Usage: node scripts/test-runner.js [command] [options]

Commands:
  all              Run all test suites (default)
  specific <name>  Run specific test suite by name or pattern
  help             Show this help message

Options:
  --coverage       Generate coverage report
  --bail           Stop on first test failure
  --verbose        Show detailed output

Test Suites:
${this.testSuites.map(suite => `  • ${suite.name}\n    ${suite.description}`).join('\n')}

Examples:
  node scripts/test-runner.js
  node scripts/test-runner.js all --coverage
  node scripts/test-runner.js specific "API" --bail
  node scripts/test-runner.js specific "solution" --verbose
`);
  }
}

// Main execution
async function main() {
  const runner = new TestRunner();
  const args = process.argv.slice(2);
  
  const command = args[0] || 'all';
  const options = {
    coverage: args.includes('--coverage'),
    bail: args.includes('--bail'),
    verbose: args.includes('--verbose')
  };

  switch (command) {
    case 'help':
      runner.showHelp();
      break;
      
    case 'all':
      await runner.runAllTests(options);
      break;
      
    case 'specific':
      const pattern = args[1];
      if (!pattern) {
        console.error('✗ Please specify a test pattern');
        process.exit(1);
      }
      await runner.runSpecificTest(pattern, options);
      break;
      
    default:
      console.error(`✗ Unknown command: ${command}`);
      runner.showHelp();
      process.exit(1);
  }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

main().catch(error => {
  console.error('Test runner error:', error);
  process.exit(1);
});