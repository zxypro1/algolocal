# API Test Suite

Comprehensive unit tests for the OfflineLeetPractice API endpoints, ensuring all existing problem solutions run as expected across multiple programming languages.

## Overview

This test suite validates:
- **API Functionality**: Core endpoints work correctly
- **Multi-Language Support**: JavaScript, Java, Python, C++, C execution
- **Solution Validation**: All provided solutions pass their test cases
- **Data Integrity**: Problem data structure and consistency
- **Template Handling**: Language-specific code templates
- **Error Handling**: Graceful handling of compilation and runtime errors
- **Performance**: Execution time and memory usage tracking

## Test Structure

### 1. Problem Data Integrity (`problem-data.test.js`)
- **Problem Structure**: Validates required fields (id, title, tests, templates)
- **Test Cases**: Ensures proper input/output format and edge case coverage
- **Multi-language Content**: Validates English/Chinese translations
- **Template Validation**: Checks language-specific template syntax
- **File System Consistency**: Verifies problems.json synchronization

### 2. API Functionality (`run.test.js`)
- **JavaScript Solutions**: Tests all JS solutions for correctness
- **Java Solutions**: Tests Java class handling and method execution
- **Python Solutions**: Tests Python function execution
- **C++ Solutions**: Tests both class and standalone function formats
- **C Solutions**: Tests C function execution
- **Error Handling**: Invalid problem IDs, compilation errors, runtime errors
- **Performance Metrics**: Execution time and memory usage validation

### 3. Language-Specific Features (`language-specific.test.js`)
- **Java Template Handling**: Class vs method-only code, String arrays, boolean/array returns
- **C++ Template Handling**: Class vs standalone functions, parameter type detection
- **C Template Handling**: Function formats, boolean return types
- **Python Template Handling**: Function naming conventions, type handling
- **Edge Cases**: Empty functions, infinite loops, timeout handling
- **Platform Support**: Cross-platform compatibility validation

### 4. Solution Validation (`solutions.test.js`)
- **Solution Correctness**: All provided solutions pass their test cases
- **Cross-Language Consistency**: Same logic produces identical results
- **Performance Benchmarks**: Solutions complete within reasonable time
- **Error Handling**: Malformed solutions handled gracefully
- **Template Solutions**: Verified working solutions for all major problems

## Running Tests

### Prerequisites
```bash
npm install
```

### Quick Start
```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run specific test suite
npm run test:solutions
npm run test:data
```

### Advanced Usage
```bash
# Run specific test by pattern
node scripts/test-runner.js specific "java"
node scripts/test-runner.js specific "API" --bail

# Show help
node scripts/test-runner.js help
```

### Available Commands
- `npm test` - Run all test suites
- `npm run test:coverage` - Run all tests with coverage report
- `npm run test:solutions` - Test solution validation only
- `npm run test:data` - Test problem data integrity only
- `npm run test:api` - Test core API functionality only
- `npm run test:watch` - Run tests in watch mode

## Test Configuration

### Jest Configuration (`jest.config.js`)
- **Environment**: Node.js for API testing
- **Timeout**: 30 seconds for language compilation/execution
- **Workers**: Sequential execution to avoid conflicts
- **Coverage**: API routes and core components

### Global Setup (`jest.setup.js`)
- **Timeout**: Extended timeout for compilation tests
- **Utilities**: Common validation functions
- **Console**: Suppressed logs for cleaner output

## Expected Problems Coverage

The test suite validates solutions for these problems:
- **Two Sum** (all languages) - 6 test cases
- **Reverse Integer** (all languages) - 7 test cases
- **Palindrome Number** (all languages) - 8 test cases
- **Longest Common Prefix** (JavaScript, Java, Python)
- **Valid Parentheses** (JavaScript, Java, Python)
- **Merge Sorted Lists** (linked-list conversion) - 3 test cases
- **Remove Duplicates** (when available)
- **Search Insert Position** (when available) - 7 test cases
- **Maximum Subarray** (when available) - 3 test cases
- **Climbing Stairs** (when available) - 3 test cases
- **Contains Duplicate** (new) - 5 test cases
- **Single Number** (new) - 4 test cases
- **Move Zeroes** (new) - 4 test cases

**Total: 13 problems with comprehensive test coverage**

## Language Support Matrix

| Problem | JavaScript | Java | Python | C++ | C |
|---------|------------|------|--------|-----|---|
| Two Sum | | | | | |
| Reverse Integer | | | | | |
| Palindrome Number | | | | | |
| Longest Common Prefix | | | | | |
| Valid Parentheses | | | | | |

= Fully tested | = Basic template support

## Performance Benchmarks

### Expected Performance
- **Execution Time**: < 5 seconds total per problem
- **Average Test Time**: < 1 second per test case
- **Memory Usage**: Reasonable heap usage tracking
- **Compilation**: < 10 seconds for compiled languages

### Memory Tracking
Tests monitor:
- Heap used/total
- External memory
- RSS (Resident Set Size)

## Error Handling Validation

### Compilation Errors
- Invalid syntax in Java/C++/C
- Missing imports/includes
- Type mismatches

### Runtime Errors
- Function exceptions
- Infinite loops (with timeout)
- Wrong return types
- Missing implementations

### API Errors
- Invalid problem IDs (404)
- Invalid HTTP methods (405)
- Malformed requests

## Continuous Integration

### Test Requirements
1. **All test suites must pass** (100% pass rate)
2. **Performance within limits** (< 30 seconds total)
3. **No compilation errors** for valid code
4. **Proper error handling** for invalid code

### Quality Gates
- **Data Integrity**: All problems have valid structure
- **Solution Correctness**: All solutions pass their tests
- **Language Support**: All major languages work
- **Error Resilience**: Graceful error handling

## Troubleshooting

### Common Issues

**1. Test Timeouts**
```bash
# Increase timeout for slow systems
JEST_TIMEOUT=60000 npm test
```

**2. Java Compilation Issues**
- Ensure Java is installed and in PATH
- Check JDK version compatibility
- Verify JAVA_HOME environment variable

**3. C++ Compilation Issues**
- Ensure g++ is installed
- Check compiler version
- Verify standard library availability

**4. Memory Issues**
```bash
# Run tests with more memory
node --max-old-space-size=4096 scripts/test-runner.js
```

### Debug Mode
```bash
# Verbose output
node scripts/test-runner.js all --verbose

# Single test with debug
jest tests/api/run.test.js --verbose --no-cache
```

## Contributing

### Adding New Tests
1. Follow existing test structure
2. Use `global.testUtils.validateAPIResponse()` for API tests
3. Include both positive and negative test cases
4. Add performance validation where appropriate

### Test Naming Convention
- **Describe blocks**: Feature or component being tested
- **Test cases**: "should [expected behavior] when [condition]"
- **File names**: `[feature].test.js`

### Best Practices
- **Isolation**: Each test is independent
- **Descriptive**: Clear test names and descriptions  
- **Comprehensive**: Cover happy path and edge cases
- **Performance**: Include timing assertions
- **Cleanup**: Proper resource cleanup in tests

## Support

For test-related issues:
1. Check this README for troubleshooting
2. Run individual test suites to isolate issues
3. Use verbose mode for detailed output
4. Verify environment setup (Java, C++, etc.)

The test suite ensures the API remains reliable and all existing solutions continue to work correctly across all supported programming languages.