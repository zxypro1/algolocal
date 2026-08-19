const fs = require('fs');
const path = require('path');

console.log('Testing dynamic problems.json modification...\n');

// Read the current problems.json
const problemsPath = path.join(__dirname, 'public', 'problems.json');
const originalData = fs.readFileSync(problemsPath, 'utf8');
const problems = JSON.parse(originalData);

console.log(`Current number of problems: ${problems.length}`);

// Add a test problem
const testProblem = {
  "id": "test-problem",
  "title": { "en": "Test Problem", "zh": "测试问题" },
  "difficulty": "Easy",
  "tags": ["test"],
  "description": {
    "en": "This is a test problem to verify dynamic loading.",
    "zh": "这是一个测试问题，用于验证动态加载。"
  },
  "examples": [
    { "input": "1", "output": "1" }
  ],
  "template": {
    "js": "function testFunction(x) {\n  // Write your code here\n  return x;\n}\nmodule.exports = testFunction;"
  },
  "solution": {
    "js": "function testFunction(x) {\n  return x;\n}\nmodule.exports = testFunction;"
  },
  "tests": [
    { "input": "1", "output": "1" },
    { "input": "42", "output": "42" }
  ]
};

// Add the test problem
problems.push(testProblem);

// Write back to file
fs.writeFileSync(problemsPath, JSON.stringify(problems, null, 2));

console.log(`✓ Added test problem. New count: ${problems.length}`);
console.log('Visit http://localhost:3002 to see the new problem!');
console.log('Direct link: http://localhost:3002/problems/test-problem');
console.log('\nThe test problem should appear immediately without rebuilding!');

// Provide cleanup instructions
console.log('\nTo remove the test problem, run: npm run test:cleanup');