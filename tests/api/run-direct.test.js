/**
 * Direct API tests that bypass Next.js server setup
 * This avoids the dynamic import issues and tests the API handler directly
 */

const fs = require('fs');
const path = require('path');

// Mock Next.js types and request/response
function createMockReq(method = 'POST', body = {}) {
  return {
    method,
    body,
    headers: {},
    query: {}
  };
}

function createMockRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
    _statusCode: 200,
    _jsonData: null
  };
  
  res.status.mockImplementation((code) => {
    res._statusCode = code;
    return res;
  });
  
  res.json.mockImplementation((data) => {
    res._jsonData = data;
    return res;
  });
  
  return res;
}

describe('Direct API Tests', () => {
  let handler;
  let problems;

  beforeAll(async () => {
    // Load problems data
    const problemsPath = path.join(process.cwd(), 'public', 'problems.json');
    problems = JSON.parse(fs.readFileSync(problemsPath, 'utf8'));
    
    // Mock Next.js types for the handler
    global.NextApiRequest = class {};
    global.NextApiResponse = class {};
    
    // Import the handler after setting up mocks
    const handlerModule = require('../../pages/api/run.ts');
    handler = handlerModule.default;
  });

  describe('Linked List Problems', () => {
    test('merge-sorted-lists should convert linked list result to array', async () => {
      const solution = `function ListNode(val, next) {
  this.val = (val===undefined ? 0 : val);
  this.next = (next===undefined ? null : next);
}

function mergeTwoLists(list1, list2) {
  const dummy = new ListNode(0);
  let current = dummy;
  while (list1 && list2) {
    if (list1.val <= list2.val) {
      current.next = list1;
      list1 = list1.next;
    } else {
      current.next = list2;
      list2 = list2.next;
    }
    current = current.next;
  }
  current.next = list1 || list2;
  return dummy.next;
}
module.exports = mergeTwoLists;`;

      const req = createMockReq('POST', {
        id: 'merge-sorted-lists',
        code: solution,
        language: 'javascript'
      });
      
      const res = createMockRes();
      
      await handler(req, res);
      
      expect(res._statusCode).toBe(200);
      expect(res._jsonData).toBeDefined();
      expect(res._jsonData.status).toBe('success');
      expect(res._jsonData.passed).toBe(res._jsonData.total);
      expect(res._jsonData.passed).toBe(3); // merge-sorted-lists has 3 test cases
      
      // Verify each test case passed
      res._jsonData.results.forEach((result, index) => {
        expect(result.passed).toBe(true);
        expect(result.error).toBeNull();
        expect(Array.isArray(result.actual)).toBe(true);
        expect(Array.isArray(result.expected)).toBe(true);
      });

      // Verify specific test cases
      const testCase1 = res._jsonData.results.find(r => r.input === '[1,2,4],[1,3,4]');
      expect(testCase1).toBeDefined();
      expect(testCase1.actual).toEqual([1, 1, 2, 3, 4, 4]);
      expect(testCase1.expected).toEqual([1, 1, 2, 3, 4, 4]);
      
      const testCase2 = res._jsonData.results.find(r => r.input === '[],[]');
      expect(testCase2).toBeDefined();
      expect(testCase2.actual).toEqual([]);
      expect(testCase2.expected).toEqual([]);
      
      const testCase3 = res._jsonData.results.find(r => r.input === '[],[0]');
      expect(testCase3).toBeDefined();
      expect(testCase3.actual).toEqual([0]);
      expect(testCase3.expected).toEqual([0]);
    });
  });

  describe('Non-Linked List Problems', () => {
    test('two-sum should work normally without linked list conversion', async () => {
      const solution = `function twoSum(nums, target) {
  const map = new Map();
  for (let i = 0; i < nums.length; i++) {
    const complement = target - nums[i];
    if (map.has(complement)) return [map.get(complement), i];
    map.set(nums[i], i);
  }
}
module.exports = twoSum;`;

      const req = createMockReq('POST', {
        id: 'two-sum',
        code: solution,
        language: 'javascript'
      });
      
      const res = createMockRes();
      
      await handler(req, res);
      
      expect(res._statusCode).toBe(200);
      expect(res._jsonData).toBeDefined();
      expect(res._jsonData.status).toBe('success');
      expect(res._jsonData.passed).toBe(res._jsonData.total);
      
      // Verify each test case passed
      res._jsonData.results.forEach((result, index) => {
        expect(result.passed).toBe(true);
        expect(result.error).toBeNull();
        expect(Array.isArray(result.actual)).toBe(true);
        expect(Array.isArray(result.expected)).toBe(true);
      });
    });

    test('reverse-integer should work normally', async () => {
      const solution = `function reverse(x) {
  const sign = x < 0 ? -1 : 1;
  const reversed = parseInt(Math.abs(x).toString().split('').reverse().join(''));
  if (reversed > 2**31 - 1) return 0;
  return sign * reversed;
}
module.exports = reverse;`;

      const req = createMockReq('POST', {
        id: 'reverse-integer',
        code: solution,
        language: 'javascript'
      });
      
      const res = createMockRes();
      
      await handler(req, res);
      
      expect(res._statusCode).toBe(200);
      expect(res._jsonData).toBeDefined();
      expect(res._jsonData.status).toBe('success');
      expect(res._jsonData.passed).toBe(res._jsonData.total);
      
      // Verify each test case passed
      res._jsonData.results.forEach((result, index) => {
        expect(result.passed).toBe(true);
        expect(result.error).toBeNull();
        expect(typeof result.actual).toBe('number');
        expect(typeof result.expected).toBe('number');
      });
    });
  });

  describe('Error Handling', () => {
    test('Invalid problem ID should return 404', async () => {
      const req = createMockReq('POST', {
        id: 'non-existent-problem',
        code: 'function test() { return 42; }',
        language: 'javascript'
      });
      
      const res = createMockRes();
      
      await handler(req, res);
      
      expect(res._statusCode).toBe(404);
      expect(res._jsonData).toBeDefined();
      expect(res._jsonData.error).toBe('Problem not found');
    });

    test('Invalid HTTP method should return 405', async () => {
      const req = createMockReq('GET', {});
      const res = createMockRes();
      
      await handler(req, res);
      
      expect(res._statusCode).toBe(405);
    });

    test('Runtime error should be handled gracefully', async () => {
      const runtimeErrorCode = `function twoSum(nums, target) {
  throw new Error('Intentional runtime error');
}
module.exports = twoSum;`;

      const req = createMockReq('POST', {
        id: 'two-sum',
        code: runtimeErrorCode,
        language: 'javascript'
      });
      
      const res = createMockRes();
      
      await handler(req, res);
      
      expect(res._statusCode).toBe(200);
      expect(res._jsonData.status).toBe('success');
      expect(res._jsonData.passed).toBe(0);
      expect(res._jsonData.results.every(r => r.error !== null)).toBe(true);
    });
  });

  describe('Solution Validation', () => {
    test('All problems with JavaScript solutions should pass', async () => {
      const problemsWithJSSolutions = problems.filter(problem => 
        problem.solution && problem.solution.js
      );
      
      expect(problemsWithJSSolutions.length).toBeGreaterThan(0);
      console.log(`Testing ${problemsWithJSSolutions.length} JavaScript solutions...`);
      
      for (const problem of problemsWithJSSolutions) {
        console.log(`\nTesting ${problem.id} JavaScript solution...`);
        
        const req = createMockReq('POST', {
          id: problem.id,
          code: problem.solution.js,
          language: 'javascript'
        });
        
        const res = createMockRes();
        
        await handler(req, res);
        
        expect(res._statusCode).toBe(200);
        expect(res._jsonData).toBeDefined();
        expect(res._jsonData.status).toBe('success');
        
        if (res._jsonData.passed !== res._jsonData.total) {
          console.log(`\n✗ FAILING PROBLEM: ${problem.id}`);
          console.log(`Passed: ${res._jsonData.passed}/${res._jsonData.total}`);
          console.log('Failed test cases:');
          res._jsonData.results.forEach((result, index) => {
            if (!result.passed) {
              console.log(`  Test ${index + 1}: input=${result.input}, expected=${JSON.stringify(result.expected)}, actual=${JSON.stringify(result.actual)}, error=${result.error}`);
            }
          });
        }
        
        expect(res._jsonData.passed).toBe(res._jsonData.total);
        expect(res._jsonData.passed).toBe(problem.tests.length);
        
        // Verify each individual test case
        res._jsonData.results.forEach((result, index) => {
          expect(result.passed).toBe(true);
          expect(result.error).toBeNull();
          expect(result).toHaveProperty('executionTime');
          expect(typeof result.executionTime).toBe('number');
          expect(result.executionTime).toBeGreaterThanOrEqual(0);
        });

        // Performance validation
        expect(res._jsonData.performance.totalExecutionTime).toBeGreaterThan(0);
        expect(res._jsonData.performance.averageExecutionTime).toBeGreaterThan(0);
        expect(res._jsonData.performance.totalExecutionTime).toBeLessThan(10000); // Should complete within 10 seconds
        
        console.log(`✓ ${problem.id}: ${res._jsonData.passed}/${res._jsonData.total} tests passed`);
      }
    });
  });

  describe('Performance Metrics', () => {
    test('Response should include performance metrics', async () => {
      const req = createMockReq('POST', {
        id: 'two-sum',
        code: `function twoSum(nums, target) {
  const map = new Map();
  for (let i = 0; i < nums.length; i++) {
    const complement = target - nums[i];
    if (map.has(complement)) return [map.get(complement), i];
    map.set(nums[i], i);
  }
}
module.exports = twoSum;`,
        language: 'javascript'
      });
      
      const res = createMockRes();
      
      await handler(req, res);
      
      expect(res._jsonData).toHaveProperty('performance');
      expect(res._jsonData.performance).toHaveProperty('totalExecutionTime');
      expect(res._jsonData.performance).toHaveProperty('averageExecutionTime');
      expect(res._jsonData.performance).toHaveProperty('memoryUsage');
      expect(typeof res._jsonData.performance.totalExecutionTime).toBe('number');
      expect(typeof res._jsonData.performance.averageExecutionTime).toBe('number');
    });
  });
});